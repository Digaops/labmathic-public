const express = require('express');

const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const {
  FEATURE_KEY,
  TypedQuestionAuthoringError,
  activateTypedVersion,
  adoptTypedQuestion,
  cancelTypedReview,
  createNextTypedVersion,
  decideTypedReview,
  getTypedAuthoringState,
  listTypedReviewQueue,
  submitTypedReview,
  updateTypedDraft,
} = require('../services/typedQuestionAuthoring');

const router = express.Router();

function fail(status, code, message, details) {
  throw new TypedQuestionAuthoringError(status, code, message, details);
}

function strictBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'invalid_request_shape', 'O corpo da requisição deve ser um objeto JSON.');
  }
  const unexpected = Object.keys(body).filter((field) => !allowedFields.includes(field));
  if (unexpected.length > 0) {
    fail(
      400,
      'invalid_request_shape',
      'A requisição possui campos não permitidos.',
      { unexpected },
    );
  }
  return body;
}

function idempotencyKey(req) {
  return req.get('Idempotency-Key');
}

function mapError(error, res) {
  if (error instanceof TypedQuestionAuthoringError) {
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (process.env.NODE_ENV !== 'production') {
    console.error('[typed-question-authoring]', error.message);
  }
  return res.status(500).json({
    error: 'Não foi possível concluir a operação de autoria.',
    code: 'typed_authoring_unavailable',
  });
}

function write(handler, { created = false } = {}) {
  return (req, res) => {
    try {
      const result = handler(req);
      return res.status(created && !result.replayed ? 201 : 200).json(result);
    } catch (error) {
      return mapError(error, res);
    }
  };
}

function requireTypedFeature(req, res, next) {
  const userId = Number(req.user?.id);
  const principal = Number.isInteger(userId) && userId > 0
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;
  if (!principal) {
    return res.status(401).json({ error: 'Sessão inválida.', code: 'invalid_principal' });
  }
  req.user = { ...req.user, ...principal };
  const decision = evaluateFeatureFlag(db, FEATURE_KEY, principal);
  if (!decision.enabled) {
    return res.status(404).json({
      error: 'A autoria tipada ainda não está disponível.',
      code: 'feature_disabled',
    });
  }
  return next();
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
router.use(authenticate, requireTypedFeature);

router.get('/reviews', (req, res) => {
  try {
    return res.json({
      reviews: listTypedReviewQueue(db, {
        actor: req.user,
        limit: req.query.limit === undefined ? 50 : req.query.limit,
      }),
    });
  } catch (error) {
    return mapError(error, res);
  }
});

router.get('/versions/:versionPublicId', (req, res) => {
  try {
    return res.json(getTypedAuthoringState(db, {
      actor: req.user,
      versionPublicId: req.params.versionPublicId,
    }));
  } catch (error) {
    return mapError(error, res);
  }
});

router.post('/items', write((req) => {
  const body = strictBody(req.body, ['questionId', 'definition']);
  return adoptTypedQuestion(db, {
    actor: req.user,
    questionId: body.questionId,
    definition: body.definition,
    idempotencyKey: idempotencyKey(req),
  });
}, { created: true }));

router.patch('/versions/:versionPublicId/draft', write((req) => {
  const body = strictBody(req.body, ['expectedRevision', 'definition']);
  return updateTypedDraft(db, {
    actor: req.user,
    versionPublicId: req.params.versionPublicId,
    expectedRevision: body.expectedRevision,
    definition: body.definition,
    idempotencyKey: idempotencyKey(req),
  });
}));

router.post('/items/:itemPublicId/versions', write((req) => {
  const body = strictBody(req.body, ['expectedCurrentRevision']);
  return createNextTypedVersion(db, {
    actor: req.user,
    itemPublicId: req.params.itemPublicId,
    expectedCurrentRevision: body.expectedCurrentRevision,
    idempotencyKey: idempotencyKey(req),
  });
}, { created: true }));

router.post('/versions/:versionPublicId/reviews', write((req) => {
  const body = strictBody(req.body, ['expectedRevision']);
  return submitTypedReview(db, {
    actor: req.user,
    versionPublicId: req.params.versionPublicId,
    expectedRevision: body.expectedRevision,
    idempotencyKey: idempotencyKey(req),
  });
}, { created: true }));

router.post('/reviews/:reviewPublicId/decision', write((req) => {
  const body = strictBody(req.body, ['expectedRevision', 'decision', 'reason']);
  return decideTypedReview(db, {
    actor: req.user,
    reviewPublicId: req.params.reviewPublicId,
    expectedRevision: body.expectedRevision,
    decision: body.decision,
    reason: body.reason,
    idempotencyKey: idempotencyKey(req),
  });
}));

router.post('/reviews/:reviewPublicId/cancel', write((req) => {
  const body = strictBody(req.body, ['expectedRevision', 'reason']);
  return cancelTypedReview(db, {
    actor: req.user,
    reviewPublicId: req.params.reviewPublicId,
    expectedRevision: body.expectedRevision,
    reason: body.reason,
    idempotencyKey: idempotencyKey(req),
  });
}));

router.post('/versions/:versionPublicId/activate', write((req) => {
  const body = strictBody(req.body, ['expectedItemRevision', 'expectedCurrentRevision']);
  return activateTypedVersion(db, {
    actor: req.user,
    versionPublicId: req.params.versionPublicId,
    expectedItemRevision: body.expectedItemRevision,
    expectedCurrentRevision: body.expectedCurrentRevision,
    idempotencyKey: idempotencyKey(req),
  });
}));

module.exports = router;
