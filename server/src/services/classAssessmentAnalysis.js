const { scoredResponses } = require('./numericAssessments');
const DEFAULT_THRESHOLDS = Object.freeze({
  consolidatedMin: 70,
  developingMin: 50,
  followUpBelow: 60,
});

const METHODOLOGY = 'classical_test_theory';
const RECOVERY_METHODOLOGY_VERSION = 'descriptive-v1';

function calculatePercentage(numerator, denominator) {
  if (!denominator) return null;
  return Number(((Number(numerator) * 100) / Number(denominator)).toFixed(2));
}

function classifySkillLevel(successRate, thresholds = DEFAULT_THRESHOLDS) {
  if (successRate === null || successRate === undefined) return 'no_data';
  if (successRate >= thresholds.consolidatedMin) return 'consolidated';
  if (successRate >= thresholds.developingMin) return 'developing';
  return 'below_expected';
}

function classifyEvidence({ submittedCount, questionCount, opportunityCount }) {
  if (!submittedCount || !questionCount || !opportunityCount) {
    return {
      level: 'insufficient',
      notice: 'Ainda não há respostas suficientes para orientar uma intervenção.',
    };
  }
  if (submittedCount < 5 || questionCount < 2) {
    return {
      level: 'limited',
      notice: 'Use como indício inicial e confirme com observação pedagógica ou nova atividade.',
    };
  }
  if (submittedCount < 15 || questionCount < 3) {
    return {
      level: 'moderate',
      notice: 'Há evidência descritiva para planejar uma intervenção, sem valor de diagnóstico definitivo.',
    };
  }
  return {
    level: 'broader',
    notice: 'A evidência cobre mais estudantes e itens, mas continua sendo descritiva e não equivale à TRI.',
  };
}

function loadParticipants(database, assignment) {
  return database.prepare(`
    SELECT
      participant.id AS participant_id,
      student.public_id AS student_public_id,
      student.display_name,
      participant.status AS participation_status,
      attempt.public_id AS attempt_public_id,
      attempt.status AS attempt_status,
      attempt.revision AS attempt_revision,
      attempt.answered_count,
      attempt.correct_count,
      attempt.question_count,
      attempt.score_percentage,
      attempt.submitted_at
    FROM class_assessment_participants participant
    JOIN students student ON student.id = participant.student_id
    LEFT JOIN class_assessment_attempts attempt
      ON attempt.participant_id = participant.id AND attempt.status <> 'voided'
    WHERE participant.assignment_id = ?
    ORDER BY student.display_name COLLATE NOCASE, student.public_id
  `).all(assignment.id).map((row) => ({
    id: row.student_public_id,
    displayName: row.display_name,
    participationStatus: row.participation_status,
    attemptId: row.attempt_public_id,
    attemptStatus: row.attempt_status || 'pending',
    attemptRevision: row.attempt_revision || 0,
    answeredCount: row.answered_count || 0,
    correctCount: row.correct_count,
    questionCount: row.question_count || assignment.question_count,
    percentage: row.score_percentage,
    submittedAt: row.submitted_at,
  }));
}

function loadQuestionResults(database, assignmentId) {
  // Filter before the LEFT JOIN so both response-view branches use their attempt
  // indexes instead of materializing every assessment's answers. Keep blank
  // responses in the denominator and items without submissions in the result.
  return database.prepare(`
    SELECT
      item.id,
      item.source_skill_id,
      item.question_code_snapshot,
      substr(item.statement_snapshot, 1, 240) AS statement_preview,
      item.skill_code_snapshot,
      item.skill_description_snapshot,
      item.sort_order,
      COUNT(response.id) AS response_count,
      SUM(CASE WHEN response.answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
      SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM class_assessment_items item
    LEFT JOIN (
      SELECT id, assessment_item_id, answered_at, is_correct
      FROM ${scoredResponses(database)}
      WHERE attempt_id IN (
        SELECT id FROM class_assessment_attempts
        WHERE assignment_id = ? AND status = 'submitted'
      )
    ) response ON response.assessment_item_id = item.id
    WHERE item.assignment_id = ?
    GROUP BY item.id
    ORDER BY item.sort_order, item.id
  `).all(assignmentId, assignmentId).map((row, index) => {
    const correctCount = Number(row.correct_count || 0);
    const responseCount = Number(row.response_count || 0);
    const successRate = calculatePercentage(correctCount, responseCount);
    return {
      id: row.id,
      sourceSkillId: row.source_skill_id,
      number: index + 1,
      code: row.question_code_snapshot,
      statement: row.statement_preview,
      skillCode: row.skill_code_snapshot,
      skillDescription: row.skill_description_snapshot,
      responseCount,
      answeredCount: Number(row.answered_count || 0),
      correctCount,
      successRate,
      errorRate: successRate === null ? null : Number((100 - successRate).toFixed(2)),
    };
  });
}

function aggregateSkills(questionRows, submittedCount, thresholds) {
  const skillsByCode = new Map();
  questionRows.forEach((question) => {
    const key = question.skillCode || 'SEM_HABILIDADE';
    const skill = skillsByCode.get(key) || {
      sourceSkillId: question.sourceSkillId,
      code: question.skillCode,
      description: question.skillDescription,
      questionCount: 0,
      opportunities: 0,
      correctCount: 0,
    };
    skill.questionCount += 1;
    skill.opportunities += question.responseCount;
    skill.correctCount += question.correctCount;
    skillsByCode.set(key, skill);
  });

  return [...skillsByCode.values()].map((skill) => {
    const successRate = calculatePercentage(skill.correctCount, skill.opportunities);
    return {
      ...skill,
      successRate,
      level: classifySkillLevel(successRate, thresholds),
      evidence: {
        submittedCount,
        questionCount: skill.questionCount,
        opportunityCount: skill.opportunities,
        ...classifyEvidence({
          submittedCount,
          questionCount: skill.questionCount,
          opportunityCount: skill.opportunities,
        }),
      },
    };
  }).sort((left, right) => (
    (left.successRate ?? Number.POSITIVE_INFINITY)
    - (right.successRate ?? Number.POSITIVE_INFINITY)
  ));
}

function summarizeParticipants(participants) {
  const eligible = participants.filter(p => p.participationStatus !== 'exempted');
  const submitted = eligible.filter(p => p.attemptStatus === 'submitted');
  return { participantCount: eligible.length, exemptedCount: participants.length - eligible.length,
    submittedCount: submitted.length, pendingCount: eligible.length - submitted.length,
    meanPercentage: submitted.length ? Number((submitted.reduce((sum, p) => sum + Number(p.percentage), 0) / submitted.length).toFixed(2)) : null };
}
// Period lists need only counts and scores, not names, answers or per-question analysis.
function loadAssessmentOverview(database, assignmentId) {
  const participants = database.prepare(`SELECT p.status AS participationStatus,
    a.status AS attemptStatus, a.score_percentage AS percentage
    FROM class_assessment_participants p JOIN students s ON s.id = p.student_id
    LEFT JOIN class_assessment_attempts a ON a.participant_id = p.id AND a.status <> 'voided'
    WHERE p.assignment_id = ? ORDER BY s.display_name COLLATE NOCASE, s.public_id`).all(assignmentId);
  return summarizeParticipants(participants);
}
function analyzeClassAssessment(database, assignment, thresholds = DEFAULT_THRESHOLDS) {
  const participants = loadParticipants(database, assignment);
  const eligibleParticipants = participants
    .filter(({ participationStatus }) => participationStatus !== 'exempted');
  const submitted = eligibleParticipants
    .filter(({ attemptStatus }) => attemptStatus === 'submitted');
  const questionRows = loadQuestionResults(database, assignment.id);
  const skills = aggregateSkills(questionRows, submitted.length, thresholds);
  const hardestQuestions = questionRows
    .filter(({ errorRate }) => errorRate !== null)
    .sort((left, right) => right.errorRate - left.errorRate || left.number - right.number)
    .slice(0, 10);
  const studentsNeedingFollowUp = submitted
    .filter(({ percentage: score }) => Number(score) < thresholds.followUpBelow)
    .sort((left, right) => left.percentage - right.percentage);

  return {
    assessment: {
      id: assignment.public_id,
      title: assignment.title_snapshot,
      status: assignment.status,
      revision: assignment.revision,
      questionCount: assignment.question_count,
      className: assignment.class_name,
    },
    overview: summarizeParticipants(participants),
    thresholds: { ...thresholds },
    participants,
    questions: questionRows.map(({ sourceSkillId: _sourceSkillId, ...question }) => question),
    hardestQuestions: hardestQuestions.map(({ sourceSkillId: _sourceSkillId, ...question }) => question),
    skills: skills.map(({ sourceSkillId: _sourceSkillId, ...skill }) => skill),
    studentsNeedingFollowUp,
    methodology: METHODOLOGY,
  };
}

module.exports = {
  DEFAULT_THRESHOLDS,
  METHODOLOGY,
  RECOVERY_METHODOLOGY_VERSION,
  calculatePercentage,
  classifyEvidence,
  classifySkillLevel,
  analyzeClassAssessment,
  loadAssessmentOverview,
  loadQuestionResults,
  aggregateSkills,
};
