const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { testSettings, claimAttempt, onceTransport, offlineTransport } = require('../scripts/ai/localSmoke.cjs');
const { reservedCost, MODEL } = require('../src/services/aiConfig');
const { requestBody } = require('../src/services/aiQuestionContract');
const fakeKey = 'sk-offline-not-a-real-provider-key';
const body = () => requestBody({ skill: { code: 'EF04MA07', description: 'Divisão em grupos.',
  grade_name: '4º Ano - EF', unit_name: 'Números' }, quantity: 1, difficulty: 'facil',
  topic: 'Distribuir materiais', teacher_instruction: '' }, testSettings(fakeKey));
const options = () => ({ method: 'POST', body: JSON.stringify(body()) });

test('smoke budget and quotas are independent of ambient configuration', () => {
  const settings = testSettings(fakeKey);
  assert.equal(settings.model, MODEL);
  assert.equal(settings.budgetNanos, 20000000);
  assert.equal(reservedCost(settings), 11192000);
  for (const name of ['AI_DAILY_REQUEST_LIMIT', 'AI_MONTHLY_REQUEST_LIMIT', 'AI_REQUESTS_PER_MINUTE', 'AI_MAX_QUESTIONS_PER_REQUEST']) assert.equal(settings[name], 1);
});
test('one-shot transport refuses another call even after an uncertain network failure', async () => {
  let calls = 0;
  const diagnostics = {};
  const transport = onceTransport({ live: false, diagnostics, transport: async () => { calls++; throw new Error('offline failure'); } });
  await assert.rejects(() => transport('https://api.openai.com/v1/responses', options()));
  await assert.rejects(() => transport('https://api.openai.com/v1/responses', options()));
  assert.equal(calls, 1); assert.equal(diagnostics.attempts, 1);
});
test('durable attempt marker cannot be overwritten', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-smoke-guard-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^labmathic-smoke-guard-/);
    fs.rmSync(root, { recursive: true });
  });
  claimAttempt(root);
  const before = fs.readFileSync(path.join(root, 'attempt.json'), 'utf8');
  assert.throws(() => claimAttempt(root), { code: 'EEXIST' });
  assert.equal(fs.readFileSync(path.join(root, 'attempt.json'), 'utf8'), before);
});
test('a fresh transport cannot send when another attempt marker already exists', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-smoke-guard-'));
  t.after(() => {
    assert.equal(path.dirname(fs.realpathSync(root)), fs.realpathSync(os.tmpdir()));
    assert.match(path.basename(root), /^labmathic-smoke-guard-/);
    fs.rmSync(root, { recursive: true });
  });
  claimAttempt(root);
  let calls = 0;
  const transport = onceTransport({ live: true, directory: root, diagnostics: {}, transport: async () => { calls++; } });
  await assert.rejects(() => transport('https://api.openai.com/v1/responses', options()), { code: 'EEXIST' });
  assert.equal(calls, 0);
});
test('transport rejects changed URL, model, tools, output limit and quantity before network', async () => {
  let calls = 0;
  for (const patch of [{ model: 'other' }, { tools: [] }, { max_output_tokens: 5000 }, { store: true }]) {
    const transport = onceTransport({ live: false, diagnostics: {}, transport: () => { calls++; } });
    await assert.rejects(() => transport('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify({ ...body(), ...patch }) }));
  }
  const transport = onceTransport({ live: false, diagnostics: {}, transport: () => { calls++; } });
  await assert.rejects(() => transport('https://example.invalid/responses', options()));
  const changed = body(); changed.text.format.schema.properties.questions.maxItems = 2;
  await assert.rejects(() => transport('https://api.openai.com/v1/responses', { method: 'POST', body: JSON.stringify(changed) }));
  assert.equal(calls, 0);
});
test('provider diagnostics never include messages, unknown codes or credentials', async () => {
  const diagnostics = {};
  const transport = onceTransport({ live: false, diagnostics, transport: async () => new Response(JSON.stringify({
    error: { code: fakeKey, message: fakeKey, type: fakeKey },
  }), { status: 403 }) });
  const response = await transport('https://api.openai.com/v1/responses', options());
  assert.equal(diagnostics.httpStatus, 403); assert.equal(diagnostics.providerCode, 'unclassified');
  assert.ok(!(await response.text()).includes(fakeKey));
  assert.ok(!JSON.stringify(diagnostics).includes(fakeKey));
});
test('offline transport is deterministic and never sends a request', async () => {
  const response = await offlineTransport('', options());
  assert.equal((await response.json()).usage.total_tokens, 1150);
});
test('paid mode is explicit, key travels on stdin, and no application secret is written', () => {
  const wrapper = fs.readFileSync(path.resolve(__dirname, '../scripts/ai/runLocalSmoke.ps1'), 'utf8');
  assert.match(wrapper, /param\(\[switch\]\$LiveOnce\)/);
  assert.match(wrapper, /StandardInput\.WriteLine/);
  assert.match(wrapper, /Test-LabMathicLocalKey/);
  assert.match(wrapper, /Select-Object -First 1/);
  assert.match(wrapper, /\$childStarted -and -not \$child.HasExited/);
  assert.doesNotMatch(wrapper, /Set-Content|WriteAllText|OPENAI_API_KEY\s*=/);
});
