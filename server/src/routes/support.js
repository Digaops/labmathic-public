const express = require('express');
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { notifyOnce, notifyAdminsOnce } = require('../helpers/notify');
const { logActivity } = require('../helpers/activity');

const router = express.Router();

router.use(authenticate);

const SUBJECT_LIST = [
  'Sugestão',
  'Dúvida sobre o sistema',
  'Solicitação de conteúdo',
  'Problema técnico',
  'Outro assunto',
];
const SUBJECTS = new Set(SUBJECT_LIST);

function normalizeSubject(value) {
  return SUBJECTS.has(value) ? value : 'Outro assunto';
}

function normalizeMessage(value) {
  return String(value || '').trim();
}

function validateMessage(body) {
  if (!body) return 'Escreva uma mensagem antes de enviar.';
  if (body.length > 4000) return 'A mensagem deve ter no máximo 4.000 caracteres.';
  return null;
}

function markSupportNotificationRead(userId, type, threadId) {
  return db.prepare(`
    UPDATE notifications
    SET read = 1
    WHERE user_id = ?
      AND type = ?
      AND read = 0
      AND data = ?
  `).run(userId, type, JSON.stringify({ support_thread_id: Number(threadId) }));
}

function requireProfessor(req, res, next) {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'Esta operação é exclusiva para professores.' });
  }
  next();
}

function getThreadSummary(threadId) {
  return db.prepare(`
    SELECT
      st.*,
      u.name AS professor_name,
      u.email AS professor_email,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.thread_id = st.id
          AND sm.read_at IS NULL
          AND sender.role = 'professor'
      ) AS admin_unread_count,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.thread_id = st.id
          AND sm.read_at IS NULL
          AND sender.role = 'admin'
      ) AS professor_unread_count
    FROM support_threads st
    JOIN users u ON u.id = st.professor_id
    WHERE st.id = ?
  `).get(threadId);
}

function getMessages(threadId) {
  return db.prepare(`
    SELECT
      sm.id,
      sm.thread_id,
      sm.sender_id,
      sm.body,
      sm.read_at,
      sm.created_at,
      u.name AS sender_name,
      u.role AS sender_role
    FROM support_messages sm
    JOIN users u ON u.id = sm.sender_id
    WHERE sm.thread_id = ?
    ORDER BY sm.created_at ASC, sm.id ASC
  `).all(threadId);
}

function getProfessorThreads(professorId) {
  return db.prepare(`
    SELECT
      st.*,
      (
        SELECT sm.body
        FROM support_messages sm
        WHERE sm.thread_id = st.id
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.thread_id = st.id
          AND sm.read_at IS NULL
          AND sender.role = 'admin'
      ) AS unread_count,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        WHERE sm.thread_id = st.id
      ) AS message_count
    FROM support_threads st
    WHERE st.professor_id = ?
    ORDER BY st.last_message_at DESC, st.id DESC
  `).all(professorId);
}

function getProfessorThread(threadId, professorId) {
  const ownedThread = db.prepare(`
    SELECT id
    FROM support_threads
    WHERE id = ? AND professor_id = ?
  `).get(threadId, professorId);

  return ownedThread ? getThreadSummary(ownedThread.id) : null;
}

router.get('/threads', requireProfessor, (req, res) => {
  res.json({ threads: getProfessorThreads(req.user.id), subjects: SUBJECT_LIST });
});

router.get('/threads/:id', requireProfessor, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Conversa inválida.' });
  }

  const thread = getProfessorThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Conversa não encontrada.' });

  res.json({ thread, messages: getMessages(id) });
});

router.get('/thread', requireProfessor, (req, res) => {
  const thread = db.prepare(
    'SELECT id FROM support_threads WHERE professor_id = ? ORDER BY last_message_at DESC, id DESC LIMIT 1'
  ).get(req.user.id);

  if (!thread) {
    return res.json({ thread: null, messages: [] });
  }

  res.json({
    thread: getThreadSummary(thread.id),
    messages: getMessages(thread.id),
  });
});

router.post('/thread/messages', requireProfessor, (req, res) => {
  const body = normalizeMessage(req.body.body);
  const error = validateMessage(body);
  if (error) return res.status(400).json({ error });

  const subject = normalizeSubject(req.body.subject);

  const createMessage = db.transaction(() => {
    let thread = db.prepare(`
      SELECT *
      FROM support_threads
      WHERE professor_id = ? AND subject = ?
    `).get(req.user.id, subject);

    if (!thread) {
      const result = db.prepare(`
        INSERT INTO support_threads (professor_id, subject)
        VALUES (?, ?)
      `).run(req.user.id, subject);
      thread = db.prepare('SELECT * FROM support_threads WHERE id = ?').get(result.lastInsertRowid);
    } else {
      db.prepare(`
        UPDATE support_threads
        SET status = 'open', updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(thread.id);
    }

    const messageResult = db.prepare(`
      INSERT INTO support_messages (thread_id, sender_id, body)
      VALUES (?, ?, ?)
    `).run(thread.id, req.user.id, body);

    db.prepare(`
      UPDATE support_threads
      SET last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(thread.id);

    return {
      threadId: thread.id,
      messageId: messageResult.lastInsertRowid,
    };
  });

  const created = createMessage();

  notifyAdminsOnce(
    req.user.id,
    'support_message',
    'Nova mensagem no Fale Conosco',
    `${req.user.name} enviou uma mensagem sobre ${subject.toLowerCase()}.`,
    { support_thread_id: created.threadId }
  );

  logActivity({
    user: req.user,
    action: 'send_support_message',
    module: 'support',
    entityType: 'support_thread',
    entityId: created.threadId,
    entityTitle: subject,
    description: `${req.user.name} iniciou ou atualizou uma conversa com a administração.`,
    metadata: { subject, message_length: body.length },
    req,
  });

  res.status(201).json({
    thread: getThreadSummary(created.threadId),
    messages: getMessages(created.threadId),
  });
});

router.put('/thread/read', requireProfessor, (req, res) => {
  const thread = db.prepare(
    'SELECT id FROM support_threads WHERE professor_id = ? ORDER BY last_message_at DESC, id DESC LIMIT 1'
  ).get(req.user.id);

  if (!thread) return res.json({ updated: 0 });

  const result = db.prepare(`
    UPDATE support_messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE thread_id = ?
      AND read_at IS NULL
      AND sender_id IN (SELECT id FROM users WHERE role = 'admin')
  `).run(thread.id);

  markSupportNotificationRead(req.user.id, 'support_reply', thread.id);

  res.json({ updated: result.changes });
});

router.put('/threads/:id/read', requireProfessor, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Conversa inválida.' });
  }

  const thread = getProfessorThread(id, req.user.id);
  if (!thread) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const result = db.prepare(`
    UPDATE support_messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE thread_id = ?
      AND read_at IS NULL
      AND sender_id IN (SELECT id FROM users WHERE role = 'admin')
  `).run(id);

  markSupportNotificationRead(req.user.id, 'support_reply', id);
  res.json({ updated: result.changes });
});

router.get('/admin/threads', requireAdmin, (req, res) => {
  const conditions = [];
  const params = [];

  if (req.query.search) {
    conditions.push('(u.name LIKE ? OR u.email LIKE ? OR st.subject LIKE ?)');
    const term = `%${String(req.query.search).trim()}%`;
    params.push(term, term, term);
  }

  if (req.query.filter === 'unread') {
    conditions.push(`EXISTS (
      SELECT 1
      FROM support_messages unread_message
      JOIN users unread_sender ON unread_sender.id = unread_message.sender_id
      WHERE unread_message.thread_id = st.id
        AND unread_message.read_at IS NULL
        AND unread_sender.role = 'professor'
    )`);
  }

  if (req.query.subject && SUBJECTS.has(req.query.subject)) {
    conditions.push('st.subject = ?');
    params.push(req.query.subject);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const threads = db.prepare(`
    SELECT
      st.*,
      u.name AS professor_name,
      u.email AS professor_email,
      (
        SELECT sm.body
        FROM support_messages sm
        WHERE sm.thread_id = st.id
        ORDER BY sm.created_at DESC, sm.id DESC
        LIMIT 1
      ) AS last_message,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.thread_id = st.id
          AND sm.read_at IS NULL
          AND sender.role = 'professor'
      ) AS unread_count,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        WHERE sm.thread_id = st.id
      ) AS message_count
    FROM support_threads st
    JOIN users u ON u.id = st.professor_id
    ${whereClause}
    ORDER BY st.last_message_at DESC, st.id DESC
  `).all(...params);

  const totals = db.prepare(`
    SELECT
      COUNT(*) AS total_threads,
      SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open_threads,
      (
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.read_at IS NULL AND sender.role = 'professor'
      ) AS unread_messages
    FROM support_threads
  `).get();

  const bySubject = db.prepare(`
    SELECT
      st.subject,
      COUNT(*) AS total_threads,
      SUM(CASE WHEN st.status = 'open' THEN 1 ELSE 0 END) AS open_threads,
      COALESCE(SUM((
        SELECT COUNT(*)
        FROM support_messages sm
        JOIN users sender ON sender.id = sm.sender_id
        WHERE sm.thread_id = st.id
          AND sm.read_at IS NULL
          AND sender.role = 'professor'
      )), 0) AS unread_messages
    FROM support_threads st
    GROUP BY st.subject
    ORDER BY total_threads DESC, st.subject ASC
  `).all();

  res.json({
    threads,
    subjects: SUBJECT_LIST,
    totals: { ...totals, by_subject: bySubject },
  });
});

router.get('/admin/threads/:id', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Conversa inválida.' });
  }

  const thread = getThreadSummary(id);
  if (!thread) return res.status(404).json({ error: 'Conversa não encontrada.' });

  res.json({ thread, messages: getMessages(id) });
});

router.put('/admin/threads/:id/read', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Conversa inválida.' });
  }

  const exists = db.prepare('SELECT id FROM support_threads WHERE id = ?').get(id);
  if (!exists) return res.status(404).json({ error: 'Conversa não encontrada.' });

  const result = db.prepare(`
    UPDATE support_messages
    SET read_at = CURRENT_TIMESTAMP
    WHERE thread_id = ?
      AND read_at IS NULL
      AND sender_id IN (SELECT id FROM users WHERE role = 'professor')
  `).run(id);

  markSupportNotificationRead(req.user.id, 'support_message', id);

  res.json({ updated: result.changes });
});

router.post('/admin/threads/:id/messages', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) {
    return res.status(400).json({ error: 'Conversa inválida.' });
  }

  const body = normalizeMessage(req.body.body);
  const error = validateMessage(body);
  if (error) return res.status(400).json({ error });

  const thread = getThreadSummary(id);
  if (!thread) return res.status(404).json({ error: 'Conversa não encontrada.' });

  db.transaction(() => {
    db.prepare(`
      INSERT INTO support_messages (thread_id, sender_id, body)
      VALUES (?, ?, ?)
    `).run(id, req.user.id, body);

    db.prepare(`
      UPDATE support_threads
      SET status = 'open', last_message_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  })();

  notifyOnce(
    thread.professor_id,
    'support_reply',
    'A administração respondeu sua mensagem',
    'Você recebeu uma nova resposta no Fale Conosco.',
    { support_thread_id: id }
  );

  logActivity({
    user: req.user,
    action: 'reply_support_message',
    module: 'support',
    entityType: 'support_thread',
    entityId: id,
    entityTitle: thread.professor_name,
    description: `${req.user.name} respondeu a conversa de ${thread.professor_name}.`,
    metadata: { message_length: body.length },
    req,
  });

  res.status(201).json({
    thread: getThreadSummary(id),
    messages: getMessages(id),
  });
});

router.put('/admin/threads/:id/status', requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  const status = req.body.status;

  if (!Number.isInteger(id) || id < 1 || !['open', 'closed'].includes(status)) {
    return res.status(400).json({ error: 'Dados inválidos.' });
  }

  const result = db.prepare(`
    UPDATE support_threads
    SET status = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(status, id);

  if (!result.changes) return res.status(404).json({ error: 'Conversa não encontrada.' });
  res.json(getThreadSummary(id));
});

module.exports = router;
