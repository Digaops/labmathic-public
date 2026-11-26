const { v4: uuidv4 } = require('uuid');
const { logActivityStrict } = require('../helpers/activity');
const { buildLearningRecoveryPreview } = require('./learningRecoveryPreview');
const {
  LearningRecoveryConfirmationError,
  normalizeConfirmation,
  resolveAcceptedPriorities,
  serializePlan,
} = require('./learningRecoveryConfirmation');
const { serializeLearningRecoveryExecution } = require('./learningRecoveryExecution');

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

function normalizeDraftReview(body) {
  return {
    ...normalizeConfirmation(body),
    expectedPlanRevision: positiveInteger(
      body?.expectedPlanRevision,
      'A revisão esperada do plano'
    ),
  };
}

function ownedPlanContext(database, {
  teacherId,
  classPublicId,
  assessmentPublicId,
  planPublicId,
}) {
  return database.prepare(`
    SELECT
      assignment.*,
      plan.id AS recovery_plan_id,
      plan.public_id AS recovery_plan_public_id,
      plan.title AS recovery_plan_title,
      plan.status AS recovery_plan_status,
      plan.revision AS recovery_plan_revision,
      plan.source_assessment_revision AS recovery_source_assessment_revision,
      plan.source_results_revision_hash AS recovery_source_results_revision_hash,
      plan.methodology_version AS recovery_methodology_version,
      plan.diagnostic_algorithm_version_snapshot AS recovery_algorithm_version,
      plan.diagnostic_confirmation_version_snapshot AS recovery_confirmation_version,
      review.reviewed_at AS diagnostic_reviewed_at
    FROM learning_recovery_plans plan
    JOIN class_assessment_assignments assignment
      ON assignment.id = plan.source_assignment_id
      AND assignment.class_id = plan.class_id
      AND assignment.owner_teacher_id = plan.owner_teacher_id
    JOIN school_classes school_class
      ON school_class.id = plan.class_id
      AND school_class.owner_teacher_id = plan.owner_teacher_id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    LEFT JOIN diagnostic_question_set_reviews review
      ON review.question_set_id = diagnostic.question_set_id
      AND review.owner_teacher_id = diagnostic.owner_teacher_id
    WHERE plan.public_id = ?
      AND school_class.public_id = ?
      AND assignment.public_id = ?
      AND plan.owner_teacher_id = ?
  `).get(planPublicId, classPublicId, assessmentPublicId, teacherId);
}

function requireOwnedPlan(database, context) {
  const plan = ownedPlanContext(database, context);
  if (!plan) fail(404, 'recovery_plan_not_found', 'Plano de recomposição não encontrado.');
  return plan;
}

function validateEditableSource(database, plan, review) {
  if (plan.recovery_plan_status !== 'draft') {
    fail(409, 'recovery_plan_frozen', 'Este plano já foi revisado e não pode mais ser alterado.');
  }
  if (plan.recovery_plan_revision !== review.expectedPlanRevision) {
    fail(
      409,
      'stale_plan',
      'O rascunho foi alterado em outro acesso. Recarregue o plano antes de continuar.',
      { currentRevision: plan.recovery_plan_revision }
    );
  }
  if (plan.status !== 'closed' || !plan.diagnostic_reviewed_at) {
    fail(409, 'recovery_source_changed', 'A avaliação de origem não está mais disponível para revisão.');
  }
  if (
    plan.revision !== review.expectedAssessmentRevision
    || plan.recovery_source_assessment_revision !== review.expectedAssessmentRevision
  ) {
    fail(
      409,
      'stale_preview',
      'Os dados da aplicação mudaram. Recarregue a recomposição antes de continuar.'
    );
  }
  if (plan.recovery_methodology_version !== review.methodologyVersion) {
    fail(409, 'methodology_changed', 'A metodologia mudou. Recarregue a recomposição antes de continuar.');
  }

  const preview = buildLearningRecoveryPreview(database, plan, plan.owner_teacher_id);
  if (!preview.isActionable || preview.methodology.version !== review.methodologyVersion) {
    fail(409, 'preview_not_actionable', 'Os resultados atuais não sustentam mais esta recomposição.');
  }
  if (
    preview.source.resultRevision !== review.expectedResultRevision
    || plan.recovery_source_results_revision_hash !== review.expectedResultRevision
  ) {
    fail(
      409,
      'stale_results',
      'Os resultados mudaram. Recarregue e confira novamente as prioridades.'
    );
  }
  return preview;
}

function replaceDraftContent(database, plan, review, accepted) {
  database.prepare(`
    DELETE FROM learning_recovery_student_groups WHERE plan_id = ?
  `).run(plan.recovery_plan_id);
  database.prepare(`
    DELETE FROM learning_recovery_plan_skills WHERE plan_id = ?
  `).run(plan.recovery_plan_id);

  const insertSkill = database.prepare(`
    INSERT INTO learning_recovery_plan_skills (
      plan_id, owner_teacher_id, class_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot,
      success_rate_snapshot, opportunity_count, diagnostic_level,
      priority, suggested_question_count, rationale
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertGroup = database.prepare(`
    INSERT INTO learning_recovery_student_groups (
      public_id, plan_id, owner_teacher_id, class_id,
      focus_skill_id, focus_skill_code_snapshot,
      title, objective, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const insertMember = database.prepare(`
    INSERT INTO learning_recovery_student_group_members (
      group_id, plan_id, student_id, owner_teacher_id, class_id,
      success_rate_snapshot, opportunity_count
    ) VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  let groupCount = 0;
  let groupMemberCount = 0;
  accepted.forEach(({ selection, priority, group, order }) => {
    insertSkill.run(
      plan.recovery_plan_id,
      plan.owner_teacher_id,
      plan.class_id,
      priority.skill.id,
      priority.skill.code,
      priority.skill.description,
      priority.result.successRate,
      priority.result.opportunityCount,
      priority.result.level,
      order,
      selection.suggestedQuestionCount,
      selection.rationale
    );
    if (!group) return;
    const groupId = Number(insertGroup.run(
      uuidv4(),
      plan.recovery_plan_id,
      plan.owner_teacher_id,
      plan.class_id,
      priority.skill.id,
      priority.skill.code,
      group.title,
      group.objective,
      order
    ).lastInsertRowid);
    groupCount += 1;
    group.students.forEach((student) => {
      insertMember.run(
        groupId,
        plan.recovery_plan_id,
        student.internalId,
        plan.owner_teacher_id,
        plan.class_id,
        student.successRate,
        student.opportunityCount
      );
      groupMemberCount += 1;
    });
  });

  return {
    priorityCount: accepted.length,
    groupCount,
    groupMemberCount,
    title: review.title,
  };
}

function getLearningRecoveryPlan(database, context) {
  const plan = requireOwnedPlan(database, context);
  return {
    ...serializePlan(database, plan.recovery_plan_id),
    execution: serializeLearningRecoveryExecution(
      database,
      plan.recovery_plan_id,
      context.teacherId
    ),
  };
}

function updateLearningRecoveryPlanDraft(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  body,
  request,
}) {
  const review = normalizeDraftReview(body);
  const persist = database.transaction(() => {
    const plan = requireOwnedPlan(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    const preview = validateEditableSource(database, plan, review);
    const accepted = resolveAcceptedPriorities(database, plan, review, preview);
    const counts = replaceDraftContent(database, plan, review, accepted);
    const updated = database.prepare(`
      UPDATE learning_recovery_plans
      SET title = ?, revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND status = 'draft'
    `).run(
      review.title,
      teacher.id,
      plan.recovery_plan_id,
      review.expectedPlanRevision
    );
    if (updated.changes !== 1) {
      fail(409, 'stale_plan', 'O rascunho foi alterado em outro acesso. Recarregue antes de continuar.');
    }

    logActivityStrict({
      user: teacher,
      action: 'update_learning_recovery_plan',
      module: 'classes',
      entityType: 'learning_recovery_plan',
      entityId: plan.recovery_plan_id,
      entityTitle: review.title,
      description: `${teacher.name || teacher.email || 'Professor'} salvou a revisão do rascunho de recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        previous_revision: review.expectedPlanRevision,
        ...counts,
      },
      req: request,
    }, database);

    return serializePlan(database, plan.recovery_plan_id);
  });
  return persist.immediate();
}

function activateLearningRecoveryPlan(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  body,
  request,
}) {
  if (body?.reviewConfirmed !== true) {
    fail(400, 'review_confirmation_required', 'Confirme explicitamente a revisão pedagógica do plano.');
  }
  const review = normalizeDraftReview(body);
  const persist = database.transaction(() => {
    const plan = requireOwnedPlan(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    if (plan.recovery_plan_status === 'active') {
      return { activated: false, replayed: true, plan: serializePlan(database, plan.recovery_plan_id) };
    }
    const preview = validateEditableSource(database, plan, review);
    const accepted = resolveAcceptedPriorities(database, plan, review, preview);
    const counts = replaceDraftContent(database, plan, review, accepted);
    const activated = database.prepare(`
      UPDATE learning_recovery_plans
      SET title = ?, status = 'active', activated_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND status = 'draft'
    `).run(
      review.title,
      teacher.id,
      plan.recovery_plan_id,
      review.expectedPlanRevision
    );
    if (activated.changes !== 1) {
      fail(409, 'stale_plan', 'O rascunho foi alterado em outro acesso. Recarregue antes de continuar.');
    }

    logActivityStrict({
      user: teacher,
      action: 'activate_learning_recovery_plan',
      module: 'classes',
      entityType: 'learning_recovery_plan',
      entityId: plan.recovery_plan_id,
      entityTitle: review.title,
      description: `${teacher.name || teacher.email || 'Professor'} concluiu a revisão pedagógica e ativou o plano de recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        previous_revision: review.expectedPlanRevision,
        methodology_version: review.methodologyVersion,
        ...counts,
      },
      req: request,
    }, database);

    return {
      activated: true,
      replayed: false,
      plan: serializePlan(database, plan.recovery_plan_id),
    };
  });
  return persist.immediate();
}

module.exports = {
  getLearningRecoveryPlan,
  normalizeDraftReview,
  updateLearningRecoveryPlanDraft,
  activateLearningRecoveryPlan,
};
