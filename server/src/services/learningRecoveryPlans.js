const VALID_RECOVERY_PLAN_STATUSES = new Set([
  'draft',
  'active',
  'completed',
  'archived',
]);

function recoveryPlanCounts(database, teacherId) {
  const row = database.prepare(`
    SELECT
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'draft' THEN 1 ELSE 0 END) AS draft,
      SUM(CASE WHEN status = 'active' THEN 1 ELSE 0 END) AS active,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed,
      SUM(CASE WHEN status = 'archived' THEN 1 ELSE 0 END) AS archived
    FROM learning_recovery_plans
    WHERE owner_teacher_id = ?
  `).get(teacherId);

  return {
    total: Number(row?.total) || 0,
    draft: Number(row?.draft) || 0,
    active: Number(row?.active) || 0,
    completed: Number(row?.completed) || 0,
    archived: Number(row?.archived) || 0,
  };
}

function listLearningRecoveryPlans(database, {
  teacherId,
  status = null,
  search = null,
  limit = 50,
} = {}) {
  const params = [teacherId];
  let filters = '';

  if (status) {
    filters += ' AND plan.status = ?';
    params.push(status);
  }
  if (search) {
    filters += ` AND (
      instr(lower(plan.title), lower(?)) > 0
      OR instr(lower(school_class.name), lower(?)) > 0
      OR instr(lower(assignment.title_snapshot), lower(?)) > 0
    )`;
    params.push(search, search, search);
  }
  params.push(limit);

  return database.prepare(`
    SELECT
      plan.public_id,
      plan.title,
      plan.status,
      plan.revision,
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
      assignment.title_snapshot AS assessment_title,
      assignment.status AS assessment_status,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic,
      (
        SELECT COUNT(*)
        FROM learning_recovery_plan_skills skill
        WHERE skill.plan_id = plan.id
      ) AS priority_count,
      (
        SELECT COALESCE(SUM(skill.suggested_question_count), 0)
        FROM learning_recovery_plan_skills skill
        WHERE skill.plan_id = plan.id
      ) AS planned_question_count,
      (
        SELECT COUNT(*)
        FROM learning_recovery_student_groups student_group
        WHERE student_group.plan_id = plan.id
      ) AS group_count,
      (
        SELECT COUNT(DISTINCT member.student_id)
        FROM learning_recovery_student_group_members member
        WHERE member.plan_id = plan.id
      ) AS student_count,
      (
        SELECT execution.status
        FROM teaching_plans execution
        WHERE execution.source_recovery_plan_id = plan.id
          AND execution.owner_teacher_id = plan.owner_teacher_id
      ) AS execution_status,
      (
        SELECT COUNT(*)
        FROM teaching_plans execution
        JOIN teaching_plan_lessons lesson ON lesson.plan_id = execution.id
        WHERE execution.source_recovery_plan_id = plan.id
          AND execution.owner_teacher_id = plan.owner_teacher_id
      ) AS execution_total,
      (
        SELECT COUNT(*)
        FROM teaching_plans execution
        JOIN teaching_plan_lessons lesson ON lesson.plan_id = execution.id
        WHERE execution.source_recovery_plan_id = plan.id
          AND execution.owner_teacher_id = plan.owner_teacher_id
          AND lesson.status <> 'planned'
      ) AS execution_handled
    FROM learning_recovery_plans plan
    JOIN school_classes school_class
      ON school_class.id = plan.class_id
      AND school_class.owner_teacher_id = plan.owner_teacher_id
    JOIN grades grade ON grade.id = school_class.grade_id
    JOIN class_assessment_assignments assignment
      ON assignment.id = plan.source_assignment_id
      AND assignment.class_id = plan.class_id
      AND assignment.owner_teacher_id = plan.owner_teacher_id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    WHERE plan.owner_teacher_id = ?${filters}
    ORDER BY
      CASE plan.status
        WHEN 'draft' THEN 1
        WHEN 'active' THEN 2
        WHEN 'completed' THEN 3
        ELSE 4
      END,
      plan.updated_at DESC,
      plan.id DESC
    LIMIT ?
  `).all(...params).map((row) => ({
    id: row.public_id,
    title: row.title,
    status: row.status,
    revision: Number(row.revision),
    class: {
      id: row.class_public_id,
      name: row.class_name,
      gradeName: row.grade_name,
      academicYear: Number(row.academic_year),
    },
    sourceAssessment: {
      id: row.assessment_public_id,
      title: row.assessment_title,
      status: row.assessment_status,
      isDiagnostic: row.is_diagnostic === 1,
    },
    priorityCount: Number(row.priority_count) || 0,
    plannedQuestionCount: Number(row.planned_question_count) || 0,
    groupCount: Number(row.group_count) || 0,
    studentCount: Number(row.student_count) || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activatedAt: row.activated_at,
    completedAt: row.completed_at,
    archivedAt: row.archived_at,
    execution: row.execution_status ? {
      status: row.execution_status,
      total: Number(row.execution_total) || 0,
      handled: Number(row.execution_handled) || 0,
      percentage: Number(row.execution_total)
        ? Math.round((Number(row.execution_handled) / Number(row.execution_total)) * 100)
        : 0,
    } : null,
  }));
}

module.exports = {
  VALID_RECOVERY_PLAN_STATUSES,
  listLearningRecoveryPlans,
  recoveryPlanCounts,
};
