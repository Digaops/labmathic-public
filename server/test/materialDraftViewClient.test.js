const test = require('node:test'), assert = require('node:assert/strict');
test('recibos de rascunho e publicação exigem identidade, operação e destino corretos', async () => {
  const { draftReceipt } = await import('../../client/src/services/materialDraftView.mjs');
  const r = { operationKey: 'key', operation: 'create', draftId: 1, materialId: null, title: 'Aula', version: 'a'.repeat(64) };
  assert.equal(draftReceipt(r, 'key'), r);
  for (const patch of [{ operation: 'publish' }, { draftId: 0 }, { materialId: 1 }, { version: '' }, { title: '' }]) assert.throws(() => draftReceipt({ ...r, ...patch }, 'key'));
  const p = { ...r, operation: 'publish', materialId: 4 }; assert.equal(draftReceipt(p, 'key', '1', true), p); assert.throws(() => draftReceipt(p, 'key', '2', true));
});
test('lista de rascunhos não aceita totais incoerentes nem linhas duplicadas', async () => {
  const { draftList } = await import('../../client/src/services/materialDraftView.mjs'); const p = { drafts: [{ id: 1, title: 'Aula' }], page: 1, total: 1, totalPages: 1 };
  assert.equal(draftList(p), p); assert.throws(() => draftList({ ...p, total: 2 })); assert.throws(() => draftList({ ...p, drafts: [p.drafts[0], p.drafts[0]], total: 2 }));
});
