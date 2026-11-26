const { createHash, randomUUID } = require('node:crypto');
const { prepareAuthoringBrief, validateQuestionSuggestion } = require('./aiAuthoringContract');
const provider = require('./aiAuthoringProvider');
const { evaluateFeatureFlag } = require('./featureFlags');
const FLAG = 'question_bank.ai_assistant';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const messages = {
  generation_unavailable: 'A geração por IA ainda não está liberada. Você pode continuar escrevendo sua questão no editor.',
  invalid_brief: 'Confira o ano, a unidade, a habilidade e o texto. Não inclua dados de pessoas.',
  quota_exceeded: 'O limite de uso deste piloto foi atingido. Continue pelo editor ou consulte a administração.',
  generation_busy: 'Já há uma sugestão em andamento. Aguarde ou consulte o pedido anterior.',
  idempotency_conflict: 'Este pedido já foi enviado com outro conteúdo. Confira o resultado antes de criar outro.',
  request_not_found: 'Pedido não encontrado para esta conta.',
  review_required: 'Confira a questão, o gabarito e a habilidade antes de aproveitar a sugestão.',
  curriculum_changed: 'A habilidade ou o ano escolar deste pedido foi atualizado. Prepare uma nova sugestão com o catálogo atual.',
};
class AiAuthoringError extends Error { constructor(status, code) { super(messages[code] || 'Não foi possível concluir a ajuda de IA.'); this.status = status; this.code = code; } }
const fail = (status, code) => { throw new AiAuthoringError(status, code); };
function curriculum(db) {
  const skills = db.prepare("SELECT id,code,description,grade_id,unit_id FROM bncc_skills WHERE code GLOB 'EF[0-9][0-9]MA[0-9][0-9]' ORDER BY code").all();
  return { skills, grades: db.prepare('SELECT id,name FROM grades ORDER BY sort_order,name').all().filter(g => skills.some(s => s.grade_id === g.id)),
    units: db.prepare('SELECT id,name FROM bncc_units ORDER BY sort_order,name').all().filter(u => skills.some(s => s.unit_id === u.id)) };
}
function prepare(db, input, catalog = curriculum(db)) {
  try {
    if (!['new_question','complement'].includes(input?.mode) || input.skillIds?.length !== 1) throw new Error();
    return prepareAuthoringBrief(input, catalog);
  } catch { return fail(400, 'invalid_brief'); }
}
function catalogOfBrief(brief) {
  return { grades: [brief.grade], units: [brief.unit], skills: brief.skills.map(skill => ({ ...skill, grade_id: brief.grade.id, unit_id: brief.unit.id })) };
}
function assertCurrentCurriculum(db, brief) {
  let current;
  try {
    current = prepare(db, { mode: brief.mode, gradeId: brief.grade.id, unitId: brief.unit.id, academicYear: brief.academicYear,
      skillIds: brief.skills.map(s => s.id), teacherText: brief.teacherText, privacyConfirmed: true });
  } catch { fail(409, 'curriculum_changed'); }
  if (hash(current) !== hash(brief)) fail(409, 'curriculum_changed');
}
function authorize(db, actor) {
  const user = db.prepare('SELECT id,role,auth_version FROM users WHERE id=?').get(actor?.id || -1);
  if (!user || user.role !== 'professor' || (actor.auth_version !== undefined && user.auth_version !== actor.auth_version)) fail(403, 'request_not_found');
  if (!evaluateFeatureFlag(db, FLAG, user).enabled) fail(404, 'generation_unavailable');
}
function createAiAuthoring(db, { config = () => provider.configuration(), generate = provider.generate, now = Date.now, timeoutMs = 45000,
  audit = (id, action, time) => db.prepare('INSERT INTO ai_authoring_events(request_id,action,created_at) VALUES(?,?,?)').run(id, action, time) } = {}) {
  const controllers = new Map();
  function expire() {
    db.transaction(() => {
      const old = db.prepare("SELECT public_id FROM ai_authoring_requests WHERE status='processing' AND created_at<?").all(now() - 70000);
      for (const r of old) { db.prepare("UPDATE ai_authoring_requests SET status='expired',completed_at=? WHERE public_id=? AND status='processing'").run(now(), r.public_id); audit(r.public_id, 'expired', now()); controllers.get(r.public_id)?.abort(); }
    }).immediate();
  }
  function own(actor, id) {
    authorize(db, actor); if (typeof id !== 'string' || !UUID.test(id)) fail(404, 'request_not_found');
    const row = db.prepare('SELECT * FROM ai_authoring_requests WHERE public_id=? AND teacher_id=?').get(id, actor.id);
    if (!row) fail(404, 'request_not_found'); return row;
  }
  const view = row => row ? { id: row.public_id, requestKey: row.idempotency_key, status: row.status, brief: JSON.parse(row.brief_json), model: row.model,
    suggestion: row.suggestion_json ? JSON.parse(row.suggestion_json) : null, reviewed: Boolean(row.reviewed_at),
    failureCode: row.failure_code, createdAt: row.created_at } : null;
  function get(actor, id) { own(actor, id); expire(); return view(own(actor, id)); }
  function getByKey(actor, key) {
    authorize(db, actor);
    if (typeof key !== 'string' || !UUID.test(key)) fail(404, 'request_not_found');
    const row = db.prepare('SELECT public_id FROM ai_authoring_requests WHERE teacher_id=? AND idempotency_key=?').get(actor.id, key);
    if (!row) fail(404, 'request_not_found');
    return get(actor, row.public_id);
  }
  function bootstrap(actor) {
    authorize(db, actor); expire();
    return { available: config().enabled, curriculum: curriculum(db), maxSkills: 1, dailyLimit: 5,
      latest: view(db.prepare('SELECT * FROM ai_authoring_requests WHERE teacher_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(actor.id)) };
  }
  async function request(actor, input, key) {
    authorize(db, actor);
    if (typeof key !== 'string' || !UUID.test(key)) fail(400, 'idempotency_conflict');
    expire();
    const reserved = db.transaction(() => {
      const previous = db.prepare('SELECT * FROM ai_authoring_requests WHERE teacher_id=? AND idempotency_key=?').get(actor.id, key);
      if (previous) {
        // Replays use the original trusted catalog snapshot, not a catalog that may have changed since dispatch.
        const original = JSON.parse(previous.brief_json);
        const replay = prepare(db, input, catalogOfBrief(original));
        if (previous.request_hash !== hash(replay)) fail(409, 'idempotency_conflict');
        return { previous };
      }
      const brief = prepare(db, input), fingerprint = hash(brief), settings = config();
      if (!settings.enabled) fail(503, 'generation_unavailable');
      const body = provider.requestBody(brief, settings.model);
      // Deliberately conservative token allowance, not a price quote. Keep reservations even on uncertain failures.
      const reservedTokens = Buffer.byteLength(JSON.stringify(body), 'utf8') + 2048 + provider.MAX_OUTPUT_TOKENS;
      if (reservedTokens > 30000) fail(400, 'invalid_brief');
      const day = new Date(now()); day.setUTCHours(0,0,0,0);
      const month = new Date(day); month.setUTCDate(1);
      const spent = db.prepare('SELECT COALESCE(SUM(reserved_tokens),0) FROM ai_authoring_requests WHERE created_at>=?').pluck().get(month.getTime());
      const daily = db.prepare('SELECT COUNT(*) FROM ai_authoring_requests WHERE teacher_id=? AND created_at>=?').pluck().get(actor.id, day.getTime());
      if (spent + reservedTokens > settings.tokenBudget || daily >= 5) fail(429, 'quota_exceeded');
      const active = db.prepare("SELECT teacher_id FROM ai_authoring_requests WHERE status='processing'").all();
      if (active.length >= 2 || active.some(r => r.teacher_id === actor.id)) fail(409, 'generation_busy');
      const id = randomUUID();
      db.prepare(`INSERT INTO ai_authoring_requests(public_id,teacher_id,idempotency_key,request_hash,brief_json,model,prompt_version,status,reserved_tokens,created_at)
        VALUES(?,?,?,?,?,?,?,'processing',?,?)`).run(id, actor.id, key, fingerprint, JSON.stringify(brief), settings.model, provider.PROMPT_VERSION, reservedTokens, now());
      audit(id, 'reserved', now()); return { id, body, brief, settings };
    }).immediate();
    if (reserved.previous) return view(reserved.previous);
    const controller = new AbortController(); controllers.set(reserved.id, controller);
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const generated = await generate({ body: reserved.body, config: reserved.settings, signal: controller.signal });
      if (controller.signal.aborted) throw new Error('generation_timeout');
      const suggestion = validateQuestionSuggestion(generated.suggestion, reserved.brief);
      db.transaction(() => {
        const changed = db.prepare("UPDATE ai_authoring_requests SET status='succeeded',suggestion_json=?,input_tokens=?,output_tokens=?,completed_at=? WHERE public_id=? AND status='processing'")
          .run(JSON.stringify(suggestion), generated.usage.input, generated.usage.output, now(), reserved.id).changes;
        if (changed) audit(reserved.id, 'succeeded', now());
      }).immediate();
    } catch (error) {
      const code = controller.signal.aborted ? 'generation_timeout'
        : ['suggestion_refused','incomplete_suggestion'].includes(error.message) ? error.message : 'generation_failed';
      db.transaction(() => { const changed = db.prepare("UPDATE ai_authoring_requests SET status='failed',failure_code=?,completed_at=? WHERE public_id=? AND status='processing'").run(code, now(), reserved.id).changes;
        if (changed) audit(reserved.id, 'failed', now()); }).immediate();
    } finally { clearTimeout(timer); controllers.delete(reserved.id); }
    return get(actor, reserved.id);
  }
  function cancel(actor, id) {
    own(actor, id);
    db.transaction(() => { const changed = db.prepare("UPDATE ai_authoring_requests SET status='cancelled',completed_at=? WHERE public_id=? AND status='processing'").run(now(), id).changes;
      if (changed) audit(id, 'cancelled', now()); }).immediate();
    controllers.get(id)?.abort(); return get(actor, id);
  }
  function review(actor, id, checks) {
    const row = own(actor, id);
    if (row.status !== 'succeeded' || !checks || Object.keys(checks).length !== 3
      || ['math','clarity','curriculum'].some(k => checks[k] !== true)) fail(400, 'review_required');
    assertCurrentCurriculum(db, JSON.parse(row.brief_json));
    db.transaction(() => { const changed = db.prepare('UPDATE ai_authoring_requests SET reviewed_at=? WHERE public_id=? AND reviewed_at IS NULL').run(now(), id).changes;
      if (changed) audit(id, 'reviewed', now()); }).immediate();
    return get(actor, id);
  }
  return { bootstrap, request, get, getByKey, cancel, review, prepare: input => prepare(db, input) };
}
function recordAiQuestionLink(db, actorId, questionId, requestId) {
  if (requestId === undefined || requestId === '') return;
  const request = typeof requestId === 'string' && UUID.test(requestId) && db.prepare("SELECT brief_json FROM ai_authoring_requests WHERE public_id=? AND teacher_id=? AND status='succeeded' AND reviewed_at IS NOT NULL").get(requestId, actorId);
  const question = db.prepare("SELECT skill_id,statement,support_text,official_explanation,image_path FROM questions WHERE id=? AND created_by=? AND source='teacher'").get(questionId, actorId);
  if (!request || !question) fail(400, 'review_required');
  assertCurrentCurriculum(db, JSON.parse(request.brief_json));
  const options = db.prepare('SELECT option_label,option_text,is_correct FROM question_options WHERE question_id=? ORDER BY sort_order').all(questionId);
  db.prepare('INSERT INTO ai_authoring_question_links(request_id,question_id,saved_content_json,saved_at) VALUES(?,?,?,?)')
    .run(requestId, questionId, JSON.stringify({ ...question, options }), Date.now());
}
module.exports = { FLAG, AiAuthoringError, createAiAuthoring, prepare, authorize, recordAiQuestionLink };
