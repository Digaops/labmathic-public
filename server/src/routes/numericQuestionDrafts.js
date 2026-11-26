const router = require('express').Router();
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { TypedQuestionAuthoringError } = require('../services/typedQuestionAuthoring');
const { getNumericDraft, listNumericDrafts, saveNumericDraft, checkNumericDraft, previewNumericDraft, prepareNumericDraftPrint } = require('../services/numericQuestionDrafts');
const { logActivityStrict } = require('../helpers/activity');
const { listNumericReviews, getNumericReview, submitNumericReview, decideNumericReview, createNumericVersion } = require('../services/numericEditorial');
const fields = ['gradeId','unitId','skillId','statement','supportText','unit','answer','explanation','difficulty'];
function body(req, allowed) {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
    || Object.keys(req.body).some(key => !allowed.includes(key))) {
    throw new TypedQuestionAuthoringError(400, 'invalid_request_shape', 'A requisição contém campos inválidos.');
  }
  return req.body;
}
function handle(fn, create = false) {
  return (req, res) => {
    try {
      const result = fn(req);
      res.status(create && !result.replayed ? 201 : 200).json(result);
    } catch (error) {
      const known = error instanceof TypedQuestionAuthoringError;
      res.status(known ? error.status : 500).json({ code: known ? error.code : 'numeric_draft_unavailable',
        error: known ? error.message : 'Não foi possível confirmar a operação. Seus campos foram preservados.' });
    }
  };
}
router.use((_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
router.use(authenticate);
router.get('/reviews/queue', handle(req => listNumericReviews(db, { actor:req.user, page:req.query.page === undefined ? 1 : Number(req.query.page), status:req.query.status ?? 'pending' })));
router.get('/reviews/:reviewId', handle(req => getNumericReview(db, { actor:req.user, publicId:req.params.reviewId })));
router.post('/reviews/:reviewId/decision', handle(req => {
  const input=body(req,['expectedRevision','decision','reason']);
  if(!['approved','rejected'].includes(input.decision)) throw new TypedQuestionAuthoringError(400,'invalid_decision','Escolha aprovar ou pedir ajustes.');
  return decideNumericReview(db,{actor:req.user,publicId:req.params.reviewId,...input,idempotencyKey:req.get('Idempotency-Key')});
}));
router.post('/reviews/:reviewId/withdraw', handle(req => decideNumericReview(db,{actor:req.user,publicId:req.params.reviewId,
  ...body(req,['expectedRevision']),decision:'cancelled',reason:'Envio retirado pelo professor para conferir e ajustar a questão.',idempotencyKey:req.get('Idempotency-Key')})));
router.get('/', handle(req => listNumericDrafts(db, { actor: req.user, page: req.query.page === undefined ? 1 : Number(req.query.page), search: req.query.search ?? '' })));
router.get('/:publicId', handle(req => getNumericDraft(db, { actor: req.user, publicId: req.params.publicId })));
router.post('/', handle(req => saveNumericDraft(db, { actor: req.user, input: body(req, fields), idempotencyKey: req.get('Idempotency-Key') }), true));
router.patch('/:publicId', handle(req => saveNumericDraft(db, { actor: req.user, publicId: req.params.publicId,
  input: body(req, [...fields, 'expectedRevision']), idempotencyKey: req.get('Idempotency-Key') })));
router.post('/:publicId/check', handle(req => checkNumericDraft(db, { actor: req.user, publicId: req.params.publicId,
  ...body(req, ['response', 'expectedRevision']) })));
router.post('/:publicId/preview', handle(req => previewNumericDraft(db, { actor: req.user, publicId: req.params.publicId,
  ...body(req, ['expectedRevision']) })));
router.post('/:publicId/print', handle(req => prepareNumericDraftPrint(db, { actor: req.user, publicId: req.params.publicId,
  ...body(req, ['expectedRevision', 'expectedFingerprint', 'audience']) }, (payload, database) => logActivityStrict({ ...payload, req }, database))));
router.post('/:publicId/submit-review', handle(req => submitNumericReview(db,{actor:req.user,publicId:req.params.publicId,
  ...body(req,['expectedRevision','confirmed']),idempotencyKey:req.get('Idempotency-Key')})));
router.post('/:publicId/versions', handle(req => createNumericVersion(db,{actor:req.user,publicId:req.params.publicId,
  ...body(req,['expectedRevision']),idempotencyKey:req.get('Idempotency-Key')})));
module.exports = router;
