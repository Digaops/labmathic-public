const { verifyUserToken } = require('./authSessions');
const { PasswordOperationError } = require('./passwordOperations');

// Express 4 doesn't forward rejected async route promises itself.
const passwordRoute = handler => (req, res, next) => Promise.resolve().then(() => handler(req, res)).catch(next);

function revalidatePasswordActor(req, admin = false) {
  try {
    req.user = verifyUserToken(req.authToken).user;
  } catch (error) {
    if (error.code?.startsWith('SQLITE_')) throw error;
    throw new PasswordOperationError(401, 'SESSION_CHANGED', 'Sua sessão mudou ou expirou. Entre novamente.');
  }
  if (admin && req.user.role !== 'admin') throw new PasswordOperationError(403, 'ADMIN_REQUIRED', 'Acesso restrito a administradores.');
}

function unchangedPasswordUser(database, previous, status = 409) {
  const current = database.prepare('SELECT * FROM users WHERE id = ?').get(previous.id);
  if (!current || current.password !== previous.password || current.auth_version !== previous.auth_version
      || current.email !== previous.email || current.role !== previous.role) {
    throw new PasswordOperationError(status, 'ACCOUNT_CHANGED', 'A conta mudou durante a operação. Atualize a página e tente novamente.');
  }
  return current;
}

module.exports = { passwordRoute, revalidatePasswordActor, unchangedPasswordUser };
