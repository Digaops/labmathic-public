const db = require('../database');
const { evaluateFeatureFlag } = require('../services/featureFlags');

function requireFeatureFlag(flagKey) {
  return (req, res, next) => {
    const decision = evaluateFeatureFlag(db, flagKey, req.user);
    if (!decision.enabled) {
      return res.status(404).json({ error: 'Funcionalidade indisponível.' });
    }
    return next();
  };
}

module.exports = { requireFeatureFlag };
