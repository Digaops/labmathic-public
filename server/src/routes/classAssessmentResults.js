const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const { logActivity } = require('../helpers/activity');
const { numericItems, scoredResponses, normalizeNumericResponse, saveNumericResponse, numericDiagnostic, enabled: numericEnabled } = require('../services/numericAssessments');
const { finalizePendingStudentOnlineAttempts } = require('../services/studentAssessmentSubmission');
const {
  analyzeClassAssessment,
  calculatePercentage,
} = require('../services/classAssessmentAnalysis');
const { buildLearningRecoveryPreview } = require('../services/learningRecoveryPreview');
const {
  LearningRecoveryConfirmationError,
  confirmLearningRecoveryPlan,
} = require('../services/learningRecoveryConfirmation');
const {
  activateLearningRecoveryPlan,
  getLearningRecoveryPlan,
  updateLearningRecoveryPlanDraft,
} = require('../services/learningRecoveryPlanLifecycle');
const {
  VALID_RECOVERY_PLAN_STATUSES,
  listLearningRecoveryPlans,
  recoveryPlanCounts,
} = require('../services/learningRecoveryPlans');
const {
  completeLearningRecoveryExecution,
  createLearningRecoveryExecution,
  learningRecoveryExecutionResourceOptions,
  updateLearningRecoveryExecutionResources,
  updateLearningRecoveryExecutionLesson,
} = require('../services/learningRecoveryExecution');
const {
  createLearningRecoveryMonitoring,
  learningRecoveryMonitoringOptions,
} = require('../services/learningRecoveryMonitoring');
const {
  StudentAssessmentFeedbackError,
  releaseStudentFeedback,
  releasedFeedback,
  withFeedbackProgress,
} = require('../services/studentAssessmentFeedback');

const router = express.Router();

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function requireProfessor(req, res, next) {
  const currentUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .get(req.user.id);
  if (!currentUser || currentUser.role !== 'professor') {
    return res.status(403).json({ error: 'Acesso restrito a professores.' });
  }
  req.user = { ...req.user, ...currentUser };
  return next();
}

function ownedAssessment(classPublicId, assessmentPublicId, teacherId) {
  return db.prepare(`
    SELECT
      assignment.*,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      school_class.status AS class_status
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
    WHERE school_class.public_id = ?
      AND assignment.public_id = ?
      AND assignment.owner_teacher_id = ?
      AND school_class.owner_teacher_id = ?
  `).get(classPublicId, assessmentPublicId, teacherId, teacherId);
}

function availableAssessment(req, res) {
  const assignment = ownedAssessment(
    req.params.classPublicId,
    req.params.assessmentPublicId,
    req.user.id
  );
  if (!assignment) {
    res.status(404).json({ error: 'Aplicação não encontrada.' });
    return null;
  }
  if (!['open', 'closed'].includes(assignment.status)) {
    res.status(409).json({
      error: 'Os resultados ficam disponíveis quando a aplicação está aberta ou encerrada.',
    });
    return null;
  }
  return assignment;
}

function ownedParticipant(assignment, studentPublicId) {
  return db.prepare(`
    SELECT
      participant.*,
      student.public_id AS student_public_id,
      student.display_name
    FROM class_assessment_participants participant
    JOIN students student ON student.id = participant.student_id
    WHERE participant.assignment_id = ?
      AND participant.class_id = ?
      AND participant.owner_teacher_id = ?
      AND student.public_id = ?
  `).get(
    assignment.id,
    assignment.class_id,
    assignment.owner_teacher_id,
    studentPublicId
  );
}

function assessmentItems(assignmentId) {
  const numeric=numericItems(db,assignmentId);
  const items = db.prepare(`
    SELECT
      item.id,
      item.question_code_snapshot,
      item.statement_snapshot,
      item.skill_code_snapshot,
      item.skill_description_snapshot,
      item.sort_order
    FROM class_assessment_items item
    WHERE item.assignment_id = ?
    ORDER BY item.sort_order, item.id
  `).all(assignmentId);
  const options = db.prepare(`
    SELECT id, assessment_item_id, option_label, option_text_snapshot, is_correct, sort_order
    FROM class_assessment_item_options
    WHERE assignment_id = ?
    ORDER BY assessment_item_id, sort_order, id
  `).all(assignmentId);
  const optionsByItem = new Map();
  options.forEach((option) => {
    const list = optionsByItem.get(option.assessment_item_id) || [];
    list.push({
      id: option.id,
      label: option.option_label,
      text: option.option_text_snapshot,
      isCorrect: option.is_correct === 1,
    });
    optionsByItem.set(option.assessment_item_id, list);
  });
  return items.map((item, index) => ({
    id: item.id,
    numericDefinition:numeric.get(item.id) || null,
    number: index + 1,
    code: item.question_code_snapshot,
    statement: item.statement_snapshot,
    skillCode: item.skill_code_snapshot,
    skillDescription: item.skill_description_snapshot,
    options: optionsByItem.get(item.id) || [],
  }));
}

function currentAttempt(participantId) {
  return db.prepare(`
    SELECT *
    FROM class_assessment_attempts
    WHERE participant_id = ? AND status <> 'voided'
    ORDER BY attempt_number DESC
    LIMIT 1
  `).get(participantId);
}

function finalizeExpiredOnlineAttempts(assignment, req) {
  const finalize = db.transaction(() => finalizePendingStudentOnlineAttempts(
    db,
    assignment.id,
    { expiredOnly: true }
  ));
  const submitted = finalize.immediate();
  submitted.forEach(({ attempt, studentPublicId }) => {
    logActivity({
      user: req.user,
      action: 'auto_submit_student_online_assessment',
      module: 'classes',
      entityType: 'class_assessment_attempt',
      entityId: attempt.id,
      entityTitle: assignment.title_snapshot,
      description: `As respostas salvas de um estudante em "${assignment.title_snapshot}" foram enviadas automaticamente ao fim do prazo.`,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        student_id: studentPublicId,
        answered_count: attempt.answered_count,
        question_count: attempt.question_count,
        submission_channel: 'student_online',
        automatic: true,
        reason: assignment.status === 'closed' ? 'assessment_closed' : 'time_limit',
      },
      req,
    });
  });
}

function serializeEntry(assignment, participant) {
  const items = assessmentItems(assignment.id);
  const attempt = currentAttempt(participant.id);
  const selections = attempt ? db.prepare(`
    SELECT assessment_item_id, selected_option_id, is_correct, numeric_value
    FROM ${scoredResponses(db)}
    WHERE attempt_id = ?
  `).all(attempt.id) : [];
  const responseByItem = new Map(selections.map((response) => [
    response.assessment_item_id,
    response,
  ]));

  return {
    assessment: {
      id: assignment.public_id,
      title: assignment.title_snapshot,
      status: assignment.status,
      questionCount: assignment.question_count,
    },
    participant: {
      id: participant.student_public_id,
      displayName: participant.display_name,
    },
    feedback: releasedFeedback(db, {
      assignment_id: assignment.id,
      participant_id: participant.id,
      assignment_status: assignment.status,
    }),
    attempt: attempt ? {
      id: attempt.public_id,
      attemptNumber: attempt.attempt_number,
      status: attempt.status,
      revision: attempt.revision,
      answeredCount: attempt.answered_count,
      correctCount: attempt.correct_count,
      percentage: attempt.score_percentage,
      submittedAt: attempt.submitted_at,
    } : null,
    items: items.map((item) => ({
      id: item.id,
      number: item.number,
      code: item.code,
      statement: item.statement,
      skillCode: item.skillCode,
      skillDescription: item.skillDescription,
      options: item.options.map(({ isCorrect: _isCorrect, ...option }) => option),
      ...(item.numericDefinition ? {questionType:'numeric',unit:item.numericDefinition.content.unit || '',
        numericValue:responseByItem.get(item.id)?.numeric_value ?? null,
        correctNumericValue:attempt?.status==='submitted'?String(item.numericDefinition.answerKey.value):null} : {}),
      selectedOptionId: responseByItem.get(item.id)?.selected_option_id || null,
      isCorrect: attempt?.status === 'submitted'
        ? responseByItem.get(item.id)?.is_correct === 1
        : null,
      correctOptionId: attempt?.status === 'submitted'
        ? item.options.find((option) => option.isCorrect)?.id || null
        : null,
    })),
  };
}

function serializeResults(assignment, actor) {
  return db.transaction(() => withFeedbackProgress(db, actor, assignment,
    analyzeClassAssessment(db, assignment)))();
}

function reviewedDiagnostic(assignment) {
  const numeric=numericDiagnostic(db,assignment);
  if(numeric)return numeric;
  if (!assignment.source_question_set_id) return null;
  return db.prepare(`
    SELECT
      diagnostic.question_set_id,
      diagnostic.grade_id,
      diagnostic.algorithm_version,
      review.confirmation_version,
      review.reviewed_at
    FROM diagnostic_question_sets diagnostic
    JOIN diagnostic_question_set_reviews review
      ON review.question_set_id = diagnostic.question_set_id
      AND review.owner_teacher_id = diagnostic.owner_teacher_id
    WHERE diagnostic.question_set_id = ?
      AND diagnostic.owner_teacher_id = ?
  `).get(assignment.source_question_set_id, assignment.owner_teacher_id);
}

function sendError(error, res, next) {
  const message = String(error?.message || '');
  if (message.includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: 'As respostas mudaram em outro acesso. Atualize a tela.' });
  }
  const constraints = new Map([
    ['assessment_attempt_score_mismatch', 'A pontuação calculada ficou inconsistente. Nenhum dado foi enviado.'],
    ['assessment_attempt_responses_incomplete', 'Salve todas as questões, inclusive as deixadas em branco, antes de corrigir.'],
    ['assessment_responses_are_immutable', 'Uma correção enviada não pode ser alterada.'],
    ['assessment_response_score_mismatch', 'A alternativa não corresponde ao snapshot desta questão.'],
  ]);
  for (const [constraint, friendly] of constraints) {
    if (message.includes(constraint)) return res.status(409).json({ error: friendly });
  }
  return next(error);
}

router.get(
  '/recovery-plans',
  authenticate,
  requireProfessor,
  requireFeatureFlag('classes.core'),
  requireFeatureFlag('classes.assessment_assignments'),
  requireFeatureFlag('classes.assessment_results'),
  requireFeatureFlag('classes.learning_recovery'),
  (req, res) => {
    const requestedStatus = String(req.query.status || '').trim();
    if (requestedStatus && !VALID_RECOVERY_PLAN_STATUSES.has(requestedStatus)) {
      return res.status(400).json({ error: 'Situação de plano inválida.' });
    }
    const rawSearch = String(req.query.search || '').replace(/\s+/g, ' ').trim();
    if (rawSearch.length > 80 || /[\u0000-\u001F\u007F]/.test(rawSearch)) {
      return res.status(400).json({ error: 'Busca inválida.' });
    }
    const parsedLimit = Number(req.query.limit || 50);
    const limit = Number.isInteger(parsedLimit) && parsedLimit > 0
      ? Math.min(parsedLimit, 100)
      : 50;

    res.set('Cache-Control', 'private, no-store');
    return res.json({
      data: listLearningRecoveryPlans(db, {
        teacherId: req.user.id,
        status: requestedStatus || null,
        search: rawSearch || null,
        limit,
      }),
      counts: recoveryPlanCounts(db, req.user.id),
    });
  }
);

router.use(
  '/:classPublicId/assessments/:assessmentPublicId/results',
  authenticate,
  requireProfessor,
  requireFeatureFlag('classes.core'),
  requireFeatureFlag('classes.assessment_assignments'),
  requireFeatureFlag('classes.assessment_results')
);

router.use('/:classPublicId/assessments/:assessmentPublicId/results', (_req, res, next) => {
  res.set('Cache-Control', 'private, no-store');
  next();
});

router.get('/:classPublicId/assessments/:assessmentPublicId/results', (req, res) => {
  const assignment = availableAssessment(req, res);
  if (!assignment) return undefined;
  finalizeExpiredOnlineAttempts(assignment, req);
  return res.json(serializeResults(assignment, req.user));
});

router.get(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-preview',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res) => {
    const assignment = availableAssessment(req, res);
    if (!assignment) return undefined;
    if (assignment.status !== 'closed') {
      return res.status(409).json({
        error: 'Encerre a aplicação antes de gerar a prévia de recomposição.',
      });
    }
    const diagnostic = reviewedDiagnostic(assignment);
    if (!diagnostic) {
      return res.status(409).json({
        error: 'A recomposição exige uma avaliação diagnóstica conferida pelo professor.',
      });
    }
    finalizeExpiredOnlineAttempts(assignment, req);
    const submittedCount = db.prepare(`
      SELECT COUNT(*)
      FROM class_assessment_attempts
      WHERE assignment_id = ? AND status = 'submitted'
    `).pluck().get(assignment.id);
    if (!submittedCount) {
      return res.status(409).json({
        error: 'Ainda não há resultados enviados para orientar a recomposição.',
      });
    }

    res.set('Cache-Control', 'private, no-store');
    return res.json({
      ...buildLearningRecoveryPreview(db, assignment, req.user.id),
      diagnostic: {
        algorithmVersion: diagnostic.algorithm_version,
        confirmationVersion: diagnostic.confirmation_version,
        reviewedAt: diagnostic.reviewed_at,
      },
      generatedAt: new Date().toISOString(),
    });
  }
);

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const result = confirmLearningRecoveryPlan(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        idempotencyKey: req.get('Idempotency-Key'),
        body: req.body,
        request: req,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.get(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.put(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const plan = updateLearningRecoveryPlanDraft(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        body: req.body,
        request: req,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ updated: true, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/activate',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const result = activateLearningRecoveryPlan(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        body: req.body,
        request: req,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json(result);
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const result = createLearningRecoveryExecution(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        body: req.body,
        request: req,
      });
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.status(result.created ? 201 : 200).json({ ...result, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.put(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/lessons/:lessonPublicId',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const execution = updateLearningRecoveryExecutionLesson(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        lessonPublicId: req.params.lessonPublicId,
        body: req.body,
        request: req,
      });
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ updated: true, execution, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.get(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/lessons/:lessonPublicId/resources/options',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const options = learningRecoveryExecutionResourceOptions(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        lessonPublicId: req.params.lessonPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json(options);
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.put(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/lessons/:lessonPublicId/resources',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const execution = updateLearningRecoveryExecutionResources(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        lessonPublicId: req.params.lessonPublicId,
        body: req.body,
        request: req,
      });
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ updated: true, execution, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.get(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/monitoring/options',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const options = learningRecoveryMonitoringOptions(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json(options);
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/monitoring',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const result = createLearningRecoveryMonitoring(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        body: req.body,
        request: req,
      });
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.status(result.created ? 201 : 200).json({ ...result, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/recovery-plans/:planPublicId/execution/complete',
  requireFeatureFlag('classes.learning_recovery'),
  (req, res, next) => {
    try {
      const result = completeLearningRecoveryExecution(db, {
        teacher: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
        body: req.body,
        request: req,
      });
      const plan = getLearningRecoveryPlan(db, {
        teacherId: req.user.id,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        planPublicId: req.params.planPublicId,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.json({ ...result, plan });
    } catch (error) {
      if (error instanceof LearningRecoveryConfirmationError) {
        return res.status(error.status).json({
          error: error.message,
          code: error.code,
          ...(error.details ? { details: error.details } : {}),
        });
      }
      return next(error);
    }
  }
);

router.get('/:classPublicId/assessments/:assessmentPublicId/results/participants/:studentPublicId', (req, res) => {
  const assignment = availableAssessment(req, res);
  if (!assignment) return undefined;
  finalizeExpiredOnlineAttempts(assignment, req);
  const participant = ownedParticipant(assignment, req.params.studentPublicId);
  if (!participant) return res.status(404).json({ error: 'Estudante não participa desta aplicação.' });
  return res.json(serializeEntry(assignment, participant));
});

router.put('/:classPublicId/assessments/:assessmentPublicId/results/participants/:studentPublicId', (req, res, next) => {
  try {
    const assignment = availableAssessment(req, res);
    if (!assignment) return undefined;
    const participant = ownedParticipant(assignment, req.params.studentPublicId);
    if (!participant) return res.status(404).json({ error: 'Estudante não participa desta aplicação.' });
    if (participant.status === 'exempted') {
      return res.status(409).json({ error: 'Este estudante está dispensado desta aplicação.' });
    }
    const expectedRevision = Number(req.body?.expectedRevision);
    const submittedResponses = req.body?.responses;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 0 || !Array.isArray(submittedResponses)) {
      return res.status(400).json({ error: 'Respostas ou revisão inválidas.' });
    }

    const items = assessmentItems(assignment.id);
    if (submittedResponses.length !== items.length) {
      return res.status(400).json({ error: 'Envie uma marcação para cada questão, inclusive as deixadas em branco.' });
    }
    const itemById = new Map(items.map((item) => [item.id, item]));
    if(items.some(item=>item.numericDefinition) && !numericEnabled(db,req.user))return res.status(404).json({error:'O registro numérico não está liberado para esta conta.'});
    let normalized;
    try { normalized = submittedResponses.map((response) => ({
      itemId: positiveInteger(response?.itemId),
      optionId: response?.optionId === null ? null : positiveInteger(response?.optionId),
      ...(itemById.get(positiveInteger(response?.itemId))?.numericDefinition ? {numericValue:normalizeNumericResponse(response?.numericValue)} : {}),
    })); } catch(error) { return res.status(400).json({error:error.message}); }
    if (
      normalized.some(({ itemId, optionId }, index) => (
        !itemId
        || (!itemById.get(itemId)?.numericDefinition && submittedResponses[index]?.optionId !== null && !optionId)
        || !itemById.has(itemId)
        || (!itemById.get(itemId)?.numericDefinition && optionId !== null && !itemById.get(itemId).options.some(({ id }) => id === optionId))
      ))
      || new Set(normalized.map(({ itemId }) => itemId)).size !== items.length
    ) {
      return res.status(400).json({ error: 'Uma ou mais respostas não pertencem a esta aplicação.' });
    }

    const save = db.transaction(() => {
      let attempt = currentAttempt(participant.id);
      if (attempt?.status === 'submitted') {
        throw Object.assign(new Error('already_submitted'), { status: 409 });
      }
      if (attempt?.submission_channel === 'student_online') {
        throw Object.assign(new Error('online_in_progress'), { status: 409 });
      }
      if ((attempt?.revision || 0) !== expectedRevision) {
        throw Object.assign(new Error('revision_conflict'), { status: 409 });
      }

      const optionIds = normalized.filter(({ optionId }) => optionId !== null)
        .map(({ optionId }) => optionId);
      const optionScore = new Map();
      if (optionIds.length) {
        const placeholders = optionIds.map(() => '?').join(', ');
        db.prepare(`
          SELECT id, is_correct
          FROM class_assessment_item_options
          WHERE assignment_id = ? AND id IN (${placeholders})
        `).all(assignment.id, ...optionIds).forEach((option) => {
          optionScore.set(option.id, option.is_correct === 1 ? 1 : 0);
        });
      }
      if (optionScore.size !== optionIds.length) {
        throw Object.assign(new Error('invalid_options'), { status: 400 });
      }

      const answeredCount = normalized.filter(r => itemById.get(r.itemId).numericDefinition ? r.numericValue !== null : r.optionId !== null).length;
      if (!attempt) {
        const attemptNumber = db.prepare(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1
          FROM class_assessment_attempts
          WHERE participant_id = ?
        `).pluck().get(participant.id);
        const result = db.prepare(`
          INSERT INTO class_assessment_attempts (
            public_id, participant_id, assignment_id, class_id, student_id,
            owner_teacher_id, attempt_number, submission_channel,
            question_count, answered_count, created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'teacher_entry', ?, ?, ?, ?)
        `).run(
          uuidv4(),
          participant.id,
          assignment.id,
          assignment.class_id,
          participant.student_id,
          req.user.id,
          attemptNumber,
          assignment.question_count,
          answeredCount,
          req.user.id,
          req.user.id
        );
        attempt = db.prepare('SELECT * FROM class_assessment_attempts WHERE id = ?')
          .get(result.lastInsertRowid);
      } else {
        const update = db.prepare(`
          UPDATE class_assessment_attempts
          SET answered_count = ?, revision = revision + 1,
              updated_by = ?, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'draft' AND revision = ?
        `).run(answeredCount, req.user.id, attempt.id, expectedRevision);
        if (update.changes !== 1) {
          throw Object.assign(new Error('revision_conflict'), { status: 409 });
        }
        db.prepare('DELETE FROM class_assessment_responses WHERE attempt_id = ?')
          .run(attempt.id);
        attempt = db.prepare('SELECT * FROM class_assessment_attempts WHERE id = ?')
          .get(attempt.id);
      }

      const insertResponse = db.prepare(`
        INSERT INTO class_assessment_responses (
          attempt_id, assessment_item_id, selected_option_id,
          assignment_id, class_id, owner_teacher_id, is_correct, answered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      normalized.forEach(({ itemId, optionId, numericValue }) => {
        if(itemById.get(itemId).numericDefinition) {saveNumericResponse(db,attempt,itemId,numericValue,itemById.get(itemId).numericDefinition);return;}
        insertResponse.run(
          attempt.id,
          itemId,
          optionId,
          assignment.id,
          assignment.class_id,
          req.user.id,
          optionId === null ? 0 : optionScore.get(optionId),
          optionId === null ? null : new Date().toISOString()
        );
      });
      return attempt;
    });

    let attempt;
    try {
      attempt = save.immediate();
    } catch (error) {
      if(error.message==='online_in_progress')return res.status(409).json({error:'O estudante está respondendo on-line. Aguarde a entrega; as respostas dele foram preservadas.'});
      if (error.status === 400) return res.status(400).json({ error: 'Uma ou mais alternativas são inválidas.' });
      if (error.message === 'already_submitted') {
        return res.status(409).json({ error: 'Esta correção já foi enviada e não pode ser alterada.' });
      }
      if (error.message === 'revision_conflict') {
        return res.status(409).json({ error: 'As respostas mudaram em outro acesso. Atualize a tela.' });
      }
      throw error;
    }

    logActivity({
      user: req.user,
      action: 'save_assessment_responses',
      module: 'classes',
      entityType: 'class_assessment_attempt',
      entityId: attempt.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        student_id: participant.student_public_id,
        answered_count: attempt.answered_count,
        question_count: assignment.question_count,
      },
      req,
    });
    return res.json(serializeEntry(assignment, participant));
  } catch (error) {
    return sendError(error, res, next);
  }
});

router.post('/:classPublicId/assessments/:assessmentPublicId/results/participants/:studentPublicId/submit', (req, res, next) => {
  try {
    const assignment = availableAssessment(req, res);
    if (!assignment) return undefined;
    const participant = ownedParticipant(assignment, req.params.studentPublicId);
    if (!participant) return res.status(404).json({ error: 'Estudante não participa desta aplicação.' });
    if (participant.status === 'exempted') {
      return res.status(409).json({ error: 'Este estudante está dispensado desta aplicação.' });
    }
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) return res.status(400).json({ error: 'Informe a revisão atual das respostas.' });

    const submit = db.transaction(() => {
      const attempt = currentAttempt(participant.id);
      if (!attempt || attempt.status !== 'draft' || attempt.revision !== expectedRevision) {
        throw Object.assign(new Error('revision_conflict'), { status: 409 });
      }
      const score = db.prepare(`
        SELECT
          COUNT(*) AS response_count,
          SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
          SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
        FROM ${scoredResponses(db)}
        WHERE attempt_id = ?
      `).get(attempt.id);
      const correctCount = Number(score.correct_count || 0);
      const answeredCount = Number(score.answered_count || 0);
      const scorePercentage = calculatePercentage(correctCount, assignment.question_count);
      const now = new Date().toISOString();
      const update = db.prepare(`
        UPDATE class_assessment_attempts
        SET status = 'submitted', answered_count = ?, correct_count = ?,
            score_percentage = ?, submitted_at = ?, updated_by = ?,
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'draft' AND revision = ?
      `).run(
        answeredCount,
        correctCount,
        scorePercentage,
        now,
        req.user.id,
        attempt.id,
        expectedRevision
      );
      if (update.changes !== 1) throw Object.assign(new Error('revision_conflict'), { status: 409 });
      if (participant.status !== 'submitted') {
        db.prepare(`
          UPDATE class_assessment_participants
          SET status = 'submitted', submitted_at = ?, updated_by = ?,
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ?
        `).run(now, req.user.id, participant.id);
      }
      return db.prepare('SELECT * FROM class_assessment_attempts WHERE id = ?').get(attempt.id);
    });

    let submitted;
    try {
      submitted = submit.immediate();
    } catch (error) {
      if (error.message === 'revision_conflict') {
        return res.status(409).json({ error: 'As respostas mudaram em outro acesso. Atualize a tela.' });
      }
      throw error;
    }
    logActivity({
      user: req.user,
      action: 'submit_assessment_results',
      module: 'classes',
      entityType: 'class_assessment_attempt',
      entityId: submitted.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        student_id: participant.student_public_id,
        attempt_number: submitted.attempt_number,
        answered_count: submitted.answered_count,
        correct_count: submitted.correct_count,
        question_count: submitted.question_count,
      },
      req,
    });
    return res.json(serializeEntry(assignment, participant));
  } catch (error) {
    return sendError(error, res, next);
  }
});

router.post('/:classPublicId/assessments/:assessmentPublicId/results/participants/:studentPublicId/revise', (_req, res) => {
  return res.status(410).json({
    error: 'A revisão de uma correção concluída foi descontinuada. O resultado enviado é imutável.',
  });
});

router.post(
  '/:classPublicId/assessments/:assessmentPublicId/results/participants/:studentPublicId/feedback',
  requireFeatureFlag('classes.student_feedback_release'),
  (req, res, next) => {
    try {
      const result = releaseStudentFeedback(db, {
        actor: req.user,
        classPublicId: req.params.classPublicId,
        assessmentPublicId: req.params.assessmentPublicId,
        studentPublicId: req.params.studentPublicId,
        body: req.body,
        idempotencyKey: req.get('Idempotency-Key'),
        req,
      });
      res.set('Cache-Control', 'private, no-store');
      return res.status(result.created ? 201 : 200).json(result);
    } catch (error) {
      if (error instanceof StudentAssessmentFeedbackError) {
        return res.status(error.status).json({ error: error.message, code: error.code });
      }
      return next(error);
    }
  },
);

module.exports = router;
