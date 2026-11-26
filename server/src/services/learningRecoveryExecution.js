const { v4: uuidv4 } = require('uuid');
const { eligibleMaterialSkill } = require('./materialSkillEligibility');
const { logActivityStrict } = require('../helpers/activity');
const { LearningRecoveryConfirmationError } = require('./learningRecoveryConfirmation');
const { buildLearningRecoveryPreview } = require('./learningRecoveryPreview');
const { serializeLearningRecoveryMonitoring } = require('./learningRecoveryMonitoring');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('./questionEditorialCuration');

const EXECUTION_LESSON_STATUSES = new Set(['planned', 'taught', 'skipped']);

function fail(status, code, message, details) {
  throw new LearningRecoveryConfirmationError(status, code, message, details);
}

function positiveInteger(value, field, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < min || number > max) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  return number;
}

function normalizeDate(value, field) {
  const text = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    fail(400, 'invalid_request', `${field} é inválida.`);
  }
  const parsed = new Date(`${text}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== text) {
    fail(400, 'invalid_request', `${field} é inválida.`);
  }
  return text;
}

function addDays(date, days) {
  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

function normalizeNotes(value) {
  const text = String(value ?? '').replace(/\r\n/g, '\n').trim();
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(text) || text.length > 5000) {
    fail(400, 'invalid_request', 'As observações são inválidas.');
  }
  return text || null;
}

function ownedRecoveryContext(database, {
  teacherId,
  classPublicId,
  assessmentPublicId,
  planPublicId,
}) {
  return database.prepare(`
    SELECT
      recovery.id,
      recovery.public_id,
      recovery.title,
      recovery.status,
      recovery.revision,
      recovery.owner_teacher_id,
      recovery.class_id,
      recovery.source_assignment_id,
      school_class.grade_id,
      school_class.academic_year,
      (
        SELECT MIN(class_discipline.discipline_id)
        FROM school_class_disciplines class_discipline
        WHERE class_discipline.class_id = recovery.class_id
          AND class_discipline.owner_teacher_id = recovery.owner_teacher_id
      ) AS discipline_id
    FROM learning_recovery_plans recovery
    JOIN school_classes school_class
      ON school_class.id = recovery.class_id
      AND school_class.owner_teacher_id = recovery.owner_teacher_id
    JOIN class_assessment_assignments assignment
      ON assignment.id = recovery.source_assignment_id
      AND assignment.class_id = recovery.class_id
      AND assignment.owner_teacher_id = recovery.owner_teacher_id
    WHERE recovery.public_id = ?
      AND school_class.public_id = ?
      AND assignment.public_id = ?
      AND recovery.owner_teacher_id = ?
  `).get(planPublicId, classPublicId, assessmentPublicId, teacherId);
}

function requireOwnedRecovery(database, context) {
  const recovery = ownedRecoveryContext(database, context);
  if (!recovery) fail(404, 'recovery_plan_not_found', 'Plano de recomposição não encontrado.');
  return recovery;
}

function serializeLearningRecoveryExecution(database, recoveryPlanId, teacherId) {
  const execution = database.prepare(`
    SELECT
      plan.id,
      plan.public_id,
      plan.title,
      plan.status,
      plan.revision,
      plan.period_type,
      plan.starts_on,
      plan.ends_on,
      plan.activated_at,
      plan.completed_at,
      plan.created_at,
      plan.updated_at
    FROM teaching_plans plan
    WHERE plan.source_recovery_plan_id = ?
      AND plan.owner_teacher_id = ?
  `).get(recoveryPlanId, teacherId);
  if (!execution) return null;

  const lessons = database.prepare(`
    SELECT
      lesson.id,
      lesson.public_id,
      lesson.title,
      lesson.objective,
      lesson.teacher_notes,
      lesson.sequence_order,
      lesson.planned_date,
      lesson.duration_minutes,
      lesson.status,
      lesson.lesson_phase,
      lesson.revision,
      lesson.created_at,
      lesson.updated_at
    FROM teaching_plan_lessons lesson
    WHERE lesson.plan_id = ? AND lesson.owner_teacher_id = ?
    ORDER BY lesson.sequence_order, lesson.id
  `).all(execution.id, teacherId).map((lesson) => ({
    internalId: lesson.id,
    id: lesson.public_id,
    title: lesson.title,
    objective: lesson.objective,
    teacherNotes: lesson.teacher_notes,
    sequence: Number(lesson.sequence_order),
    plannedDate: lesson.planned_date,
    durationMinutes: lesson.duration_minutes === null ? null : Number(lesson.duration_minutes),
    status: lesson.status,
    phase: lesson.lesson_phase,
    revision: Number(lesson.revision),
    createdAt: lesson.created_at,
    updatedAt: lesson.updated_at,
    skills: [],
    resources: [],
  }));
  const lessonById = new Map(lessons.map((lesson) => [lesson.internalId, lesson]));

  if (lessons.length) {
    database.prepare(`
      SELECT lesson_id, source_skill_id, skill_code_snapshot, skill_description_snapshot
      FROM teaching_plan_lesson_skills
      WHERE plan_id = ? AND owner_teacher_id = ?
      ORDER BY lesson_id, skill_code_snapshot
    `).all(execution.id, teacherId).forEach((skill) => {
      lessonById.get(skill.lesson_id)?.skills.push({
        skillId: skill.source_skill_id,
        code: skill.skill_code_snapshot,
        description: skill.skill_description_snapshot,
      });
    });
    database.prepare(`
      SELECT
        id, lesson_id, resource_type, material_id, question_id, question_set_id,
        title_snapshot, teacher_notes, sort_order
      FROM teaching_plan_lesson_resources
      WHERE plan_id = ? AND owner_teacher_id = ?
      ORDER BY lesson_id, sort_order, id
    `).all(execution.id, teacherId).forEach((resource) => {
      lessonById.get(resource.lesson_id)?.resources.push({
        id: Number(resource.id),
        type: resource.resource_type,
        materialId: resource.material_id,
        questionId: resource.question_id,
        questionSetId: resource.question_set_id,
        title: resource.title_snapshot,
        teacherNotes: resource.teacher_notes,
        sortOrder: Number(resource.sort_order),
      });
    });
  }

  const totals = lessons.reduce((summary, lesson) => {
    summary[lesson.status] += 1;
    return summary;
  }, { planned: 0, taught: 0, skipped: 0 });
  const handled = totals.taught + totals.skipped;
  const total = lessons.length;

  return {
    id: execution.public_id,
    title: execution.title,
    status: execution.status,
    revision: Number(execution.revision),
    periodType: execution.period_type,
    startsOn: execution.starts_on,
    endsOn: execution.ends_on,
    activatedAt: execution.activated_at,
    completedAt: execution.completed_at,
    createdAt: execution.created_at,
    updatedAt: execution.updated_at,
    progress: {
      total,
      planned: totals.planned,
      taught: totals.taught,
      skipped: totals.skipped,
      handled,
      percentage: total ? Math.round((handled / total) * 100) : 0,
    },
    lessons: lessons.map(({ internalId: _internalId, ...lesson }) => lesson),
    monitoring: serializeLearningRecoveryMonitoring(database, {
      recoveryPlanId,
      teacherId,
    }),
  };
}

function createLearningRecoveryExecution(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  body,
  request,
}) {
  const startDate = normalizeDate(body?.startDate, 'A data inicial');
  const cadenceDays = positiveInteger(body?.cadenceDays ?? 2, 'O intervalo entre etapas', {
    min: 1,
    max: 14,
  });

  const persist = database.transaction(() => {
    const recovery = requireOwnedRecovery(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    const replay = serializeLearningRecoveryExecution(database, recovery.id, teacher.id);
    if (replay) return { created: false, replayed: true, execution: replay };
    if (recovery.status !== 'active') {
      fail(409, 'recovery_plan_not_active', 'Conclua a revisão do plano antes de organizar a execução.');
    }

    const skills = database.prepare(`
      SELECT
        source_skill_id, skill_code_snapshot, skill_description_snapshot,
        suggested_question_count, rationale, priority
      FROM learning_recovery_plan_skills
      WHERE plan_id = ? AND owner_teacher_id = ?
      ORDER BY priority, id
    `).all(recovery.id, teacher.id);
    if (!skills.length) {
      fail(409, 'recovery_plan_without_priorities', 'O plano não possui prioridades para executar.');
    }
    if (skills.some((skill) => !skill.source_skill_id)) {
      fail(
        409,
        'recovery_skill_unavailable',
        'Uma habilidade deste plano não está mais disponível no catálogo BNCC. Revise o cadastro antes de organizar a execução.'
      );
    }
    const sourceAssignment = database.prepare(`
      SELECT assignment.*, school_class.name AS class_name
      FROM class_assessment_assignments assignment
      JOIN school_classes school_class ON school_class.id = assignment.class_id
      WHERE assignment.id = ?
        AND assignment.class_id = ?
        AND assignment.owner_teacher_id = ?
    `).get(recovery.source_assignment_id, recovery.class_id, teacher.id);
    const preview = sourceAssignment
      ? buildLearningRecoveryPreview(database, sourceAssignment, teacher.id)
      : null;
    const previewBySkill = new Map(
      (preview?.priorities || []).map((priority) => [priority.skill.code, priority])
    );

    const monitoringDate = addDays(startDate, skills.length * cadenceDays);
    const executionId = Number(database.prepare(`
      INSERT INTO teaching_plans (
        public_id, owner_teacher_id, class_id, grade_id, discipline_id,
        source_recovery_plan_id, title, period_type, academic_year,
        starts_on, ends_on, status, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'custom', ?, ?, ?, 'draft', ?, ?)
    `).run(
      uuidv4(),
      teacher.id,
      recovery.class_id,
      recovery.grade_id,
      recovery.discipline_id,
      recovery.id,
      `Execução · ${recovery.title}`.slice(0, 160),
      recovery.academic_year,
      startDate,
      monitoringDate,
      teacher.id,
      teacher.id
    ).lastInsertRowid);

    const insertLesson = database.prepare(`
      INSERT INTO teaching_plan_lessons (
        public_id, plan_id, owner_teacher_id, title, objective, teacher_notes,
        sequence_order, planned_date, duration_minutes, status, lesson_phase
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'planned', ?)
    `);
    const insertLessonSkill = database.prepare(`
      INSERT INTO teaching_plan_lesson_skills (
        lesson_id, plan_id, owner_teacher_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);
    const insertResource = database.prepare(`
      INSERT INTO teaching_plan_lesson_resources (
        lesson_id, plan_id, owner_teacher_id, resource_type,
        material_id, question_id, question_set_id,
        title_snapshot, teacher_notes, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const curatedMaterials = database.prepare(`
      SELECT material.id, material.title
      FROM material_bncc_skills mapping
      JOIN materials material ON material.id = mapping.material_id
    WHERE mapping.skill_id = ? AND ${eligibleMaterialSkill()}
      ORDER BY material.title COLLATE NOCASE, material.id
      LIMIT 3
    `);

    skills.forEach((skill, index) => {
      const lessonId = Number(insertLesson.run(
        uuidv4(),
        executionId,
        teacher.id,
        `Retomar ${skill.skill_code_snapshot}`.slice(0, 160),
        skill.skill_description_snapshot.slice(0, 2000),
        skill.rationale || null,
        index + 1,
        addDays(startDate, index * cadenceDays),
        50,
        'intervention'
      ).lastInsertRowid);
      insertLessonSkill.run(
        lessonId,
        executionId,
        teacher.id,
        skill.source_skill_id,
        skill.skill_code_snapshot,
        skill.skill_description_snapshot
      );
      insertResource.run(
        lessonId,
        executionId,
        teacher.id,
        'activity',
        null,
        null,
        null,
        `Selecionar ${skill.suggested_question_count} ${skill.suggested_question_count === 1 ? 'questão' : 'questões'} de reforço`,
        'Escolha questões adequadas à turma antes da intervenção.',
        1
      );
      const recommended = previewBySkill.get(skill.skill_code_snapshot);
      (recommended?.reinforcementQuestions || [])
        .slice(0, skill.suggested_question_count)
        .forEach((question, questionIndex) => {
          insertResource.run(
            lessonId,
            executionId,
            teacher.id,
            'question',
            null,
            question.id,
            null,
            `${question.code} · ${question.statement}`.slice(0, 240),
            question.requiresTeacherReview
              ? 'Questão autoral: confira o conteúdo antes de usar.'
              : 'Questão sugerida para a prática orientada.',
            questionIndex + 10
          );
        });
      curatedMaterials.all(skill.source_skill_id).forEach((material, materialIndex) => {
        insertResource.run(
          lessonId,
          executionId,
          teacher.id,
          'material',
          material.id,
          null,
          null,
          material.title.slice(0, 240),
          'Material associado à habilidade no acervo; confira a adequação à turma.',
          materialIndex + 30
        );
      });
    });

    const monitoringLessonId = Number(insertLesson.run(
      uuidv4(),
      executionId,
      teacher.id,
      'Verificar a evolução',
      'Aplicar uma nova avaliação curta para verificar a evolução nas habilidades trabalhadas.',
      null,
      skills.length + 1,
      monitoringDate,
      50,
      'monitoring'
    ).lastInsertRowid);
    skills.forEach((skill) => insertLessonSkill.run(
      monitoringLessonId,
      executionId,
      teacher.id,
      skill.source_skill_id,
      skill.skill_code_snapshot,
      skill.skill_description_snapshot
    ));
    insertResource.run(
      monitoringLessonId,
      executionId,
      teacher.id,
      'activity',
      null,
      null,
      null,
      'Preparar avaliação de monitoramento',
      'Monte uma avaliação curta com questões diferentes das usadas no diagnóstico.',
      1
    );

    database.prepare(`
      UPDATE teaching_plans
      SET status = 'active', activated_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'draft'
    `).run(teacher.id, executionId);
    database.prepare(`
      UPDATE learning_recovery_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, recovery.id);

    logActivityStrict({
      user: teacher,
      action: 'start_learning_recovery_execution',
      module: 'classes',
      entityType: 'learning_recovery_plan',
      entityId: recovery.id,
      entityTitle: recovery.title,
      description: `${teacher.name || teacher.email || 'Professor'} organizou o cronograma de execução do plano de recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        start_date: startDate,
        cadence_days: cadenceDays,
        lesson_count: skills.length + 1,
      },
      req: request,
    }, database);

    return {
      created: true,
      replayed: false,
      execution: serializeLearningRecoveryExecution(database, recovery.id, teacher.id),
    };
  });
  return persist.immediate();
}

function normalizeResourceIds(value, field, max) {
  if (!Array.isArray(value) || value.length > max) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  const ids = value.map((item) => positiveInteger(item, field));
  if (new Set(ids).size !== ids.length) {
    fail(400, 'invalid_request', `${field} contém itens repetidos.`);
  }
  return ids;
}

function learningRecoveryExecutionResourceOptions(database, {
  teacherId,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  lessonPublicId,
}) {
  const recovery = requireOwnedRecovery(database, {
    teacherId,
    classPublicId,
    assessmentPublicId,
    planPublicId,
  });
  const lesson = database.prepare(`
    SELECT lesson.id, lesson.public_id, lesson.status, lesson.lesson_phase,
      execution.id AS execution_id, execution.status AS execution_status,
      execution.revision AS execution_revision
    FROM teaching_plans execution
    JOIN teaching_plan_lessons lesson
      ON lesson.plan_id = execution.id
      AND lesson.owner_teacher_id = execution.owner_teacher_id
    WHERE execution.source_recovery_plan_id = ?
      AND execution.owner_teacher_id = ?
      AND lesson.public_id = ?
  `).get(recovery.id, teacherId, lessonPublicId);
  if (!lesson) fail(404, 'recovery_execution_lesson_not_found', 'Etapa de execução não encontrada.');
  if (lesson.lesson_phase !== 'intervention') {
    fail(409, 'recovery_resource_selection_unavailable', 'Os recursos de reforço pertencem às etapas de intervenção.');
  }

  const skills = database.prepare(`
    SELECT source_skill_id, skill_code_snapshot
    FROM teaching_plan_lesson_skills
    WHERE lesson_id = ? AND plan_id = ? AND owner_teacher_id = ?
  `).all(lesson.id, lesson.execution_id, teacherId);
  const skillIds = skills.map(({ source_skill_id: id }) => id).filter(Boolean);
  if (!skillIds.length) {
    fail(409, 'recovery_skill_unavailable', 'A habilidade desta etapa não está mais disponível.');
  }
  const placeholders = skillIds.map(() => '?').join(', ');
  const pilotEnabled = isEditorialPilotEnabled(database, { id: teacherId, role: 'professor' });
  const questions = database.prepare(`
    SELECT question.id, question.question_code, substr(question.statement, 1, 240) AS statement,
      question.difficulty, question.source, question.reviewed, question.image_path,
      CASE WHEN selected.id IS NULL THEN 0 ELSE 1 END AS selected
    FROM questions question
    LEFT JOIN question_editorial_curation editorial ON editorial.question_id = question.id
    LEFT JOIN teaching_plan_lesson_resources selected
      ON selected.lesson_id = ?
      AND selected.question_id = question.id
      AND selected.resource_type = 'question'
    WHERE question.skill_id IN (${placeholders})
      AND question.status = 'active'
      AND (selected.id IS NOT NULL OR ${editorialEligibleSql('question', { pilotEnabled, purpose: 'practice' })})
      AND question.question_type = 'multiple_choice'
      AND (question.source = 'official' OR (question.source = 'teacher' AND question.created_by = ?))
      AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id) = 4
      AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id AND option.is_correct = 1) = 1
      AND NOT EXISTS (
        SELECT 1 FROM class_assessment_items source_item
        WHERE source_item.assignment_id = ?
          AND (source_item.source_question_id = question.id OR source_item.question_code_snapshot = question.question_code)
      )
    ORDER BY selected DESC, CASE WHEN editorial.state = 'pilot' THEN 0 ELSE 1 END, question.reviewed DESC,
      CASE question.source WHEN 'official' THEN 0 ELSE 1 END,
      question.question_code COLLATE NOCASE, question.id
    LIMIT 40
  `).all(lesson.id, ...skillIds, teacherId, recovery.source_assignment_id).map((question) => ({
    id: question.id,
    code: question.question_code,
    statement: question.statement,
    difficulty: question.difficulty,
    source: question.source,
    reviewed: question.reviewed === 1,
    hasImage: Boolean(question.image_path),
    selected: question.selected === 1,
  }));
  const materials = database.prepare(`
    SELECT material.id, material.title,
      substr(COALESCE(material.description, ''), 1, 240) AS description,
      material.file_format,
      CASE WHEN selected.id IS NULL THEN 0 ELSE 1 END AS selected,
      NOT EXISTS (SELECT 1 FROM material_bncc_skills mapping
        WHERE mapping.material_id=material.id AND mapping.skill_id IN (${placeholders})
          AND ${eligibleMaterialSkill()}) AS needs_review
    FROM materials material
    LEFT JOIN teaching_plan_lesson_resources selected
      ON selected.lesson_id = ?
      AND selected.material_id = material.id
      AND selected.resource_type = 'material'
    WHERE selected.id IS NOT NULL OR EXISTS (SELECT 1 FROM material_bncc_skills mapping
      WHERE mapping.material_id=material.id AND mapping.skill_id IN (${placeholders})
        AND ${eligibleMaterialSkill()})
    GROUP BY material.id
    ORDER BY selected DESC, material.title COLLATE NOCASE, material.id
    LIMIT 20
  `).all(...skillIds, lesson.id, ...skillIds).map((material) => ({
    id: material.id,
    title: material.title,
    description: material.description || null,
    format: material.file_format,
    selected: material.selected === 1,
    needsReview: material.needs_review === 1,
  }));

  return {
    lesson: { id: lesson.public_id, status: lesson.status, phase: lesson.lesson_phase },
    executionRevision: Number(lesson.execution_revision),
    editable: recovery.status === 'active'
      && lesson.execution_status === 'active'
      && lesson.status === 'planned',
    limits: { maxQuestions: 10, maxMaterials: 5 },
    questions,
    materials,
  };
}

function updateLearningRecoveryExecutionResources(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  lessonPublicId,
  body,
  request,
}) {
  const expectedExecutionRevision = positiveInteger(
    body?.expectedExecutionRevision,
    'A revisão esperada da execução'
  );
  const questionIds = normalizeResourceIds(body?.questionIds, 'A seleção de questões', 10);
  const materialIds = normalizeResourceIds(body?.materialIds, 'A seleção de materiais', 5);

  const persist = database.transaction(() => {
    const options = learningRecoveryExecutionResourceOptions(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
      lessonPublicId,
    });
    if (!options.editable) {
      fail(409, 'recovery_resources_frozen', 'Registre os recursos antes de concluir esta etapa.');
    }
    if (options.executionRevision !== expectedExecutionRevision) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de salvar.');
    }
    const allowedQuestionIds = new Set(options.questions.map(({ id }) => id));
    const allowedMaterialIds = new Set(options.materials.map(({ id }) => id));
    if (questionIds.some((id) => !allowedQuestionIds.has(id))
      || materialIds.some((id) => !allowedMaterialIds.has(id))) {
      fail(400, 'invalid_recovery_resource', 'Um dos recursos selecionados não está disponível para esta habilidade.');
    }

    const context = database.prepare(`
      SELECT lesson.id AS lesson_id, execution.id AS execution_id, recovery.id AS recovery_id,
        recovery.title
      FROM learning_recovery_plans recovery
      JOIN teaching_plans execution ON execution.source_recovery_plan_id = recovery.id
      JOIN teaching_plan_lessons lesson ON lesson.plan_id = execution.id
      WHERE recovery.public_id = ? AND recovery.owner_teacher_id = ?
        AND lesson.public_id = ?
    `).get(planPublicId, teacher.id, lessonPublicId);
    database.prepare(`
      DELETE FROM teaching_plan_lesson_resources
      WHERE lesson_id = ? AND resource_type IN ('question', 'material')
    `).run(context.lesson_id);
    const insert = database.prepare(`
      INSERT INTO teaching_plan_lesson_resources (
        lesson_id, plan_id, owner_teacher_id, resource_type,
        material_id, question_id, title_snapshot, teacher_notes, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const questionById = new Map(options.questions.map((question) => [question.id, question]));
    questionIds.forEach((id, index) => {
      const question = questionById.get(id);
      insert.run(
        context.lesson_id, context.execution_id, teacher.id, 'question', null, id,
        `${question.code} · ${question.statement}`.slice(0, 240),
        question.reviewed ? 'Questão selecionada para a prática orientada.' : 'Questão autoral: confira o conteúdo antes de usar.',
        index + 10
      );
    });
    const materialById = new Map(options.materials.map((material) => [material.id, material]));
    materialIds.forEach((id, index) => {
      const material = materialById.get(id);
      insert.run(
        context.lesson_id, context.execution_id, teacher.id, 'material', id, null,
        material.title.slice(0, 240),
        material.needsReview ? 'Material já escolhido; confira o vínculo com a habilidade antes de reutilizar.' : 'Material associado à habilidade no acervo; confira a adequação à turma.',
        index + 30
      );
    });
    const updated = database.prepare(`
      UPDATE teaching_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active' AND revision = ?
    `).run(teacher.id, context.execution_id, expectedExecutionRevision);
    if (updated.changes !== 1) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de salvar.');
    }
    database.prepare(`
      UPDATE learning_recovery_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, context.recovery_id);

    logActivityStrict({
      user: teacher,
      action: 'update_learning_recovery_resources',
      module: 'classes',
      entityType: 'teaching_plan_lesson',
      entityId: context.lesson_id,
      entityTitle: context.title,
      description: `${teacher.name || teacher.email || 'Professor'} revisou os recursos de uma intervenção.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        lesson_id: lessonPublicId,
        question_ids: questionIds,
        material_ids: materialIds,
      },
      req: request,
    }, database);

    return serializeLearningRecoveryExecution(database, context.recovery_id, teacher.id);
  });
  return persist.immediate();
}

function updateLearningRecoveryExecutionLesson(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  lessonPublicId,
  body,
  request,
}) {
  const expectedRevision = positiveInteger(body?.expectedRevision, 'A revisão esperada da etapa');
  const plannedDate = normalizeDate(body?.plannedDate, 'A data planejada');
  const durationMinutes = positiveInteger(body?.durationMinutes, 'A duração', { min: 10, max: 600 });
  const teacherNotes = normalizeNotes(body?.teacherNotes);
  const status = String(body?.status || '').trim();
  if (!EXECUTION_LESSON_STATUSES.has(status)) {
    fail(400, 'invalid_request', 'A situação da etapa é inválida.');
  }

  const persist = database.transaction(() => {
    const recovery = requireOwnedRecovery(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    const lesson = database.prepare(`
      SELECT
        lesson.id, lesson.title, lesson.status, lesson.lesson_phase, lesson.revision,
        execution.id AS execution_id, execution.status AS execution_status,
        execution.starts_on, execution.ends_on
      FROM teaching_plans execution
      JOIN teaching_plan_lessons lesson
        ON lesson.plan_id = execution.id
        AND lesson.owner_teacher_id = execution.owner_teacher_id
      WHERE execution.source_recovery_plan_id = ?
        AND execution.owner_teacher_id = ?
        AND lesson.public_id = ?
    `).get(recovery.id, teacher.id, lessonPublicId);
    if (!lesson) fail(404, 'recovery_execution_lesson_not_found', 'Etapa de execução não encontrada.');
    if (recovery.status !== 'active' || lesson.execution_status !== 'active') {
      fail(409, 'recovery_execution_frozen', 'Esta execução já foi encerrada e está disponível somente para consulta.');
    }
    if (Number(lesson.revision) !== expectedRevision) {
      fail(409, 'stale_execution_lesson', 'Esta etapa foi alterada em outro acesso. Recarregue antes de salvar.', {
        currentRevision: Number(lesson.revision),
      });
    }

    if (lesson.lesson_phase === 'monitoring' && status === 'skipped'
      && (!teacherNotes || teacherNotes.length < 10)) {
      fail(
        400,
        'monitoring_skip_reason_required',
        'Explique em pelo menos 10 caracteres por que a verificação não foi realizada.'
      );
    }
    if (lesson.lesson_phase === 'monitoring' && status === 'taught') {
      const monitoring = serializeLearningRecoveryMonitoring(database, {
        recoveryPlanId: recovery.id,
        teacherId: teacher.id,
      });
      if (monitoring?.state !== 'evidence_ready') {
        fail(
          409,
          'monitoring_evidence_required',
          'Conclua a aplicação de monitoramento e registre ao menos um resultado antes de marcar esta etapa como realizada.'
        );
      }
    }

    const startsOn = plannedDate < lesson.starts_on ? plannedDate : lesson.starts_on;
    const endsOn = plannedDate > lesson.ends_on ? plannedDate : lesson.ends_on;
    if (startsOn !== lesson.starts_on || endsOn !== lesson.ends_on) {
      database.prepare(`
        UPDATE teaching_plans
        SET starts_on = ?, ends_on = ?, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'active'
      `).run(startsOn, endsOn, teacher.id, lesson.execution_id);
    }

    const updated = database.prepare(`
      UPDATE teaching_plan_lessons
      SET planned_date = ?, duration_minutes = ?, teacher_notes = ?, status = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      plannedDate,
      durationMinutes,
      teacherNotes,
      status,
      lesson.id,
      expectedRevision
    );
    if (updated.changes !== 1) {
      fail(409, 'stale_execution_lesson', 'Esta etapa foi alterada em outro acesso. Recarregue antes de salvar.');
    }
    database.prepare(`
      UPDATE teaching_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, lesson.execution_id);
    database.prepare(`
      UPDATE learning_recovery_plans
      SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, recovery.id);

    logActivityStrict({
      user: teacher,
      action: 'update_learning_recovery_execution',
      module: 'classes',
      entityType: 'teaching_plan_lesson',
      entityId: lesson.id,
      entityTitle: lesson.title,
      description: `${teacher.name || teacher.email || 'Professor'} atualizou uma etapa da recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        lesson_id: lessonPublicId,
        previous_status: lesson.status,
        status,
        planned_date: plannedDate,
      },
      req: request,
    }, database);

    return serializeLearningRecoveryExecution(database, recovery.id, teacher.id);
  });
  return persist.immediate();
}

function completeLearningRecoveryExecution(database, {
  teacher,
  classPublicId,
  assessmentPublicId,
  planPublicId,
  body,
  request,
}) {
  const expectedRevision = positiveInteger(body?.expectedExecutionRevision, 'A revisão esperada da execução');
  const persist = database.transaction(() => {
    const recovery = requireOwnedRecovery(database, {
      teacherId: teacher.id,
      classPublicId,
      assessmentPublicId,
      planPublicId,
    });
    const execution = database.prepare(`
      SELECT id, public_id, title, status, revision
      FROM teaching_plans
      WHERE source_recovery_plan_id = ? AND owner_teacher_id = ?
    `).get(recovery.id, teacher.id);
    if (!execution) fail(404, 'recovery_execution_not_found', 'A execução deste plano ainda não foi organizada.');
    if (execution.status === 'completed' && recovery.status === 'completed') {
      return { completed: false, replayed: true, execution: serializeLearningRecoveryExecution(database, recovery.id, teacher.id) };
    }
    if (recovery.status !== 'active' || execution.status !== 'active') {
      fail(409, 'recovery_execution_frozen', 'Esta execução não pode mais ser concluída.');
    }
    if (Number(execution.revision) !== expectedRevision) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de concluir.', {
        currentRevision: Number(execution.revision),
      });
    }
    const pending = Number(database.prepare(`
      SELECT COUNT(*) FROM teaching_plan_lessons
      WHERE plan_id = ? AND owner_teacher_id = ? AND status = 'planned'
    `).pluck().get(execution.id, teacher.id));
    if (pending > 0) {
      fail(409, 'recovery_execution_has_pending_lessons', 'Registre todas as etapas como realizadas ou não realizadas antes de concluir.', { pending });
    }
    const monitoringLesson = database.prepare(`
      SELECT status, teacher_notes
      FROM teaching_plan_lessons
      WHERE plan_id = ? AND owner_teacher_id = ? AND lesson_phase = 'monitoring'
    `).get(execution.id, teacher.id);
    const monitoring = serializeLearningRecoveryMonitoring(database, {
      recoveryPlanId: recovery.id,
      teacherId: teacher.id,
    });
    const hasMonitoringEvidence = monitoringLesson?.status === 'taught'
      && monitoring?.state === 'evidence_ready';
    const hasDocumentedContingency = monitoringLesson?.status === 'skipped'
      && String(monitoringLesson.teacher_notes || '').trim().length >= 10;
    if (!hasMonitoringEvidence && !hasDocumentedContingency) {
      fail(
        409,
        'monitoring_evidence_required',
        'Finalize a verificação de aprendizagem ou registre por que ela não foi realizada antes de concluir o ciclo.'
      );
    }

    const completedExecution = database.prepare(`
      UPDATE teaching_plans
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND status = 'active'
    `).run(teacher.id, execution.id, expectedRevision);
    if (completedExecution.changes !== 1) {
      fail(409, 'stale_execution', 'A execução foi alterada em outro acesso. Recarregue antes de concluir.');
    }
    const completedRecovery = database.prepare(`
      UPDATE learning_recovery_plans
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'active'
    `).run(teacher.id, recovery.id);
    if (completedRecovery.changes !== 1) {
      fail(409, 'stale_recovery_plan', 'O plano foi alterado em outro acesso. Recarregue antes de concluir.');
    }

    logActivityStrict({
      user: teacher,
      action: 'complete_learning_recovery_execution',
      module: 'classes',
      entityType: 'learning_recovery_plan',
      entityId: recovery.id,
      entityTitle: recovery.title,
      description: `${teacher.name || teacher.email || 'Professor'} concluiu o ciclo de recomposição.`,
      metadata: {
        class_id: classPublicId,
        assessment_id: assessmentPublicId,
        plan_id: planPublicId,
        execution_id: execution.public_id,
      },
      req: request,
    }, database);

    return {
      completed: true,
      replayed: false,
      execution: serializeLearningRecoveryExecution(database, recovery.id, teacher.id),
    };
  });
  return persist.immediate();
}

module.exports = {
  EXECUTION_LESSON_STATUSES,
  serializeLearningRecoveryExecution,
  createLearningRecoveryExecution,
  learningRecoveryExecutionResourceOptions,
  updateLearningRecoveryExecutionResources,
  updateLearningRecoveryExecutionLesson,
  completeLearningRecoveryExecution,
};
