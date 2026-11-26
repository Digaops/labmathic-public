const OpenAI = require('openai');
const { AiError, fail } = require('./aiErrors');
const { MODEL, TIMEOUT_MS } = require('./aiConfig');
const { requestBody } = require('./aiQuestionContract');
const BASE_URL = 'https://api.openai.com/v1';
function boundedFetch(fetchImpl) {
  return async (url, options) => {
    if (String(url) !== BASE_URL + '/responses') fail('AI_PROVIDER_UNAVAILABLE');
    const response = await fetchImpl(url, { ...options, redirect: 'error' });
    if (!response.body) fail('AI_INVALID_RESPONSE');
    const reader = response.body.getReader(), chunks = [];
    let bytes = 0;
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 150000) fail('AI_INVALID_RESPONSE');
        chunks.push(Buffer.from(value));
      }
    } finally { await reader.cancel().catch(() => {}); }
    const headers = new Headers(response.headers);
    headers.delete('content-length'); headers.delete('content-encoding');
    return new Response(Buffer.concat(chunks), { status: response.status, headers });
  };
}
function createClient(settings, fetchImpl = fetch) {
  if (!settings.configured || !settings.apiKey) fail('AI_NOT_CONFIGURED');
  return new OpenAI({ apiKey: settings.apiKey, baseURL: BASE_URL, organization: null, project: null, adminAPIKey: null,
    webhookSecret: null, maxRetries: 0, timeout: TIMEOUT_MS, logLevel: 'off',
    fetch: boundedFetch(fetchImpl), fetchOptions: { redirect: 'error' }, dangerouslyAllowBrowser: false });
}
function publicProviderError(error) {
  if (error instanceof AiError) return error;
  if (error instanceof OpenAI.APIConnectionTimeoutError || error?.name === 'AbortError') return new AiError('AI_TIMEOUT');
  if (error instanceof OpenAI.RateLimitError) return new AiError('AI_PROVIDER_RATE_LIMITED');
  return new AiError('AI_PROVIDER_UNAVAILABLE');
}
// Factory injection is only for isolated backend tests. Routes never accept provider options.
function createOpenaiService({ fetchImpl, timeoutMs = TIMEOUT_MS } = {}) {
  return {
    async generate(brief, settings) {
      const body = requestBody(brief, settings);
      const client = createClient(settings, fetchImpl);
      const controller = new AbortController();
      let timer;
      // Bound the entire operation, including body reads, not only receipt of response headers.
      const deadline = new Promise((_, reject) => {
        timer = setTimeout(() => { controller.abort(); reject(new AiError('AI_TIMEOUT')); }, timeoutMs);
      });
      try { return await Promise.race([client.responses.create(body, { signal: controller.signal, maxRetries: 0 }), deadline]); }
      catch (error) { throw controller.signal.aborted ? new AiError('AI_TIMEOUT') : publicProviderError(error); }
      finally { clearTimeout(timer); }
    },
  };
}
function hasExpectedPricing(response) {
  return Boolean(response && (response.model === MODEL || new RegExp('^' + MODEL.replaceAll('.', '\\.') + '-\\d{4}-\\d{2}-\\d{2}$').test(response.model || ''))
    && (!response.service_tier || response.service_tier === 'default'));
}
function extractSuggestion(response) {
  if (!hasExpectedPricing(response)) fail('AI_INVALID_RESPONSE');
  if (response.status === 'incomplete') fail('AI_INCOMPLETE_RESPONSE');
  if (response.status !== 'completed' || response.error || !Array.isArray(response.output)) fail('AI_INVALID_RESPONSE');
  if (response.output.some(item => !item || !['message','reasoning'].includes(item.type))) fail('AI_INVALID_RESPONSE');
  const contents = response.output.filter(item => item.type === 'message').flatMap(item => item.content || []);
  if (contents.some(item => item?.type === 'refusal')) fail('AI_RESPONSE_REFUSED');
  if (contents.length !== 1 || contents[0]?.type !== 'output_text' || typeof contents[0].text !== 'string'
    || Buffer.byteLength(contents[0].text, 'utf8') > 100000) fail('AI_INVALID_RESPONSE');
  try { return JSON.parse(contents[0].text); } catch { fail('AI_INVALID_RESPONSE'); }
}
module.exports = { createClient, createOpenaiService, extractSuggestion, hasExpectedPricing };
