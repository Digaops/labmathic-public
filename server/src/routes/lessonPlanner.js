const express = require('express');
const db = require('../database');
const { eligibleMaterialSkill } = require('../services/materialSkillEligibility');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('../services/questionEditorialCuration');
const { searchLessonPlannerResources } = require('../services/lessonPlannerCatalog');
const { previewLessonPlannerResource } = require('../services/lessonPlannerResourcePreview');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const {
  LessonPlannerError,
  createLessonPlan,
  duplicateLessonPlan,
  listLessonPlans,
  ownedPlan,
  serializePlan,
  transitionPlan,
  updateLessonPlan,
  updateLessonProgress,
} = require('../services/lessonPlanner');

const router = express.Router();

function requireProfessor(req, res, next) {
  const currentUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!currentUser || currentUser.role !== 'professor') {
    return res.status(403).json({ error: 'Acesso restrito a professores.' });
  }
  req.user = { ...req.user, ...currentUser };
  return next();
}

function positiveInteger(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function mapError(error, res) {
  if (error instanceof LessonPlannerError) {
    return res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
  }
  const known = {
    teaching_plan_requires_lessons_with_skills: 'Revise as aulas: todas precisam de ao menos uma habilidade BNCC.',
    teaching_plan_has_pending_lessons: 'Registre todas as aulas como realizadas ou não realizadas antes de concluir.',
    invalid_teaching_plan_status_transition: 'Esta mudança não está disponível no estado atual do planejamento.',
    teaching_plan_class_context_mismatch: 'A turma e o ano letivo não são compatíveis com este planejamento.',
  };
  const message = Object.entries(known).find(([code]) => String(error.message).includes(code));
  if (message) return res.status(409).json({ error: message[1], code: message[0] });
  if (process.env.NODE_ENV !== 'production') console.error(error);
  return res.status(500).json({ error: 'Não foi possível concluir esta operação.' });
}

router.use(authenticate, requireProfessor, requireFeatureFlag('planning.lesson_planner'));
router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});

router.get('/bootstrap', (_req, res) => {
  const teacherId = _req.user.id;
  const classes = db.prepare(`
    SELECT school_class.public_id AS publicId, school_class.name,
      school_class.academic_year AS academicYear, school_class.grade_id AS gradeId,
      grade.name AS gradeName
    FROM school_classes school_class
    JOIN grades grade ON grade.id = school_class.grade_id
    WHERE school_class.owner_teacher_id = ? AND school_class.status = 'active'
    ORDER BY school_class.academic_year DESC, grade.sort_order, school_class.name COLLATE NOCASE
  `).all(teacherId).map((schoolClass) => ({
    ...schoolClass,
    disciplines: db.prepare(`
      SELECT discipline.id, discipline.name FROM school_class_disciplines link
      JOIN disciplines discipline ON discipline.id = link.discipline_id
      JOIN school_classes school_class ON school_class.id = link.class_id
      WHERE school_class.public_id = ? AND link.owner_teacher_id = ?
      ORDER BY discipline.name COLLATE NOCASE
    `).all(schoolClass.publicId, teacherId),
  }));
  const grades = db.prepare(`
    SELECT DISTINCT grade.id, grade.name, grade.sort_order AS sortOrder
    FROM grades grade JOIN bncc_skills skill ON skill.grade_id = grade.id
    ORDER BY grade.sort_order, grade.name
  `).all();
  res.json({ classes, grades });
});

router.get('/catalog/skills', (req, res) => {
  const gradeId = positiveInteger(req.query.gradeId);
  const unitId = positiveInteger(req.query.unitId);
  if (!gradeId) return res.status(400).json({ error: 'Selecione um ano escolar.' });
  const units = db.prepare(`
    SELECT DISTINCT unit.id, unit.name, unit.sort_order AS sortOrder
    FROM bncc_units unit JOIN bncc_skills skill ON skill.unit_id = unit.id
    WHERE skill.grade_id = ? ORDER BY unit.sort_order, unit.name
  `).all(gradeId);
  const params = [gradeId];
  const unitClause = unitId ? 'AND skill.unit_id = ?' : '';
  if (unitId) params.push(unitId);
  const skills = db.prepare(`
    SELECT skill.id, skill.code, skill.description, skill.grade_id AS gradeId,
      grade.name AS gradeName, skill.unit_id AS unitId, unit.name AS unitName
    FROM bncc_skills skill
    JOIN grades grade ON grade.id = skill.grade_id
    JOIN bncc_units unit ON unit.id = skill.unit_id
    WHERE skill.grade_id = ? ${unitClause}
    ORDER BY unit.sort_order, skill.code
  `).all(...params);
  return res.json({ units, skills });
});

router.get('/catalog/resources/:type/:id/preview', (req, res) => {
  try { return res.json(previewLessonPlannerResource(db, req.user.id, req.params.type, req.params.id)); }
  catch (error) { return mapError(error, res); }
});

router.get('/catalog/resources', (req, res) => {
  if (req.query.category !== undefined || req.query.page !== undefined) {
    try { return res.json(searchLessonPlannerResources(db, req.user.id, req.query)); }
    catch (error) { return mapError(error, res); }
  }
  const skillIds = [...new Set(String(req.query.skillIds || '').split(',').map(Number))]
    .filter((id) => Number.isInteger(id) && id > 0).slice(0, 10);
  if (!skillIds.length) return res.status(400).json({ error: 'Selecione ao menos uma habilidade.' });
  const gradeId = positiveInteger(req.query.gradeId);
  const disciplineId = positiveInteger(req.query.disciplineId);
  const search = String(req.query.search || '').trim().slice(0, 80);
  const placeholders = skillIds.map(() => '?').join(', ');
  const searchTerm = `%${search}%`;
  const pilotEnabled = isEditorialPilotEnabled(db, req.user);

  const questions = db.prepare(`
    SELECT question.id, question.question_code AS code, question.statement AS title,
      question.difficulty, skill.code AS skillCode
    FROM questions question JOIN bncc_skills skill ON skill.id = question.skill_id
    WHERE question.status = 'active' AND question.skill_id IN (${placeholders})
      AND ${editorialEligibleSql('question', { pilotEnabled })}
      AND (question.source = 'official' OR question.created_by = ?)
      AND (? = '' OR question.statement LIKE ? OR question.question_code LIKE ?)
      AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id) = 4
      AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id AND option.is_correct = 1) = 1
    ORDER BY CASE question.difficulty WHEN 'facil' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
      question.question_code LIMIT 30
  `).all(...skillIds, req.user.id, search, searchTerm, searchTerm);

  const questionSets = db.prepare(`
    SELECT question_set.id, question_set.title,
      COUNT(DISTINCT item.question_id) AS questionCount
    FROM question_sets question_set
    JOIN question_set_items item ON item.question_set_id = question_set.id
    JOIN questions question ON question.id = item.question_id
    WHERE (question_set.is_public = 1 OR question_set.user_id = ?)
      AND question.skill_id IN (${placeholders})
      AND NOT EXISTS (SELECT 1 FROM question_set_items member JOIN questions q ON q.id = member.question_id
        WHERE member.question_set_id = question_set.id AND NOT (${editorialEligibleSql('q', { pilotEnabled })}))
      AND (? = '' OR question_set.title LIKE ?)
    GROUP BY question_set.id ORDER BY question_set.updated_at DESC LIMIT 30
  `).all(req.user.id, ...skillIds, search, searchTerm);

  const materialConditions = [];
  const materialParams = [...skillIds];
  if (gradeId) { materialConditions.push('(material.grade_id = ? OR mapping.skill_id IS NOT NULL)'); materialParams.push(gradeId); }
  if (disciplineId) { materialConditions.push('(material.discipline_id = ? OR material.discipline_id IS NULL)'); materialParams.push(disciplineId); }
  if (search) { materialConditions.push('(material.title LIKE ? OR material.description LIKE ?)'); materialParams.push(searchTerm, searchTerm); }
  const materials = db.prepare(`
    SELECT DISTINCT material.id, material.title, type.name AS typeName,
      grade.name AS gradeName, discipline.name AS disciplineName,
      CASE WHEN mapping.skill_id IS NOT NULL THEN 1 ELSE 0 END AS skillMatch
    FROM materials material
    LEFT JOIN material_bncc_skills mapping
      ON mapping.material_id = material.id AND mapping.skill_id IN (${placeholders})
      AND ${eligibleMaterialSkill()}
    LEFT JOIN material_types type ON type.id = material.material_type_id
    LEFT JOIN grades grade ON grade.id = material.grade_id
    LEFT JOIN disciplines discipline ON discipline.id = material.discipline_id
    ${materialConditions.length ? `WHERE ${materialConditions.join(' AND ')}` : ''}
    ORDER BY skillMatch DESC, material.updated_at DESC LIMIT 30
  `).all(...materialParams);

  return res.json({ materials, questions, questionSets });
});

router.get('/', (req, res) => {
  res.json({ plans: listLessonPlans(db, req.user.id, req.query) });
});

router.get('/:planPublicId', (req, res) => {
  const plan = ownedPlan(db, req.user.id, req.params.planPublicId);
  if (!plan) return res.status(404).json({ error: 'Planejamento não encontrado.' });
  return res.json({ plan: serializePlan(db, plan) });
});

router.post('/', (req, res) => {
  try {
    const result = createLessonPlan(db, {
      teacher: req.user, body: req.body, idempotencyKey: req.get('Idempotency-Key'), req,
    });
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { return mapError(error, res); }
});

router.put('/:planPublicId', (req, res) => {
  try {
    return res.json({ plan: updateLessonPlan(db, {
      teacher: req.user, planPublicId: req.params.planPublicId, body: req.body, req,
    }) });
  } catch (error) { return mapError(error, res); }
});

['activate', 'complete', 'archive'].forEach((action) => {
  router.post(`/:planPublicId/${action}`, (req, res) => {
    try {
      return res.json({ plan: transitionPlan(db, {
        teacher: req.user, planPublicId: req.params.planPublicId, body: req.body, action, req,
      }) });
    } catch (error) { return mapError(error, res); }
  });
});

router.patch('/:planPublicId/lessons/:lessonPublicId', (req, res) => {
  try {
    return res.json({ plan: updateLessonProgress(db, {
      teacher: req.user, planPublicId: req.params.planPublicId,
      lessonPublicId: req.params.lessonPublicId, body: req.body, req,
    }) });
  } catch (error) { return mapError(error, res); }
});

router.post('/:planPublicId/duplicate', (req, res) => {
  try {
    const result = duplicateLessonPlan(db, {
      teacher: req.user, planPublicId: req.params.planPublicId, body: req.body,
      idempotencyKey: req.get('Idempotency-Key'), req,
    });
    return res.status(result.replayed ? 200 : 201).json(result);
  } catch (error) { return mapError(error, res); }
});

module.exports = router;
