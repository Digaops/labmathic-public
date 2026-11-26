const MODEL = 'gpt-5.6-luna';
const FLAG = 'ai.questions_generation';
const OPERATION = 'questions.generate';
const TIMEOUT_MS = 45000;
const MAX_INPUT_TOKENS = 32768;
const NANOS_PER_USD = 1000000000;
// Standard/global endpoint, short context. USD/token in integer nanodollars.
// Verified 2026-09-14: https://developers.openai.com/api/docs/pricing
const PRICING = Object.freeze({ version: 'luna-standard-2026-09-14', input: 200, cached: 20, cacheWrite: 250, output: 1200 });
const LIMITS = Object.freeze({
  AI_DAILY_REQUEST_LIMIT: [10, 1, 10000],
  AI_MONTHLY_REQUEST_LIMIT: [100, 1, 100000],
  AI_REQUESTS_PER_MINUTE: [3, 1, 60],
  AI_MAX_PROMPT_CHARS: [1500, 1, 1500],
  AI_MAX_QUESTIONS_PER_REQUEST: [5, 1, 5],
  AI_MAX_OUTPUT_TOKENS: [2500, 256, 2500],
  AI_BUDGET_WARNING_PERCENT: [70, 1, 89],
});
function configuration(env = process.env) {
  let valid = env.AI_MODEL === undefined || env.AI_MODEL === '' || env.AI_MODEL === MODEL;
  const settings = { model: MODEL };
  for (const [name, [fallback, min, max]] of Object.entries(LIMITS)) {
    const raw = env[name] ?? String(fallback);
    const value = /^\d+$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < min || value > max) valid = false;
    settings[name] = value;
  }
  const dollars = env.AI_GLOBAL_MONTHLY_BUDGET_USD ?? '25';
  settings.budgetNanos = Math.round(Number(dollars) * NANOS_PER_USD);
  if (!/^\d+(?:\.\d{1,6})?$/.test(dollars) || !Number.isSafeInteger(settings.budgetNanos)
    || settings.budgetNanos < 0 || settings.budgetNanos > 10000 * NANOS_PER_USD) valid = false;
  const key = env.OPENAI_API_KEY;
  settings.configured = Boolean(valid && typeof key === 'string' && key.length >= 20 && key.length <= 1024 && !/\s/.test(key));
  // Defense in depth against accidental JSON serialization of configuration.
  Object.defineProperty(settings, 'apiKey', { value: settings.configured ? key : null, enumerable: false });
  return Object.freeze(settings);
}
function reservedCost(settings) {
  return MAX_INPUT_TOKENS * PRICING.cacheWrite + settings.AI_MAX_OUTPUT_TOKENS * PRICING.output;
}
function usageCost(usage) {
  // Missing cache-write detail is conservatively charged as cache creation, not as zero.
  const writes = usage.cacheWrite ?? usage.input - usage.cached;
  return (usage.input - usage.cached - writes) * PRICING.input + usage.cached * PRICING.cached
    + writes * PRICING.cacheWrite + usage.output * PRICING.output;
}
module.exports = { MODEL, FLAG, OPERATION, TIMEOUT_MS, MAX_INPUT_TOKENS, NANOS_PER_USD, PRICING, configuration, reservedCost, usageCost };
