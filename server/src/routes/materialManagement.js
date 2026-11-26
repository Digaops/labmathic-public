const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const db = require('../database');
const upload = require('../middleware/upload');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { verifyUserToken } = require('../services/authSessions');
const { discardNewUpload } = require('../services/imageLifecycle');
const { notifyAllExcept } = require('../helpers/notify');
const { materialDeletionVersion } = require('../services/materialDeletionVersion');
const { evaluateFeatureFlag } = require('../services/featureFlags');

const hash = value => createHash('sha256').update(value).digest('hex');
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const validId = value => Number.isSafeInteger(value) && value > 0;
function requestKey(value) {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{20,120}$/.test(value)) fail(400, 'invalid_operation', 'Identificação do pedido inválida. Reabra o formulário.');
  return hash(value);
}
function ids(value, label, limit = 200) {
  if (!Array.isArray(value) || value.length > limit || value.some(id => !validId(id)) || new Set(value).size !== value.length) fail(400, 'invalid_fields', `${label}: seleção inválida.`);
  return [...value].sort((a, b) => a - b);
}
function payload(body, editing) {
  let p; try { p = JSON.parse(body.payload); } catch { fail(400, 'invalid_fields', 'Dados do material incompletos.'); }
  const fields = ['title', 'description', 'discipline_id', 'grade_id', 'material_type_id', 'external_url', 'duration', 'page_count', 'topicIds', 'addCollectionIds', 'replaceFile', 'expectedVersion'];
  if (!p || Array.isArray(p) || typeof p !== 'object' || Object.keys(p).some(key => !fields.includes(key))) fail(400, 'invalid_fields', 'Dados do material inválidos.');
  for (const [key, max] of [['title', 200], ['description', 5000], ['external_url', 2000], ['duration', 80]]) {
    if (typeof p[key] !== 'string' || p[key].length > max) fail(400, 'invalid_fields', `Confira o campo ${key}.`);
  }
  if (!p.title.trim()) fail(400, 'invalid_fields', 'Informe o título do material.');
  for (const key of ['discipline_id', 'grade_id', 'material_type_id']) if (p[key] !== null && !validId(p[key])) fail(400, 'invalid_fields', 'Confira a classificação do material.');
  if (p.page_count !== null && (!Number.isSafeInteger(p.page_count) || p.page_count < 0 || p.page_count > 100000)) fail(400, 'invalid_fields', 'Informe de 0 a 100000 páginas, ou deixe em branco.');
  const url = p.external_url.trim();
  if (url) { let parsed; try { parsed = new URL(url); } catch { fail(400, 'invalid_fields', 'Informe um link HTTP ou HTTPS válido.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) fail(400, 'invalid_fields', 'Use um link HTTP ou HTTPS sem credenciais.'); }
  if (typeof p.replaceFile !== 'boolean') fail(400, 'invalid_fields', 'Confira a substituição do arquivo.');
  if (editing ? !/^[a-f0-9]{64}$/.test(p.expectedVersion || '') : p.expectedVersion !== null) fail(400, 'invalid_version', 'Reabra o material antes de editar.');
  return { title: p.title.trim(), description: p.description, discipline_id: p.discipline_id, grade_id: p.grade_id, material_type_id: p.material_type_id,
    external_url: url, duration: p.duration, page_count: p.page_count, topicIds: ids(p.topicIds, 'Assuntos'), addCollectionIds: ids(p.addCollectionIds, 'Laboratórios', 50), replaceFile: p.replaceFile, expectedVersion: p.expectedVersion };
}
async function fileDigest(file) {
  if (!file) return null;
  const digest = createHash('sha256');
  for await (const chunk of fs.createReadStream(file.path)) digest.update(chunk);
  return { sha256: digest.digest('hex'), size: file.size, format: path.extname(file.originalname).slice(1).toUpperCase() };
}
function snapshot(id, actor) {
  const material = db.prepare('SELECT * FROM materials WHERE id=?').get(id);
  if (!material) fail(404, 'material_missing', 'Material não encontrado. Volte à lista para conferir.');
  const topics = db.prepare('SELECT t.id,t.name FROM topics t JOIN material_topics mt ON mt.topic_id=t.id WHERE mt.material_id=? ORDER BY t.name,t.id').all(id);
  const collections = db.prepare('SELECT c.id,c.name FROM collections c JOIN collection_items ci ON ci.collection_id=c.id WHERE ci.material_id=? AND (c.user_id=? OR c.is_public=1) ORDER BY c.name,c.id').all(id, actor);
  const count = db.prepare('SELECT COUNT(*) FROM collection_items WHERE material_id=?').pluck().get(id);
  return { material, topics, collections, otherCollectionCount: count - collections.length, version: materialDeletionVersion(db, material) };
}
function validateReferences(p, actor) {
  for (const [field, table] of [['discipline_id', 'disciplines'], ['grade_id', 'grades'], ['material_type_id', 'material_types']]) {
    if (p[field] && !db.prepare(`SELECT id FROM ${table} WHERE id=?`).get(p[field])) fail(400, 'invalid_reference', 'Uma classificação mudou. Atualize as opções e confira sua escolha.');
  }
  for (const id of p.topicIds) if (!db.prepare('SELECT id FROM topics WHERE id=?').get(id)) fail(400, 'invalid_reference', 'Um assunto não está mais disponível. Atualize as opções.');
  for (const id of p.addCollectionIds) if (!db.prepare('SELECT id FROM collections WHERE id=? AND (user_id=? OR is_public=1)').get(id, actor)) fail(403, 'invalid_collection', 'Um laboratório não está disponível para sua conta.');
}

module.exports = function materialManagement({ auditMaterial, retireMaterialFiles }) {
  const router = express.Router();
  router.use(authenticate, requireAdmin, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
  router.use('/drafts', require('./materialDrafts')({ payload, fileDigest, validateReferences, hash, fail, requestKey, auditMaterial }));
  router.get('/operations/:key', (req, res, next) => {
    try { const saved = db.prepare('SELECT receipt_json FROM material_management_operations WHERE actor_user_id=? AND key_hash=?').get(req.user.id, requestKey(req.params.key));
      if (!saved) return res.status(404).json({ code: 'operation_unconfirmed', error: 'Pedido ainda não confirmado. Não inicie outro cadastro para repeti-lo.' });
      res.json(JSON.parse(saved.receipt_json));
    } catch (e) { next(e); }
  });
  router.get('/:id', (req, res, next) => {
    try { const id = Number(req.params.id); if (!validId(id)) fail(400, 'invalid_id', 'Material inválido.'); res.json(db.transaction(() => snapshot(id, req.user.id))()); }
    catch (e) { next(e); }
  });
  async function save(req, res, next) {
    try {
      if (req.user.role !== 'admin') fail(403, 'admin_required', 'Apenas administradores podem salvar materiais.');
      const operation = req.params.id ? 'update' : 'create', id = operation === 'update' ? Number(req.params.id) : null;
      if (operation === 'update' && !validId(id)) fail(400, 'invalid_id', 'Material inválido.');
      const key = req.get('Idempotency-Key'), keyHash = requestKey(key), p = payload(req.body, operation === 'update');
      const file = await fileDigest(req.file), requestHash = hash(JSON.stringify({ operation, id, payload: p, file }));
      // Hashing a large file yields the event loop; revalidate the session after it.
      try { req.user = verifyUserToken(req.authToken).user; }
      catch (error) {
        if (error.code?.startsWith('SQLITE_')) throw error;
        fail(401, 'session_expired', 'Sua sessão expirou. Entre novamente antes de salvar.');
      }
      if (req.user.role !== 'admin') fail(403, 'admin_required', 'Apenas administradores podem salvar materiais.');
      if (req.aborted || res.destroyed) fail(400, 'request_cancelled', 'Envio interrompido. Confira o pedido antes de repetir.');
      const outcome = db.transaction(() => {
        const previous = db.prepare('SELECT request_hash,receipt_json FROM material_management_operations WHERE actor_user_id=? AND key_hash=?').get(req.user.id, keyHash);
        if (previous) {
          if (previous.request_hash !== requestHash) fail(409, 'operation_conflict', 'Este pedido já foi salvo com outros dados. Confira o resultado antes de continuar.');
          return { replay: true, receipt: JSON.parse(previous.receipt_json) };
        }
        if (!id && evaluateFeatureFlag(db, 'materials.draft_publication', req.user).enabled) fail(409, 'draft_required', 'O cadastro agora começa como rascunho. Abra Novo material para preparar e publicar.');
        const existing = id ? db.prepare('SELECT * FROM materials WHERE id=?').get(id) : null;
        if (id && (!existing || materialDeletionVersion(db, existing) !== p.expectedVersion)) fail(409, 'material_conflict', 'O material mudou ou foi removido. Suas alterações não foram salvas. Confira a versão atual.');
        validateReferences(p, req.user.id);
        if (file && existing?.file_path && !p.replaceFile) fail(400, 'replacement_required', 'Confirme a substituição do arquivo atual.');
        if (file && existing?.file_path) retireMaterialFiles(existing, 'replaced', req);
        let materialId = id;
        const values = [p.title, p.description || null, p.discipline_id, p.grade_id, p.material_type_id,
          file?.format || existing?.file_format || null, req.file?.filename || existing?.file_path || null, file?.size ?? existing?.file_size ?? null,
          p.external_url || null, p.duration || null, p.page_count];
        if (id) db.prepare('UPDATE materials SET title=?,description=?,discipline_id=?,grade_id=?,material_type_id=?,file_format=?,file_path=?,file_size=?,external_url=?,duration=?,page_count=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(...values, id);
        else materialId = Number(db.prepare('INSERT INTO materials(title,description,discipline_id,grade_id,material_type_id,file_format,file_path,file_size,external_url,duration,page_count,created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(...values, req.user.id).lastInsertRowid);
        db.prepare('DELETE FROM material_topics WHERE material_id=?').run(materialId);
        for (const topicId of p.topicIds) db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(materialId, topicId);
        // Additions only. Never replace links belonging to this or another administrator.
        for (const collectionId of p.addCollectionIds) {
          const added = db.prepare('INSERT OR IGNORE INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collectionId, materialId);
          if (added.changes) db.prepare('UPDATE collections SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(collectionId);
        }
        const material = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
        auditMaterial(req, operation === 'create' ? 'create_material' : 'update_material', material, {
          operation_key_hash: keyHash, previous: existing ? { title: existing.title, discipline_id: existing.discipline_id } : null,
          current: { title: material.title, discipline_id: material.discipline_id }, added_collection_ids: p.addCollectionIds, topic_ids: p.topicIds, file_replaced: Boolean(file && existing?.file_path),
        });
        if (operation === 'create') notifyAllExcept(req.user.id, 'new_material', 'Novo material disponível', `"${material.title}" foi adicionado à biblioteca.`, { material_id: material.id });
        const receipt = { operationKey: key, operation, materialId, title: material.title, version: materialDeletionVersion(db, material) };
        db.prepare('INSERT INTO material_management_operations(actor_user_id,key_hash,request_hash,operation,material_id,receipt_json) VALUES (?,?,?,?,?,?)').run(req.user.id, keyHash, requestHash, operation, materialId, JSON.stringify(receipt));
        return { replay: false, receipt };
      }).immediate();
      if (outcome.replay) discardNewUpload(req.file?.filename);
      res.status(operation === 'create' && !outcome.replay ? 201 : 200).json(outcome.receipt);
    } catch (e) {
      discardNewUpload(req.file?.filename);
      if (e.status) return res.status(e.status).json({ code: e.code || 'save_failed', error: e.message });
      if (['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_CHECK', 'SQLITE_CONSTRAINT_NOTNULL'].includes(e.code)) return res.status(400).json({ code: 'invalid_reference', error: 'Não foi possível salvar. Confira as classificações e os vínculos.' });
      next(e);
    }
  }
  router.post('/', upload.single('file'), save);
  router.put('/:id', upload.single('file'), save);
  return router;
};
