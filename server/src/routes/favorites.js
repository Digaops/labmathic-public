const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { logActivity } = require('../helpers/activity');

router.use(authenticate);

// Get user's favorites
router.get('/', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 20));
  const offset = (page - 1) * limit;

  const total = db.prepare('SELECT COUNT(*) as count FROM favorites WHERE user_id = ?').get(req.user.id).count;

  const favorites = db.prepare(`
    SELECT m.*, d.name as discipline_name, g.name as grade_name,
           mt.name as material_type_name, mt.icon as material_type_icon,
           f.created_at as favorited_at,
           (SELECT COUNT(*) FROM access_history ah WHERE ah.material_id = m.id) as view_count,
           (SELECT COALESCE(ROUND(AVG(r.score), 1), 0) FROM ratings r WHERE r.material_id = m.id) as avg_rating
    FROM favorites f
    JOIN materials m ON m.id = f.material_id
    LEFT JOIN disciplines d ON d.id = m.discipline_id
    LEFT JOIN grades g ON g.id = m.grade_id
    LEFT JOIN material_types mt ON mt.id = m.material_type_id
    WHERE f.user_id = ?
    ORDER BY f.created_at DESC
    LIMIT ? OFFSET ?
  `).all(req.user.id, limit, offset);

  // Add topics
  const topicStmt = db.prepare(`
    SELECT t.id, t.name FROM topics t
    JOIN material_topics mt ON mt.topic_id = t.id
    WHERE mt.material_id = ?
  `);
  for (const fav of favorites) {
    fav.topics = topicStmt.all(fav.id);
  }

  res.json({
    data: favorites,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
  });
});

// Check if material is favorited
router.get('/check/:materialId', (req, res) => {
  const materialId = Number(req.params.materialId);
  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }
  const fav = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND material_id = ?')
    .get(req.user.id, materialId);
  res.json({ favorited: !!fav });
});

// Toggle favorite
router.post('/toggle', (req, res) => {
  const { material_id } = req.body;
  const materialId = Number(material_id);
  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID do material inválido.' });
  }

  const material = db.prepare('SELECT id, title FROM materials WHERE id = ?').get(materialId);
  if (!material) {
    return res.status(404).json({ error: 'Material não encontrado.' });
  }

  const existing = db.prepare('SELECT id FROM favorites WHERE user_id = ? AND material_id = ?')
    .get(req.user.id, materialId);

  if (existing) {
    db.prepare('DELETE FROM favorites WHERE id = ?').run(existing.id);
    logActivity({
      user: req.user,
      action: 'unfavorite',
      module: 'favorites',
      entityType: 'material',
      entityId: materialId,
      entityTitle: material.title,
      description: `${req.user.name} removeu "${material.title}" dos favoritos.`,
      metadata: { title: material.title },
      req,
    });
    res.json({ favorited: false });
  } else {
    db.prepare('INSERT INTO favorites (user_id, material_id) VALUES (?, ?)').run(req.user.id, materialId);
    logActivity({
      user: req.user,
      action: 'favorite',
      module: 'favorites',
      entityType: 'material',
      entityId: materialId,
      entityTitle: material.title,
      description: `${req.user.name} favoritou "${material.title}".`,
      metadata: { title: material.title },
      req,
    });
    res.json({ favorited: true });
  }
});

module.exports = router;
