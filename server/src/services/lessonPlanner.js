const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');
const { logActivityStrict } = require('../helpers/activity');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('./questionEditorialCuration');

const PERIOD_TYPES = new Set(['week', 'bimester', 'custom']);
const PLAN_STATUSES = new Set(['draft', 'active', 'completed', 'archived']);
const RESOURCE_TYPES = new Set(['material', 'question', 'question_set', 'activity']);

class LessonPlannerError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new LessonPlannerError(status, code, message, details);
}

function text(value, field, max, { required = true } = {}) {
  const normalized = String(value ?? '').trim();
  if (required && !normalized) fail(400, 'invalid_request', `${field} é obrigatório.`);
  if (normalized.length > max) fail(400, 'invalid_request', `${field} deve ter no máximo ${max} caracteres.`);
  return normalized || null;
}

function positiveInteger(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) fail(400, 'invalid_request', `${field} é inválido.`);
  return number;
}

function isoDate(value, field) {
  const normalized = String(value || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || Number.isNaN(Date.parse(`${normalized}T00:00:00Z`))) {
    fail(400, 'invalid_request', `${field} é inválida.`);
  }
  return normalized;
}

function hash(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function fingerprintInput(normalized) {
  return {
    title: normalized.title,
    classId: normalized.class.id,
    gradeId: normalized.class.grade_id,
    academicYear: normalized.class.academic_year,
    disciplineId: normalized.discipline.id,
    periodType: normalized.periodType,
    startsOn: normalized.startsOn,
    endsOn: normalized.endsOn,
    lessons: normalized.lessons.map((lesson) => ({
      title: lesson.title,
      objective: lesson.objective,
      teacherNotes: lesson.teacherNotes,
      plannedDate: lesson.plannedDate,
      durationMinutes: lesson.durationMinutes,
      skills: lesson.skills.map(({ id, code, description }) => ({ id, code, description })),
      resources: lesson.resources,
    })),
  };
}

function normalizeIdempotencyKey(value) {
  const key = String(value || '').trim();
  if (key.length < 8 || key.length > 200) {
    fail(400, 'idempotency_key_required', 'Envie uma chave de idempotência válida para concluir esta operação.');
  }
  return hash(key);
}

function ownedClass(database, teacherId, classPublicId) {
  return database.prepare(`
    SELECT school_class.*, grade.name AS grade_name
    FROM school_classes school_class
    JOIN grades grade ON grade.id = school_class.grade_id
    WHERE school_class.public_id = ? AND school_class.owner_teacher_id = ?
  `).get(classPublicId, teacherId);
}

function ownedPlan(database, teacherId, planPublicId) {
  return database.prepare(`
    SELECT plan.*, school_class.public_id AS class_public_id,
      school_class.name AS class_name, grade.name AS grade_name,
      discipline.name AS discipline_name
    FROM teaching_plans plan
    LEFT JOIN school_classes school_class ON school_class.id = plan.class_id
    JOIN grades grade ON grade.id = plan.grade_id
    LEFT JOIN disciplines discipline ON discipline.id = plan.discipline_id
    WHERE plan.public_id = ? AND plan.owner_teacher_id = ?
      AND plan.source_recovery_plan_id IS NULL
  `).get(planPublicId, teacherId);
}

function validatePlanInput(database, teacherId, body) {
  const classPublicId = text(body?.classPublicId, 'A turma', 64);
  const schoolClass = ownedClass(database, teacherId, classPublicId);
  if (!schoolClass) fail(404, 'class_not_found', 'Turma não encontrada.');
  if (schoolClass.status !== 'active') fail(409, 'class_archived', 'Escolha uma turma ativa para este planejamento.');

  const disciplineId = positiveInteger(body?.disciplineId, 'O componente curricular');
  const discipline = database.prepare(`
    SELECT discipline.id, discipline.name
    FROM school_class_disciplines link
    JOIN disciplines discipline ON discipline.id = link.discipline_id
    WHERE link.class_id = ? AND link.owner_teacher_id = ? AND link.discipline_id = ?
  `).get(schoolClass.id, teacherId, disciplineId);
  if (!discipline) fail(400, 'invalid_discipline', 'O componente curricular não pertence à turma escolhida.');

  const startsOn = isoDate(body?.startsOn, 'A data inicial');
  const endsOn = isoDate(body?.endsOn, 'A data final');
  if (endsOn < startsOn) fail(400, 'invalid_period', 'A data final deve ser igual ou posterior à data inicial.');
  if (Number(startsOn.slice(0, 4)) !== schoolClass.academic_year
      || Number(endsOn.slice(0, 4)) !== schoolClass.academic_year) {
    fail(400, 'invalid_academic_year', 'O período deve estar dentro do ano letivo da turma.');
  }
  const periodType = String(body?.periodType || '').trim();
  if (!PERIOD_TYPES.has(periodType)) fail(400, 'invalid_period_type', 'Selecione uma organização por semana, bimestre ou período personalizado.');

  if (!Array.isArray(body?.lessons) || body.lessons.length < 1 || body.lessons.length > 100) {
    fail(400, 'invalid_lessons', 'O planejamento deve conter de 1 a 100 aulas.');
  }

  const lessons = body.lessons.map((lesson, index) => {
    const skillIds = [...new Set((lesson?.skillIds || []).map(Number))]
      .filter((id) => Number.isInteger(id) && id > 0);
    if (skillIds.length < 1 || skillIds.length > 10) {
      fail(400, 'invalid_skills', `A aula ${index + 1} deve ter de 1 a 10 habilidades BNCC.`);
    }
    const placeholders = skillIds.map(() => '?').join(', ');
    const skills = database.prepare(`
      SELECT skill.id, skill.code, skill.description, skill.grade_id,
        grade.name AS grade_name, unit.name AS unit_name
      FROM bncc_skills skill
      JOIN grades grade ON grade.id = skill.grade_id
      JOIN bncc_units unit ON unit.id = skill.unit_id
      WHERE skill.id IN (${placeholders})
      ORDER BY grade.sort_order, skill.code
    `).all(...skillIds);
    if (skills.length !== skillIds.length) fail(400, 'invalid_skills', `Há uma habilidade BNCC inválida na aula ${index + 1}.`);

    const plannedDate = lesson?.plannedDate ? isoDate(lesson.plannedDate, `A data da aula ${index + 1}`) : null;
    if (plannedDate && (plannedDate < startsOn || plannedDate > endsOn)) {
      fail(400, 'lesson_outside_period', `A aula ${index + 1} está fora do período do planejamento.`);
    }
    const durationMinutes = positiveInteger(lesson?.durationMinutes, `A duração da aula ${index + 1}`, { optional: true });
    if (durationMinutes !== null && (durationMinutes < 10 || durationMinutes > 600)) {
      fail(400, 'invalid_duration', 'A duração deve ficar entre 10 e 600 minutos.');
    }

    if (!Array.isArray(lesson?.resources) || lesson.resources.length > 50) {
      fail(400, 'invalid_resources', `A aula ${index + 1} pode ter no máximo 50 recursos.`);
    }
    const resources = lesson.resources.map((resource, resourceIndex) => validateResource(
      database, teacherId, resource, skillIds, resourceIndex
    ));
    return {
      title: text(lesson?.title, `O título da aula ${index + 1}`, 160),
      objective: text(lesson?.objective, `O objetivo da aula ${index + 1}`, 2000),
      teacherNotes: text(lesson?.teacherNotes, 'As observações', 5000, { required: false }),
      plannedDate,
      durationMinutes,
      skills,
      resources,
    };
  });

  return {
    title: text(body?.title, 'O título', 160),
    class: schoolClass,
    discipline,
    periodType,
    startsOn,
    endsOn,
    lessons,
  };
}

function validateResource(database, teacherId, resource, skillIds, index) {
  const type = String(resource?.type || '').trim();
  if (!RESOURCE_TYPES.has(type)) fail(400, 'invalid_resource', `O recurso ${index + 1} é inválido.`);
  const notes = text(resource?.notes, 'As orientações do recurso', 2000, { required: false });
  if (type === 'activity') {
    return { type, id: null, title: text(resource?.title, 'O título da atividade', 240), notes };
  }
  const id = positiveInteger(resource?.id, 'O recurso');
  let item;
  if (type === 'material') {
    item = database.prepare('SELECT id, title FROM materials WHERE id = ?').get(id);
  } else if (type === 'question') {
    item = database.prepare(`
      SELECT question.id, question.question_code || ' · ' || substr(question.statement, 1, 180) AS title
      FROM questions question
      WHERE question.id = ? AND question.status = 'active'
        AND question.skill_id IN (${skillIds.map(() => '?').join(', ')})
        AND (question.source = 'official' OR question.created_by = ?)
        AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id) = 4
        AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id AND option.is_correct = 1) = 1
    `).get(id, ...skillIds, teacherId);
  } else {
    item = database.prepare(`
      SELECT question_set.id, question_set.title
      FROM question_sets question_set
      WHERE question_set.id = ? AND (question_set.is_public = 1 OR question_set.user_id = ?)
        AND EXISTS (
          SELECT 1 FROM question_set_items item
          JOIN questions question ON question.id = item.question_id
          WHERE item.question_set_id = question_set.id
            AND question.skill_id IN (${skillIds.map(() => '?').join(', ')})
        )
    `).get(id, teacherId, ...skillIds);
  }
  if (!item) fail(400, 'resource_unavailable', 'Um recurso selecionado não está mais disponível para esta aula.');
  return { type, id, title: item.title, notes };
}

function assertNewEditorialResources(database, teacher, lessons, existingPlanId = null) {
  const retained = new Map();
  if (existingPlanId != null) {
    const saved = database.prepare(`SELECT resource_type, question_id, question_set_id
      FROM teaching_plan_lesson_resources WHERE plan_id = ? AND owner_teacher_id = ?
      AND resource_type IN ('question', 'question_set')`).all(existingPlanId, teacher.id);
    for (const row of saved) {
      const key = `${row.resource_type}:${row.question_id ?? row.question_set_id}`;
      retained.set(key, (retained.get(key) || 0) + 1);
    }
  }
  const questionIds = new Set();
  const setIds = new Set();
  for (const lesson of lessons) for (const resource of lesson.resources) {
    const key = `${resource.type}:${resource.id}`;
    const previous = retained.get(key);
    if (previous > 0) { retained.set(key, previous - 1); continue; }
    if (resource.type === 'question') questionIds.add(resource.id);
    if (resource.type === 'question_set') setIds.add(resource.id);
  }
  if (!questionIds.size && !setIds.size) return;
  const pilotEnabled = isEditorialPilotEnabled(database, teacher);
  const eligibleSql = editorialEligibleSql('q', { pilotEnabled });
  const questionBlocks = database.prepare(`SELECT 1 FROM questions q WHERE q.id = ? AND NOT (${eligibleSql})`);
  const setBlocks = database.prepare(`SELECT 1 FROM question_set_items item JOIN questions q ON q.id = item.question_id
    WHERE item.question_set_id = ? AND NOT (${eligibleSql}) LIMIT 1`);
  if ([...questionIds].some(id => questionBlocks.get(id)) || [...setIds].some(id => setBlocks.get(id))) {
    fail(409, 'editorial_resource_unavailable', 'Há uma questão indisponível para novos planejamentos. Substitua a questão ou o simulado para continuar.');
  }
}

function insertPlanContent(database, teacherId, planId, lessons) {
  const insertLesson = database.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective, teacher_notes,
      sequence_order, planned_date, duration_minutes, lesson_phase
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'intervention')
  `);
  const insertSkill = database.prepare(`
    INSERT INTO teaching_plan_lesson_skills (
      lesson_id, plan_id, owner_teacher_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot
    ) VALUES (?, ?, ?, ?, ?, ?)
  `);
  const insertResource = database.prepare(`
    INSERT INTO teaching_plan_lesson_resources (
      lesson_id, plan_id, owner_teacher_id, resource_type,
      material_id, question_id, question_set_id, title_snapshot, teacher_notes, sort_order
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  lessons.forEach((lesson, lessonIndex) => {
    const lessonId = insertLesson.run(
      uuidv4(), planId, teacherId, lesson.title, lesson.objective, lesson.teacherNotes,
      lessonIndex + 1, lesson.plannedDate, lesson.durationMinutes
    ).lastInsertRowid;
    lesson.skills.forEach((skill) => insertSkill.run(
      lessonId, planId, teacherId, skill.id, skill.code, skill.description
    ));
    lesson.resources.forEach((resource, resourceIndex) => insertResource.run(
      lessonId, planId, teacherId, resource.type,
      resource.type === 'material' ? resource.id : null,
      resource.type === 'question' ? resource.id : null,
      resource.type === 'question_set' ? resource.id : null,
      resource.title, resource.notes, resourceIndex + 1
    ));
  });
}

function serializePlan(database, plan) {
  const lessons = database.prepare(`
    SELECT id, public_id, title, objective, teacher_notes, sequence_order,
      planned_date, duration_minutes, status, revision, lesson_phase, updated_at
    FROM teaching_plan_lessons WHERE plan_id = ? ORDER BY sequence_order
  `).all(plan.id).map((lesson) => ({
    publicId: lesson.public_id,
    title: lesson.title,
    objective: lesson.objective,
    teacherNotes: lesson.teacher_notes,
    sequenceOrder: lesson.sequence_order,
    plannedDate: lesson.planned_date,
    durationMinutes: lesson.duration_minutes,
    status: lesson.status,
    revision: lesson.revision,
    phase: lesson.lesson_phase,
    updatedAt: lesson.updated_at,
    skills: database.prepare(`
      SELECT source_skill_id AS id, skill_code_snapshot AS code,
        skill_description_snapshot AS description
      FROM teaching_plan_lesson_skills WHERE lesson_id = ? ORDER BY skill_code_snapshot
    `).all(lesson.id),
    resources: database.prepare(`
      SELECT id, resource_type AS type, material_id AS materialId,
        question_id AS questionId, question_set_id AS questionSetId,
        title_snapshot AS title, teacher_notes AS notes, sort_order AS sortOrder
      FROM teaching_plan_lesson_resources WHERE lesson_id = ? ORDER BY sort_order
    `).all(lesson.id),
  }));
  return {
    publicId: plan.public_id,
    title: plan.title,
    status: plan.status,
    revision: plan.revision,
    periodType: plan.period_type,
    academicYear: plan.academic_year,
    startsOn: plan.starts_on,
    endsOn: plan.ends_on,
    activatedAt: plan.activated_at,
    completedAt: plan.completed_at,
    archivedAt: plan.archived_at,
    createdAt: plan.created_at,
    updatedAt: plan.updated_at,
    duplicatedFromPlanId: plan.duplicated_from_plan_id,
    class: plan.class_id ? { publicId: plan.class_public_id, name: plan.class_name } : null,
    grade: { id: plan.grade_id, name: plan.grade_name },
    discipline: plan.discipline_id ? { id: plan.discipline_id, name: plan.discipline_name } : null,
    lessons,
  };
}

function createLessonPlan(database, { teacher, body, idempotencyKey, req }) {
  const normalized = validatePlanInput(database, teacher.id, body);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const fingerprint = hash(JSON.stringify(fingerprintInput(normalized)));
  const existing = database.prepare(`
    SELECT operation.request_fingerprint, plan.public_id
    FROM teaching_plan_write_operations operation
    JOIN teaching_plans plan ON plan.id = operation.result_plan_id
    WHERE operation.owner_teacher_id = ? AND operation.operation_type = 'create'
      AND operation.idempotency_key_hash = ?
  `).get(teacher.id, keyHash);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'Esta operação já foi usada com outro conteúdo.');
    return { plan: serializePlan(database, ownedPlan(database, teacher.id, existing.public_id)), replayed: true };
  }

  const transaction = database.transaction(() => {
    assertNewEditorialResources(database, teacher, normalized.lessons);
    const publicId = uuidv4();
    const planId = database.prepare(`
      INSERT INTO teaching_plans (
        public_id, owner_teacher_id, class_id, grade_id, discipline_id,
        title, period_type, academic_year, starts_on, ends_on, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      publicId, teacher.id, normalized.class.id, normalized.class.grade_id,
      normalized.discipline.id, normalized.title, normalized.periodType,
      normalized.class.academic_year, normalized.startsOn, normalized.endsOn,
      teacher.id, teacher.id
    ).lastInsertRowid;
    insertPlanContent(database, teacher.id, planId, normalized.lessons);
    database.prepare(`
      INSERT INTO teaching_plan_write_operations (
        public_id, owner_teacher_id, operation_type, idempotency_key_hash,
        request_fingerprint, result_plan_id
      ) VALUES (?, ?, 'create', ?, ?, ?)
    `).run(uuidv4(), teacher.id, keyHash, fingerprint, planId);
    logActivityStrict({
      user: teacher, action: 'create_teaching_plan', module: 'planning',
      entityType: 'teaching_plan', entityId: planId, entityTitle: normalized.title,
      metadata: { classId: normalized.class.id, lessonCount: normalized.lessons.length }, req,
    }, database);
    return publicId;
  });
  const publicId = transaction();
  return { plan: serializePlan(database, ownedPlan(database, teacher.id, publicId)), replayed: false };
}

function updateLessonPlan(database, { teacher, planPublicId, body, req }) {
  const plan = ownedPlan(database, teacher.id, planPublicId);
  if (!plan) fail(404, 'plan_not_found', 'Planejamento não encontrado.');
  if (plan.status !== 'draft') fail(409, 'plan_frozen', 'Somente rascunhos podem ter sua estrutura alterada.');
  const expectedRevision = positiveInteger(body?.expectedRevision, 'A revisão esperada');
  if (plan.revision !== expectedRevision) fail(409, 'stale_plan', 'Este planejamento foi alterado em outro acesso. Recarregue antes de continuar.', { currentRevision: plan.revision });
  const normalized = validatePlanInput(database, teacher.id, body);
  const transaction = database.transaction(() => {
    assertNewEditorialResources(database, teacher, normalized.lessons, plan.id);
    database.prepare('DELETE FROM teaching_plan_lessons WHERE plan_id = ?').run(plan.id);
    database.prepare(`
      UPDATE teaching_plans SET class_id = ?, grade_id = ?, discipline_id = ?, title = ?,
        period_type = ?, academic_year = ?, starts_on = ?, ends_on = ?,
        revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      normalized.class.id, normalized.class.grade_id, normalized.discipline.id,
      normalized.title, normalized.periodType, normalized.class.academic_year,
      normalized.startsOn, normalized.endsOn, teacher.id, plan.id, expectedRevision
    );
    insertPlanContent(database, teacher.id, plan.id, normalized.lessons);
    logActivityStrict({
      user: teacher, action: 'update_teaching_plan', module: 'planning',
      entityType: 'teaching_plan', entityId: plan.id, entityTitle: normalized.title,
      metadata: { revision: expectedRevision + 1, lessonCount: normalized.lessons.length }, req,
    }, database);
  });
  transaction();
  return serializePlan(database, ownedPlan(database, teacher.id, planPublicId));
}

function transitionPlan(database, { teacher, planPublicId, body, action, req }) {
  const plan = ownedPlan(database, teacher.id, planPublicId);
  if (!plan) fail(404, 'plan_not_found', 'Planejamento não encontrado.');
  const expectedRevision = positiveInteger(body?.expectedRevision, 'A revisão esperada');
  if (plan.revision !== expectedRevision) fail(409, 'stale_plan', 'Este planejamento foi alterado em outro acesso. Recarregue antes de continuar.', { currentRevision: plan.revision });
  const transitions = {
    activate: { from: ['draft'], to: 'active', timestamp: 'activated_at', label: 'activate_teaching_plan' },
    complete: { from: ['active'], to: 'completed', timestamp: 'completed_at', label: 'complete_teaching_plan' },
    archive: { from: ['draft', 'active', 'completed'], to: 'archived', timestamp: 'archived_at', label: 'archive_teaching_plan' },
  };
  const transition = transitions[action];
  if (!transition.from.includes(plan.status)) fail(409, 'invalid_plan_transition', 'Esta ação não está disponível no estado atual do planejamento.');
  if (action === 'activate' && body?.reviewConfirmed !== true) fail(400, 'review_required', 'Confirme a revisão pedagógica antes de iniciar o planejamento.');
  const transaction = database.transaction(() => {
    database.prepare(`
      UPDATE teaching_plans SET status = ?, ${transition.timestamp} = CURRENT_TIMESTAMP,
        revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(transition.to, teacher.id, plan.id, expectedRevision);
    logActivityStrict({
      user: teacher, action: transition.label, module: 'planning', entityType: 'teaching_plan',
      entityId: plan.id, entityTitle: plan.title, metadata: { from: plan.status, to: transition.to }, req,
    }, database);
  });
  transaction();
  return serializePlan(database, ownedPlan(database, teacher.id, planPublicId));
}

function updateLessonProgress(database, { teacher, planPublicId, lessonPublicId, body, req }) {
  const plan = ownedPlan(database, teacher.id, planPublicId);
  if (!plan) fail(404, 'plan_not_found', 'Planejamento não encontrado.');
  if (plan.status !== 'active') fail(409, 'plan_not_active', 'Inicie o planejamento antes de registrar a aula.');
  const lesson = database.prepare(`
    SELECT * FROM teaching_plan_lessons WHERE public_id = ? AND plan_id = ? AND owner_teacher_id = ?
  `).get(lessonPublicId, plan.id, teacher.id);
  if (!lesson) fail(404, 'lesson_not_found', 'Aula não encontrada.');
  const expectedPlanRevision = positiveInteger(body?.expectedPlanRevision, 'A revisão do planejamento');
  const expectedLessonRevision = positiveInteger(body?.expectedLessonRevision, 'A revisão da aula');
  if (plan.revision !== expectedPlanRevision || lesson.revision !== expectedLessonRevision) {
    fail(409, 'stale_lesson', 'A aula foi alterada em outro acesso. Recarregue antes de continuar.');
  }
  const status = String(body?.status || '').trim();
  if (!['taught', 'skipped'].includes(status)) fail(400, 'invalid_lesson_status', 'Informe se a aula foi realizada ou não realizada.');
  const notes = text(body?.teacherNotes, 'O registro da aula', 5000, { required: status === 'skipped' });
  if (status === 'skipped' && notes.length < 10) fail(400, 'skip_reason_required', 'Explique brevemente por que a aula não foi realizada.');
  const transaction = database.transaction(() => {
    database.prepare(`
      UPDATE teaching_plan_lessons SET status = ?, teacher_notes = ?, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?
    `).run(status, notes, lesson.id, expectedLessonRevision);
    database.prepare(`
      UPDATE teaching_plans SET revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(teacher.id, plan.id, expectedPlanRevision);
    logActivityStrict({
      user: teacher, action: 'update_teaching_plan_lesson', module: 'planning',
      entityType: 'teaching_plan_lesson', entityId: lesson.id, entityTitle: lesson.title,
      metadata: { planId: plan.id, status }, req,
    }, database);
  });
  transaction();
  return serializePlan(database, ownedPlan(database, teacher.id, planPublicId));
}

function listLessonPlans(database, teacherId, query = {}) {
  const status = query.status && PLAN_STATUSES.has(query.status) ? query.status : null;
  const search = String(query.search || '').trim().slice(0, 100);
  const conditions = ['plan.owner_teacher_id = ?', 'plan.source_recovery_plan_id IS NULL'];
  const params = [teacherId];
  if (status) { conditions.push('plan.status = ?'); params.push(status); }
  if (search) { conditions.push('(plan.title LIKE ? OR school_class.name LIKE ?)'); params.push(`%${search}%`, `%${search}%`); }
  return database.prepare(`
    SELECT plan.public_id AS publicId, plan.title, plan.status, plan.revision,
      plan.period_type AS periodType, plan.starts_on AS startsOn, plan.ends_on AS endsOn,
      plan.updated_at AS updatedAt, school_class.public_id AS classPublicId,
      school_class.name AS className, grade.name AS gradeName, discipline.name AS disciplineName,
      COUNT(lesson.id) AS lessonCount,
      SUM(CASE WHEN lesson.status = 'taught' THEN 1 ELSE 0 END) AS taughtCount
    FROM teaching_plans plan
    LEFT JOIN school_classes school_class ON school_class.id = plan.class_id
    JOIN grades grade ON grade.id = plan.grade_id
    LEFT JOIN disciplines discipline ON discipline.id = plan.discipline_id
    LEFT JOIN teaching_plan_lessons lesson ON lesson.plan_id = plan.id
    WHERE ${conditions.join(' AND ')}
    GROUP BY plan.id ORDER BY CASE plan.status WHEN 'active' THEN 0 WHEN 'draft' THEN 1 WHEN 'completed' THEN 2 ELSE 3 END,
      date(plan.starts_on) DESC, datetime(plan.updated_at) DESC
    LIMIT 100
  `).all(...params);
}

function duplicateLessonPlan(database, { teacher, planPublicId, body, idempotencyKey, req }) {
  const source = ownedPlan(database, teacher.id, planPublicId);
  if (!source) fail(404, 'plan_not_found', 'Planejamento não encontrado.');
  const sourceSerialized = serializePlan(database, source);
  const targetClass = ownedClass(database, teacher.id, text(body?.classPublicId, 'A turma de destino', 64));
  if (!targetClass || targetClass.status !== 'active') fail(400, 'invalid_target_class', 'Escolha uma turma ativa de sua responsabilidade.');
  const targetStart = isoDate(body?.startsOn, 'A nova data inicial');
  const span = Math.round((Date.parse(`${source.ends_on}T00:00:00Z`) - Date.parse(`${source.starts_on}T00:00:00Z`)) / 86400000);
  const targetEndDate = new Date(`${targetStart}T00:00:00Z`);
  targetEndDate.setUTCDate(targetEndDate.getUTCDate() + span);
  const targetEnd = targetEndDate.toISOString().slice(0, 10);
  const shift = Math.round((Date.parse(`${targetStart}T00:00:00Z`) - Date.parse(`${source.starts_on}T00:00:00Z`)) / 86400000);
  const lessons = sourceSerialized.lessons.map((lesson) => {
    let plannedDate = null;
    if (lesson.plannedDate) {
      const shifted = new Date(`${lesson.plannedDate}T00:00:00Z`);
      shifted.setUTCDate(shifted.getUTCDate() + shift);
      plannedDate = shifted.toISOString().slice(0, 10);
    }
    return {
      title: lesson.title, objective: lesson.objective, teacherNotes: null,
      plannedDate, durationMinutes: lesson.durationMinutes,
      skillIds: lesson.skills.map((skill) => skill.id),
      resources: lesson.resources.map((resource) => ({
        type: resource.type,
        id: resource.materialId || resource.questionId || resource.questionSetId || null,
        title: resource.title,
        notes: resource.notes,
      })),
    };
  });
  const createBody = {
    title: text(body?.title || `Cópia de ${source.title}`, 'O título', 160),
    classPublicId: targetClass.public_id,
    disciplineId: positiveInteger(body?.disciplineId ?? source.discipline_id, 'O componente curricular'),
    periodType: body?.periodType || source.period_type,
    startsOn: targetStart,
    endsOn: targetEnd,
    lessons,
  };
  const normalized = validatePlanInput(database, teacher.id, createBody);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const fingerprint = hash(JSON.stringify({
    source: source.public_id,
    plan: fingerprintInput(normalized),
  }));
  const existing = database.prepare(`
    SELECT operation.request_fingerprint, plan.public_id FROM teaching_plan_write_operations operation
    JOIN teaching_plans plan ON plan.id = operation.result_plan_id
    WHERE operation.owner_teacher_id = ? AND operation.operation_type = 'duplicate'
      AND operation.idempotency_key_hash = ?
  `).get(teacher.id, keyHash);
  if (existing) {
    if (existing.request_fingerprint !== fingerprint) fail(409, 'idempotency_conflict', 'Esta duplicação já foi usada com outro destino.');
    return { plan: serializePlan(database, ownedPlan(database, teacher.id, existing.public_id)), replayed: true };
  }
  const transaction = database.transaction(() => {
    assertNewEditorialResources(database, teacher, normalized.lessons);
    const publicId = uuidv4();
    const planId = database.prepare(`
      INSERT INTO teaching_plans (
        public_id, owner_teacher_id, class_id, grade_id, discipline_id, duplicated_from_plan_id,
        title, period_type, academic_year, starts_on, ends_on, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(publicId, teacher.id, normalized.class.id, normalized.class.grade_id,
      normalized.discipline.id, source.id, normalized.title, normalized.periodType,
      normalized.class.academic_year, normalized.startsOn, normalized.endsOn, teacher.id, teacher.id).lastInsertRowid;
    insertPlanContent(database, teacher.id, planId, normalized.lessons);
    database.prepare(`
      INSERT INTO teaching_plan_write_operations (
        public_id, owner_teacher_id, operation_type, idempotency_key_hash, request_fingerprint, result_plan_id
      ) VALUES (?, ?, 'duplicate', ?, ?, ?)
    `).run(uuidv4(), teacher.id, keyHash, fingerprint, planId);
    logActivityStrict({
      user: teacher, action: 'duplicate_teaching_plan', module: 'planning', entityType: 'teaching_plan',
      entityId: planId, entityTitle: normalized.title,
      metadata: { sourcePlanId: source.id, targetClassId: normalized.class.id }, req,
    }, database);
    return publicId;
  });
  const publicId = transaction();
  return { plan: serializePlan(database, ownedPlan(database, teacher.id, publicId)), replayed: false };
}

module.exports = {
  LessonPlannerError,
  createLessonPlan,
  duplicateLessonPlan,
  listLessonPlans,
  ownedPlan,
  serializePlan,
  transitionPlan,
  updateLessonPlan,
  updateLessonProgress,
};
