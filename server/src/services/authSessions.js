const crypto = require('node:crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const db = require('../database');

const MEDIA_COOKIE = 'labmathic_media';
const STUDENT_MEDIA_COOKIE = 'labmathic_student_media';
const digestToken = (token) => crypto.createHash('sha256').update(token).digest('hex');

function verifyUserToken(token) {
  const decoded = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
  if (!Number.isInteger(decoded.id) || decoded.id < 1 || decoded.type
      || !Number.isInteger(decoded.exp)) throw new Error('invalid_session');
  const user = db.prepare('SELECT id, name, email, role, auth_version FROM users WHERE id = ?').get(decoded.id);
  // Tokens legados são aceitos apenas enquanto a conta ainda não teve revogação.
  if (!user || (decoded.authVersion ?? 0) !== user.auth_version
      || db.prepare('SELECT 1 FROM revoked_auth_tokens WHERE token_digest = ?').get(digestToken(token))) {
    throw new Error('revoked_session');
  }
  return { user, expiresAt: decoded.exp };
}

function issueUserToken(userId) {
  const user = db.prepare('SELECT id, name, email, role, auth_version FROM users WHERE id = ?').get(userId);
  return jwt.sign({ id: user.id, name: user.name, email: user.email, role: user.role, authVersion: user.auth_version },
    config.jwtSecret, { algorithm: 'HS256', expiresIn: config.jwtExpiresIn, jwtid: crypto.randomUUID() });
}

function mediaCookieOptions() {
  // Cookies somente para leitura de mídia. Escritas da API continuam exigindo Bearer.
  return { httpOnly: true, secure: config.isProduction, sameSite: 'strict', path: '/uploads' };
}

function setMediaCookie(res, token, name = MEDIA_COOKIE) {
  res.cookie(name, token, mediaCookieOptions());
}

function clearMediaCookie(res, name = MEDIA_COOKIE) {
  res.clearCookie(name, mediaCookieOptions());
}

function readCookie(req, name) {
  const value = String(req.headers.cookie || '').split(';').map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
  try { return value ? decodeURIComponent(value) : null; } catch { return null; }
}

module.exports = { verifyUserToken, issueUserToken, digestToken, setMediaCookie, clearMediaCookie, readCookie, MEDIA_COOKIE, STUDENT_MEDIA_COOKIE };
