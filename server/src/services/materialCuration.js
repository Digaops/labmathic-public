const crypto = require('crypto');
const { evaluateFeatureFlag } = require('./featureFlags');
const { existingUploadPath } = require('./uploadPaths');
const { logActivityStrict } = require('../helpers/activity');
const { eligibleMaterialSkill } = require('./materialSkillEligibility');

const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function id(value) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) fail(400, 'invalid_id', 'Identificador inválido.');
  return Number(value);
}
function keyHash(key) {
  if (typeof key !== 'string' || !/^[\da-f-]{36}$/i.test(key)) fail(400, 'invalid_key', 'Reabra a revisão para iniciar um novo pedido.');
  return hash(key);
}
function skillView(row) {
  return { id: row.id, code: row.code, description: row.description, gradeId: row.grade_id,
    gradeName: row.grade_name, unitName: row.unit_name,
    version: hash([row.id, row.code, row.description, row.grade_id, row.unit_id]) };
}
const skillSelect = `SELECT skill.*, grade.name AS grade_name, unit.name AS unit_name
  FROM bncc_skills skill JOIN grades grade ON grade.id=skill.grade_id JOIN bncc_units unit ON unit.id=skill.unit_id`;
function materialSnapshot(db, materialId) {
  const material = db.prepare('SELECT * FROM materials WHERE id=?').get(id(materialId));
  if (!material) fail(404, 'material_missing', 'Material não encontrado no acervo.');
  const links = db.prepare(`${skillSelect}
    JOIN material_bncc_skills mapping ON mapping.skill_id=skill.id
    WHERE mapping.material_id=? ORDER BY skill.code`).all(material.id);
  // Explicit columns avoid duplicate SQL column names (skill.id versus review.id).
  const states = db.prepare(`SELECT mapping.skill_id, mapping.linked_by, mapping.link_source, mapping.created_at,
    state.needs_review, state.review_id, review.reason, review.location, review.actor_name, review.created_at AS reviewed_at
    FROM material_bncc_skills mapping
    LEFT JOIN material_bncc_review_state state ON state.material_id=mapping.material_id AND state.skill_id=mapping.skill_id
    LEFT JOIN material_bncc_reviews review ON review.id=state.review_id WHERE mapping.material_id=? ORDER BY mapping.skill_id`).all(material.id);
  const byId = new Map(states.map(s => [s.skill_id, s]));
  const associations = links.map(row => {
    const state = byId.get(row.id);
    return { ...skillView(row), status: state.needs_review === null ? 'legacy' : state.needs_review || !state.review_id ? 'needs_review' : 'confirmed',
      reason: state.reason || null, location: state.location || null, reviewer: state.actor_name || null, reviewedAt: state.reviewed_at || null };
  });
  return { material: { id: material.id, title: material.title, gradeId: material.grade_id }, associations,
    version: hash({ material, states, skills: associations.map(s => s.version) }) };
}
function receipt(db, actorId, key) {
  const row = db.prepare('SELECT receipt_json FROM material_bncc_operations WHERE actor_id=? AND key_hash=?').get(actorId, keyHash(key));
  if (!row) fail(404, 'operation_unconfirmed', 'Pedido ainda não confirmado.');
  return JSON.parse(row.receipt_json);
}
function searchSkills(db, query) {
  const q = typeof query.q === 'string' ? query.q.trim() : '';
  const page = query.page === undefined ? 1 : id(query.page);
  if (q.length < 2 || q.length > 80 || page > 10000) fail(400, 'invalid_search', 'Digite de 2 a 80 caracteres para buscar por código ou descrição.');
  const term = `%${q.replace(/[\\%_]/g, '\\$&')}%`;
  const where = "WHERE skill.code LIKE ? ESCAPE '\\' OR skill.description LIKE ? ESCAPE '\\'";
  const total = db.prepare(`SELECT COUNT(*) FROM bncc_skills skill ${where}`).pluck().get(term, term);
  const skills = db.prepare(`${skillSelect} ${where} ORDER BY skill.code LIMIT 20 OFFSET ?`).all(term, term, (page - 1) * 20).map(row => ({
    ...skillView(row),
    coverage: db.prepare(`SELECT COUNT(*) FROM material_bncc_skills mapping WHERE mapping.skill_id=? AND ${eligibleMaterialSkill()}`).pluck().get(row.id),
    pending: db.prepare(`SELECT COUNT(*) FROM material_bncc_review_state WHERE skill_id=? AND (needs_review=1 OR review_id IS NULL)`).pluck().get(row.id),
  }));
  return { skills, page, total, totalPages: Math.ceil(total / 20) };
}
function history(db, materialId, query) {
  const after = query.before === undefined ? Number.MAX_SAFE_INTEGER : id(query.before);
  const rows = db.prepare('SELECT id,decision,reason,location,actor_name,created_at,evidence_json FROM material_bncc_reviews WHERE material_id=? AND id<? ORDER BY id DESC LIMIT 21').all(id(materialId), after);
  return { events: rows.slice(0, 20).map(row => ({ id: row.id, decision: row.decision, reason: row.reason, location: row.location,
    reviewer: row.actor_name, createdAt: row.created_at, skill: JSON.parse(row.evidence_json).skill })),
    nextBefore: rows.length > 20 ? rows[19].id : null };
}
function reviewMaterial(db, { actor, materialId, key, body, req, audit = logActivityStrict }) {
  const materialIdValue = id(materialId), hashedKey = keyHash(key);
  const fields = ['skillId', 'skillVersion', 'expectedVersion', 'decision', 'reason', 'location', 'confirmed'];
  if (!body || Array.isArray(body) || Object.keys(body).length !== fields.length || Object.keys(body).some(k => !fields.includes(k))
    || !['confirm', 'remove'].includes(body.decision) || body.confirmed !== true
    || !/^[a-f0-9]{64}$/.test(body.expectedVersion || '') || !/^[a-f0-9]{64}$/.test(body.skillVersion || '')
    || typeof body.reason !== 'string' || body.reason.trim().length < 20 || body.reason.length > 1000
    || typeof body.location !== 'string' || body.location.length > 160 || (body.decision === 'confirm' && body.location.trim().length < 3)) {
    fail(400, 'invalid_review', 'Informe onde a habilidade é trabalhada, justifique a decisão e confirme a conferência.');
  }
  const skillId = id(body.skillId), requestHash = hash({ materialId: materialIdValue, body });
  return db.transaction(() => {
    const currentActor = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(actor.id);
    if (currentActor?.role !== 'admin') fail(403, 'admin_required', 'Apenas administradores podem revisar associações.');
    const prior = db.prepare('SELECT * FROM material_bncc_operations WHERE actor_id=? AND key_hash=?').get(actor.id, hashedKey);
    if (prior) {
      if (prior.request_hash !== requestHash) fail(409, 'operation_conflict', 'Este pedido já foi registrado com outros dados. Confira o resultado.');
      return JSON.parse(prior.receipt_json);
    }
    if (!evaluateFeatureFlag(db, 'materials.bncc_curation', actor).enabled) fail(403, 'feature_disabled', 'A gravação de revisões está pausada. Os registros anteriores continuam disponíveis.');
    const snapshot = materialSnapshot(db, materialIdValue);
    const skill = db.prepare(`${skillSelect} WHERE skill.id=?`).get(skillId);
    if (!skill || skillView(skill).version !== body.skillVersion || snapshot.version !== body.expectedVersion) fail(409, 'review_conflict', 'O material ou a habilidade mudou. Atualize a página e confira antes de salvar.');
    const previous = snapshot.associations.find(s => s.id === skillId);
    const material = db.prepare('SELECT * FROM materials WHERE id=?').get(materialIdValue);
    if (body.decision === 'confirm') {
      let safeLink = false;
      try { const url = new URL(material.external_url); safeLink = ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password; } catch { /* Legacy links may be incomplete. Never fetch them here. */ }
      if (!(material.file_path && existingUploadPath(material.file_path)) && !safeLink) fail(400, 'content_missing', 'Disponibilize o arquivo ou um link HTTP/HTTPS válido do material antes de associar uma habilidade.');
      if (!previous && snapshot.associations.length >= 50) fail(400, 'association_limit', 'Este material já tem 50 associações. Revise as existentes antes de adicionar outra.');
    } else if (!previous) fail(409, 'review_conflict', 'A associação já não está ativa. Atualize a página.');
    const reviewId = Number(db.prepare(`INSERT INTO material_bncc_reviews(material_id,skill_id,decision,reason,location,actor_id,actor_name,evidence_json)
      VALUES (?,?,?,?,?,?,?,?)`).run(materialIdValue, skillId, body.decision, body.reason.trim(), body.location.trim(), actor.id, currentActor.name,
        JSON.stringify({ material, skill: skillView(skill), previous: previous || null })).lastInsertRowid);
    if (body.decision === 'confirm') {
      if (!previous) db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (?,?,?)').run(materialIdValue, skillId, actor.id);
      db.prepare(`INSERT INTO material_bncc_review_state(material_id,skill_id,review_id,needs_review) VALUES (?,?,?,0)
        ON CONFLICT(material_id,skill_id) DO UPDATE SET review_id=excluded.review_id,needs_review=0`).run(materialIdValue, skillId, reviewId);
    } else db.prepare('DELETE FROM material_bncc_skills WHERE material_id=? AND skill_id=?').run(materialIdValue, skillId);
    const result = { operationKey: key, materialId: materialIdValue, skillId, decision: body.decision, reviewId, version: materialSnapshot(db, materialIdValue).version };
    audit({ user: actor, action: 'review_material_skill', module: 'materials', entityType: 'material', entityId: materialIdValue,
      entityTitle: material.title, metadata: { review_id: reviewId, skill_id: skillId, decision: body.decision, operation_key_hash: hashedKey }, req }, db);
    db.prepare('INSERT INTO material_bncc_operations(actor_id,key_hash,request_hash,receipt_json) VALUES (?,?,?,?)').run(actor.id, hashedKey, requestHash, JSON.stringify(result));
    return result;
  }).immediate();
}
module.exports = { materialSnapshot, searchSkills, history, receipt, reviewMaterial };
