const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');

const router = express.Router();

router.use(authenticate);

function normalizeAccessKey(value) {
  const accessKey = String(value || '').trim();

  if (!/^[a-zA-Z0-9_-]{8,100}$/.test(accessKey)) {
    return null;
  }

  return accessKey;
}

function serializeAnnouncement(row) {
  if (!row) return null;

  let payload = {};
  try {
    payload = JSON.parse(row.payload_json);
  } catch {
    payload = {};
  }

  return {
    id: row.id,
    key: row.announcement_key,
    title: row.title,
    payload,
    maxImpressions: row.max_impressions,
    impressions: row.impression_count,
    remaining: Math.max(0, row.max_impressions - row.impression_count),
  };
}

function findEligibleAnnouncement(user, accessKey, id = null) {
  const idFilter = id ? 'AND a.id = @id' : '';

  const params = {
    userId: user.id,
    role: user.role,
    accessKey,
  };

  if (id) params.id = id;

  return db.prepare(`
    SELECT
      a.*,
      (
        SELECT COUNT(*)
        FROM announcement_impressions ai
        WHERE ai.announcement_id = a.id
          AND ai.user_id = @userId
      ) AS impression_count
    FROM announcements a
    WHERE a.active = 1
      AND (a.audience = 'all' OR a.audience = @role)
      ${idFilter}
      AND NOT EXISTS (
        SELECT 1
        FROM announcement_impressions current_access
        WHERE current_access.announcement_id = a.id
          AND current_access.user_id = @userId
          AND current_access.access_key = @accessKey
      )
      AND (
        SELECT COUNT(*)
        FROM announcement_impressions previous_accesses
        WHERE previous_accesses.announcement_id = a.id
          AND previous_accesses.user_id = @userId
      ) < a.max_impressions
    ORDER BY a.created_at DESC, a.id DESC
    LIMIT 1
  `).get(params);
}

router.get('/current', (req, res) => {
  const accessKey = normalizeAccessKey(req.query.access_id);
  if (!accessKey) {
    return res.status(400).json({ error: 'Identificador de acesso inválido.' });
  }

  const announcement = findEligibleAnnouncement(req.user, accessKey);
  return res.json({ announcement: serializeAnnouncement(announcement) });
});

router.post('/:id/impressions', (req, res) => {
  const announcementId = Number(req.params.id);
  const accessKey = normalizeAccessKey(req.body?.access_id);

  if (!Number.isInteger(announcementId) || announcementId < 1) {
    return res.status(400).json({ error: 'Aviso inválido.' });
  }

  if (!accessKey) {
    return res.status(400).json({ error: 'Identificador de acesso inválido.' });
  }

  const registerImpression = db.transaction(() => {
    const announcement = findEligibleAnnouncement(req.user, accessKey, announcementId);
    if (!announcement) return null;

    const result = db.prepare(`
      INSERT OR IGNORE INTO announcement_impressions (
        announcement_id,
        user_id,
        access_key
      )
      VALUES (?, ?, ?)
    `).run(announcementId, req.user.id, accessKey);

    if (result.changes !== 1) return null;

    const impressions = announcement.impression_count + 1;
    return {
      announcement: serializeAnnouncement({
        ...announcement,
        impression_count: impressions,
      }),
      impressions,
      remaining: Math.max(0, announcement.max_impressions - impressions),
    };
  });

  const registration = registerImpression();
  if (!registration) {
    return res.status(409).json({
      error: 'Este aviso já foi registrado neste acesso ou atingiu o limite de exibições.',
    });
  }

  return res.status(201).json(registration);
});

module.exports = router;
