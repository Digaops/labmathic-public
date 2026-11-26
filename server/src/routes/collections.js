const express = require('express');
const path = require('path');
const upload = require('../middleware/upload').images;
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivity, logActivityStrict } = require('../helpers/activity');
const { discardNewUpload, preservePreviousImage } = require('../services/imageLifecycle');

const router = express.Router();

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

function parseBoolean(value) {
  return value === true || value === 'true' || value === '1' || value === 1;
}

function validateImageUpload(file) {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) || !file.mimetype?.startsWith('image/')) {
    discardNewUpload(file.filename);
    return 'A imagem do laboratório deve ser um arquivo de imagem válido.';
  }

  return null;
}

router.use(authenticate);

router.get('/', (req, res) => {
  const collections = db.prepare(`
    SELECT c.*,
           (SELECT COUNT(*) FROM collection_items ci WHERE ci.collection_id = c.id) as item_count
    FROM collections c
    WHERE c.user_id = ? OR c.is_public = 1
    ORDER BY c.updated_at DESC
  `).all(req.user.id);

  res.json(collections);
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return res.status(404).json({ error: 'Coleção não encontrada.' });
  if (collection.user_id !== req.user.id && !collection.is_public) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const materials = db.prepare(`
    SELECT m.*, d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon,
           ci.added_at
    FROM collection_items ci
    JOIN materials m ON m.id = ci.material_id
    LEFT JOIN disciplines d ON d.id = m.discipline_id
    LEFT JOIN grades g ON g.id = m.grade_id
    LEFT JOIN material_types mt ON mt.id = m.material_type_id
    WHERE ci.collection_id = ?
    ORDER BY ci.added_at DESC
  `).all(id);

  const topicStmt = db.prepare(`
    SELECT t.id, t.name FROM topics t
    JOIN material_topics mtt ON mtt.topic_id = t.id
    WHERE mtt.material_id = ?
  `);

  for (const mat of materials) {
    mat.topics = topicStmt.all(mat.id);
  }

  res.json({ ...collection, materials });
});

router.post('/', requireAdmin, upload.single('image'), (req, res, next) => {
  const { name, description, is_public } = req.body;
  const imagePath = req.file ? req.file.filename : null;
  const imageError = validateImageUpload(req.file);

  if (imageError) return res.status(400).json({ error: imageError });
  if (!name || !String(name).trim()) {
    discardNewUpload(imagePath);
    return res.status(400).json({ error: 'Nome é obrigatório.' });
  }

  try {
    const collection = db.transaction(() => {
      const result = db.prepare(
        'INSERT INTO collections (user_id, name, description, is_public, image_path) VALUES (?, ?, ?, ?, ?)'
      ).run(
        req.user.id,
        String(name).trim(),
        description?.trim() || null,
        parseBoolean(is_public) ? 1 : 0,
        imagePath
      );

      const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(result.lastInsertRowid);
      logActivityStrict({
        user: req.user,
        action: 'create_collection',
        module: 'collections',
        entityType: 'collection',
        entityId: collection.id,
        entityTitle: collection.name,
        description: `${req.user.name} criou o laboratório "${collection.name}".`,
        metadata: {
          name: collection.name,
          is_public: Boolean(collection.is_public),
          has_image: Boolean(collection.image_path),
        },
        req,
      });
      return collection;
    })();
    res.status(201).json(collection);
  } catch (error) {
    discardNewUpload(req.file?.filename);
    next(error);
  }
});

router.put('/:id', requireAdmin, upload.single('image'), (req, res) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) {
      discardNewUpload(req.file?.filename);
      return res.status(400).json({ error: 'ID inválido.' });
    }

    const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
    if (!collection) {
      discardNewUpload(req.file?.filename);
      return res.status(404).json({ error: 'Laboratório não encontrado.' });
    }

    const { name, description, is_public } = req.body;
    const imageError = validateImageUpload(req.file);

    if (imageError) return res.status(400).json({ error: imageError });
    if (!name || !String(name).trim()) {
      discardNewUpload(req.file?.filename);
      return res.status(400).json({ error: 'Nome é obrigatório.' });
    }

    const imagePath = req.file ? req.file.filename : collection.image_path;

    const updated = db.transaction(() => {
      preservePreviousImage(req, 'collection', collection, imagePath, 'replaced');
      db.prepare(`
        UPDATE collections
        SET name = ?, description = ?, is_public = ?, image_path = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(
        String(name).trim(),
        description?.trim() || null,
        parseBoolean(is_public) ? 1 : 0,
        imagePath,
        id
      );

      const updated = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
      logActivityStrict({
        user: req.user,
        action: 'update_collection',
        module: 'collections',
        entityType: 'collection',
        entityId: id,
        entityTitle: updated.name,
        description: `${req.user.name} editou o laboratório "${updated.name}".`,
        metadata: {
          previous: {
            name: collection.name,
            description: collection.description,
            is_public: Boolean(collection.is_public),
            has_image: Boolean(collection.image_path),
          },
          current: {
            name: updated.name,
            description: updated.description,
            is_public: Boolean(updated.is_public),
            has_image: Boolean(updated.image_path),
          },
          image_changed: Boolean(req.file),
        },
        req,
      });
      return updated;
    })();
    res.json(updated);
  } catch (err) {
    discardNewUpload(req.file?.filename);
    console.error('Erro ao atualizar laboratório:', err);
    res.status(500).json({ error: 'Erro interno ao atualizar laboratório.' });
  }
});

router.delete('/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return res.status(404).json({ error: 'Coleção não encontrada.' });

  db.transaction(() => {
    preservePreviousImage(req, 'collection', collection, null, 'deleted');
    db.prepare('DELETE FROM collections WHERE id = ?').run(id);
    logActivityStrict({
      user: req.user,
      action: 'delete_collection',
      module: 'collections',
      entityType: 'collection',
      entityId: id,
      entityTitle: collection.name,
      description: `${req.user.name} excluiu o laboratório "${collection.name}".`,
      metadata: { name: collection.name, was_public: Boolean(collection.is_public) },
      isCritical: true,
      req,
    });
  })();
  res.json({ message: 'Coleção excluída.' });
});

router.post('/:id/items', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.body.material_id);

  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'ID da coleção inválido.' });
  }
  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID do material inválido.' });
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return res.status(404).json({ error: 'Coleção não encontrada.' });

  const material = db.prepare('SELECT id, title FROM materials WHERE id = ?').get(materialId);
  if (!material) return res.status(404).json({ error: 'Material não encontrado.' });

  try {
    db.prepare('INSERT INTO collection_items (collection_id, material_id) VALUES (?, ?)').run(id, materialId);
    db.prepare('UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
    logActivity({
      user: req.user,
      action: 'add_collection_item',
      module: 'collections',
      entityType: 'collection',
      entityId: id,
      entityTitle: collection.name,
      description: `${req.user.name} vinculou "${material.title}" ao laboratório "${collection.name}".`,
      metadata: {
        collection_id: id,
        collection_name: collection.name,
        material_id: materialId,
        material_title: material.title,
      },
      req,
    });
    res.status(201).json({ message: 'Material adicionado a colecao.' });
  } catch (err) {
    if (err.message.includes('UNIQUE')) {
      return res.status(409).json({ error: 'Material já está na coleção.' });
    }
    throw err;
  }
});

router.delete('/:id/items/:materialId', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const materialId = Number(req.params.materialId);

  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const collection = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  if (!collection) return res.status(404).json({ error: 'Coleção não encontrada.' });

  const material = db.prepare('SELECT id, title FROM materials WHERE id = ?').get(materialId);

  db.prepare('DELETE FROM collection_items WHERE collection_id = ? AND material_id = ?').run(id, materialId);
  db.prepare('UPDATE collections SET updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id);
  logActivity({
    user: req.user,
    action: 'remove_collection_item',
    module: 'collections',
    entityType: 'collection',
    entityId: id,
    entityTitle: collection.name,
    description: `${req.user.name} removeu "${material?.title || 'material'}" do laboratório "${collection.name}".`,
    metadata: {
      collection_id: id,
      collection_name: collection.name,
      material_id: materialId,
      material_title: material?.title || null,
    },
    req,
  });
  res.json({ message: 'Material removido da colecao.' });
});

module.exports = router;
