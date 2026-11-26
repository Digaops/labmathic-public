const { v4: uuidv4 } = require('uuid');
const { logActivityStrict } = require('../helpers/activity');
const {
  AnswerKeyBalanceError,
  createQuestionSetOptionOrders,
} = require('./answerKeyBalance');
const { analyzeClassAssessment } = require('./classAssessmentAnalysis');
const { buildMatchedRecoveryComparison } = require('./learningRecoveryComparison');
const { LearningRecoveryConfirmationError } = require('./learningRecoveryConfirmation');
const { loadQuestionCandidates, MONITORING_QUESTION_TARGET } = require('./learningRecoveryPreview');
const { isEditorialPilotEnabled } = require('./questionEditorialCuration');

const MONITORING_SELECTION_METHOD = 'unused-questions-v2';

function fail(status, code, message, details) {
  throw new LearningRecoveryConfirmationError(status, code, message, details);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  return number;
}

function ownedMonitoringContext(database, {
  teacherId,
  classPublicId,
  assessmentPublicId,
  planPublicId,
}) {
  const context = database.prepare(`
    SELECT
      recovery.id AS recovery_id,
      recovery.public_id AS recovery_public_id,
      recovery.title AS recovery_title,
      recovery.status AS recovery_status,
      recovery.source_assignment_id,
      recovery.class_id,
      execution.id AS execution_id,
      execution.public_id AS execution_public_id,
      execution.status AS execution_status,
      execution.revision AS execution_revision,
      monitoring_lesson.id AS monitoring_lesson_id,
      monitoring_lesson.public_id AS monitoring_lesson_public_id,
      monitoring_lesson.status AS monitoring_lesson_status
    FROM learning_recovery_plans recovery
    JOIN school_classes school_class
      ON school_class.id = recovery.class_id
      AND school_class.owner_teacher_id = recovery.owner_teacher_id
    JOIN class_assessment_assignments source_assignment
      ON source_assignment.id = recovery.source_assignment_id
      AND source_assignment.class_id = recovery.class_id
      AND source_assignment.owner_teacher_id = recovery.owner_teacher_id
    JOIN teaching_plans execution
      ON execution.source_recovery_plan_id = recovery.id
      AND execution.owner_teacher_id = recovery.owner_teacher_id
    JOIN teaching_plan_lessons monitoring_lesson
      ON monitoring_lesson.plan_id = execution.id
      AND monitoring_lesson.owner_teacher_id = execution.owner_teacher_id
      AND monitoring_lesson.lesson_phase = 'monitoring'
    WHERE recovery.public_id = ?
      AND school_class.public_id = ?
      AND source_assignment.public_id = ?
      AND recovery.owner_teacher_id = ?
  `).get(planPublicId, classPublicId, assessmentPublicId, teacherId);
  if (!context) fail(404, 'recovery_plan_not_found', 'Plano de recomposição não encontrado.');
  return context;
}

function serializeLearningRecoveryMonitoring(database, { recoveryPlanId, teacherId }) {
  const monitoring = database.prepare(`
    SELECT
      cycle.id,
      cycle.public_id,
      cycle.revision,
      cycle.question_set_id,
      cycle.assignment_id,
      cycle.created_at,
      cycle.updated_at,
      cycle.class_id,
      recovery.source_assignment_id,
      question_set.title AS question_set_title,
      assignment.public_id AS assignment_public_id,
      assignment.title_snapshot AS assignment_title,
      assignment.status AS assignment_status,
      assignment.revision AS assignment_revision,
      assignment.question_count,
      assignment.opens_at,
      assignment.closes_at,
      assignment.opened_at,
      assignment.closed_at,
      assignment.cancelled_at,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      (
        SELECT COUNT(*) FROM class_assessment_participants participant
        WHERE participant.assignment_id = assignment.id
          AND participant.status <> 'exempted'
      ) AS participant_count,
      (
        SELECT COUNT(*) FROM class_assessment_attempts attempt
        WHERE attempt.assignment_id = assignment.id AND attempt.status = 'submitted'
      ) AS submitted_count
    FROM learning_recovery_monitoring_cycles cycle
    JOIN learning_recovery_plans recovery ON recovery.id = cycle.recovery_plan_id
      AND recovery.owner_teacher_id = cycle.owner_teacher_id AND recovery.class_id = cycle.class_id
    JOIN question_sets question_set ON question_set.id = cycle.question_set_id
    JOIN school_classes school_class
      ON school_class.id = cycle.class_id
      AND school_class.owner_teacher_id = cycle.owner_teacher_id
    LEFT JOIN class_assessment_assignments assignment ON assignment.id = cycle.assignment_id
    WHERE cycle.recovery_plan_id = ? AND cycle.owner_teacher_id = ?
  `).get(recoveryPlanId, teacherId);
  if (!monitoring) return null;

  const participantCount = Number(monitoring.participant_count || 0);
  const submittedCount = Number(monitoring.submitted_count || 0);
  let state = 'needs_application';
  if (monitoring.assignment_status === 'draft') state = 'draft';
  else if (monitoring.assignment_status === 'scheduled') state = 'scheduled';
  else if (monitoring.assignment_status === 'open') state = 'open';
  else if (monitoring.assignment_status === 'closed' && submittedCount > 0) state = 'evidence_ready';
  else if (monitoring.assignment_status === 'closed') state = 'awaiting_results';
  else if (monitoring.assignment_status === 'cancelled') state = 'cancelled';

  let comparison = null;
  if (state === 'evidence_ready') {
    const assignment = database.prepare(`
      SELECT assignment.*, school_class.name AS class_name
      FROM class_assessment_assignments assignment
      JOIN school_classes school_class ON school_class.id = assignment.class_id
      WHERE assignment.id = ? AND assignment.owner_teacher_id = ?
    `).get(monitoring.assignment_id, teacherId);
    const analysis = analyzeClassAssessment(database, assignment);
    const baselineSkills = database.prepare(`
      SELECT skill_code_snapshot, skill_description_snapshot,
        success_rate_snapshot, opportunity_count
      FROM learning_recovery_plan_skills
      WHERE plan_id = ? AND owner_teacher_id = ?
      ORDER BY priority, id
    `).all(recoveryPlanId, teacherId);
    comparison = {
      ...buildMatchedRecoveryComparison(database, {
        teacherId, classId: monitoring.class_id,
        sourceAssignmentId: monitoring.source_assignment_id,
        monitoringAssignmentId: monitoring.assignment_id, baselineSkills,
      }),
      overview: analysis.overview,
      studentsNeedingFollowUp: analysis.studentsNeedingFollowUp.map((student) => ({
        id: student.id,
        displayName: student.displayName,
        percentage: student.percentage,
      })),
    };
  }

  return {
    id: monitoring.public_id,
    revision: Number(monitoring.revision),
    state,
    questionSet: {
      id: monitoring.question_set_id,
      title: monitoring.question_set_title,
    },
    application: monitoring.assignment_id ? {
      id: monitoring.assignment_public_id,
      title: monitoring.assignment_title,
      status: monitoring.assignment_status,
      revision: Number(monitoring.assignment_revision),
      questionCount: Number(monitoring.question_count),
      participantCount,
      submittedCount,
      opensAt: monitoring.opens_at,
      closesAt: monitoring.closes_at,
      openedAt: monitoring.opened_at,
      closedAt: monitoring.closed_at,
      cancelledAt: monitoring.cancelled_at,
    } : null,
    class: {
      id: monitoring.class_public_id,
      name: monitoring.class_name,
    },
    comparison,
    createdAt: monitoring.created_at,
    updatedAt: monitoring.updated_at,
  };
}

function learningRecoveryMonitoringOptions(database, contextParams) {
  const context = ownedMonitoringContext(database, contextParams);
  if (context.recovery_status !== 'active' || context.execution_status !== 'active') {
    fail(409, 'recovery_execution_frozen', 'Esta recomposição não aceita uma nova verificação.');
  }
  const pendingInterventions = Number(database.prepare(`
    SELECT COUNT(*)
    FROM teaching_plan_lessons
    WHERE plan_id = ? AND owner_teacher_id = ?
      AND lesson_phase = 'intervention' AND status = 'planned'
  `).pluck().get(context.execution_id, contextParams.teacherId));
  if (pendingInterventions > 0) {
    fail(
      409,
      'recovery_interventions_pending',
      'Registre todas as intervenções antes de preparar a verificação de aprendizagem.',
      { pendingInterventions }
    );
  }
  const existing = serializeLearningRecoveryMonitoring(database, {
    recoveryPlanId: context.recovery_id,
    teacherId: contextParams.teacherId,
  });
  if (existing) return { existing, ready: true, skills: [], questionCount: 0 };

  const sourceAssignment = database.prepare(`
    SELECT assignment.*, school_class.name AS class_name
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
    WHERE assignment.id = ? AND assignment.owner_teacher_id = ?
  `).get(context.source_assignment_id, contextParams.teacherId);
  const acceptedSkills = database.prepare(`
    SELECT skill.id, accepted.skill_code_snapshot AS code,
      accepted.skill_description_snapshot AS description, unit.name AS unitName
    FROM learning_recovery_plan_skills accepted
    LEFT JOIN bncc_skills skill ON skill.id = accepted.source_skill_id
      AND skill.code = accepted.skill_code_snapshot
    LEFT JOIN bncc_units unit ON unit.id = skill.unit_id
    WHERE accepted.plan_id = ? AND accepted.owner_teacher_id = ?
    ORDER BY accepted.priority, accepted.id
  `).all(context.recovery_id, contextParams.teacherId);
  const reinforcementIds = database.prepare(`
    SELECT resource.question_id
    FROM teaching_plan_lesson_resources resource
    JOIN teaching_plan_lessons lesson ON lesson.id = resource.lesson_id
    WHERE resource.plan_id = ? AND resource.owner_teacher_id = ?
      AND resource.resource_type = 'question'
      AND lesson.lesson_phase = 'intervention'
  `).all(context.execution_id, contextParams.teacherId).map(({ question_id: id }) => id);

  // Use the confirmed plan, not today's prioritization or its suggested split.
  // A candidate never selected for intervention remains eligible for verification.
  const pilotEnabled = isEditorialPilotEnabled(database, { id: contextParams.teacherId, role: 'professor' });
  const skills = acceptedSkills.map(skill => {
    const questions = skill.id ? loadQuestionCandidates(database, sourceAssignment,
      contextParams.teacherId, skill.id, {
        excludedQuestionIds: reinforcementIds, limit: MONITORING_QUESTION_TARGET, pilotEnabled, purpose: 'verification',
      }).map(question => ({ ...question, selected: true })) : [];
    return {
      skill, minimum: 1, recommended: MONITORING_QUESTION_TARGET,
      availability: !skill.id ? 'skill_unavailable' : questions.length ? 'available' : 'no_questions',
      questions,
    };
  });
  const ready = skills.length > 0 && skills.every(({ questions }) => questions.length >= 1);
  const warnings = skills.filter(({ questions }) => !questions.length).map(({ skill }) => !skill.id
    ? `${skill.code}: o cadastro desta habilidade precisa ser conferido pela administração.`
    : `${skill.code}: cadastre ao menos uma questão com quatro alternativas e um único gabarito, sem repetir o diagnóstico nem as questões escolhidas para o apoio.`);
  if (!skills.length) warnings.push('Não há habilidades confirmadas neste plano. Atualize a página e confira o plano.');
  return {
    existing: null,
    executionRevision: Number(context.execution_revision),
    selectionMethodology: MONITORING_SELECTION_METHOD,
    ready,
    questionCount: skills.reduce((total, skill) => total + skill.questions.length, 0),
    skills,
    warnings,
  };
}

function normalizeMonitoringItems(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) {
    fail(400, 'invalid_request', 'Selecione de 1 a 50 questões para a verificação.');
  }
  const items = value.map((item, index) => ({
    id: positiveInteger(item?.id, `A questão ${index + 1}`),
    showImage: item?.showImage !== false,
  }));
  if (new Set(items.map(({ id }) => id)).size !== items.length) {
    fail(400, 'invalid_request', 'A seleção da verificação contém questões repetidas.');
  }
  return items;
}

function createLearningRecoveryMonitoring(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  body,
  request,
}) {
  const expectedExecutionRevision = positiveInteger(
    body?.expectedExecutionRevision,
    'A revisão esperada da execução'
  );
  const requestedItems = normalizeMonitoringItems(body?.questions);
  const persist = database.transaction(() => {
    const options = learningRecoveryMonitoringOptions(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    if (options.existing) {
      return { created: false, replayed: true, monitoring: options.existing };
    }
    if (!options.ready) {
      fail(409, 'monitoring_questions_unavailable', options.warnings[0]);
    }
    if (options.executionRevision !== expectedExecutionRevision) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de continuar.');
    }
    const questionById = new Map();
    const skillByQuestionId = new Map();
    options.skills.forEach(({ skill, questions }) => questions.forEach((question) => {
      questionById.set(question.id, question);
      skillByQuestionId.set(question.id, skill.code);
    }));
    if (requestedItems.some(({ id }) => !questionById.has(id))) {
      fail(400, 'invalid_monitoring_question', 'Uma das questões não está mais disponível para esta verificação. Atualize as opções antes de continuar.');
    }
    const selectedSkillCodes = new Set(requestedItems.map(({ id }) => skillByQuestionId.get(id)));
    if (options.skills.some(({ skill }) => !selectedSkillCodes.has(skill.code))) {
      fail(400, 'incomplete_monitoring_coverage', 'Selecione ao menos uma questão de cada habilidade priorizada.');
    }

    const context = ownedMonitoringContext(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    const selectedQuestions = database.prepare(`
      SELECT id, source FROM questions
      WHERE id IN (${requestedItems.map(() => '?').join(', ')})
    `).all(...requestedItems.map(({ id }) => id));
    const containsAuthorQuestions = selectedQuestions.some(({ source }) => source === 'teacher');
    const title = `Verificação · ${context.recovery_title}`.slice(0, 200);
    const description = 'Verificação de aprendizagem vinculada ao plano de recomposição. Questões inéditas em relação ao diagnóstico de origem.';
    const questionSetId = Number(database.prepare(`
      INSERT INTO question_sets (
        user_id, title, description, is_public, contains_author_questions
      ) VALUES (?, ?, ?, 0, ?)
    `).run(teacher.id, title, description, containsAuthorQuestions ? 1 : 0).lastInsertRowid);
    const questionItems = requestedItems.map((item, index) => ({
      question_id: item.id,
      sort_order: index + 1,
      show_image: item.showImage && questionById.get(item.id).hasImage ? 1 : 0,
    }));
    let optionOrders;
    try {
      optionOrders = createQuestionSetOptionOrders(
        database,
        questionItems,
        `recovery-monitoring:${context.recovery_public_id}`
      );
    } catch (error) {
      if (error instanceof AnswerKeyBalanceError) {
        fail(
          409,
          'monitoring_question_invalid',
          'Uma questão selecionada deixou de possuir quatro alternativas e um único gabarito. Recarregue a seleção.'
        );
      }
      throw error;
    }
    const insertItem = database.prepare(`
      INSERT INTO question_set_items (
        question_set_id, question_id, sort_order, show_image, option_order
      ) VALUES (?, ?, ?, ?, ?)
    `);
    questionItems.forEach((item) => insertItem.run(
      questionSetId,
      item.question_id,
      item.sort_order,
      item.show_image,
      optionOrders.get(item.question_id)
    ));
    const cycleId = Number(database.prepare(`
      INSERT INTO learning_recovery_monitoring_cycles (
        public_id, recovery_plan_id, execution_plan_id, monitoring_lesson_id,
        owner_teacher_id, class_id, question_set_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      context.recovery_id,
      context.execution_id,
      context.monitoring_lesson_id,
      teacher.id,
      context.class_id,
      questionSetId,
      teacher.id,
      teacher.id
    ).lastInsertRowid);
    database.prepare(`
      INSERT INTO teaching_plan_lesson_resources (
        lesson_id, plan_id, owner_teacher_id, resource_type,
        question_set_id, title_snapshot, teacher_notes, sort_order
      ) VALUES (?, ?, ?, 'question_set', ?, ?, ?, 10)
    `).run(
      context.monitoring_lesson_id,
      context.execution_id,
      teacher.id,
      questionSetId,
      title.slice(0, 240),
      'Verificação da aprendizagem criada a partir das habilidades priorizadas.'
    );
    const updated = database.prepare(`
      UPDATE teaching_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active' AND revision = ?
    `).run(teacher.id, context.execution_id, expectedExecutionRevision);
    if (updated.changes !== 1) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de continuar.');
    }
    database.prepare(`
      UPDATE learning_recovery_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, context.recovery_id);

    logActivityStrict({
      user: teacher,
      action: 'create_learning_recovery_monitoring',
      module: 'classes',
      entityType: 'learning_recovery_monitoring',
      entityId: cycleId,
      entityTitle: title,
      description: `${teacher.name || teacher.email || 'Professor'} preparou a verificação do plano de recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        question_set_id: questionSetId,
        question_ids: requestedItems.map(({ id }) => id),
        answer_key_methodology: 'balanced-answer-key-v1',
        selection_methodology: MONITORING_SELECTION_METHOD,
      },
      req: request,
    }, database);

    return {
      created: true,
      replayed: false,
      monitoring: serializeLearningRecoveryMonitoring(database, {
        recoveryPlanId: context.recovery_id,
        teacherId: teacher.id,
      }),
    };
  });
  return persist.immediate();
}

module.exports = {
  serializeLearningRecoveryMonitoring,
  learningRecoveryMonitoringOptions,
  createLearningRecoveryMonitoring,
};
