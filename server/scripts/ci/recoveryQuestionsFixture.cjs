// Opt-in synthetic setup only. The interactive test authors the new question through the UI.
const assert = require('node:assert/strict');

async function seedRecoveryQuestions({ baseUrl, db, teacher, tokenFor, classPublicId, assessmentPublicId }) {
  assert.equal(process.env.SCREEN_LAYOUT_AUDIT, '1');
  assert.equal(process.env.PLATFORM_JOURNEY_AUDIT, '1');
  assert.equal(process.env.RECOVERY_QUESTIONS_AUDIT, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  let operation = 0;
  const token = tokenFor(teacher);
  async function api(url, method = 'GET', body) {
    const response = await fetch(baseUrl + '/api' + url, { method,
      headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json',
        'Idempotency-Key': 'recovery-questions-fixture-' + (++operation) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, url + ': ' + JSON.stringify(value));
    return value;
  }
  const source = db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE public_id = ?').pluck().get(assessmentPublicId);
  const participants = db.prepare(`SELECT s.public_id FROM students s
    JOIN school_class_enrollments e ON e.student_id = s.id
    JOIN school_classes c ON c.id = e.class_id WHERE c.public_id = ? AND e.status = 'active'`)
    .all(classPublicId).map(s => s.public_id);
  const assignment = await api(`/classes/${classPublicId}/assessments`, 'POST', {
    sourceQuestionSetId: source, participantIds: participants,
  });
  const assignmentPath = `/classes/${classPublicId}/assessments/${assignment.id}`;
  const opened = await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: assignment.revision, action: 'open' });
  for (const id of participants.slice(0, 2)) {
    const entry = await api(assignmentPath + '/results/participants/' + id);
    const saved = await api(assignmentPath + '/results/participants/' + id, 'PUT', {
      expectedRevision: 0, responses: entry.items.map(item => ({ itemId: item.id,
        optionId: db.prepare('SELECT id FROM class_assessment_item_options WHERE assessment_item_id = ? AND is_correct = 0 LIMIT 1').pluck().get(item.id) })),
    });
    await api(assignmentPath + '/results/participants/' + id + '/submit', 'POST', { expectedRevision: saved.attempt.revision });
  }
  await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: opened.revision, action: 'close' });
  const preview = await api(assignmentPath + '/results/recovery-preview');
  const priority = preview.priorities.find(p => p.skill.code === 'EF07MA02');
  assert.ok(priority);
  const payload = { expectedAssessmentRevision: preview.source.assessment.revision,
    expectedResultRevision: preview.source.resultRevision, methodologyVersion: preview.methodology.version,
    title: 'Verificação com uma questão — QA', acceptedPriorities: [{ skillId: priority.skill.id,
      suggestedQuestionCount: 2, group: { title: priority.suggestedGroup.title,
        objective: priority.suggestedGroup.objective, studentIds: priority.suggestedGroup.students.map(s => s.id) } }] };
  const draft = (await api(assignmentPath + '/results/recovery-plans', 'POST', payload)).plan;
  const basePath = assignmentPath + '/results/recovery-plans/' + draft.id;
  await api(basePath + '/activate', 'POST', { ...payload, expectedPlanRevision: draft.revision, reviewConfirmed: true });
  await api(basePath + '/execution', 'POST', { startDate: '2026-09-12', cadenceDays: 2 });
  const plan = (await api(basePath)).plan;
  for (const lesson of plan.execution.lessons.filter(l => l.phase === 'intervention')) {
    const resourcePath = basePath + '/execution/lessons/' + lesson.id + '/resources';
    const options = await api(resourcePath + '/options');
    await api(resourcePath, 'PUT', { expectedExecutionRevision: options.executionRevision, questionIds: [], materialIds: [] });
    const current = (await api(basePath)).plan.execution.lessons.find(l => l.id === lesson.id);
    await api(basePath + '/execution/lessons/' + lesson.id, 'PUT', { expectedRevision: current.revision,
      plannedDate: current.plannedDate, durationMinutes: 50, status: 'taught',
      teacherNotes: 'Atividade própria registrada no cenário sintético, sem questões do banco.' });
  }
  if (process.env.RECOVERY_LANGUAGE_AUDIT === '1' || process.env.RECOVERY_PARTICIPANTS_AUDIT === '1') {
    const options = await api(basePath + '/execution/monitoring/options');
    assert.equal(options.ready, true, 'Language QA needs an eligible question after the support lessons');
    return { planId: draft.id, basePath, skill: priority.skill, syntheticDataOnly: true, initialState: 'available_questions' };
  }
  // Stage the empty-bank edge case. This temporary DB is deleted by the owning test.
  const changedQuestions = db.prepare("UPDATE questions SET status = 'inactive' WHERE skill_id = ?").run(priority.skill.id).changes;
  const options = await api(basePath + '/execution/monitoring/options');
  assert.equal(options.ready, false);
  assert.equal(options.questionCount, 0);
  return { planId: draft.id, basePath, skill: priority.skill, stagedInactiveQuestionCount: changedQuestions,
    syntheticDataOnly: true, initialState: 'no_questions' };
}

module.exports = { seedRecoveryQuestions };
