const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const {
  authorizeBackfillDiagnostic,
  createInstitutionalBackfillDiagnostic,
  createInstitutionalBackfillPlan,
  linkInstitutionalBackfillPlan,
  verifyInstitutionalBackfillReceipt,
} = require('../../src/services/institutionalBackfill');

const HOMOLOGATION_PATH_PATTERN = /(homolog|staging)/i;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const ALLOWED_MODES = new Set(['diagnose', 'plan', 'link', 'verify']);
const ALLOWED_ARGUMENTS = new Set([
  'mode',
  'database',
  'output',
  'actor-email',
  'municipality',
  'limit',
  'after-class',
  'mapping',
  'input',
  'reason',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertExactKeys(value, allowedKeys, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} deve ser um objeto.`);
  const keys = Object.keys(value);
  assert(
    keys.length === allowedKeys.length && keys.every((key) => allowedKeys.includes(key)),
    `${label} possui campos ausentes ou não permitidos.`,
  );
}

function assertRegularFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} não existe.`);
  const stats = fs.lstatSync(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} deve ser um arquivo regular.`);
}

function resolveHomologationDatabasePath(databasePath, env = process.env) {
  assert(databasePath, 'Informe --database.');
  const resolved = path.resolve(databasePath);
  assert(HOMOLOGATION_PATH_PATTERN.test(resolved), 'O banco deve estar em um caminho de homologação.');
  assertRegularFile(resolved, 'O banco de homologação');
  const real = fs.realpathSync(resolved);
  assert(HOMOLOGATION_PATH_PATTERN.test(real), 'O destino real do banco deve permanecer na homologação.');
  assert(
    path.resolve(env.DB_PATH || '') === resolved,
    'DB_PATH deve apontar exatamente para o banco informado em --database.',
  );

  const header = Buffer.alloc(16);
  const descriptor = fs.openSync(resolved, 'r');
  try {
    assert(fs.readSync(descriptor, header, 0, header.length, 0) === header.length, 'Banco SQLite truncado.');
  } finally {
    fs.closeSync(descriptor);
  }
  assert(header.toString('binary') === 'SQLite format 3\u0000', 'Arquivo informado não é um banco SQLite.');

  for (const sidecarPath of [`${resolved}-wal`, `${resolved}-shm`]) {
    assert(
      !fs.existsSync(sidecarPath),
      'Pare a homologação e execute checkpoint antes do backfill; WAL/SHM foi encontrado.',
    );
  }
  return resolved;
}

function resolveNewOutputPath(outputPath) {
  assert(outputPath, 'Informe --output.');
  const resolved = path.resolve(outputPath);
  assert(HOMOLOGATION_PATH_PATTERN.test(resolved), 'O artefato deve ficar em um caminho de homologação.');
  assert(!fs.existsSync(resolved), 'O arquivo de saída já existe; nenhum artefato será sobrescrito.');
  const parent = path.dirname(resolved);
  assert(fs.existsSync(parent), 'O diretório do artefato não existe.');
  const parentStats = fs.lstatSync(parent);
  assert(parentStats.isDirectory() && !parentStats.isSymbolicLink(), 'O diretório de saída deve ser regular.');
  assert(
    HOMOLOGATION_PATH_PATTERN.test(fs.realpathSync(parent)),
    'O destino real do artefato deve permanecer na homologação.',
  );
  return resolved;
}

function readJson(filePath, label) {
  const resolved = path.resolve(filePath || '');
  assertRegularFile(resolved, label);
  const stats = fs.statSync(resolved);
  assert(stats.size > 0 && stats.size <= MAX_JSON_BYTES, `${label} possui tamanho inválido.`);
  try {
    return JSON.parse(fs.readFileSync(resolved, 'utf8'));
  } catch (error) {
    throw new Error(`${label} não contém JSON válido: ${error.message}`);
  }
}

function writeJsonNew(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    flag: 'wx',
    mode: 0o600,
  });
}

function assertHomologationRuntime(env = process.env) {
  assert(env.APP_ENV === 'homologation', 'APP_ENV deve ser homologation.');
  assert(env.NODE_ENV === 'production', 'NODE_ENV deve ser production para manter as proteções HTTP.');
}

function inspectSafeDatabase(db) {
  db.pragma('foreign_keys = ON');
  const metadataTable = db.prepare(`
    SELECT 1 FROM sqlite_master
    WHERE type = 'table' AND name = 'homologation_snapshot_metadata'
  `).get();
  assert(metadataTable, 'O banco não possui a marca de sanitização de homologação.');
  const metadata = db.prepare(`
    SELECT sanitized, sanitizer_version, source_schema_version, sanitized_at
    FROM homologation_snapshot_metadata
    WHERE id = 1
  `).get();
  assert(metadata?.sanitized === 1, 'A marca de sanitização é inválida.');
  assert(Number(metadata.sanitizer_version) >= 9, 'O snapshot exige sanitizador versão 9 ou superior.');

  const schemaVersion = db.prepare(`
    SELECT COALESCE(MAX(version), 0) FROM schema_migrations
  `).pluck().get();
  assert(schemaVersion >= 16, 'A migração institucional 016 ainda não foi aplicada.');
  for (const tableName of [
    'municipalities',
    'schools',
    'institutional_memberships',
    'school_class_institution_contexts',
    'institutional_audit_log',
  ]) {
    const exists = db.prepare(`
      SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?
    `).get(tableName);
    assert(exists, `Estrutura institucional ausente: ${tableName}.`);
  }

  const flag = db.prepare(`
    SELECT master_enabled, default_enabled, rollout_percentage, kill_switch_active
    FROM feature_flags
    WHERE flag_key = 'institutions.core'
  `).get();
  assert(flag, 'Feature flag institutions.core não encontrada.');
  assert(
    flag.master_enabled === 0
      && flag.default_enabled === 0
      && flag.rollout_percentage === 0
      && flag.kill_switch_active === 1,
    'O backfill exige institutions.core desligada e com kill switch ativo.',
  );
  assert(db.pragma('integrity_check', { simple: true }) === 'ok', 'O banco falhou no integrity_check.');
  assert(db.pragma('foreign_key_check').length === 0, 'O banco possui violações de chave estrangeira.');

  return {
    schemaVersion,
    sanitizerVersion: String(metadata.sanitizer_version),
    sanitizedAt: metadata.sanitized_at,
  };
}

function findActorByEmail(db, email) {
  const normalized = String(email || '').trim().toLowerCase();
  assert(normalized.endsWith('@homologacao.invalid'), 'O ator deve usar e-mail @homologacao.invalid.');
  const actor = db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE email = ? COLLATE NOCASE
  `).get(normalized);
  assert(actor, 'Ator de homologação não encontrado.');
  return actor;
}

function validateExplicitMapping(mapping) {
  assertExactKeys(
    mapping,
    ['format', 'formatVersion', 'municipalityPublicId', 'assignments'],
    'O mapeamento explícito',
  );
  assert(
    mapping.format === 'labmathic.institutional-backfill-mapping'
      && mapping.formatVersion === 1,
    'Formato de mapeamento não suportado.',
  );
  assert(Array.isArray(mapping.assignments), 'assignments deve ser uma lista.');
  mapping.assignments.forEach((assignment) => {
    assertExactKeys(
      assignment,
      ['classPublicId', 'schoolPublicId'],
      'Um vínculo do mapeamento explícito',
    );
  });
  return mapping;
}

function parseCliArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assert(argument.startsWith('--'), `Argumento inválido: ${argument}.`);
    const name = argument.slice(2);
    assert(ALLOWED_ARGUMENTS.has(name), `Argumento não suportado: ${argument}.`);
    assert(!args.has(name), `Argumento duplicado: ${argument}.`);
    const value = argv[index + 1];
    assert(value && !value.startsWith('--'), `Valor ausente para ${argument}.`);
    args.set(name, value);
    index += 1;
  }
  const mode = String(args.get('mode') || '').trim().toLowerCase();
  assert(ALLOWED_MODES.has(mode), 'Informe --mode diagnose, plan, link ou verify.');
  return {
    mode,
    databasePath: args.get('database'),
    outputPath: args.get('output'),
    actorEmail: args.get('actor-email'),
    municipalityPublicId: args.get('municipality') || null,
    limit: args.get('limit') || undefined,
    afterClassPublicId: args.get('after-class') || null,
    mappingPath: args.get('mapping') || null,
    inputPath: args.get('input') || null,
    reason: args.get('reason') || null,
  };
}

function runInstitutionalBackfill(options, env = process.env) {
  assert(ALLOWED_MODES.has(options.mode), 'Modo de backfill inválido.');
  assertHomologationRuntime(env);
  const databasePath = resolveHomologationDatabasePath(options.databasePath, env);
  const outputPath = resolveNewOutputPath(options.outputPath);
  const readonly = options.mode === 'diagnose' || options.mode === 'plan';
  const db = new Database(databasePath, { readonly, fileMustExist: true });
  try {
    if (!readonly) db.pragma('busy_timeout = 5000');
    const database = inspectSafeDatabase(db);
    const actor = findActorByEmail(db, options.actorEmail);
    let artifact;
    let digest = null;

    if (options.mode === 'diagnose') {
      const authorization = authorizeBackfillDiagnostic(
        db,
        actor.id,
        options.municipalityPublicId,
      );
      assert(authorization.allowed, `Diagnóstico negado: ${authorization.reason}.`);
      artifact = createInstitutionalBackfillDiagnostic(db, {
        municipalityPublicId: options.municipalityPublicId,
        limit: options.limit,
        afterClassPublicId: options.afterClassPublicId,
      });
    } else if (options.mode === 'plan') {
      assert(options.mappingPath, 'Informe --mapping no modo plan.');
      const mapping = validateExplicitMapping(
        readJson(options.mappingPath, 'O mapeamento explícito'),
      );
      artifact = createInstitutionalBackfillPlan(db, {
        generatedByUserId: actor.id,
        municipalityPublicId: mapping.municipalityPublicId,
        assignments: mapping.assignments,
      });
      digest = artifact.planDigest;
    } else if (options.mode === 'link') {
      assert(options.inputPath, 'Informe --input com o plano no modo link.');
      artifact = linkInstitutionalBackfillPlan(
        db,
        readJson(options.inputPath, 'O plano de backfill'),
        {
          actorUserId: actor.id,
          reason: options.reason,
          appEnvironment: env.APP_ENV,
          confirmation: env.INSTITUTIONAL_BACKFILL_CONFIRM,
        },
      );
      digest = artifact.receiptDigest;
    } else {
      assert(options.inputPath, 'Informe --input com o recibo no modo verify.');
      artifact = verifyInstitutionalBackfillReceipt(
        db,
        readJson(options.inputPath, 'O recibo de vinculação'),
        {
          reviewerUserId: actor.id,
          reason: options.reason,
          appEnvironment: env.APP_ENV,
          confirmation: env.INSTITUTIONAL_BACKFILL_CONFIRM,
        },
      );
      digest = artifact.verificationDigest;
    }

    if (!readonly) {
      assert(db.pragma('foreign_key_check').length === 0, 'O backfill gerou violação referencial.');
    }
    writeJsonNew(outputPath, artifact);
    return {
      status: 'completed',
      mode: options.mode,
      outputPath,
      itemCount: artifact.items.length,
      digest,
      database,
      safety: {
        homologationOnly: true,
        sanitizedSnapshotRequired: true,
        featureFlagDisabled: true,
        existingOutputNeverOverwritten: true,
        studentDataIncluded: false,
      },
    };
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    const report = runInstitutionalBackfill(parseCliArguments(process.argv.slice(2)));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    console.error(JSON.stringify({
      status: 'failed',
      code: error.code || 'institutional_backfill_failed',
      error: error.message,
      details: error.details || undefined,
    }, null, 2));
    process.exitCode = 1;
  }
}

module.exports = {
  ALLOWED_MODES,
  assertHomologationRuntime,
  inspectSafeDatabase,
  parseCliArguments,
  resolveHomologationDatabasePath,
  resolveNewOutputPath,
  runInstitutionalBackfill,
  validateExplicitMapping,
};
