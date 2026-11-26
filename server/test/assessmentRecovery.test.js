const test = require('node:test');
const assert = require('node:assert/strict');
let createAssessmentRecovery, DRAFT_KEY;
test.before(async () => ({ createAssessmentRecovery, DRAFT_KEY } = await import('../../client/src/services/assessmentRecovery.mjs')));
const tick = () => new Promise((resolve) => setImmediate(resolve));
const copy = (value) => structuredClone(value);
function portal(scope = 'opaque-attempt-one') {
  return { serverTime: new Date().toISOString(), student: { displayName: 'Nunca persistir este nome' },
    assessment: { status: 'open', title: 'Nunca persistir enunciados' },
    attempt: { draftScope: scope, status: 'draft', revision: 1 },
    items: [1, 2].map((n) => ({ id: 'q' + n, number: n, selectedOptionId: null,
      statement: 'Não guardar texto', options: ['A', 'B', 'C'].map((label) => ({ id: 'q' + n + label, label })) })) };
}
function fixture(numeric = false) {
  let current = portal(); let time = Date.now(); let override;
  if(numeric)current.items=current.items.map(item=>({...item,questionType:'numeric',numericValue:null,unit:'litros',options:[]}));
  const calls = []; const values = new Map(); const timers = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  async function real(method, path, body) {
    if (method === 'get') return copy(current);
    if (body.expectedRevision !== current.attempt.revision || current.attempt.status !== 'draft') {
      throw { response: { status: 409 } };
    }
    current.attempt.revision++;
    if (method === 'put') current.items.forEach((item) => { const r=body.responses.find(r=>r.itemId===item.id);
      if(numeric)item.numericValue=r.numericValue;else item.selectedOptionId=r.optionId; });
    else current.attempt.status = 'submitted';
    return copy(current);
  }
  const options = { request: async (...args) => { calls.push(copy(args.slice(0, 3))); return override ? override(...args) : real(...args); },
    storage: () => storage, now: () => time, schedule: (fn, delay) => { const id = {}; timers.set(id, { fn, delay }); return id; }, cancel: (id) => timers.delete(id) };
  let recovery = createAssessmentRecovery(options); recovery.start(copy(current));
  return { get recovery() { return recovery; }, current, calls, values, storage, timers, real,
    override(fn) { override = fn; }, advance(ms) { time += ms; },
    reload() { recovery.dispose(); recovery = createAssessmentRecovery(options); recovery.start(); },
    async sync() { recovery.retry(); await tick(); await tick(); },
  };
}

test('guarda só escolhas opacas da aba e remove cópia quando o servidor confirma', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A');
  const raw = f.values.get(DRAFT_KEY);
  assert.doesNotMatch(raw, /Nunca|statement|displayName|token|gabarito/);
  assert.equal(f.recovery.snapshot().canSubmit, false);
  await f.sync();
  assert.equal(f.current.items[0].selectedOptionId, 'q1A');
  assert.equal(f.values.has(DRAFT_KEY), false);
  assert.equal(f.recovery.snapshot().canSubmit, true);
  assert.deepEqual(f.calls.map(([method]) => method), ['get', 'put']);
});

test('número decimal com vírgula é salvo canonicamente; zero conta como resposta e pode ser apagado',async()=>{
  const f=fixture(true);f.recovery.choose('q1','2,5');f.recovery.choose('q2','0');await f.sync();
  assert.equal(f.current.items[0].numericValue,'2.5');assert.equal(f.current.items[1].numericValue,'0');assert.equal(f.recovery.snapshot().canSubmit,true);
  f.recovery.choose('q2','');assert.equal(f.recovery.snapshot().portal.items[1].numericValue,'');await f.sync();
  assert.equal(f.current.items[1].numericValue,null);assert.equal(f.recovery.snapshot().pendingIds.length,0);
});
test('digitação numérica incompleta permanece na aba sem enviar resposta inválida ou bloquear a edição',async()=>{
  const f=fixture(true);f.recovery.choose('q1','-');await f.sync();
  assert.equal(f.calls.filter(c=>c[0]==='put').length,0);assert.equal(f.recovery.snapshot().canEdit,true);assert.equal(f.recovery.snapshot().canSubmit,false);
  f.recovery.choose('q1','-2,');await f.sync();assert.equal(f.calls.filter(c=>c[0]==='put').length,0);
  f.recovery.choose('q1','-2,5');await f.sync();assert.equal(f.current.items[0].numericValue,'-2.5');assert.equal(f.recovery.snapshot().canSubmit,true);
});
test('salva respostas numéricas válidas e preserva a digitação incompleta junto ao valor já confirmado', async () => {
  const f = fixture(true);
  f.recovery.choose('q1', '5');
  await f.sync();
  f.recovery.choose('q1', '-2,');
  f.recovery.choose('q2', '42');
  await f.sync();

  assert.deepEqual(f.current.items.map(item => item.numericValue), ['5', '42']);
  assert.equal(f.recovery.snapshot().portal.items[0].numericValue, '-2,');
  assert.deepEqual(f.recovery.snapshot().invalidNumericIds, ['q1']);
  assert.deepEqual(f.recovery.snapshot().pendingIds, ['q1']);
  assert.equal(f.timers.size, 0);
  await f.recovery.submit();
  assert.equal(f.calls.filter(([method]) => method === 'post').length, 0);

  f.reload();
  await tick();
  assert.equal(f.recovery.snapshot().portal.items[0].numericValue, '-2,');
  assert.deepEqual(f.recovery.snapshot().invalidNumericIds, ['q1']);
  f.recovery.choose('q1', '-2,5');
  await f.sync();
  assert.deepEqual(f.current.items.map(item => item.numericValue), ['-2.5', '42']);
  assert.equal(f.recovery.snapshot().canSubmit, true);
});
test('finalização por prazo preserva as outras respostas salvas enquanto um número está incompleto', async () => {
  const f = fixture(true);
  f.recovery.choose('q1', '1,');
  f.recovery.choose('q2', '42');
  await f.sync();
  f.current.attempt.status = 'submitted';
  f.current.attempt.revision++;
  f.recovery.expire();
  await tick();

  const state = f.recovery.snapshot();
  assert.equal(state.portal.attempt.status, 'submitted');
  assert.deepEqual(state.portal.items.map(item => item.numericValue), [null, '42']);
  assert.deepEqual(state.pendingIds, ['q1']);
  assert.match(state.message, /não foram incluídas/);
  assert.deepEqual(f.calls.map(([method]) => method), ['get', 'put', 'get']);
});
test('resposta numérica sobrevive a confirmação perdida e recarga; conflito exige escolha humana',async()=>{
  const f=fixture(true);f.recovery.choose('q1','2,50');
  f.override(async(method,path,body)=>{const result=await f.real(method,path,body);if(method==='put')throw Error('lost numeric ack');return result;});
  await f.sync();f.override(null);f.reload();await tick();await tick();
  assert.equal(f.calls.filter(c=>c[0]==='put').length,1);assert.equal(f.recovery.snapshot().pendingIds.length,0);
  f.recovery.choose('q1','3');f.current.items[0].numericValue='4';f.current.attempt.revision++;await f.sync();
  assert.deepEqual(f.recovery.snapshot().conflicts,['q1']);f.recovery.resolve('q1',true);await f.sync();assert.equal(f.current.items[0].numericValue,'3');
});

test('falha de rede preserva escolha e retomada na mesma aba reconcilia antes de gravar', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A');
  f.override(() => { throw Error('offline'); }); await f.sync();
  assert.equal(f.recovery.snapshot().portal.items[0].selectedOptionId, 'q1A');
  assert.equal(f.recovery.snapshot().phase, 'offline');
  f.override(null); f.reload(); await tick(); await tick();
  assert.equal(f.current.items[0].selectedOptionId, 'q1A');
  assert.equal(f.recovery.snapshot().pendingIds.length, 0);
});

test('confirmação HTTP perdida não causa uma segunda gravação', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1B');
  f.override(async (method, path, body) => { const result = await f.real(method, path, body); if (method === 'put') throw Error('lost ack'); return result; });
  await f.sync(); assert.equal(f.current.attempt.revision, 2);
  f.override(null); await f.sync();
  assert.equal(f.calls.filter(([method]) => method === 'put').length, 1);
  assert.equal(f.recovery.snapshot().canSubmit, true);
});

test('escolhas feitas durante uma gravação lenta permanecem na fila sem concorrência', async () => {
  const f = fixture(); let release;
  f.override(async (method, path, body) => {
    if (method === 'put') await new Promise((resolve) => { release = resolve; });
    return f.real(method, path, body);
  });
  f.recovery.choose('q1', 'q1A'); f.recovery.retry(); await tick();
  f.recovery.choose('q1', 'q1C'); f.recovery.choose('q2', 'q2A'); f.recovery.retry();
  assert.equal(f.calls.filter(([method]) => method === 'put').length, 1);
  release(); await tick();
  assert.equal(f.recovery.snapshot().portal.items[0].selectedOptionId, 'q1C');
  assert.equal(f.recovery.snapshot().pendingIds.length, 2);
  f.override(null); await f.sync();
  assert.equal(f.current.items[0].selectedOptionId, 'q1C');
  assert.equal(f.current.items[1].selectedOptionId, 'q2A');
});

test('alteração em outra questão é mesclada; conflito na mesma exige decisão explícita', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A');
  f.current.items[1].selectedOptionId = 'q2B'; f.current.attempt.revision++;
  await f.sync(); assert.equal(f.current.items[1].selectedOptionId, 'q2B');
  f.recovery.choose('q1', 'q1B'); f.current.items[0].selectedOptionId = 'q1C'; f.current.attempt.revision++;
  const writes = f.calls.filter(([m]) => m === 'put').length;
  await f.sync();
  assert.deepEqual(f.recovery.snapshot().conflicts, ['q1']);
  assert.equal(f.calls.filter(([m]) => m === 'put').length, writes);
  f.recovery.resolve('q1', true); await f.sync();
  assert.equal(f.current.items[0].selectedOptionId, 'q1B');
  f.recovery.choose('q1', 'q1A'); f.current.items[0].selectedOptionId = 'q1C'; f.current.attempt.revision++;
  await f.sync(); f.recovery.resolve('q1', false);
  assert.equal(f.recovery.snapshot().portal.items[0].selectedOptionId, 'q1C');
  assert.equal(f.recovery.snapshot().pendingIds.length, 0);
});

test('entrega incerta só é confirmada por leitura e não repete POST', async () => {
  const f = fixture();
  f.override(async (...args) => { const result = await f.real(...args); if (args[0] === 'post') throw Error('lost submit ack'); return result; });
  await f.recovery.submit();
  assert.equal(f.recovery.snapshot().uncertain, true);
  assert.equal(f.recovery.snapshot().canEdit, false);
  f.override(null); await f.sync();
  assert.equal(f.recovery.snapshot().portal.attempt.status, 'submitted');
  assert.equal(f.calls.filter(([m]) => m === 'post').length, 1);
});
test('entrega confirmada atualiza resultado e orientação apenas por GET e rejeita retorno a rascunho', async () => {
  const f = fixture();
  await f.recovery.submit();
  f.current.assessment.status = 'closed';
  f.current.result = { percentage: 100 };
  f.current.feedback = { message: 'Confira a estratégia de resolução.' };
  await f.sync();
  assert.deepEqual(f.recovery.snapshot().portal.result, f.current.result);
  assert.deepEqual(f.recovery.snapshot().portal.feedback, f.current.feedback);

  f.override(() => ({ ...copy(f.current), attempt: { ...f.current.attempt, status: 'draft' } }));
  await f.sync();
  assert.equal(f.recovery.snapshot().portal.attempt.status, 'submitted');
  assert.equal(f.recovery.snapshot().canEdit, false);
  assert.equal(f.recovery.snapshot().canSubmit, false);
  assert.match(f.recovery.snapshot().message, /Não foi possível atualizar/);
  await f.recovery.submit();
  assert.deepEqual(f.calls.map(([method, path]) => [method, path]), [
    ['post', '/submit'], ['get', '/me'], ['get', '/me'],
  ]);
});

test('entrega que não chegou precisa de nova confirmação humana após leitura', async () => {
  const f = fixture(); f.override(() => { throw Error('offline'); });
  await f.recovery.submit(); f.override(null); await f.sync();
  assert.equal(f.recovery.snapshot().portal.attempt.status, 'draft');
  assert.match(f.recovery.snapshot().message, /entrega ainda não está confirmada/);
  assert.equal(f.calls.filter(([m]) => m === 'post').length, 1);
});

test('prazo encerrado não envia pendências e informa respostas excluídas da entrega', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1B');
  f.current.attempt.status = 'submitted'; f.current.attempt.revision++;
  f.recovery.expire(); await tick();
  assert.equal(f.calls.filter(([m]) => m === 'put').length, 0);
  assert.equal(f.recovery.snapshot().portal.items[0].selectedOptionId, null);
  assert.match(f.recovery.snapshot().message, /não foram incluídas/);
  assert.equal(f.recovery.snapshot().canEdit, false);
});

test('cópia de outra tentativa não é aplicada; sessão profissional permanece intacta', async () => {
  const f = fixture(); f.values.set('professional', 'untouched'); f.recovery.choose('q1', 'q1B');
  f.current.attempt.draftScope = 'other-attempt'; f.reload(); await tick();
  assert.equal(f.current.items[0].selectedOptionId, null);
  assert.equal(f.values.get('professional'), 'untouched');
  assert.match(f.recovery.snapshot().message, /outro acesso/);
});

test('armazenamento indisponível não perde escolha em memória nem promete recuperação', async () => {
  const f = fixture(); f.storage.setItem = () => { throw Error('quota'); };
  f.recovery.choose('q1', 'q1C');
  assert.equal(f.recovery.snapshot().storageAvailable, false);
  assert.equal(f.recovery.snapshot().portal.items[0].selectedOptionId, 'q1C');
  await f.sync(); assert.equal(f.current.items[0].selectedOptionId, 'q1C');
});

test('429 respeita Retry-After inclusive em repetição manual e 401 bloqueia gravações', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A');
  f.override(() => { throw { response: { status: 429, headers: { 'retry-after': '120' } } }; });
  await f.sync(); const count = f.calls.length; await f.sync(); assert.equal(f.calls.length, count);
  f.advance(120001); f.override(() => { throw { response: { status: 401 } }; });
  await f.sync(); assert.equal(f.recovery.snapshot().phase, 'blocked');
  assert.equal(f.recovery.snapshot().pendingIds.length, 1);
  const blockedCount = f.calls.length; await f.sync(); assert.equal(f.calls.length, blockedCount);
});

test('dispose cancela atualização de interface mas mantém escrita incerta recuperável', async () => {
  const f = fixture(); let release;
  f.override(async (...args) => { if (args[0] === 'put') await new Promise((resolve) => { release = resolve; }); return f.real(...args); });
  f.recovery.choose('q1', 'q1B'); f.recovery.retry(); await tick();
  f.recovery.dispose(); release(); await tick();
  assert.ok(JSON.parse(f.values.get(DRAFT_KEY)).flight);
  f.override(null); f.reload(); await tick(); await tick();
  assert.equal(f.recovery.snapshot().pendingIds.length, 0);
  assert.equal(f.calls.filter(([m]) => m === 'put').length, 1);
});

test('voltar à escolha anterior invalida gravação antiga que ainda poderia chegar', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A'); await f.sync();
  let delayedBody;
  f.override(async (method, path, body) => {
    if (method === 'put') { delayedBody = copy(body); throw Error('request may still arrive'); }
    return f.real(method, path, body);
  });
  f.recovery.choose('q1', 'q1B'); await f.sync();
  f.recovery.choose('q1', 'q1A'); f.override(null); await f.sync();
  assert.equal(f.current.items[0].selectedOptionId, 'q1A');
  await assert.rejects(() => f.real('put', '/responses', delayedBody));
  assert.equal(f.recovery.snapshot().pendingIds.length, 0);
});

test('cópia ilegível é sinalizada e preservada até escolha explícita ou saída', async () => {
  const f = fixture(); f.values.set(DRAFT_KEY, '{invalid'); f.reload(); await tick();
  assert.equal(f.values.get(DRAFT_KEY), '{invalid');
  assert.equal(f.recovery.snapshot().hasRecoveryCopy, true);
  assert.equal(f.recovery.snapshot().storageAvailable, false);
  assert.match(f.recovery.snapshot().message, /Não foi possível recuperar/);
});

test('retomada bloqueada antes de carregar portal ainda avisa sobre cópia existente', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A');
  f.override(() => { throw { response: { status: 401 } }; }); f.reload(); await tick();
  assert.equal(f.recovery.snapshot().portal, null);
  assert.equal(f.recovery.snapshot().hasRecoveryCopy, true);
});

test('tentativa removida do acesso bloqueia retomada sem apagar a cópia pendente', async () => {
  const f = fixture(); f.recovery.choose('q1', 'q1A'); f.current.attempt = null;
  f.reload(); await tick();
  assert.equal(f.recovery.snapshot().phase, 'blocked');
  assert.equal(f.recovery.snapshot().hasRecoveryCopy, true);
  assert.equal(f.recovery.snapshot().canSubmit, false);
  assert.equal(f.calls.filter(([method]) => method === 'put').length, 0);
});
