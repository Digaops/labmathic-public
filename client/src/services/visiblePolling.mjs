export function retryDelay(error, now = Date.now()) {
  const headers = error?.response?.headers;
  const raw = headers?.get?.('retry-after') ?? headers?.['retry-after'];
  const seconds = Number(raw ?? error?.response?.data?.retryAfterSeconds);
  if (Number.isFinite(seconds) && seconds > 0) return Math.min(seconds * 1000, 86_400_000);
  const date = typeof raw === 'string' ? Date.parse(raw) : NaN;
  return Number.isFinite(date) ? Math.min(Math.max(0, date - now), 86_400_000) : 0;
}

// Apenas consultas de leitura. Não repete gravações e não guarda dados de contas.
export function createVisiblePoller(task, {
  intervalMs, eventName, minGapMs = 3000,
  document: doc = document, window: win = window, navigator: nav = navigator,
  now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout,
} = {}) {
  let stopped = false;
  let timer;
  let pending;
  let controller;
  let lastStart = -Infinity;
  let blockedUntil = 0;
  let failures = 0;
  const available = () => !stopped && doc.visibilityState !== 'hidden' && nav.onLine !== false;
  const clear = () => { if (timer !== undefined) clearTimer(timer); timer = undefined; };
  const schedule = delay => {
    clear();
    if (available()) timer = setTimer(run, delay);
  };
  function run() {
    if (!available()) return Promise.resolve();
    if (pending) return pending;
    const wait = Math.max(blockedUntil, lastStart + minGapMs) - now();
    if (wait > 0) { schedule(wait); return Promise.resolve(); }
    clear();
    lastStart = now();
    controller = new AbortController();
    const { signal } = controller;
    pending = Promise.resolve().then(() => signal.aborted ? undefined : task({ signal }))
      .then(value => { failures = 0; blockedUntil = 0; return value; })
      .catch(error => {
        if (stopped || signal.aborted) return;
        failures += 1;
        const backoff = Math.min(intervalMs * (2 ** Math.min(failures, 5)), 300_000);
        blockedUntil = now() + Math.max(intervalMs, backoff, retryDelay(error, now()));
      })
      .finally(() => {
        pending = undefined;
        if (!stopped) schedule(Math.max(intervalMs, blockedUntil - now()));
      });
    return pending;
  }
  const onAvailability = () => { if (available()) run(); else clear(); };
  doc.addEventListener('visibilitychange', onAvailability);
  win.addEventListener('focus', onAvailability);
  win.addEventListener('online', onAvailability);
  win.addEventListener('offline', onAvailability);
  if (eventName) win.addEventListener(eventName, onAvailability);
  run();
  return {
    refresh: run,
    stop() {
      stopped = true;
      clear();
      controller?.abort();
      doc.removeEventListener('visibilitychange', onAvailability);
      win.removeEventListener('focus', onAvailability);
      win.removeEventListener('online', onAvailability);
      win.removeEventListener('offline', onAvailability);
      if (eventName) win.removeEventListener(eventName, onAvailability);
    },
  };
}
