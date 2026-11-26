const crypto = require('node:crypto');
const express = require('express');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const { notifyAdmins } = require('../helpers/notify');
const { logActivity } = require('../helpers/activity');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('../services/questionEditorialCuration');
const {
  AnswerKeyBalanceError,
  createQuestionSetOptionOrders,
} = require('../services/answerKeyBalance');

const router = express.Router();
const MAX_SKILLS = 10;
const MIN_QUESTIONS_PER_SKILL = 2;
const MAX_QUESTIONS_PER_SKILL = 5;
const DIFFICULTY_SEQUENCE = ['facil', 'media', 'dificil', 'media', 'facil'];

class DiagnosticRequestError extends Error {
  constructor(status, message, details = null) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireCurrentProfessor(req, res, next) {
  const current = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(req.user.id);
  if (!current || current.role !== 'professor') {
    return res.status(403).json({ error: 'O gerador diagnóstico é exclusivo para professores.' });
  }
  req.currentUser = current;
  return next();
}

function eligibleCondition(pilotEnabled) {
  return `
    question.status = 'active'
    AND ${editorialEligibleSql('question', { pilotEnabled, purpose: 'diagnosis' })}
    AND question.question_type = 'multiple_choice'
    AND (
      question.source = 'official'
      OR (question.source = 'teacher' AND question.created_by = ?)
    )
    AND (
      SELECT COUNT(*) FROM question_options option
      WHERE option.question_id = question.id
    ) = 4
    AND (
      SELECT COUNT(*) FROM question_options option
      WHERE option.question_id = question.id AND option.is_correct = 1
    ) = 1
  `;
}

function shuffle(values) {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swapIndex = crypto.randomInt(index + 1);
    [result[index], result[swapIndex]] = [result[swapIndex], result[index]];
  }
  return result;
}

function selectBalanced(candidates, requestedCount) {
  const buckets = new Map([
    ['facil', shuffle(candidates.filter(({ difficulty }) => difficulty === 'facil'))],
    ['media', shuffle(candidates.filter(({ difficulty }) => difficulty === 'media'))],
    ['dificil', shuffle(candidates.filter(({ difficulty }) => difficulty === 'dificil'))],
  ]);
  const selected = [];
  for (let index = 0; index < requestedCount; index += 1) {
    const preferred = DIFFICULTY_SEQUENCE[index];
    let bucket = buckets.get(preferred);
    if (!bucket?.length) {
      bucket = [...buckets.values()].sort((left, right) => right.length - left.length)[0];
    }
    if (!bucket?.length) break;
    selected.push(bucket.pop());
  }
  return selected;
}

function selectWithEditorialPriority(candidates, requestedCount) {
  const pilot = candidates.filter(question => question.editorial_stage);
  const selectedPilot = selectBalanced(pilot, Math.min(pilot.length, requestedCount));
  return selectedPilot.concat(selectBalanced(candidates.filter(question => !question.editorial_stage),
    requestedCount - selectedPilot.length));
}

function normalizeGeneration(body) {
  const gradeId = positiveInteger(body?.gradeId);
  const questionsPerSkill = positiveInteger(body?.questionsPerSkill);
  const rawSkillIds = body?.skillIds;
  const title = body?.title === undefined || body?.title === null
    ? ''
    : String(body.title).trim();

  if (!gradeId) throw new DiagnosticRequestError(400, 'Selecione um ano escolar válido.');
  if (!Array.isArray(rawSkillIds) || rawSkillIds.length < 1 || rawSkillIds.length > MAX_SKILLS) {
    throw new DiagnosticRequestError(400, `Selecione de 1 a ${MAX_SKILLS} habilidades BNCC.`);
  }
  const skillIds = rawSkillIds.map(positiveInteger);
  if (skillIds.some((id) => !id) || new Set(skillIds).size !== skillIds.length) {
    throw new DiagnosticRequestError(400, 'A lista de habilidades contém valores inválidos ou repetidos.');
  }
  if (!questionsPerSkill
      || questionsPerSkill < MIN_QUESTIONS_PER_SKILL
      || questionsPerSkill > MAX_QUESTIONS_PER_SKILL) {
    throw new DiagnosticRequestError(
      400,
      `Escolha entre ${MIN_QUESTIONS_PER_SKILL} e ${MAX_QUESTIONS_PER_SKILL} questões por habilidade.`
    );
  }
  if (title.length > 200) throw new DiagnosticRequestError(400, 'O título deve ter no máximo 200 caracteres.');
  return { gradeId, skillIds, questionsPerSkill, title };
}

router.use(
  '/diagnostics',
  authenticate,
  requireCurrentProfessor,
  requireFeatureFlag('question_bank.diagnostic_generator')
);

router.get('/diagnostics/bootstrap', (req, res) => {
  const gradeId = positiveInteger(req.query.grade_id);
  const pilotEnabled = isEditorialPilotEnabled(db, req.currentUser);
  const grades = db.prepare(`
    SELECT grade.id, grade.name, grade.sort_order,
      COUNT(DISTINCT skill.id) AS skill_count,
      COUNT(question.id) AS candidate_count,
      SUM(CASE WHEN question.reviewed = 1 THEN 1 ELSE 0 END) AS reviewed_count
    FROM grades grade
    JOIN bncc_skills skill ON skill.grade_id = grade.id
    JOIN questions question ON question.skill_id = skill.id
    WHERE ${eligibleCondition(pilotEnabled)}
    GROUP BY grade.id
    ORDER BY grade.sort_order, grade.name
  `).all(req.user.id).map((grade) => ({
    id: grade.id,
    name: grade.name,
    skillCount: Number(grade.skill_count),
    candidateCount: Number(grade.candidate_count),
    reviewedCount: Number(grade.reviewed_count || 0),
  }));

  const skills = gradeId ? db.prepare(`
    SELECT skill.id, skill.code, skill.description,
      unit.id AS unit_id, unit.name AS unit_name, unit.sort_order AS unit_sort_order,
      COUNT(question.id) AS candidate_count,
      SUM(CASE WHEN question.difficulty = 'facil' THEN 1 ELSE 0 END) AS easy_count,
      SUM(CASE WHEN question.difficulty = 'media' THEN 1 ELSE 0 END) AS medium_count,
      SUM(CASE WHEN question.difficulty = 'dificil' THEN 1 ELSE 0 END) AS difficult_count,
      SUM(CASE WHEN question.reviewed = 1 THEN 1 ELSE 0 END) AS reviewed_count
    FROM bncc_skills skill
    JOIN bncc_units unit ON unit.id = skill.unit_id
    JOIN questions question ON question.skill_id = skill.id
    WHERE skill.grade_id = ? AND ${eligibleCondition(pilotEnabled)}
    GROUP BY skill.id
    ORDER BY unit.sort_order, skill.code
  `).all(gradeId, req.user.id).map((skill) => ({
    id: skill.id,
    code: skill.code,
    description: skill.description,
    unitId: skill.unit_id,
    unitName: skill.unit_name,
    candidateCount: Number(skill.candidate_count),
    reviewedCount: Number(skill.reviewed_count || 0),
    difficulties: {
      easy: Number(skill.easy_count || 0),
      medium: Number(skill.medium_count || 0),
      difficult: Number(skill.difficult_count || 0),
    },
  })) : [];

  const unitsById = new Map();
  skills.forEach((skill) => {
    const current = unitsById.get(skill.unitId) || {
      id: skill.unitId,
      name: skill.unitName,
      skillCount: 0,
      candidateCount: 0,
    };
    current.skillCount += 1;
    current.candidateCount += skill.candidateCount;
    unitsById.set(skill.unitId, current);
  });

  return res.json({
    grades,
    units: [...unitsById.values()],
    skills,
    limits: {
      maxSkills: MAX_SKILLS,
      minQuestionsPerSkill: MIN_QUESTIONS_PER_SKILL,
      maxQuestionsPerSkill: MAX_QUESTIONS_PER_SKILL,
      maxQuestions: MAX_SKILLS * MAX_QUESTIONS_PER_SKILL,
    },
    qualityNotice: 'Questões ativas e com gabarito válido. Revise o simulado antes de aplicar.',
    methodology: 'balanced_by_skill_and_available_difficulty',
  });
});

router.post('/diagnostics/generate', (req, res, next) => {
  let input;
  try {
    input = normalizeGeneration(req.body);
  } catch (error) {
    if (error instanceof DiagnosticRequestError) {
      return res.status(error.status).json({ error: error.message, details: error.details });
    }
    return next(error);
  }

  try {
    const createDiagnostic = db.transaction(() => {
      const pilotEnabled = isEditorialPilotEnabled(db, req.currentUser);
      const grade = db.prepare('SELECT id, name FROM grades WHERE id = ?').get(input.gradeId);
      if (!grade) throw new DiagnosticRequestError(400, 'Ano escolar não encontrado.');

      const placeholders = input.skillIds.map(() => '?').join(', ');
      const skillRows = db.prepare(`
        SELECT id, code, description
        FROM bncc_skills
        WHERE grade_id = ? AND id IN (${placeholders})
      `).all(input.gradeId, ...input.skillIds);
      if (skillRows.length !== input.skillIds.length) {
        throw new DiagnosticRequestError(400, 'Uma ou mais habilidades não pertencem ao ano selecionado.');
      }
      const skillById = new Map(skillRows.map((skill) => [skill.id, skill]));
      const candidates = db.prepare(`
        SELECT question.id, question.skill_id, question.difficulty,
          question.source, question.reviewed, question.image_path, editorial.stage AS editorial_stage
        FROM questions question
        LEFT JOIN question_editorial_curation editorial ON editorial.question_id = question.id
        WHERE question.skill_id IN (${placeholders})
          AND ${eligibleCondition(pilotEnabled)}
      `).all(...input.skillIds, req.user.id);
      const candidatesBySkill = new Map(input.skillIds.map((skillId) => [skillId, []]));
      candidates.forEach((question) => candidatesBySkill.get(question.skill_id)?.push(question));

      const shortages = input.skillIds
        .filter((skillId) => candidatesBySkill.get(skillId).length < input.questionsPerSkill)
        .map((skillId) => ({
          skillId,
          code: skillById.get(skillId).code,
          available: candidatesBySkill.get(skillId).length,
          required: input.questionsPerSkill,
        }));
      if (shortages.length) {
        throw new DiagnosticRequestError(
          409,
          'O banco ainda não possui questões suficientes para todas as habilidades selecionadas.',
          { shortages }
        );
      }

      const selectionBySkill = input.skillIds.map((skillId) => {
        const eligible = candidatesBySkill.get(skillId);
        return {
          skill: skillById.get(skillId),
          candidateCount: eligible.length,
          selected: selectWithEditorialPriority(eligible, input.questionsPerSkill),
        };
      });
      const selectedQuestions = selectionBySkill.flatMap(({ selected }) => selected);
      const containsAuthorQuestions = selectedQuestions.some(({ source }) => source === 'teacher');
      const reviewedCount = selectedQuestions.filter(({ reviewed }) => reviewed === 1).length;
      const generatedTitle = input.title || `Avaliação diagnóstica · ${grade.name}`;
      const skillCountLabel = selectionBySkill.length === 1
        ? '1 habilidade BNCC'
        : `${selectionBySkill.length} habilidades BNCC`;
      const description = `Diagnóstico de ${grade.name} com ${skillCountLabel}.`;

      const questionSetId = Number(db.prepare(`
        INSERT INTO question_sets (
          user_id, title, description, is_public, contains_author_questions
        ) VALUES (?, ?, ?, 0, ?)
      `).run(
        req.user.id,
        generatedTitle,
        description,
        containsAuthorQuestions ? 1 : 0
      ).lastInsertRowid);
      let optionOrders;
      try {
        optionOrders = createQuestionSetOptionOrders(
          db,
          selectedQuestions.map(({ id: questionId }) => ({ question_id: questionId })),
          `question-set:${questionSetId}`
        );
      } catch (error) {
        if (error instanceof AnswerKeyBalanceError) {
          throw new DiagnosticRequestError(
            409,
            'Uma das questões selecionadas possui um gabarito incompatível.',
            { questionId: error.questionId }
          );
        }
        throw error;
      }
      const insertItem = db.prepare(`
        INSERT INTO question_set_items (
          question_set_id, question_id, sort_order, show_image, option_order
        ) VALUES (?, ?, ?, ?, ?)
      `);
      selectedQuestions.forEach((question, index) => {
        insertItem.run(
          questionSetId,
          question.id,
          index + 1,
          question.image_path ? 1 : 0,
          optionOrders.get(question.id)
        );
      });
      db.prepare(`
        INSERT INTO diagnostic_question_sets (
          question_set_id, owner_teacher_id, grade_id,
          questions_per_skill, total_questions
        ) VALUES (?, ?, ?, ?, ?)
      `).run(questionSetId, req.user.id, input.gradeId, input.questionsPerSkill, selectedQuestions.length);
      const insertSkill = db.prepare(`
        INSERT INTO diagnostic_question_set_skills (
          question_set_id, owner_teacher_id, grade_id, skill_id,
          requested_count, selected_count, easy_count, medium_count,
          difficult_count, candidate_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const composition = selectionBySkill.map(({ skill, selected, candidateCount }) => {
        const difficultyCount = {
          easy: selected.filter(({ difficulty }) => difficulty === 'facil').length,
          medium: selected.filter(({ difficulty }) => difficulty === 'media').length,
          difficult: selected.filter(({ difficulty }) => difficulty === 'dificil').length,
        };
        insertSkill.run(
          questionSetId, req.user.id, input.gradeId, skill.id,
          input.questionsPerSkill, selected.length,
          difficultyCount.easy, difficultyCount.medium, difficultyCount.difficult,
          candidateCount
        );
        return {
          id: skill.id,
          code: skill.code,
          description: skill.description,
          candidateCount,
          selectedCount: selected.length,
          editorialPilotCount: selected.filter(question => question.editorial_stage).length,
          difficulties: difficultyCount,
        };
      });

      return {
        id: questionSetId,
        title: generatedTitle,
        grade,
        questionCount: selectedQuestions.length,
        questionsPerSkill: input.questionsPerSkill,
        containsAuthorQuestions,
        reviewedCount,
        composition,
      };
    });

    const created = createDiagnostic.immediate();
    notifyAdmins(
      req.user.id,
      'diagnostic_question_set_created',
      'Nova avaliação diagnóstica gerada',
      `${req.currentUser.name} gerou "${created.title}" com ${created.questionCount} questões.`,
      {
        question_set_id: created.id,
        creator_id: req.user.id,
        grade_id: created.grade.id,
        skill_count: created.composition.length,
        question_count: created.questionCount,
      }
    );
    logActivity({
      user: req.currentUser,
      action: 'create_diagnostic_question_set',
      module: 'question_bank',
      entityType: 'question_set',
      entityId: created.id,
      entityTitle: created.title,
      metadata: {
        grade_id: created.grade.id,
        skill_ids: created.composition.map(({ id }) => id),
        question_count: created.questionCount,
        questions_per_skill: created.questionsPerSkill,
        algorithm_version: 'balanced-v1',
        answer_key_methodology: 'balanced-answer-key-v1',
        reviewed_count: created.reviewedCount,
        editorial_pilot_count: created.composition.reduce((total, skill) => total + skill.editorialPilotCount, 0),
      },
      req,
    });
    return res.status(201).json({
      ...created,
      isPrivate: true,
      algorithmVersion: 'balanced-v1',
      requiresTeacherReview: true,
      methodology: 'balanced_by_skill_and_available_difficulty',
    });
  } catch (error) {
    if (error instanceof DiagnosticRequestError) {
      return res.status(error.status).json({ error: error.message, details: error.details });
    }
    return next(error);
  }
});

module.exports = router;
