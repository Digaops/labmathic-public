const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { logActivityStrict } = require('../helpers/activity');

router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

// Create share link (admin only)
router.post('/', authenticate, (req, res) => {
  // Bloqueia compartilhamento para Professores
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Apenas administradores podem compartilhar materiais.' });
  }

  const { material_id, expires_hours } = req.body;
  const materialId = Number(material_id);

  if (!Number.isInteger(materialId) || materialId < 1) {
    return res.status(400).json({ error: 'ID do material inválido.' });
  }

  const material = db.prepare('SELECT id FROM materials WHERE id = ?').get(materialId);
  if (!material) return res.status(404).json({ error: 'Material não encontrado.' });

  const hours = expires_hours === undefined ? 72 : Number(expires_hours);
  if (!Number.isFinite(hours) || hours < 1 || hours > 168) {
    return res.status(400).json({ error: 'O compartilhamento deve durar entre 1 e 168 horas.' });
  }
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();

  db.transaction(() => {
    db.prepare(
      'INSERT INTO share_links (material_id, created_by, token, expires_at) VALUES (?, ?, ?, ?)'
    ).run(materialId, req.user.id, token, expiresAt);
    logActivityStrict({ user: req.user, action: 'create_share', module: 'materials', entityType: 'material',
      entityId: materialId, description: 'Compartilhamento temporário criado.', metadata: { expiresAt }, req });
  }).immediate();

  res.status(201).json({ token, expires_at: expiresAt });
});

// Inventário restrito: nenhum link/token é exposto a professores ou anônimos.
router.get('/material/:id', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  const materialId = Number(req.params.id);
  const before = req.query.before === undefined ? Number.MAX_SAFE_INTEGER : Number(req.query.before);
  if (!Number.isSafeInteger(materialId) || materialId < 1 || !Number.isSafeInteger(before) || before < 1) {
    return res.status(400).json({ error: 'Consulta inválida.' });
  }
  if (!db.prepare('SELECT id FROM materials WHERE id = ?').get(materialId)) return res.sendStatus(404);
  const rows = db.prepare(`SELECT id, token, expires_at, created_at FROM share_links
    WHERE material_id = ? AND id < ? AND julianday(expires_at) > julianday('now')
    ORDER BY id DESC LIMIT 21`).all(materialId, before);
  const links = rows.slice(0, 20);
  res.json({ links, nextCursor: rows.length > 20 ? links[links.length - 1].id : null });
});

// Resolve share link (no auth needed)
router.get('/:token', (req, res) => {
  const { token } = req.params;
  if (!/^[a-f0-9]{64}$/.test(token)) {
    return res.status(400).json({ error: 'Link inválido.' });
  }

  const link = db.prepare('SELECT * FROM share_links WHERE token = ?').get(token);
  if (!link) return res.status(404).json({ error: 'Link não encontrado.' });
  if (!Number.isFinite(Date.parse(link.expires_at)) || Date.parse(link.expires_at) <= Date.now()) {
    return res.status(410).json({ error: 'Link expirado.' });
  }

  res.json({ material_id: link.material_id });
});

router.delete('/:token', authenticate, (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  const link = db.prepare('SELECT material_id FROM share_links WHERE token = ?').get(req.params.token);
  if (!link) return res.sendStatus(404);
  db.transaction(() => {
    db.prepare('DELETE FROM share_links WHERE token = ?').run(req.params.token);
    logActivityStrict({ user: req.user, action: 'revoke_share', module: 'materials', entityType: 'material',
      entityId: link.material_id, description: 'Compartilhamento revogado.', req });
  }).immediate();
  res.sendStatus(204);
});

module.exports = router;
