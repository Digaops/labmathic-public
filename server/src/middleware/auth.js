const { verifyUserToken } = require('../services/authSessions');

function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Token não fornecido.' });
  }

  const token = authHeader.slice(7);
  try {
    const session = verifyUserToken(token);
    req.user = session.user;
    req.authToken = token;
    req.authExpiresAt = session.expiresAt;
  } catch (error) {
    if (error.code?.startsWith('SQLITE_')) return next(error);
    return res.status(401).json({ error: 'Token inválido ou expirado.' });
  }
  return next();
}

function requireAdmin(req, res, next) {
  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso restrito a administradores.' });
  }
  next();
}

module.exports = { authenticate, requireAdmin };
