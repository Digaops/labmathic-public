const test = require('node:test'), assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import('../../client/src/services/eventDates.mjs');
test('eventos SQLite e ISO representam o mesmo instante, independentemente do fuso de exibição', async () => {
  const { parseEventInstant, eventDay, eventTime } = await load();
  for (const value of ['2026-09-12 01:48:33', '2026-09-12T01:48:33', '2026-09-12T01:48:33Z', '2026-09-11T22:48:33-03:00']) {
    assert.equal(parseEventInstant(value).toISOString(), '2026-09-12T01:48:33.000Z');
    assert.equal(eventDay(value, 'America/Sao_Paulo'), '11/09/2026');
    assert.match(eventTime(value, 'America/Sao_Paulo'), /11\/09\/2026.*22:48/);
    assert.equal(eventDay(value, 'UTC'), '12/09/2026');
  }
  assert.equal(eventDay('2026-12-31T23:30:00Z', 'Asia/Tokyo'), '01/01/2027');
  assert.equal(parseEventInstant('2026-09-12 01:48:33.125').getUTCMilliseconds(), 125);
});
test('datas inválidas não são normalizadas para outro dia e datas civis não mudam com o fuso', async () => {
  const { parseEventInstant, eventDay, eventTime, isCalendarDay } = await load();
  for (const value of [null, {}, 0, '', 'não é data', '2026-02-30', '2026-02-30 12:00:00', '2026-01-01 24:00:00', '2026-01-01T10:60:00Z', '2026-01-01T10:00:00+24:00', '2026-01-01T10:00:00+03:60']) {
    assert.equal(parseEventInstant(value), null); assert.equal(eventDay(value), ''); assert.equal(eventTime(value), 'Horário não informado');
  }
  assert.equal(isCalendarDay('2024-02-29'), true); assert.equal(isCalendarDay('2025-02-29'), false);
  for (const zone of ['America/Sao_Paulo', 'UTC', 'Pacific/Kiritimati', 'Pacific/Pago_Pago']) assert.equal(eventDay('2026-09-12', zone), '12/09/2026');
  assert.equal(parseEventInstant('2026-09-12'), null);
});
test('material, curadoria e auditoria usam o mesmo fuso real do navegador/processo sem alterar datas de aula', () => {
  const url = file => pathToFileURL(path.resolve(__dirname, '../../client/src/services', file)).href;
  const script = `const {materialDate}=await import(${JSON.stringify(url('materialView.mjs'))});
    const {activityTime}=await import(${JSON.stringify(url('adminActivityView.mjs'))});
    const {curationDate}=await import(${JSON.stringify(url('materialCurationView.mjs'))});
    const {plannerDate}=await import(${JSON.stringify(url('lessonPlannerView.mjs'))});
    console.log(JSON.stringify({material:materialDate('2026-09-12 01:48:33'),activity:activityTime('2026-09-12 01:48:33'),curation:curationDate('2026-09-12 01:48:33'),lesson:plannerDate('2026-09-12')}));`;
  for (const [TZ, day] of [['America/Sao_Paulo', '11/09/2026'], ['UTC', '12/09/2026'], ['Asia/Tokyo', '12/09/2026']]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', env: { ...process.env, TZ } });
    assert.equal(result.status, 0, result.stderr); const output = JSON.parse(result.stdout);
    assert.equal(output.material, day); assert.ok(output.activity.startsWith(day)); assert.equal(output.activity, output.curation); assert.equal(output.lesson, '12/09/2026');
  }
});
