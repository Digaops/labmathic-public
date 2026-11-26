const test = require('node:test');
const assert = require('node:assert/strict');
const { periodBounds } = require('../src/services/pedagogicalPeriod');
test('period uses inclusive Brasília calendar days, not UTC days', () => {
  const period = periodBounds('2026-09-01', '2026-09-15');
  assert.equal(period.from, '2026-09-01T03:00:00.000Z');
  assert.equal(period.until, '2026-09-16T03:00:00.000Z');
});
test('period resolves historical midnight daylight-saving transition', () => {
  const period = periodBounds('2018-11-04', '2018-11-04');
  assert.equal(period.from, '2018-11-04T03:00:00.000Z');
  assert.equal(period.until, '2018-11-05T02:00:00.000Z');
});
test('period rejects malformed, impossible, reversed and oversized intervals', () => {
  for (const [start, end] of [[undefined, undefined], ['2026-02-30', '2026-03-01'], ['2026-09-02', '2026-09-01'], ['2024-01-01', '2025-01-01'], [[], '2026-01-01']])
    assert.throws(() => periodBounds(start, end));
  assert.doesNotThrow(() => periodBounds('2024-01-01', '2024-12-31'));
});
