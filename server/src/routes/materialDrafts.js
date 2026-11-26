const express = require('express');
const db = require('../database');
const upload = require('../middleware/upload');
const { verifyUserToken } = require('../services/authSessions');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { existingUploadPath } = require('../services/uploadPaths');
const { discardNewUpload } = require('../services/imageLifecycle');
const { logActivityStrict } = require('../helpers/activity');
const { notifyAllExcept } = require('../helpers/notify');

// Mounted after authenticate/requireAdmin. Draft IDs never identify catalog rows.
module.exports = function materialDrafts({ payload, fileDigest, validateReferences, hash, fail, requestKey, auditMaterial }) {
  const router = express.Router();
  const version = row => hash(JSON.stringify(row));
  function owned(id, actor) {
    if (!/^[1-9]\d*$/.test(String(id)) || !Number.isSafeInteger(Number(id))) fail(400, 'invalid_id', 'Rascunho inválido.');
    const row = db.prepare('SELECT * FROM material_drafts WHERE id=? AND owner_id=?').get(id, actor);
    if (!row) fail(404, 'draft_missing', 'Rascunho não encontrado nesta conta.');
    return row;
  }
  function enabled(req) {
    if (!evaluateFeatureFlag(db, 'materials.draft_publication', req.user).enabled) fail(403, 'feature_disabled', 'A gravação de rascunhos está pausada. O que já foi salvo continua preservado.');
  }
  function receiptFor(row, operation, key) {
    return { operationKey: key, operation, draftId: row.id, materialId: row.published_material_id, title: JSON.parse(row.payload_json).title, version: version(row) };
  }
  function audit(req, action, row, metadata) {
    logActivityStrict({ user: req.user, action, module: 'materials', entityType: 'material_draft', entityId: row.id,
      entityTitle: JSON.parse(row.payload_json).title, metadata, req });
  }
  router.get('/operations/:key', (req, res, next) => {
    try {
      const row = db.prepare('SELECT receipt_json FROM material_draft_operations WHERE actor_user_id=? AND key_hash=?').get(req.user.id, requestKey(req.params.key));
      if (!row) fail(404, 'operation_unconfirmed', 'Pedido ainda não confirmado.');
      res.json(JSON.parse(row.receipt_json));
    } catch (e) { next(e); }
  });
  // Reading saved work remains possible with the flag off; privacy never depends on it.
  router.get('/', (req, res, next) => {
    try {
      const page = req.query.page === undefined ? 1 : Number(req.query.page);
      if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail(400, 'invalid_page', 'Página inválida.');
      const total = db.prepare('SELECT COUNT(*) FROM material_drafts WHERE owner_id=? AND published_material_id IS NULL').pluck().get(req.user.id);
      const rows = db.prepare('SELECT id,payload_json,updated_at FROM material_drafts WHERE owner_id=? AND published_material_id IS NULL ORDER BY id DESC LIMIT 20 OFFSET ?').all(req.user.id, (page - 1) * 20);
      res.json({ drafts: rows.map(r => ({ id: r.id, title: JSON.parse(r.payload_json).title, updatedAt: r.updated_at })), page, total, totalPages: Math.ceil(total / 20) });
    } catch (e) { next(e); }
  });
  router.get('/:id', (req, res, next) => {
    try {
      const row = owned(req.params.id, req.user.id), p = JSON.parse(row.payload_json);
      const topics = p.topicIds.flatMap(id => db.prepare('SELECT id,name FROM topics WHERE id=?').all(id));
      const collections = p.addCollectionIds.flatMap(id => db.prepare('SELECT id,name FROM collections WHERE id=? AND (user_id=? OR is_public=1)').all(id, req.user.id));
      res.json({ material: { ...p, id: row.id, file_path: row.file_path, file_format: row.file_format, file_size: row.file_size },
        topics, collections: [], plannedCollections: collections, otherCollectionCount: 0, version: version(row), publishedMaterialId: row.published_material_id });
    } catch (e) { next(e); }
  });
  async function write(req, res, next) {
    try {
      const publishing = req.path.endsWith('/publish'), operation = publishing ? 'publish' : req.params.id ? 'update' : 'create';
      const key = req.get('Idempotency-Key'), keyHash = requestKey(key);
      let p;
      if (publishing) {
        try { p = JSON.parse(req.body.payload); } catch { fail(400, 'invalid_version', 'Reabra o rascunho antes de publicar.'); }
        if (!p || Object.keys(p).length !== 1 || !/^[a-f0-9]{64}$/.test(p.expectedVersion || '')) fail(400, 'invalid_version', 'Confira a versão do rascunho.');
      } else p = payload(req.body, operation === 'update');
      const file = await fileDigest(req.file);
      const requestHash = hash(JSON.stringify({ operation, id: req.params.id || null, payload: p, file }));
      try { req.user = verifyUserToken(req.authToken).user; } catch (e) { if (e.code?.startsWith('SQLITE_')) throw e; fail(401, 'session_expired', 'Sua sessão expirou. Entre novamente.'); }
      if (req.user.role !== 'admin') fail(403, 'admin_required', 'Apenas administradores podem preparar materiais.');
      if (req.aborted || res.destroyed) fail(400, 'request_cancelled', 'Envio interrompido. Confira o pedido.');
      const result = db.transaction(() => {
        const prior = db.prepare('SELECT * FROM material_draft_operations WHERE actor_user_id=? AND key_hash=?').get(req.user.id, keyHash);
        if (prior) {
          if (prior.request_hash !== requestHash) fail(409, 'operation_conflict', 'Este pedido já foi salvo com outros dados. Confira o resultado.');
          return { replay: true, receipt: JSON.parse(prior.receipt_json) };
        }
        enabled(req);
        const previous = req.params.id ? owned(req.params.id, req.user.id) : null;
        if (previous && (previous.published_material_id || version(previous) !== p.expectedVersion)) fail(409, 'material_conflict', 'Este rascunho mudou ou já foi publicado. Carregue a versão atual.');
        let id = previous?.id;
        if (publishing) {
          const saved = payload({ payload: previous.payload_json }, false);
          validateReferences(saved, req.user.id);
          // Never fetch arbitrary URLs here. File resolution is bounded to uploads.
          if (previous.file_path && !existingUploadPath(previous.file_path)) fail(400, 'content_missing', 'O arquivo salvo não está disponível. Reenvie o arquivo antes de publicar.');
          if (!previous.file_path && !saved.external_url) fail(400, 'content_missing', 'Adicione um arquivo ou um link antes de publicar.');
          const materialId = Number(db.prepare(`INSERT INTO materials(title,description,discipline_id,grade_id,material_type_id,file_format,file_path,file_size,external_url,duration,page_count,created_by)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(saved.title, saved.description || null, saved.discipline_id, saved.grade_id, saved.material_type_id,
            previous.file_format, previous.file_path, previous.file_size, saved.external_url || null, saved.duration || null, saved.page_count, req.user.id).lastInsertRowid);
          for (const topic of saved.topicIds) db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(materialId, topic);
          for (const collection of saved.addCollectionIds) {
            db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collection, materialId);
            db.prepare('UPDATE collections SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(collection);
          }
          db.prepare('UPDATE material_drafts SET published_material_id=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(materialId, id);
          const material = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
          auditMaterial(req, 'create_material', material, { draft_id: id, operation_key_hash: keyHash });
          notifyAllExcept(req.user.id, 'new_material', 'Novo material disponível', `"${material.title}" foi adicionado à biblioteca.`, { material_id: materialId });
        } else {
          validateReferences(p, req.user.id);
          if (file && previous?.file_path && !p.replaceFile) fail(400, 'replacement_required', 'Confirme a substituição do arquivo atual.');
          const json = JSON.stringify({ ...p, expectedVersion: null, replaceFile: false });
          const values = [json, req.file?.filename || previous?.file_path || null, file?.format || previous?.file_format || null, file?.size ?? previous?.file_size ?? null];
          if (previous) db.prepare('UPDATE material_drafts SET payload_json=?,file_path=?,file_format=?,file_size=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(...values, id);
          else id = Number(db.prepare('INSERT INTO material_drafts(payload_json,file_path,file_format,file_size,owner_id) VALUES (?,?,?,?,?)').run(...values, req.user.id).lastInsertRowid);
          // All accepted uploads are retained; replacement never deletes the previous file.
          if (req.file) db.prepare('INSERT INTO material_draft_files(file_path,draft_id) VALUES (?,?)').run(req.file.filename, id);
        }
        const row = owned(id, req.user.id), receipt = receiptFor(row, operation, key);
        audit(req, publishing ? 'publish_material_draft' : 'save_material_draft', row, { operation_key_hash: keyHash, revision: row.revision, material_id: row.published_material_id });
        db.prepare('INSERT INTO material_draft_operations(actor_user_id,key_hash,request_hash,receipt_json) VALUES (?,?,?,?)').run(req.user.id, keyHash, requestHash, JSON.stringify(receipt));
        return { replay: false, receipt };
      }).immediate();
      if (result.replay) discardNewUpload(req.file?.filename);
      res.status(operation === 'create' && !result.replay ? 201 : 200).json(result.receipt);
    } catch (e) {
      discardNewUpload(req.file?.filename);
      if (e.status) return res.status(e.status).json({ code: e.code, error: e.message });
      next(e);
    }
  }
  router.post('/', upload.single('file'), write);
  router.put('/:id', upload.single('file'), write);
  router.post('/:id/publish', require('multer')({ limits: { files: 0, fields: 1, parts: 2, fieldSize: 256 } }).none(), write);
  router.use((error, _req, res, next) => {
    if (error.status && error.code) return res.status(error.status).json({ code: error.code, error: error.message });
    next(error);
  });
  return router;
};
