const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { createHash, createHmac } = require('node:crypto');
const migration040 = require('../src/migrations/040_protect_institutional_professional_receipts');
const { runMigrations } = require('../src/migrations');
const { createProfessional, getInstitutionalOperation } = require('../src/services/institutionalManagement');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const migration023 = require('../src/migrations/023_institutional_management_pilot');

test('migrações preservam contextos e protegem recibos profissionais com replay autorizado', async () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('professor', 'admin'))
      );
      CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE grades (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    `);
    migration002.up(db);
    migration003.up(db);
    migration016.up(db);
    const adminId = Number(db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Admin Migração', 'admin-023@teste.local', 'hash', 'admin')
    `).run().lastInsertRowid);
    const teacherId = Number(db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Professor Migração', 'teacher-023@teste.local', 'hash', 'professor')
    `).run().lastInsertRowid);
    const gradeId = Number(db.prepare(`
      INSERT INTO grades (name) VALUES ('7º Ano Migração 023')
    `).run().lastInsertRowid);
    const classId = Number(db.prepare(`
      INSERT INTO school_classes (
        public_id, owner_teacher_id, name, grade_id, academic_year, created_by
      ) VALUES ('class-before-migration-023', ?, 'Turma legada', ?, 2026, ?)
    `).run(teacherId, gradeId, teacherId).lastInsertRowid);

    migration023.up(db);

    assert.equal(
      db.prepare(`SELECT origin FROM school_class_institution_contexts WHERE class_id = ?`)
        .pluck().get(classId),
      'legacy',
    );
    const flag = db.prepare(`
      SELECT master_enabled, default_enabled, rollout_percentage
      FROM feature_flags WHERE flag_key = 'institutions.management_pilot'
    `).get();
    assert.deepEqual(flag, { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });

    const operationId = Number(db.prepare(`
      INSERT INTO institutional_write_operations (
        public_id, operation_type, actor_user_id, entity_type, entity_key,
        idempotency_key_hash, request_fingerprint, result_json
      ) VALUES (
        'institution-operation-test-023', 'create_municipality', ?,
        'municipality', 'municipality-test-023', ?, ?, '{}'
      )
    `).run(adminId, 'a'.repeat(64), 'b'.repeat(64)).lastInsertRowid);
    assert.throws(
      () => db.prepare(`UPDATE institutional_write_operations SET entity_key = 'changed' WHERE id = ?`).run(operationId),
      /institutional_write_operation_is_immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM institutional_write_operations WHERE id = ?').run(operationId),
      /institutional_write_operation_is_immutable/,
    );
    assert.throws(
      () => db.prepare(`
        UPDATE school_class_institution_contexts SET origin = 'unknown' WHERE class_id = ?
      `).run(classId),
      /CHECK constraint failed/,
    );
    const digest = value => createHash('sha256').update(value).digest('hex');
    const secret = 'segredo-sintetico-do-teste-de-migracao';
    const input = { actor: { id: adminId }, name: 'Profissional sintético', email: 'profissional@example.invalid',
      temporaryPassword: 'Senha-temporaria-teste!', role: 'municipal_manager',
      municipalityPublicId: 'municipio-sintetico-040', idempotencyKey: 'chave-sintetica-replay-040', fingerprintSecret: secret };
    db.prepare(`INSERT INTO municipalities (public_id, name) VALUES (?, 'Município sintético')`).run(input.municipalityPublicId);
    const raw = digest(JSON.stringify({ email: input.email, municipalityPublicId: input.municipalityPublicId, name: input.name,
      operationType: 'create_professional', passwordHash: digest(input.temporaryPassword), role: input.role, schoolPublicId: null }));
    const receipt = { professional: { email: input.email } };
    const legacyId = db.prepare(`INSERT INTO institutional_write_operations (
      public_id, operation_type, actor_user_id, entity_type, entity_key,
      idempotency_key_hash, request_fingerprint, result_json
    ) VALUES ('operation-professional-040', 'create_professional', ?, 'membership', 'membership-040', ?, ?, ?)
    `).run(adminId, digest(input.idempotencyKey), raw, JSON.stringify(receipt)).lastInsertRowid;
    const readReceipt = db.prepare('SELECT * FROM institutional_write_operations WHERE id = ?');
    const before = readReceipt.get(legacyId);
    assert.deepEqual(getInstitutionalOperation(db, input).result, { ...receipt, replayed: true });
    const migrationOptions = { migrations: [migration040], logger: {} };
    assert.throws(() => runMigrations(db, migrationOptions), /Segredo ausente/);
    assert.deepEqual(readReceipt.get(legacyId), before);
    assert.throws(() => db.prepare('UPDATE institutional_write_operations SET entity_key = ? WHERE id = ?').run('other', legacyId),
      /institutional_write_operation_is_immutable/);
    const options = { ...migrationOptions, institutionalFingerprintSecret: secret };
    assert.equal(runMigrations(db, options).appliedNow.length, 1);
    const protectedHash = createHmac('sha256', secret).update('labmathic:institutional-professional-receipt:v1:').update(raw).digest('hex');
    assert.deepEqual(readReceipt.get(legacyId), { ...before, request_fingerprint: protectedHash });
    assert.notEqual(protectedHash, raw);
    assert.equal(readReceipt.get(operationId).request_fingerprint, 'b'.repeat(64));
    assert.equal(runMigrations(db, options).appliedNow.length, 0);
    assert.deepEqual(await createProfessional(db, input), { ...receipt, replayed: true });
    const rotated = { ...input, fingerprintSecret: 'outro-segredo-sintetico' };
    await assert.rejects(createProfessional(db, rotated), { code: 'idempotency_conflict' });
    assert.deepEqual(getInstitutionalOperation(db, rotated).result, { ...receipt, replayed: true });
    assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 2);
    assert.throws(() => db.prepare('DELETE FROM institutional_write_operations WHERE id = ?').run(legacyId),
      /institutional_write_operation_is_immutable/);
  } finally {
    db.close();
  }
});
