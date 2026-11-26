const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { FLAG, publication, searchMunicipalities, portrait } = require('../services/municipalIndicators');
const router = express.Router();
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); res.setHeader('Vary', 'Authorization'); next(); });
router.use(authenticate, (req, res, next) => {
  if (!['admin', 'professor'].includes(req.user.role)) return res.status(403).json({ error: 'Consulta não disponível para este perfil.' });
  if (!evaluateFeatureFlag(db, FLAG, req.user).enabled) return res.status(404).json({ error: 'Retrato da rede ainda não liberado para esta conta.', code: 'feature_disabled' });
  return next();
});
const invalid = res => res.status(400).json({ error: 'Confira o município, a etapa e o ano dos dados.', code: 'invalid_portrait_query' });
router.get('/', (req, res) => Object.keys(req.query).length ? invalid(res) : res.json(publication(db)));
router.get('/municipalities', (req, res) => {
  if (Object.keys(req.query).some(k => k !== 'q') || typeof req.query.q !== 'string' || req.query.q.trim().length < 2 || req.query.q.length > 80) return invalid(res);
  return res.json(searchMunicipalities(db, req.query.q));
});
router.get('/municipalities/:ibgeCode', (req, res) => {
  if (!/^\d{7}$/.test(req.params.ibgeCode) || Object.keys(req.query).some(k => !['stage', 'year'].includes(k))
    || !['elementary_initial', 'elementary_final'].includes(req.query.stage) || !['2023', '2025'].includes(req.query.year)) return invalid(res);
  const result = portrait(db, { ibgeCode: req.params.ibgeCode, stage: req.query.stage, year: Number(req.query.year) });
  return result ? res.json(result) : res.status(404).json({ error: 'Município não encontrado no catálogo conferido.', code: 'municipality_not_found' });
});
module.exports = router;
