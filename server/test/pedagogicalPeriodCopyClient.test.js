const test = require('node:test');
const assert = require('node:assert/strict');
const view = import('../../client/src/services/pedagogicalPeriodView.mjs');
const download = import('../../client/src/services/reportCsvDownload.mjs');
const { formatPeriodCsv } = require('../src/services/pedagogicalPeriodCopy');
const query = { start: '2026-09-01', end: '2026-09-30' };
function fixture(size = 12) {
  return { version: 'class-period-copy-v1', class: { id: 'class', name: '7º A', gradeName: '7º Ano', academicYear: 2026, status: 'active', institution: { status: 'pending' } },
    period: { ...query, timeZone: 'America/Sao_Paulo' }, total: size, limit: 200, revision: 'a'.repeat(64), generatedAt: '2026-09-19T12:00:00Z',
    notice: 'Não somamos participantes nem calculamos média geral.', privacyNotice: 'Confira antes de compartilhar.',
    assessments: Array.from({ length: size }, (_, index) => ({ id: `assessment-${index}`, title: `Avaliação ${index}`, status: 'closed',
      openedAt: '2026-09-01T03:00:00.000Z', questionCount: 2,
      overview: { participantCount: 3, submittedCount: 2, pendingCount: 1, exemptedCount: 1, meanPercentage: 0 } })) };
}
test('period copy accepts all pages, linked and unavailable context, null and zero means', async () => {
  const { parsePedagogicalPeriodCopy: parse } = await view;
  for (const size of [1, 10, 12, 200]) assert.equal(parse(fixture(size), 'class', query).total, size);
  for (const status of ['linked', 'unavailable']) {
    const data = fixture(); data.class.institution.status = status;
    data.assessments[0].overview = { participantCount: 3, submittedCount: 0, pendingCount: 3, exemptedCount: 0, meanPercentage: null };
    assert.doesNotThrow(() => parse(data, 'class', query));
  }
});
test('period copy rejects cross-page duplicates, truncation, wrong context and inconsistent denominators', async () => {
  const { parsePedagogicalPeriodCopy: parse } = await view;
  for (const mutate of [d => d.class.id = 'other', d => d.total = 10, d => d.limit = 500, d => d.assessments.pop(),
    d => d.assessments[10].id = d.assessments[0].id, d => d.assessments[0].openedAt = '2026-09-01T02:59:59Z',
    d => d.assessments[0].questionCount = 0, d => d.assessments[0].overview.exemptedCount = -1,
    d => d.assessments[0].overview.submittedCount = 4, d => d.assessments[0].overview.meanPercentage = null,
    d => d.assessments[0].overview.meanPercentage = 101, d => d.class.name = '', d => d.revision = 'invalid',
    d => d.period.end = '2026-10-01', d => d.generatedAt = 'bad', d => d.class.institution.school = {}, d => d.notice = '']) {
    const data = fixture(); mutate(data); assert.throws(() => parse(data, 'class', query));
  }
  assert.throws(() => parse(fixture(201), 'class', query));
  assert.throws(() => parse(fixture(0), 'class', query));
});
test('period CSV has one rectangular row per assessment, no totals and safe text', () => {
  const data = fixture(2);
  data.class.name = ' =HYPERLINK("invalid","turma")';
  data.assessments[0].title = '+SUM(1,2)'; data.assessments[0].status = 'open';
  data.assessments[1].overview = { participantCount: 3, submittedCount: 0, pendingCount: 3, exemptedCount: 1, meanPercentage: null };
  const csv = formatPeriodCsv(data);
  assert.equal(csv.charCodeAt(0), 0xfeff);
  assert.equal(csv.split('\r\n').length, 3);
  assert.ok(csv.includes('"\' =HYPERLINK(""invalid"",""turma"")"'));
  assert.ok(csv.includes('"\'+SUM(1,2)"'));
  assert.match(csv, /Aberta — resultado parcial/);
  assert.match(csv, /"3","1","2","1","0"/);
  assert.match(csv, /"3","1","0","3","Sem correções concluídas"/);
  assert.match(csv, /01\/09\/2026, 00:00:00/);
  assert.match(csv, /Pendentes não são nota zero/);
  assert.doesNotMatch(csv, /Total de estudantes|Média geral,/);
});
function environment({ failAt } = {}) {
  const events = [], timers = new Map(); let sequence = 0;
  return { events, timers, options: { document: {
    body: { appendChild() { if (failAt === 'append') throw Error('append'); events.push('append'); } },
    createElement() { return { click() { if (failAt === 'click') throw Error('click'); events.push('click'); }, remove() { events.push('remove'); } }; },
  }, urlApi: { createObjectURL() { const id = `blob:${++sequence}`; events.push(id); return id; }, revokeObjectURL(url) { events.push(`revoke:${url}`); } },
  setTimer(fn) { timers.set(sequence, fn); return sequence; }, clearTimer(id) { timers.delete(id); } } };
}
const response = () => ({ status: 200, data: new Blob(['csv']), headers: { 'content-type': 'text/csv; charset=utf-8', 'x-report-revision': 'a'.repeat(64) } });
test('CSV download rejects wrong status, type, revision and empty body before any URL exists', async () => {
  const { createReportCsvDownload } = await download;
  const env = environment(), saver = createReportCsvDownload(env.options);
  for (const mutate of [r => r.status = 500, r => r.headers['content-type'] = 'text/html',
    r => r.headers['x-report-revision'] = 'b'.repeat(64), r => r.data = new Blob([]), r => r.data = 'not a blob']) {
    const r = response(); mutate(r); assert.throws(() => saver.save(r, 'a'.repeat(64), 'report.csv'));
  }
  assert.deepEqual(env.events, []);
});
test('CSV URLs are released after timeout or disposal, once only, with no late download', async () => {
  const { createReportCsvDownload } = await download;
  const env = environment(), saver = createReportCsvDownload(env.options);
  saver.save(response(), 'a'.repeat(64), 'report.csv');
  assert.deepEqual(env.events, ['blob:1', 'append', 'click', 'remove']);
  env.timers.get(1)(); assert.equal(env.timers.size, 0);
  saver.save(response(), 'a'.repeat(64), 'report.csv');
  saver.dispose(); saver.dispose();
  assert.deepEqual(env.events.filter(e => e.startsWith('revoke')), ['revoke:blob:1', 'revoke:blob:2']);
  assert.equal(env.timers.size, 0);
  assert.throws(() => saver.save(response(), 'a'.repeat(64), 'report.csv'));
});
test('CSV link failures clean up URLs and elements', async () => {
  const { createReportCsvDownload } = await download;
  for (const failAt of ['click', 'append']) {
    const env = environment({ failAt }), saver = createReportCsvDownload(env.options);
    assert.throws(() => saver.save(response(), 'a'.repeat(64), 'report.csv'));
    assert.equal(env.timers.size, 0); assert.ok(env.events.includes('remove')); assert.ok(env.events.includes('revoke:blob:1'));
  }
});
