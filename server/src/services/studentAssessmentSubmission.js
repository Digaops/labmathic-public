const { scoredResponses } = require('./numericAssessments');
function percentage(numerator, denominator) {
  if (!denominator) return null;
  return Number(((Number(numerator) * 100) / Number(denominator)).toFixed(2));
}

function currentAttempt(db, attemptId) {
  return db.prepare('SELECT * FROM class_assessment_attempts WHERE id = ?').get(attemptId);
}

function finalizeStudentOnlineAttempt(db, attempt, now = new Date().toISOString()) {
  if (!attempt || attempt.status !== 'draft' || attempt.submission_channel !== 'student_online') {
    return attempt;
  }
  const score = db.prepare(`
    SELECT
      SUM(CASE WHEN answered_at IS NOT NULL THEN 1 ELSE 0 END) AS answered_count,
      SUM(CASE WHEN is_correct = 1 THEN 1 ELSE 0 END) AS correct_count
    FROM ${scoredResponses(db)}
    WHERE attempt_id = ?
  `).get(attempt.id);
  const answeredCount = Number(score.answered_count || 0);
  const correctCount = Number(score.correct_count || 0);
  const update = db.prepare(`
    UPDATE class_assessment_attempts
    SET status = 'submitted', answered_count = ?, correct_count = ?,
        score_percentage = ?, submitted_at = ?, updated_by = NULL,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'draft' AND submission_channel = 'student_online'
      AND revision = ?
  `).run(
    answeredCount,
    correctCount,
    percentage(correctCount, attempt.question_count),
    now,
    attempt.id,
    attempt.revision
  );
  if (update.changes !== 1) {
    throw Object.assign(new Error('revision_conflict'), { status: 409 });
  }
  db.prepare(`
    UPDATE class_assessment_participants
    SET status = 'submitted', submitted_at = ?, updated_by = NULL,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status IN ('assigned', 'in_progress')
  `).run(now, attempt.participant_id);
  db.prepare(`
    UPDATE class_assessment_access_credentials
    SET status = 'used', used_at = ?, revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE participant_id = ? AND status = 'active'
  `).run(now, attempt.participant_id);
  return currentAttempt(db, attempt.id);
}

function pendingStudentOnlineAttempts(db, assignmentId, { expiredOnly = false } = {}) {
  return db.prepare(`
    SELECT
      attempt.*,
      student.public_id AS student_public_id
    FROM class_assessment_attempts attempt
    JOIN class_assessment_assignments assignment ON assignment.id = attempt.assignment_id
    JOIN students student ON student.id = attempt.student_id
    WHERE attempt.assignment_id = ?
      AND attempt.status = 'draft'
      AND attempt.submission_channel = 'student_online'
      ${expiredOnly ? `AND (
        assignment.status = 'closed'
        OR (assignment.closes_at IS NOT NULL
          AND julianday(assignment.closes_at) <= julianday(?))
        OR (assignment.time_limit_minutes IS NOT NULL
          AND julianday(attempt.started_at, '+' || assignment.time_limit_minutes || ' minutes') <= julianday(?))
      )` : ''}
    ORDER BY attempt.id
  `).all(...(expiredOnly
    ? [assignmentId, new Date().toISOString(), new Date().toISOString()]
    : [assignmentId]));
}

function finalizePendingStudentOnlineAttempts(db, assignmentId, options = {}) {
  const now = new Date().toISOString();
  return pendingStudentOnlineAttempts(db, assignmentId, options).map((attempt) => ({
    attempt: finalizeStudentOnlineAttempt(db, attempt, now),
    studentPublicId: attempt.student_public_id,
  }));
}

module.exports = {
  finalizePendingStudentOnlineAttempts,
  finalizeStudentOnlineAttempt,
};
