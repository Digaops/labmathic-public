const test = require('node:test');
const assert = require('node:assert/strict');
const service = import('../../client/src/services/assessmentView.mjs');
test('aplicações: vazio verdadeiro e respostas inválidas são distintos', async () => {
  const { parseAssignments, parseAssessmentBootstrap } = await service;
  assert.deepEqual(parseAssignments([]), []);
  for (const value of [null, {}, [{ id: 'x' }]]) assert.throws(() => parseAssignments(value));
  assert.throws(() => parseAssessmentBootstrap({ sources: [] }));
  assert.deepEqual(parseAssessmentBootstrap({ sources: [], participants: [] }), { sources: [], participants: [] });
});
test('resultados: contrato valida antes de apresentar indicadores e listas', async () => {
  const { parseResults } = await service;
  const result = { assessment: { questionCount: 2 }, overview: { participantCount: 0, submittedCount: 0, pendingCount: 0, meanPercentage: null }, participants: [], hardestQuestions: [], skills: [], studentsNeedingFollowUp: [], thresholds: { followUpBelow: 60, consolidatedMin: 70, developingMin: 50 } };
  assert.equal(parseResults(result), result);
  assert.throws(() => parseResults({ ...result, skills: null }));
  assert.throws(() => parseResults({ ...result, overview: { ...result.overview, meanPercentage: 120 } }));
});
test('correção: distingue rascunho alterado, salvo, em branco e correção imutável', async () => {
  const { parseCorrection, correctionSelections, hasUnsavedResponses } = await service;
  const entry = { assessment: { title: 'A', questionCount: 1 }, participant: { id: 's', displayName: 'José' }, attempt: null, items: [{ id: 1, statement: 'Q', selectedOptionId: null, options: [{ id: 2, text: 'A' }] }] };
  assert.equal(parseCorrection(entry), entry);
  assert.deepEqual(correctionSelections(entry), { 1: null });
  assert.equal(hasUnsavedResponses(entry, { 1: 2 }), true);
  assert.equal(hasUnsavedResponses(entry, { 1: null }), false);
  const saved = { ...entry, items: [{ ...entry.items[0], selectedOptionId: 2 }], attempt: { status: 'draft', revision: 1 } };
  assert.equal(hasUnsavedResponses(saved, { 1: 2 }), false);
  assert.equal(hasUnsavedResponses(saved, { 1: null }), true);
  assert.equal(hasUnsavedResponses({ ...saved, attempt: { status: 'submitted', revision: 2 } }, { 1: null }), false);
  assert.throws(() => parseCorrection({ ...entry, items: [{}] }));
});
test('buscas de aplicação/estudante ignoram caixa e acentos', async () => {
  const { matchesAssessmentText } = await service;
  assert.equal(matchesAssessmentText('José · Diagnóstico', 'diagnostico'), true);
  assert.equal(matchesAssessmentText('José', 'maria'), false);
});
