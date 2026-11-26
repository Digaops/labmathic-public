const express = require('express');
const router = express.Router();
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { integer, activityQuery } = require('../services/adminReadInputs');

router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });

function parsePagination(query) {
  const { page, limit } = query;
  return { page, limit, offset: (page - 1) * limit };
}

function buildTimelineFilters(query) {
  const conditions = [];
  const params = [];

  const addEquals = (column, value) => {
    if (value !== undefined && value !== null && String(value).trim() !== '') {
      conditions.push(`${column} = ?`);
      params.push(value);
    }
  };

  addEquals('al.user_id', query.user_id ? Number(query.user_id) : null);
  addEquals('al.user_role', query.user_role);
  addEquals('al.action', query.action);
  addEquals('al.module', query.module);
  addEquals('al.entity_type', query.entity_type);
  addEquals('al.entity_id', query.entity_id ? Number(query.entity_id) : null);

  if (query.critical_only === '1' || query.critical_only === 'true') {
    conditions.push('COALESCE(al.is_critical, 0) = 1');
  }

  if (query.date_from) {
    conditions.push("datetime(al.created_at) >= datetime(?)");
    params.push(query.date_from);
  }

  if (query.date_to) {
    conditions.push("datetime(al.created_at) <= datetime(?)");
    params.push(query.date_to);
  }

  if (query.date_before) {
    conditions.push('datetime(al.created_at) < datetime(?)');
    params.push(query.date_before);
  }
  if (query.snapshot_id !== undefined) {
    conditions.push('al.id <= ?'); params.push(query.snapshot_id);
  }

  if (query.search) {
    const term = `%${String(query.search).trim().replace(/[\\%_]/g, '\\$&')}%`;
    conditions.push(`(
      al.description LIKE ? ESCAPE '\\'
      OR al.entity_title LIKE ? ESCAPE '\\'
      OR al.action LIKE ? ESCAPE '\\'
      OR al.module LIKE ? ESCAPE '\\'
      OR al.user_name LIKE ? ESCAPE '\\'
      OR u.name LIKE ? ESCAPE '\\'
      OR u.email LIKE ? ESCAPE '\\'
    )`);
    params.push(term, term, term, term, term, term, term);
  }

  return {
    where: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function parseMetadata(row) {
  const raw = row.metadata_json || row.metadata;
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function mapActivity(row) {
  return {
    ...row,
    user_name: row.user_name || row.fallback_user_name,
    user_role: row.user_role || row.fallback_user_role,
    metadata: parseMetadata(row),
  };
}

function getTimeline(req, res) {
  const query = activityQuery(req.query);
  if (query.snapshot_id === undefined) query.snapshot_id = db.prepare('SELECT COALESCE(MAX(id),0) AS id FROM activity_log').get().id;
  const { page, limit, offset } = parsePagination(query);
  const { where, params } = buildTimelineFilters(query);

  const total = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.user_id
    ${where}
  `).get(...params).count;

  const rows = db.prepare(`
    SELECT
      al.*,
      u.name AS fallback_user_name,
      u.role AS fallback_user_role,
      u.email AS user_email
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.user_id
    ${where}
    ORDER BY datetime(al.created_at) DESC, al.id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    snapshot_id: query.snapshot_id,
    data: rows.map(mapActivity),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    },
  });
}

router.get('/', requireAdmin, getTimeline);
router.get('/timeline', requireAdmin, getTimeline);

router.get('/summary', requireAdmin, (req, res) => {
  const query = activityQuery(req.query);
  const dateFrom = query.date_from || null;
  const dateTo = query.date_to || null;
  const conditions = [];
  const params = [];

  if (dateFrom) {
    conditions.push("datetime(created_at) >= datetime(?)");
    params.push(dateFrom);
  }

  if (dateTo) {
    conditions.push("datetime(created_at) <= datetime(?)");
    params.push(dateTo);
  }

  const rangeWhere = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const totalToday = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_log
    WHERE date(created_at, 'localtime') = date('now', 'localtime')
  `).get().count;

  const totalLast7Days = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_log
    WHERE datetime(created_at) >= datetime('now', '-7 days')
  `).get().count;

  const criticalTotal = db.prepare(`
    SELECT COUNT(*) as count
    FROM activity_log
    WHERE COALESCE(is_critical, 0) = 1
  `).get().count;

  const activeUsers = db.prepare(`
    SELECT COUNT(DISTINCT user_id) as count
    FROM activity_log
    ${rangeWhere}
  `).get(...params).count;

  const modules = db.prepare(`
    SELECT COALESCE(module, 'admin') as module, COUNT(*) as count
    FROM activity_log
    ${rangeWhere}
    GROUP BY COALESCE(module, 'admin')
    ORDER BY count DESC
    LIMIT 6
  `).all(...params);

  const latestCritical = db.prepare(`
    SELECT al.*, u.name AS fallback_user_name, u.role AS fallback_user_role
    FROM activity_log al
    LEFT JOIN users u ON u.id = al.user_id
    WHERE COALESCE(al.is_critical, 0) = 1
    ORDER BY datetime(al.created_at) DESC, al.id DESC
    LIMIT 5
  `).all().map(mapActivity);

  res.json({
    totalToday,
    totalLast7Days,
    criticalTotal,
    activeUsers,
    modules,
    latestCritical,
  });
});

router.get('/me', (req, res) => {
  const limit = integer(req.query.limit, 20, 50);
  // Recovery snapshots belong to the admin audit, not the personal timeline.
  const activities = db.prepare(`
    SELECT *
    FROM activity_log
    WHERE user_id = ?
      AND action NOT IN ('preserve_collection_image', 'preserve_question_image')
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT ?
  `).all(req.user.id, limit).map(mapActivity);
  res.json(activities);
});

module.exports = router;
