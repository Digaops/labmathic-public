const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { notify } = require('../helpers/notify');
const { logActivity } = require('../helpers/activity');

router.use(authenticate);

// Get comments for a material
router.get('/material/:materialId', (req, res) => {
  const materialId = Number(req.params.materialId);
  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const comments = db.prepare(`
    SELECT c.*, u.name as user_name, u.role as user_role
    FROM comments c
    JOIN users u ON u.id = c.user_id
    WHERE c.material_id = ?
    ORDER BY c.created_at DESC
  `).all(materialId);

  res.json(comments);
});

// Add comment
router.post('/', (req, res) => {
  const { material_id, text } = req.body;
  const materialId = Number(material_id);

  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID do material inválido.' });
  }
  if (!text || !text.trim() || text.trim().length < 2) {
    return res.status(400).json({ error: 'Comentário deve ter pelo menos 2 caracteres.' });
  }
  if (text.trim().length > 1000) {
    return res.status(400).json({ error: 'Comentário deve ter no máximo 1000 caracteres.' });
  }

  const result = db.prepare(
    'INSERT INTO comments (user_id, material_id, text) VALUES (?, ?, ?)'
  ).run(req.user.id, materialId, text.trim());

  const comment = db.prepare(`
    SELECT c.*, u.name as user_name, u.role as user_role
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(result.lastInsertRowid);

  // Notify material author about the new comment
  const material = db.prepare('SELECT title, created_by FROM materials WHERE id = ?').get(materialId);
  if (material && material.created_by !== req.user.id) {
    notify(material.created_by, 'new_comment', 'Novo comentário',
      `${comment.user_name} comentou em "${material.title}".`,
      { material_id: materialId }
    );
  }

  logActivity(req.user.id, 'add_comment', 'material', materialId, { text: text.trim().substring(0, 100) });

  res.status(201).json(comment);
});

// Update comment (own only)
router.put('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!comment) return res.status(404).json({ error: 'Comentário não encontrado.' });
  if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Sem permissão.' });
  }

  const { text } = req.body;
  if (!text || !text.trim() || text.trim().length < 2) {
    return res.status(400).json({ error: 'Comentário deve ter pelo menos 2 caracteres.' });
  }
  if (text.trim().length > 1000) {
    return res.status(400).json({ error: 'Comentário deve ter no máximo 1000 caracteres.' });
  }

  db.prepare('UPDATE comments SET text = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
    .run(text.trim(), id);

  const updated = db.prepare(`
    SELECT c.*, u.name as user_name, u.role as user_role
    FROM comments c JOIN users u ON u.id = c.user_id
    WHERE c.id = ?
  `).get(id);

  res.json(updated);
});

// Delete comment (own or admin)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });

  const comment = db.prepare('SELECT * FROM comments WHERE id = ?').get(id);
  if (!comment) return res.status(404).json({ error: 'Comentário não encontrado.' });
  if (comment.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Sem permissão.' });
  }

  db.prepare('DELETE FROM comments WHERE id = ?').run(id);
  res.json({ message: 'Comentário excluído.' });
});

module.exports = router;
