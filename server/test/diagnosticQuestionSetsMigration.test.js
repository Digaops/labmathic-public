const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration007 = require('../src/migrations/007_diagnostic_question_sets');
const migration009 = require('../src/migrations/009_diagnostic_teacher_review');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL
    );
    CREATE TABLE grades (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      grade_id INTEGER NOT NULL,
      FOREIGN KEY (grade_id) REFERENCES grades(id)
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER NOT NULL,
      FOREIGN KEY (skill_id) REFERENCES bncc_skills(id)
    );
    CREATE TABLE question_sets (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE question_set_items (
      id INTEGER PRIMARY KEY,
      question_set_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      show_image INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );

    INSERT INTO users VALUES
      (1, 'Professora', 'professora@teste.local', 'hash', 'professor'),
      (2, 'Admin', 'admin@teste.local', 'hash', 'admin'),
      (3, 'Outro professor', 'outro@teste.local', 'hash', 'professor');
    INSERT INTO grades VALUES (7, '7o Ano'), (8, '8o Ano');
    INSERT INTO bncc_skills VALUES
      (70, 'EF07MA01', 'Habilidade um', 7),
      (71, 'EF07MA02', 'Habilidade dois', 7),
      (80, 'EF08MA01', 'Habilidade de outro ano', 8);
    INSERT INTO questions VALUES
      (700, 'EF07MA01-Q001', 70),
      (701, 'EF07MA01-Q002', 70);
    INSERT INTO question_sets VALUES
      (100, 1, 'Diagnostico privado', 0),
      (101, 1, 'Simulado publico', 1),
      (102, 2, 'Simulado administrativo', 0),
      (103, 3, 'Simulado de outro professor', 0);
    INSERT INTO question_set_items VALUES
      (1000, 100, 700, 1, 1),
      (1001, 100, 701, 2, 1);
  `);
  migration002.up(db);
  db.prepare(`
    INSERT INTO product_releases (version, title, status)
    VALUES ('2.0.0', 'Turmas e diagnosticos', 'draft')
  `).run();
  migration007.up(db);
  migration009.up(db);
  return db;
}

function insertDiagnostic(db, questionSetId = 100, ownerId = 1) {
  db.prepare(`
    INSERT INTO diagnostic_question_sets (
      question_set_id, owner_teacher_id, grade_id,
      questions_per_skill, total_questions
    ) VALUES (?, ?, 7, 2, 2)
  `).run(questionSetId, ownerId);
  db.prepare(`
    INSERT INTO diagnostic_question_set_skills (
      question_set_id, owner_teacher_id, grade_id, skill_id,
      requested_count, selected_count, easy_count, medium_count,
      difficult_count, candidate_count
    ) VALUES (?, ?, 7, 70, 2, 2, 1, 1, 0, 8)
  `).run(questionSetId, ownerId);
}

test('migração 007 cria metadados diagnósticos e flag desligada por padrão', () => {
  const db = createDatabase();
  insertDiagnostic(db);

  assert.deepEqual(
    db.prepare(`
      SELECT questions_per_skill, total_questions, algorithm_version, cycle_stage
      FROM diagnostic_question_sets WHERE question_set_id = 100
    `).get(),
    {
      questions_per_skill: 2,
      total_questions: 2,
      algorithm_version: 'balanced-v1',
      cycle_stage: 'diagnostic',
    }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage
      FROM feature_flags WHERE flag_key = 'question_bank.diagnostic_generator'
    `).get(),
    {
      flag_key: 'question_bank.diagnostic_generator',
      master_enabled: 0,
      default_enabled: 0,
      rollout_percentage: 0,
    }
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('banco exige professor proprietário, simulado privado e habilidade do mesmo ano', () => {
  const db = createDatabase();
  assert.throws(() => insertDiagnostic(db, 101, 1), /diagnostic_question_set_must_be_private_and_owned/);
  assert.throws(() => insertDiagnostic(db, 102, 2), /diagnostic_requires_professor/);
  assert.throws(() => insertDiagnostic(db, 103, 1), /diagnostic_question_set_must_be_private_and_owned/);

  insertDiagnostic(db);
  assert.throws(() => db.prepare(`
    INSERT INTO diagnostic_question_set_skills (
      question_set_id, owner_teacher_id, grade_id, skill_id,
      requested_count, selected_count, easy_count, medium_count,
      difficult_count, candidate_count
    ) VALUES (100, 1, 7, 80, 2, 2, 1, 1, 0, 8)
  `).run(), /FOREIGN KEY constraint failed/);
  db.close();
});

test('composição fica imutável, imagem continua configurável e exclusão do simulado é possível', () => {
  const db = createDatabase();
  insertDiagnostic(db);

  assert.throws(
    () => db.prepare('UPDATE question_sets SET is_public = 1 WHERE id = 100').run(),
    /diagnostic_question_set_is_private/
  );
  assert.throws(
    () => db.prepare('UPDATE question_set_items SET sort_order = 3 WHERE id = 1000').run(),
    /diagnostic_question_selection_is_immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM question_set_items WHERE id = 1000').run(),
    /diagnostic_question_selection_is_immutable/
  );
  db.prepare('UPDATE question_set_items SET show_image = 0 WHERE id = 1000').run();
  assert.equal(db.prepare('SELECT show_image FROM question_set_items WHERE id = 1000').pluck().get(), 0);

  db.prepare('DELETE FROM question_sets WHERE id = 100').run();
  assert.equal(db.prepare('SELECT COUNT(*) FROM diagnostic_question_sets').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_set_items WHERE question_set_id = 100').pluck().get(), 0);
  db.close();
});

test('migração 009 exige confirmação única do professor proprietário e preserva o registro', () => {
  const db = createDatabase();
  insertDiagnostic(db);

  assert.equal(
    db.prepare('SELECT COUNT(*) FROM diagnostic_question_set_reviews').pluck().get(),
    0,
    'diagnósticos existentes devem começar pendentes, sem confirmação presumida'
  );
  assert.throws(() => db.prepare(`
    INSERT INTO diagnostic_question_set_reviews (
      question_set_id, owner_teacher_id, reviewed_by
    ) VALUES (100, 1, 2)
  `).run(), /CHECK constraint failed|diagnostic_review_requires_professor/);
  assert.throws(() => db.prepare(`
    INSERT INTO diagnostic_question_set_reviews (
      question_set_id, owner_teacher_id, reviewed_by
    ) VALUES (100, 3, 3)
  `).run(), /diagnostic_review_requires_owner/);

  db.prepare(`
    INSERT INTO diagnostic_question_set_reviews (
      question_set_id, owner_teacher_id, reviewed_by
    ) VALUES (100, 1, 1)
  `).run();
  const review = db.prepare(`
    SELECT owner_teacher_id, reviewed_by, confirmation_version
    FROM diagnostic_question_set_reviews WHERE question_set_id = 100
  `).get();
  assert.deepEqual(review, {
    owner_teacher_id: 1,
    reviewed_by: 1,
    confirmation_version: 'teacher-review-v1',
  });
  assert.throws(
    () => db.prepare(`
      UPDATE diagnostic_question_set_reviews SET reviewed_at = CURRENT_TIMESTAMP
      WHERE question_set_id = 100
    `).run(),
    /diagnostic_review_is_immutable/
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});
