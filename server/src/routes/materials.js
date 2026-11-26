const express = require('express');
const path = require('path');
const fs = require('fs');
const db = require('../database');
const config = require('../config');
const { authenticate, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload');
const listingLimit = require('../middleware/listingLimit');
const { notifyAllExcept } = require('../helpers/notify');
const { logActivity, logActivityStrict } = require('../helpers/activity');
const { findActiveShare } = require('../services/sharedMaterials');
const { existingUploadPath } = require('../services/uploadPaths');
const { materialDeletionVersion, checkDeletionVersion } = require('../services/materialDeletionVersion');

const router = express.Router();
router.use('/management', require('./materialManagement')({ auditMaterial, retireMaterialFiles }));
router.use('/curation', require('./materialCuration'));

// ─── Helper: build WHERE clause from filters ───
function buildFilters(query, user) {
  const conditions = [];
  const params = [];

  if (query.search) {
    conditions.push(`(m.title LIKE ? OR m.description LIKE ?)`);
    const term = `%${query.search}%`;
    params.push(term, term);
  }
  if (query.discipline_id) {
    conditions.push('m.discipline_id = ?');
    params.push(Number(query.discipline_id));
  }
  if (query.grade_id) {
    conditions.push('m.grade_id = ?');
    params.push(Number(query.grade_id));
  } else if (query.my_grades === '1' && user?.role === 'professor') {
    conditions.push(`(
      NOT EXISTS (
        SELECT 1 FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
      OR m.grade_id IN (
        SELECT preference.grade_id
        FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
    )`);
    params.push(user.id, user.id);
  }
  if (query.material_type_id) {
    conditions.push('m.material_type_id = ?');
    params.push(Number(query.material_type_id));
  }
  if (query.file_format) {
    conditions.push('m.file_format = ?');
    params.push(query.file_format);
  }
  if (query.topic_id) {
    conditions.push('EXISTS (SELECT 1 FROM material_topics mt2 WHERE mt2.material_id = m.id AND mt2.topic_id = ?)');
    params.push(Number(query.topic_id));
  }

  return { conditions, params };
}

function parsePositiveInt(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function attachTopics(materials) {
  if (!materials.length) return;
  const byMaterial = new Map(materials.map(material => {
    material.topics = [];
    return [material.id, material.topics];
  }));
  const topics = db.prepare(`
    SELECT mt.material_id, t.id, t.name FROM material_topics mt
    INNER JOIN topics t ON t.id = mt.topic_id
    WHERE mt.material_id IN (${materials.map(() => '?').join(',')})
    ORDER BY mt.material_id, t.id
  `).all(...materials.map(material => material.id));
  for (const topic of topics) {
    byMaterial.get(topic.material_id).push({ id: topic.id, name: topic.name });
  }
}

function removeUpload(filename) {
  if (!filename) return;

  const fileFull = path.join(config.uploadDir, filename);
  if (fs.existsSync(fileFull)) {
    fs.unlinkSync(fileFull);
  }
}

function validateMaterialInput({ title, description }) {
  if (typeof title !== 'string' || !title.trim()) {
    return 'Título é obrigatório.';
  }

  if (String(title).trim().length > 200) {
    return 'Título deve ter no máximo 200 caracteres.';
  }

  if (description != null && (typeof description !== 'string' || description.length > 5000)) {
    return 'Descrição deve ter no máximo 5000 caracteres.';
  }

  return null;
}

function parseTopicIds(topics) {
  if (!topics) return [];

  let topicIds;
  try {
    topicIds = typeof topics === 'string' ? JSON.parse(topics) : topics;
  } catch {
    const error = new Error('Formato de tópicos inválido.');
    error.status = 400;
    throw error;
  }

  if (!Array.isArray(topicIds)) {
    const error = new Error('Formato de tópicos inválido.');
    error.status = 400;
    throw error;
  }

  if (topicIds.length > 200 || topicIds.some(id => !parsePositiveInt(id))) {
    throw Object.assign(new Error('Tópicos inválidos.'), { status: 400 });
  }
  return [...new Set(topicIds.map(Number))];
}

function validateCollectionId(collectionId) {
  if (!collectionId) return null;

  const id = parsePositiveInt(collectionId);
  if (!id) {
    const error = new Error('Laboratório inválido.');
    error.status = 400;
    throw error;
  }

  const collection = db.prepare('SELECT id FROM collections WHERE id = ?').get(id);
  if (!collection) {
    const error = new Error('Laboratório não encontrado.');
    error.status = 404;
    throw error;
  }

  return id;
}

// ─── GET /api/materials ─── (public for authenticated users)
router.get('/', authenticate, (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const offset = (page - 1) * limit;

  const { conditions, params } = buildFilters(req.query, req.user);
  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  // Sorting
  const validSorts = {
    'recent': 'm.created_at DESC',
    'oldest': 'm.created_at ASC',
    'title_asc': 'm.title ASC',
    'title_desc': 'm.title DESC',
    'most_viewed': '(SELECT COUNT(*) FROM access_history ah WHERE ah.material_id = m.id) DESC',
    'best_rated': '(SELECT COALESCE(AVG(r.score), 0) FROM ratings r WHERE r.material_id = m.id) DESC',
  };
  const sortKey = req.query.sort || 'recent';
  const orderBy = validSorts[sortKey] || validSorts['recent'];

  const countSql = `SELECT COUNT(DISTINCT m.id) as total FROM materials m ${whereClause}`;
  const total = db.prepare(countSql).get(...params).total;

  const sql = `
    SELECT m.*, 
           d.name as discipline_name,
           g.name as grade_name,
           mt.name as material_type_name,
           mt.icon as material_type_icon,
           (SELECT COUNT(*) FROM access_history ah WHERE ah.material_id = m.id) as view_count,
           (SELECT COALESCE(ROUND(AVG(r.score), 1), 0) FROM ratings r WHERE r.material_id = m.id) as avg_rating,
           (SELECT COUNT(*) FROM ratings r WHERE r.material_id = m.id) as rating_count
    FROM materials m
    LEFT JOIN disciplines d ON m.discipline_id = d.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `;

  const materials = db.prepare(sql).all(...params, limit, offset);

  attachTopics(materials);

  res.json({
    data: materials,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ─── GET /api/materials/recent ─── (últimos adicionados)
router.get('/recent', authenticate, listingLimit(6, 20), (req, res) => {
  const limit = res.locals.listingLimit;
  const materials = db.prepare(`
    SELECT m.*, d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon
    FROM materials m
    LEFT JOIN disciplines d ON m.discipline_id = d.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    ORDER BY m.created_at DESC
    LIMIT ?
  `).all(limit);

  attachTopics(materials);

  res.json(materials);
});

// ─── GET /api/materials/history ─── (histórico do professor)
router.get('/history', authenticate, listingLimit(6, 20), (req, res) => {
  const limit = res.locals.listingLimit;
  const materials = db.prepare(`
    SELECT m.*, d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon,
           MAX(ah.accessed_at) as last_accessed
    FROM access_history ah
    INNER JOIN materials m ON ah.material_id = m.id
    LEFT JOIN disciplines d ON m.discipline_id = d.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    WHERE ah.user_id = ?
    GROUP BY m.id
    ORDER BY last_accessed DESC
    LIMIT ?
  `).all(req.user.id, limit);

  attachTopics(materials);

  res.json(materials);
});

// ─── GET /api/materials/stats ─── (admin dashboard)
router.get('/stats', authenticate, requireAdmin, (req, res) => {
  const total = db.prepare('SELECT COUNT(*) as count FROM materials').get().count;

  const thisMonth = db.prepare(`
    SELECT COUNT(*) as count FROM materials 
    WHERE date(created_at, 'localtime') >= date('now', 'localtime', 'start of month')
  `).get().count;

  const byType = db.prepare(`
    SELECT mt.name, COUNT(m.id) as count 
    FROM material_types mt
    LEFT JOIN materials m ON m.material_type_id = mt.id
    GROUP BY mt.id
    ORDER BY count DESC
  `).all();

  const topMaterials = db.prepare(`
    SELECT 
      m.id,
      m.title,
      g.name as grade_name,
      mt.name as material_type_name,
      COUNT(ah.id) as access_count
    FROM materials m
    LEFT JOIN access_history ah ON ah.material_id = m.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    GROUP BY m.id
    ORDER BY access_count DESC, m.created_at DESC
    LIMIT 5
  `).all();

  res.json({ total, thisMonth, byType, topMaterials });
});

// GET /api/materials/dashboard-stats (home metrics)
router.get('/dashboard-stats', authenticate, (req, res) => {
  const isAdmin = req.user.role === 'admin';

  const totalMaterials = db.prepare('SELECT COUNT(*) as count FROM materials').get().count;

  const totalMaterialAccesses = isAdmin
    ? db.prepare('SELECT COUNT(*) as count FROM access_history').get().count
    : db.prepare('SELECT COUNT(*) as count FROM access_history WHERE user_id = ?').get(req.user.id).count;

  const totalFavorites = isAdmin
    ? db.prepare('SELECT COUNT(*) as count FROM favorites').get().count
    : db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?').get(req.user.id).count;

  const totalQuestionSets = isAdmin
    ? db.prepare('SELECT COUNT(*) as count FROM question_sets').get().count
    : db.prepare(`
        SELECT COUNT(*) as count
        FROM question_sets
        WHERE user_id = ? OR is_public = 1
      `).get(req.user.id).count;

  const totalQuestions = db.prepare('SELECT COUNT(*) as count FROM questions').get().count;
  const totalCoveredSkills = db.prepare(`
    SELECT COUNT(DISTINCT skill_id) as count
    FROM questions
  `).get().count;

  res.json({
    totalMaterials,
    totalMaterialAccesses,
    totalFavorites,
    totalQuestionSets,
    totalQuestions,
    totalCoveredSkills,
    scope: isAdmin ? 'global' : 'user',
  });
});

// GET /api/materials/suggestions (sugestões por disciplina mais acessada)
router.get('/suggestions', authenticate, listingLimit(6, 20), (req, res) => {
  const limit = res.locals.listingLimit;

  // Find most accessed discipline for this user
  const topDiscipline = db.prepare(`
    SELECT m.discipline_id, COUNT(*) as cnt
    FROM access_history ah
    INNER JOIN materials m ON ah.material_id = m.id
    WHERE ah.user_id = ? AND m.discipline_id IS NOT NULL
    GROUP BY m.discipline_id
    ORDER BY cnt DESC
    LIMIT 1
  `).get(req.user.id);

  let materials;
  if (topDiscipline) {
    materials = db.prepare(`
      SELECT m.*, d.name as discipline_name, g.name as grade_name,
             mt.name as material_type_name, mt.icon as material_type_icon
      FROM materials m
      LEFT JOIN disciplines d ON m.discipline_id = d.id
      LEFT JOIN grades g ON m.grade_id = g.id
      LEFT JOIN material_types mt ON m.material_type_id = mt.id
      WHERE m.discipline_id = ?
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(topDiscipline.discipline_id, limit);
  } else {
    // If no history, return recent
    materials = db.prepare(`
      SELECT m.*, d.name as discipline_name, g.name as grade_name,
             mt.name as material_type_name, mt.icon as material_type_icon
      FROM materials m
      LEFT JOIN disciplines d ON m.discipline_id = d.id
      LEFT JOIN grades g ON m.grade_id = g.id
      LEFT JOIN material_types mt ON m.material_type_id = mt.id
      ORDER BY m.created_at DESC
      LIMIT ?
    `).all(limit);
  }

  attachTopics(materials);

  res.json(materials);
});

// Read-only deletion review, intentionally before /:id; never records a material access.
router.get('/management-selection', authenticate, requireAdmin, (req, res, next) => {
  const raw = typeof req.query.ids === 'string' ? req.query.ids.split(',') : [];
  if (!raw.length || raw.length > 50 || raw.some(id => !/^[1-9]\d*$/.test(id) || !Number.isSafeInteger(Number(id)))) {
    return res.status(400).json({ error: 'Informe de 1 a 50 materiais para conferir.' });
  }
  const ids = [...new Set(raw.map(Number))];
  try {
    const result = db.transaction(() => {
      const rows = db.prepare(`SELECT * FROM materials WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      return { materials: rows.map(material => ({ id: material.id, title: material.title, version: materialDeletionVersion(db, material) })), missingIds: ids.filter(id => !rows.some(row => row.id === id)) };
    })();
    res.setHeader('Cache-Control', 'private, no-store'); res.json(result);
  } catch (error) { next(error); }
});

// ─── GET /api/materials/:id ───
router.get('/:id', authenticate, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const material = db.prepare(`
    SELECT m.*, d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon
    FROM materials m
    LEFT JOIN disciplines d ON m.discipline_id = d.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    WHERE m.id = ?
  `).get(req.params.id);

  if (!material) {
    return res.status(404).json({ error: 'Material não encontrado.' });
  }

  material.topics = db.prepare(`
    SELECT t.id, t.name FROM topics t
    INNER JOIN material_topics mt ON mt.topic_id = t.id
    WHERE mt.material_id = ?
  `).all(material.id);

  // Record access
  db.prepare(`
    INSERT INTO access_history (user_id, material_id) VALUES (?, ?)
  `).run(req.user.id, material.id);

  res.json(material);
});

// ─── GET /api/materials/:id/public ─── (no auth, for shared links)
router.get('/:id/public', (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  if (!findActiveShare(req.query.token, id)) {
    return res.status(404).json({ error: 'Link indisponível ou expirado.' });
  }
  const material = db.prepare(`
    SELECT m.id, m.title, m.description, m.file_path, m.file_format, m.external_url, m.created_at,
           d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon
    FROM materials m
    LEFT JOIN disciplines d ON m.discipline_id = d.id
    LEFT JOIN grades g ON m.grade_id = g.id
    LEFT JOIN material_types mt ON m.material_type_id = mt.id
    WHERE m.id = ?
  `).get(id);

  if (!material) {
    return res.status(404).json({ error: 'Material não encontrado.' });
  }

  res.json(material);
});

// ─── GET /api/materials/:id/download ─── (admin only)
router.get('/:id/download', authenticate, (req, res) => {
  // Bloqueia download para Professores
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem fazer download de materiais.' });
  }

  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(id);
  if (!material || !material.file_path) {
    return res.status(404).json({ error: 'Arquivo não encontrado.' });
  }

  const fileFull = existingUploadPath(material.file_path);
  if (!fileFull) {
    return res.status(404).json({ error: 'Arquivo não encontrado no servidor.' });
  }

  // Sanitize filename for download
  const ext = path.extname(material.file_path);
  const safeName = material.title.replace(/[^a-zA-Z0-9À-ú\s\-_]/g, '').trim() + ext;

  res.setHeader('Cache-Control', 'private, no-store');
  res.download(fileFull, safeName);
});

// Grava catálogo, relacionamentos, recuperação e auditoria na mesma transação.
// Arquivos antigos ficam preservados, mas deixam de ser públicos/ativos.
function retireMaterialFiles(material, reason, req) {
  const relatedRows = {};
  if (reason === 'deleted') {
    // Lista fechada de relações afetadas por CASCADE/SET NULL. Nunca aceitar nomes da requisição.
    for (const table of ['material_topics', 'collection_items', 'favorites', 'ratings', 'comments',
      'access_history', 'material_bncc_skills', 'material_bncc_review_state', 'teaching_plan_lesson_resources']) {
      relatedRows[table] = db.prepare(`SELECT * FROM ${table} WHERE material_id = ?`).all(material.id);
    }
    // Links de compartilhamento não são restaurados: a exclusão deve revogá-los.
  }
  const recovery = JSON.stringify({
    material,
    relatedRows,
    topicIds: db.prepare('SELECT topic_id FROM material_topics WHERE material_id = ?').all(material.id).map(row => row.topic_id),
    collectionIds: db.prepare('SELECT collection_id FROM collection_items WHERE material_id = ?').all(material.id).map(row => row.collection_id),
  });
  const paths = [...new Set([material.file_path, material.thumbnail_path].filter(Boolean))];
  // Também preserva os metadados de materiais sem arquivo físico.
  for (const filePath of paths.length ? paths : ['']) {
    db.prepare(`INSERT INTO material_file_retirements
      (file_path, material_id, reason, recovery_json, retired_by) VALUES (?, ?, ?, ?, ?)`)
      .run(filePath, material.id, reason, recovery, req.user.id);
  }
}

function updateMaterialLinks(materialId, topics, collectionId) {
  if (topics !== undefined) {
    const topicIds = parseTopicIds(topics);
    db.prepare('DELETE FROM material_topics WHERE material_id = ?').run(materialId);
    for (const topicId of topicIds) {
      db.prepare('INSERT INTO material_topics (material_id, topic_id) VALUES (?, ?)').run(materialId, topicId);
    }
  }
  if (collectionId !== undefined) {
    const id = validateCollectionId(collectionId);
    db.prepare('DELETE FROM collection_items WHERE material_id = ?').run(materialId);
    if (id) {
      db.prepare('INSERT INTO collection_items (collection_id, material_id) VALUES (?, ?)').run(id, materialId);
      db.prepare('UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    }
  }
}

function auditMaterial(req, action, material, metadata = {}) {
  logActivityStrict({
    user: req.user, action, module: 'materials', entityType: 'material',
    entityId: material.id, entityTitle: material.title,
    description: `${req.user.name}: ${action} — "${material.title}".`,
    metadata, isCritical: action === 'delete_material', req,
  });
}

function materialWriteFailure(req, res, next, error) {
  // Somente o upload NOVO desta requisição é descartado após um rollback.
  removeUpload(req.file?.filename);
  if (error.status) return res.status(error.status).json({ error: error.message });
  if (['SQLITE_CONSTRAINT_FOREIGNKEY', 'SQLITE_CONSTRAINT_CHECK', 'SQLITE_CONSTRAINT_NOTNULL'].includes(error.code)) {
    return res.status(400).json({ error: 'Não foi possível salvar. Verifique os vínculos e tente novamente.' });
  }
  next(error);
}

// ─── POST /api/materials ─── (admin)
router.post('/', authenticate, requireAdmin, (req, res, next) => {
  if (require('../services/featureFlags').evaluateFeatureFlag(db, 'materials.draft_publication', req.user).enabled) return res.status(409).json({ code: 'draft_required', error: 'O cadastro agora começa como rascunho. Abra Novo material para preparar e publicar.' });
  next();
}, upload.single('file'), (req, res, next) => {
  const { title, description, discipline_id, grade_id, material_type_id, file_format,
    external_url, duration, page_count, topics, collection_id } = req.body;
  const inputError = validateMaterialInput({ title, description });
  if (inputError) {
    removeUpload(req.file?.filename);
    return res.status(400).json({ error: inputError });
  }
  try {
    const created = db.transaction(() => {
      if (require('../services/featureFlags').evaluateFeatureFlag(db, 'materials.draft_publication', req.user).enabled) throw Object.assign(new Error('O cadastro agora começa como rascunho. Reabra Novo material.'), { status: 409 });
      const result = db.prepare(`INSERT INTO materials
        (title, description, discipline_id, grade_id, material_type_id, file_format, file_path,
          file_size, external_url, duration, page_count, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        title.trim(), description || null, discipline_id ? Number(discipline_id) : null,
        grade_id ? Number(grade_id) : null, material_type_id ? Number(material_type_id) : null,
        req.file ? path.extname(req.file.originalname).slice(1).toUpperCase() : file_format || null,
        req.file?.filename || null, req.file?.size ?? null, external_url || null,
        duration || null, page_count ? Number(page_count) : null, req.user.id);
      updateMaterialLinks(result.lastInsertRowid, topics, collection_id);
      const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(result.lastInsertRowid);
      auditMaterial(req, 'create_material', material, { has_file: Boolean(material.file_path) });
      notifyAllExcept(req.user.id, 'new_material', 'Novo material disponível',
        `"${material.title}" foi adicionado à biblioteca.`, { material_id: material.id });
      return material;
    }).immediate();
    res.status(201).json(created);
  } catch (error) { materialWriteFailure(req, res, next, error); }
});

// ─── PUT /api/materials/:id ─── (admin)
router.put('/:id', authenticate, requireAdmin, upload.single('file'), (req, res, next) => {
  try {
    const updated = db.transaction(() => {
      const existing = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
      if (!existing) throw Object.assign(new Error('Material não encontrado.'), { status: 404 });
      const { title, description, discipline_id, grade_id, material_type_id, file_format,
        external_url, duration, page_count, topics, collection_id } = req.body;
      const inputError = validateMaterialInput({
        title: title !== undefined ? title : existing.title,
        description: description !== undefined ? description : existing.description,
      });
      if (inputError) throw Object.assign(new Error(inputError), { status: 400 });
      if (req.file && existing.file_path) retireMaterialFiles(existing, 'replaced', req);
      db.prepare(`UPDATE materials SET title=?, description=?, discipline_id=?, grade_id=?,
        material_type_id=?, file_format=?, file_path=?, file_size=?, external_url=?, duration=?,
        page_count=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(
        title !== undefined ? title.trim() : existing.title,
        description !== undefined ? description : existing.description,
        discipline_id ? Number(discipline_id) : existing.discipline_id,
        grade_id ? Number(grade_id) : existing.grade_id,
        material_type_id ? Number(material_type_id) : existing.material_type_id,
        req.file ? path.extname(req.file.originalname).slice(1).toUpperCase() : file_format || existing.file_format,
        req.file?.filename || existing.file_path, req.file?.size ?? existing.file_size,
        external_url !== undefined ? external_url || null : existing.external_url,
        duration !== undefined ? duration || null : existing.duration,
        page_count !== undefined ? (page_count ? Number(page_count) : null) : existing.page_count,
        existing.id);
      updateMaterialLinks(existing.id, topics, collection_id);
      const material = db.prepare('SELECT * FROM materials WHERE id = ?').get(existing.id);
      auditMaterial(req, 'update_material', material, {
        previous: { title: existing.title }, current: { title: material.title },
        file_replaced: Boolean(req.file),
      });
      return material;
    }).immediate();
    res.json(updated);
  } catch (error) { materialWriteFailure(req, res, next, error); }
});

// ─── DELETE /api/materials/:id ─── (admin)
router.delete('/:id', authenticate, requireAdmin, (req, res, next) => {
  try {
    db.transaction(() => {
      const existing = db.prepare('SELECT * FROM materials WHERE id = ?').get(req.params.id);
      checkDeletionVersion(db, existing, req.body?.expectedVersion);
      if (!existing) throw Object.assign(new Error('Material não encontrado.'), { status: 404 });
      retireMaterialFiles(existing, 'deleted', req);
      db.prepare('DELETE FROM materials WHERE id = ?').run(existing.id);
      auditMaterial(req, 'delete_material', existing, { recoverable: true });
    }).immediate();
    res.json({ message: 'Material excluído com sucesso.' });
  } catch (error) { materialWriteFailure(req, res, next, error); }
});

// ─── POST /api/materials/bulk-delete ─── (admin)
router.post('/bulk-delete', authenticate, requireAdmin, (req, res, next) => {
  const { ids } = req.body;
  if (!Array.isArray(ids) || !ids.length || ids.length > 50
      || ids.some(id => !parsePositiveInt(id))) {
    return res.status(400).json({ error: 'Informe de 1 a 50 IDs válidos.' });
  }
  const validIds = [...new Set(ids.map(Number))];
  const versions = req.body.expectedVersions;
  if (versions !== undefined && (!versions || Array.isArray(versions) || typeof versions !== 'object'
    || Object.keys(versions).length !== validIds.length
    || Object.keys(versions).some(id => !validIds.includes(Number(id)) || String(Number(id)) !== id)
    || validIds.some(id => typeof versions[id] !== 'string' || !/^[a-f0-9]{64}$/.test(versions[id])))) {
    return res.status(400).json({ error: 'Conferência do lote inválida.' });
  }
  try {
    const deleted = db.transaction(() => {
      const materials = db.prepare(`SELECT * FROM materials WHERE id IN (${validIds.map(() => '?').join(',')})`)
        .all(...validIds);
      if (versions !== undefined) for (const id of validIds) checkDeletionVersion(db, materials.find(material => material.id === id), versions[id]);
      for (const material of materials) {
        retireMaterialFiles(material, 'deleted', req);
        db.prepare('DELETE FROM materials WHERE id = ?').run(material.id);
      }
      logActivityStrict({
        user: req.user, action: 'bulk_delete_materials', module: 'materials', entityType: 'material',
        entityTitle: `${materials.length} materiais`,
        description: `${req.user.name} excluiu ${materials.length} materiais em massa.`,
        metadata: { count: materials.length, ids: materials.map(m => m.id), recoverable: true },
        isCritical: true, req,
      });
      return materials.length;
    }).immediate();
    res.json({ message: `${deleted} material(is) excluído(s).`, deleted });
  } catch (error) { materialWriteFailure(req, res, next, error); }
});

module.exports = router;
