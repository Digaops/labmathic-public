const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const config = require('../config');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { logActivity } = require('../helpers/activity');
const { assessmentRosterReady } = require('../services/assessmentRoster');
const {
  deterministicOrder,
  digestAccessCode,
  normalizeAccessCode,
  opaquePortalToken,
  signStudentSession,
  verifyStudentSession,
} = require('../services/studentAssessmentAccess');
const {
  finalizePendingStudentOnlineAttempts,
  finalizeStudentOnlineAttempt,
} = require('../services/studentAssessmentSubmission');
const {
  applyOptionOrder,
  createBalancedOptionOrders,
} = require('../services/answerKeyBalance');
const { releasedFeedback } = require('../services/studentAssessmentFeedback');
const { numericItems, scoredResponses, normalizeNumericResponse, saveNumericResponse, enabled: numericEnabled } = require('../services/numericAssessments');
const { TypedQuestionAuthoringError } = require('../services/typedQuestionAuthoring');

const router = express.Router();
const { setMediaCookie, clearMediaCookie, STUDENT_MEDIA_COOKIE } = require('../services/authSessions');

function credentialContext(column, value) {
  const allowed = new Set(['credential.code_digest', 'credential.public_id']);
  if (!allowed.has(column)) throw new Error('invalid_credential_lookup');
  return db.prepare(`
    SELECT
      credential.*,
      assignment.public_id AS assignment_public_id,
      assignment.title_snapshot,
      assignment.instructions,
      assignment.status AS assignment_status,
      assignment.opens_at,
      assignment.closes_at,
      assignment.opened_at,
      assignment.closed_at,
      assignment.time_limit_minutes,
      assignment.randomize_questions,
      assignment.randomize_options,
      assignment.question_count,
      assignment.student_access_enabled,
      assignment.student_result_mode,
      participant.status AS participant_status,
      student.public_id AS student_public_id,
      student.display_name,
      school_class.name AS class_name,
      school_class.public_id AS class_public_id,
      owner.id AS owner_id,
      owner.role AS owner_role
    FROM class_assessment_access_credentials credential
    JOIN class_assessment_assignments assignment ON assignment.id = credential.assignment_id
    JOIN class_assessment_participants participant ON participant.id = credential.participant_id
    JOIN students student ON student.id = credential.student_id
    JOIN school_classes school_class ON school_class.id = credential.class_id
    JOIN users owner ON owner.id = credential.owner_teacher_id
    WHERE ${column} = ?
  `).get(value);
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

function synchronizeWindow(context, req) {
  const now = new Date().toISOString();
  if (
    context.assignment_status === 'scheduled'
    && context.opens_at
    && Date.parse(context.opens_at) <= Date.now()
  ) {
    const transition = db.transaction(() => {
      if (!assessmentRosterReady(db, context.assignment_id)) return { changes: 0 };
      return db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'open', opened_at = COALESCE(opened_at, opens_at, ?),
          updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'scheduled'
      `).run(now, context.owner_teacher_id, context.assignment_id);
    }).immediate();
    if (transition.changes === 1) {
      logActivity({
        user: context.owner_teacher_id,
        action: 'auto_open_class_assessment',
        module: 'classes',
        entityType: 'class_assessment',
        entityId: context.assignment_id,
        entityTitle: context.title_snapshot,
        description: `A aplicação "${context.title_snapshot}" foi aberta automaticamente no horário programado.`,
        metadata: { class_id: context.class_public_id, automatic: true, status: 'open' },
        req,
      });
    }
    context = credentialContext('credential.public_id', context.public_id);
  }
  if (
    context.assignment_status === 'open'
    && context.closes_at
    && Date.parse(context.closes_at) <= Date.now()
  ) {
    const close = db.transaction(() => {
      const transition = db.prepare(`
        UPDATE class_assessment_assignments
        SET status = 'closed', closed_at = COALESCE(closed_at, closes_at, ?),
            updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'open'
      `).run(now, context.owner_teacher_id, context.assignment_id);
      return {
        changed: transition.changes === 1,
        autoSubmitted: transition.changes === 1
          ? finalizePendingStudentOnlineAttempts(db, context.assignment_id)
          : [],
      };
    });
    const closeOutcome = close.immediate();
    if (closeOutcome.changed) {
      logActivity({
        user: context.owner_teacher_id,
        action: 'auto_close_class_assessment',
        module: 'classes',
        entityType: 'class_assessment',
        entityId: context.assignment_id,
        entityTitle: context.title_snapshot,
        description: `A aplicação "${context.title_snapshot}" foi encerrada automaticamente no horário programado.`,
        metadata: { class_id: context.class_public_id, automatic: true, status: 'closed' },
        req,
      });
      closeOutcome.autoSubmitted.forEach(({ attempt, studentPublicId }) => {
        logActivity({
          user: context.owner_teacher_id,
          action: 'auto_submit_student_online_assessment',
          module: 'classes',
          entityType: 'class_assessment_attempt',
          entityId: attempt.id,
          entityTitle: context.title_snapshot,
          description: `As respostas salvas de um estudante em "${context.title_snapshot}" foram enviadas automaticamente no encerramento.`,
          metadata: {
            assessment_id: context.assignment_public_id,
            student_id: studentPublicId,
            answered_count: attempt.answered_count,
            question_count: attempt.question_count,
            submission_channel: 'student_online',
            automatic: true,
            reason: 'assessment_closed',
          },
          req,
        });
      });
    }
    context = credentialContext('credential.public_id', context.public_id);
  }
  return context;
}

function assertFeatureAvailable(context) {
  const decision = evaluateFeatureFlag(db, 'classes.student_assessment_portal', {
    id: context.owner_id,
    role: context.owner_role,
  });
  return decision.enabled && (!numericItems(db,context.assignment_id).size
    || numericEnabled(db,{id:context.owner_id,role:context.owner_role}));
}

function effectiveDeadline(context, attempt) {
  const deadlines = [];
  if (context.closes_at) deadlines.push(Date.parse(context.closes_at));
  if (context.time_limit_minutes && attempt?.started_at) {
    deadlines.push(Date.parse(attempt.started_at) + Number(context.time_limit_minutes) * 60_000);
  }
  const valid = deadlines.filter(Number.isFinite);
  return valid.length ? new Date(Math.min(...valid)).toISOString() : null;
}

function loadPortalItems(context) {
  const numeric = numericItems(db,context.assignment_id);
  let items = db.prepare(`
    SELECT
      item.id,
      item.statement_snapshot,
      item.support_text_snapshot,
      item.image_path_snapshot,
      item.show_image,
      item.sort_order
    FROM class_assessment_items item
    WHERE item.assignment_id = ?
    ORDER BY item.sort_order, item.id
  `).all(context.assignment_id);
  const options = db.prepare(`
    SELECT id, assessment_item_id, option_label, option_text_snapshot, is_correct, sort_order
    FROM class_assessment_item_options
    WHERE assignment_id = ?
    ORDER BY assessment_item_id, sort_order, id
  `).all(context.assignment_id);
  const optionsByItem = new Map();
  options.forEach((option) => {
    const list = optionsByItem.get(option.assessment_item_id) || [];
    list.push(option);
    optionsByItem.set(option.assessment_item_id, list);
  });
  if (context.randomize_questions === 1) {
    items = deterministicOrder(`questions:${context.participant_id}`, items);
  }
  const balancedOptionOrders = context.randomize_options === 1
    ? createBalancedOptionOrders(items.filter(item=>!numeric.has(item.id)).map((item) => ({
      id: item.id,
      options: optionsByItem.get(item.id) || [],
    })), `portal:${context.assignment_id}:${context.participant_id}`)
    : null;
  return items.map((item, index) => {
    let itemOptions = optionsByItem.get(item.id) || [];
    if (balancedOptionOrders && !numeric.has(item.id)) {
      itemOptions = applyOptionOrder(
        itemOptions,
        balancedOptionOrders.get(item.id)
      );
    }
    return {
      databaseId: item.id,
      numericDefinition: numeric.get(item.id) || null,
      token: opaquePortalToken(context.public_id, 'item', item.id),
      number: index + 1,
      statement: item.statement_snapshot,
      supportText: item.support_text_snapshot,
      imagePath: item.show_image === 1 ? item.image_path_snapshot : null,
      options: itemOptions.map((option, optionIndex) => ({
        databaseId: option.id,
        token: opaquePortalToken(context.public_id, 'option', option.id),
        label: String.fromCharCode(65 + optionIndex),
        text: option.option_text_snapshot,
        isCorrect: option.is_correct === 1,
      })),
    };
  });
}

function resultVisible(context, attempt) {
  if (attempt?.status !== 'submitted') return false;
  if (context.student_result_mode === 'score_after_submit') return true;
  return context.student_result_mode === 'score_after_close'
    && context.assignment_status === 'closed';
}

function portalPayload(context, attempt = currentAttempt(context.participant_id)) {
  const items = loadPortalItems(context);
  const selectedByItem = new Map();
  if (attempt) {
    db.prepare(`
      SELECT assessment_item_id, selected_option_id, numeric_value
      FROM ${scoredResponses(db)} WHERE attempt_id = ?
    `).all(attempt.id).forEach((response) => {
      selectedByItem.set(response.assessment_item_id, response);
    });
  }
  const showResult = resultVisible(context, attempt);
  const feedback = attempt?.status === 'submitted' && context.assignment_status === 'closed'
    ? releasedFeedback(db, context)
    : null;
  return {
    student: { displayName: context.display_name },
    assessment: {
      title: context.title_snapshot,
      className: context.class_name,
      instructions: context.instructions,
      status: context.assignment_status,
      questionCount: context.question_count,
      opensAt: context.opens_at,
      closesAt: context.closes_at,
      timeLimitMinutes: context.time_limit_minutes,
      resultMode: context.student_result_mode,
    },
    attempt: attempt ? {
      // Identidade opaca da tentativa, estável ao renovar a sessão e sem dados pessoais.
      draftScope: opaquePortalToken(context.public_id, 'attempt', attempt.id),
      status: attempt.status,
      revision: attempt.revision,
      answeredCount: attempt.answered_count,
      startedAt: attempt.started_at,
      submittedAt: attempt.submitted_at,
      deadline: effectiveDeadline(context, attempt),
    } : null,
    items: items.map((item) => {
      const response = selectedByItem.get(item.databaseId);
      const selectedOptionId = response?.selected_option_id;
      return {
        id: item.token,
        number: item.number,
        statement: item.statement,
        supportText: item.supportText,
        imagePath: item.imagePath,
        ...(item.numericDefinition ? {questionType:'numeric',unit:item.numericDefinition.content.unit || '',
          numericValue:response?.numeric_value ?? null} : {}),
        selectedOptionId: selectedOptionId
          ? item.options.find(({ databaseId }) => databaseId === selectedOptionId)?.token || null
          : null,
        options: item.options.map(({ databaseId: _databaseId, isCorrect: _isCorrect, token, ...option }) => ({
          id: token,
          ...option,
        })),
      };
    }),
    result: showResult ? {
      answeredCount: attempt.answered_count,
      correctCount: attempt.correct_count,
      questionCount: attempt.question_count,
      percentage: attempt.score_percentage,
      methodology: 'classical_test_theory',
    } : null,
    feedback,
    resultAvailableAfterClose: attempt?.status === 'submitted'
      && context.student_result_mode === 'score_after_close'
      && context.assignment_status !== 'closed',
    serverTime: new Date().toISOString(),
  };
}

function finalizeAttempt(context, attempt) {
  return finalizeStudentOnlineAttempt(db, attempt);
}

function logStudentSubmission(context, submitted, req, { automatic = false, reason = null } = {}) {
  logActivity({
    user: context.owner_teacher_id,
    action: automatic
      ? 'auto_submit_student_online_assessment'
      : 'submit_student_online_assessment',
    module: 'classes',
    entityType: 'class_assessment_attempt',
    entityId: submitted.id,
    entityTitle: context.title_snapshot,
    description: automatic
      ? `As respostas salvas de um estudante em "${context.title_snapshot}" foram enviadas automaticamente ao fim do prazo.`
      : `Um estudante enviou a avaliação "${context.title_snapshot}" on-line.`,
    metadata: {
      assessment_id: context.assignment_public_id,
      student_id: context.student_public_id,
      answered_count: submitted.answered_count,
      question_count: submitted.question_count,
      submission_channel: 'student_online',
      automatic,
      reason,
    },
    req,
  });
}

function maybeFinalizeExpired(context, attempt, req) {
  if (!attempt || attempt.status !== 'draft') return attempt;
  const deadline = effectiveDeadline(context, attempt);
  if (context.assignment_status === 'closed' || (deadline && Date.parse(deadline) <= Date.now())) {
    const submitted = finalizeAttempt(context, attempt);
    logStudentSubmission(context, submitted, req, {
      automatic: true,
      reason: context.assignment_status === 'closed' ? 'assessment_closed' : 'time_limit',
    });
    return submitted;
  }
  return attempt;
}

function authenticateStudentSession(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Sessão do estudante não fornecida.' });
  }
  try {
    const decoded = verifyStudentSession(authHeader.slice(7));
    let context = credentialContext('credential.public_id', decoded.credentialId);
    if (!context || context.participant_status === 'exempted' || context.status === 'revoked' || Date.parse(context.expires_at) <= Date.now()) {
      return res.status(401).json({ error: 'Este acesso expirou ou foi revogado.' });
    }
    if (!assertFeatureAvailable(context) || context.student_access_enabled !== 1) {
      return res.status(423).json({ error: 'A resposta on-line está temporariamente indisponível.' });
    }
    context = synchronizeWindow(context, req);
    req.studentAssessment = context;
    setMediaCookie(res, authHeader.slice(7), STUDENT_MEDIA_COOKIE);
    return next();
  } catch {
    return res.status(401).json({ error: 'Sessão do estudante inválida ou expirada.' });
  }
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  next();
});

router.post('/session', (req, res, next) => {
  try {
    if (!config.studentAssessmentAccessSecret) {
      return res.status(503).json({ error: 'A aplicação on-line ainda não foi configurada neste ambiente.' });
    }
    const normalizedCode = normalizeAccessCode(req.body?.code);
    if (!normalizedCode) return res.status(400).json({ error: 'Informe um código de acesso válido.' });
    let context = credentialContext('credential.code_digest', digestAccessCode(normalizedCode));
    if (!context || context.participant_status === 'exempted' || context.status === 'revoked' || Date.parse(context.expires_at) <= Date.now()) {
      return res.status(401).json({ error: 'Código inválido, expirado ou revogado.' });
    }
    if (!assertFeatureAvailable(context) || context.student_access_enabled !== 1) {
      return res.status(423).json({ error: 'A resposta on-line está temporariamente indisponível.' });
    }
    context = synchronizeWindow(context, req);
    if (context.assignment_status === 'scheduled') {
      return res.status(423).json({
        error: Date.parse(context.opens_at) <= Date.now()
          ? 'A abertura desta avaliação está aguardando uma conferência do professor. Procure seu professor para continuar.'
          : 'Esta avaliação ainda não começou.',
        opensAt: context.opens_at,
      });
    }
    if (context.assignment_status === 'cancelled') {
      return res.status(410).json({ error: 'Esta avaliação foi cancelada.' });
    }

    const start = db.transaction(() => {
      let attempt = currentAttempt(context.participant_id);
      if (!attempt && context.assignment_status !== 'open') {
        throw Object.assign(new Error('assessment_closed'), { status: 410 });
      }
      if (attempt?.status === 'draft' && attempt.submission_channel !== 'student_online') {
        throw Object.assign(new Error('teacher_entry_in_progress'), { status: 409 });
      }
      if (!attempt) {
        const attemptNumber = Number(db.prepare(`
          SELECT COALESCE(MAX(attempt_number), 0) + 1
          FROM class_assessment_attempts WHERE participant_id = ?
        `).pluck().get(context.participant_id));
        const now = new Date().toISOString();
        const result = db.prepare(`
          INSERT INTO class_assessment_attempts (
            public_id, participant_id, assignment_id, class_id, student_id,
            owner_teacher_id, attempt_number, submission_channel,
            question_count, answered_count, started_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'student_online', ?, 0, ?)
        `).run(
          uuidv4(),
          context.participant_id,
          context.assignment_id,
          context.class_id,
          context.student_id,
          context.owner_teacher_id,
          attemptNumber,
          context.question_count,
          now
        );
        attempt = db.prepare('SELECT * FROM class_assessment_attempts WHERE id = ?')
          .get(result.lastInsertRowid);
        const insertBlank = db.prepare(`
          INSERT INTO class_assessment_responses (
            attempt_id, assessment_item_id, selected_option_id,
            assignment_id, class_id, owner_teacher_id, is_correct, answered_at
          ) VALUES (?, ?, NULL, ?, ?, ?, 0, NULL)
        `);
        const numericDefinitions = numericItems(db, context.assignment_id);
        db.prepare(`
          SELECT id FROM class_assessment_items WHERE assignment_id = ? ORDER BY sort_order, id
        `).all(context.assignment_id).forEach(({ id }) => {
          const definition = numericDefinitions.get(id);
          if(definition) { saveNumericResponse(db,attempt,id,null,definition); return; }
          insertBlank.run(
            attempt.id,
            id,
            context.assignment_id,
            context.class_id,
            context.owner_teacher_id
          );
        });
        db.prepare(`
          UPDATE class_assessment_participants
          SET status = 'in_progress', started_at = COALESCE(started_at, ?),
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'assigned'
        `).run(now, context.participant_id);
      }
      const now = new Date().toISOString();
      db.prepare(`
        UPDATE class_assessment_access_credentials
        SET access_count = access_count + 1,
            first_accessed_at = COALESCE(first_accessed_at, ?),
            last_accessed_at = ?, revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status IN ('active', 'used')
      `).run(now, now, context.id);
      return maybeFinalizeExpired(context, attempt, req);
    });

    let attempt;
    try {
      attempt = start.immediate();
    } catch (error) {
      if (error.message === 'assessment_closed') {
        return res.status(410).json({ error: 'Esta avaliação já foi encerrada.' });
      }
      if (error.message === 'teacher_entry_in_progress') {
        return res.status(409).json({ error: 'O professor já iniciou o lançamento deste estudante.' });
      }
      throw error;
    }
    context = credentialContext('credential.public_id', context.public_id);
    const token = signStudentSession(context.public_id);
    setMediaCookie(res, token, STUDENT_MEDIA_COOKIE);
    return res.json({
      token,
      portal: portalPayload(context, attempt),
    });
  } catch (error) {
    return next(error);
  }
});

router.use(authenticateStudentSession);

router.post('/logout', (_req, res) => {
  clearMediaCookie(res, STUDENT_MEDIA_COOKIE);
  res.sendStatus(204);
});

router.get('/me', (req, res, next) => {
  try {
    let context = synchronizeWindow(req.studentAssessment, req);
    let attempt = currentAttempt(context.participant_id);
    const finalize = db.transaction(() => maybeFinalizeExpired(context, attempt, req));
    attempt = finalize.immediate();
    context = credentialContext('credential.public_id', context.public_id);
    return res.json(portalPayload(context, attempt));
  } catch (error) {
    if(error instanceof TypedQuestionAuthoringError)return res.status(error.status).json({error:error.message});
    return next(error);
  }
});

router.put('/responses', (req, res, next) => {
  try {
    let context = synchronizeWindow(req.studentAssessment, req);
    let attempt = currentAttempt(context.participant_id);
    if (!attempt || attempt.status !== 'draft' || attempt.submission_channel !== 'student_online') {
      return res.status(409).json({ error: 'Esta avaliação já foi enviada ou não pode ser alterada.' });
    }
    const deadline = effectiveDeadline(context, attempt);
    if (context.assignment_status !== 'open' || (deadline && Date.parse(deadline) <= Date.now())) {
      const finalize = db.transaction(() => {
        const submitted = finalizeAttempt(context, attempt);
        logStudentSubmission(context, submitted, req, {
          automatic: true,
          reason: context.assignment_status === 'closed' ? 'assessment_closed' : 'time_limit',
        });
        return submitted;
      });
      finalize.immediate();
      return res.status(409).json({ error: 'O prazo terminou e as respostas salvas foram enviadas automaticamente.' });
    }
    const expectedRevision = Number(req.body?.expectedRevision);
    const submittedResponses = req.body?.responses;
    if (!Number.isInteger(expectedRevision) || expectedRevision < 1 || !Array.isArray(submittedResponses)) {
      return res.status(400).json({ error: 'Respostas ou revisão inválidas.' });
    }
    const items = loadPortalItems(context);
    if (submittedResponses.length !== items.length) {
      return res.status(400).json({ error: 'Envie o estado de todas as questões, inclusive as não respondidas.' });
    }
    const itemByToken = new Map(items.map((item) => [item.token, item]));
    const normalized = submittedResponses.map((response) => {
      const item = itemByToken.get(String(response?.itemId || ''));
      if(item?.numericDefinition) return {item,numericValue:normalizeNumericResponse(response?.numericValue)};
      const option = response?.optionId === null
        ? null
        : item?.options.find(({ token }) => token === String(response?.optionId || ''));
      return { item, option, rawOption: response?.optionId };
    });
    if (
      normalized.some(({ item, option, rawOption }) => !item || (!item.numericDefinition && rawOption !== null && !option))
      || new Set(normalized.map(({ item }) => item?.databaseId)).size !== items.length
    ) {
      return res.status(400).json({ error: 'Uma ou mais respostas não pertencem a esta avaliação.' });
    }

    const save = db.transaction(() => {
      const latest = currentAttempt(context.participant_id);
      if (!latest || latest.status !== 'draft' || latest.revision !== expectedRevision) {
        throw Object.assign(new Error('revision_conflict'), { status: 409 });
      }
      const answeredCount = normalized.filter(r => r.item.numericDefinition ? r.numericValue !== null : r.option).length;
      const update = db.prepare(`
        UPDATE class_assessment_attempts
        SET answered_count = ?, revision = revision + 1,
            updated_by = NULL, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'draft' AND revision = ?
      `).run(answeredCount, latest.id, expectedRevision);
      if (update.changes !== 1) throw Object.assign(new Error('revision_conflict'), { status: 409 });
      const updateResponse = db.prepare(`
        UPDATE class_assessment_responses
        SET selected_option_id = ?, is_correct = ?, answered_at = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE attempt_id = ? AND assessment_item_id = ?
      `);
      const now = new Date().toISOString();
      normalized.forEach(({ item, option, numericValue }) => {
        if(item.numericDefinition) { saveNumericResponse(db,latest,item.databaseId,numericValue,item.numericDefinition); return; }
        updateResponse.run(
          option?.databaseId || null,
          option?.isCorrect ? 1 : 0,
          option ? now : null,
          latest.id,
          item.databaseId
        );
      });
      db.prepare(`
        UPDATE class_assessment_access_credentials
        SET last_accessed_at = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'
      `).run(now, context.id);
      return currentAttempt(context.participant_id);
    });

    try {
      attempt = save.immediate();
    } catch (error) {
      if (error.message === 'revision_conflict') {
        return res.status(409).json({ error: 'As respostas mudaram em outro dispositivo. Recarregue a avaliação.' });
      }
      throw error;
    }
    context = credentialContext('credential.public_id', context.public_id);
    return res.json(portalPayload(context, attempt));
  } catch (error) {
    if(error instanceof TypedQuestionAuthoringError)return res.status(error.status).json({error:error.message});
    return next(error);
  }
});

router.post('/submit', (req, res, next) => {
  try {
    let context = synchronizeWindow(req.studentAssessment, req);
    const attempt = currentAttempt(context.participant_id);
    const expectedRevision = Number(req.body?.expectedRevision);
    if (!attempt || attempt.status !== 'draft' || !Number.isInteger(expectedRevision)) {
      return res.status(409).json({ error: 'Esta avaliação já foi enviada ou não está disponível.' });
    }
    if (attempt.revision !== expectedRevision) {
      return res.status(409).json({ error: 'As respostas mudaram em outro dispositivo. Recarregue a avaliação.' });
    }
    const submit = db.transaction(() => finalizeAttempt(context, attempt));
    let submitted;
    try {
      submitted = submit.immediate();
    } catch (error) {
      if (error.message === 'revision_conflict') {
        return res.status(409).json({ error: 'As respostas mudaram em outro dispositivo. Recarregue a avaliação.' });
      }
      throw error;
    }
    context = credentialContext('credential.public_id', context.public_id);
    logStudentSubmission(context, submitted, req);
    return res.json(portalPayload(context, submitted));
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
