const express = require('express');
const db = require('../database');
const { existingUploadPath } = require('../services/uploadPaths');
const { verifyUserToken, readCookie, MEDIA_COOKIE, STUDENT_MEDIA_COOKIE } = require('../services/authSessions');
const { findActiveShare } = require('../services/sharedMaterials');
const { verifyStudentSession } = require('../services/studentAssessmentAccess');
const { evaluateFeatureFlag } = require('../services/featureFlags');

function userCanRead(user, filename) {
  const names = [filename, `/uploads/${filename}`];
  if (user.role === 'admin' && db.prepare('SELECT 1 FROM material_drafts WHERE owner_id=? AND published_material_id IS NULL AND file_path IN (?, ?)').get(user.id, ...names)) return true;
  if (db.prepare('SELECT 1 FROM materials WHERE file_path IN (?, ?) OR thumbnail_path IN (?, ?)').get(...names, ...names)
      || db.prepare('SELECT 1 FROM collections WHERE image_path IN (?, ?) AND (is_public = 1 OR user_id = ?)')
        .get(...names, user.id)) return true;
  if (db.prepare(`SELECT 1 FROM questions WHERE image_path IN (?, ?)
      AND (? = 'admin' OR source = 'official' OR created_by = ?)`).get(...names, user.role, user.id)) return true;
  return Boolean(db.prepare(`SELECT 1 FROM class_assessment_items WHERE image_path_snapshot IN (?, ?)
      AND (? = 'admin' OR owner_teacher_id = ?)`).get(...names, user.role, user.id));
}

function studentCanRead(token, filename) {
  const decoded = verifyStudentSession(token);
  const access = db.prepare(`
    SELECT credential.expires_at, credential.owner_teacher_id, owner.role
    FROM class_assessment_access_credentials credential
    JOIN users owner ON owner.id = credential.owner_teacher_id
    JOIN class_assessment_assignments assignment ON assignment.id = credential.assignment_id
    JOIN class_assessment_items item ON item.assignment_id = assignment.id
    JOIN class_assessment_participants participant ON participant.id = credential.participant_id
    WHERE credential.public_id = ? AND credential.status IN ('active', 'used')
      AND assignment.student_access_enabled = 1 AND assignment.status IN ('open', 'closed')
      AND participant.status NOT IN ('exempted', 'removed')
      AND item.show_image = 1 AND item.image_path_snapshot IN (?, ?)
  `).get(decoded.credentialId, filename, `/uploads/${filename}`);
  return Boolean(access && Date.parse(access.expires_at) > Date.now()
    && evaluateFeatureFlag(db, 'classes.student_assessment_portal', { id: access.owner_teacher_id, role: access.role }).enabled);
}

const router = express.Router();
router.use((req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('Vary', 'Cookie, Authorization');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  // Conteúdo enviado nunca pode executar scripts no mesmo domínio da aplicação.
  res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'; style-src 'unsafe-inline'");
  if (req.method !== 'GET' && req.method !== 'HEAD') return res.sendStatus(405);
  next();
});
router.get('/:filename', (req, res, next) => {
  const filename = req.params.filename;
  if (!filename || filename.startsWith('.') || /[/\\\x00-\x1f]/.test(filename)) return res.sendStatus(404);
  let allowed = false;
  if (req.query.share !== undefined) {
    const share = findActiveShare(req.query.share);
    allowed = Boolean(share && db.prepare('SELECT 1 FROM materials WHERE id = ? AND file_path IN (?, ?)')
      .get(share.material_id, filename, `/uploads/${filename}`));
  } else {
    const header = req.headers.authorization;
    const userToken = header?.startsWith('Bearer ') ? header.slice(7) : readCookie(req, MEDIA_COOKIE);
    if (userToken) {
      try { allowed = userCanRead(verifyUserToken(userToken).user, filename); } catch { /* fail closed */ }
    }
    if (!allowed) {
      const studentToken = readCookie(req, STUDENT_MEDIA_COOKIE);
      if (studentToken) {
        try { allowed = studentCanRead(studentToken, filename); } catch { /* fail closed */ }
      }
    }
  }
  if (!allowed) return res.sendStatus(404);
  try {
    const real = existingUploadPath(filename);
    if (!real) return res.sendStatus(404);
    return res.sendFile(real, { cacheControl: false, lastModified: false, dotfiles: 'deny' }, (error) => {
      if (error && !res.headersSent) next(error);
    });
  } catch (error) {
    if (error.code === 'ENOENT') return res.sendStatus(404);
    return next(error);
  }
});
router.use((_req, res) => res.sendStatus(404));

module.exports = router;
