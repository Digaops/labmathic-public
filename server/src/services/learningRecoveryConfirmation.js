const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { logActivityStrict } = require('../helpers/activity');
const {
  buildLearningRecoveryPreview,
} = require('./learningRecoveryPreview');

const METHODOLOGY_VERSION = 'descriptive-v1';
const MAX_PRIORITIES = 10;
const MAX_GROUP_STUDENTS = 200;

class LearningRecoveryConfirmationError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'LearningRecoveryConfirmationError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new LearningRecoveryConfirmationError(status, code, message, details);
}

function trimmedString(value, { field, required = false, maxLength }) {
  if (value === null || value === undefined || value === '') {
    if (required) fail(400, 'invalid_request', `Informe ${field}.`);
    return null;
  }
  if (typeof value !== 'string') fail(400, 'invalid_request', `${field} é inválido.`);
  const normalized = value.trim();
  if (!normalized && required) fail(400, 'invalid_request', `Informe ${field}.`);
  if (!normalized) return null;
  if (normalized.length > maxLength) {
    fail(400, 'invalid_request', `${field} deve ter no máximo ${maxLength} caracteres.`);
  }
  return normalized;
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  return number;
}

function sha256Revision(value) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    fail(400, 'invalid_request', 'A revisão dos resultados é inválida. Gere uma nova prévia.');
  }
  return value;
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') {
    fail(400, 'idempotency_key_required', 'Envie uma chave de idempotência para confirmar o plano.');
  }
  const normalized = value.trim();
  if (
    normalized.length < 20
    || normalized.length > 200
    || !/^[A-Za-z0-9._:-]+$/.test(normalized)
  ) {
    fail(
      400,
      'invalid_idempotency_key',
      'A chave de idempotência deve ter entre 20 e 200 caracteres seguros.'
    );
  }
  return normalized;
}

function normalizeGroup(group, priorityIndex) {
  if (group === null || group === undefined) return null;
  if (typeof group !== 'object' || Array.isArray(group)) {
    fail(400, 'invalid_request', `O grupo da prioridade ${priorityIndex + 1} é inválido.`);
  }
  if (!Array.isArray(group.studentIds)) {
    fail(400, 'invalid_request', `Informe os estudantes do grupo da prioridade ${priorityIndex + 1}.`);
  }
  if (!group.studentIds.length || group.studentIds.length > MAX_GROUP_STUDENTS) {
    fail(
      400,
      'invalid_request',
      `O grupo da prioridade ${priorityIndex + 1} deve ter entre 1 e ${MAX_GROUP_STUDENTS} estudantes.`
    );
  }
  const studentIds = group.studentIds.map((studentId) => {
    if (typeof studentId !== 'string') {
      fail(400, 'invalid_request', 'Um ou mais estudantes selecionados são inválidos.');
    }
    const normalized = studentId.trim();
    if (normalized.length < 20 || normalized.length > 64) {
      fail(400, 'invalid_request', 'Um ou mais estudantes selecionados são inválidos.');
    }
    return normalized;
  });
  if (new Set(studentIds.map((id) => id.toLocaleLowerCase('pt-BR'))).size !== studentIds.length) {
    fail(400, 'invalid_request', 'O mesmo estudante não pode aparecer duas vezes no mesmo grupo.');
  }
  return {
    title: trimmedString(group.title, {
      field: 'o título do grupo',
      maxLength: 120,
    }),
    objective: trimmedString(group.objective, {
      field: 'o objetivo do grupo',
      maxLength: 1000,
    }),
    studentIds,
  };
}

function normalizeConfirmation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    fail(400, 'invalid_request', 'Os dados da confirmação são inválidos.');
  }
  const expectedAssessmentRevision = positiveInteger(
    body.expectedAssessmentRevision,
    'A revisão esperada da aplicação'
  );
  if (body.methodologyVersion !== METHODOLOGY_VERSION) {
    fail(409, 'methodology_changed', 'A metodologia da prévia mudou. Gere uma nova prévia antes de confirmar.');
  }
  const title = trimmedString(body.title, {
    field: 'o título do plano',
    required: true,
    maxLength: 160,
  });
  if (!Array.isArray(body.acceptedPriorities)) {
    fail(400, 'invalid_request', 'Selecione ao menos uma prioridade para o plano.');
  }
  if (!body.acceptedPriorities.length || body.acceptedPriorities.length > MAX_PRIORITIES) {
    fail(400, 'invalid_request', `Selecione entre 1 e ${MAX_PRIORITIES} prioridades.`);
  }
  const acceptedPriorities = body.acceptedPriorities.map((priority, index) => {
    if (!priority || typeof priority !== 'object' || Array.isArray(priority)) {
      fail(400, 'invalid_request', `A prioridade ${index + 1} é inválida.`);
    }
    const suggestedQuestionCount = positiveInteger(
      priority.suggestedQuestionCount,
      `A quantidade de questões da prioridade ${index + 1}`
    );
    if (suggestedQuestionCount > 10) {
      fail(400, 'invalid_request', 'Cada prioridade pode sugerir no máximo 10 questões.');
    }
    return {
      skillId: positiveInteger(priority.skillId, `A habilidade da prioridade ${index + 1}`),
      suggestedQuestionCount,
      rationale: trimmedString(priority.rationale, {
        field: `a justificativa da prioridade ${index + 1}`,
        maxLength: 1000,
      }),
      group: normalizeGroup(priority.group, index),
    };
  });
  if (new Set(acceptedPriorities.map(({ skillId }) => skillId)).size !== acceptedPriorities.length) {
    fail(400, 'invalid_request', 'A mesma habilidade não pode ser selecionada duas vezes.');
  }
  return {
    expectedAssessmentRevision,
    expectedResultRevision: sha256Revision(body.expectedResultRevision),
    methodologyVersion: METHODOLOGY_VERSION,
    title,
    acceptedPriorities,
  };
}

function sha256(value) {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

function requestFingerprint({ teacherId, classPublicId, assessmentPublicId, confirmation }) {
  return sha256(JSON.stringify({
    teacherId,
    classPublicId,
    assessmentPublicId,
    ...confirmation,
  }));
}

function ownedClosedDiagnostic(database, { teacherId, classPublicId, assessmentPublicId }) {
  const assignment=database.prepare(`
    SELECT
      assignment.*,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      diagnostic.algorithm_version AS diagnostic_algorithm_version,
      review.confirmation_version AS diagnostic_confirmation_version,
      review.reviewed_at AS diagnostic_reviewed_at
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class
      ON school_class.id = assignment.class_id
      AND school_class.owner_teacher_id = assignment.owner_teacher_id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    LEFT JOIN diagnostic_question_set_reviews review
      ON review.question_set_id = diagnostic.question_set_id
      AND review.owner_teacher_id = diagnostic.owner_teacher_id
    WHERE school_class.public_id = ?
      AND assignment.public_id = ?
      AND assignment.owner_teacher_id = ?
  `).get(classPublicId, assessmentPublicId, teacherId);
  if(assignment && !assignment.diagnostic_reviewed_at) {
    const numeric=require('./numericAssessments').numericDiagnostic(database,assignment);
    if(numeric)Object.assign(assignment,{diagnostic_algorithm_version:numeric.algorithm_version,
      diagnostic_confirmation_version:numeric.confirmation_version,diagnostic_reviewed_at:numeric.reviewed_at});
  }
  return assignment;
}

const { scoredResponses } = require('./numericAssessments');
function studentSkillPerformance(database, assignment, skillCode) {
  return database.prepare(`
    SELECT
      student.id,
      student.public_id,
      student.display_name,
      COUNT(response.id) AS opportunity_count,
      SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM class_assessment_participants participant
    JOIN students student
      ON student.id = participant.student_id
      AND student.owner_teacher_id = participant.owner_teacher_id
    JOIN class_assessment_attempts attempt
      ON attempt.participant_id = participant.id
      AND attempt.assignment_id = participant.assignment_id
      AND attempt.status = 'submitted'
    JOIN ${scoredResponses(database)} response ON response.attempt_id = attempt.id
    JOIN class_assessment_items item
      ON item.id = response.assessment_item_id
      AND item.assignment_id = participant.assignment_id
    WHERE participant.assignment_id = ?
      AND participant.owner_teacher_id = ?
      AND item.skill_code_snapshot = ?
    GROUP BY participant.id, student.id
  `).all(assignment.id, assignment.owner_teacher_id, skillCode).map((student) => ({
    internalId: student.id,
    id: student.public_id,
    displayName: student.display_name,
    successRate: Number(((Number(student.correct_count) * 100)
      / Number(student.opportunity_count)).toFixed(2)),
    opportunityCount: Number(student.opportunity_count),
  }));
}

function resolveAcceptedPriorities(database, assignment, confirmation, preview) {
  const priorityBySkillId = new Map(
    preview.priorities.map((priority) => [priority.skill.id, priority])
  );
  return confirmation.acceptedPriorities.map((selection, index) => {
    const priority = priorityBySkillId.get(selection.skillId);
    if (!priority) {
      fail(
        409,
        'priority_not_actionable',
        'Uma habilidade selecionada não faz mais parte das prioridades atuais.'
      );
    }
    let group = null;
    if (selection.group) {
      const performanceByPublicId = new Map(
        studentSkillPerformance(database, assignment, priority.skill.code)
          .map((student) => [student.id.toLocaleLowerCase('pt-BR'), student])
      );
      const students = selection.group.studentIds.map((studentPublicId) => {
        const student = performanceByPublicId.get(studentPublicId.toLocaleLowerCase('pt-BR'));
        if (!student) {
          fail(
            409,
            'invalid_group_member',
            'Um estudante selecionado não possui resultado válido nessa habilidade.'
          );
        }
        return student;
      });
      group = {
        title: selection.group.title || `Reforço · ${priority.skill.code}`,
        objective: selection.group.objective
          || `Retomar ${priority.skill.description}`.slice(0, 1000),
        students,
      };
    }
    return { selection, priority, group, order: index + 1 };
  });
}

function serializePlan(database, planId) {
  const plan = database.prepare(`
    SELECT
      plan.id,
      plan.public_id,
      plan.title,
      plan.status,
      plan.methodology_version,
      plan.revision,
      plan.source_assessment_revision,
      plan.source_results_revision_hash,
      plan.diagnostic_algorithm_version_snapshot,
      plan.diagnostic_confirmation_version_snapshot,
      plan.created_at,
      plan.updated_at,
      plan.activated_at,
      plan.completed_at,
      plan.archived_at,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      school_class.academic_year,
      grade.name AS grade_name,
      assignment.public_id AS assessment_public_id,
      assignment.title_snapshot AS assessment_title
    FROM learning_recovery_plans plan
    JOIN school_classes school_class ON school_class.id = plan.class_id
    JOIN grades grade ON grade.id = school_class.grade_id
    JOIN class_assessment_assignments assignment ON assignment.id = plan.source_assignment_id
    WHERE plan.id = ?
  `).get(planId);
  if (!plan) return null;

  const skills = database.prepare(`
    SELECT
      id, source_skill_id, skill_code_snapshot, skill_description_snapshot,
      success_rate_snapshot, opportunity_count, diagnostic_level, priority,
      suggested_question_count, rationale
    FROM learning_recovery_plan_skills
    WHERE plan_id = ?
    ORDER BY priority, id
  `).all(planId).map((skill) => ({
    skillId: skill.source_skill_id,
    code: skill.skill_code_snapshot,
    description: skill.skill_description_snapshot,
    successRateSnapshot: skill.success_rate_snapshot,
    opportunityCount: skill.opportunity_count,
    diagnosticLevel: skill.diagnostic_level,
    priority: skill.priority,
    suggestedQuestionCount: skill.suggested_question_count,
    rationale: skill.rationale,
  }));
  const groups = database.prepare(`
    SELECT
      id, public_id, focus_skill_id, focus_skill_code_snapshot,
      title, objective, sort_order
    FROM learning_recovery_student_groups
    WHERE plan_id = ?
    ORDER BY sort_order, id
  `).all(planId).map((group) => ({
    internalId: group.id,
    id: group.public_id,
    focusSkillId: group.focus_skill_id,
    focusSkillCode: group.focus_skill_code_snapshot,
    title: group.title,
    objective: group.objective,
    sortOrder: group.sort_order,
    students: [],
  }));
  const groupById = new Map(groups.map((group) => [group.internalId, group]));
  if (groups.length) {
    const members = database.prepare(`
      SELECT
        member.group_id,
        student.public_id,
        student.display_name,
        member.success_rate_snapshot,
        member.opportunity_count
      FROM learning_recovery_student_group_members member
      JOIN students student ON student.id = member.student_id
      WHERE member.plan_id = ?
      ORDER BY student.display_name COLLATE NOCASE, student.public_id
    `).all(planId);
    members.forEach((member) => {
      groupById.get(member.group_id)?.students.push({
        id: member.public_id,
        displayName: member.display_name,
        successRateSnapshot: member.success_rate_snapshot,
        opportunityCount: member.opportunity_count,
      });
    });
  }

  return {
    id: plan.public_id,
    title: plan.title,
    status: plan.status,
    methodologyVersion: plan.methodology_version,
    revision: plan.revision,
    sourceAssessmentRevision: plan.source_assessment_revision,
    sourceResultRevision: plan.source_results_revision_hash,
    diagnosticSnapshot: {
      algorithmVersion: plan.diagnostic_algorithm_version_snapshot,
      confirmationVersion: plan.diagnostic_confirmation_version_snapshot,
    },
    classId: plan.class_public_id,
    class: {
      id: plan.class_public_id,
      name: plan.class_name,
      gradeName: plan.grade_name,
      academicYear: Number(plan.academic_year),
    },
    sourceAssessmentId: plan.assessment_public_id,
    sourceAssessment: {
      id: plan.assessment_public_id,
      title: plan.assessment_title,
    },
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    activatedAt: plan.activated_at,
    completedAt: plan.completed_at,
    archivedAt: plan.archived_at,
    skills,
    groups: groups.map(({ internalId: _internalId, ...group }) => group),
  };
}

function confirmLearningRecoveryPlan(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  idempotencyKey,
  body,
  request,
}) {
  const normalizedKey = normalizeIdempotencyKey(idempotencyKey);
  const confirmation = normalizeConfirmation(body);
  const keyHash = sha256(`${teacher.id}:${normalizedKey}`);
  const fingerprint = requestFingerprint({
    teacherId: teacher.id,
    classPublicId,
    assessmentPublicId,
    confirmation,
  });

  const persist = database.transaction(() => {
    const replay = database.prepare(`
      SELECT id, request_fingerprint
      FROM learning_recovery_plans
      WHERE owner_teacher_id = ? AND idempotency_key_hash = ?
    `).get(teacher.id, keyHash);
    if (replay) {
      if (replay.request_fingerprint !== fingerprint) {
        fail(
          409,
          'idempotency_conflict',
          'Esta chave de idempotência já foi usada com uma confirmação diferente.'
        );
      }
      return { created: false, replayed: true, plan: serializePlan(database, replay.id) };
    }

    const assignment = ownedClosedDiagnostic(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
    });
    if (!assignment) fail(404, 'assessment_not_found', 'Aplicação não encontrada.');
    if (assignment.status !== 'closed') {
      fail(409, 'assessment_not_closed', 'Encerre a aplicação antes de confirmar a recomposição.');
    }
    if (!assignment.diagnostic_reviewed_at) {
      fail(409, 'diagnostic_not_reviewed', 'A recomposição exige uma avaliação diagnóstica conferida.');
    }
    if (assignment.revision !== confirmation.expectedAssessmentRevision) {
      fail(
        409,
        'stale_preview',
        'Os dados da aplicação mudaram. Gere uma nova prévia antes de confirmar.'
      );
    }
    const submittedCount = database.prepare(`
      SELECT COUNT(*)
      FROM class_assessment_attempts
      WHERE assignment_id = ? AND status = 'submitted'
    `).pluck().get(assignment.id);
    if (!submittedCount) {
      fail(409, 'results_required', 'Ainda não há resultados enviados para orientar a recomposição.');
    }
    const existingPlan = database.prepare(`
      SELECT public_id
      FROM learning_recovery_plans
      WHERE source_assignment_id = ?
    `).get(assignment.id);
    if (existingPlan) {
      fail(
        409,
        'recovery_plan_exists',
        'Esta aplicação já possui um plano de recomposição.',
        { planId: existingPlan.public_id }
      );
    }

    const preview = buildLearningRecoveryPreview(database, assignment, teacher.id);
    if (!preview.isActionable || preview.methodology.version !== confirmation.methodologyVersion) {
      fail(409, 'preview_not_actionable', 'A prévia atual não pode mais ser confirmada. Gere-a novamente.');
    }
    if (preview.source.resultRevision !== confirmation.expectedResultRevision) {
      fail(
        409,
        'stale_results',
        'Os resultados mudaram depois da prévia. Revise as recomendações antes de confirmar.'
      );
    }
    const accepted = resolveAcceptedPriorities(
      database,
      assignment,
      confirmation,
      preview
    );

    const planResult = database.prepare(`
      INSERT INTO learning_recovery_plans (
        public_id, owner_teacher_id, class_id, source_assignment_id,
        title, idempotency_key_hash, request_fingerprint,
        source_assessment_revision, source_results_revision_hash,
        diagnostic_algorithm_version_snapshot,
        diagnostic_confirmation_version_snapshot,
        methodology_version, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      teacher.id,
      assignment.class_id,
      assignment.id,
      confirmation.title,
      keyHash,
      fingerprint,
      assignment.revision,
      confirmation.expectedResultRevision,
      assignment.diagnostic_algorithm_version,
      assignment.diagnostic_confirmation_version,
      confirmation.methodologyVersion,
      teacher.id,
      teacher.id
    );
    const planId = Number(planResult.lastInsertRowid);
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
        planId,
        teacher.id,
        assignment.class_id,
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
        planId,
        teacher.id,
        assignment.class_id,
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
          planId,
          student.internalId,
          teacher.id,
          assignment.class_id,
          student.successRate,
          student.opportunityCount
        );
        groupMemberCount += 1;
      });
    });

    logActivityStrict({
      user: teacher,
      action: 'create_learning_recovery_plan',
      module: 'classes',
      entityType: 'learning_recovery_plan',
      entityId: planId,
      entityTitle: confirmation.title,
      description: `${teacher.name || teacher.email || 'Professor'} confirmou um plano de recomposição a partir de um diagnóstico encerrado.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        methodology_version: confirmation.methodologyVersion,
        assessment_revision: assignment.revision,
        priority_count: accepted.length,
        group_count: groupCount,
        group_member_count: groupMemberCount,
      },
      req: request,
    }, database);

    return { created: true, replayed: false, plan: serializePlan(database, planId) };
  });

  return persist.immediate();
}

module.exports = {
  LearningRecoveryConfirmationError,
  METHODOLOGY_VERSION,
  normalizeConfirmation,
  normalizeIdempotencyKey,
  confirmLearningRecoveryPlan,
  resolveAcceptedPriorities,
  serializePlan,
};
