const crypto = require('node:crypto');
const { eligibleMaterialSkill } = require('./materialSkillEligibility');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('./questionEditorialCuration');
const {
  DEFAULT_THRESHOLDS,
  RECOVERY_METHODOLOGY_VERSION,
  analyzeClassAssessment,
  calculatePercentage,
} = require('./classAssessmentAnalysis');

const REINFORCEMENT_QUESTION_TARGET = 3;
const MONITORING_QUESTION_TARGET = 2;
const MAX_CANDIDATES_PER_SKILL = REINFORCEMENT_QUESTION_TARGET + MONITORING_QUESTION_TARGET;
const DIFFICULTY_SEQUENCE = ['facil', 'media', 'dificil', 'media', 'facil'];

function buildRecoveryResultRevision(database, assignment) {
  const submittedAttempts = database.prepare(`
    SELECT
      attempt.public_id,
      attempt.revision,
      attempt.answered_count,
      attempt.correct_count,
      attempt.question_count,
      attempt.score_percentage,
      attempt.submitted_at
    FROM class_assessment_attempts attempt
    WHERE attempt.assignment_id = ? AND attempt.status = 'submitted'
    ORDER BY attempt.public_id COLLATE NOCASE, attempt.id
  `).all(assignment.id);
  return crypto.createHash('sha256').update(JSON.stringify({
    assessmentRevision: assignment.revision,
    submittedAttempts,
  }), 'utf8').digest('hex');
}

function placeholders(values) {
  return values.map(() => '?').join(', ');
}

function selectDiverseQuestions(candidates, limit = MAX_CANDIDATES_PER_SKILL) {
  const buckets = new Map([
    ['facil', candidates.filter(({ difficulty }) => difficulty === 'facil')],
    ['media', candidates.filter(({ difficulty }) => difficulty === 'media')],
    ['dificil', candidates.filter(({ difficulty }) => difficulty === 'dificil')],
  ]);
  const selected = [];
  for (let index = 0; index < limit; index += 1) {
    const preferred = DIFFICULTY_SEQUENCE[index % DIFFICULTY_SEQUENCE.length];
    let bucket = buckets.get(preferred);
    if (!bucket?.length) {
      bucket = [...buckets.values()].sort((left, right) => right.length - left.length)[0];
    }
    if (!bucket?.length) break;
    selected.push(bucket.shift());
  }
  return selected;
}

function splitQuestionPurpose(selected) {
  if (selected.length >= 4) {
    return {
      reinforcement: selected.slice(0, selected.length - MONITORING_QUESTION_TARGET),
      monitoring: selected.slice(-MONITORING_QUESTION_TARGET),
    };
  }
  if (selected.length >= 2) {
    return {
      reinforcement: selected.slice(0, selected.length - 1),
      monitoring: selected.slice(-1),
    };
  }
  return { reinforcement: selected, monitoring: [] };
}

function serializeQuestion(question) {
  return {
    id: question.id,
    code: question.question_code,
    statement: question.statement_preview,
    difficulty: question.difficulty,
    source: question.source,
    reviewed: question.reviewed === 1,
    hasImage: Boolean(question.image_path),
    requiresTeacherReview: question.reviewed !== 1,
  };
}

function loadQuestionCandidates(database, assignment, teacherId, skillId, {
  excludedQuestionIds = [], limit = MAX_CANDIDATES_PER_SKILL, pilotEnabled = false,
  purpose = 'catalog', pilotOnly = false,
} = {}) {
  const candidates = database.prepare(`
    SELECT
      question.id,
      question.question_code,
      substr(question.statement, 1, 240) AS statement_preview,
      question.difficulty,
      question.source,
      question.reviewed,
      question.image_path,
      editorial.family AS editorial_family
    FROM questions question
    LEFT JOIN question_editorial_curation editorial ON editorial.question_id = question.id
    WHERE question.skill_id = ?
      AND question.status = 'active'
      AND ${editorialEligibleSql('question', { pilotEnabled, purpose })}
      ${pilotOnly ? "AND editorial.state = 'pilot'" : ''}
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
      AND NOT EXISTS (
        SELECT 1 FROM class_assessment_items source_item
        WHERE source_item.assignment_id = ?
          AND (
            source_item.source_question_id = question.id
            OR source_item.question_code_snapshot = question.question_code
          )
      )
    ORDER BY
      question.reviewed DESC,
      CASE question.source WHEN 'official' THEN 0 ELSE 1 END,
      question.question_code COLLATE NOCASE,
      question.id
  `).all(skillId, teacherId, assignment.id);
  // Filter actual intervention resources before the display limit; otherwise a
  // usable question beyond the original five suggestions can disappear.
  const excluded = new Set(excludedQuestionIds);
  const legacy = [];
  const curated = [];
  const reservedFamilies = new Set();
  if (candidates.some(question => question.editorial_family)) {
    const excludedSql = excluded.size ? `OR editorial.question_id IN (${placeholders([...excluded])})` : '';
    for (const { family } of database.prepare(`
      SELECT editorial.family FROM question_editorial_curation editorial
      JOIN questions question ON question.id = editorial.question_id
      WHERE editorial.state = 'pilot' AND (
        EXISTS (SELECT 1 FROM class_assessment_items item
          WHERE item.assignment_id = ? AND (item.source_question_id = editorial.question_id
            OR item.question_code_snapshot = question.question_code))
        ${excludedSql}
      )
    `).all(assignment.id, ...excluded)) reservedFamilies.add(family);
  }
  for (const question of candidates) {
    if (excluded.has(question.id)) continue;
    if (!question.editorial_family) legacy.push(question);
    else if (!reservedFamilies.has(question.editorial_family)) {
      curated.push(question);
      reservedFamilies.add(question.editorial_family);
    }
  }
  const selectedCurated = selectDiverseQuestions(curated, limit);
  return selectedCurated.concat(selectDiverseQuestions(legacy, limit - selectedCurated.length)).map(serializeQuestion);
}

function loadExactMaterials(database, skillId) {
  return database.prepare(`
    SELECT
      material.id,
      material.title,
      substr(COALESCE(material.description, ''), 1, 240) AS description,
      material.file_format,
      material_type.name AS material_type,
      COUNT(access.id) AS access_count
    FROM material_bncc_skills mapping
    JOIN materials material ON material.id = mapping.material_id
    LEFT JOIN material_types material_type ON material_type.id = material.material_type_id
    LEFT JOIN access_history access ON access.material_id = material.id
      WHERE mapping.skill_id = ? AND ${eligibleMaterialSkill()}
    GROUP BY material.id
    ORDER BY access_count DESC, material.title COLLATE NOCASE, material.id
    LIMIT 3
  `).all(skillId).map((material) => ({
    id: material.id,
    title: material.title,
    description: material.description || null,
    format: material.file_format,
    type: material.material_type,
    accessCount: Number(material.access_count || 0),
    matchBasis: 'curated_bncc',
    requiresTeacherReview: false,
  }));
}

function loadDiscoveryMaterials(database, assignment, gradeId) {
  return database.prepare(`
    SELECT
      material.id,
      material.title,
      substr(COALESCE(material.description, ''), 1, 240) AS description,
      material.file_format,
      material_type.name AS material_type,
      COUNT(access.id) AS access_count
    FROM materials material
    LEFT JOIN material_types material_type ON material_type.id = material.material_type_id
    LEFT JOIN access_history access ON access.material_id = material.id
    WHERE material.grade_id = ?
      AND NOT EXISTS (
        SELECT 1 FROM material_bncc_skills mapping
        WHERE mapping.material_id = material.id
          AND ${eligibleMaterialSkill()}
      )
      AND (
        material.discipline_id IS NULL
        OR EXISTS (
          SELECT 1 FROM school_class_disciplines class_discipline
          WHERE class_discipline.class_id = ?
            AND class_discipline.owner_teacher_id = ?
            AND class_discipline.discipline_id = material.discipline_id
        )
      )
    GROUP BY material.id
    ORDER BY access_count DESC, material.title COLLATE NOCASE, material.id
    LIMIT 3
  `).all(gradeId, assignment.class_id, assignment.owner_teacher_id).map((material) => ({
    id: material.id,
    title: material.title,
    description: material.description || null,
    format: material.file_format,
    type: material.material_type,
    accessCount: Number(material.access_count || 0),
    matchBasis: 'same_grade_discovery',
    requiresTeacherReview: true,
  }));
}

const { scoredResponses } = require('./numericAssessments');
function loadStudentSkillPerformance(database, assignment, skillCode) {
  return database.prepare(`
    SELECT
      student.public_id,
      student.display_name,
      COUNT(response.id) AS opportunity_count,
      SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM class_assessment_participants participant
    JOIN students student ON student.id = participant.student_id
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
    ORDER BY
      (1.0 * SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) / COUNT(response.id)),
      student.display_name COLLATE NOCASE,
      student.public_id
  `).all(
    assignment.id,
    assignment.owner_teacher_id,
    skillCode
  ).map((student) => ({
    id: student.public_id,
    displayName: student.display_name,
    successRate: calculatePercentage(student.correct_count, student.opportunity_count),
    opportunityCount: Number(student.opportunity_count),
    evidenceLevel: Number(student.opportunity_count) < 3 ? 'limited' : 'moderate',
  }));
}

function loadSkillRecords(database, skillCodes) {
  if (!skillCodes.length) return new Map();
  return new Map(database.prepare(`
    SELECT skill.id, skill.code, skill.description, skill.grade_id, unit.name AS unit_name
    FROM bncc_skills skill
    LEFT JOIN bncc_units unit ON unit.id = skill.unit_id
    WHERE skill.code IN (${placeholders(skillCodes)})
  `).all(...skillCodes).map((skill) => [skill.code, skill]));
}

function existingRecoveryPlan(database, assignmentId) {
  const plan = database.prepare(`
    SELECT public_id, status, revision, title
    FROM learning_recovery_plans
    WHERE source_assignment_id = ?
  `).get(assignmentId);
  return plan ? {
    id: plan.public_id,
    status: plan.status,
    revision: plan.revision,
    title: plan.title,
  } : null;
}

function buildLearningRecoveryPreview(database, assignment, teacherId) {
  const analysis = analyzeClassAssessment(database, assignment);
  const pilotEnabled = isEditorialPilotEnabled(database, { id: teacherId, role: 'professor' });
  const levelOrder = { below_expected: 0, developing: 1 };
  const targetSkills = analysis.skills
    .filter((skill) => skill.code && Object.hasOwn(levelOrder, skill.level))
    .sort((left, right) => (
      levelOrder[left.level] - levelOrder[right.level]
      || left.successRate - right.successRate
      || left.code.localeCompare(right.code, 'pt-BR')
    ));
  const skillByCode = loadSkillRecords(database, targetSkills.map(({ code }) => code));
  const warnings = [];
  let priorityNumber = 0;

  const priorities = targetSkills.flatMap((skill) => {
    const sourceSkill = skillByCode.get(skill.code);
    if (!sourceSkill) {
      warnings.push(`A habilidade ${skill.code} permanece no resultado histórico, mas não está mais no cadastro BNCC atual.`);
      return [];
    }
    const legacy = splitQuestionPurpose(loadQuestionCandidates(database, assignment, teacherId, sourceSkill.id));
    const curatedQuestions = (purpose, limit, excludedQuestionIds = []) => pilotEnabled
      ? loadQuestionCandidates(database, assignment, teacherId, sourceSkill.id, {
        pilotEnabled, pilotOnly: true, purpose, limit, excludedQuestionIds,
      }) : [];
    const practice = curatedQuestions('practice', REINFORCEMENT_QUESTION_TARGET);
    const verification = curatedQuestions('verification', MONITORING_QUESTION_TARGET, practice.map(({ id }) => id));
    const reinforcement = practice.concat(legacy.reinforcement).slice(0, REINFORCEMENT_QUESTION_TARGET);
    const monitoring = verification.concat(legacy.monitoring).slice(0, MONITORING_QUESTION_TARGET);
    const materials = loadExactMaterials(database, sourceSkill.id);
    const discoveryMaterials = materials.length
      ? []
      : loadDiscoveryMaterials(database, assignment, sourceSkill.grade_id);
    const studentCandidates = loadStudentSkillPerformance(database, assignment, skill.code);
    const students = studentCandidates
      .filter(({ successRate }) => successRate < DEFAULT_THRESHOLDS.consolidatedMin);
    if (!materials.length) {
      warnings.push(`A habilidade ${skill.code} ainda não possui material com vínculo BNCC validado pela administração.`);
    }
    if (monitoring.length < MONITORING_QUESTION_TARGET) {
      warnings.push(`A habilidade ${skill.code} ainda não possui questões inéditas suficientes para uma verificação equilibrada.`);
    }

    priorityNumber += 1;
    return [{
      priority: priorityNumber,
      skill: {
        id: sourceSkill.id,
        code: skill.code,
        description: skill.description,
        unitName: sourceSkill.unit_name,
      },
      result: {
        successRate: skill.successRate,
        level: skill.level,
        questionCount: skill.questionCount,
        opportunityCount: skill.opportunities,
        evidence: skill.evidence,
      },
      reinforcementQuestions: reinforcement,
      materials,
      materialDiscoveryCandidates: discoveryMaterials,
      studentCandidates,
      suggestedGroup: students.length ? {
        title: `Reforço · ${skill.code}`,
        objective: `Retomar ${skill.description}`,
        temporary: true,
        requiresTeacherConfirmation: true,
        students,
      } : null,
      suggestedSequence: [
        {
          order: 1,
          type: 'guided_review',
          title: 'Retomada guiada',
          resourceIds: materials.map(({ id }) => id),
        },
        {
          order: 2,
          type: 'guided_practice',
          title: 'Prática orientada',
          questionIds: reinforcement.map(({ id }) => id),
        },
        {
          order: 3,
          type: 'formative_check',
          title: 'Verificação formativa',
          questionIds: monitoring.map(({ id }) => id),
        },
      ],
      monitoringQuestions: monitoring,
    }];
  });

  const monitoringCoverage = priorities.map((priority) => ({
    skillCode: priority.skill.code,
    available: priority.monitoringQuestions.length,
    recommended: MONITORING_QUESTION_TARGET,
  }));
  const monitoringQuestions = priorities.flatMap(({ skill, monitoringQuestions: questions }) => (
    questions.map((question) => ({ ...question, skillCode: skill.code }))
  ));

  return {
    source: {
      assessment: analysis.assessment,
      resultRevision: buildRecoveryResultRevision(database, assignment),
      overview: analysis.overview,
      thresholds: analysis.thresholds,
    },
    existingPlan: existingRecoveryPlan(database, assignment.id),
    methodology: {
      version: RECOVERY_METHODOLOGY_VERSION,
      basis: 'deterministic_descriptive_rules',
      usesTri: false,
      notice: 'Sugestões pedagógicas baseadas nos resultados desta aplicação. O professor deve revisar e confirmar antes de usar.',
    },
    isActionable: analysis.overview.submittedCount > 0 && priorities.length > 0,
    priorities,
    monitoringAssessment: {
      ready: priorities.length > 0
        && monitoringCoverage.every(({ available }) => available >= MONITORING_QUESTION_TARGET),
      requiresTeacherConfirmation: true,
      willCreateAutomatically: false,
      recommendedQuestionsPerSkill: MONITORING_QUESTION_TARGET,
      questionCount: monitoringQuestions.length,
      coverage: monitoringCoverage,
      questions: monitoringQuestions,
    },
    warnings: [...new Set(warnings)],
  };
}

module.exports = {
  REINFORCEMENT_QUESTION_TARGET,
  MONITORING_QUESTION_TARGET,
  selectDiverseQuestions,
  splitQuestionPurpose,
  loadQuestionCandidates,
  buildRecoveryResultRevision,
  loadStudentSkillPerformance,
  buildLearningRecoveryPreview,
};
