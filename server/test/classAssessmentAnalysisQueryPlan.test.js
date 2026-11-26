const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { performance } = require('node:perf_hooks');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-analysis-query-'));
process.env.DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.JWT_SECRET = 'isolated-assessment-query-plan-test-secret';
const db = require('../src/database');
const { loadQuestionResults } = require('../src/services/classAssessmentAnalysis');
const { scoredResponses, loadNumericQuestions, insertNumericSnapshot, saveNumericResponse } = require('../src/services/numericAssessments');
const { saveNumericDraft } = require('../src/services/numericQuestionDrafts');
const { submitNumericReview, decideNumericReview } = require('../src/services/numericEditorial');

// The previous aggregation is the regression oracle; the current SQL is captured
// from prepare() so EXPLAIN always checks the query actually used by the service.
function previousQuery() {
  return `SELECT item.id, item.source_skill_id, item.question_code_snapshot,
    substr(item.statement_snapshot, 1, 240) AS statement_preview,
    item.skill_code_snapshot, item.skill_description_snapshot, item.sort_order,
    COUNT(response.id) AS response_count,
    SUM(CASE WHEN response.answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
    SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM class_assessment_items item
    LEFT JOIN ${scoredResponses(db)} response ON response.assessment_item_id = item.id
      AND EXISTS (SELECT 1 FROM class_assessment_attempts submitted_attempt
        WHERE submitted_attempt.id = response.attempt_id AND submitted_attempt.status = 'submitted')
    WHERE item.assignment_id = ? GROUP BY item.id ORDER BY item.sort_order, item.id`;
}

function observedResults(assignmentId) {
  let observed;
  const database = { prepare(sql) {
    const statement = db.prepare(sql);
    if (!sql.includes('COUNT(response.id)')) return statement;
    return { all(...parameters) {
      observed = { sql, parameters, rows: statement.all(...parameters) };
      return observed.rows;
    } };
  } };
  return { results: loadQuestionResults(database, assignmentId), ...observed };
}

let teacher, schoolClass, skillId, numericQuestions, objective, numeric, empty;
function student() {
  const id = Number(db.prepare(`INSERT INTO students(public_id,owner_teacher_id,display_name)
    VALUES(?,?,'Estudante sintético')`).run(randomUUID(), teacher.id).lastInsertRowid);
  const enrollmentId = Number(db.prepare(`INSERT INTO school_class_enrollments(class_id,student_id,owner_teacher_id)
    VALUES(?,?,?)`).run(schoolClass, id, teacher.id).lastInsertRowid);
  return { id, enrollmentId };
}

function assessment(isNumeric = false, learners = Array.from({ length: 4 }, student)) {
  const id = Number(db.prepare(`INSERT INTO class_assessment_assignments
    (public_id,class_id,owner_teacher_id,title_snapshot,snapshot_hash,question_count)
    VALUES(?,?,?,'Consulta sintética',?,3)`)
    .run(randomUUID(), schoolClass, teacher.id, 'a'.repeat(64)).lastInsertRowid);
  const items = Array.from({ length: 3 }, (_, index) => {
    const question = isNumeric ? numericQuestions[index] : null;
    const itemId = Number(db.prepare(`INSERT INTO class_assessment_items
      (assignment_id,class_id,owner_teacher_id,source_question_id,source_skill_id,
       question_code_snapshot,skill_code_snapshot,skill_description_snapshot,statement_snapshot,difficulty_snapshot,sort_order)
      VALUES(?,?,?,?,?,?,'EF06MA01-QUERY','Habilidade sintética',?,'media',?)`)
      .run(id, schoolClass, teacher.id, question?.sourceQuestionId || null, skillId,
        question?.questionCode || `QUERY-${index}`, question?.statement || `Enunciado sintético ${index}`, index).lastInsertRowid);
    if (question) {
      insertNumericSnapshot(db, itemId, question.typed);
      return { id: itemId, definition: JSON.parse(question.typed.definition_json) };
    }
    const options = ['A', 'B', 'C', 'D'].map((label, order) => Number(db.prepare(`INSERT INTO class_assessment_item_options
      (assessment_item_id,assignment_id,class_id,owner_teacher_id,option_label,option_text_snapshot,is_correct,sort_order)
      VALUES(?,?,?,?,?,'Alternativa sintética',?,?)`).run(itemId, id, schoolClass, teacher.id, label, Number(order === 0), order).lastInsertRowid));
    return { id: itemId, options };
  });
  if (isNumeric) db.prepare(`INSERT INTO class_assessment_numeric_origins
    (assignment_id,owner_teacher_id,request_key,request_hash) VALUES(?,?,?,?)`)
    .run(id, teacher.id, randomUUID(), 'b'.repeat(64));
  const participants = new Map(learners.map(learner => [learner.id, Number(db.prepare(`INSERT INTO class_assessment_participants
    (assignment_id,class_id,student_id,enrollment_id,owner_teacher_id) VALUES(?,?,?,?,?)`)
    .run(id, schoolClass, learner.id, learner.enrollmentId, teacher.id).lastInsertRowid)]));
  db.prepare(`UPDATE class_assessment_assignments SET status='open',opened_at=CURRENT_TIMESTAMP,
    revision=revision+1 WHERE id=?`).run(id);
  return { id, items, isNumeric, learners, participants, nextParticipant: 0 };
}

function attempt(assignment, answers, status = 'submitted', learner = assignment.learners[assignment.nextParticipant++]) {
  const participantId = assignment.participants.get(learner.id);
  const id = Number(db.prepare(`INSERT INTO class_assessment_attempts
    (public_id,participant_id,assignment_id,class_id,student_id,owner_teacher_id,question_count)
    VALUES(?,?,?,?,?,?,3)`).run(randomUUID(), participantId, assignment.id, schoolClass, learner.id, teacher.id).lastInsertRowid);
  assignment.items.forEach((item, index) => {
    const answer = answers[index];
    if (assignment.isNumeric) {
      saveNumericResponse(db, { id, assignment_id: assignment.id, class_id: schoolClass, owner_teacher_id: teacher.id },
        item.id, answer === null ? null : answer ? '0' : '9', item.definition);
    } else {
      db.prepare(`INSERT INTO class_assessment_responses
        (attempt_id,assessment_item_id,selected_option_id,assignment_id,class_id,owner_teacher_id,is_correct,answered_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(id, item.id, answer === null ? null : item.options[answer ? 0 : 1],
        assignment.id, schoolClass, teacher.id, Number(answer === true), answer === null ? null : '2026-10-12T00:00:00.000Z');
    }
  });
  if (status !== 'draft') {
    const correct = answers.filter(answer => answer === true).length;
    db.prepare(`UPDATE class_assessment_attempts SET status='submitted',answered_count=?,correct_count=?,
      score_percentage=?,submitted_at=CURRENT_TIMESTAMP WHERE id=?`)
      .run(answers.filter(answer => answer !== null).length, correct, correct * 100 / 3, id);
    if (status === 'voided') db.prepare(`UPDATE class_assessment_attempts
      SET status='voided',voided_at=CURRENT_TIMESTAMP WHERE id=?`).run(id);
  }
  return id;
}

test.before(() => {
  const user = role => ({ id: Number(db.prepare(`INSERT INTO users(name,email,password,role)
    VALUES('Pessoa sintética',?,'synthetic',?)`).run(`${randomUUID()}@query.invalid`, role).lastInsertRowid), role });
  teacher = user('professor');
  const admin = user('admin');
  db.prepare(`UPDATE feature_flags SET master_enabled=1,default_enabled=1
    WHERE flag_key IN ('question_bank.numeric_drafts','classes.numeric_assessments')`).run();
  const gradeId = Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('6º consulta',6)").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units(name) VALUES('Unidade sintética')").run().lastInsertRowid);
  skillId = Number(db.prepare(`INSERT INTO bncc_skills(code,description,grade_id,unit_id)
    VALUES('EF06MA01-QUERY','Habilidade sintética',?,?)`).run(gradeId, unitId).lastInsertRowid);
  schoolClass = Number(db.prepare(`INSERT INTO school_classes(public_id,owner_teacher_id,name,grade_id,academic_year)
    VALUES(?,?,'Turma sintética',?,2026)`).run(randomUUID(), teacher.id, gradeId).lastInsertRowid);
  const versions = Array.from({ length: 3 }, (_, index) => {
    const draft = saveNumericDraft(db, { actor: teacher, idempotencyKey: randomUUID(), input: {
      gradeId, unitId, skillId, statement: `Qual é o valor de zero no exemplo ${index}?`, answer: '0',
      unit: '', supportText: '', difficulty: 'media', explanation: 'O resultado deste exemplo é zero.',
    } });
    const review = submitNumericReview(db, { actor: teacher, publicId: draft.publicId,
      expectedRevision: draft.revision, confirmed: true, idempotencyKey: randomUUID() }).review;
    decideNumericReview(db, { actor: admin, publicId: review.publicId, expectedRevision: review.revision,
      decision: 'approved', reason: 'Enunciado, habilidade e resposta conferidos.', idempotencyKey: randomUUID() });
    return draft.publicId;
  });
  numericQuestions = loadNumericQuestions(db, teacher, versions);
  objective = assessment(); numeric = assessment(true); empty = assessment();
  for (const assignment of [objective, numeric]) {
    attempt(assignment, [true, false, null]);
    attempt(assignment, [null, true, null]);
    attempt(assignment, [true, true, true], 'draft');
    attempt(assignment, [true, true, true], 'voided');
  }
});

test.after(() => {
  db.close();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^labmathic-analysis-query-/);
  fs.rmSync(directory, { recursive: true, force: true });
});

for (const isNumeric of [false, true]) test(`análise ${isNumeric ? 'numérica' : 'objetiva'} preserva brancos e ignora rascunhos e anulações`, () => {
  const assignment = isNumeric ? numeric : objective;
  const current = observedResults(assignment.id);
  assert.deepEqual(current.rows, db.prepare(previousQuery()).all(assignment.id));
  assert.deepEqual(current.results.map(row => [row.responseCount, row.answeredCount, row.correctCount, row.successRate]),
    [[2, 1, 1, 50], [2, 2, 1, 50], [2, 0, 0, 0]]);
  assert.deepEqual(current.results.map(row => row.number), [1, 2, 3]);
});

test('avaliação sem respostas mantém os itens e percentuais nulos', () => {
  const current = observedResults(empty.id);
  assert.deepEqual(current.rows, db.prepare(previousQuery()).all(empty.id));
  assert.equal(current.results.length, 3);
  for (const row of current.results) {
    assert.equal(row.responseCount, 0);
    assert.equal(row.answeredCount, 0);
    assert.equal(row.correctCount, 0);
    assert.equal(row.successRate, null);
    assert.equal(row.errorRate, null);
  }
});

test('plano real consulta respostas por tentativa sem varrer avaliações alheias', t => {
  const learners = 1000;
  db.transaction(() => {
    const participants = Array.from({ length: learners }, student);
    const unrelatedObjective = assessment(false, participants);
    const unrelatedNumeric = assessment(true, participants);
    for (const learner of participants) {
      attempt(unrelatedObjective, [true, false, null], 'submitted', learner);
      attempt(unrelatedNumeric, [true, false, null], 'submitted', learner);
    }
  })();
  const current = observedResults(objective.id);
  const plan = db.prepare(`EXPLAIN QUERY PLAN ${current.sql}`).all(...current.parameters).map(row => row.detail);
  for (const table of ['class_assessment_responses', 'class_assessment_numeric_responses']) {
    assert.ok(plan.some(detail => detail.startsWith(`SEARCH ${table} `) && /attempt_id=\?/.test(detail)), plan.join('\n'));
    assert.ok(!plan.some(detail => detail.startsWith(`SCAN ${table}`)), plan.join('\n'));
  }
  assert.ok(plan.some(detail => detail.includes('assignment_id=? AND status=?')), plan.join('\n'));
  const oldSql = previousQuery();
  const previousPlan = db.prepare(`EXPLAIN QUERY PLAN ${oldSql}`).all(objective.id).map(row => row.detail);
  const before = performance.now();
  const previousRows = db.prepare(oldSql).all(objective.id);
  const oldMs = performance.now() - before;
  const after = performance.now();
  const newRows = db.prepare(current.sql).all(...current.parameters);
  const newMs = performance.now() - after;
  assert.deepEqual(newRows, previousRows);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  t.diagnostic(JSON.stringify({ unrelatedResponses: learners * 6, oldMs, newMs, previousPlan, plan }));
});

test('fallback anterior à view numérica conserva resultados e usa índice de tentativa', () => {
  // Only the compatibility view is absent; all production tables, indexes and
  // write guards remain intact. No numeric write occurs while it is absent.
  const viewSql = db.prepare("SELECT sql FROM sqlite_master WHERE type='view' AND name='class_assessment_scored_responses'").pluck().get();
  db.exec('DROP VIEW class_assessment_scored_responses');
  try {
    const current = observedResults(objective.id);
    assert.deepEqual(current.rows, db.prepare(previousQuery()).all(objective.id));
    const plan = db.prepare(`EXPLAIN QUERY PLAN ${current.sql}`).all(...current.parameters).map(row => row.detail);
    assert.ok(!plan.some(detail => detail.startsWith('SCAN class_assessment_responses')), plan.join('\n'));
    assert.deepEqual(current.results.map(row => row.successRate), [50, 50, 0]);
  } finally { db.exec(viewSql); }
});
