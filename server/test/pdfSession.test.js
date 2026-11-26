const test = require('node:test');
const assert = require('node:assert/strict');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
let createPdfSession, pdfPageText;
test.before(async () => { ({ createPdfSession, pdfPageText } = await import('../../client/src/services/pdfSession.mjs')); });
function fixture(t, getPage, { text = false } = {}) {
  const previousWindow = global.window;
  global.window = { devicePixelRatio: 4, getComputedStyle: () => ({ paddingLeft: '12', paddingRight: '12' }) };
  t.after(() => { if (previousWindow === undefined) delete global.window; else global.window = previousWindow; });
  const loading = deferred();
  const events = { destroyed: 0, loaded: [], errors: [], busy: [], rendered: [], cleaned: [], text: [] };
  const textWaiters = [];
  const task = { promise: loading.promise, destroy: async () => { events.destroyed += 1; } };
  const page = id => ({ getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale }),
    render: () => { events.rendered.push(id); return { promise: Promise.resolve(), cancel() {} }; },
    getTextContent: async () => ({ items: [{ str: `Texto real da página ${id}`, hasEOL: true }] }),
    cleanup: () => events.cleaned.push(id) });
  const pdf = { numPages: 3, getPage: getPage || (async id => page(id)) };
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ({ setTransform() {}, clearRect() {} }) };
  const session = createPdfSession({ getDocument: () => task, url: '/synthetic.pdf',
    onLoaded: n => events.loaded.push(n), onError: message => events.errors.push(message), onBusy: value => events.busy.push(value),
    onText: text ? state => {
      events.text.push(state);
      for (const waiter of textWaiters) if (state.status === waiter.status && state.pageNumber === waiter.pageNumber) waiter.resolve(state);
    } : undefined });
  const waitForText = (status, pageNumber = 1) => {
    const existing = events.text.find(state => state.status === status && state.pageNumber === pageNumber);
    return existing ? Promise.resolve(existing) : new Promise(resolve => textWaiters.push({ status, pageNumber, resolve }));
  };
  return { session, events, loading, page, pdf, canvas, waitForText, container: { clientWidth: 1000 } };
}

test('PDF encerra carregamento pendente exatamente uma vez e ignora resolução tardia', async t => {
  const f = fixture(t);
  await f.session.dispose(); await f.session.dispose();
  f.loading.resolve(f.pdf); await f.session.loaded;
  assert.equal(f.events.destroyed, 1);
  assert.deepEqual(f.events.loaded, []);
  assert.deepEqual(f.events.errors, []);
});

test('PDF ignora falha tardia após fechamento', async t => {
  const f = fixture(t);
  await f.session.dispose();
  f.loading.reject(new Error('request aborted'));
  await f.session.loaded;
  assert.deepEqual(f.events.errors, []);
});

test('falha de carregamento notifica a interface e ainda libera worker', async t => {
  const f = fixture(t);
  f.loading.reject(new Error('synthetic network failure'));
  await f.session.loaded; await f.session.dispose();
  assert.equal(f.events.errors.length, 1);
  assert.equal(f.events.destroyed, 1);
});

test('página libera recursos após pintura, limita DPI e zera bitmap ao fechar', async t => {
  const f = fixture(t);
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  assert.ok(f.canvas.width <= 1950, 'DPI 4 não quadruplica a alocação');
  assert.ok(f.canvas.width * f.canvas.height <= 16000000);
  assert.deepEqual(f.events.cleaned, [1]);
  assert.deepEqual(f.events.busy, [true, false]);
  await f.session.dispose();
  assert.equal(f.canvas.width, 0); assert.equal(f.canvas.height, 0);
});

test('página antiga em espera não pinta depois de pedido mais recente', async t => {
  const pending = deferred();
  const f = fixture(t, id => id === 1 ? pending.promise : Promise.resolve(f.page(id)));
  f.loading.resolve(f.pdf); await f.session.loaded;
  const old = f.session.render(1, f.canvas, f.container);
  await Promise.resolve();
  const latest = f.session.render(2, f.canvas, f.container);
  pending.resolve(f.page(1));
  await Promise.all([old, latest]);
  assert.deepEqual(f.events.rendered, [2]);
  assert.deepEqual(f.events.cleaned, [1, 2]);
  await f.session.dispose();
});

test('fechar durante getPage não pinta nem atualiza estado e limpa a página tardia', async t => {
  const pending = deferred();
  const f = fixture(t, () => pending.promise);
  f.loading.resolve(f.pdf); await f.session.loaded;
  const render = f.session.render(1, f.canvas, f.container);
  await Promise.resolve(); await f.session.dispose();
  pending.resolve(f.page(1)); await render;
  assert.deepEqual(f.events.rendered, []);
  assert.deepEqual(f.events.busy, [true]);
  assert.deepEqual(f.events.cleaned, [1]);
});

test('renderização cancelada termina antes de reutilizar canvas', async t => {
  const rendering = deferred();
  const started = deferred();
  let cancelled = 0;
  const f = fixture(t, async id => id === 1 ? { ...f.page(1), render() {
    started.resolve();
    return { promise: rendering.promise, cancel() { cancelled += 1; rendering.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
  } } : f.page(id));
  f.loading.resolve(f.pdf); await f.session.loaded;
  const old = f.session.render(1, f.canvas, f.container);
  await started.promise;
  const next = f.session.render(2, f.canvas, f.container);
  await Promise.all([old, next]);
  assert.equal(cancelled, 1);
  assert.deepEqual(f.events.rendered, [2]);
  assert.deepEqual(f.events.errors, []);
  await f.session.dispose();
});

test('texto preserva ordem, fragmentos, quebras e caracteres do PDF sem inventar estrutura', () => {
  const content = { items: [{ str: 'Mate' }, { str: 'mática: ' }, { str: '1/2 + 1/4', hasEOL: true },
    { type: 'beginMarkedContent', id: 'source-tag' }, { str: '<script> não é HTML; ação 😀 עברית', hasEOL: true }] };
  assert.equal(pdfPageText(content), 'Matemática: 1/2 + 1/4\n<script> não é HTML; ação 😀 עברית');
  assert.equal(pdfPageText({ items: [{ str: ' ', hasEOL: true }, { type: 'endMarkedContent' }] }), '');
  assert.throws(() => pdfPageText({}), /indisponível/);
});

test('página informa carregamento e texto real, liberando recursos após os dois usos', { timeout: 2000 }, async t => {
  const f = fixture(t, undefined, { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  const result = await f.waitForText('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(result, { pageNumber: 1, status: 'ready', text: 'Texto real da página 1' });
  assert.deepEqual(f.events.text.map(state => state.status), ['loading', 'ready']);
  assert.deepEqual(f.events.cleaned, [1]);
  assert.deepEqual(f.events.errors, []);
  await f.session.dispose();
});

test('texto lento não prende o canvas e texto antigo nunca substitui o da nova página', { timeout: 2000 }, async t => {
  const pending = deferred();
  const f = fixture(t, async id => id === 1 ? { ...f.page(id), getTextContent: () => pending.promise } : f.page(id), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  assert.deepEqual(f.events.rendered, [1]);
  assert.equal(f.events.busy.at(-1), false);
  assert.deepEqual(f.events.cleaned, [], 'extração ainda usa a página');
  await f.session.render(2, f.canvas, f.container);
  await f.waitForText('ready', 2);
  pending.resolve({ items: [{ str: 'Texto antigo' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.rendered, [1, 2]);
  assert.deepEqual(f.events.text.filter(state => state.status === 'ready'), [
    { pageNumber: 2, status: 'ready', text: 'Texto real da página 2' },
  ]);
  assert.deepEqual([...f.events.cleaned].sort(), [1, 2]);
  await f.session.dispose();
});

test('falha tardia de extração de outra página é ignorada', { timeout: 2000 }, async t => {
  const pending = deferred();
  const f = fixture(t, async id => id === 1 ? { ...f.page(id), getTextContent: () => pending.promise } : f.page(id), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  await f.session.render(2, f.canvas, f.container);
  await f.waitForText('ready', 2);
  pending.reject(Error('Falha antiga'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.text.at(-1).pageNumber, 2);
  assert.equal(f.events.text.at(-1).status, 'ready');
  assert.deepEqual(f.events.errors, []);
  await f.session.dispose();
});

test('ausência de texto é distinta de erro e não inventa conteúdo de imagem', { timeout: 2000 }, async t => {
  const f = fixture(t, async id => ({ ...f.page(id), getTextContent: async () => ({ items: [] }) }), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  assert.deepEqual(await f.waitForText('empty'), { pageNumber: 1, status: 'empty', text: '' });
  assert.deepEqual(f.events.rendered, [1]);
  assert.deepEqual(f.events.errors, []);
  await f.session.dispose();
});

test('erro de extração mantém canvas utilizável e retry só recarrega texto', { timeout: 2000 }, async t => {
  let attempts = 0;
  const f = fixture(t, async id => ({ ...f.page(id), getTextContent: async () => {
    attempts += 1;
    if (attempts === 1) throw Error('Extração indisponível');
    return { items: [{ str: 'Texto recuperado' }] };
  } }), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  assert.deepEqual(await f.waitForText('error'), { pageNumber: 1, status: 'error', text: '' });
  assert.deepEqual(f.events.errors, []);
  assert.ok(f.canvas.width > 0);
  await f.session.retryText(1);
  assert.deepEqual(f.events.text.at(-1), { pageNumber: 1, status: 'ready', text: 'Texto recuperado' });
  assert.deepEqual(f.events.rendered, [1], 'retry não repinta nem recria documento');
  assert.deepEqual(f.events.text.map(state => state.status), ['loading', 'error', 'loading', 'ready']);
  await f.session.dispose();
});

test('resize reutiliza extração em andamento e limpa proxy compartilhado apenas após término', { timeout: 2000 }, async t => {
  const pending = deferred();
  let sharedPage, reads = 0;
  const f = fixture(t, async () => sharedPage, { text: true });
  sharedPage = { ...f.page(1), getTextContent: () => { reads += 1; return pending.promise; } };
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  await f.session.render(1, f.canvas, { clientWidth: 500 });
  assert.equal(reads, 1);
  assert.deepEqual(f.events.cleaned, []);
  pending.resolve({ items: [{ str: 'Texto compartilhado' }] });
  await f.waitForText('ready');
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.cleaned, [1]);
  assert.deepEqual(f.events.text.map(state => state.status), ['loading', 'ready']);
  await f.session.dispose();
});

test('fechar durante extração ignora conteúdo tardio e encerra worker uma única vez', { timeout: 2000 }, async t => {
  const pending = deferred();
  const f = fixture(t, async id => ({ ...f.page(id), getTextContent: () => pending.promise }), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  await f.session.dispose(); await f.session.dispose();
  pending.resolve({ items: [{ str: 'Texto depois de fechar' }] });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(f.events.text, [{ pageNumber: 1, status: 'loading', text: '' }]);
  assert.deepEqual(f.events.cleaned, [1]);
  assert.equal(f.events.destroyed, 1);
  assert.equal(f.canvas.width, 0);
  assert.deepEqual(f.events.errors, []);
});

test('retry invalida extração anterior da mesma página sem publicar erro antigo', { timeout: 2000 }, async t => {
  const pending = deferred();
  let attempts = 0;
  const f = fixture(t, async id => ({ ...f.page(id), getTextContent: () => {
    attempts += 1;
    return attempts === 1 ? pending.promise : Promise.resolve({ items: [{ str: 'Texto atual' }] });
  } }), { text: true });
  f.loading.resolve(f.pdf); await f.session.loaded;
  await f.session.render(1, f.canvas, f.container);
  await f.session.retryText(1);
  pending.reject(Error('Falha anterior'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.events.text.at(-1).text, 'Texto atual');
  assert.equal(f.events.text.some(state => state.status === 'error'), false);
  assert.deepEqual(f.events.errors, []);
  await f.session.dispose();
});
