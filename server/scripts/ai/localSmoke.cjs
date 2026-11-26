// Explicit, one-shot operational test. Never imported by the application or CI.
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const serverRoot = path.resolve(__dirname, '../..');
const repoRoot = path.resolve(serverRoot, '..');
const { configuration, MODEL, FLAG, reservedCost, NANOS_PER_USD } = require('../../src/services/aiConfig');
const { AiError } = require('../../src/services/aiErrors');

function testSettings(apiKey) {
  return configuration({ OPENAI_API_KEY: apiKey, AI_MODEL: MODEL,
    AI_GLOBAL_MONTHLY_BUDGET_USD: '0.02', AI_DAILY_REQUEST_LIMIT: '1', AI_MONTHLY_REQUEST_LIMIT: '1',
    AI_REQUESTS_PER_MINUTE: '1', AI_MAX_QUESTIONS_PER_REQUEST: '1', AI_MAX_OUTPUT_TOKENS: '2500' });
}
function claimAttempt(directory) {
  // Keep this marker even on failure. An uncertain result must not allow another charge.
  fs.writeFileSync(path.join(directory, 'attempt.json'), JSON.stringify({ startedAt: new Date().toISOString(),
    model: MODEL, maximumCalls: 1, budgetUsd: 0.02 }), { flag: 'wx' });
}
function onceTransport({ live, directory, diagnostics, transport = fetch }) {
  let calls = 0;
  return async (url, options) => {
    if (String(url) !== 'https://api.openai.com/v1/responses' || options.method !== 'POST' || calls) {
      throw new AiError('AI_PROVIDER_UNAVAILABLE');
    }
    const body = JSON.parse(options.body);
    if (body.model !== MODEL || body.max_output_tokens !== 2500 || body.store !== false
      || body.service_tier !== 'default' || body.tools || body.previous_response_id || body.conversation
      || body.text?.format?.schema?.properties?.questions?.maxItems !== 1) throw new AiError('AI_INVALID_REQUEST');
    if (live) claimAttempt(directory);
    calls++;
    diagnostics.attempts = calls;
    const response = await transport(url, options);
    diagnostics.httpStatus = response.status;
    if (response.ok) return response;
    // Retain only known error codes, never the provider message, headers or raw body.
    const reader = response.body?.getReader();
    let bytes = 0;
    const chunks = [];
    try {
      if (reader) while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) break;
        chunks.push(Buffer.from(value));
      }
    } finally { if (reader) await reader.cancel().catch(() => {}); }
    const allowed = new Set(['invalid_api_key', 'insufficient_quota', 'model_not_found', 'permission_denied',
      'insufficient_permissions', 'unsupported_parameter', 'invalid_request_error', 'rate_limit_exceeded',
      'organization_spend_limit_exceeded', 'project_spend_limit_exceeded', 'credit_balance_exhausted']);
    try {
      const error = JSON.parse(Buffer.concat(chunks).toString('utf8')).error;
      diagnostics.providerCode = allowed.has(error?.code) ? error.code : 'unclassified';
    } catch { diagnostics.providerCode = 'unclassified'; }
    return new Response(JSON.stringify({ error: { message: 'Provider rejected isolated test.',
      code: diagnostics.providerCode, type: 'invalid_request_error' } }), {
      status: response.status, headers: { 'Content-Type': 'application/json' },
    });
  };
}
function readCatalog() {
  const Database = require('better-sqlite3');
  const source = new Database(path.join(serverRoot, 'data/database.sqlite'), { readonly: true, fileMustExist: true });
  try {
    const skill = source.prepare(`SELECT s.id,s.code,s.description,s.grade_id,s.unit_id,g.name AS grade_name,u.name AS unit_name
      FROM bncc_skills s JOIN grades g ON g.id=s.grade_id JOIN bncc_units u ON u.id=s.unit_id WHERE s.code=?`).get('EF04MA07');
    if (!skill) throw new Error('CATALOG_UNAVAILABLE');
    return skill;
  } finally { source.close(); }
}
async function readKey() {
  let bytes = 0;
  const chunks = [];
  const timer = setTimeout(() => process.stdin.destroy(new Error('KEY_INPUT_TIMEOUT')), 5000);
  try {
    for await (const chunk of process.stdin) {
      bytes += chunk.length;
      if (bytes > 1028) throw new Error('INVALID_KEY_INPUT');
      chunks.push(chunk);
    }
    const key = Buffer.concat(chunks).toString('utf8').trim();
    if (!/^sk-[A-Za-z0-9_-]{17,1021}$/.test(key)) throw new Error('INVALID_KEY_INPUT');
    return key;
  } finally { clearTimeout(timer); for (const chunk of chunks) chunk.fill(0); }
}
function offlineTransport(_url, options) {
  const body = JSON.parse(options.body), context = JSON.parse(body.input[0].content);
  const questions = [{ statement: 'Há 24 lápis para repartir igualmente entre 4 grupos. Quantos lápis cada grupo recebe?',
    support_text: null, alternatives: ['4', '6', '8', '12'].map((text, i) => ({ letter: 'ABCD'[i], text })),
    correct_answer: 'B', explanation: '24 dividido por 4 é 6.', difficulty: context.difficulty, bncc_skill: context.bncc.code }];
  return Promise.resolve(new Response(JSON.stringify({ model: MODEL, service_tier: 'default', status: 'completed',
    output: [{ type: 'message', content: [{ type: 'output_text', text: JSON.stringify({ questions }) }] }],
    usage: { input_tokens: 900, output_tokens: 250, total_tokens: 1150 } }), { headers: { 'Content-Type': 'application/json' } }));
}
async function main() {
  const mode = process.argv.slice(2);
  if (mode.length !== 1 || !['--offline', '--live-once'].includes(mode[0])) throw new Error('EXPLICIT_MODE_REQUIRED');
  const live = mode[0] === '--live-once';
  // Do not load existing operational secrets/configuration via dotenv.
  if (fs.existsSync(path.join(serverRoot, '.env'))) throw new Error('EXISTING_ENV_REFUSED');
  const skill = readCatalog();
  const outputRoot = path.join(repoRoot, 'tmp');
  fs.mkdirSync(outputRoot, { recursive: true });
  if (fs.lstatSync(outputRoot).isSymbolicLink()) throw new Error('INVALID_OUTPUT_ROOT');
  const directory = live ? path.join(outputRoot, 'ai-live-smoke-2026-09-14')
    : fs.mkdtempSync(path.join(outputRoot, 'ai-offline-smoke-'));
  if (live) fs.mkdirSync(directory); // Never re-use a live run, even if a previous attempt failed.
  let apiKey = live ? await readKey() : 'sk-offline-not-a-real-provider-key';
  const settings = testSettings(apiKey);
  if (!settings.configured || reservedCost(settings) > settings.budgetNanos) throw new Error('TEST_BUDGET_INVALID');
  Object.assign(process.env, { NODE_ENV: 'test', APP_ENV: 'development', DB_PATH: path.join(directory, 'fixture.sqlite'),
    UPLOAD_DIR: path.join(directory, 'uploads'), JWT_SECRET: randomUUID(), OPENAI_API_KEY: '', SMTP_USER: '', SMTP_PASS: '' });
  const db = require('../../src/database');
  const { createRouter } = require('../../src/routes/ai');
  const { createOpenaiService } = require('../../src/services/openaiService');
  const { issueUserToken } = require('../../src/services/authSessions');
  const express = require('express');
  const diagnostics = { attempts: 0, httpStatus: null, providerCode: null };
  const provider = createOpenaiService({ fetchImpl: onceTransport({ live, directory, diagnostics,
    transport: live ? fetch : offlineTransport }) });
  let listener;
  const started = Date.now();
  try {
    const teacher = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES('Teste isolado','isolated@example.invalid','disabled','professor')").run().lastInsertRowid);
    db.prepare('INSERT INTO grades(id,name,sort_order) VALUES(?,?,?)').run(skill.grade_id, skill.grade_name, 4);
    db.prepare('INSERT INTO bncc_units(id,name,sort_order) VALUES(?,?,1)').run(skill.unit_id, skill.unit_name);
    db.prepare('INSERT INTO bncc_skills(id,code,description,grade_id,unit_id) VALUES(?,?,?,?,?)')
      .run(skill.id, skill.code, skill.description, skill.grade_id, skill.unit_id);
    db.prepare('UPDATE feature_flags SET master_enabled=1,default_enabled=1,kill_switch_active=0 WHERE flag_key=?').run(FLAG);
    const app = express();
    app.use('/api/ai', createRouter(db, { config: () => settings, provider }));
    await new Promise((resolve, reject) => { listener = app.listen(0, '127.0.0.1', resolve); listener.once('error', reject); });
    const response = await fetch(`http://127.0.0.1:${listener.address().port}/api/ai/questions/generate`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + issueUserToken(teacher),
        'Idempotency-Key': randomUUID() },
      body: JSON.stringify({ year: skill.grade_id, bncc_skill_id: skill.id, topic: 'Repartição de materiais escolares em grupos iguais',
        difficulty: 'facil', question_type: 'multiple_choice', quantity: 1,
        teacher_instruction: 'Use números naturais pequenos e divisão exata. Enunciado curto, sem nomes de pessoas.' }),
      signal: AbortSignal.timeout(55000),
    });
    const result = await response.json();
    const event = db.prepare(`SELECT status,success,error_type,input_tokens,cached_input_tokens,output_tokens,total_tokens,
      estimated_cost_nanos,reserved_cost_nanos FROM ai_usage_events ORDER BY rowid DESC LIMIT 1`).get() || null;
    const questionsSaved = db.prepare('SELECT COUNT(*) FROM questions').pluck().get();
    const report = { mode: live ? 'live' : 'offline', model: MODEL, grade: skill.grade_name, skill: skill.code,
      startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, routeStatus: response.status,
      diagnostics, event, estimatedCostUsd: event?.estimated_cost_nanos == null ? null : event.estimated_cost_nanos / NANOS_PER_USD,
      conservativeReservationUsd: reservedCost(settings) / NANOS_PER_USD, testBudgetUsd: 0.02,
      questionsSaved, teacherReviewRequired: result.requires_teacher_review === true };
    const safe = JSON.stringify(report, null, 2);
    if (safe.includes(apiKey)) throw new Error('SECRET_OUTPUT_REFUSED');
    fs.writeFileSync(path.join(directory, 'report.json'), safe, { flag: 'wx' });
    console.log(safe);
    if (response.ok && result.questions?.length === 1 && questionsSaved === 0 && result.saved === false) {
      // Show only validated synthetic-topic content for human review. Never save it as an artifact/question.
      const preview = JSON.stringify({ questionForReview: result.questions[0] }, null, 2);
      if (preview.includes(apiKey)) throw new Error('SECRET_OUTPUT_REFUSED');
      console.log(preview);
    } else process.exitCode = 2;
  } finally {
    if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    db.close(); apiKey = null;
  }
}
if (require.main === module) main().catch(() => {
  console.error('TESTE_INTERROMPIDO: nenhuma repeticao automatica; conferir marcador e relatorio local.');
  process.exitCode = 1;
});
module.exports = { testSettings, claimAttempt, onceTransport, offlineTransport };
