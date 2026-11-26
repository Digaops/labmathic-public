const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { notify } = require('../helpers/notify');

router.use(authenticate);

// Get ratings for a material
router.get('/material/:materialId', (req, res) => {
  const materialId = Number(req.params.materialId);
  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const stats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(AVG(score), 0) as average
    FROM ratings WHERE material_id = ?
  `).get(materialId);

  const userRating = db.prepare(
    'SELECT score FROM ratings WHERE user_id = ? AND material_id = ?'
  ).get(req.user.id, materialId);

  res.json({
    average: Math.round(stats.average * 10) / 10,
    count: stats.count,
    userScore: userRating?.score || null,
  });
});

// Rate a material (create or update)
router.post('/', (req, res) => {
  const { material_id, score } = req.body;
  const materialId = Number(material_id);
  const scoreNum = Number(score);

  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID do material inválido.' });
  }
  if (!Number.isInteger(scoreNum) || scoreNum < 1 || scoreNum > 5) {
    return res.status(400).json({ error: 'Nota deve ser entre 1 e 5.' });
  }

  const existing = db.prepare(
    'SELECT id FROM ratings WHERE user_id = ? AND material_id = ?'
  ).get(req.user.id, materialId);

  if (existing) {
    db.prepare('UPDATE ratings SET score = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(scoreNum, existing.id);
  } else {
    db.prepare('INSERT INTO ratings (user_id, material_id, score) VALUES (?, ?, ?)')
      .run(req.user.id, materialId, scoreNum);

    // Notify material author about the new rating (only on first rating, not updates)
    const material = db.prepare('SELECT title, created_by FROM materials WHERE id = ?').get(materialId);
    if (material && material.created_by !== req.user.id) {
      const userName = db.prepare('SELECT name FROM users WHERE id = ?').get(req.user.id)?.name || 'Alguém';
      notify(material.created_by, 'new_rating', 'Nova avaliação',
        `${userName} avaliou "${material.title}" com ${scoreNum} estrela(s).`,
        { material_id: materialId }
      );
    }
  }

  const stats = db.prepare(`
    SELECT COUNT(*) as count, COALESCE(AVG(score), 0) as average
    FROM ratings WHERE material_id = ?
  `).get(materialId);

  res.json({
    average: Math.round(stats.average * 10) / 10,
    count: stats.count,
    userScore: scoreNum,
  });
});

module.exports = router;
