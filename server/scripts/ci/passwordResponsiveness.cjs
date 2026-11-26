// Local CPU measurement only. Never imports config, database or real accounts.
const { performance } = require('node:perf_hooks');
const bcrypt = require('bcryptjs');
const { PasswordPool } = require('../../src/services/passwordOperations');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function measure(work) {
  let previous = performance.now();
  const intervals = [];
  const timer = setInterval(() => { const now = performance.now(); intervals.push(now - previous); previous = now; }, 5);
  await pause(20);
  const start = performance.now();
  await work();
  const elapsedMs = performance.now() - start;
  await pause(20);
  clearInterval(timer);
  return { elapsedMs: Math.round(elapsedMs), longestTimerGapMs: Math.round(Math.max(...intervals)), timerTicks: intervals.length };
}
(async () => {
  const pool = new PasswordPool();
  try {
    await pool.hash('synthetic-warm-up', 10);
    const sync = await measure(() => { for (let i = 0; i < 4; i += 1) bcrypt.hashSync('synthetic-benchmark-password', 12); });
    const worker = await measure(() => Promise.all(Array.from({ length: 4 }, () => pool.hash('synthetic-benchmark-password', 12))));
    console.log(JSON.stringify({ node: process.version, hashes: 4, cost: 12, sync, worker,
      note: 'Local measurement, not a VPS latency guarantee. Hash cost is unchanged.' }, null, 2));
  } finally { await pool.close(); }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
