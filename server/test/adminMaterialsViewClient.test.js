const test = require('node:test'), assert = require('node:assert/strict');
const source = import('../../client/src/services/adminMaterialsView.mjs');
test('consulta administrativa usa busca explícita, página e apenas seus três filtros', async () => {
  const { adminMaterialsQuery, adminMaterialsParams, adminMaterialsPath } = await source;
  const query = adminMaterialsQuery(new URLSearchParams('search=frações&page=2&grade_id=3&material_type_id=x&my_grades=1'));
  assert.equal(query.page, 2); assert.equal(query.filters.grade_id, '3'); assert.equal(query.filters.material_type_id, '');
  assert.equal(adminMaterialsQuery(adminMaterialsParams(query)).search, 'frações'); assert.match(adminMaterialsPath(query), /limit=20/); assert.doesNotMatch(adminMaterialsPath(query), /my_grades/);
});
test('página administrativa recusa identidades duplicadas e metadados malformados', async () => {
  const { adminMaterialsPage } = await source; const row = { id: 1, title: 'Material' }, pagination = { page: 1, limit: 20, total: 1, totalPages: 1 };
  assert.equal(adminMaterialsPage({ data: [row], pagination }).data.length, 1);
  for (const data of [{}, { data: [row, row], pagination: { ...pagination, total: 2 } }, { data: [{ ...row, grade_name: {} }], pagination }, { data: [row], pagination: { ...pagination, limit: 12 } }]) assert.throws(() => adminMaterialsPage(data));
});
test('conferência preserva ordem e distingue ausente de consulta falha', async () => {
  const { deletionSelection } = await source;
  const result = deletionSelection({ materials: [{ id: 2, title: 'B', version: 'b'.repeat(64) }, { id: 1, title: 'A', version: 'a'.repeat(64) }], missingIds: [3] }, [1, 3, 2]);
  assert.deepEqual(result.materials.map(m => m.id), [1, 2]); assert.deepEqual(result.missingIds, [3]);
  assert.throws(() => deletionSelection({}, [1]));
});
test('conferência recusa alvo substituído, duplicado, omitido ou versão inválida', async () => {
  const { deletionSelection } = await source; const row = { id: 1, title: 'A', version: 'a'.repeat(64) };
  for (const data of [{ materials: [], missingIds: [] }, { materials: [row], missingIds: [1] }, { materials: [{ ...row, id: 2 }], missingIds: [] }, { materials: [{ ...row, version: '' }], missingIds: [] }]) assert.throws(() => deletionSelection(data, [1]));
});
