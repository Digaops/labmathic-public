const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');

const ACCESS_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACCESS_CODE_LENGTH = 16;
const STUDENT_SESSION_AUDIENCE = 'labmathic-student-assessment';

function normalizeAccessCode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (
    normalized.length !== ACCESS_CODE_LENGTH
    || [...normalized].some((character) => !ACCESS_CODE_ALPHABET.includes(character))
  ) {
    return null;
  }
  return normalized;
}

function formatAccessCode(value) {
  const normalized = normalizeAccessCode(value);
  if (!normalized) return null;
  return normalized.match(/.{1,4}/g).join('-');
}

function generateAccessCode() {
  let code = '';
  while (code.length < ACCESS_CODE_LENGTH) {
    const bytes = crypto.randomBytes(ACCESS_CODE_LENGTH - code.length);
    for (const byte of bytes) {
      if (byte >= 224) continue;
      code += ACCESS_CODE_ALPHABET[byte % ACCESS_CODE_ALPHABET.length];
      if (code.length === ACCESS_CODE_LENGTH) break;
    }
  }
  return formatAccessCode(code);
}

function digestAccessCode(value) {
  const normalized = normalizeAccessCode(value);
  if (!normalized) return null;
  if (!config.studentAssessmentAccessSecret) {
    throw new Error('student_assessment_access_secret_missing');
  }
  return crypto
    .createHmac('sha256', config.studentAssessmentAccessSecret)
    .update(`student-assessment-access:v1:${normalized}`)
    .digest('hex');
}

function signStudentSession(credentialPublicId) {
  return jwt.sign(
    { type: 'student_assessment', credentialId: credentialPublicId },
    config.jwtSecret,
    {
      audience: STUDENT_SESSION_AUDIENCE,
      issuer: 'labmathic',
      expiresIn: '8h',
    }
  );
}

function verifyStudentSession(token) {
  const decoded = jwt.verify(token, config.jwtSecret, {
    audience: STUDENT_SESSION_AUDIENCE,
    issuer: 'labmathic',
  });
  if (decoded?.type !== 'student_assessment' || !decoded.credentialId) {
    throw new Error('invalid_student_assessment_session');
  }
  return decoded;
}

function opaquePortalToken(credentialPublicId, kind, databaseId) {
  if (!config.studentAssessmentAccessSecret) {
    throw new Error('student_assessment_access_secret_missing');
  }
  return crypto
    .createHmac('sha256', config.studentAssessmentAccessSecret)
    .update(`student-assessment-portal:v1:${credentialPublicId}:${kind}:${databaseId}`)
    .digest('base64url')
    .slice(0, 22);
}

function deterministicOrder(seed, rows) {
  if (!config.studentAssessmentAccessSecret) {
    throw new Error('student_assessment_access_secret_missing');
  }
  return [...rows].sort((left, right) => {
    const leftDigest = crypto.createHmac('sha256', config.studentAssessmentAccessSecret)
      .update(`${seed}:${left.id}`)
      .digest('hex');
    const rightDigest = crypto.createHmac('sha256', config.studentAssessmentAccessSecret)
      .update(`${seed}:${right.id}`)
      .digest('hex');
    return leftDigest.localeCompare(rightDigest);
  });
}

module.exports = {
  digestAccessCode,
  deterministicOrder,
  formatAccessCode,
  generateAccessCode,
  normalizeAccessCode,
  opaquePortalToken,
  signStudentSession,
  verifyStudentSession,
};
