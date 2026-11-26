const { calculatePercentage, classifyEvidence, classifySkillLevel } = require('./classAssessmentAnalysis');
const { scoredResponses } = require('./numericAssessments');

const METHODOLOGY = 'matched-students-v2';

// Read only immutable assessment snapshots/responses, never today's question bank.
// IDs remain internal: the cycle/feedback receives counts, not student identities.
function loadSkillResults(database, assignmentId, teacherId, classId) {
  return database.prepare(`
    SELECT participant.student_id, item.skill_code_snapshot AS code,
      COUNT(item.id) AS question_count, COUNT(response.id) AS opportunities,
      SUM(CASE WHEN response.is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
      AND school_class.owner_teacher_id = assignment.owner_teacher_id
    JOIN class_assessment_participants participant ON participant.assignment_id = assignment.id
      AND participant.status <> 'exempted'
    JOIN class_assessment_attempts attempt ON attempt.participant_id = participant.id
      AND attempt.assignment_id = assignment.id AND attempt.status = 'submitted'
    JOIN class_assessment_items item ON item.assignment_id = assignment.id
    LEFT JOIN ${scoredResponses(database)} response ON response.attempt_id = attempt.id
      AND response.assessment_item_id = item.id AND response.assignment_id = assignment.id
    WHERE assignment.id = ? AND assignment.owner_teacher_id = ? AND assignment.class_id = ?
      AND assignment.status = 'closed' AND item.skill_code_snapshot IS NOT NULL
    GROUP BY participant.student_id, item.skill_code_snapshot
    ORDER BY participant.student_id, item.skill_code_snapshot
  `).all(assignmentId, teacherId, classId);
}

function completeRows(rows, code) {
  return rows.filter(row => row.code === code && row.question_count > 0
    && row.opportunities === row.question_count);
}

function totals(rows) {
  const opportunities = rows.reduce((sum, row) => sum + row.opportunities, 0);
  return {
    rate: calculatePercentage(rows.reduce((sum, row) => sum + row.correct_count, 0), opportunities),
    opportunities,
    questionCount: rows[0]?.question_count || 0,
  };
}

function buildMatchedRecoveryComparison(database, { teacherId, classId, sourceAssignmentId,
  monitoringAssignmentId, baselineSkills }) {
  const assignments = database.prepare(`
    SELECT assignment.id, assignment.status FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
      AND school_class.owner_teacher_id = assignment.owner_teacher_id
    WHERE assignment.id IN (?, ?) AND assignment.owner_teacher_id = ? AND assignment.class_id = ?
  `).all(sourceAssignmentId, monitoringAssignmentId, teacherId, classId);
  const available = sourceAssignmentId !== monitoringAssignmentId && assignments.length === 2
    && assignments.every(assignment => assignment.status === 'closed');
  const diagnostic = available ? loadSkillResults(database, sourceAssignmentId, teacherId, classId) : [];
  const monitoring = available ? loadSkillResults(database, monitoringAssignmentId, teacherId, classId) : [];
  return {
    methodology: METHODOLOGY,
    usesTri: false,
    notice: 'A comparação usa os mesmos estudantes nas duas etapas, por habilidade. As questões são diferentes: a diferença de acertos, sozinha, não prova que o apoio causou a mudança.',
    skills: baselineSkills.map(baseline => {
      const before = completeRows(diagnostic, baseline.skill_code_snapshot);
      const after = completeRows(monitoring, baseline.skill_code_snapshot);
      const afterIds = new Set(after.map(row => row.student_id));
      const pairedBefore = before.filter(row => afterIds.has(row.student_id));
      const pairedIds = new Set(pairedBefore.map(row => row.student_id));
      const pairedAfter = after.filter(row => pairedIds.has(row.student_id));
      const first = totals(pairedBefore), last = totals(pairedAfter);
      const studentCount = pairedIds.size;
      const delta = studentCount ? Number((last.rate - first.rate).toFixed(2)) : null;
      const evidence = {
        submittedCount: studentCount,
        questionCount: Math.min(first.questionCount, last.questionCount),
        opportunityCount: Math.min(first.opportunities, last.opportunities),
      };
      return {
        code: baseline.skill_code_snapshot,
        description: baseline.skill_description_snapshot,
        diagnosticRate: first.rate,
        monitoringRate: last.rate,
        diagnosticOpportunities: first.opportunities,
        monitoringOpportunities: last.opportunities,
        diagnosticQuestionCount: first.questionCount,
        monitoringQuestionCount: last.questionCount,
        cohort: {
          status: !available ? 'source_unavailable' : studentCount ? 'matched' : 'no_common_results',
          studentCount,
          diagnosticStudentCount: before.length,
          monitoringStudentCount: after.length,
          excludedDiagnosticCount: before.length - studentCount,
          excludedMonitoringCount: after.length - studentCount,
        },
        // Historical context is additive and is never used as the paired baseline.
        diagnosticSnapshot: {
          rate: Number(baseline.success_rate_snapshot),
          opportunities: Number(baseline.opportunity_count),
        },
        delta,
        trajectory: delta === null ? 'no_data' : delta >= 10 ? 'improved' : delta <= -10 ? 'declined' : 'stable',
        level: classifySkillLevel(last.rate),
        evidence: { ...evidence, ...classifyEvidence(evidence) },
      };
    }),
  };
}

module.exports = { METHODOLOGY, buildMatchedRecoveryComparison };
