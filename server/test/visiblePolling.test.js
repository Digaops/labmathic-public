const test = require('node:test');
const assert = require('node:assert/strict');
let createVisiblePoller;
let retryDelay;
test.before(async () => ({ createVisiblePoller, retryDelay } = await import('../../client/src/services/visiblePolling.mjs')));
const flush = async () => { for (let i = 0; i < 12; i += 1) await Promise.resolve(); };

function environment() {
  let now = 0;
  let next = 0;
  const timers = new Map();
  const doc = new EventTarget();
  doc.visibilityState = 'visible';
  const win = new EventTarget();
  const nav = { onLine: true };
  return {
    doc, win, nav, timers,
    options: { intervalMs: 30000, document: doc, window: win, navigator: nav, now: () => now,
      setTimer: (fn, delay) => { const id = ++next; timers.set(id, { fn, at: now + delay }); return id; },
      clearTimer: id => timers.delete(id) },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!due || due[1].at > target) break;
        now = due[1].at;
        timers.delete(due[0]); due[1].fn(); await flush();
      }
      now = target; await flush();
    },
    async visibility(value) { doc.visibilityState = value; doc.dispatchEvent(new Event('visibilitychange')); await flush(); },
    async online(value) { nav.onLine = value; win.dispatchEvent(new Event(value ? 'online' : 'offline')); await flush(); },
  };
}

test('pausa em aba oculta/offline e atualiza ao retornar sem duplicar foco e visibilidade', async t => {
  const env = environment(); let calls = 0;
  const poller = createVisiblePoller(async () => { calls += 1; }, env.options);
  t.after(() => poller.stop());
  await flush(); assert.equal(calls, 1);
  await env.advance(30000); assert.equal(calls, 2);
  await env.visibility('hidden'); await env.advance(180000); assert.equal(calls, 2);
  await env.visibility('visible'); env.win.dispatchEvent(new Event('focus')); await flush();
  assert.equal(calls, 3);
  await env.online(false); await env.advance(180000); assert.equal(calls, 3);
  await env.online(true); assert.equal(calls, 4);
});

test('não inicia consulta em aba inicialmente oculta e não sobrepõe requisições lentas', async t => {
  const env = environment(); let calls = 0; let finish;
  env.doc.visibilityState = 'hidden';
  const poller = createVisiblePoller(() => { calls += 1; return new Promise(resolve => { finish = resolve; }); }, env.options);
  t.after(() => poller.stop());
  await flush(); assert.equal(calls, 0);
  await env.visibility('visible'); assert.equal(calls, 1);
  const pending = poller.refresh();
  assert.equal(poller.refresh(), pending);
  await env.advance(90000); assert.equal(calls, 1);
  finish(); await flush(); await env.advance(29999); assert.equal(calls, 1);
  await env.advance(1); assert.equal(calls, 2);
  finish(); await flush();
});

test('429 respeita Retry-After mesmo ao focar ou pedir atualização manual', async t => {
  const env = environment(); let calls = 0;
  const poller = createVisiblePoller(async () => {
    calls += 1;
    if (calls === 1) throw { response: { status: 429, headers: { 'retry-after': '120' } } };
  }, { ...env.options, eventName: 'notifications:refresh' });
  t.after(() => poller.stop());
  await flush();
  await env.advance(30000);
  env.win.dispatchEvent(new Event('focus'));
  env.win.dispatchEvent(new Event('notifications:refresh'));
  await poller.refresh();
  await env.advance(89999); assert.equal(calls, 1);
  await env.advance(1); assert.equal(calls, 2);
  await env.advance(30000); assert.equal(calls, 3);
});

test('falhas consecutivas aumentam espera e descarte aborta trabalho da conta anterior', async () => {
  const env = environment(); let calls = 0; let lastSignal;
  const poller = createVisiblePoller(async ({ signal }) => { calls += 1; lastSignal = signal; throw new Error('offline'); }, env.options);
  await flush(); await env.advance(60000); assert.equal(calls, 2);
  await env.advance(119999); assert.equal(calls, 2);
  await env.advance(1); assert.equal(calls, 3);
  poller.stop(); assert.equal(lastSignal.aborted, true); assert.equal(env.timers.size, 0);
  env.win.dispatchEvent(new Event('focus')); await env.advance(900000); assert.equal(calls, 3);
});

test('remontagem de StrictMode não inicia trabalho descartado', async () => {
  const env = environment(); let calls = 0;
  const discarded = createVisiblePoller(async () => { calls += 1; }, env.options);
  discarded.stop();
  const current = createVisiblePoller(async () => { calls += 1; }, env.options);
  await flush(); assert.equal(calls, 1); current.stop();
});

test('Retry-After aceita segundos, data HTTP e corpo padronizado', () => {
  assert.equal(retryDelay({ response: { headers: { 'retry-after': '15' } } }), 15000);
  assert.equal(retryDelay({ response: { headers: { 'retry-after': 'Thu, 01 Jan 1970 00:01:00 GMT' } } }, 10000), 50000);
  assert.equal(retryDelay({ response: { data: { retryAfterSeconds: 90 } } }), 90000);
  assert.equal(retryDelay(new Error('network')), 0);
});
