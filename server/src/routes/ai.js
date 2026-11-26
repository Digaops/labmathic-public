const express = require('express');
const { authenticate } = require('../middleware/auth');
const { verifyUserToken } = require('../services/authSessions');
const { AiError, fail } = require('../services/aiErrors');
const { createAiQuestions } = require('../services/aiQuestions');
const jsonParser = express.json({ limit: '16kb', strict: true });
function parseJson(req, res, next) {
  jsonParser(req, res, error => {
    if (!error) return next();
    res.setHeader('Cache-Control', 'private, no-store');
    const safe = new AiError(error.type === 'entity.too.large' ? 'AI_PROMPT_TOO_LONG' : 'AI_INVALID_REQUEST');
    return res.status(error.type === 'entity.too.large' ? 413 : 400).json({ code: safe.code, error: safe.message });
  });
}
function createRouter(db, dependencies) {
  const router = express.Router(), service = createAiQuestions(db, dependencies);
  router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.vary('Authorization'); next(); });
  router.use(authenticate);
  router.use(parseJson);
  router.post('/questions/generate', async (req, res) => {
    try {
      if (Object.keys(req.query).length) fail('AI_INVALID_REQUEST');
      const result = await service.generate(req.user, req.body, req.get('Idempotency-Key'), () => {
        try { verifyUserToken(req.authToken); } catch { fail('AI_FORBIDDEN'); }
      });
      return res.json(result);
    } catch (error) {
      const safe = error instanceof AiError ? error : new AiError('AI_USAGE_UNAVAILABLE');
      if (safe.code === 'AI_RATE_LIMITED') res.setHeader('Retry-After', '60');
      return res.status(safe.status).json({ code: safe.code, error: safe.message });
    }
  });
  return router;
}
module.exports = { createRouter, parseJson };
