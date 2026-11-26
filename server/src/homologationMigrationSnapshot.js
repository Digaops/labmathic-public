const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const { inspectMigrations } = require('./migrations');

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const descriptor = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(1024 * 1024);

  try {
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }

  return hash.digest('hex');
}

function assertRegularFile(filePath, label) {
  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new Error(`${label} deve ser um arquivo regular e não simbólico.`);
  }
  return stats;
}

function readSchemaVersion(db) {
  const tableExists = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get();
  if (!tableExists) return 0;
  return db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get();
}

function verifySnapshot(snapshotPath, expected) {
  const stats = assertRegularFile(snapshotPath, 'O snapshot de pré-migração');
  const snapshotDb = new Database(snapshotPath, { readonly: true, fileMustExist: true });

  try {
    const sanitized = snapshotDb.prepare(`
      SELECT sanitized FROM homologation_snapshot_metadata WHERE id = 1
    `).pluck().get();
    const schemaVersion = readSchemaVersion(snapshotDb);
    const integrityCheck = snapshotDb.pragma('integrity_check', { simple: true });
    const foreignKeyViolations = snapshotDb.pragma('foreign_key_check').length;

    if (sanitized !== 1) throw new Error('O snapshot perdeu a marca de sanitização.');
    if (schemaVersion !== expected.schemaVersion) {
      throw new Error(`Schema inesperado no snapshot: ${schemaVersion}.`);
    }
    if (integrityCheck !== 'ok' || foreignKeyViolations !== 0) {
      throw new Error('O snapshot não passou pelas verificações de integridade SQLite.');
    }

    return {
      bytes: stats.size,
      sha256: sha256File(snapshotPath),
      schemaVersion,
      integrityCheck,
      foreignKeyViolations,
      sanitized: true,
    };
  } finally {
    snapshotDb.close();
  }
}

function validateExistingSnapshot(snapshotPath, manifestPath, expected) {
  if (!fs.existsSync(snapshotPath) || !fs.existsSync(manifestPath)) {
    throw new Error('Snapshot ou manifesto parcial encontrado; a homologação foi bloqueada.');
  }

  assertRegularFile(manifestPath, 'O manifesto de pré-migração');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const verification = verifySnapshot(snapshotPath, expected);

  if (
    manifest.status !== 'verified'
    || manifest.environment !== 'homologation'
    || manifest.sourceSha !== expected.sourceSha
    || manifest.fromSchemaVersion !== expected.schemaVersion
    || manifest.toSchemaVersion !== expected.toSchemaVersion
    || manifest.sha256 !== verification.sha256
    || manifest.bytes !== verification.bytes
  ) {
    throw new Error('O snapshot existente não corresponde ao manifesto esperado.');
  }

  return verification;
}

function createHomologationPreMigrationSnapshot(options) {
  if (options.appEnvironment !== 'homologation') {
    throw new Error('Snapshots automáticos de pré-migração exigem APP_ENV=homologation.');
  }
  const databasePath = path.resolve(options.databasePath);
  if (!/(homolog|staging)/i.test(databasePath)) {
    throw new Error('Snapshots automáticos são permitidos somente na homologação.');
  }
  assertRegularFile(databasePath, 'O banco sanitizado de homologação');

  const sourceDb = new Database(databasePath, { readonly: true, fileMustExist: true });
  let status;
  try {
    status = inspectMigrations(sourceDb);
    if (status.unknown.length > 0 || status.changed.length > 0) {
      throw new Error('O histórico de migrações não é confiável para criar o snapshot.');
    }
    if (status.pending.length === 0) {
      return { status: 'not-required', schemaVersion: readSchemaVersion(sourceDb) };
    }

    if (!/^[0-9a-f]{40}$/.test(options.sourceSha || '')) {
      throw new Error('O SHA exato da release é obrigatório antes de uma migração na homologação.');
    }

    const sanitized = sourceDb.prepare(`
      SELECT sanitized FROM homologation_snapshot_metadata WHERE id = 1
    `).pluck().get();
    if (sanitized !== 1) {
      throw new Error('O banco de origem não possui marca válida de sanitização.');
    }

    const realDatabasePath = fs.realpathSync(databasePath);
    const databaseDirectory = path.dirname(realDatabasePath);
    const snapshotDirectory = path.join(databaseDirectory, 'migration-snapshots');
    fs.mkdirSync(snapshotDirectory, { recursive: true, mode: 0o700 });
    if (fs.lstatSync(snapshotDirectory).isSymbolicLink()) {
      throw new Error('O diretório de snapshots não pode ser um link simbólico.');
    }

    const realSnapshotDirectory = fs.realpathSync(snapshotDirectory);
    if (!realSnapshotDirectory.startsWith(`${databaseDirectory}${path.sep}`)) {
      throw new Error('O diretório de snapshots deve permanecer ao lado do banco de homologação.');
    }

    const schemaVersion = readSchemaVersion(sourceDb);
    const toSchemaVersion = Math.max(...status.pending.map(({ version }) => version));
    const firstPendingVersion = status.pending[0].version;
    const basename = `before-schema-${String(firstPendingVersion).padStart(3, '0')}-${options.sourceSha.slice(0, 12)}`;
    const snapshotPath = path.join(realSnapshotDirectory, `${basename}.sqlite`);
    const manifestPath = `${snapshotPath}.manifest.json`;
    const expected = { schemaVersion, toSchemaVersion, sourceSha: options.sourceSha };

    if (fs.existsSync(snapshotPath) || fs.existsSync(manifestPath)) {
      const verification = validateExistingSnapshot(snapshotPath, manifestPath, expected);
      return { status: 'reused', snapshotPath, manifestPath, ...verification, toSchemaVersion };
    }

    const temporarySnapshotPath = `${snapshotPath}.tmp`;
    const temporaryManifestPath = `${manifestPath}.tmp`;
    if (fs.existsSync(temporarySnapshotPath) || fs.existsSync(temporaryManifestPath)) {
      throw new Error('Arquivo temporário de snapshot já existe; revisão manual necessária.');
    }

    try {
      sourceDb.prepare('VACUUM INTO ?').run(temporarySnapshotPath);
      fs.chmodSync(temporarySnapshotPath, 0o600);
      const verification = verifySnapshot(temporarySnapshotPath, expected);
      const manifest = {
        status: 'verified',
        environment: 'homologation',
        sourceSha: options.sourceSha,
        fromSchemaVersion: schemaVersion,
        toSchemaVersion,
        createdAt: new Date().toISOString(),
        sha256: verification.sha256,
        bytes: verification.bytes,
        integrityCheck: verification.integrityCheck,
        foreignKeyViolations: verification.foreignKeyViolations,
        sanitized: true,
      };
      fs.writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
        encoding: 'utf8',
        mode: 0o600,
        flag: 'wx',
      });
      fs.renameSync(temporarySnapshotPath, snapshotPath);
      fs.renameSync(temporaryManifestPath, manifestPath);

      return { status: 'created', snapshotPath, manifestPath, ...verification, toSchemaVersion };
    } catch (error) {
      fs.rmSync(temporarySnapshotPath, { force: true });
      fs.rmSync(temporaryManifestPath, { force: true });
      throw error;
    }
  } finally {
    sourceDb.close();
  }
}

module.exports = { createHomologationPreMigrationSnapshot, verifySnapshot };
