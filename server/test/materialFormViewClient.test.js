const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/materialFormView.mjs');
const snapshot = { material: { id: 2, title: 'Ciências', discipline_id: 8, grade_id: 7, material_type_id: 6, description: 'Descrição', file_path: 'old.txt', file_size: 10, file_format: 'TXT', external_url: 'https://example.invalid', duration: '12 minutos', page_count: 0 }, topics: [{ id: 1, name: 'Assunto' }], collections: [{ id: 4, name: 'Laboratório' }], otherCollectionCount: 1, version: 'a'.repeat(64) };
test('snapshot exige identidade, versão e relações completas', async () => {
  const { materialSnapshot } = await view; assert.equal(materialSnapshot(snapshot, 2), snapshot);
  for (const bad of [{}, { ...snapshot, topics: undefined }, { ...snapshot, version: '' }, { ...snapshot, otherCollectionCount: -1 }, { ...snapshot, material: { ...snapshot.material, id: 3 } }]) assert.throws(() => materialSnapshot(bad, 2));
});
test('rascunho preserva disciplina, zero páginas e assuntos; laboratório nunca é substituído', async () => {
  const { materialDraft, materialPayload } = await view; const draft = materialDraft(snapshot); assert.equal(draft.discipline_id, '8'); assert.equal(draft.page_count, '0'); assert.deepEqual(draft.topicIds, [1]); assert.deepEqual(draft.addCollectionIds, []);
  const p = materialPayload({ ...draft, discipline_id: '', external_url: '', topicIds: [] }, snapshot); assert.equal(p.discipline_id, null); assert.equal(p.external_url, ''); assert.equal(p.page_count, 0); assert.equal(p.expectedVersion, snapshot.version); assert.equal(p.collection_id, undefined);
  assert.equal(materialDraft(null).discipline_id, '');
});
test('validação explica título, link, páginas e consentimento de arquivo', async () => {
  const { materialDraft, materialFormError } = await view; const d = materialDraft(snapshot); assert.equal(materialFormError(d, null, snapshot), null);
  for (const [patch, name] of [[{ title: '' }, 'title'], [{ external_url: 'javascript:alert(1)' }, 'external_url'], [{ page_count: '-1' }, 'page_count'], [{ page_count: '1.5' }, 'page_count']]) assert.equal(materialFormError({ ...d, ...patch }, null, snapshot)[0], name);
  assert.equal(materialFormError(d, {}, snapshot)[0], 'replaceFile'); assert.equal(materialFormError({ ...d, replaceFile: true }, {}, snapshot), null);
});
test('recibo e catálogos rejeitam identidade trocada, código diferente e duplicação', async () => {
  const { materialReceipt, materialOptions } = await view; const receipt = { operationKey: 'key', operation: 'update', materialId: 2, title: 'Título', version: 'b'.repeat(64) };
  assert.equal(materialReceipt(receipt, 'key', 2), receipt); assert.throws(() => materialReceipt(receipt, 'other', 2)); assert.throws(() => materialReceipt(receipt, 'key', 3)); assert.throws(() => materialReceipt(receipt, 'key', null));
  assert.throws(() => materialOptions({})); assert.throws(() => materialOptions([{ id: 1, name: 'A' }, { id: 1, name: 'B' }])); assert.deepEqual(materialOptions([]), []);
});
