const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migration005 = require('../src/migrations/005_teacher_grade_preferences');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-grade-preferences-'));
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
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );
  `);
  migration005.up(db);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return db;
}

function seed(db) {
  const teacherOneId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Um', 'professor-um@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid);
  const teacherTwoId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Dois', 'professor-dois@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid);
  const adminId = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Administrador', 'admin@teste.local', 'hash', 'admin')
  `).run().lastInsertRowid);
  const firstGradeId = Number(db.prepare("INSERT INTO grades (name) VALUES ('6º Ano')")
    .run().lastInsertRowid);
  const secondGradeId = Number(db.prepare("INSERT INTO grades (name) VALUES ('7º Ano')")
    .run().lastInsertRowid);

  return { teacherOneId, teacherTwoId, adminId, firstGradeId, secondGradeId };
}

test('migração 005 é aditiva, cria somente as preferências e preserva dados existentes', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);

  db.prepare(`
    INSERT INTO teacher_grade_preference_profiles (teacher_id)
    VALUES (?)
  `).run(fixtures.teacherOneId);
  db.prepare(`
    INSERT INTO teacher_grade_preferences (teacher_id, grade_id)
    VALUES (?, ?), (?, ?)
  `).run(
    fixtures.teacherOneId,
    fixtures.firstGradeId,
    fixtures.teacherOneId,
    fixtures.secondGradeId
  );

  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 3);
  assert.equal(db.prepare('SELECT COUNT(*) FROM grades').pluck().get(), 2);
  assert.deepEqual(
    db.prepare(`
      SELECT teacher_id AS teacherId, grade_id AS gradeId
      FROM teacher_grade_preferences
      ORDER BY grade_id
    `).all(),
    [
      { teacherId: fixtures.teacherOneId, gradeId: fixtures.firstGradeId },
      { teacherId: fixtures.teacherOneId, gradeId: fixtures.secondGradeId },
    ]
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('preferências são exclusivas de professores e isoladas por usuário', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);

  assert.throws(
    () => db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
      .run(fixtures.adminId),
    /grade_preferences_require_professor/
  );
  assert.throws(
    () => db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (99999)')
      .run(),
    /grade_preferences_require_professor/
  );

  db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
    .run(fixtures.teacherOneId);
  db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
    .run(fixtures.teacherTwoId);
  db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
    .run(fixtures.teacherOneId, fixtures.firstGradeId);
  db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
    .run(fixtures.teacherTwoId, fixtures.secondGradeId);

  assert.deepEqual(
    db.prepare('SELECT grade_id FROM teacher_grade_preferences WHERE teacher_id = ?')
      .all(fixtures.teacherOneId),
    [{ grade_id: fixtures.firstGradeId }]
  );
  assert.throws(
    () => db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
      .run(fixtures.teacherOneId, fixtures.firstGradeId),
    /UNIQUE constraint failed/
  );
});

test('cascatas e mudança de papel mantêm as invariantes da preferência', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);

  db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
    .run(fixtures.teacherOneId);
  db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
    .run(fixtures.teacherOneId, fixtures.firstGradeId);

  db.prepare('DELETE FROM grades WHERE id = ?').run(fixtures.firstGradeId);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM teacher_grade_preferences WHERE teacher_id = ?')
      .pluck().get(fixtures.teacherOneId),
    0
  );

  db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
    .run(fixtures.teacherOneId, fixtures.secondGradeId);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(fixtures.teacherOneId);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM teacher_grade_preference_profiles WHERE teacher_id = ?')
      .pluck().get(fixtures.teacherOneId),
    0
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM teacher_grade_preferences WHERE teacher_id = ?')
      .pluck().get(fixtures.teacherOneId),
    0
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('identidade e revisão do perfil não podem assumir valores inválidos', (t) => {
  const db = createDatabase(t);
  const fixtures = seed(db);

  db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
    .run(fixtures.teacherOneId);
  assert.throws(
    () => db.prepare(`
      UPDATE teacher_grade_preference_profiles
      SET teacher_id = ?
      WHERE teacher_id = ?
    `).run(fixtures.teacherTwoId, fixtures.teacherOneId),
    /invalid_teacher_grade_preference_update/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE teacher_grade_preference_profiles
      SET revision = 0
      WHERE teacher_id = ?
    `).run(fixtures.teacherOneId),
    /CHECK constraint failed/
  );
});
