const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');

function createFoundationDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-classes-foundation-'));
  const db = new Database(path.join(tempDir, 'database.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professor', 'admin'))
    );

    CREATE TABLE disciplines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
  `);
  migration002.up(db);
  migration003.up(db);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return db;
}

function seedOwnershipFixtures(db) {
  const teacherOneId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Um', 'professor-um@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const teacherTwoId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Dois', 'professor-dois@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const gradeId = db.prepare("INSERT INTO grades (name) VALUES ('7o Ano')")
    .run().lastInsertRowid;
  const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Matematica')")
    .run().lastInsertRowid;

  const classOneId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-public-id-00000001', ?, 'Turma A', ?, 2026, ?)
  `).run(teacherOneId, gradeId, teacherOneId).lastInsertRowid;
  const classTwoId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-public-id-00000002', ?, 'Turma B', ?, 2026, ?)
  `).run(teacherTwoId, gradeId, teacherTwoId).lastInsertRowid;

  const studentOneId = db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by
    ) VALUES ('student-public-id-000001', ?, 'Estudante Um', 'REF-001', ?)
  `).run(teacherOneId, teacherOneId).lastInsertRowid;
  const studentTwoId = db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by
    ) VALUES ('student-public-id-000002', ?, 'Estudante Dois', 'REF-002', ?)
  `).run(teacherTwoId, teacherTwoId).lastInsertRowid;

  return {
    teacherOneId,
    teacherTwoId,
    gradeId,
    disciplineId,
    classOneId,
    classTwoId,
    studentOneId,
    studentTwoId,
  };
}

test('migracao 003 cria somente a fundacao e mantem todas as flags desligadas', (t) => {
  const db = createFoundationDatabase(t);
  const requiredTables = [
    'school_classes',
    'school_class_disciplines',
    'students',
    'school_class_enrollments',
    'school_class_entry_codes',
    'school_class_entry_code_redemptions',
  ];
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map(({ name }) => name)
  );

  for (const tableName of requiredTables) assert.equal(tables.has(tableName), true);
  assert.deepEqual(
    db.prepare("SELECT version, status FROM product_releases WHERE version = '2.0.0'").get(),
    { version: '2.0.0', status: 'draft' }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage
      FROM feature_flags
      WHERE release_id = (
        SELECT id FROM product_releases WHERE version = '2.0.0'
      )
      ORDER BY flag_key
    `).all(),
    [
      {
        flag_key: 'classes.core',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
      },
      {
        flag_key: 'classes.entry_codes',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
      },
      {
        flag_key: 'classes.student_import',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
      },
    ]
  );

  const entryCodeColumns = db.pragma('table_info(school_class_entry_codes)')
    .map(({ name }) => name);
  assert.equal(entryCodeColumns.includes('code_digest'), true);
  assert.equal(entryCodeColumns.includes('code'), false);
  assert.equal(entryCodeColumns.includes('token'), false);
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('o banco bloqueia matriculas e componentes entre professores diferentes', (t) => {
  const db = createFoundationDatabase(t);
  const fixtures = seedOwnershipFixtures(db);

  db.prepare(`
    INSERT INTO school_class_disciplines (
      class_id, owner_teacher_id, discipline_id, added_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    fixtures.classOneId,
    fixtures.teacherOneId,
    fixtures.disciplineId,
    fixtures.teacherOneId
  );
  const enrollmentId = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    fixtures.classOneId,
    fixtures.studentOneId,
    fixtures.teacherOneId,
    fixtures.teacherOneId
  ).lastInsertRowid;

  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_disciplines (
        class_id, owner_teacher_id, discipline_id, added_by
      ) VALUES (?, ?, ?, ?)
    `).run(
      fixtures.classTwoId,
      fixtures.teacherOneId,
      fixtures.disciplineId,
      fixtures.teacherOneId
    ),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_enrollments (
        class_id, student_id, owner_teacher_id, created_by
      ) VALUES (?, ?, ?, ?)
    `).run(
      fixtures.classOneId,
      fixtures.studentTwoId,
      fixtures.teacherOneId,
      fixtures.teacherOneId
    ),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_entry_codes (
        public_id, class_id, owner_teacher_id, code_digest,
        max_uses, expires_at, created_by
      ) VALUES ('cross-owner-entry-code-01', ?, ?, ?, 10, ?, ?)
    `).run(
      fixtures.classTwoId,
      fixtures.teacherOneId,
      'f'.repeat(64),
      '2099-01-01T00:00:00.000Z',
      fixtures.teacherOneId
    ),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare('DELETE FROM school_classes WHERE id = ?').run(fixtures.classOneId),
    /FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare('DELETE FROM users WHERE id = ?').run(fixtures.teacherOneId),
    /FOREIGN KEY constraint failed/
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) FROM school_class_enrollments WHERE id = ?')
      .pluck().get(enrollmentId),
    1
  );
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('codigos usam somente digest, respeitam validade, revogacao e limite de usos', (t) => {
  const db = createFoundationDatabase(t);
  const fixtures = seedOwnershipFixtures(db);
  const enrollmentOneId = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    fixtures.classOneId,
    fixtures.studentOneId,
    fixtures.teacherOneId,
    fixtures.teacherOneId
  ).lastInsertRowid;
  const studentThreeId = db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by
    ) VALUES ('student-public-id-000003', ?, 'Estudante Tres', 'REF-003', ?)
  `).run(fixtures.teacherOneId, fixtures.teacherOneId).lastInsertRowid;
  const enrollmentThreeId = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    fixtures.classOneId,
    studentThreeId,
    fixtures.teacherOneId,
    fixtures.teacherOneId
  ).lastInsertRowid;

  const activeCodeId = db.prepare(`
    INSERT INTO school_class_entry_codes (
      public_id, class_id, owner_teacher_id, code_digest,
      max_uses, expires_at, created_by
    ) VALUES ('entry-code-public-id-0001', ?, ?, ?, 1, '2099-01-01T00:00:00.000Z', ?)
  `).run(
    fixtures.classOneId,
    fixtures.teacherOneId,
    'a'.repeat(64),
    fixtures.teacherOneId
  ).lastInsertRowid;

  const redemptionId = db.prepare(`
    INSERT INTO school_class_entry_code_redemptions (
      entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    activeCodeId,
    fixtures.classOneId,
    fixtures.studentOneId,
    enrollmentOneId,
    fixtures.teacherOneId
  ).lastInsertRowid;

  assert.deepEqual(
    db.prepare(`
      SELECT code_digest, use_count, revision, last_used_at IS NOT NULL AS was_used
      FROM school_class_entry_codes
      WHERE id = ?
    `).get(activeCodeId),
    {
      code_digest: 'a'.repeat(64),
      use_count: 1,
      revision: 2,
      was_used: 1,
    }
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_entry_code_redemptions (
        entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      activeCodeId,
      fixtures.classOneId,
      studentThreeId,
      enrollmentThreeId,
      fixtures.teacherOneId
    ),
    /entry_code_unavailable/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE school_class_entry_code_redemptions
      SET redeemed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(redemptionId),
    /entry_code_redemption_is_immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM school_class_entry_code_redemptions WHERE id = ?')
      .run(redemptionId),
    /entry_code_redemption_is_immutable/
  );

  const revokedCodeId = db.prepare(`
    INSERT INTO school_class_entry_codes (
      public_id, class_id, owner_teacher_id, code_digest,
      max_uses, expires_at, revoked_at, created_by
    ) VALUES (
      'entry-code-public-id-0002', ?, ?, ?,
      10, '2099-01-01T00:00:00.000Z', CURRENT_TIMESTAMP, ?
    )
  `).run(
    fixtures.classOneId,
    fixtures.teacherOneId,
    'b'.repeat(64),
    fixtures.teacherOneId
  ).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_entry_code_redemptions (
        entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      revokedCodeId,
      fixtures.classOneId,
      studentThreeId,
      enrollmentThreeId,
      fixtures.teacherOneId
    ),
    /entry_code_unavailable/
  );

  const expiredCodeId = db.prepare(`
    INSERT INTO school_class_entry_codes (
      public_id, class_id, owner_teacher_id, code_digest,
      max_uses, created_at, expires_at, created_by
    ) VALUES (
      'entry-code-public-id-0003', ?, ?, ?,
      10, '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z', ?
    )
  `).run(
    fixtures.classOneId,
    fixtures.teacherOneId,
    'c'.repeat(64),
    fixtures.teacherOneId
  ).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_entry_code_redemptions (
        entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      expiredCodeId,
      fixtures.classOneId,
      studentThreeId,
      enrollmentThreeId,
      fixtures.teacherOneId
    ),
    /entry_code_unavailable/
  );

  assert.throws(
    () => db.prepare(`
      INSERT INTO school_class_entry_codes (
        public_id, class_id, owner_teacher_id, code_digest,
        max_uses, expires_at, created_by
      ) VALUES ('entry-code-public-id-0004', ?, ?, 'codigo-em-texto-puro', 10, ?, ?)
    `).run(
      fixtures.classOneId,
      fixtures.teacherOneId,
      '2099-01-01T00:00:00.000Z',
      fixtures.teacherOneId
    ),
    /CHECK constraint failed/
  );
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('arquivamento e desligamento de matricula exigem datas coerentes', (t) => {
  const db = createFoundationDatabase(t);
  const fixtures = seedOwnershipFixtures(db);

  assert.throws(
    () => db.prepare(`
      UPDATE school_classes
      SET status = 'archived'
      WHERE id = ?
    `).run(fixtures.classOneId),
    /CHECK constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE students
      SET archived_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixtures.studentOneId),
    /CHECK constraint failed/
  );

  const enrollmentId = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    fixtures.classOneId,
    fixtures.studentOneId,
    fixtures.teacherOneId,
    fixtures.teacherOneId
  ).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      UPDATE school_class_enrollments
      SET status = 'withdrawn'
      WHERE id = ?
    `).run(enrollmentId),
    /CHECK constraint failed/
  );

  db.prepare(`
    UPDATE school_class_enrollments
    SET status = 'withdrawn', ended_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(enrollmentId);
  db.prepare(`
    UPDATE school_classes
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fixtures.classOneId);
  db.prepare(`
    UPDATE students
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fixtures.studentOneId);

  assert.equal(db.pragma('foreign_key_check').length, 0);
});
