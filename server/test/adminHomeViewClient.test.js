const test = require('node:test'), assert = require('node:assert/strict');
const source = import('../../client/src/services/adminHomeView.mjs');

test('início administrativo preserva envelopes e limites de cada lista', async () => {
  const { adminHistory, adminFavorites, adminRecentMaterials, adminRecentSets } = await source;
  const material = { id: 4, title: 'Estratégias', discipline_name: 'Matemática' };
  assert.equal(adminHistory([material])[0].path, '/material/4');
  assert.equal(adminFavorites({ data: [material] })[0].discipline, 'Matemática');
  assert.equal(adminRecentMaterials({ data: [material] })[0].questionCount, null);
  assert.equal(adminRecentSets({ data: [{ ...material, question_count: 0 }] })[0].path, '/simulados/4');
  for (const parse of [adminHistory, adminFavorites, adminRecentMaterials, adminRecentSets]) assert.throws(() => parse({}));
});
test('listas pessoais vazias são aceitas somente com contrato explícito', async () => {
  const { adminHistory, adminFavorites } = await source;
  assert.deepEqual(adminHistory([]), []); assert.deepEqual(adminFavorites({ data: [] }), []);
  for (const data of [null, {}, { data: null }, { data: 'nenhum' }]) assert.throws(() => adminFavorites(data));
});
test('títulos e identidades malformados não geram links no início administrativo', async () => {
  const { adminHistory, adminRecentSets } = await source;
  const row = { id: 1, title: 'Material' };
  for (const data of [[row, row], [{ ...row, id: '1/../admin' }], [{ ...row, id: 0 }], [{ ...row, title: ' ' }], [{ ...row, discipline_name: {} }]]) assert.throws(() => adminHistory(data));
  assert.throws(() => adminRecentSets({ data: [{ ...row, question_count: -1 }] }));
  assert.throws(() => adminRecentSets({ data: [row] }));
  assert.equal(adminHistory([{ ...row, path: '//example.org' }])[0].path, '/material/1');
});
test('listas maiores que o recorte anunciado são recusadas', async () => {
  const { adminHistory, adminFavorites, adminRecentMaterials, adminRecentSets } = await source;
  const items = Array.from({ length: 7 }, (_, i) => ({ id: i + 1, title: 'Material ' + i, question_count: 1 }));
  assert.throws(() => adminHistory(items.slice(0, 5)));
  assert.throws(() => adminFavorites({ data: items.slice(0, 4) }));
  assert.throws(() => adminRecentSets({ data: items.slice(0, 4) }));
  assert.throws(() => adminRecentMaterials({ data: items }));
});
test('totais exigem escopo global e não transformam valores inválidos em zero', async () => {
  const { adminHomeStats } = await source;
  const data = { scope: 'global', totalMaterials: 0, totalQuestions: 2, totalQuestionSets: 0, totalCoveredSkills: 1 };
  assert.deepEqual(adminHomeStats(data), { totalMaterials: 0, totalQuestions: 2, totalQuestionSets: 0, totalCoveredSkills: 1 });
  for (const invalid of [{}, { ...data, scope: 'user' }, { ...data, totalMaterials: '0' }, { ...data, totalCoveredSkills: 3 }, { ...data, totalQuestionSets: -1 }]) assert.throws(() => adminHomeStats(invalid));
});
test('resumo da rede não aceita outro perfil nem campos ausentes como zeros', async () => {
  const { adminNetworkSummary } = await source;
  const data = { mode: 'admin', readOnly: true, summary: { activeMunicipalities: 1, activeSchools: 2, verifiedClasses: 3, pendingClasses: 0 } };
  assert.deepEqual(adminNetworkSummary(data), data.summary);
  for (const invalid of [{}, { ...data, mode: 'manager' }, { ...data, readOnly: false }, { ...data, summary: {} }, { ...data, summary: { ...data.summary, pendingClasses: '0' } }]) assert.throws(() => adminNetworkSummary(invalid));
});
