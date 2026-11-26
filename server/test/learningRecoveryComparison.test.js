const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { buildMatchedRecoveryComparison } = require('../src/services/learningRecoveryComparison');
const viewModule = import('../../client/src/services/recoveryComparisonView.mjs');

// Deliberately small in-memory schema for read-only aggregation edge cases.
// The route suite exercises the same service with real migrations/triggers.
function fixture(t, { beforeQuestions = 2, afterQuestions = 1 } = {}) {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE school_classes(id INTEGER PRIMARY KEY, owner_teacher_id INTEGER);
    CREATE TABLE class_assessment_assignments(id INTEGER PRIMARY KEY, owner_teacher_id INTEGER, class_id INTEGER, status TEXT);
    CREATE TABLE class_assessment_participants(id INTEGER PRIMARY KEY, assignment_id INTEGER, student_id INTEGER, status TEXT);
    CREATE TABLE class_assessment_attempts(id INTEGER PRIMARY KEY, assignment_id INTEGER, participant_id INTEGER, status TEXT);
    CREATE TABLE class_assessment_items(id INTEGER PRIMARY KEY, assignment_id INTEGER, skill_code_snapshot TEXT);
    CREATE TABLE class_assessment_responses(id INTEGER PRIMARY KEY, assignment_id INTEGER, attempt_id INTEGER, assessment_item_id INTEGER, is_correct INTEGER);
    INSERT INTO school_classes VALUES (1,10),(2,20);
    INSERT INTO class_assessment_assignments VALUES (1,10,1,'closed'),(2,10,1,'closed');
  `);
  for (const [assignment, questions] of [[1, beforeQuestions], [2, afterQuestions]]) {
    for (let index = 0; index < questions; index++) db.prepare('INSERT INTO class_assessment_items(assignment_id,skill_code_snapshot) VALUES (?,?)').run(assignment, 'EF07MA01');
  }
  function result(assignment, student, correct, { participation = 'assigned', status = 'submitted', missing = 0 } = {}) {
    const participant = db.prepare('INSERT INTO class_assessment_participants(assignment_id,student_id,status) VALUES (?,?,?)').run(assignment, student, participation).lastInsertRowid;
    const attempt = db.prepare('INSERT INTO class_assessment_attempts(assignment_id,participant_id,status) VALUES (?,?,?)').run(assignment, participant, status).lastInsertRowid;
    const items = db.prepare('SELECT id FROM class_assessment_items WHERE assignment_id=? ORDER BY id').all(assignment);
    items.slice(0, items.length - missing).forEach((item, index) => db.prepare('INSERT INTO class_assessment_responses(assignment_id,attempt_id,assessment_item_id,is_correct) VALUES (?,?,?,?)').run(assignment, attempt, item.id, Number(index < correct)));
  }
  const baseline = { skill_code_snapshot: 'EF07MA01', skill_description_snapshot: 'Comparar inteiros.', success_rate_snapshot: 50, opportunity_count: 4 };
  const options = { teacherId: 10, classId: 1, sourceAssignmentId: 1, monitoringAssignmentId: 2, baselineSkills: [baseline] };
  return { db, result, options, compare: () => buildMatchedRecoveryComparison(db, options) };
}

test('reprodução: compara Alfa 0→100, não a turma 50→100; preserva snapshot e não grava', async t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(1, 102, 2); f.result(2, 101, 1);
  const changes = f.db.prepare('SELECT total_changes()').pluck().get();
  const comparison = f.compare(), s = comparison.skills[0];
  assert.equal(comparison.methodology, 'matched-students-v2');
  assert.deepEqual([s.diagnosticRate, s.monitoringRate, s.delta], [0, 100, 100]);
  assert.deepEqual(s.diagnosticSnapshot, { rate: 50, opportunities: 4 });
  assert.deepEqual(s.cohort, { status: 'matched', studentCount: 1, diagnosticStudentCount: 2, monitoringStudentCount: 1, excludedDiagnosticCount: 1, excludedMonitoringCount: 0 });
  assert.deepEqual([s.diagnosticQuestionCount, s.monitoringQuestionCount, s.diagnosticOpportunities, s.monitoringOpportunities], [2, 1, 2, 1]);
  assert.equal(s.evidence.level, 'limited');
  assert.doesNotMatch(JSON.stringify(comparison), /student_id|101|102/);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
  const view = (await viewModule).recoveryComparisonView(comparison);
  assert.match(view.skills[0].groupLabel, /1 estudante comparado/);
  assert.match(view.skills[0].evidenceNotice, /não confirma o domínio/);
});

test('mesmos estudantes: arredondamento, queda e estabilidade sem inventar ausência', async t => {
  const f = fixture(t, { beforeQuestions: 3, afterQuestions: 3 });
  f.result(1, 101, 2); f.result(2, 101, 1);
  let s = f.compare().skills[0];
  assert.deepEqual([s.diagnosticRate, s.monitoringRate, s.delta], [66.67, 33.33, -33.34]);
  assert.equal(s.trajectory, 'declined');
  (await viewModule).validateRecoveryComparison(f.compare());
  f.result(1, 102, 1); f.result(2, 102, 2);
  s = f.compare().skills[0];
  assert.deepEqual([s.diagnosticRate, s.monitoringRate, s.delta], [50, 50, 0]);
  assert.equal(s.trajectory, 'stable');
});

test('sem estudantes em comum: ausência não vira 0%, delta nem evolução', async t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 102, 1);
  const s = f.compare().skills[0];
  assert.equal(s.cohort.status, 'no_common_results');
  assert.deepEqual([s.diagnosticRate, s.monitoringRate, s.delta], [null, null, null]);
  assert.equal(s.evidence.level, 'insufficient');
  const view = (await viewModule).recoveryComparisonView(f.compare());
  assert.equal(view.skills[0].comparable, false);
  assert.match(view.skills[0].groupLabel, /Não há estudantes/);
});

for (const side of [1, 2]) for (const [name, options] of [
  ['dispensado', { participation: 'exempted' }], ['rascunho', { status: 'draft' }],
  ['anulado', { status: 'voided' }], ['registro incompleto', { missing: 1 }],
]) test(`exclui ${name} na etapa ${side}, sem contaminar quem concluiu`, async t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 101, 1);
  f.result(1, 102, 2, side === 1 ? options : {}); f.result(2, 102, 0, side === 2 ? options : {});
  const s = f.compare().skills[0];
  assert.equal(s.cohort.studentCount, 1);
  assert.deepEqual([s.diagnosticRate, s.monitoringRate], [0, 100]);
  (await viewModule).validateRecoveryComparison(f.compare());
});

test('pareamento é por habilidade; não usa resultado de outro conteúdo como base', t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 101, 1);
  f.db.prepare("UPDATE class_assessment_items SET skill_code_snapshot='EF07MA02' WHERE assignment_id=2").run();
  assert.equal(f.compare().skills[0].cohort.studentCount, 0);
  assert.equal(f.compare().skills[0].monitoringRate, null);
});

test('duas etapas com questões suficientes mantêm aviso descritivo, sem inferência causal', async t => {
  const f = fixture(t, { beforeQuestions: 3, afterQuestions: 3 });
  for (let student = 100; student < 120; student++) { f.result(1, student, 1); f.result(2, student, 3); }
  assert.equal(f.compare().skills[0].evidence.level, 'broader');
  const view = (await viewModule).recoveryComparisonView(f.compare());
  assert.match(view.notice, /não prova o efeito/);
  assert.match(view.skills[0].evidenceNotice, /não resume tudo/);
});

for (const field of ['teacherId', 'classId', 'sourceAssignmentId']) test(`recusa comparação fora do escopo: ${field}`, async t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 101, 1); f.options[field] = 999;
  const s = f.compare().skills[0];
  assert.equal(s.cohort.status, 'source_unavailable');
  assert.deepEqual([s.diagnosticRate, s.monitoringRate, s.delta], [null, null, null]);
  assert.equal(s.cohort.diagnosticStudentCount, 0);
  (await viewModule).validateRecoveryComparison(f.compare());
});

test('não compara fonte reaberta nem avaliação consigo mesma', t => {
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 101, 1);
  f.db.prepare("UPDATE class_assessment_assignments SET status='open' WHERE id=1").run();
  assert.equal(f.compare().skills[0].cohort.status, 'source_unavailable');
  f.db.prepare("UPDATE class_assessment_assignments SET status='closed' WHERE id=1").run();
  f.options.monitoringAssignmentId = 1;
  assert.equal(f.compare().skills[0].delta, null);
});

test('histórico legado permanece intacto e recebe aviso, sem delta apresentável', async () => {
  const { recoveryComparisonView } = await viewModule;
  const legacy = { methodology: 'descriptive-comparison-v1', skills: [{ code: 'EF07MA01', diagnosticRate: 50, monitoringRate: 100, delta: 50 }] };
  const original = JSON.stringify(legacy), view = recoveryComparisonView(legacy);
  assert.equal(view.legacy, true); assert.equal(view.skills[0].comparable, false);
  assert.match(view.notice, /Registro antigo/); assert.match(view.notice, /Não interprete/);
  assert.equal(JSON.stringify(legacy), original);
  assert.equal(recoveryComparisonView({ ...legacy, methodology: undefined }).legacy, true);
});

test('cliente recusa contrato v2 incompleto, contagem incoerente, NaN e delta inventado', async t => {
  const { validateRecoveryComparison } = await viewModule;
  const f = fixture(t); f.result(1, 101, 0); f.result(2, 101, 1);
  for (const mutate of [s => { delete s.cohort; }, s => { s.cohort.studentCount = 2; },
    s => { s.delta = 50; }, s => { s.monitoringRate = NaN; }, s => { s.diagnosticOpportunities = 99; },
    s => { s.evidence.level = 'certain'; }, s => { s.diagnosticRate = -1; }]) {
    const value = f.compare(); mutate(value.skills[0]); assert.throws(() => validateRecoveryComparison(value));
  }
});
