const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const {
  assertHomologationRuntime,
  parseCliArguments,
  runInstitutionalBackfill,
  validateExplicitMapping,
} = require('../scripts/homologation/institutionalBackfill');

function createHomologationDatabase(databasePath) {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professor', 'admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    );
  `);
  migration002.up(db);
  migration003.up(db);
  migration016.up(db);

  const adminOneId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Administradora Homologação', 'admin-um@homologacao.invalid', 'hash', 'admin')
  `).run().lastInsertRowid);
  const adminTwoId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Revisor Homologação', 'admin-dois@homologacao.invalid', 'hash', 'admin')
  `).run().lastInsertRowid);
  const teacherId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Homologação', 'professor@homologacao.invalid', 'hash', 'professor')
  `).run().lastInsertRowid);
  db.prepare("INSERT INTO grades (id, name, sort_order) VALUES (1, '8º ano', 8)").run();
  const municipalityId = Number(db.prepare(`
    INSERT INTO municipalities (public_id, name, created_by)
    VALUES ('municipality-cli-homolog-01', 'Município Sintético', ?)
  `).run(adminOneId).lastInsertRowid);
  const schoolId = Number(db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-cli-homologation-001', ?, 'Escola Sintética', ?)
  `).run(municipalityId, adminOneId).lastInsertRowid);
  db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES ('membership-cli-teacher-001', ?, 'teacher', ?, ?, ?)
  `).run(teacherId, municipalityId, schoolId, adminOneId);
  db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-cli-homologation-001', ?, 'Turma Sintética', 1, 2026, ?)
  `).run(teacherId, teacherId);

  db.exec(`
    CREATE TABLE schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    );
    INSERT INTO schema_migrations (version, name, checksum)
    VALUES (16, 'institutional_foundation', 'synthetic-checksum');

    CREATE TABLE homologation_snapshot_metadata (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      sanitized INTEGER NOT NULL CHECK(sanitized = 1),
      sanitizer_version TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL,
      sanitized_at DATETIME NOT NULL
    );
    INSERT INTO homologation_snapshot_metadata (
      id, sanitized, sanitizer_version, source_schema_version, sanitized_at
    ) VALUES (1, 1, '9', 16, '2026-08-16T10:00:00.000Z');
  `);
  db.prepare(`
    UPDATE feature_flags
    SET master_enabled = 0,
        default_enabled = 0,
        rollout_percentage = 0,
        kill_switch_active = 1,
        kill_switch_reason = 'Proteção do ensaio de backfill.',
        kill_switch_activated_by = ?,
        kill_switch_activated_at = CURRENT_TIMESTAMP
    WHERE flag_key = 'institutions.core'
  `).run(adminOneId);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
  return { adminOneId, adminTwoId, teacherId, municipalityId, schoolId };
}

function baseEnvironment(databasePath, confirmation = '') {
  return {
    APP_ENV: 'homologation',
    NODE_ENV: 'production',
    DB_PATH: databasePath,
    INSTITUTIONAL_BACKFILL_CONFIRM: confirmation,
  };
}

test('CLI aceita somente argumentos conhecidos e exige runtime de homologação', () => {
  assert.deepEqual(
    parseCliArguments([
      '--mode', 'diagnose',
      '--database', 'homologation.sqlite',
      '--output', 'homologation-report.json',
      '--actor-email', 'admin@homologacao.invalid',
    ]).mode,
    'diagnose',
  );
  assert.throws(
    () => parseCliArguments(['--mode', 'diagnose', '--replace-output', 'yes']),
    /não suportado/i,
  );
  assert.throws(
    () => assertHomologationRuntime({ APP_ENV: 'production', NODE_ENV: 'production' }),
    /APP_ENV deve ser homologation/,
  );
  assert.throws(
    () => assertHomologationRuntime({ APP_ENV: 'homologation', NODE_ENV: 'development' }),
    /NODE_ENV deve ser production/,
  );
  assert.throws(
    () => validateExplicitMapping({
      format: 'labmathic.institutional-backfill-mapping',
      formatVersion: 1,
      municipalityPublicId: 'municipality-cli-homolog-01',
      assignments: [{
        classPublicId: 'class-cli-homologation-001',
        schoolPublicId: 'school-cli-homologation-001',
        studentName: 'campo proibido',
      }],
    }),
    /não permitidos/i,
  );
});

test('CLI executa diagnóstico, plano, vínculo e verificação somente no snapshot protegido', (t) => {
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-homologation-backfill-'));
  t.after(() => fs.rmSync(temporaryDirectory, { recursive: true, force: true }));
  const databasePath = path.join(temporaryDirectory, 'homologation.sqlite');
  createHomologationDatabase(databasePath);
  const mappingPath = path.join(temporaryDirectory, 'homologation-mapping.json');
  fs.writeFileSync(mappingPath, JSON.stringify({
    format: 'labmathic.institutional-backfill-mapping',
    formatVersion: 1,
    municipalityPublicId: 'municipality-cli-homolog-01',
    assignments: [{
      classPublicId: 'class-cli-homologation-001',
      schoolPublicId: 'school-cli-homologation-001',
    }],
  }));

  const diagnosticPath = path.join(temporaryDirectory, 'homologation-diagnostic.json');
  const diagnosticReport = runInstitutionalBackfill({
    mode: 'diagnose',
    databasePath,
    outputPath: diagnosticPath,
    actorEmail: 'admin-um@homologacao.invalid',
    municipalityPublicId: 'municipality-cli-homolog-01',
  }, baseEnvironment(databasePath));
  assert.equal(diagnosticReport.safety.studentDataIncluded, false);
  assert.equal(JSON.parse(fs.readFileSync(diagnosticPath, 'utf8')).counts.pending, 1);

  const planPath = path.join(temporaryDirectory, 'homologation-plan.json');
  const planReport = runInstitutionalBackfill({
    mode: 'plan',
    databasePath,
    outputPath: planPath,
    actorEmail: 'admin-um@homologacao.invalid',
    mappingPath,
  }, baseEnvironment(databasePath));
  assert.match(planReport.digest, /^[a-f0-9]{64}$/);
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));

  const linkPath = path.join(temporaryDirectory, 'homologation-link-receipt.json');
  const linkReport = runInstitutionalBackfill({
    mode: 'link',
    databasePath,
    outputPath: linkPath,
    actorEmail: 'admin-um@homologacao.invalid',
    inputPath: planPath,
    reason: 'Vínculo sintético confirmado em ensaio isolado de homologação.',
  }, baseEnvironment(databasePath, `LINK ${plan.planDigest}`));
  assert.match(linkReport.digest, /^[a-f0-9]{64}$/);
  const linkReceipt = JSON.parse(fs.readFileSync(linkPath, 'utf8'));

  const verificationPath = path.join(temporaryDirectory, 'homologation-verification.json');
  const verificationReport = runInstitutionalBackfill({
    mode: 'verify',
    databasePath,
    outputPath: verificationPath,
    actorEmail: 'admin-dois@homologacao.invalid',
    inputPath: linkPath,
    reason: 'Segunda conferência sintética concluída por outro administrador.',
  }, baseEnvironment(databasePath, `VERIFY ${linkReceipt.receiptDigest}`));
  assert.match(verificationReport.digest, /^[a-f0-9]{64}$/);

  const db = new Database(databasePath, { readonly: true });
  try {
    assert.deepEqual(db.prepare(`
      SELECT migration_status, linked_by, verified_by
      FROM school_class_institution_contexts
    `).get(), {
      migration_status: 'verified',
      linked_by: 1,
      verified_by: 2,
    });
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 2);
    assert.deepEqual(db.prepare(`
      SELECT master_enabled, default_enabled, rollout_percentage, kill_switch_active
      FROM feature_flags WHERE flag_key = 'institutions.core'
    `).get(), {
      master_enabled: 0,
      default_enabled: 0,
      rollout_percentage: 0,
      kill_switch_active: 1,
    });
  } finally {
    db.close();
  }

  assert.throws(
    () => runInstitutionalBackfill({
      mode: 'diagnose',
      databasePath,
      outputPath: diagnosticPath,
      actorEmail: 'admin-um@homologacao.invalid',
    }, baseEnvironment(databasePath)),
    /já existe/i,
  );
});
