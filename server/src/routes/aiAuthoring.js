const express = require('express');
const { authenticate } = require('../middleware/auth');
const { verifyUserToken } = require('../services/authSessions');
const { createAiAuthoring, AiAuthoringError, authorize } = require('../services/aiAuthoring');
function createRouter(db, dependencies) {
  const router = express.Router(), service = createAiAuthoring(db, dependencies);
  router.use((_req, res, next) => { res.setHeader('Cache-Control','private, no-store'); res.vary('Authorization'); next(); });
  router.use(authenticate);
  const handler = fn => async (req, res) => {
    try {
      authorize(db, req.user);
      if (Object.keys(req.query).length) throw new AiAuthoringError(400, 'invalid_brief');
      const result = await fn(req);
      // A generation may outlive a revoked login. Do not send its result to a stale session.
      try { verifyUserToken(req.authToken); } catch { return res.status(401).json({ error: 'Sua sessão expirou.' }); }
      authorize(db, req.user); return res.json(result);
    } catch (error) {
      return res.status(error instanceof AiAuthoringError ? error.status : 503).json({
        code: error instanceof AiAuthoringError ? error.code : 'generation_unavailable',
        error: error instanceof AiAuthoringError ? error.message : 'Não foi possível concluir a ajuda de IA. Consulte seu último pedido antes de gerar novamente.',
      });
    }
  };
  router.get('/', handler(req => service.bootstrap(req.user)));
  router.post('/brief', handler(req => service.prepare(req.body)));
  router.post('/requests', handler(req => service.request(req.user, req.body, req.get('Idempotency-Key'))));
  router.get('/requests/by-key/:key', handler(req => service.getByKey(req.user, req.params.key)));
  router.get('/requests/:id', handler(req => service.get(req.user, req.params.id)));
  router.post('/requests/:id/cancel', handler(req => {
    if (req.body && Object.keys(req.body).length) throw new AiAuthoringError(400,'invalid_brief');
    return service.cancel(req.user, req.params.id);
  }));
  router.post('/requests/:id/review', handler(req => service.review(req.user, req.params.id, req.body)));
  return router;
}
module.exports = { createRouter };
