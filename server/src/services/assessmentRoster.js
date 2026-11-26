// Reused by teacher and student entrypoints. Never repair a roster during a read.
const ineligibleRosterCountSql = `(
  SELECT COUNT(*) FROM class_assessment_participants roster
  JOIN students student ON student.id = roster.student_id
  JOIN school_class_enrollments enrollment ON enrollment.id = roster.enrollment_id
  WHERE roster.assignment_id = assignment.id
    AND roster.status <> 'exempted'
    AND (student.status <> 'active' OR enrollment.status <> 'active')
)`;

function assessmentRosterReady(database, assignmentId) {
  return Boolean(database.prepare(`
    SELECT 1 FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
    WHERE assignment.id = ? AND school_class.status = 'active'
      AND EXISTS (SELECT 1 FROM class_assessment_participants WHERE assignment_id = assignment.id AND status <> 'exempted')
      AND ${ineligibleRosterCountSql} = 0
  `).get(assignmentId));
}

const exemptedRosterCountSql = `(SELECT COUNT(*) FROM class_assessment_participants WHERE assignment_id=assignment.id AND status='exempted')`;
module.exports = { ineligibleRosterCountSql, exemptedRosterCountSql, assessmentRosterReady };
