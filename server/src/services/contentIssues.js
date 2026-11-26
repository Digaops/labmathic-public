const { randomUUID, createHash } = require('node:crypto');
const { logActivityStrict } = require('../helpers/activity');
const { evaluateFeatureFlag } = require('./featureFlags');
const FLAG = 'content.issue_review';
const reasons = ['answer', 'content', 'media', 'accessibility', 'other'];
const statuses = ['open', 'in_review', 'resolved', 'not_changed'];
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
const hash = value => createHash('sha256').update(value).digest('hex');
function positive(value) { return ['number', 'string'].includes(typeof value) && /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0; }
function text(value) { return typeof value === 'string' ? value.trim().replace(/\r\n/g, '\n') : ''; }
function description(value) { const result = text(value); if (result.length < 10 || result.length > 2000 || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(result)) fail(400, 'invalid_text', 'Descreva o problema ou a resposta em 10 a 2.000 caracteres.'); return result; }
function fields(body, allowed) { if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(k => !allowed.includes(k))) fail(400, 'invalid_body', 'Confira os dados enviados.'); }
function actorFor(db, actor) {
  const current = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(actor?.id || 0);
  if (!current || !['admin', 'professor'].includes(current.role)) fail(403, 'access_denied', 'Seu acesso não permite esta operação.');
  if (!evaluateFeatureFlag(db, FLAG, current).enabled) fail(404, 'feature_disabled', 'Esta funcionalidade não está disponível para sua conta.');
  return current;
}
function target(db, actor, type, id) {
  if (type === 'material') return db.prepare('SELECT title AS label FROM materials WHERE id=?').get(id) || null;
  return db.prepare(`SELECT question_code AS label FROM questions WHERE id=?
    AND (?='admin' OR (status='active' AND (source='official' OR (source='teacher' AND created_by=?))))`).get(id, actor.role, actor.id) || null;
}
function issueRow(db, actor, publicId) {
  const row = db.prepare('SELECT * FROM content_issues WHERE public_id=? AND (?=\'admin\' OR reporter_id=?)').get(String(publicId), actor.role, actor.id);
  if (!row) fail(404, 'issue_missing', 'Relato não encontrado.');
  return row;
}
function summary(row) {
  return { id: row.public_id, targetType: row.target_type, targetId: row.target_id, targetLabel: row.target_label,
    reason: row.reason, status: row.status, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at };
}
function detail(db, actor, row) {
  const available = target(db, actor, row.target_type, row.target_id);
  const assignee = row.assignee_id ? db.prepare('SELECT name,role FROM users WHERE id=?').get(row.assignee_id) : null;
  return { ...summary(row), description: row.description,
    assignee: assignee?.name || (row.assignee_id ? 'Responsável anterior' : null),
    canReview: actor.role === 'admin' && row.status === 'in_review' && row.assignee_id === actor.id,
    canClaim: actor.role === 'admin' && (row.status === 'open' || (row.status === 'in_review' && assignee?.role !== 'admin')),
    targetAvailable: Boolean(available),
    // Never link an old report to a different question that now happens to reuse its code.
    targetPath: !available ? null : row.target_type === 'material' ? `/material/${row.target_id}` : `/banco-questoes?search=${encodeURIComponent(available.label)}`,
    events: db.prepare('SELECT action,reply,revision,created_at FROM content_issue_events WHERE issue_id=? ORDER BY revision').all(row.id)
      .map(e => ({ action: e.action, reply: e.reply, revision: e.revision, createdAt: e.created_at })),
  };
}
function listIssues(db, actor, query = {}) {
  actor = actorFor(db, actor);
  const status = query.status || 'all', page = query.page === undefined ? 1 : Number(query.page);
  if (![...statuses, 'all', 'pending'].includes(status) || !positive(page) || page > 10000) fail(400, 'invalid_query', 'Confira o filtro e a página.');
  const where = `(?='admin' OR reporter_id=?) AND (?='all' OR status=? OR (?='pending' AND status IN ('open','in_review')))`;
  const params = [actor.role, actor.id, status, status, status];
  const total = db.prepare(`SELECT COUNT(*) FROM content_issues WHERE ${where}`).pluck().get(...params);
  const items = db.prepare(`SELECT * FROM content_issues WHERE ${where} ORDER BY id DESC LIMIT 20 OFFSET ?`).all(...params, (page - 1) * 20).map(summary);
  return { items, total, page, pageSize: 20 };
}
function getIssue(db, actor, publicId) { actor = actorFor(db, actor); return detail(db, actor, issueRow(db, actor, publicId)); }
function operation(db, actor, key, body, execute) {
  if (typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,100}$/.test(key)) fail(400, 'invalid_key', 'Atualize a página antes de enviar.');
  const keyHash = hash(key), requestHash = hash(JSON.stringify(body));
  const previous = db.prepare('SELECT * FROM content_issue_operations WHERE actor_id=? AND key_hash=?').get(actor.id, keyHash);
  if (previous) {
    if (previous.request_hash !== requestHash) fail(409, 'operation_conflict', 'Este envio já foi utilizado para outros dados. Confira seu histórico.');
    return JSON.parse(previous.receipt_json);
  }
  const receipt = execute();
  db.prepare('INSERT INTO content_issue_operations(actor_id,key_hash,request_hash,receipt_json) VALUES (?,?,?,?)').run(actor.id, keyHash, requestHash, JSON.stringify(receipt));
  return receipt;
}
function auditEvent(db, audit, actor, row, action, req) {
  const descriptions = { created: 'Relato sobre o acervo enviado para revisão.', claimed: 'Responsabilidade pela revisão de acervo assumida.', resolved: 'Revisão de acervo concluída com ajuste informado.', not_changed: 'Revisão de acervo concluída sem alteração, com resposta ao professor.' };
  audit({ user: actor, req, action: 'content_issue_' + action, module: 'admin', entityType: 'content_issue', entityId: row.id,
    description: descriptions[action],
    metadata: { publicId: row.public_id, targetType: row.target_type, targetId: row.target_id, revision: row.revision } }, db);
}
function createIssue(db, { actor, key, body, req, audit = logActivityStrict }) {
  return db.transaction(() => {
    actor = actorFor(db, actor);
    fields(body, ['targetType', 'targetId', 'reason', 'description']);
    if (!['question', 'material'].includes(body.targetType) || !positive(body.targetId) || !reasons.includes(body.reason) || (body.targetType === 'material' && body.reason === 'answer')) fail(400, 'invalid_target', 'Confira o conteúdo e o tipo de problema.');
    const input = { targetType: body.targetType, targetId: Number(body.targetId), reason: body.reason, description: description(body.description) };
    return operation(db, actor, key, { action: 'create', ...input }, () => {
      if (db.prepare("SELECT COUNT(*) FROM content_issue_operations WHERE actor_id=? AND created_at >= datetime('now','-1 day')").pluck().get(actor.id) >= 30) fail(429, 'operation_limit', 'Muitas tentativas de envio nas últimas 24 horas. Confira seus relatos e tente mais tarde.');
      const content = target(db, actor, input.targetType, input.targetId);
      if (!content) fail(404, 'target_missing', 'Este conteúdo não está disponível para sua conta.');
      const existing = db.prepare("SELECT public_id FROM content_issues WHERE reporter_id=? AND target_type=? AND target_id=? AND status IN ('open','in_review')").get(actor.id, input.targetType, input.targetId);
      if (existing) return { id: existing.public_id, alreadyOpen: true };
      if (db.prepare("SELECT COUNT(*) FROM content_issues WHERE reporter_id=? AND created_at >= datetime('now','-1 day')").pluck().get(actor.id) >= 10) fail(429, 'daily_limit', 'Você já enviou 10 relatos nas últimas 24 horas. Aguarde para enviar outro.');
      const publicId = randomUUID();
      db.prepare('INSERT INTO content_issues(public_id,reporter_id,target_type,target_id,target_label,reason,description) VALUES (?,?,?,?,?,?,?)')
        .run(publicId, actor.id, input.targetType, input.targetId, content.label, input.reason, input.description);
      const row = issueRow(db, actor, publicId);
      db.prepare("INSERT INTO content_issue_events(issue_id,actor_id,action,revision) VALUES (?,?,'created',1)").run(row.id, actor.id);
      auditEvent(db, audit, actor, row, 'created', req);
      return { id: publicId, alreadyOpen: false };
    });
  }).immediate();
}
function reviewIssue(db, { actor, publicId, key, body, req, audit = logActivityStrict }) {
  return db.transaction(() => {
    actor = actorFor(db, actor);
    if (actor.role !== 'admin') fail(403, 'admin_required', 'A revisão é feita pela administração.');
    fields(body, ['action', 'expectedRevision', 'reply', 'confirmed']);
    if (!['claim', 'resolved', 'not_changed'].includes(body.action) || !positive(body.expectedRevision)) fail(400, 'invalid_review', 'Confira a ação de revisão.');
    const reply = body.action === 'claim' ? '' : description(body.reply);
    if (body.action !== 'claim' && body.confirmed !== true) fail(400, 'confirmation_required', 'Confira o conteúdo antes de concluir a revisão.');
    return operation(db, actor, key, { publicId, action: body.action, expectedRevision: Number(body.expectedRevision), reply, confirmed: body.confirmed === true }, () => {
      const row = issueRow(db, actor, publicId), current = detail(db, actor, row);
      if (row.revision !== Number(body.expectedRevision)) fail(409, 'review_conflict', 'Outro atendimento alterou este relato. Atualize os detalhes antes de continuar.');
      if (body.action === 'claim' ? !current.canClaim : !current.canReview) fail(409, 'invalid_transition', 'Assuma a revisão antes de responder. Relatos concluídos não podem ser alterados.');
      const action = body.action === 'claim' ? 'claimed' : body.action, status = body.action === 'claim' ? 'in_review' : body.action;
      db.prepare('UPDATE content_issues SET status=?,assignee_id=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(status, actor.id, row.id);
      db.prepare('INSERT INTO content_issue_events(issue_id,actor_id,action,reply,revision) VALUES (?,?,?,?,?)').run(row.id, actor.id, action, reply, row.revision + 1);
      auditEvent(db, audit, actor, { ...row, revision: row.revision + 1 }, action, req);
      return { id: publicId, revision: row.revision + 1 };
    });
  }).immediate();
}
module.exports = { FLAG, createIssue, reviewIssue, listIssues, getIssue };
