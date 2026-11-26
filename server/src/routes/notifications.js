const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const listingLimit = require('../middleware/listingLimit');

router.use(authenticate);

// Get user notifications
router.get('/', listingLimit(20, 50), (req, res) => {
  const limit = res.locals.listingLimit;
  const notifications = db.prepare(`
    SELECT * FROM notifications
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT ?
  `).all(req.user.id, limit);

  const unread = db.prepare(
    'SELECT COUNT(*) as count FROM notifications WHERE user_id = ? AND read = 0'
  ).get(req.user.id);

  const unreadSupport = db.prepare(`
    SELECT COUNT(*) AS count
    FROM notifications
    WHERE user_id = ?
      AND read = 0
      AND type IN ('support_message', 'support_reply')
  `).get(req.user.id);

  res.json({
    notifications,
    unreadCount: unread.count,
    supportUnreadCount: unreadSupport.count,
  });
});

// Mark one as read
router.put('/:id/read', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });

  const notif = db.prepare('SELECT * FROM notifications WHERE id = ? AND user_id = ?').get(id, req.user.id);
  if (!notif) return res.status(404).json({ error: 'Notificação não encontrada.' });

  db.prepare('UPDATE notifications SET read = 1 WHERE id = ?').run(id);
  res.json({ message: 'Marcada como lida.' });
});

// Mark all as read
router.put('/read-all', (req, res) => {
  db.prepare('UPDATE notifications SET read = 1 WHERE user_id = ? AND read = 0').run(req.user.id);
  res.json({ message: 'Todas marcadas como lidas.' });
});

// Delete notification
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'ID inválido.' });

  db.prepare('DELETE FROM notifications WHERE id = ? AND user_id = ?').run(id, req.user.id);
  res.json({ message: 'Notificação excluída.' });
});

module.exports = router;
