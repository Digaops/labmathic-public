const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../client/src/services/assessmentPreparation.mjs');
const assignment = { id: 'application', sourceQuestionSetId: 7, title: 'Salva', revision: 1, questionCount: 1, participantCount: 2, status: 'draft' };

test('preparação exige origem exata, contagens válidas e relação explícita com a aplicação', async () => {
  const { parseAssessmentPreparation } = await load();
  const valid = { source: { id: 7, title: 'Verificação', questionCount: 1 }, recovery: { participantIds: ['a', 'b'], unavailableCount: 0 }, existingAssignment: null };
  assert.equal(parseAssessmentPreparation(valid, '7'), valid);
  assert.ok(parseAssessmentPreparation({ ...valid, existingAssignment: assignment }, 7));
  for (const value of [null, {}, { ...valid, recovery: undefined }, { ...valid, recovery: { participantIds: ['a', 'a'], unavailableCount: 0 } },
    { ...valid, source: { ...valid.source, questionCount: 0 } }, { ...valid, existingAssignment: {} },
    { ...valid, existingAssignment: { ...assignment, sourceQuestionSetId: 8 } }, { ...valid, recovery: null, existingAssignment: assignment }]) {
    assert.throws(() => parseAssessmentPreparation(value, 7));
  }
  assert.throws(() => parseAssessmentPreparation(valid, 8));
  assert.ok(parseAssessmentPreparation({ ...valid, recovery: null }, 7));
});

test('seleção de apoio cruza a matrícula atual, remove repetidos e não modifica o grupo', async () => {
  const { supportParticipants } = await load();
  const recovery = Object.freeze({ participantIds: Object.freeze(['a', 'a', 'b', 'removed']), unavailableCount: 1 });
  assert.deepEqual(supportParticipants(recovery, [{ id: 'a' }, { id: 'b' }, { id: 'c' }]), ['a', 'b']);
  assert.deepEqual(supportParticipants(recovery, []), []);
  assert.deepEqual(supportParticipants(null, [{ id: 'c' }]), []);
  assert.equal(recovery.participantIds.length, 4);
});

test('reconciliação reconhece só a verificação vinculada, sem interferir na edição ou em simulados comuns', async () => {
  const { existingVerification } = await load();
  for (const status of ['draft', 'scheduled', 'open', 'closed', 'cancelled']) {
    const saved = { ...assignment, status };
    assert.equal(existingVerification([saved], { mode: 'create', source: { id: 7 }, recovery: {} }, '7'), saved);
  }
  for (const wizard of [null, { mode: 'edit', recovery: {} }, { mode: 'create', recovery: null }]) assert.equal(existingVerification([assignment], wizard, 7), null);
  assert.equal(existingVerification([assignment], { mode: 'create', source: { id: 7 }, recovery: {} }, 8), null);
});

test('consumo do atalho preserva turma, aba e filtros de navegação', async () => {
  const { classNavigation } = await import('../../client/src/services/classesView.mjs');
  const original = new URLSearchParams('turma=classe&secao=avaliacoes&simulado=7&busca=A&situacao=archived');
  const cleaned = classNavigation(original, { simulado: null });
  assert.equal(cleaned.get('simulado'), null);
  for (const key of ['turma', 'secao', 'busca', 'situacao']) assert.equal(cleaned.get(key), original.get(key));
  assert.equal(original.get('simulado'), '7');
});
