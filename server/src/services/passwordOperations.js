const path = require('node:path');
const { Worker } = require('node:worker_threads');

class PasswordOperationError extends Error {
  constructor(status = 503, code = 'PASSWORD_SERVICE_BUSY', message = 'Serviço de senhas ocupado. Aguarde alguns segundos e tente novamente.') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// One reusable worker per API process suits the shared VPS. Bound both retained
// requests and total wait time; never fall back to blocking the event loop.
class PasswordPool {
  constructor({ maxQueue = 16, timeoutMs = 15000, workerFile = path.join(__dirname, 'passwordWorker.js') } = {}) {
    this.maxQueue = maxQueue;
    this.timeoutMs = timeoutMs;
    this.workerFile = workerFile;
    this.queue = [];
    this.active = null;
    this.worker = null;
    this.closed = false;
  }

  hash(password, rounds = 10) {
    if (![10, 12].includes(rounds)) return Promise.reject(new TypeError('Unsupported password cost'));
    return this.run('hash', password, rounds);
  }

  compare(password, hash) { return this.run('compare', password, hash); }

  run(operation, password, value) {
    if (typeof password !== 'string' || password.length > 1024) return Promise.reject(new TypeError('Invalid password input'));
    if (this.closed || (this.active && this.queue.length >= this.maxQueue)) return Promise.reject(new PasswordOperationError());
    return new Promise((resolve, reject) => {
      const job = { payload: { operation, password, value }, resolve, reject };
      job.timer = setTimeout(() => {
        if (this.active === job) this.failWorker(this.worker);
        else {
          this.queue = this.queue.filter(item => item !== job);
          job.payload = null;
          reject(new PasswordOperationError());
        }
      }, this.timeoutMs);
      this.queue.push(job);
      this.pump();
    });
  }

  pump() {
    if (this.closed || this.active || !this.queue.length) return;
    this.active = this.queue.shift();
    try {
      if (!this.worker) {
        const worker = new Worker(this.workerFile, { env: {}, resourceLimits: { maxOldGenerationSizeMb: 32 } });
        this.worker = worker;
        worker.on('message', message => {
          if (this.worker !== worker || !this.active) return;
          const job = this.active;
          this.active = null;
          clearTimeout(job.timer);
          if (message.failed) job.reject(new PasswordOperationError());
          else job.resolve(message.result);
          worker.unref();
          this.pump();
        });
        worker.on('error', () => this.failWorker(worker));
        worker.on('exit', () => this.failWorker(worker));
      }
      this.worker.ref();
      this.worker.postMessage(this.active.payload);
      this.active.payload = null;
    } catch {
      this.failWorker(this.worker);
    }
  }

  failWorker(worker) {
    if (worker !== this.worker) return;
    this.worker = null;
    const jobs = [this.active, ...this.queue].filter(Boolean);
    this.active = null;
    this.queue = [];
    for (const job of jobs) {
      clearTimeout(job.timer);
      job.payload = null;
      job.reject(new PasswordOperationError());
    }
    // Fail the bounded batch, not a restart loop. A later request may retry.
    return worker?.terminate().catch(() => {});
  }

  async close() {
    this.closed = true;
    await this.failWorker(this.worker);
  }
}

module.exports = new PasswordPool();
module.exports.PasswordPool = PasswordPool;
module.exports.PasswordOperationError = PasswordOperationError;
