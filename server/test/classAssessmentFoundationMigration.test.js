const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration004 = require('../src/migrations/004_class_assessment_assignments_foundation');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-assessment-foundation-'));
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
    CREATE TABLE question_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      is_public INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      description TEXT NOT NULL
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER,
      statement TEXT NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
    );
  `);
  migration002.up(db);
  migration003.up(db);
  migration004.up(db);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return db;
}

function seed(db) {
  const teacherOne = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Um', 'prof-um@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const teacherTwo = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Dois', 'prof-dois@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const gradeId = db.prepare("INSERT INTO grades (name) VALUES ('7o Ano')").run().lastInsertRowid;
  const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Matematica')").run().lastInsertRowid;
  const classOne = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('assessment-class-public-01', ?, 'Turma Um', ?, 2026, ?)
  `).run(teacherOne, gradeId, teacherOne).lastInsertRowid;
  const classTwo = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('assessment-class-public-02', ?, 'Turma Dois', ?, 2026, ?)
  `).run(teacherTwo, gradeId, teacherTwo).lastInsertRowid;
  const studentOne = db.prepare(`
    INSERT INTO students (public_id, owner_teacher_id, display_name, created_by)
    VALUES ('assessment-student-public-01', ?, 'Estudante Um', ?)
  `).run(teacherOne, teacherOne).lastInsertRowid;
  const studentTwo = db.prepare(`
    INSERT INTO students (public_id, owner_teacher_id, display_name, created_by)
    VALUES ('assessment-student-public-02', ?, 'Estudante Dois', ?)
  `).run(teacherTwo, teacherTwo).lastInsertRowid;
  const enrollmentOne = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(classOne, studentOne, teacherOne, teacherOne).lastInsertRowid;
  const enrollmentTwo = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(classTwo, studentTwo, teacherTwo, teacherTwo).lastInsertRowid;
  const questionSet = db.prepare(`
    INSERT INTO question_sets (user_id, title) VALUES (?, 'Simulado fonte')
  `).run(teacherOne).lastInsertRowid;
  const skill = db.prepare(`
    INSERT INTO bncc_skills (code, description) VALUES ('EF07MA01', 'Habilidade sintética')
  `).run().lastInsertRowid;
  const question = db.prepare(`
    INSERT INTO questions (question_code, skill_id, statement)
    VALUES ('EF07MA01-Q001', ?, 'Quanto é dois mais dois?')
  `).run(skill).lastInsertRowid;

  return {
    teacherOne,
    teacherTwo,
    classOne,
    classTwo,
    studentOne,
    studentTwo,
    enrollmentOne,
    enrollmentTwo,
    questionSet,
    skill,
    question,
    disciplineId,
  };
}

function createAssignment(db, fixtures) {
  return db.prepare(`
    INSERT INTO class_assessment_assignments (
      public_id, class_id, owner_teacher_id, source_question_set_id,
      title_snapshot, snapshot_hash, question_count, created_by, updated_by
    ) VALUES (
      'assessment-assignment-0001', ?, ?, ?,
      'Simulado fonte', ?, 1, ?, ?
    )
  `).run(
    fixtures.classOne,
    fixtures.teacherOne,
    fixtures.questionSet,
    'a'.repeat(64),
    fixtures.teacherOne,
    fixtures.teacherOne
  ).lastInsertRowid;
}

test('migração 004 cria somente fundação e novas flags completamente desligadas', (t) => {
  const db = createDatabase(t);
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(({ name }) => name));
  for (const tableName of [
    'class_assessment_assignments',
    'class_assessment_items',
    'class_assessment_item_options',
    'class_assessment_participants',
  ]) {
    assert.equal(tables.has(tableName), true);
  }
  assert.equal(
    db.pragma('table_info(school_class_entry_code_redemptions)').some(({ name }) => name === 'request_digest'),
    true
  );
  assert.equal(
    db.pragma('table_info(school_class_enrollments)').some(({ name }) => name === 'revision'),
    true
  );
  assert.deepEqual(
    db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage
      FROM feature_flags
      WHERE flag_key LIKE 'classes.assessment_%'
      ORDER BY flag_key
    `).all(),
    [
      { flag_key: 'classes.assessment_assignments', master_enabled: 0, default_enabled: 0, rollout_percentage: 0 },
      { flag_key: 'classes.assessment_delivery', master_enabled: 0, default_enabled: 0, rollout_percentage: 0 },
      { flag_key: 'classes.assessment_results', master_enabled: 0, default_enabled: 0, rollout_percentage: 0 },
    ]
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('banco impede atribuição e participantes entre professores diferentes', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);
  assert.throws(() => db.prepare(`
    INSERT INTO class_assessment_assignments (
      public_id, class_id, owner_teacher_id, title_snapshot,
      snapshot_hash, question_count, created_by
    ) VALUES ('assessment-cross-owner-01', ?, ?, 'Inválido', ?, 1, ?)
  `).run(fixtures.classTwo, fixtures.teacherOne, 'b'.repeat(64), fixtures.teacherOne), /FOREIGN KEY/);

  const assignment = createAssignment(db, fixtures);
  assert.throws(() => db.prepare(`
    INSERT INTO class_assessment_participants (
      assignment_id, class_id, student_id, enrollment_id,
      owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    assignment,
    fixtures.classOne,
    fixtures.studentTwo,
    fixtures.enrollmentTwo,
    fixtures.teacherOne,
    fixtures.teacherOne
  ), /FOREIGN KEY|assessment_participant_is_not_active/);
});

test('snapshot e lista de participantes ficam congelados quando a aplicação abre', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);
  const assignment = createAssignment(db, fixtures);
  const item = db.prepare(`
    INSERT INTO class_assessment_items (
      assignment_id, class_id, owner_teacher_id, source_question_id,
      source_skill_id, question_code_snapshot, skill_code_snapshot,
      statement_snapshot, difficulty_snapshot, sort_order
    ) VALUES (?, ?, ?, ?, ?, 'EF07MA01-Q001', 'EF07MA01', ?, 'media', 0)
  `).run(
    assignment,
    fixtures.classOne,
    fixtures.teacherOne,
    fixtures.question,
    fixtures.skill,
    'Quanto é dois mais dois?'
  ).lastInsertRowid;
  const insertOption = db.prepare(`
    INSERT INTO class_assessment_item_options (
      assessment_item_id, assignment_id, class_id, owner_teacher_id,
      option_label, option_text_snapshot, is_correct, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  [
    ['A', '4', 1, 0],
    ['B', '3', 0, 1],
    ['C', '5', 0, 2],
    ['D', '6', 0, 3],
  ].forEach(([label, text, correct, order]) => {
    insertOption.run(
      item,
      assignment,
      fixtures.classOne,
      fixtures.teacherOne,
      label,
      text,
      correct,
      order
    );
  });
  const participant = db.prepare(`
    INSERT INTO class_assessment_participants (
      assignment_id, class_id, student_id, enrollment_id,
      owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    assignment,
    fixtures.classOne,
    fixtures.studentOne,
    fixtures.enrollmentOne,
    fixtures.teacherOne,
    fixtures.teacherOne
  ).lastInsertRowid;

  db.prepare(`
    UPDATE class_assessment_assignments
    SET status = 'open', opened_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ?
  `).run(assignment);

  assert.throws(
    () => db.prepare("UPDATE class_assessment_items SET statement_snapshot = 'Alterado' WHERE id = ?").run(item),
    /published_assessment_items_are_immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM class_assessment_participants WHERE id = ?').run(participant),
    /assessment_roster_is_frozen/
  );
  assert.throws(
    () => db.prepare('UPDATE class_assessment_participants SET enrollment_id = enrollment_id WHERE id = ?').run(participant),
    /assessment_participant_identity_is_immutable/
  );
  assert.throws(
    () => db.prepare("UPDATE class_assessment_assignments SET title_snapshot = 'Alterado' WHERE id = ?").run(assignment),
    /published_assessment_snapshot_is_immutable/
  );
  assert.throws(
    () => db.prepare("UPDATE class_assessment_assignments SET status = 'draft' WHERE id = ?").run(assignment),
    /invalid_assessment_status_transition/
  );

  db.prepare('DELETE FROM question_sets WHERE id = ?').run(fixtures.questionSet);
  assert.equal(
    db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE id = ?')
      .get(assignment).source_question_set_id,
    null
  );
  db.prepare('DELETE FROM questions WHERE id = ?').run(fixtures.question);
  assert.equal(
    db.prepare('SELECT source_question_id FROM class_assessment_items WHERE id = ?')
      .get(item).source_question_id,
    null
  );
  db.prepare('DELETE FROM bncc_skills WHERE id = ?').run(fixtures.skill);
  const preservedItem = db.prepare(`
    SELECT source_skill_id, statement_snapshot
    FROM class_assessment_items
    WHERE id = ?
  `).get(item);
  assert.equal(preservedItem.source_skill_id, null);
  assert.match(preservedItem.statement_snapshot, /dois mais dois/i);

  const replacementSet = db.prepare(`
    INSERT INTO question_sets (user_id, title) VALUES (?, 'Outra fonte')
  `).run(fixtures.teacherOne).lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      UPDATE class_assessment_assignments
      SET source_question_set_id = ?
      WHERE id = ?
    `).run(replacementSet, assignment),
    /published_assessment_source_cannot_be_repointed/
  );
  const replacementSkill = db.prepare(`
    INSERT INTO bncc_skills (code, description) VALUES ('EF07MA02', 'Outra habilidade')
  `).run().lastInsertRowid;
  assert.throws(
    () => db.prepare(`
      UPDATE class_assessment_items SET source_skill_id = ? WHERE id = ?
    `).run(replacementSkill, item),
    /published_assessment_source_cannot_be_repointed/
  );
});

test('digest de idempotência não confunde estudantes homônimos', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);
  const code = db.prepare(`
    INSERT INTO school_class_entry_codes (
      public_id, class_id, owner_teacher_id, code_digest,
      max_uses, expires_at, created_by
    ) VALUES ('assessment-entry-code-01', ?, ?, ?, 3, '2099-01-01T00:00:00.000Z', ?)
  `).run(fixtures.classOne, fixtures.teacherOne, 'c'.repeat(64), fixtures.teacherOne).lastInsertRowid;
  db.prepare(`
    INSERT INTO school_class_entry_code_redemptions (
      entry_code_id, class_id, student_id, enrollment_id,
      owner_teacher_id, request_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    code,
    fixtures.classOne,
    fixtures.studentOne,
    fixtures.enrollmentOne,
    fixtures.teacherOne,
    'd'.repeat(64)
  );
  assert.throws(() => db.prepare(`
    INSERT INTO school_class_entry_code_redemptions (
      entry_code_id, class_id, student_id, enrollment_id,
      owner_teacher_id, request_digest
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    code,
    fixtures.classOne,
    fixtures.studentOne,
    fixtures.enrollmentOne,
    fixtures.teacherOne,
    'd'.repeat(64)
  ), /UNIQUE/);
});
