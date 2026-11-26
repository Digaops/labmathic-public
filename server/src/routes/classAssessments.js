const crypto = require('crypto');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const { logActivity, logActivityStrict } = require('../helpers/activity');
const { ineligibleRosterCountSql, exemptedRosterCountSql, assessmentRosterReady } = require('../services/assessmentRoster');
const { finalizePendingStudentOnlineAttempts } = require('../services/studentAssessmentSubmission');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('../services/questionEditorialCuration');
const { numericSources, searchNumericSources, loadNumericQuestions, insertNumericSnapshot, numericItems, numericDiagnostic } = require('../services/numericAssessments');
const { TypedQuestionAuthoringError } = require('../services/typedQuestionAuthoring');
const { previewNumericAssessmentPaper, prepareNumericAssessmentPaper } = require('../services/numericAssessmentPaper');
const {
  AnswerKeyBalanceError,
  answerKeySummary,
  applyOptionOrder,
  createBalancedOptionOrders,
  normalizeOptionOrder,
} = require('../services/answerKeyBalance');

const router = express.Router();
const MAX_PARTICIPANTS = 500;
const VALID_DIFFICULTIES = new Set(['facil', 'media', 'dificil']);
const OPTION_LABELS = ['A', 'B', 'C', 'D'];

class AssessmentRequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireProfessor(req, res, next) {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'A aplicação de simulados em turmas é exclusiva para professores.' });
  }
  return next();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object || {}, key);
}

function normalizeOptionalMultiline(value, maxLength, fieldLabel) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const text = String(value).replace(/\r\n?/g, '\n').trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) || text.length > maxLength) {
    throw new AssessmentRequestError(400, `${fieldLabel} deve ter no máximo ${maxLength} caracteres.`);
  }
  return text;
}

function normalizeOptionalDate(value, fieldLabel) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 40) {
    throw new AssessmentRequestError(400, `${fieldLabel} possui uma data inválida.`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    throw new AssessmentRequestError(400, `${fieldLabel} possui uma data inválida.`);
  }
  return new Date(timestamp).toISOString();
}

function normalizeOptionalTimeLimit(value) {
  if (value === undefined || value === null || value === '') return null;
  const parsed = positiveInteger(value);
  if (!parsed || parsed < 5 || parsed > 300) {
    throw new AssessmentRequestError(400, 'O tempo de realização deve ficar entre 5 e 300 minutos.');
  }
  return parsed;
}

function normalizeBoolean(value, fieldLabel) {
  if (value === true || value === 1 || value === '1') return 1;
  if (value === false || value === 0 || value === '0') return 0;
  throw new AssessmentRequestError(400, `${fieldLabel} deve ser verdadeiro ou falso.`);
}

function validateWindow(opensAt, closesAt) {
  if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) {
    throw new AssessmentRequestError(400, 'O encerramento deve ocorrer depois da abertura.');
  }
}

function normalizeParticipantIds(value) {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_PARTICIPANTS) {
    throw new AssessmentRequestError(
      400,
      `Selecione de 1 a ${MAX_PARTICIPANTS} estudantes para a aplicação.`
    );
  }
  const ids = value.map((item) => String(item || '').trim());
  if (ids.some((item) => !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(item))) {
    throw new AssessmentRequestError(400, 'A lista de estudantes contém um identificador inválido.');
  }
  const uniqueIds = [...new Set(ids.map((item) => item.toLowerCase()))];
  if (uniqueIds.length !== ids.length) {
    throw new AssessmentRequestError(400, 'A lista de estudantes contém itens duplicados.');
  }
  return uniqueIds;
}

function ownedClass(classPublicId, ownerTeacherId) {
  return db.prepare(`
    SELECT id, public_id, owner_teacher_id, name, status, revision
    FROM school_classes
    WHERE public_id = ? AND owner_teacher_id = ?
  `).get(classPublicId, ownerTeacherId);
}

function ownedAssignment(classId, publicId, ownerTeacherId) {
  return db.prepare(`
    SELECT *
    FROM class_assessment_assignments
    WHERE public_id = ? AND class_id = ? AND owner_teacher_id = ?
  `).get(publicId, classId, ownerTeacherId);
}

function activeParticipants(classId, ownerTeacherId, participantPublicIds) {
  const placeholders = participantPublicIds.map(() => '?').join(',');
  const participants = db.prepare(`
    SELECT
      student.id AS student_id,
      student.public_id AS student_public_id,
      student.display_name,
      enrollment.id AS enrollment_id
    FROM school_class_enrollments enrollment
    JOIN students student ON student.id = enrollment.student_id
    WHERE enrollment.class_id = ?
      AND enrollment.owner_teacher_id = ?
      AND enrollment.status = 'active'
      AND student.status = 'active'
      AND student.public_id IN (${placeholders})
    ORDER BY student.display_name COLLATE NOCASE, student.public_id
  `).all(classId, ownerTeacherId, ...participantPublicIds);

  if (participants.length !== participantPublicIds.length) {
    throw new AssessmentRequestError(
      400,
      'Um ou mais estudantes não possuem matrícula ativa nesta turma.'
    );
  }
  return participants;
}

function accessibleQuestionSet(sourceQuestionSetId, ownerTeacherId) {
  return db.prepare(`
    SELECT question_set.id, question_set.user_id, question_set.title,
      question_set.description, question_set.is_public,
      question_set.contains_author_questions,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic,
      CASE WHEN diagnostic_review.question_set_id IS NULL THEN 0 ELSE 1 END AS diagnostic_reviewed
    FROM question_sets question_set
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = question_set.id
    LEFT JOIN diagnostic_question_set_reviews diagnostic_review
      ON diagnostic_review.question_set_id = diagnostic.question_set_id
    WHERE question_set.id = ?
      AND (
        question_set.user_id = ?
        OR (question_set.is_public = 1 AND question_set.contains_author_questions = 0)
      )
  `).get(sourceQuestionSetId, ownerTeacherId);
}

// A verification belongs to one teacher and one class, even if its set is shared.
function ownedVerificationCycle(req, schoolClass, sourceQuestionSetId) {
  const cycle = db.prepare('SELECT * FROM learning_recovery_monitoring_cycles WHERE question_set_id = ?').get(sourceQuestionSetId);
  if (!cycle) return null;
  if (cycle.owner_teacher_id !== req.user.id || cycle.class_id !== schoolClass.id
    || !evaluateFeatureFlag(db, 'classes.learning_recovery', req.user).enabled) {
    throw new AssessmentRequestError(404, 'Verificação não encontrada para esta turma.');
  }
  return cycle;
}

function loadQuestionSetSnapshot(questionSet, ownerTeacherId) {
  if (
    !String(questionSet.title || '').trim()
    || String(questionSet.title).trim().length > 200
    || String(questionSet.description || '').length > 5000
  ) {
    throw new AssessmentRequestError(400, 'O simulado possui título ou descrição incompatível.');
  }

  const rows = db.prepare(`
    SELECT
      q.id AS source_question_id,
      q.question_code,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.source,
      q.created_by,
      skill.id AS source_skill_id,
      skill.code AS skill_code,
      skill.description AS skill_description,
      item.show_image,
      item.option_order
    FROM question_set_items item
    JOIN questions q ON q.id = item.question_id
    JOIN bncc_skills skill ON skill.id = q.skill_id
    WHERE item.question_set_id = ?
    ORDER BY item.sort_order, item.id
  `).all(questionSet.id);

  if (rows.length < 1 || rows.length > 100) {
    throw new AssessmentRequestError(400, 'O simulado deve conter de 1 a 100 questões.');
  }

  const questionIds = rows.map((row) => row.source_question_id);
  const options = db.prepare(`
    SELECT question_id, option_label, option_text, is_correct, sort_order, id
    FROM question_options
    WHERE question_id IN (${questionIds.map(() => '?').join(',')})
    ORDER BY question_id, sort_order, id
  `).all(...questionIds);
  const optionsByQuestion = new Map();
  options.forEach((option) => {
    const list = optionsByQuestion.get(option.question_id) || [];
    list.push(option);
    optionsByQuestion.set(option.question_id, list);
  });

  const hasCompleteStoredOrder = rows.every(({ option_order: order }) => (
    Boolean(normalizeOptionOrder(order))
  ));
  let optionOrders;
  try {
    optionOrders = hasCompleteStoredOrder
      ? new Map(rows.map((row) => [row.source_question_id, row.option_order]))
      : createBalancedOptionOrders(rows.map((row) => ({
        id: row.source_question_id,
        options: optionsByQuestion.get(row.source_question_id) || [],
      })), `question-set:${questionSet.id}`);
  } catch (error) {
    if (error instanceof AnswerKeyBalanceError) {
      throw new AssessmentRequestError(
        400,
        `A questão ${error.questionId || ''} não está pronta para aplicação.`.replace('  ', ' ')
      );
    }
    throw error;
  }

  return rows.map((row, index) => {
    const questionOptions = optionsByQuestion.get(row.source_question_id) || [];
    const labels = questionOptions.map((option) => option.option_label);
    const validLabels = OPTION_LABELS.every((label) => labels.includes(label));
    const correctCount = questionOptions.filter((option) => option.is_correct === 1).length;
    const sourceIsVisible = row.source === 'official'
      || (row.source === 'teacher' && row.created_by === ownerTeacherId);

    if (
      row.status !== 'active'
      || !sourceIsVisible
      || row.question_type !== 'multiple_choice'
      || !VALID_DIFFICULTIES.has(row.difficulty)
      || !String(row.question_code || '').trim()
      || String(row.question_code).trim().length > 100
      || !String(row.statement || '').trim()
      || String(row.statement).trim().length > 20000
      || questionOptions.length !== 4
      || !validLabels
      || correctCount !== 1
      || questionOptions.some((option) => (
        !String(option.option_text || '').trim()
        || String(option.option_text).trim().length > 10000
      ))
    ) {
      throw new AssessmentRequestError(
        400,
        `A questão ${row.question_code || index + 1} não está pronta para aplicação.`
      );
    }

    const presentedOptions = applyOptionOrder(
      questionOptions,
      optionOrders.get(row.source_question_id)
    );

    return {
      sourceQuestionId: row.source_question_id,
      sourceSkillId: row.source_skill_id,
      questionCode: String(row.question_code).trim(),
      skillCode: row.skill_code || null,
      skillDescription: row.skill_description || null,
      statement: String(row.statement).trim(),
      supportText: row.support_text || null,
      imagePath: row.image_path || null,
      developmentSpace: row.development_space,
      difficulty: row.difficulty,
      questionType: 'multiple_choice',
      explanation: row.official_explanation || null,
      sortOrder: index,
      showImage: row.show_image === 1 && Boolean(row.image_path) ? 1 : 0,
      options: presentedOptions.map((option, optionIndex) => ({
        label: option.option_label,
        text: String(option.option_text).trim(),
        isCorrect: option.is_correct === 1 ? 1 : 0,
        sortOrder: optionIndex,
      })),
    };
  });
}

function assertEditorialApplicationSource(questionSetId, user) {
  const blocked = db.prepare(`
    SELECT q.question_code FROM question_set_items item
    JOIN questions q ON q.id = item.question_id
    WHERE item.question_set_id = ? AND NOT (${editorialEligibleSql('q', {
      pilotEnabled: isEditorialPilotEnabled(db, user),
    })})
    ORDER BY item.sort_order LIMIT 1
  `).get(questionSetId);
  if (blocked) throw new AssessmentRequestError(409,
    `A questão ${blocked.question_code} está indisponível para novas aplicações. Substitua a questão no simulado antes de continuar.`);
}

function snapshotHash(questionSet, questions) {
  const canonical = {
    version: 1,
    sourceQuestionSetId: questionSet.id,
    title: String(questionSet.title).trim(),
    description: questionSet.description || null,
    questions,
  };
  return crypto.createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function assignmentParticipants(assignmentId) {
  return db.prepare(`
    SELECT
      student.public_id AS student_public_id,
      student.display_name,
      participant.status,
      student.status AS student_status,
      enrollment.status AS enrollment_status,
      EXISTS (SELECT 1 FROM class_assessment_attempts WHERE participant_id = participant.id) AS has_attempt,
      EXISTS (SELECT 1 FROM class_assessment_access_credentials WHERE participant_id = participant.id)
        OR EXISTS (SELECT 1 FROM class_assessment_attempts WHERE participant_id = participant.id) AS has_history,
      participant.revision,
      participant.assigned_at,
      participant.started_at,
      participant.submitted_at,
      participant.exempted_at
    FROM class_assessment_participants participant
    JOIN students student ON student.id = participant.student_id
    JOIN school_class_enrollments enrollment ON enrollment.id = participant.enrollment_id
    WHERE participant.assignment_id = ?
    ORDER BY student.display_name COLLATE NOCASE, student.public_id
  `).all(assignmentId).map((row) => ({
    id: row.student_public_id,
    displayName: row.display_name,
    studentStatus: row.student_status,
    enrollmentStatus: row.enrollment_status,
    eligible: row.status !== 'exempted' && row.student_status === 'active' && row.enrollment_status === 'active',
    canRemove: row.status !== 'exempted' && !row.has_history,
    canExempt: row.status === 'assigned' && !row.has_attempt,
    status: row.status,
    revision: row.revision,
    assignedAt: row.assigned_at,
    startedAt: row.started_at,
    submittedAt: row.submitted_at,
    exemptedAt: row.exempted_at,
  }));
}

function assignmentItems(assignmentId) {
  const numeric = numericItems(db,assignmentId);
  const items = db.prepare(`
    SELECT *
    FROM class_assessment_items
    WHERE assignment_id = ?
    ORDER BY sort_order, id
  `).all(assignmentId);
  if (items.length === 0) return [];

  const options = db.prepare(`
    SELECT *
    FROM class_assessment_item_options
    WHERE assignment_id = ?
    ORDER BY assessment_item_id, sort_order, id
  `).all(assignmentId);
  const optionsByItem = new Map();
  options.forEach((option) => {
    const list = optionsByItem.get(option.assessment_item_id) || [];
    list.push({
      label: option.option_label,
      text: option.option_text_snapshot,
      isCorrect: option.is_correct === 1,
      sortOrder: option.sort_order,
    });
    optionsByItem.set(option.assessment_item_id, list);
  });

  return items.map((item) => ({
    questionCode: item.question_code_snapshot,
    skillCode: item.skill_code_snapshot,
    skillDescription: item.skill_description_snapshot,
    statement: item.statement_snapshot,
    supportText: item.support_text_snapshot,
    imagePath: item.image_path_snapshot,
    showImage: item.show_image === 1,
    developmentSpace: item.development_space_snapshot,
    difficulty: item.difficulty_snapshot,
    questionType: numeric.has(item.id) ? 'numeric' : item.question_type_snapshot,
    ...(numeric.has(item.id) ? {unit:numeric.get(item.id).content.unit || ''} : {}),
    explanation: item.explanation_snapshot,
    sortOrder: item.sort_order,
    options: optionsByItem.get(item.id) || [],
  }));
}

function serializeAssignment(row, { detail = false } = {}) {
  const numericOrigin = numericDiagnostic(db, row);
  const payload = {
    id: row.public_id,
    sourceQuestionSetId: row.source_question_set_id,
    title: row.title_snapshot,
    description: row.description_snapshot,
    instructions: row.instructions,
    snapshotVersion: row.snapshot_version,
    snapshotHash: row.snapshot_hash,
    questionCount: row.question_count,
    participantCount: Number(row.participant_count ?? 0),
    roster: {
      eligibleCount: Number(row.participant_count ?? 0) - Number(row.ineligible_participant_count ?? 0) - Number(row.exempted_participant_count ?? 0),
      ineligibleCount: Number(row.ineligible_participant_count ?? 0),
      exemptedCount: Number(row.exempted_participant_count ?? 0),
    },
    status: row.status,
    opensAt: row.opens_at,
    closesAt: row.closes_at,
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    cancelledAt: row.cancelled_at,
    timeLimitMinutes: row.time_limit_minutes,
    randomizeQuestions: row.randomize_questions === 1,
    randomizeOptions: row.randomize_options === 1,
    isDiagnostic: row.is_diagnostic === 1 || Boolean(numericOrigin),
    responseFormat: numericOrigin ? 'numeric' : 'multiple_choice',
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (detail) {
    payload.participants = assignmentParticipants(row.id);
    payload.items = assignmentItems(row.id);
    payload.answerKey = answerKeySummary(payload.items.filter(item=>item.questionType!=='numeric').map((item, index) => ({
      id: index + 1,
      options: item.options,
    })));
  }
  return payload;
}

function assignmentWithCount(assignmentId) {
  return db.prepare(`
    SELECT assignment.*, COUNT(participant.id) AS participant_count,
      ${ineligibleRosterCountSql} AS ineligible_participant_count,
      ${exemptedRosterCountSql} AS exempted_participant_count,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic
    FROM class_assessment_assignments assignment
    LEFT JOIN class_assessment_participants participant
      ON participant.assignment_id = assignment.id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    WHERE assignment.id = ?
    GROUP BY assignment.id
  `).get(assignmentId);
}

function synchronizeTemporalStatus(schoolClass, req) {
  const now = new Date().toISOString();
  const deliveryEnabled = evaluateFeatureFlag(
    db,
    'classes.assessment_delivery',
    req.user
  ).enabled;
  const transitions = db.transaction(() => {
    const changed = [];
    const dueToOpen = schoolClass.status === 'active' && deliveryEnabled ? db.prepare(`
      SELECT id, public_id, title_snapshot, revision
      FROM class_assessment_assignments
      WHERE class_id = ? AND owner_teacher_id = ? AND status = 'scheduled'
        AND julianday(opens_at) <= julianday(?)
    `).all(schoolClass.id, req.user.id, now) : [];
    const openStatement = db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'open', opened_at = COALESCE(opened_at, opens_at, ?),
          updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_teacher_id = ? AND status = 'scheduled' AND revision = ?
    `);
    dueToOpen.forEach((assignment) => {
      if(numericItems(db,assignment.id).size && !evaluateFeatureFlag(db,'classes.numeric_assessments',req.user).enabled)return;
      if (!assessmentRosterReady(db, assignment.id)) return;
      const result = openStatement.run(
        now,
        req.user.id,
        assignment.id,
        req.user.id,
        assignment.revision
      );
      if (result.changes === 1) changed.push({ assignment, status: 'open' });
    });

    const dueToClose = db.prepare(`
      SELECT id, public_id, title_snapshot, revision
      FROM class_assessment_assignments
      WHERE class_id = ? AND owner_teacher_id = ? AND status = 'open'
        AND closes_at IS NOT NULL
        AND julianday(closes_at) <= julianday(?)
    `).all(schoolClass.id, req.user.id, now);
    const closeStatement = db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'closed', closed_at = COALESCE(closed_at, closes_at, ?),
          updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_teacher_id = ? AND status = 'open' AND revision = ?
    `);
    dueToClose.forEach((assignment) => {
      const result = closeStatement.run(
        now,
        req.user.id,
        assignment.id,
        req.user.id,
        assignment.revision
      );
      if (result.changes === 1) {
        changed.push({
          assignment,
          status: 'closed',
          autoSubmitted: finalizePendingStudentOnlineAttempts(db, assignment.id),
        });
      }
    });
    return changed;
  })();

  transitions.forEach(({ assignment, status, autoSubmitted = [] }) => {
    logActivity({
      user: req.user,
      action: status === 'open'
        ? 'auto_open_class_assessment'
        : 'auto_close_class_assessment',
      module: 'classes',
      entityType: 'class_assessment',
      entityId: assignment.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: schoolClass.public_id,
        status,
        automatic: true,
      },
      req,
    });
    autoSubmitted.forEach(({ attempt, studentPublicId }) => {
      logActivity({
        user: req.user,
        action: 'auto_submit_student_online_assessment',
        module: 'classes',
        entityType: 'class_assessment_attempt',
        entityId: attempt.id,
        entityTitle: assignment.title_snapshot,
        description: `As respostas salvas de um estudante em "${assignment.title_snapshot}" foram enviadas automaticamente no encerramento.`,
        metadata: {
          class_id: schoolClass.public_id,
          assessment_id: assignment.public_id,
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
  });
}

function insertParticipants(assignment, participants, actorId) {
  const insert = db.prepare(`
    INSERT INTO class_assessment_participants (
      assignment_id, class_id, student_id, enrollment_id, owner_teacher_id,
      created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);
  participants.forEach((participant) => {
    insert.run(
      assignment.id,
      assignment.class_id,
      participant.student_id,
      participant.enrollment_id,
      assignment.owner_teacher_id,
      actorId,
      actorId
    );
  });
}

function sendAssessmentError(error, res, next) {
  if (error instanceof AssessmentRequestError || error instanceof TypedQuestionAuthoringError) {
    return res.status(error.status).json({ error: error.message });
  }
  if (String(error?.message || '').includes('UNIQUE constraint failed')) {
    return res.status(409).json({ error: 'Já existe uma aplicação com esses dados.' });
  }
  const constraintMessages = new Map([
    ['assessment_class_is_not_active', 'A turma precisa estar ativa para disponibilizar o simulado.'],
    ['assessment_question_count_mismatch', 'O conteúdo preservado do simulado está inconsistente.'],
    ['assessment_options_are_incomplete', 'Uma ou mais questões não estão prontas para disponibilização.'],
    ['assessment_has_no_participants', 'Selecione ao menos um estudante antes de disponibilizar.'],
    ['invalid_assessment_status_transition', 'Esta mudança de situação não é mais permitida. Atualize a tela.'],
    ['assessment_roster_is_frozen', 'A lista de estudantes está congelada porque o simulado já foi disponibilizado.'],
    ['recovery_monitoring_assignment_already_created', 'Esta verificação já possui uma aplicação vinculada. Abra o plano de recomposição para continuar.'],
  ]);
  const errorMessage = String(error?.message || '');
  for (const [constraint, message] of constraintMessages) {
    if (errorMessage.includes(constraint)) return res.status(409).json({ error: message });
  }
  return next(error);
}

router.use(
  '/:classPublicId/assessments',
  authenticate,
  requireProfessor,
  requireFeatureFlag('classes.core'),
  requireFeatureFlag('classes.assessment_assignments')
);

router.get('/:classPublicId/assessments/bootstrap', (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });

  const participants = db.prepare(`
    SELECT student.public_id, student.display_name
    FROM school_class_enrollments enrollment
    JOIN students student ON student.id = enrollment.student_id
    WHERE enrollment.class_id = ?
      AND enrollment.owner_teacher_id = ?
      AND enrollment.status = 'active'
      AND student.status = 'active'
    ORDER BY student.display_name COLLATE NOCASE, student.public_id
  `).all(schoolClass.id, req.user.id).map((row) => ({
    id: row.public_id,
    displayName: row.display_name,
  }));

  const sources = db.prepare(`
    SELECT
      question_set.id,
      question_set.title,
      question_set.description,
      question_set.user_id,
      question_set.is_public,
      question_set.contains_author_questions,
      COUNT(item.id) AS question_count,
      question_set.updated_at
    FROM question_sets question_set
    LEFT JOIN question_set_items item ON item.question_set_id = question_set.id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = question_set.id
    LEFT JOIN diagnostic_question_set_reviews diagnostic_review
      ON diagnostic_review.question_set_id = diagnostic.question_set_id
    WHERE (
      question_set.user_id = ?
      OR (question_set.is_public = 1 AND question_set.contains_author_questions = 0)
    )
      AND (diagnostic.question_set_id IS NULL OR diagnostic_review.question_set_id IS NOT NULL)
    GROUP BY question_set.id
    HAVING COUNT(item.id) BETWEEN 1 AND 100
    ORDER BY question_set.updated_at DESC, question_set.id DESC
    LIMIT 200
  `).all(req.user.id).map((row) => ({
    id: row.id,
    title: row.title,
    description: row.description,
    questionCount: Number(row.question_count),
    ownership: row.user_id === req.user.id ? 'own' : 'public',
    containsAuthorQuestions: row.contains_author_questions === 1,
    updatedAt: row.updated_at,
  }));

  return res.json({
    class: { id: schoolClass.public_id, name: schoolClass.name, status: schoolClass.status },
    participants,
    sources,
    numericSources: numericSources(db, req.user),
    numericSourceSearch: true,
    numericEnabled: evaluateFeatureFlag(db,'classes.numeric_assessments',req.user).enabled,
    limits: { maxParticipants: MAX_PARTICIPANTS, maxQuestions: 100 },
  });
});

router.get('/:classPublicId/assessments/numeric-sources', (req, res, next) => {
  res.set('Cache-Control', 'no-store');
  try {
    if (!ownedClass(req.params.classPublicId, req.user.id)) return res.status(404).json({ error: 'Turma não encontrada.' });
    return res.json(searchNumericSources(db, req.user, { search: req.query.search, page: req.query.page }));
  } catch (error) { return sendAssessmentError(error, res, next); }
});

router.get('/:classPublicId/assessments', (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });

  synchronizeTemporalStatus(schoolClass, req);
  const assignments = db.prepare(`
    SELECT assignment.*, COUNT(participant.id) AS participant_count,
      ${ineligibleRosterCountSql} AS ineligible_participant_count,
      ${exemptedRosterCountSql} AS exempted_participant_count,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic
    FROM class_assessment_assignments assignment
    LEFT JOIN class_assessment_participants participant
      ON participant.assignment_id = assignment.id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    WHERE assignment.class_id = ? AND assignment.owner_teacher_id = ?
    GROUP BY assignment.id
    ORDER BY assignment.updated_at DESC, assignment.id DESC
  `).all(schoolClass.id, req.user.id).map((row) => serializeAssignment(row));

  return res.json(assignments);
});

router.get('/:classPublicId/assessments/sources/:sourceId/preparation', (req, res, next) => {
  try {
    const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
    if (!schoolClass) throw new AssessmentRequestError(404, 'Turma não encontrada.');
    const sourceId = positiveInteger(req.params.sourceId);
    const questionSet = sourceId && accessibleQuestionSet(sourceId, req.user.id);
    if (!questionSet) throw new AssessmentRequestError(404, 'Simulado não encontrado.');
    const cycle = ownedVerificationCycle(req, schoolClass, sourceId);
    if (!cycle?.assignment_id) assertEditorialApplicationSource(questionSet.id, req.user);
    const questionCount = db.prepare('SELECT COUNT(*) FROM question_set_items WHERE question_set_id = ?').pluck().get(sourceId);
    if (questionCount < 1 || questionCount > 100 || (questionSet.is_diagnostic === 1 && questionSet.diagnostic_reviewed !== 1)) {
      throw new AssessmentRequestError(409, 'Revise o simulado antes de preparar a aplicação.');
    }
    let recovery = null;
    if (cycle) {
      const members = db.prepare(`
        SELECT DISTINCT student.public_id,
          CASE WHEN student.status = 'active' AND enrollment.status = 'active' THEN 1 ELSE 0 END AS eligible
        FROM learning_recovery_student_group_members member
        JOIN students student ON student.id = member.student_id AND student.owner_teacher_id = member.owner_teacher_id
        LEFT JOIN school_class_enrollments enrollment ON enrollment.student_id = member.student_id
          AND enrollment.class_id = member.class_id AND enrollment.owner_teacher_id = member.owner_teacher_id
        WHERE member.plan_id = ? AND member.class_id = ? AND member.owner_teacher_id = ?
        ORDER BY student.public_id
      `).all(cycle.recovery_plan_id, schoolClass.id, req.user.id);
      recovery = {
        participantIds: members.filter(member => member.eligible === 1).map(member => member.public_id),
        unavailableCount: members.filter(member => member.eligible !== 1).length,
      };
    }
    // Read-only: no automatic publishing, roster changes or temporal transitions here.
    return res.json({
      source: { id: questionSet.id, title: questionSet.title, questionCount },
      recovery,
      existingAssignment: cycle?.assignment_id ? serializeAssignment(assignmentWithCount(cycle.assignment_id)) : null,
    });
  } catch (error) { return sendAssessmentError(error, res, next); }
});

router.get('/:classPublicId/assessments/:assessmentPublicId/readiness', requireFeatureFlag('classes.assessment_delivery'), (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });
  const assignment = ownedAssignment(schoolClass.id, req.params.assessmentPublicId, req.user.id);
  if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
  return res.json({ assignment: serializeAssignment(assignmentWithCount(assignment.id)),
    classActive: schoolClass.status === 'active', participants: assignmentParticipants(assignment.id) });
});

router.post('/:classPublicId/assessments/:assessmentPublicId/participants/:studentPublicId/exemption',
  requireFeatureFlag('classes.assessment_delivery'), requireFeatureFlag('classes.assessment_exemptions'), (req, res, next) => {
    try {
      if (req.body?.confirmation !== 'DISPENSAR_ESTUDANTE'
        || !['enrollment_changed', 'selection_correction'].includes(req.body?.reason)
        || !Number.isSafeInteger(req.body?.expectedRevision) || req.body.expectedRevision < 1) {
        throw new AssessmentRequestError(400, 'Confira o motivo, a revisão e a confirmação da dispensa.');
      }
      const result = db.transaction(() => {
        const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
        const assignment = schoolClass && ownedAssignment(schoolClass.id, req.params.assessmentPublicId, req.user.id);
        if (!assignment) throw new AssessmentRequestError(404, 'Aplicação não encontrada.');
        if (schoolClass.status !== 'active' || assignment.status !== 'draft' || assignment.revision !== req.body.expectedRevision) {
          throw new AssessmentRequestError(409, 'Atualize a aplicação. A dispensa exige turma ativa e rascunho; retire o agendamento antes de continuar.');
        }
        const participant = db.prepare(`SELECT participant.* FROM class_assessment_participants participant
          JOIN students student ON student.id=participant.student_id
          WHERE participant.assignment_id=? AND student.public_id=?`).get(assignment.id, req.params.studentPublicId);
        if (!participant) throw new AssessmentRequestError(404, 'Estudante não encontrado nesta aplicação.');
        if (participant.status !== 'assigned' || db.prepare('SELECT 1 FROM class_assessment_attempts WHERE participant_id=? LIMIT 1').get(participant.id)) {
          throw new AssessmentRequestError(409, 'A dispensa não está disponível: estudante já dispensado ou com tentativa de resposta registrada. O histórico foi preservado.');
        }
        const remaining = db.prepare("SELECT COUNT(*) FROM class_assessment_participants WHERE assignment_id=? AND status<>'exempted'").pluck().get(assignment.id);
        if (remaining <= 1) throw new AssessmentRequestError(409, 'Mantenha pelo menos um participante. Se ninguém for realizar a avaliação, mantenha o rascunho sem disponibilizar.');
        const now = new Date().toISOString();
        db.prepare(`UPDATE class_assessment_participants SET status='exempted', exempted_at=?,
          revision=revision+1, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(now, req.user.id, participant.id);
        const revoked = db.prepare(`UPDATE class_assessment_access_credentials SET status='revoked', revoked_at=?,
          updated_by=?, revision=revision+1, updated_at=CURRENT_TIMESTAMP WHERE participant_id=? AND status='active'`).run(now, req.user.id, participant.id);
        db.prepare('UPDATE class_assessment_assignments SET revision=revision+1, updated_by=?, updated_at=CURRENT_TIMESTAMP WHERE id=?').run(req.user.id, assignment.id);
        logActivityStrict({ user: req.user, action: 'exempt_class_assessment_participant', module: 'classes',
          entityType: 'class_assessment', entityId: assignment.id, entityTitle: assignment.title_snapshot,
          metadata: { student_id: req.params.studentPublicId, reason: req.body.reason, revoked_access_count: revoked.changes,
            remaining_participant_count: remaining - 1 }, req }, db);
        return serializeAssignment(assignmentWithCount(assignment.id));
      }).immediate();
      res.setHeader('Cache-Control', 'no-store');
      return res.json(result);
    } catch (error) { return sendAssessmentError(error, res, next); }
  });

router.get('/:classPublicId/assessments/:assessmentPublicId/numeric-paper', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    return res.json(previewNumericAssessmentPaper(db, { actor: req.user, ...req.params }));
  } catch (error) { return sendAssessmentError(error, res, next); }
});

router.post('/:classPublicId/assessments/:assessmentPublicId/numeric-paper/print', (req, res, next) => {
  res.setHeader('Cache-Control', 'private, no-store');
  try {
    const allowed = ['audience', 'confirmed', 'expectedRevision', 'expectedFingerprint'];
    if (!req.body || Array.isArray(req.body) || typeof req.body !== 'object'
      || Object.keys(req.body).some(key => !allowed.includes(key))) {
      throw new AssessmentRequestError(400, 'Os dados da impressão não foram reconhecidos. Reabra a prévia.');
    }
    return res.json(prepareNumericAssessmentPaper(db, { ...req.body, actor: req.user, ...req.params },
      (payload, database) => logActivityStrict({ ...payload, req }, database)));
  } catch (error) { return sendAssessmentError(error, res, next); }
});

router.get('/:classPublicId/assessments/:assessmentPublicId', (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });
  synchronizeTemporalStatus(schoolClass, req);
  const assignment = ownedAssignment(
    schoolClass.id,
    req.params.assessmentPublicId,
    req.user.id
  );
  if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
  return res.json(serializeAssignment(assignmentWithCount(assignment.id), { detail: true }));
});

router.post('/:classPublicId/assessments', (req, res, next) => {
  try {
    const sourceQuestionSetId = positiveInteger(req.body?.sourceQuestionSetId);
    const numeric = hasOwn(req.body, 'numericVersionIds');
    if(numeric && req.body.pedagogicalConfirmed!==true)throw new AssessmentRequestError(400,'Confirme que conferiu as questões e as habilidades para esta turma.');
    if (!numeric && !sourceQuestionSetId) {
      throw new AssessmentRequestError(400, 'Selecione um simulado válido.');
    }
    if (numeric && sourceQuestionSetId) throw new AssessmentRequestError(400, 'Escolha um único tipo de atividade.');
    const numericTitle = numeric && typeof req.body.title === 'string' ? req.body.title.trim() : '';
    const requestKey = req.get('Idempotency-Key');
    if (numeric && (!numericTitle || numericTitle.length > 200 || !/^[a-zA-Z0-9-]{16,100}$/.test(requestKey || '')))
      throw new AssessmentRequestError(400, 'Informe o título e a identificação desta criação.');
    const participantPublicIds = normalizeParticipantIds(req.body?.participantIds);
    const instructions = normalizeOptionalMultiline(req.body?.instructions, 2000, 'As instruções');
    const opensAt = normalizeOptionalDate(req.body?.opensAt, 'A abertura');
    const closesAt = normalizeOptionalDate(req.body?.closesAt, 'O encerramento');
    const timeLimitMinutes = normalizeOptionalTimeLimit(req.body?.timeLimitMinutes);
    const randomizeQuestions = hasOwn(req.body, 'randomizeQuestions')
      ? normalizeBoolean(req.body.randomizeQuestions, 'A opção de embaralhar questões')
      : 0;
    const randomizeOptions = hasOwn(req.body, 'randomizeOptions')
      ? normalizeBoolean(req.body.randomizeOptions, 'A opção de embaralhar alternativas')
      : 0;
    validateWindow(opensAt, closesAt);
    const requestHash = numeric ? crypto.createHash('sha256').update(JSON.stringify({
      classId:req.params.classPublicId, ids:req.body.numericVersionIds, title:numericTitle,
      participantPublicIds,instructions,opensAt,closesAt,timeLimitMinutes,randomizeQuestions,randomizeOptions,
    })).digest('hex') : null;

    const createDraft = db.transaction(() => {
      const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
      if (!schoolClass) throw new AssessmentRequestError(404, 'Turma não encontrada.');
      if (schoolClass.status !== 'active') {
        throw new AssessmentRequestError(409, 'Restaure a turma antes de criar uma aplicação.');
      }

      const questionSet = numeric ? { id:null,title:numericTitle,description:null } : accessibleQuestionSet(sourceQuestionSetId, req.user.id);
      if (!questionSet) throw new AssessmentRequestError(404, 'Simulado não encontrado.');
      if (!numeric) ownedVerificationCycle(req, schoolClass, sourceQuestionSetId);
      if (!numeric) assertEditorialApplicationSource(questionSet.id, req.user);
      if (questionSet.is_diagnostic === 1 && questionSet.diagnostic_reviewed !== 1) {
        throw new AssessmentRequestError(
          409,
          'Revise as questões e confirme a revisão pedagógica antes de aplicar este diagnóstico.'
        );
      }
      const questions = numeric ? loadNumericQuestions(db,req.user,req.body.numericVersionIds) : loadQuestionSetSnapshot(questionSet, req.user.id);
      if (numeric) {
        const previous=db.prepare('SELECT * FROM class_assessment_numeric_origins WHERE owner_teacher_id=? AND request_key=?').get(req.user.id,requestKey);
        if(previous) {
          if(previous.request_hash!==requestHash)throw new AssessmentRequestError(409,'Esta criação já foi recebida com outro conteúdo. Atualize a lista antes de continuar.');
          return {assignmentId:previous.assignment_id,schoolClass,replayed:true};
        }
      }
      const participants = activeParticipants(
        schoolClass.id,
        req.user.id,
        participantPublicIds
      );
      const hash = numeric ? crypto.createHash('sha256').update(JSON.stringify({title:numericTitle,
        versions:questions.map(q=>({id:q.typed.public_id,hash:q.typed.definition_hash,skill:q.skillCode}))})).digest('hex') : snapshotHash(questionSet, questions);

      const result = db.prepare(`
        INSERT INTO class_assessment_assignments (
          public_id, class_id, owner_teacher_id, source_question_set_id,
          title_snapshot, description_snapshot, instructions,
          snapshot_hash, question_count, opens_at, closes_at,
          time_limit_minutes, randomize_questions, randomize_options,
          created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        schoolClass.id,
        req.user.id,
        questionSet.id,
        String(questionSet.title).trim(),
        questionSet.description || null,
        instructions,
        hash,
        questions.length,
        opensAt,
        closesAt,
        timeLimitMinutes,
        randomizeQuestions,
        randomizeOptions,
        req.user.id,
        req.user.id
      );

      const assignment = db.prepare('SELECT * FROM class_assessment_assignments WHERE id = ?')
        .get(result.lastInsertRowid);
      const insertItem = db.prepare(`
        INSERT INTO class_assessment_items (
          assignment_id, class_id, owner_teacher_id, source_question_id, source_skill_id,
          question_code_snapshot, skill_code_snapshot, skill_description_snapshot,
          statement_snapshot, support_text_snapshot, image_path_snapshot,
          development_space_snapshot, difficulty_snapshot, question_type_snapshot,
          explanation_snapshot, sort_order, show_image
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const insertOption = db.prepare(`
        INSERT INTO class_assessment_item_options (
          assessment_item_id, assignment_id, class_id, owner_teacher_id,
          option_label, option_text_snapshot, is_correct, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);

      questions.forEach((question) => {
        const itemResult = insertItem.run(
          assignment.id,
          assignment.class_id,
          assignment.owner_teacher_id,
          question.sourceQuestionId,
          question.sourceSkillId,
          question.questionCode,
          question.skillCode,
          question.skillDescription,
          question.statement,
          question.supportText,
          question.imagePath,
          question.developmentSpace,
          question.difficulty,
          question.questionType,
          question.explanation,
          question.sortOrder,
          question.showImage
        );
        if(question.typed)insertNumericSnapshot(db,itemResult.lastInsertRowid,question.typed);
        question.options.forEach((option) => {
          insertOption.run(
            itemResult.lastInsertRowid,
            assignment.id,
            assignment.class_id,
            assignment.owner_teacher_id,
            option.label,
            option.text,
            option.isCorrect,
            option.sortOrder
          );
        });
      });
      insertParticipants(assignment, participants, req.user.id);
      if(numeric) {
        db.prepare('INSERT INTO class_assessment_numeric_origins(assignment_id,owner_teacher_id,request_key,request_hash) VALUES(?,?,?,?)')
          .run(assignment.id,req.user.id,requestKey,requestHash);
        logActivityStrict({user:req.user,action:'create_numeric_class_assessment',module:'classes',
          entityType:'class_assessment',entityId:assignment.id,entityTitle:numericTitle,
          metadata:{class_id:schoolClass.public_id,question_count:questions.length,participant_count:participants.length},req},db);
      }
      return { assignmentId: assignment.id, schoolClass };
    });

    const created = createDraft.immediate();
    const assignment = assignmentWithCount(created.assignmentId);
    logActivity({
      user: req.user,
      action: 'create_class_assessment',
      module: 'classes',
      entityType: 'class_assessment',
      entityId: assignment.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: created.schoolClass.public_id,
        source_question_set_id: assignment.source_question_set_id,
        question_count: assignment.question_count,
        participant_count: Number(assignment.participant_count),
        status: assignment.status,
        answer_key_methodology: 'balanced-answer-key-v1',
      },
      req,
    });
    return res.status(201).json(serializeAssignment(assignment, { detail: true }));
  } catch (error) {
    return sendAssessmentError(error, res, next);
  }
});

router.patch('/:classPublicId/assessments/:assessmentPublicId', (req, res, next) => {
  try {
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) {
      throw new AssessmentRequestError(400, 'Informe a revisão atual da aplicação.');
    }

    const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
    if (!schoolClass) throw new AssessmentRequestError(404, 'Turma não encontrada.');
    if (schoolClass.status !== 'active') {
      throw new AssessmentRequestError(409, 'Restaure a turma antes de editar a aplicação.');
    }
    const current = ownedAssignment(schoolClass.id, req.params.assessmentPublicId, req.user.id);
    if (!current) throw new AssessmentRequestError(404, 'Aplicação não encontrada.');
    if (current.status !== 'draft') {
      throw new AssessmentRequestError(409, 'Somente aplicações em rascunho podem ser editadas.');
    }

    const instructions = hasOwn(req.body, 'instructions')
      ? normalizeOptionalMultiline(req.body.instructions, 2000, 'As instruções')
      : current.instructions;
    const opensAt = hasOwn(req.body, 'opensAt')
      ? normalizeOptionalDate(req.body.opensAt, 'A abertura')
      : current.opens_at;
    const closesAt = hasOwn(req.body, 'closesAt')
      ? normalizeOptionalDate(req.body.closesAt, 'O encerramento')
      : current.closes_at;
    const timeLimitMinutes = hasOwn(req.body, 'timeLimitMinutes')
      ? normalizeOptionalTimeLimit(req.body.timeLimitMinutes)
      : current.time_limit_minutes;
    const randomizeQuestions = hasOwn(req.body, 'randomizeQuestions')
      ? normalizeBoolean(req.body.randomizeQuestions, 'A opção de embaralhar questões')
      : current.randomize_questions;
    const randomizeOptions = hasOwn(req.body, 'randomizeOptions')
      ? normalizeBoolean(req.body.randomizeOptions, 'A opção de embaralhar alternativas')
      : current.randomize_options;
    const participantPublicIds = hasOwn(req.body, 'participantIds')
      ? normalizeParticipantIds(req.body.participantIds)
      : null;
    validateWindow(opensAt, closesAt);

    const updateDraft = db.transaction(() => {
      const latestClass = ownedClass(req.params.classPublicId, req.user.id);
      if (!latestClass || latestClass.status !== 'active') {
        throw new AssessmentRequestError(409, 'A turma não está mais ativa.');
      }
      const savedParticipants = assignmentParticipants(current.id);
      if (participantPublicIds?.some(id => savedParticipants.some(person => person.id === id && person.status === 'exempted'))) {
        throw new AssessmentRequestError(409, 'Um estudante dispensado não pode ser incluído novamente nesta aplicação.');
      }
      const previousIds = new Set(savedParticipants.map(person => person.id));
      const addedIds = (participantPublicIds || []).filter(id => !previousIds.has(id));
      const addedParticipants = addedIds.length ? activeParticipants(latestClass.id, req.user.id, addedIds) : [];
      const removedParticipants = participantPublicIds ? savedParticipants.filter(person => person.status !== 'exempted' && !participantPublicIds.includes(person.id)) : [];
      if (removedParticipants.some(person => !person.canRemove)) {
        throw new AssessmentRequestError(409, 'Um estudante dessa seleção já possui códigos de acesso ou respostas registrados. A retirada foi bloqueada para preservar o histórico. Confira a matrícula antes de disponibilizar.');
      }
      const update = db.prepare(`
        UPDATE class_assessment_assignments
        SET instructions = ?, opens_at = ?, closes_at = ?, time_limit_minutes = ?,
            randomize_questions = ?, randomize_options = ?, updated_by = ?,
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND class_id = ? AND owner_teacher_id = ?
          AND status = 'draft' AND revision = ?
      `).run(
        instructions,
        opensAt,
        closesAt,
        timeLimitMinutes,
        randomizeQuestions,
        randomizeOptions,
        req.user.id,
        current.id,
        latestClass.id,
        req.user.id,
        expectedRevision
      );
      if (update.changes !== 1) {
        throw new AssessmentRequestError(
          409,
          'A aplicação foi alterada em outro acesso. Atualize os dados antes de tentar novamente.'
        );
      }
      if (participantPublicIds) {
        const remove = db.prepare('DELETE FROM class_assessment_participants WHERE assignment_id = ? AND student_id = (SELECT id FROM students WHERE public_id = ?)');
        removedParticipants.forEach(person => remove.run(current.id, person.id));
        const assignment = db.prepare('SELECT * FROM class_assessment_assignments WHERE id = ?')
          .get(current.id);
        insertParticipants(assignment, addedParticipants, req.user.id);
      }
      const updated = assignmentWithCount(current.id);
      logActivityStrict({
        user: req.user, action: 'update_class_assessment', module: 'classes', entityType: 'class_assessment',
        entityId: updated.id, entityTitle: updated.title_snapshot,
        metadata: { class_id: latestClass.public_id, question_count: updated.question_count,
          participant_count: Number(updated.participant_count), revision: updated.revision,
          added_participant_ids: addedIds, removed_participant_ids: removedParticipants.map(person => person.id),
          roster_changed: addedIds.length > 0 || removedParticipants.length > 0 }, req,
      }, db);
      return updated;
    });

    const updated = updateDraft();
    return res.json(serializeAssignment(updated, { detail: true }));
  } catch (error) {
    return sendAssessmentError(error, res, next);
  }
});

router.patch(
  '/:classPublicId/assessments/:assessmentPublicId/delivery',
  requireFeatureFlag('classes.assessment_delivery'),
  (req, res, next) => {
    try {
      const expectedRevision = positiveInteger(req.body?.expectedRevision);
      if (!expectedRevision) {
        throw new AssessmentRequestError(400, 'Informe a revisão atual da aplicação.');
      }
      const action = String(req.body?.action || '').trim().toLowerCase();
      const validActions = new Set(['schedule', 'open', 'return_to_draft', 'close', 'cancel']);
      if (!validActions.has(action)) {
        throw new AssessmentRequestError(400, 'Selecione uma ação de disponibilização válida.');
      }

      const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
      if (!schoolClass) throw new AssessmentRequestError(404, 'Turma não encontrada.');
      synchronizeTemporalStatus(schoolClass, req);
      const current = ownedAssignment(
        schoolClass.id,
        req.params.assessmentPublicId,
        req.user.id
      );
      if (!current) throw new AssessmentRequestError(404, 'Aplicação não encontrada.');
      if(['open','schedule'].includes(action) && numericItems(db,current.id).size
        && !evaluateFeatureFlag(db,'classes.numeric_assessments',req.user).enabled)
        throw new AssessmentRequestError(404,'A aplicação numérica está temporariamente indisponível. O rascunho foi preservado.');
      if (current.revision !== expectedRevision) {
        throw new AssessmentRequestError(
          409,
          'A aplicação foi alterada em outro acesso. Atualize os dados antes de tentar novamente.'
        );
      }

      const now = new Date().toISOString();
      let targetStatus;
      let opensAt = current.opens_at;
      let closesAt = current.closes_at;
      let openedAt = current.opened_at;
      let closedAt = current.closed_at;
      let cancelledAt = current.cancelled_at;

      if (action === 'schedule') {
        if (current.status !== 'draft') {
          throw new AssessmentRequestError(409, 'Somente um rascunho pode ser agendado.');
        }
        if (schoolClass.status !== 'active') {
          throw new AssessmentRequestError(409, 'Restaure a turma antes de agendar a aplicação.');
        }
        opensAt = hasOwn(req.body, 'opensAt')
          ? normalizeOptionalDate(req.body.opensAt, 'A abertura')
          : current.opens_at;
        closesAt = hasOwn(req.body, 'closesAt')
          ? normalizeOptionalDate(req.body.closesAt, 'O encerramento')
          : current.closes_at;
        if (!opensAt || Date.parse(opensAt) <= Date.parse(now)) {
          throw new AssessmentRequestError(400, 'Escolha uma abertura futura para o agendamento.');
        }
        validateWindow(opensAt, closesAt);
        targetStatus = 'scheduled';
        openedAt = null;
        closedAt = null;
        cancelledAt = null;
      } else if (action === 'open') {
        if (!['draft', 'scheduled'].includes(current.status)) {
          throw new AssessmentRequestError(409, 'Esta aplicação não pode mais ser disponibilizada.');
        }
        if (schoolClass.status !== 'active') {
          throw new AssessmentRequestError(409, 'Restaure a turma antes de disponibilizar a aplicação.');
        }
        closesAt = hasOwn(req.body, 'closesAt')
          ? normalizeOptionalDate(req.body.closesAt, 'O encerramento')
          : current.closes_at;
        if (closesAt && Date.parse(closesAt) <= Date.parse(now)) {
          throw new AssessmentRequestError(400, 'O encerramento precisa estar no futuro.');
        }
        opensAt = now;
        validateWindow(opensAt, closesAt);
        targetStatus = 'open';
        openedAt = now;
        closedAt = null;
        cancelledAt = null;
      } else if (action === 'return_to_draft') {
        if (current.status !== 'scheduled') {
          throw new AssessmentRequestError(409, 'Somente uma aplicação agendada pode voltar a rascunho.');
        }
        targetStatus = 'draft';
        openedAt = null;
        closedAt = null;
        cancelledAt = null;
      } else if (action === 'close') {
        if (current.status !== 'open') {
          throw new AssessmentRequestError(409, 'Somente uma aplicação disponível pode ser encerrada.');
        }
        targetStatus = 'closed';
        const openedTimestamp = Date.parse(current.opened_at || current.opens_at || now);
        const closeTimestamp = Math.max(Date.parse(now), openedTimestamp + 1000);
        closesAt = new Date(closeTimestamp).toISOString();
        closedAt = closesAt;
        cancelledAt = null;
      } else {
        if (!['scheduled', 'open'].includes(current.status)) {
          throw new AssessmentRequestError(409, 'Somente aplicações agendadas ou disponíveis podem ser canceladas.');
        }
        targetStatus = 'cancelled';
        cancelledAt = now;
        closedAt = null;
      }

      const changeDeliveryStatus = db.transaction(() => {
        if (['open', 'scheduled'].includes(targetStatus) && !assessmentRosterReady(db, current.id)) {
          throw new AssessmentRequestError(409, 'Confira as matrículas antes de disponibilizar. A turma precisa estar ativa e todos os estudantes selecionados devem ter cadastro e matrícula ativos. Nenhum estudante foi retirado automaticamente.');
        }
        const update = db.prepare(`
          UPDATE class_assessment_assignments
          SET status = ?, opens_at = ?, closes_at = ?, opened_at = ?, closed_at = ?,
              cancelled_at = ?, updated_by = ?, revision = revision + 1,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND class_id = ? AND owner_teacher_id = ?
            AND status = ? AND revision = ?
        `).run(
          targetStatus,
          opensAt,
          closesAt,
          openedAt,
          closedAt,
          cancelledAt,
          req.user.id,
          current.id,
          schoolClass.id,
          req.user.id,
          current.status,
          expectedRevision
        );
        if (update.changes !== 1) {
          throw new AssessmentRequestError(
            409,
            'A aplicação mudou durante esta operação. Atualize a tela antes de tentar novamente.'
          );
        }
        const autoSubmitted = targetStatus === 'closed'
          ? finalizePendingStudentOnlineAttempts(db, current.id)
          : [];
        return { assignment: assignmentWithCount(current.id), autoSubmitted };
      });

      const deliveryOutcome = changeDeliveryStatus();
      const updated = deliveryOutcome.assignment;
      const activityAction = {
        schedule: 'schedule_class_assessment',
        open: 'open_class_assessment',
        return_to_draft: 'return_class_assessment_to_draft',
        close: 'close_class_assessment',
        cancel: 'cancel_class_assessment',
      }[action];
      logActivity({
        user: req.user,
        action: activityAction,
        module: 'classes',
        entityType: 'class_assessment',
        entityId: updated.id,
        entityTitle: updated.title_snapshot,
        metadata: {
          class_id: schoolClass.public_id,
          previous_status: current.status,
          status: updated.status,
          opens_at: updated.opens_at,
          closes_at: updated.closes_at,
          revision: updated.revision,
        },
        req,
      });
      deliveryOutcome.autoSubmitted.forEach(({ attempt, studentPublicId }) => {
        logActivity({
          user: req.user,
          action: 'auto_submit_student_online_assessment',
          module: 'classes',
          entityType: 'class_assessment_attempt',
          entityId: attempt.id,
          entityTitle: updated.title_snapshot,
          description: `As respostas salvas de um estudante em "${updated.title_snapshot}" foram enviadas automaticamente no encerramento.`,
          metadata: {
            class_id: schoolClass.public_id,
            assessment_id: updated.public_id,
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
      return res.json(serializeAssignment(updated, { detail: true }));
    } catch (error) {
      return sendAssessmentError(error, res, next);
    }
  }
);

module.exports = router;
