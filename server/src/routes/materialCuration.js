const router = require('express').Router();
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { verifyUserToken } = require('../services/authSessions');
const { materialSnapshot, searchSkills, history, receipt, reviewMaterial } = require('../services/materialCuration');
router.use(authenticate, (_req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
router.get('/materials/:id/skills', (req, res, next) => {
  try {
    const { associations } = materialSnapshot(db, req.params.id);
    res.json({ associations: associations.map(({ id, code, description, gradeName, status, reason, location }) => ({ id, code, description, gradeName, status, reason, location })) });
  } catch (e) { next(e); }
});
router.use(requireAdmin);
router.get('/skills', (req, res, next) => { try { res.json(searchSkills(db, req.query)); } catch (e) { next(e); } });
router.get('/operations/:key', (req, res, next) => { try { res.json(receipt(db, req.user.id, req.params.key)); } catch (e) { next(e); } });
router.get('/materials/:id/history', (req, res, next) => { try { res.json(history(db, req.params.id, req.query)); } catch (e) { next(e); } });
router.get('/materials/:id', (req, res, next) => { try { res.json(materialSnapshot(db, req.params.id)); } catch (e) { next(e); } });
router.post('/materials/:id/reviews', (req, res, next) => {
  try {
    const actor = verifyUserToken(req.authToken).user;
    res.json(reviewMaterial(db, { actor, materialId: req.params.id, key: req.get('Idempotency-Key'), body: req.body, req }));
  } catch (e) { next(e); }
});
router.use((e, _req, res, next) => { if (e.status && e.code) res.status(e.status).json({ code: e.code, error: e.message }); else next(e); });
module.exports = router;
