const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const {
  TypedQuestionFeedbackPreviewError,
  getFeedbackPreviewCatalog,
  getFeedbackPreviewExample,
} = require('../services/typedQuestionFeedbackPreview');

const router = express.Router();
const FEATURE_KEY = 'question_bank.feedback_preview';

function noStore(_req, res, next) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  next();
}

function requirePreviewFlag(req, res, next) {
  const currentUser = db.prepare('SELECT id, role FROM users WHERE id = ?').get(req.user?.id);
  if (!currentUser) return res.status(401).json({ error: 'Usuário não autenticado.' });
  const decision = evaluateFeatureFlag(db, FEATURE_KEY, currentUser);
  if (!decision.enabled) {
    return res.status(404).json({
      error: 'O laboratório de devolutivas ainda não está disponível.',
      code: 'feature_disabled',
    });
  }
  return next();
}

router.use(noStore, authenticate, requirePreviewFlag);

router.get('/catalog', (_req, res) => {
  res.json(getFeedbackPreviewCatalog());
});

router.get('/examples/:exampleId', (req, res) => {
  try {
    res.json(getFeedbackPreviewExample(req.params.exampleId, req.query.view || 'teacher'));
  } catch (error) {
    if (error instanceof TypedQuestionFeedbackPreviewError) {
      return res.status(error.status).json({ error: error.message, code: error.code });
    }
    throw error;
  }
});

module.exports = router;
