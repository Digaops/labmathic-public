const crypto = require('node:crypto');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const db = require('../database');
const config = require('../config');
const { verifyUserToken } = require('../services/authSessions');
const { verifyStudentSession } = require('../services/studentAssessmentAccess');

// Um processo, como no ecosystem.config.js. Os contadores são voláteis e locais.
// Manter uma barreira por origem ANTES do parser e orçamentos separados por identidade validada.
const SCHOOL_LIMITS = Object.freeze({
  windowMs: 15 * 60 * 1000,
  ingress: 6000,
  anonymous: 500,
  professional: 1200,
  student: 600,
  loginOrigin: 120,
  loginFailures: 10,
  forgotOrigin: 30,
  forgotAccount: 5,
  entryOrigin: 300,
  studentCodeFailures: 12,
  classCodeFailures: 120,
  downloads: 100,
});

function resolveIdentity(req) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  const token = header.slice(7);
  try {
    return { kind: 'professional', key: `user:${verifyUserToken(token).user.id}` };
  } catch (error) {
    if (error.code?.startsWith('SQLITE_')) throw error;
  }
  try {
    const decoded = verifyStudentSession(token);
    const credential = db.prepare(`SELECT public_id, expires_at FROM class_assessment_access_credentials
      WHERE public_id = ? AND status IN ('active', 'used')`).get(decoded.credentialId);
    return credential && Date.parse(credential.expires_at) > Date.now()
      ? { kind: 'student', key: `student:${credential.public_id}` } : null;
  } catch (error) {
    if (error.code?.startsWith('SQLITE_')) throw error;
    return null;
  }
}

function identifyRateLimitPrincipal(req, _res, next) {
  try { req.rateLimitIdentity = resolveIdentity(req); next(); }
  catch (error) { next(error); }
}

function principalKey(req) {
  return req.rateLimitIdentity?.key || `ip:${ipKeyGenerator(req.ip)}`;
}

function privateInputKey(req, field, normalize) {
  const input = typeof req.body?.[field] === 'string' ? req.body[field].slice(0, 512) : '';
  return crypto.createHash('sha256').update(normalize(input)).digest('hex');
}

function createSchoolRateLimits({ production = config.isProduction } = {}) {
  const scale = production ? 1 : 10;
  const limiter = (identifier, limit, options = {}) => rateLimit({
    windowMs: SCHOOL_LIMITS.windowMs,
    limit: typeof limit === 'function' ? req => limit(req) * scale : limit * scale,
    standardHeaders: 'draft-8', legacyHeaders: false, identifier,
    handler: (req, res) => {
      const retryAfterSeconds = Math.max(1, Math.ceil(
        ((req.rateLimit?.resetTime?.getTime() || Date.now() + SCHOOL_LIMITS.windowMs) - Date.now()) / 1000,
      ));
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        error: `Muitas tentativas ou requisições. Aguarde ${retryAfterSeconds} segundos e tente novamente.`,
        code: 'rate_limited', retryAfterSeconds,
      });
    },
    ...options,
  });
  const emailKey = req => `ip:${ipKeyGenerator(req.ip)}:email:${privateInputKey(req, 'email', s => s.trim().toLowerCase())}`;
  const codeKey = req => privateInputKey(req, 'code', s => s.toUpperCase().replace(/[^A-Z0-9]/g, ''));
  return {
    ingressLimiter: limiter('api-origin', SCHOOL_LIMITS.ingress),
    identifyRateLimitPrincipal,
    apiLimiter: limiter('api-principal', req => SCHOOL_LIMITS[req.rateLimitIdentity?.kind || 'anonymous'], { keyGenerator: principalKey }),
    loginOriginLimiter: limiter('login-origin', SCHOOL_LIMITS.loginOrigin),
    authLimiter: limiter('login-failures', SCHOOL_LIMITS.loginFailures, { keyGenerator: emailKey, skipSuccessfulRequests: true }),
    forgotOriginLimiter: limiter('password-recovery-origin', SCHOOL_LIMITS.forgotOrigin),
    forgotAccountLimiter: limiter('password-recovery-account', SCHOOL_LIMITS.forgotAccount, { keyGenerator: emailKey }),
    downloadLimiter: limiter('downloads-principal', SCHOOL_LIMITS.downloads, { keyGenerator: principalKey }),
    classJoinLimiter: limiter('class-entry-origin', SCHOOL_LIMITS.entryOrigin),
    classCodeLimiter: limiter('class-code-failures', SCHOOL_LIMITS.classCodeFailures, { keyGenerator: codeKey, skipSuccessfulRequests: true }),
    studentAssessmentEntryLimiter: limiter('student-entry-origin', SCHOOL_LIMITS.entryOrigin),
    studentAssessmentCodeLimiter: limiter('student-code-failures', SCHOOL_LIMITS.studentCodeFailures, { keyGenerator: codeKey, skipSuccessfulRequests: true }),
  };
}

module.exports = { createSchoolRateLimits, SCHOOL_LIMITS, resolveIdentity };
