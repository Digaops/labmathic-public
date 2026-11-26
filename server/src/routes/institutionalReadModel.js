const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { getInstitutionalReadModel } = require('../services/institutionalReadModel');

const router = express.Router();
const FEATURE_KEY = 'institutions.read_model';

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  next();
});
router.use(authenticate);

router.get('/', (req, res, next) => {
  try {
    const currentUser = db.prepare(`
      SELECT id, role
      FROM users
      WHERE id = ?
    `).get(req.user.id);
    if (!currentUser) {
      return res.status(401).json({
        error: 'Sessão inválida ou expirada.',
        code: 'institutional_principal_not_found',
      });
    }

    const decision = evaluateFeatureFlag(db, FEATURE_KEY, currentUser);
    if (!decision.enabled) {
      return res.status(404).json({
        error: 'Contexto institucional indisponível.',
        code: 'feature_disabled',
      });
    }

    return res.json(getInstitutionalReadModel(db, currentUser.id));
  } catch (error) {
    if (error?.code === 'institutional_principal_not_found') {
      return res.status(401).json({ error: 'Sessão inválida ou expirada.', code: error.code });
    }
    if (error?.code === 'institutional_role_unsupported') {
      return res.status(403).json({ error: 'Perfil institucional indisponível.', code: error.code });
    }
    return next(error);
  }
});

module.exports = router;
