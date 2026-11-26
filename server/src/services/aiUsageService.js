const { randomUUID } = require('node:crypto');
const { MODEL, OPERATION, PRICING, TIMEOUT_MS, usageCost, reservedCost } = require('./aiConfig');
const { AiError, fail } = require('./aiErrors');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function windows(time) {
  const day = new Date(time); day.setUTCHours(0, 0, 0, 0);
  const month = new Date(day); month.setUTCDate(1);
  const end = new Date(month); end.setUTCMonth(end.getUTCMonth() + 1);
  return { day: +day, month: +month, end: +end, label: month.toISOString().slice(0, 7) };
}
function parseUsage(raw) {
  const integer = n => Number.isSafeInteger(n) && n >= 0 && n <= 2000000;
  if (!raw || !integer(raw.input_tokens) || !integer(raw.output_tokens)
    || !integer(raw.total_tokens) || raw.total_tokens !== raw.input_tokens + raw.output_tokens) return null;
  const cached = raw.input_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = raw.input_tokens_details?.cache_write_tokens ?? null;
  if (!integer(cached) || cached > raw.input_tokens || (cacheWrite !== null && (!integer(cacheWrite) || cached + cacheWrite > raw.input_tokens))) return null;
  return { input: raw.input_tokens, output: raw.output_tokens, total: raw.total_tokens, cached, cacheWrite };
}
function createUsageService(db, { now = Date.now } = {}) {
  function committed(window) {
    return db.prepare(`SELECT COALESCE(SUM(COALESCE(estimated_cost_nanos,reserved_cost_nanos)),0)
      FROM ai_usage_events WHERE created_at>=? AND created_at<?`).pluck().get(window.month, window.end);
  }
  function updateAlert(window, settings, time) {
    const cost = committed(window), budget = settings.budgetNanos;
    const level = cost >= budget ? 100 : cost >= budget * 0.9 ? 90 : cost >= budget * settings.AI_BUDGET_WARNING_PERCENT / 100 ? 70 : 0;
    db.prepare(`INSERT INTO ai_budget_months(month,peak_alert_level,committed_cost_nanos,budget_nanos,updated_at) VALUES(?,?,?,?,?)
      ON CONFLICT(month) DO UPDATE SET peak_alert_level=MAX(peak_alert_level,excluded.peak_alert_level),
      committed_cost_nanos=excluded.committed_cost_nanos,budget_nanos=excluded.budget_nanos,updated_at=excluded.updated_at`)
      .run(window.label, level, cost, budget, time);
    return cost;
  }
  function reserve(actor, quantity, settings, key) {
    if (key !== undefined && (typeof key !== 'string' || !UUID.test(key))) fail('AI_INVALID_REQUEST');
    const time = now(), window = windows(time), cost = reservedCost(settings);
    let result;
    try {
      result = db.transaction(() => {
        // After a crash, release no money on assumptions: mark stale work failed but keep its reserve.
        db.prepare("UPDATE ai_usage_events SET status='failed',error_type='AI_TIMEOUT',completed_at=? WHERE status='reserved' AND created_at<?")
          .run(time, time - TIMEOUT_MS * 2);
        if (key && db.prepare('SELECT 1 FROM ai_usage_events WHERE user_id=? AND idempotency_key=?').get(actor.id, key.toLowerCase())) return { denied: 'AI_DUPLICATE_REQUEST' };
        const counts = db.prepare(`SELECT
          COALESCE(SUM(created_at>=?),0) AS daily, COALESCE(SUM(created_at>?),0) AS minute
          FROM ai_usage_events WHERE user_id=? AND created_at>=?`).get(window.day, time - 60000, actor.id, Math.min(window.month, time - 60000));
        // A rolling minute can straddle a UTC month boundary; count the calendar month independently.
        const monthly = db.prepare('SELECT COUNT(*) FROM ai_usage_events WHERE user_id=? AND created_at>=?').pluck().get(actor.id, window.month);
        if (counts.minute >= settings.AI_REQUESTS_PER_MINUTE) return { denied: 'AI_RATE_LIMITED' };
        if (counts.daily >= settings.AI_DAILY_REQUEST_LIMIT) return { denied: 'AI_DAILY_LIMIT_REACHED' };
        if (monthly >= settings.AI_MONTHLY_REQUEST_LIMIT) return { denied: 'AI_MONTHLY_LIMIT_REACHED' };
        const spent = updateAlert(window, settings, time);
        if (spent + cost > settings.budgetNanos) return { denied: 'AI_BUDGET_LIMIT_REACHED' };
        const id = randomUUID();
        db.prepare(`INSERT INTO ai_usage_events(id,user_id,idempotency_key,model,operation,pricing_version,
          questions_requested,status,reserved_cost_nanos,created_at) VALUES(?,?,?,?,?,?,?,'reserved',?,?)`)
          .run(id, actor.id, key?.toLowerCase() ?? null, MODEL, OPERATION, PRICING.version, quantity, cost, time);
        updateAlert(window, settings, time);
        return { id };
      }).immediate();
    } catch { fail('AI_USAGE_UNAVAILABLE'); }
    if (result.denied) fail(result.denied);
    return result.id;
  }
  function settle(id, usage, success, errorCode, settings, { uncertainPricing = false } = {}) {
    const safeError = success ? null : new AiError(errorCode).code;
    try {
      db.transaction(() => {
        const row = db.prepare('SELECT created_at FROM ai_usage_events WHERE id=?').get(id);
        if (!row) throw new Error('missing_reservation');
        const changed = db.prepare(`UPDATE ai_usage_events SET status=?,success=?,error_type=?,input_tokens=?,cached_input_tokens=?,
          cache_write_tokens=?,output_tokens=?,total_tokens=?,estimated_cost_nanos=?,completed_at=? WHERE id=? AND status='reserved'`)
          .run(success ? 'succeeded' : 'failed', Number(success), safeError, usage?.input ?? null, usage?.cached ?? null,
            usage?.cacheWrite ?? null, usage?.output ?? null, usage?.total ?? null, usage && !uncertainPricing ? usageCost(usage) : null, now(), id).changes;
        if (changed !== 1) throw new Error('reservation_already_closed');
        updateAlert(windows(row.created_at), settings, now());
      }).immediate();
    } catch { fail('AI_USAGE_UNAVAILABLE'); }
  }
  // Backend-only building block for a future dashboard; no content or public analytics endpoint.
  function summarizeMonth(month) {
    if (typeof month !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) fail('AI_INVALID_REQUEST');
    const window = windows(Date.parse(month + '-01T00:00:00Z'));
    return db.prepare(`SELECT user_id, strftime('%Y-%m-%d',created_at/1000,'unixepoch') AS day,model,operation,
      COUNT(*) AS requests, SUM(success) AS successes, SUM(questions_requested) AS questions_requested,
      COALESCE(SUM(input_tokens),0) AS input_tokens,COALESCE(SUM(output_tokens),0) AS output_tokens,
      COALESCE(SUM(total_tokens),0) AS total_tokens,
      SUM(COALESCE(estimated_cost_nanos,reserved_cost_nanos)) AS committed_cost_nanos,
      SUM(estimated_cost_nanos IS NULL) AS uncertain_requests
      FROM ai_usage_events WHERE created_at>=? AND created_at<? GROUP BY user_id,day,model,operation ORDER BY day,user_id`)
      .all(window.month, window.end);
  }
  return { reserve, settle, summarizeMonth };
}
module.exports = { createUsageService, parseUsage, windows };
