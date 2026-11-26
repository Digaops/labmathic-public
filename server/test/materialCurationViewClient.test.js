const test = require('node:test'), assert = require('node:assert/strict');
const load = () => import('../../client/src/services/materialCurationView.mjs');
const skill = { id: 1, code: 'QA01', description: 'Descrição sintética.', gradeName: '7º ano', version: 'a'.repeat(64), status: 'confirmed', reason: 'Justificativa da associação.', location: 'Página 1', coverage: 1, pending: 0 };
test('histórico converte o instante UTC ao fuso escolhido, inclusive na virada do dia', async () => {
  const { curationDate } = await load();
  assert.match(curationDate('2026-09-13 01:30:00', 'America/Sao_Paulo'), /12\/09\/2026.*22:30/);
  assert.match(curationDate('2026-09-13 01:30:00', 'UTC'), /13\/09\/2026.*01:30/);
  assert.equal(curationDate(null), 'Horário não informado');
});
test('contratos de curadoria recusam resposta truncada, status inventado e falso recibo', async () => {
  const view = await load(), snapshot = { material: { id: 1, title: 'QA' }, version: 'b'.repeat(64), associations: [skill] };
  assert.equal(view.curationSnapshot(snapshot, 1), snapshot);
  for (const value of [{ ...snapshot, associations: [skill, skill] }, { ...snapshot, associations: [{ ...skill, status: 'approved_by_mec' }] }, { ...snapshot, associations: [{ ...skill, location: null }] }, { ...snapshot, version: null }]) assert.throws(() => view.curationSnapshot(value, 1));
  const receipt = { operationKey: 'key', materialId: 1, skillId: 1, reviewId: 1, decision: 'confirm', version: 'a'.repeat(64) };
  assert.equal(view.curationReceipt(receipt, 'key', 1), receipt);
  for (const extra of [{ materialId: 2 }, { reviewId: null }, { decision: 'delete' }, { operationKey: 'other' }]) assert.throws(() => view.curationReceipt({ ...receipt, ...extra }, 'key', 1));
});
test('busca e histórico validam paginação e admitem legado sem inventar justificativa', async () => {
  const view = await load(), search = { skills: [skill], page: 1, total: 1, totalPages: 1 };
  assert.equal(view.curationSearch(search), search); assert.throws(() => view.curationSearch({ ...search, total: 21 }));
  assert.throws(() => view.curationSearch({ ...search, skills: [{ ...skill, pending: -1 }] }));
  assert.ok(view.publicAssociations({ associations: [{ ...skill, status: 'legacy', reason: null, location: null }] }));
  const history = { events: [{ id: 2, skill, decision: 'confirm', reason: 'Revisão sintética.', reviewer: 'QA' }], nextBefore: null };
  assert.equal(view.curationHistory(history), history); assert.throws(() => view.curationHistory({ ...history, nextBefore: 3 }));
});
