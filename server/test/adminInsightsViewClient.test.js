const test = require('node:test'), assert = require('node:assert/strict');
const reports = import('../../client/src/services/adminReportsView.mjs'), history = import('../../client/src/services/adminActivityView.mjs');
test('relatórios: valida números, identidades e datas sem transformar falha em zero', async () => {
  const m = await reports, data = Object.fromEntries(m.overviewFields.map(k => [k, 0])); data.avgRating = 0;
  assert.equal(m.reportOverview(data).totalMaterials, 0); assert.throws(() => m.reportOverview({ ...data, totalUsers: undefined })); assert.throws(() => m.reportOverview({ ...data, totalUsers: -1 })); assert.throws(() => m.reportOverview({ ...data, avgRating: 6 }));
  assert.equal(m.reportView('invalid'), 'overview'); assert.throws(() => m.reportMaterials([{ id: 1, title: 'A', access_count: '1', avg_rating: 0 }]));
  for (const rows of [[{ date: '2026-02-30', count: 0 }], [{ date: '2026-09-11', count: 1 }, { date: '2026-09-11', count: 1 }]]) assert.throws(() => m.reportTimeline(rows));
  assert.equal(m.reportTimeline([{ date: '2026-09-11', count: 0 }]).length, 1);
});
test('relatórios: totais do banco e autores são conferidos', async () => {
  const m = await reports, totals = Object.fromEntries(m.bankGroups.flatMap(([, fields]) => fields.map(([key]) => [key, 0])));
  assert.deepEqual(m.reportBank({ totals, authorEngagement: [] }), { totals, authorEngagement: [] }); assert.throws(() => m.reportBank({ totals: {}, authorEngagement: [] })); assert.throws(() => m.reportPeople([{ id: 1, name: 'A', email: 'a' }]));
});
test('histórico: datas explícitas, período e critérios só da consulta aplicada', async () => {
  const m = await history, base = m.emptyActivityFilters();
  assert.equal(m.activityFilterIssue({ ...base, period: 'custom' })[0], 'date_from'); assert.equal(m.activityFilterIssue({ ...base, period: 'custom', date_from: '2026-09-12', date_to: '2026-09-11' })[0], 'date_to');
  const p = new URLSearchParams(m.activityParams({ ...base, period: 'custom', date_from: '2026-09-11', date_to: '2026-09-11', search: ' Ana ', critical_only: true }));
  assert.equal(p.get('search'), 'Ana'); assert.equal(p.get('critical_only'), '1'); assert.equal((Date.parse(p.get('date_before')) - Date.parse(p.get('date_from'))) / 3600000, 24);
  assert.equal(new URLSearchParams(m.activityParams({ ...base, period: 'all' })).has('date_from'), false);
});
test('histórico: rejeita páginas trocadas, snapshots e registros inválidos', async () => {
  const m = await history, data = { snapshot_id: 10, pagination: { page: 1, limit: 20, total: 1, totalPages: 1 }, data: [{ id: 10, action: 'login', metadata: {}, created_at: '2026-09-11 12:00:00' }] };
  assert.equal(m.activityList(data, 1, null).data.length, 1); assert.throws(() => m.activityList(data, 2, null)); assert.throws(() => m.activityList(data, 1, 9)); assert.throws(() => m.activityList({ ...data, data: [data.data[0], data.data[0]] }, 1, null)); assert.throws(() => m.activityList({ ...data, data: [{ ...data.data[0], description: {} }] }, 1, null));
  assert.equal(m.activityTime('invalid'), 'Horário não informado'); assert.equal(m.activityTime('2026-09-11 12:00:00'), m.activityTime('2026-09-11T12:00:00Z'));
});
