const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../client/src/services/studentFeedbackView.mjs');
const feedback = { message: 'Compare as frações usando desenhos do mesmo tamanho.', releasedAt: '2026-09-17T12:00:00Z' };
const operation = { key: 'synthetic-feedback-operation', body: { message: feedback.message, confirmed: true, expectedRevision: 2 } };

test('envio perdido é reconciliado pela orientação realmente salva', async () => {
  const { sendStudentFeedback } = await load();
  const api = { post: async () => { throw Error('connection lost'); }, get: async () => ({ data: { feedback } }) };
  assert.deepEqual(await sendStudentFeedback(api, '/participant', operation), feedback);
});
test('nova tentativa conserva chave e corpo após indisponibilidade total', async () => {
  const { sendStudentFeedback } = await load();
  const calls = [];
  const api = { post: async (path, body, config) => { calls.push({ path, body, config }); if (calls.length === 1) throw Error('offline'); return { data: { feedback } }; }, get: async () => { throw Error('offline'); } };
  await assert.rejects(sendStudentFeedback(api, '/participant', operation), /offline/);
  assert.deepEqual(await sendStudentFeedback(api, '/participant', operation), feedback);
  assert.deepEqual(calls[0], calls[1]);
});
test('sucesso malformado não é anunciado e devolutiva salva em outra aba prevalece', async () => {
  const { sendStudentFeedback } = await load();
  const existing = { ...feedback, message: 'Outro texto já revisado e enviado em outra aba.' };
  assert.deepEqual(await sendStudentFeedback({ post: async () => ({ data: {} }), get: async () => ({ data: { feedback: existing } }) }, '/participant', operation), existing);
  await assert.rejects(sendStudentFeedback({ post: async () => ({ data: {} }), get: async () => ({ data: { feedback: null } }) }, '/participant', operation), /não confirmada/);
});
test('contrato rejeita orientação inválida antes de renderizar resultados', async () => {
  const { parseStudentFeedback } = await load();
  for (const value of [null, {}, { ...feedback, message: {} }, { ...feedback, message: 'x'.repeat(2001) }, { ...feedback, releasedAt: null }]) assert.throws(() => parseStudentFeedback(value));
  const { parseCorrection } = await import('../../client/src/services/assessmentView.mjs');
  assert.throws(() => parseCorrection({ participant: { id: 'a', displayName: 'Ana' }, assessment: { title: 'Teste', questionCount: 0 }, items: [], feedback: { ...feedback, message: {} } }));
});
