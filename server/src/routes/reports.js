const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { integer } = require('../services/adminReadInputs');
const { reportCsv } = require('../services/reportCsv');

router.use(authenticate, requireAdmin, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

// Overview stats
router.get('/overview', (_req, res) => {
  const totalMaterials = db.prepare('SELECT COUNT(*) as c FROM materials').get().c;
  const totalUsers = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  const totalSystemAccesses = db.prepare("SELECT COUNT(*) as c FROM activity_log WHERE action = 'login'").get().c;
  const totalMaterialAccesses = db.prepare('SELECT COUNT(*) as c FROM access_history').get().c;
  const totalQuestionSetAccesses = db.prepare('SELECT COUNT(*) as c FROM question_set_access_history').get().c;
  const totalContentAccesses = totalMaterialAccesses + totalQuestionSetAccesses;
  const totalDownloads = db.prepare("SELECT COUNT(*) as c FROM activity_log WHERE action = 'download'").get().c;
  const totalFavorites = db.prepare('SELECT COUNT(*) as c FROM favorites').get().c;
  const totalComments = db.prepare('SELECT COUNT(*) as c FROM comments').get().c;
  const totalSupportThreads = db.prepare('SELECT COUNT(*) as c FROM support_threads').get().c;
  const unreadSupportMessages = db.prepare(`
    SELECT COUNT(*) AS c
    FROM support_messages sm
    JOIN users sender ON sender.id = sm.sender_id
    WHERE sm.read_at IS NULL AND sender.role = 'professor'
  `).get().c;
  const avgRating = db.prepare('SELECT COALESCE(AVG(score), 0) as avg FROM ratings').get().avg;

  res.json({
    totalMaterials,
    totalUsers,
    totalSystemAccesses,
    totalContentAccesses,
    totalAccesses: totalContentAccesses,
    totalMaterialAccesses,
    totalQuestionSetAccesses,
    totalDownloads,
    totalFavorites,
    totalComments,
    totalSupportThreads,
    unreadSupportMessages,
    avgRating: Math.round(avgRating * 10) / 10,
  });
});

// Most accessed materials
router.get('/top-materials', (req, res) => {
  const limit = integer(req.query.limit, 10, 50);
  const materials = db.prepare(`
    SELECT m.id, m.title, d.name as discipline_name,
           COUNT(ah.id) as access_count,
           COALESCE((SELECT AVG(r.score) FROM ratings r WHERE r.material_id = m.id), 0) as avg_rating
    FROM materials m
    LEFT JOIN access_history ah ON ah.material_id = m.id
    LEFT JOIN disciplines d ON d.id = m.discipline_id
    GROUP BY m.id
    ORDER BY access_count DESC, m.id ASC
    LIMIT ?
  `).all(limit);
  res.json(materials);
});

// Most accessed content: materials + question sets
router.get('/top-content', (req, res) => {
    const limit = integer(req.query.limit, 10, 50);

    const content = db.prepare(`
      SELECT *
      FROM (
        SELECT
          m.id,
          m.title,
          'material' AS content_type,
          d.name AS category,
          COUNT(ah.id) AS access_count,
          COALESCE((SELECT AVG(r.score) FROM ratings r WHERE r.material_id = m.id), 0) AS avg_rating,
          '/material/' || m.id AS path
        FROM materials m
        LEFT JOIN access_history ah ON ah.material_id = m.id
        LEFT JOIN disciplines d ON d.id = m.discipline_id
        GROUP BY m.id

        UNION ALL

        SELECT
          qs.id,
          qs.title,
          'question_set' AS content_type,
          CASE
            WHEN qs.contains_author_questions = 1 THEN 'Simulado com questões autorais'
            WHEN qs.is_public = 1 THEN 'Simulado público'
            ELSE 'Simulado privado'
          END AS category,
          COUNT(qsah.id) AS access_count,
          0 AS avg_rating,
          '/simulados/' || qs.id AS path
        FROM question_sets qs
        LEFT JOIN question_set_access_history qsah ON qsah.question_set_id = qs.id
        GROUP BY qs.id
      )
      ORDER BY access_count DESC, title ASC
      LIMIT ?
    `).all(limit);

    res.json(content);
});

// Most active users
router.get('/top-users', (req, res) => {
  const limit = integer(req.query.limit, 10, 50);
  const users = db.prepare(`
    SELECT u.id, u.name, u.email, u.role,
           (
             SELECT COUNT(*)
             FROM activity_log al
             WHERE al.user_id = u.id
             AND al.action = 'login'
           ) as system_access_count,
           COUNT(ah.id) + (
             SELECT COUNT(*)
             FROM question_set_access_history qsah
             WHERE qsah.user_id = u.id
           ) as content_access_count,
           COUNT(ah.id) as material_access_count,
           (
             SELECT COUNT(*)
             FROM question_set_access_history qsah
             WHERE qsah.user_id = u.id
           ) as question_set_access_count,
           (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) as favorites_count,
           (SELECT COUNT(*) FROM comments c WHERE c.user_id = u.id) as comments_count
    FROM users u
    LEFT JOIN access_history ah ON ah.user_id = u.id
    GROUP BY u.id
    ORDER BY system_access_count DESC, content_access_count DESC, u.id ASC
    LIMIT ?
  `).all(limit);
  res.json(users);
});

// System logins over time (last 30 days)
router.get('/access-timeline', (_req, res) => {
  const data = db.prepare(`
    WITH RECURSIVE days(day) AS (
      SELECT date('now', '-29 days', 'localtime')
      UNION ALL
      SELECT date(day, '+1 day')
      FROM days
      WHERE day < date('now', 'localtime')
    ),
    system_accesses AS (
      SELECT date(created_at, 'localtime') AS day, COUNT(*) AS count
      FROM activity_log
      WHERE action = 'login'
      AND created_at >= datetime('now', '-30 days')
      GROUP BY date(created_at, 'localtime')
    )
    SELECT
      days.day AS date,
      COALESCE(system_accesses.count, 0) AS count
    FROM days
    LEFT JOIN system_accesses ON system_accesses.day = days.day
    ORDER BY days.day ASC
  `).all();
  res.json(data);
});

// Materials per discipline
router.get('/by-discipline', (_req, res) => {
  const data = db.prepare(`
    SELECT d.name as discipline, COUNT(m.id) as count
    FROM disciplines d
    LEFT JOIN materials m ON m.discipline_id = d.id
    GROUP BY d.id
    ORDER BY count DESC
  `).all();
  res.json(data);
});

// Question bank and question sets usage
router.get('/question-bank-usage', (_req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM questions) AS total_questions,
      (SELECT COUNT(*) FROM questions WHERE status = 'active') AS active_questions,
      (SELECT COUNT(*) FROM questions WHERE status = 'inactive') AS inactive_questions,
      (SELECT COUNT(*) FROM questions WHERE reviewed = 1) AS reviewed_questions,
      (SELECT COUNT(*) FROM questions WHERE reviewed = 0) AS not_reviewed_questions,
      (SELECT COUNT(*) FROM question_sets) AS total_question_sets,
      (SELECT COUNT(*) FROM question_sets WHERE is_public = 1) AS public_question_sets,
      (SELECT COUNT(*) FROM question_sets WHERE is_public = 0) AS private_question_sets,
      (SELECT COUNT(*) FROM question_set_items) AS total_question_set_items,
      (SELECT COUNT(*) FROM question_set_access_history) AS total_question_set_accesses,
      (SELECT COUNT(*) FROM questions WHERE source = 'teacher') AS teacher_questions,
      (SELECT COUNT(DISTINCT created_by) FROM questions WHERE source = 'teacher') AS teacher_question_creators,
      (SELECT COUNT(*) FROM question_sets WHERE contains_author_questions = 1) AS teacher_question_sets,
      (SELECT COUNT(DISTINCT user_id) FROM question_sets WHERE contains_author_questions = 1) AS teacher_question_set_creators,
      (SELECT COUNT(*) FROM diagnostic_question_sets) AS diagnostic_question_sets,
      (SELECT COUNT(DISTINCT owner_teacher_id) FROM diagnostic_question_sets) AS diagnostic_creators,
      (
        SELECT COUNT(*)
        FROM class_assessment_assignments assignment
        JOIN diagnostic_question_sets diagnostic
          ON diagnostic.question_set_id = assignment.source_question_set_id
      ) AS diagnostic_assignments,
      (
        SELECT COUNT(*)
        FROM question_set_access_history qsah
        JOIN question_sets qs ON qs.id = qsah.question_set_id
        WHERE qs.contains_author_questions = 1
      ) AS teacher_question_set_accesses
  `).get();

  const authorEngagement = db.prepare(`
    SELECT
      u.id AS user_id,
      u.name AS user_name,
      u.email,
      (SELECT COUNT(*) FROM questions q WHERE q.created_by = u.id AND q.source = 'teacher') AS author_question_count,
      (SELECT COUNT(*) FROM question_sets qs WHERE qs.user_id = u.id AND qs.contains_author_questions = 1) AS author_set_count,
      (
        SELECT COUNT(*)
        FROM question_set_access_history qsah
        JOIN question_sets qs ON qs.id = qsah.question_set_id
        WHERE qs.user_id = u.id AND qs.contains_author_questions = 1
      ) AS author_set_access_count
    FROM users u
    WHERE u.role = 'professor'
      AND (
        EXISTS (SELECT 1 FROM questions q WHERE q.created_by = u.id AND q.source = 'teacher')
        OR EXISTS (SELECT 1 FROM question_sets qs WHERE qs.user_id = u.id AND qs.contains_author_questions = 1)
      )
    ORDER BY author_question_count DESC, author_set_count DESC, u.name ASC
  `).all();

  res.json({
    totals,
    authorEngagement,
  });
});

// Export CSV
router.get('/export/:type', (req, res) => {
  const { type } = req.params;
  let rows, headers;

  switch (type) {
    case 'materials': {
      rows = db.prepare(`
        SELECT m.id, m.title, d.name as discipline, g.name as grade,
               mt.name as type, m.file_format, m.created_at,
               (SELECT COUNT(*) FROM access_history ah WHERE ah.material_id = m.id) as accesses,
               COALESCE((SELECT AVG(r.score) FROM ratings r WHERE r.material_id = m.id), 0) as avg_rating
        FROM materials m
        LEFT JOIN disciplines d ON d.id = m.discipline_id
        LEFT JOIN grades g ON g.id = m.grade_id
        LEFT JOIN material_types mt ON mt.id = m.material_type_id
        ORDER BY m.id
      `).all();
      headers = ['ID', 'Título', 'Disciplina', 'Série', 'Tipo', 'Formato', 'Criado em', 'Acessos', 'Nota Média'];
      break;
    }
    case 'users': {
      rows = db.prepare(`
        SELECT u.id, u.name, u.email, u.role, u.created_at,
               (SELECT COUNT(*) FROM activity_log al WHERE al.user_id = u.id AND al.action = 'login') as system_accesses,
               (SELECT COUNT(*) FROM access_history ah WHERE ah.user_id = u.id) as material_accesses,
               (SELECT COUNT(*) FROM question_set_access_history qsah WHERE qsah.user_id = u.id) as question_set_accesses,
               (SELECT COUNT(*) FROM favorites f WHERE f.user_id = u.id) as favorites
        FROM users u ORDER BY u.id
      `).all();
      headers = ['ID', 'Nome', 'Email', 'Papel', 'Criado em', 'Entradas no sistema', 'Acessos a materiais', 'Acessos a simulados', 'Favoritos'];
      break;
    }
    case 'accesses': {
      rows = db.prepare(`
        SELECT ah.id, u.name as user_name, m.title as material_title, ah.accessed_at
        FROM access_history ah
        JOIN users u ON u.id = ah.user_id
        JOIN materials m ON m.id = ah.material_id
        ORDER BY ah.accessed_at DESC, ah.id DESC
        LIMIT 1000
      `).all();
      headers = ['ID', 'Usuário', 'Material', 'Data de Acesso'];
      break;
    }
    default:
      return res.status(400).json({ error: 'Tipo de exportação inválido.' });
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=relatorio-${type}-${Date.now()}.csv`);
  res.send(reportCsv(headers, rows));
});

module.exports = router;
