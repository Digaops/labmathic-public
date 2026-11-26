const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../../client/src/services/pedagogicalPeriodView.mjs');
const query = { start: '2026-09-01', end: '2026-09-30', page: 1 };
function fixture() {
  return { version: 'class-period-v1', classId: 'class', period: { ...query, timeZone: 'America/Sao_Paulo' }, generatedAt: '2026-09-15T15:00:00Z',
    pagination: { page: 1, limit: 10, total: 1, totalPages: 1 }, assessments: [{ id: 'assessment', title: 'Frações', status: 'closed', openedAt: '2026-09-01T15:00:00Z',
      overview: { participantCount: 2, submittedCount: 1, pendingCount: 1, meanPercentage: 0 } }] };
}
test('period contract distinguishes real zero, missing corrections and empty period', async () => {
  const { parsePedagogicalPeriod: parse } = await model;
  const data = fixture(); assert.equal(parse(data, 'class', query), data);
  data.assessments[0].overview = { participantCount: 2, submittedCount: 0, pendingCount: 2, meanPercentage: null };
  assert.doesNotThrow(() => parse(data, 'class', query));
  data.assessments = []; data.pagination = { page: 1, limit: 10, total: 0, totalPages: 0 };
  assert.doesNotThrow(() => parse(data, 'class', query));
});
test('period contract rejects wrong context, impossible pagination and contradictory counts', async () => {
  const { parsePedagogicalPeriod: parse } = await model;
  for (const mutate of [d => d.classId = 'other', d => d.period.end = '2026-10-01', d => d.period.timeZone = 'UTC', d => d.pagination.page = 0,
    d => d.pagination.total = 2, d => d.pagination.totalPages = 2, d => d.assessments[0].overview.meanPercentage = null,
    d => d.assessments[0].overview.pendingCount = 5, d => d.assessments[0].status = 'draft', d => d.generatedAt = 'invalid']) {
    const data = fixture(); mutate(data); assert.throws(() => parse(data, 'class', query));
  }
});
test('period validation explains missing dates, impossible dates and excessive range', async () => {
  const { periodInputError } = await model;
  assert.equal(periodInputError('2024-01-01', '2024-12-31'), '');
  for (const dates of [['', ''], ['2026-02-30', '2026-03-01'], ['2026-09-02', '2026-09-01'], ['2024-01-01', '2025-01-01']]) assert.ok(periodInputError(...dates));
});
