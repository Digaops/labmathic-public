const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migration008 = require('../src/migrations/008_student_online_assessment_access');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-student-online-migration-'));
  const db = new Database(path.join(tempDir, 'database.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE product_releases (id INTEGER PRIMARY KEY, version TEXT NOT NULL UNIQUE);
    CREATE TABLE feature_flags (
      id INTEGER PRIMARY KEY,
      flag_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      release_id INTEGER,
      master_enabled INTEGER NOT NULL,
      default_enabled INTEGER NOT NULL,
      rollout_percentage INTEGER NOT NULL
    );
    CREATE TABLE class_assessment_assignments (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      UNIQUE(id, class_id, owner_teacher_id)
    );
    CREATE TABLE class_assessment_participants (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      UNIQUE(id, assignment_id, class_id, student_id, owner_teacher_id)
    );
    CREATE TABLE class_assessment_attempts (
      id INTEGER PRIMARY KEY,
      participant_id INTEGER NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO users (id) VALUES (10);
    INSERT INTO product_releases (id, version) VALUES (20, '2.0.0');
    INSERT INTO class_assessment_assignments
      (id, class_id, owner_teacher_id, status)
      VALUES (100, 200, 10, 'scheduled'), (101, 201, 10, 'draft');
    INSERT INTO class_assessment_participants
      (id, assignment_id, class_id, student_id, owner_teacher_id)
      VALUES (300, 100, 200, 400, 10), (301, 101, 201, 401, 10);
  `);
  migration008.up(db);
  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return db;
}

function insertCredential(db, overrides = {}) {
  const value = {
    publicId: 'credential-public-id-000001',
    participantId: 300,
    assignmentId: 100,
    classId: 200,
    studentId: 400,
    ownerTeacherId: 10,
    digest: 'a'.repeat(64),
    hint: '7K2M',
    ...overrides,
  };
  return db.prepare(`
    INSERT INTO class_assessment_access_credentials (
      public_id, participant_id, assignment_id, class_id, student_id,
      owner_teacher_id, code_digest, code_hint, issued_at, expires_at,
      created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-08-15T10:00:00.000Z',
      '2026-09-15T10:00:00.000Z', 10, 10)
  `).run(
    value.publicId,
    value.participantId,
    value.assignmentId,
    value.classId,
    value.studentId,
    value.ownerTeacherId,
    value.digest,
    value.hint
  ).lastInsertRowid;
}

test('migração 008 é aditiva, cria flag desligada e não armazena código em texto puro', (t) => {
  const db = createDatabase(t);
  const assignmentColumns = db.pragma('table_info(class_assessment_assignments)')
    .map(({ name }) => name);
  const credentialColumns = db.pragma('table_info(class_assessment_access_credentials)')
    .map(({ name }) => name);

  assert.ok(assignmentColumns.includes('student_access_enabled'));
  assert.ok(assignmentColumns.includes('student_result_mode'));
  assert.ok(credentialColumns.includes('code_digest'));
  assert.equal(credentialColumns.includes('code'), false);
  assert.deepEqual(
    db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage
      FROM feature_flags WHERE flag_key = 'classes.student_assessment_portal'
    `).get(),
    {
      flag_key: 'classes.student_assessment_portal',
      master_enabled: 0,
      default_enabled: 0,
      rollout_percentage: 0,
    }
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('credencial individual preserva histórico e impede dois acessos ativos', (t) => {
  const db = createDatabase(t);
  const credentialId = insertCredential(db);

  assert.throws(
    () => insertCredential(db, {
      publicId: 'credential-public-id-000002',
      digest: 'b'.repeat(64),
      hint: '9P4R',
    }),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE class_assessment_access_credentials SET code_digest = ? WHERE id = ?
    `).run('c'.repeat(64), credentialId),
    /assessment_access_identity_is_immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM class_assessment_access_credentials WHERE id = ?')
      .run(credentialId),
    /assessment_access_history_is_immutable/
  );

  db.prepare(`
    UPDATE class_assessment_access_credentials
    SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ?
  `).run(credentialId);
  insertCredential(db, {
    publicId: 'credential-public-id-000003',
    digest: 'd'.repeat(64),
    hint: '3T8W',
  });
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM class_assessment_access_credentials WHERE participant_id = 300
    `).pluck().get(),
    2
  );
});

test('acesso só nasce para aplicação publicada e política de resultado trava na abertura', (t) => {
  const db = createDatabase(t);
  assert.throws(
    () => insertCredential(db, {
      publicId: 'credential-public-id-000004',
      participantId: 301,
      assignmentId: 101,
      classId: 201,
      studentId: 401,
      digest: 'e'.repeat(64),
      hint: '5V6X',
    }),
    /assessment_access_assignment_unavailable/
  );

  db.prepare(`
    UPDATE class_assessment_assignments SET student_result_mode = 'hidden' WHERE id = 100
  `).run();
  db.prepare(`
    UPDATE class_assessment_assignments SET status = 'open' WHERE id = 100
  `).run();
  assert.throws(
    () => db.prepare(`
      UPDATE class_assessment_assignments
      SET student_result_mode = 'score_after_submit' WHERE id = 100
    `).run(),
    /student_result_mode_is_locked/
  );
});
