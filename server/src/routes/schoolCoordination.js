const router = require('express').Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { listSchools, schoolClasses, classSupport, classSkills, supportComparison } = require('../services/schoolCoordination');
router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'Surrogate-Control': 'no-store', Vary: 'Authorization' }); next(); }, authenticate);
router.get('/schools', (req, res, next) => { try { res.json(listSchools(db, req.user, req.query, req)); } catch (e) { next(e); } });
router.get('/schools/:id/classes', (req, res, next) => { try { res.json(schoolClasses(db, req.user, req.params.id, req.query, req)); } catch (e) { next(e); } });
router.get('/schools/:id/classes/:classId/skills', (req, res, next) => {
  try { res.json(classSkills(db, req.user, req.params.id, req.params.classId, req.query, req)); } catch (e) { next(e); }
});
router.get('/schools/:id/classes/:classId/support', (req, res, next) => {
  try { res.json(classSupport(db, req.user, req.params.id, req.params.classId, req.query, req)); } catch (e) { next(e); }
});
router.get('/schools/:id/classes/:classId/support/:planId/comparison', (req, res, next) => {
  try { res.json(supportComparison(db, req.user, req.params.id, req.params.classId, req.params.planId, req.query, req)); } catch (e) { next(e); }
});
router.use((e, _req, res, next) => { if (e.status && e.code) res.status(e.status).json({ code: e.code, error: e.message }); else next(e); });
module.exports = router;
