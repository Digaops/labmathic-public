const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const migration006 = require('../src/migrations/006_class_assessment_objective_results');

function createDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-assessment-results-'));
  const db = new Database(path.join(tempDir, 'database.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY);
    CREATE TABLE class_assessment_assignments (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      question_count INTEGER NOT NULL,
      UNIQUE(id, class_id, owner_teacher_id)
    );
    CREATE TABLE class_assessment_participants (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL
    );
    CREATE TABLE class_assessment_items (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      UNIQUE(id, assignment_id, class_id, owner_teacher_id)
    );
    CREATE TABLE class_assessment_item_options (
      id INTEGER PRIMARY KEY,
      assessment_item_id INTEGER NOT NULL,
      assignment_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      is_correct INTEGER NOT NULL
    );
    INSERT INTO users (id) VALUES (10);
    INSERT INTO class_assessment_assignments
      (id, class_id, owner_teacher_id, status, question_count)
      VALUES (100, 200, 10, 'open', 2), (101, 201, 10, 'draft', 1);
    INSERT INTO class_assessment_participants
      (id, assignment_id, class_id, student_id, owner_teacher_id)
      VALUES (300, 100, 200, 400, 10), (301, 101, 201, 401, 10);
    INSERT INTO class_assessment_items
      (id, assignment_id, class_id, owner_teacher_id)
      VALUES (500, 100, 200, 10), (501, 100, 200, 10);
    INSERT INTO class_assessment_item_options
      (id, assessment_item_id, assignment_id, class_id, owner_teacher_id, is_correct)
      VALUES
        (600, 500, 100, 200, 10, 1),
        (601, 500, 100, 200, 10, 0),
        (602, 501, 100, 200, 10, 1),
        (603, 501, 100, 200, 10, 0);
  `);
  migration006.up(db);

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
  return db;
}

function insertDraftAttempt(db, overrides = {}) {
  const values = {
    publicId: 'attempt-public-id-00000001',
    participantId: 300,
    assignmentId: 100,
    classId: 200,
    studentId: 400,
    ownerTeacherId: 10,
    attemptNumber: 1,
    supersedesAttemptId: null,
    questionCount: 2,
    ...overrides,
  };
  return Number(db.prepare(`
    INSERT INTO class_assessment_attempts (
      public_id, participant_id, assignment_id, class_id, student_id,
      owner_teacher_id, attempt_number, supersedes_attempt_id,
      question_count, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    values.publicId,
    values.participantId,
    values.assignmentId,
    values.classId,
    values.studentId,
    values.ownerTeacherId,
    values.attemptNumber,
    values.supersedesAttemptId,
    values.questionCount,
    values.ownerTeacherId,
    values.ownerTeacherId
  ).lastInsertRowid);
}

function insertResponse(db, attemptId, itemId, optionId, isCorrect) {
  db.prepare(`
    INSERT INTO class_assessment_responses (
      attempt_id, assessment_item_id, selected_option_id,
      assignment_id, class_id, owner_teacher_id, is_correct, answered_at
    ) VALUES (?, ?, ?, 100, 200, 10, ?, ?)
  `).run(
    attemptId,
    itemId,
    optionId,
    isCorrect,
    optionId ? '2026-08-14T03:00:00.000Z' : null
  );
}

test('migração 006 registra gabarito objetivo, brancos e pontuação coerente', (t) => {
  const db = createDatabase(t);
  const attemptId = insertDraftAttempt(db);
  insertResponse(db, attemptId, 500, 600, 1);
  insertResponse(db, attemptId, 501, null, 0);

  db.prepare(`
    UPDATE class_assessment_attempts
    SET status = 'submitted', answered_count = 1, correct_count = 1,
        score_percentage = 50, submitted_at = '2026-08-14T03:05:00.000Z',
        revision = revision + 1
    WHERE id = ?
  `).run(attemptId);

  assert.deepEqual(db.prepare(`
    SELECT status, answered_count, correct_count, score_percentage, revision
    FROM class_assessment_attempts WHERE id = ?
  `).get(attemptId), {
    status: 'submitted', answered_count: 1, correct_count: 1, score_percentage: 50, revision: 2,
  });
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('banco calcula confiança: recusa gabarito, pontuação e vínculos incoerentes', (t) => {
  const db = createDatabase(t);
  const attemptId = insertDraftAttempt(db);

  assert.throws(
    () => insertResponse(db, attemptId, 500, 601, 1),
    /assessment_response_score_mismatch/
  );
  assert.throws(
    () => insertResponse(db, attemptId, 500, 602, 1),
    /assessment_response_score_mismatch|FOREIGN KEY constraint failed/
  );

  insertResponse(db, attemptId, 500, 600, 1);
  insertResponse(db, attemptId, 501, 603, 0);
  assert.throws(
    () => db.prepare(`
      UPDATE class_assessment_attempts
      SET status = 'submitted', answered_count = 2, correct_count = 2,
          score_percentage = 100, submitted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(attemptId),
    /assessment_attempt_score_mismatch/
  );
});

test('envio torna respostas imutáveis e versões históricas legadas permanecem rastreáveis', (t) => {
  const db = createDatabase(t);
  const attemptId = insertDraftAttempt(db);
  insertResponse(db, attemptId, 500, 600, 1);
  insertResponse(db, attemptId, 501, 603, 0);
  db.prepare(`
    UPDATE class_assessment_attempts
    SET status = 'submitted', answered_count = 2, correct_count = 1,
        score_percentage = 50, submitted_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(attemptId);

  assert.throws(
    () => db.prepare('DELETE FROM class_assessment_responses WHERE attempt_id = ?')
      .run(attemptId),
    /assessment_responses_are_immutable/
  );
  assert.throws(
    () => db.prepare('UPDATE class_assessment_attempts SET score_percentage = 60 WHERE id = ?')
      .run(attemptId),
    /submitted_assessment_score_is_immutable/
  );

  db.prepare(`
    UPDATE class_assessment_attempts
    SET status = 'voided', voided_at = CURRENT_TIMESTAMP, revision = revision + 1
    WHERE id = ?
  `).run(attemptId);
  const replacementId = insertDraftAttempt(db, {
    publicId: 'attempt-public-id-00000002',
    attemptNumber: 2,
    supersedesAttemptId: attemptId,
  });
  assert.equal(
    db.prepare('SELECT supersedes_attempt_id FROM class_assessment_attempts WHERE id = ?')
      .pluck().get(replacementId),
    attemptId
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_attempts').pluck().get(), 2);
});

test('tentativa só nasce para aplicação disponível e existe uma versão corrente', (t) => {
  const db = createDatabase(t);
  insertDraftAttempt(db);
  assert.throws(
    () => insertDraftAttempt(db, {
      publicId: 'attempt-public-id-00000003',
      attemptNumber: 2,
    }),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => insertDraftAttempt(db, {
      publicId: 'attempt-public-id-00000004',
      participantId: 301,
      assignmentId: 101,
      classId: 201,
      studentId: 401,
      questionCount: 1,
    }),
    /assessment_attempt_assignment_unavailable/
  );
});
