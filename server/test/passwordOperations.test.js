const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { PasswordPool } = require('../src/services/passwordOperations');

test('worker mantém bcrypt existente, Unicode e custos 10/12', async t => {
  const pool = new PasswordPool();
  t.after(() => pool.close());
  const password = 'Senha sintética com ação 🔐';
  for (const rounds of [10, 12]) {
    const hash = await pool.hash(password, rounds);
    assert.equal(bcrypt.getRounds(hash), rounds);
    assert.equal(bcrypt.compareSync(password, hash), true);
    assert.equal(await pool.compare(password, hash), true);
    assert.equal(await pool.compare('incorreta', hash), false);
  }
  assert.equal(await pool.compare(password, bcrypt.hashSync(password, 4)), true);
  assert.equal(await pool.compare(password, 'hash-legado-inválido'), false);
  await assert.rejects(pool.hash(password, 4), TypeError);
});

test('trabalho de CPU deixa timers da API avançarem antes da conclusão', async t => {
  const pool = new PasswordPool();
  t.after(() => pool.close());
  await pool.hash('aquecer-worker', 10);
  let finished = false;
  const task = pool.hash('teste-de-responsividade', 12).then(() => { finished = true; });
  let ticks = 0;
  const timer = setInterval(() => { if (!finished) ticks += 1; }, 5);
  try { await task; } finally { clearInterval(timer); }
  assert.ok(ticks >= 2, `Timers avançaram ${ticks} vezes durante o hash`);
});

test('fila limitada recusa excesso e volta a aceitar após concluir', async t => {
  const pool = new PasswordPool({ maxQueue: 1 });
  t.after(() => pool.close());
  const first = pool.hash('primeira-senha', 10);
  const second = pool.hash('segunda-senha', 10);
  await assert.rejects(pool.hash('excesso-senha', 10), { status: 503, code: 'PASSWORD_SERVICE_BUSY' });
  await Promise.all([first, second]);
  assert.equal(typeof await pool.hash('recuperada', 10), 'string');
});

test('timeout encerra worker e rejeita lote sem fallback síncrono', async t => {
  const pool = new PasswordPool({ timeoutMs: 1 });
  t.after(() => pool.close());
  const results = await Promise.allSettled([pool.hash('um'), pool.hash('dois')]);
  assert.ok(results.every(result => result.status === 'rejected' && result.reason.status === 503));
  assert.equal(pool.active, null);
  assert.equal(pool.queue.length, 0);
  pool.timeoutMs = 15000;
  assert.equal(typeof await pool.hash('tentar-depois'), 'string');
});

test('falha de worker e encerramento rejeitam pendências sem travar o processo', async () => {
  const pool = new PasswordPool({ workerFile: path.join(__dirname, 'worker-inexistente.cjs') });
  await assert.rejects(pool.hash('não-registrar-esta-senha'), { status: 503 });
  pool.workerFile = path.join(__dirname, '../src/services/passwordWorker.js');
  const pending = pool.hash('pendente');
  const rejected = assert.rejects(pending, { status: 503 });
  await pool.close();
  await rejected;
  await assert.rejects(pool.hash('encerrado'), { status: 503 });
});
