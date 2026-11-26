const express = require('express');
const { rateLimit } = require('express-rate-limit');
const passwords = require('../services/passwordOperations');
const { PasswordOperationError } = passwords;
const { passwordRoute, revalidatePasswordActor, unchangedPasswordUser } = require('../services/passwordAccess');
const crypto = require('crypto');
const nodemailer = require('nodemailer');
const db = require('../database');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { logActivity, logActivityStrict } = require('../helpers/activity');
const { issueUserToken, digestToken, setMediaCookie, clearMediaCookie } = require('../services/authSessions');

const router = express.Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'no-store'); next(); });

function getTransporter() {
  if (!config.smtp.user || !config.smtp.pass) {
    return null;
  }

  return nodemailer.createTransport({
    host: config.smtp.host,
    port: config.smtp.port,
    secure: config.smtp.port === 465,
    auth: {
      user: config.smtp.user,
      pass: config.smtp.pass,
    },
  });
}

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

const passwordConfirmationLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  keyGenerator: req => `user:${req.user.id}`,
  skipSuccessfulRequests: true,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Muitas tentativas de confirmação de senha. Aguarde antes de tentar novamente.' },
});

function limitEmailChange(req, res, next) {
  const email = typeof req.body?.email === 'string' && normalizeEmail(req.body.email);
  if (!email || email === req.user.email) return next();
  return passwordConfirmationLimiter(req, res, next);
}

router.post('/login', passwordRoute(async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string' || !email || !password || password.length > 1024) {
    return res.status(400).json({ error: 'E-mail e senha são obrigatórios.' });
  }

  const normalizedEmail = normalizeEmail(email);
  let user = db.prepare('SELECT * FROM users WHERE LOWER(TRIM(email)) = ?').get(normalizedEmail);

  if (!user) {
    logActivity({
      user: null,
      action: 'login_failed',
      module: 'auth',
      entityType: 'user',
      description: `Tentativa de login sem usuário cadastrado para ${normalizedEmail}.`,
      metadata: { email: normalizedEmail },
      req,
    });
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  const valid = await passwords.compare(password, user.password);
  if (!valid) {
    logActivity({
      user,
      action: 'login_failed',
      module: 'auth',
      entityType: 'user',
      entityId: user.id,
      entityTitle: user.name,
      description: `${user.name} tentou fazer login com senha inválida.`,
      req,
    });
    return res.status(401).json({ error: 'E-mail ou senha inválidos.' });
  }

  const token = db.transaction(() => {
    user = unchangedPasswordUser(db, user, 401);
    return issueUserToken(user.id);
  }).immediate();
  setMediaCookie(res, token);

  logActivity({
    user,
    action: 'login',
    module: 'auth',
    entityType: 'user',
    entityId: user.id,
    entityTitle: user.name,
    description: `${user.name} realizou login no sistema.`,
    req,
  });

  res.json({
    token,
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
  });
}));

router.post('/forgot-password', (req, res) => {
  const { email } = req.body;
  if (typeof email !== 'string' || !email.trim() || email.length > 254) {
    return res.status(400).json({ error: 'E-mail é obrigatório.' });
  }

  const successMsg = 'Se o e-mail estiver cadastrado, você receberá as instruções de recuperação em breve.';
  const normalizedEmail = normalizeEmail(email);
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();

  const user = db.transaction(() => {
    const account = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ?').get(normalizedEmail);
    if (!account) return null;
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ? AND used = 0').run(account.id);
    db.prepare(
      'INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)'
    ).run(account.id, `sha256:${digestToken(token)}`, expiresAt);
    return account;
  }).immediate();

  if (!user) return res.json({ message: successMsg });

  logActivity({
    user,
    action: 'password_reset_requested',
    module: 'auth',
    entityType: 'user',
    entityId: user.id,
    entityTitle: normalizedEmail,
    description: `Redefinição de senha solicitada para ${normalizedEmail}.`,
    metadata: { email: normalizedEmail },
    req,
  });

  const resetUrl = `${config.appUrl}/resetar-senha/${token}`;
  const transporter = getTransporter();

  if (transporter) {
    transporter.sendMail({
      from: config.smtp.from,
      to: normalizedEmail,
      subject: 'Redefinição de Senha - Biblioteca Digital',
      html: `
        <h2>Redefinição de Senha</h2>
        <p>Você solicitou a redefinição da sua senha.</p>
        <p>Clique no link abaixo para criar uma nova senha:</p>
        <p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#3b82f6;color:white;text-decoration:none;border-radius:8px;font-weight:bold;">Redefinir Senha</a></p>
        <p>Este link expira em 1 hora.</p>
        <p>Se você não solicitou esta alteração, ignore este e-mail.</p>
      `,
    }).catch(() => {
      // Email delivery failures are intentionally hidden from the client.
      console.error(JSON.stringify({ event: 'password_reset_delivery_failed', module: 'auth' }));
    });
  } else if (process.env.NODE_ENV !== 'production') {
    console.warn('[DEV] SMTP não configurado. Link de redefinição não enviado por e-mail.');
  }

  res.json({ message: successMsg });
});

router.post('/reset-password', passwordRoute(async (req, res) => {
  const { token, password } = req.body;

  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)
      || typeof password !== 'string' || !password || password.length > 1024) {
    return res.status(400).json({ error: 'Token e nova senha são obrigatórios.' });
  }

  if (password.length < 8) {
    return res.status(400).json({ error: 'A senha deve ter no mínimo 8 caracteres.' });
  }

  const resetToken = db.prepare(
    'SELECT * FROM password_reset_tokens WHERE token IN (?, ?) AND used = 0 ORDER BY id DESC LIMIT 1'
  ).get(`sha256:${digestToken(token)}`, token);

  if (!resetToken) {
    return res.status(400).json({ error: 'Token inválido ou já utilizado.' });
  }

  if (!Number.isFinite(Date.parse(resetToken.expires_at)) || Date.parse(resetToken.expires_at) <= Date.now()) {
    return res.status(400).json({ error: 'Token expirado. Solicite uma nova redefinição.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(resetToken.user_id);
  if (!user) return res.status(400).json({ error: 'Token inválido ou já utilizado.' });
  const hash = await passwords.hash(password, 10);
  const resetPassword = db.transaction(() => {
    const currentToken = db.prepare('SELECT * FROM password_reset_tokens WHERE id = ? AND used = 0').get(resetToken.id);
    if (!currentToken || !Number.isFinite(Date.parse(currentToken.expires_at)) || Date.parse(currentToken.expires_at) <= Date.now()) {
      throw new PasswordOperationError(400, 'RESET_TOKEN_UNAVAILABLE', 'Token expirado ou já utilizado. Solicite uma nova redefinição.');
    }
    unchangedPasswordUser(db, user);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(hash, resetToken.user_id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(user.id);
    logActivityStrict({ user, action: 'password_reset_completed', module: 'auth', entityType: 'user',
      entityId: user.id, description: 'Senha redefinida; sessões anteriores invalidadas.', isCritical: true, req });
  });

  resetPassword.immediate();

  res.json({ message: 'Senha redefinida com sucesso.' });
}));

router.post('/logout', authenticate, (req, res) => {
  db.transaction(() => {
    db.prepare('INSERT OR IGNORE INTO revoked_auth_tokens (token_digest, user_id, expires_at) VALUES (?, ?, ?)')
      .run(digestToken(req.authToken), req.user.id, req.authExpiresAt);
    logActivityStrict({ user: req.user, action: 'logout', module: 'auth', entityType: 'user',
      entityId: req.user.id, description: 'Sessão encerrada.', req });
  }).immediate();
  clearMediaCookie(res);
  res.json({ message: 'Sessão encerrada.' });
});

router.get('/me', authenticate, (req, res) => {
  const user = db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }
  setMediaCookie(res, req.authToken);
  res.json(user);
});

function getCurrentProfessor(userId) {
  return db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE id = ? AND role = 'professor'
  `).get(userId);
}

function serializeGradePreferences(teacherId) {
  const profile = db.prepare(`
    SELECT revision
    FROM teacher_grade_preference_profiles
    WHERE teacher_id = ?
  `).get(teacherId);
  const grades = db.prepare(`
    SELECT id, name, sort_order
    FROM grades
    ORDER BY sort_order ASC, name ASC
  `).all();
  const selectedGradeIds = db.prepare(`
    SELECT grade_id
    FROM teacher_grade_preferences
    WHERE teacher_id = ?
    ORDER BY grade_id ASC
  `).all(teacherId).map(({ grade_id: gradeId }) => gradeId);

  return {
    grades,
    selectedGradeIds,
    revision: profile?.revision || 0,
    selectionMode: selectedGradeIds.length > 0 ? 'selected' : 'all',
  };
}

router.get('/grade-preferences', authenticate, (req, res) => {
  if (!getCurrentProfessor(req.user.id)) {
    return res.status(403).json({ error: 'Preferências de anos estão disponíveis apenas para professores.' });
  }

  return res.json(serializeGradePreferences(req.user.id));
});

router.put('/grade-preferences', authenticate, (req, res) => {
  const professor = getCurrentProfessor(req.user.id);
  if (!professor) {
    return res.status(403).json({ error: 'Preferências de anos estão disponíveis apenas para professores.' });
  }

  const { gradeIds, revision } = req.body || {};
  if (!Array.isArray(gradeIds) || !Number.isInteger(revision) || revision < 0) {
    return res.status(400).json({ error: 'Seleção ou revisão inválida.' });
  }
  if (gradeIds.length > 20) {
    return res.status(400).json({ error: 'A seleção excede o limite de anos escolares.' });
  }

  const normalizedGradeIds = gradeIds.map(Number);
  if (normalizedGradeIds.some((gradeId) => !Number.isInteger(gradeId) || gradeId < 1)) {
    return res.status(400).json({ error: 'Seleção de anos escolares inválida.' });
  }
  if (new Set(normalizedGradeIds).size !== normalizedGradeIds.length) {
    return res.status(400).json({ error: 'A seleção contém anos escolares repetidos.' });
  }

  if (normalizedGradeIds.length > 0) {
    const placeholders = normalizedGradeIds.map(() => '?').join(', ');
    const existingCount = db.prepare(`
      SELECT COUNT(*)
      FROM grades
      WHERE id IN (${placeholders})
    `).pluck().get(...normalizedGradeIds);
    if (existingCount !== normalizedGradeIds.length) {
      return res.status(400).json({ error: 'Um ou mais anos escolares não existem.' });
    }
  }

  const savePreferences = db.transaction(() => {
    const current = db.prepare(`
      SELECT revision
      FROM teacher_grade_preference_profiles
      WHERE teacher_id = ?
    `).get(professor.id);
    const currentRevision = current?.revision || 0;

    if (currentRevision !== revision) {
      const conflict = new Error('PREFERENCE_REVISION_CONFLICT');
      conflict.currentRevision = currentRevision;
      throw conflict;
    }

    if (current) {
      db.prepare(`
        UPDATE teacher_grade_preference_profiles
        SET revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE teacher_id = ? AND revision = ?
      `).run(professor.id, revision);
    } else {
      db.prepare(`
        INSERT INTO teacher_grade_preference_profiles (teacher_id, revision)
        VALUES (?, 1)
      `).run(professor.id);
    }

    db.prepare('DELETE FROM teacher_grade_preferences WHERE teacher_id = ?')
      .run(professor.id);
    const insertPreference = db.prepare(`
      INSERT INTO teacher_grade_preferences (teacher_id, grade_id)
      VALUES (?, ?)
    `);
    normalizedGradeIds.forEach((gradeId) => insertPreference.run(professor.id, gradeId));
  });

  try {
    savePreferences.immediate();
  } catch (error) {
    if (error.message === 'PREFERENCE_REVISION_CONFLICT') {
      return res.status(409).json({
        error: 'Suas preferências foram atualizadas em outro acesso. Recarregue antes de salvar novamente.',
        code: 'PREFERENCE_REVISION_CONFLICT',
        currentRevision: error.currentRevision,
      });
    }
    throw error;
  }

  logActivity({
    user: professor,
    action: 'update_grade_preferences',
    module: 'preferences',
    entityType: 'teacher_grade_preferences',
    entityId: professor.id,
    entityTitle: 'Anos escolares de interesse',
    description: `${professor.name} atualizou seus anos escolares de interesse.`,
    metadata: {
      selectedGradeIds: normalizedGradeIds,
      selectedCount: normalizedGradeIds.length,
      selectionMode: normalizedGradeIds.length > 0 ? 'selected' : 'all',
    },
    req,
  });

  return res.json(serializeGradePreferences(professor.id));
});

router.put('/profile', authenticate, limitEmailChange, passwordRoute(async (req, res) => {
  const { name, email, currentPassword } = req.body;

  if ((name !== undefined && (typeof name !== 'string' || !name.trim() || name.trim().length > 100))
      || (email !== undefined && (typeof email !== 'string' || !email.trim() || email.length > 254))) {
    return res.status(400).json({ error: 'Nome ou e-mail inválido.' });
  }

  if (!name && !email) {
    return res.status(400).json({ error: 'Informe ao menos um campo para atualizar.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  const updatedEmail = email ? normalizeEmail(email) : user.email;
  const emailChanged = updatedEmail !== user.email;

  if (emailChanged) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(updatedEmail)) {
      return res.status(400).json({ error: 'E-mail inválido.' });
    }
    if (typeof currentPassword !== 'string' || !currentPassword || currentPassword.length > 1024) {
      return res.status(400).json({ error: 'Informe sua senha atual para alterar o e-mail.' });
    }
    if (!await passwords.compare(currentPassword, user.password)) {
      return res.status(403).json({ error: 'Senha atual incorreta.' });
    }
  }

  const updated = db.transaction(() => {
    let current = user;
    if (emailChanged) {
      revalidatePasswordActor(req);
      current = unchangedPasswordUser(db, user);
      const existing = db.prepare('SELECT id FROM users WHERE LOWER(TRIM(email)) = ? AND id != ?')
        .get(updatedEmail, req.user.id);
      if (existing) throw new PasswordOperationError(409, 'EMAIL_IN_USE', 'Já existe um usuário com este e-mail.');
    }
    const updatedName = name ? name.trim() : current.name;
    db.prepare('UPDATE users SET name = ?, email = COALESCE(?, email), updated_at = CURRENT_TIMESTAMP WHERE id = ?')
      .run(updatedName, emailChanged ? updatedEmail : null, req.user.id);
    if (emailChanged) db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(req.user.id);
    logActivityStrict({ user: req.user, action: 'update_profile', module: 'auth', entityType: 'user',
      entityId: req.user.id, description: 'Perfil atualizado.',
      metadata: { nameChanged: updatedName !== current.name, emailChanged }, req });
    return db.prepare('SELECT id, name, email, role, created_at FROM users WHERE id = ?').get(req.user.id);
  }).immediate();

  res.json(updated);
}));

router.put('/change-password', authenticate, passwordConfirmationLimiter, passwordRoute(async (req, res) => {
  const { currentPassword, newPassword } = req.body;

  if (typeof currentPassword !== 'string' || typeof newPassword !== 'string'
      || !currentPassword || !newPassword || newPassword.length > 1024 || currentPassword.length > 1024) {
    return res.status(400).json({ error: 'Senha atual e nova senha são obrigatórias.' });
  }

  if (newPassword.length < 8) {
    return res.status(400).json({ error: 'A nova senha deve ter no mínimo 8 caracteres.' });
  }

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.user.id);
  if (!user) {
    return res.status(404).json({ error: 'Usuário não encontrado.' });
  }

  const valid = await passwords.compare(currentPassword, user.password);
  if (!valid) {
    return res.status(401).json({ error: 'Senha atual incorreta.' });
  }

  const hash = await passwords.hash(newPassword, 10);
  const token = db.transaction(() => {
    revalidatePasswordActor(req);
    unchangedPasswordUser(db, user);
    db.prepare('UPDATE users SET password = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(hash, req.user.id);
    db.prepare('UPDATE password_reset_tokens SET used = 1 WHERE user_id = ?').run(req.user.id);
    logActivityStrict({ user: req.user, action: 'change_password', module: 'auth', entityType: 'user',
      entityId: req.user.id, description: 'Senha alterada; sessões anteriores invalidadas.', isCritical: true, req });
    return issueUserToken(req.user.id);
  }).immediate();
  setMediaCookie(res, token);

  res.json({ message: 'Senha alterada com sucesso.', token });
}));

module.exports = router;
