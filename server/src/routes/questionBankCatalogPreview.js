const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const {
  QuestionBankCatalogPreviewError,
  getQuestionBankCatalogPreview,
  getQuestionBankCatalogPreviewItem,
} = require('../services/questionBankCatalogPreview');

const router = express.Router();
const FEATURE_KEY = 'question_bank.catalog_preview';

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  next();
}

function requireCatalogPreviewFlag(req, res, next) {
  const currentUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user?.id);
  if (!currentUser) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const decision = evaluateFeatureFlag(db, FEATURE_KEY, currentUser);
  if (!decision.enabled) {
    return res.status(404).json({
      error: 'O laboratório do Banco de Questões 2.0 ainda não está disponível.',
      code: 'feature_disabled',
    });
  }
  return next();
}

function handleDomainError(error, res) {
  if (error instanceof QuestionBankCatalogPreviewError) {
    res.status(error.status).json({ error: error.message, code: error.code });
    return true;
  }
  return false;
}

router.use(noStore, authenticate, requireCatalogPreviewFlag);

router.get('/catalog', (req, res) => {
  try {
    res.json(getQuestionBankCatalogPreview(req.query));
  } catch (error) {
    if (!handleDomainError(error, res)) throw error;
  }
});

router.get('/items/:itemId', (req, res) => {
  try {
    res.json(getQuestionBankCatalogPreviewItem(req.params.itemId));
  } catch (error) {
    if (!handleDomainError(error, res)) throw error;
  }
});

module.exports = router;
