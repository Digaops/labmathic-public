const test = require('node:test');
const assert = require('node:assert/strict');
const { summarizeFeedbackProgress } = require('../src/services/studentFeedbackProgress');
const client = import('../../client/src/services/assessmentView.mjs');

test('cálculo de progresso não inicializa banco ou servidor ao ser importado', () => {
  assert.ok(!Object.keys(require.cache).some(file => /[\\/]src[\\/]database\.js$/.test(file)));
});

function fixture() {
  return { assessment: { questionCount: 2, status: 'closed' },
    overview: { participantCount: 5, submittedCount: 2, pendingCount: 3, meanPercentage: 50 },
    participants: [
      { id: 'a', displayName: 'Ágata', participationStatus: 'submitted', attemptStatus: 'submitted', percentage: 0 },
      { id: 'b', displayName: 'José', participationStatus: 'submitted', attemptStatus: 'submitted', percentage: 100 },
      { id: 'c', displayName: 'Carla', participationStatus: 'assigned', attemptStatus: 'pending' },
      { id: 'd', displayName: 'Davi', participationStatus: 'assigned', attemptStatus: 'draft' },
      { id: 'e', displayName: 'Eva', participationStatus: 'exempted', attemptStatus: 'pending' },
      { id: 'f', displayName: 'Fábio', participationStatus: 'assigned', attemptStatus: 'voided' },
    ], hardestQuestions: [], skills: [], studentsNeedingFollowUp: [],
    thresholds: { followUpBelow: 60, consolidatedMin: 70, developingMin: 50 } };
}

test('orientações: zero acertos continua elegível; ausência, rascunho, dispensa e anulação não viram pendência', () => {
  const input = fixture(), before = structuredClone(input);
  const result = summarizeFeedbackProgress(input, new Set(['b', 'c', 'e', 'another-assessment']));
  assert.deepEqual(result.feedbackProgress, { eligibleCount: 2, releasedCount: 1, pendingCount: 1 });
  assert.deepEqual(result.participants.map(p => p.feedbackStatus), ['pending', 'released', 'unavailable', 'unavailable', 'unavailable', 'unavailable']);
  assert.deepEqual(input, before, 'não modifica análise original ou compartilhada com a coordenação');
  assert.deepEqual(result.overview, input.overview);
});

test('orientações: turma sem entrega e turma sem participantes têm contagens zero, não mensagens enviadas', () => {
  for (const participants of [[], fixture().participants.slice(2)]) {
    const result = summarizeFeedbackProgress({ participants }, new Set());
    assert.deepEqual(result.feedbackProgress, { eligibleCount: 0, pendingCount: 0, releasedCount: 0 });
  }
});

test('contrato aceita resultados antigos e valida contagens e estados novos antes de mostrar sucesso', async () => {
  const { parseResults } = await client;
  assert.ok(parseResults(fixture()));
  const valid = summarizeFeedbackProgress(fixture(), new Set(['b']));
  assert.equal(parseResults(valid), valid);
  const invalids = [null, {}, { eligibleCount: 2, releasedCount: 1, pendingCount: 0 },
    { eligibleCount: 2, releasedCount: '1', pendingCount: 1 },
    { eligibleCount: -1, releasedCount: 0, pendingCount: 0 }];
  for (const feedbackProgress of invalids) assert.throws(() => parseResults({ ...valid, feedbackProgress }));
  assert.throws(() => parseResults({ ...valid, assessment: { ...valid.assessment, status: 'open' } }));
  assert.throws(() => parseResults({ ...valid, participants: valid.participants.map(p => ({ ...p, feedbackStatus: 'read' })) }));
  assert.throws(() => parseResults({ ...valid, participants: valid.participants.map((p, i) => i === 0 ? { ...p, attemptStatus: 'draft' } : p) }));
  assert.throws(() => parseResults({ ...valid, participants: [...valid.participants, valid.participants[2]] }));
});

test('busca e filtro são combinados, mantêm ordem e não confundem indisponibilidade com sem orientação', async () => {
  const { filterResultParticipants: filter } = await client;
  const result = summarizeFeedbackProgress(fixture(), new Set(['b']));
  assert.deepEqual(filter(result, 'agata', 'pending', true).map(p => p.id), ['a']);
  assert.deepEqual(filter(result, 'jose', 'released', true).map(p => p.id), ['b']);
  assert.deepEqual(filter(result, 'jose', 'pending', true), []);
  assert.equal(filter(result, '', 'all', true).length, 6);
  assert.equal(filter(result, '', 'released', false).length, 6, 'flag desativada ignora filtro anterior');
  assert.equal(filter(fixture(), '', 'pending', true).length, 6, 'API antiga não oculta participantes');
  assert.equal(filter(result, '', 'unknown', true).length, 6);
});
