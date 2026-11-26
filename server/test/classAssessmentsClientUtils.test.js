const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const test = require('node:test');

const moduleUrl = pathToFileURL(path.resolve(
  __dirname,
  '../../client/src/utils/classAssessments.js'
)).href;

test('class assessment client preserves local date and time through ISO conversion', async () => {
  const { isoToLocalInput, localInputToIso } = await import(moduleUrl);
  const localValue = '2026-08-18T09:30';

  assert.equal(isoToLocalInput(localInputToIso(localValue)), localValue);
  assert.equal(localInputToIso(''), null);
  assert.equal(isoToLocalInput(null), '');
});

test('class assessment client compares participant selections without depending on order', async () => {
  const { sameIdSet } = await import(moduleUrl);

  assert.equal(sameIdSet(['student-a', 'student-b'], ['student-b', 'student-a']), true);
  assert.equal(sameIdSet(['student-a'], ['student-a', 'student-b']), false);
  assert.equal(sameIdSet(['student-a', 'student-b'], ['student-a', 'student-c']), false);
});

test('class assessment client schedules refresh at the next delivery transition', async () => {
  const { nextAssessmentTransition } = await import(moduleUrl);
  const now = Date.parse('2026-08-12T12:00:00.000Z');

  assert.equal(nextAssessmentTransition([
    { status: 'draft', opensAt: '2026-08-12T12:01:00.000Z' },
    { status: 'scheduled', opensAt: '2026-08-12T12:05:00.000Z' },
    { status: 'open', closesAt: '2026-08-12T12:03:00.000Z' },
    { status: 'closed', closesAt: '2026-08-12T12:02:00.000Z' },
  ], now), Date.parse('2026-08-12T12:03:00.000Z'));

  assert.equal(nextAssessmentTransition([
    { status: 'scheduled', opensAt: '2026-08-12T11:59:00.000Z' },
    { status: 'open', closesAt: 'data-inválida' },
  ], now), null);
});
