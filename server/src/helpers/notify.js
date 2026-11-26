const db = require('../database');

/**
 * Create a notification for a specific user
 */
function notify(userId, type, title, message, data = null) {
  db.prepare(
    'INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, type, title, message, data ? JSON.stringify(data) : null);
}

/**
 * Notify all users except the one who triggered the action
 */
function notifyAllExcept(excludeUserId, type, title, message, data = null) {
  const users = db.prepare('SELECT id FROM users WHERE id != ?').all(excludeUserId);
  const stmt = db.prepare(
    'INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)'
  );
  const dataStr = data ? JSON.stringify(data) : null;
  const insertMany = db.transaction((users) => {
    for (const u of users) {
      stmt.run(u.id, type, title, message, dataStr);
    }
  });
  insertMany(users);
}

/**
 * Keep a single unread notification for the same user, type and context.
 * A new one can be created after the pending notification is marked as read.
 */
function notifyOnce(userId, type, title, message, data = null) {
  const dataStr = data ? JSON.stringify(data) : null;
  const existing = db.prepare(`
    SELECT id
    FROM notifications
    WHERE user_id = ?
      AND type = ?
      AND read = 0
      AND COALESCE(data, '') = COALESCE(?, '')
    ORDER BY id DESC
    LIMIT 1
  `).get(userId, type, dataStr);

  if (existing) return existing.id;

  return db.prepare(
    'INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)'
  ).run(userId, type, title, message, dataStr).lastInsertRowid;
}

/**
 * Notify administrators about an event that needs their attention.
 */
function notifyAdmins(excludeUserId, type, title, message, data = null) {
  const conditions = ["role = 'admin'"];
  const params = [];

  if (excludeUserId) {
    conditions.push('id != ?');
    params.push(excludeUserId);
  }

  const admins = db.prepare(
    `SELECT id FROM users WHERE ${conditions.join(' AND ')}`
  ).all(...params);
  const stmt = db.prepare(
    'INSERT INTO notifications (user_id, type, title, message, data) VALUES (?, ?, ?, ?, ?)'
  );
  const dataStr = data ? JSON.stringify(data) : null;

  const insertMany = db.transaction((recipients) => {
    for (const admin of recipients) {
      stmt.run(admin.id, type, title, message, dataStr);
    }
  });

  insertMany(admins);
}

function notifyAdminsOnce(excludeUserId, type, title, message, data = null) {
  const conditions = ["role = 'admin'"];
  const params = [];

  if (excludeUserId) {
    conditions.push('id != ?');
    params.push(excludeUserId);
  }

  const admins = db.prepare(
    `SELECT id FROM users WHERE ${conditions.join(' AND ')}`
  ).all(...params);

  for (const admin of admins) {
    notifyOnce(admin.id, type, title, message, data);
  }
}

module.exports = { notify, notifyOnce, notifyAllExcept, notifyAdmins, notifyAdminsOnce };
