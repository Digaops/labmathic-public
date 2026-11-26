const test = require('node:test'), assert = require('node:assert/strict');
const source = import('../../client/src/services/adminDashboardView.mjs');
test('painel administrativo exige contagem explícita de mensagens não lidas', async () => {
  const { adminAttention } = await source;
  assert.deepEqual(adminAttention({ unreadSupportMessages: 0 }), { unread: 0 });
  for (const data of [{}, null, { unreadSupportMessages: '3' }, { unreadSupportMessages: -1 }]) assert.throws(() => adminAttention(data));
});
test('distribuição distingue tipos cadastrados de tipos usados e materiais sem tipo', async () => {
  const { adminMaterialStats } = await source;
  const data = adminMaterialStats({ total: 8, thisMonth: 2, byType: [{ name: 'PDF', count: 5 }, { name: 'Vídeo', count: 0 }] });
  assert.equal(data.usedTypes, 1); assert.equal(data.unassigned, 3); assert.equal(data.total, 8);
  assert.equal(adminMaterialStats({ total: 0, thisMonth: 0, byType: [{ name: 'PDF', count: 0 }] }).usedTypes, 0);
});
test('números ausentes, duplicados e distribuição impossível não viram zeros', async () => {
  const { adminMaterialStats } = await source;
  for (const data of [{}, { total: 0, thisMonth: 1, byType: [] }, { total: 1, thisMonth: 0, byType: [{ name: 'PDF', count: 2 }] }, { total: 3, thisMonth: 0, byType: [{ name: 'PDF', count: 1 }, { name: 'PDF', count: 1 }] }, { total: 1, thisMonth: 0, byType: [{ name: 'PDF', count: -1 }] }]) assert.throws(() => adminMaterialStats(data));
});
test('conteúdos sem acesso não recebem posição no resumo dos mais consultados', async () => {
  const { adminTopContent } = await source;
  const row = { id: 1, title: 'Material', category: null, content_type: 'material', access_count: 0, path: '/material/1' };
  assert.deepEqual(adminTopContent([row]), []);
  const items = adminTopContent([{ ...row, access_count: 2 }, { ...row, content_type: 'question_set', path: '/simulados/1', access_count: 1 }]);
  assert.deepEqual(items.map(i => i.key), ['material-1', 'question_set-1']);
});
test('destino, identidade, limite e conteúdo inválidos são recusados no painel', async () => {
  const { adminTopContent } = await source;
  const row = { id: 1, title: 'Material', content_type: 'material', access_count: 2, path: '/material/1' };
  for (const data of [null, {}, [row, row], Array(6).fill(row), [{ ...row, path: '//example.org' }], [{ ...row, id: '1/../admin' }], [{ ...row, path: '/material/2' }], [{ ...row, title: null }], [{ ...row, access_count: -1 }]]) assert.throws(() => adminTopContent(data));
});
