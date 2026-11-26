const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const cycle = require('../services/pedagogicalCycle');
const report = require('../services/pedagogicalReport');
const periodCopy = require('../services/pedagogicalPeriodCopy');
const router = express.Router();
router.use((_req, res, next) => {
  res.set({ 'Cache-Control': 'no-store', 'Surrogate-Control': 'no-store', Vary: 'Authorization' }); next();
}, authenticate, (req, res, next) => {
  const user = db.prepare('SELECT id, name, role FROM users WHERE id = ?').get(req.user.id);
  if (!user || user.role !== 'professor') return res.status(403).json({ error: 'Ciclo restrito ao professor responsável pela turma.' });
  const enabled = key => evaluateFeatureFlag(db, key, user).enabled;
  if (!['pedagogy.operational_cycle', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results'].every(enabled))
    return res.status(404).json({ error: 'Ciclo pedagógico indisponível.', code: 'feature_disabled' });
  req.user = user;
  req.cycleCapabilities = { institutions: enabled('institutions.read_model'), recovery: enabled('classes.learning_recovery') };
  next();
});
const handle = fn => (req, res, next) => {
  try { fn(req, res); } catch (error) {
    if (error instanceof cycle.PedagogicalCycleError) return res.status(error.status).json({ error: error.message, code: error.code });
    next(error);
  }
};
router.get('/classes', handle((req, res) => res.json(cycle.listClasses(db, req.user.id, req.query, req.cycleCapabilities))));
router.get('/classes/:classId', handle((req, res) => res.json(cycle.classOverview(db, req.user.id, req.params.classId, req.query, req.cycleCapabilities))));
const assessmentPath = '/classes/:classId/assessments/:assessmentId';
router.get('/classes/:classId/period-report', handle((req, res) => res.json(cycle.periodOverview(db, req.user.id, req.params.classId, req.query, req.cycleCapabilities))));
router.get('/classes/:classId/period-report/copy', handle((req, res) => res.json(cycle.readPeriodCopy(db, req.user.id, req.params.classId, req.query, req.cycleCapabilities))));
router.post('/classes/:classId/period-report/export', handle((req, res) => {
  const result = periodCopy.exportPeriodCopy(db, req.user, req.params.classId, req.body, req, req.cycleCapabilities);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="avaliacoes-do-periodo.csv"',
    'X-Content-Type-Options': 'nosniff', 'X-Report-Revision': result.revision }).send(result.csv);
}));
router.get(`${assessmentPath}/report`, handle((req, res) => res.json(report.readReport(db, req.user.id, req.params.classId, req.params.assessmentId, req.cycleCapabilities))));
router.post(`${assessmentPath}/report/export`, handle((req, res) => {
  const result = report.exportReport(db, req.user, req.params.classId, req.params.assessmentId, req.body, req, req.cycleCapabilities);
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="relatorio-da-turma.csv"',
    'X-Content-Type-Options': 'nosniff', 'X-Report-Revision': result.revision }).send(result.csv);
}));
router.post(`${assessmentPath}/report/print`, handle((req, res) => {
  const result = report.prepareReportPrint(db, req.user, req.params.classId, req.params.assessmentId, req.body, req, req.cycleCapabilities);
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Report-Revision': result.revision }).json(result);
}));
router.get(assessmentPath, handle((req, res) => res.json(cycle.cycleDetail(db, req.user.id, req.params.classId, req.params.assessmentId, req.cycleCapabilities))));
router.get(`${assessmentPath}/feedback`, handle((req, res) => res.json(cycle.feedbackHistory(db, req.user.id, req.params.classId, req.params.assessmentId, req.query, req.cycleCapabilities))));
router.post(`${assessmentPath}/feedback`, handle((req, res) => {
  const result = cycle.saveFeedback(db, req.user, req.params.classId, req.params.assessmentId, req.body, req.get('Idempotency-Key'), req, req.cycleCapabilities);
  res.status(result.replayed ? 200 : 201).json(result);
}));
module.exports = router;
