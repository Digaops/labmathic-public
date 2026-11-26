const { createHash, randomUUID } = require('node:crypto');
const { logActivityStrict } = require('../helpers/activity');
const { evaluateFeatureFlag } = require('./featureFlags');
const { summarizeFeedbackProgress } = require('./studentFeedbackProgress');

const FLAG = 'classes.student_feedback_release';
const KEY_PATTERN = /^[A-Za-z0-9._:-]{16,100}$/;
const CONTROL_CHARS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

class StudentAssessmentFeedbackError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

function fail(status, code, message) {
  throw new StudentAssessmentFeedbackError(status, code, message);
}

function hash(value) {
  return createHash('sha256').update(value).digest('hex');
}

function positiveInteger(value, label) {
  const parsed = value;
  if (!Number.isSafeInteger(parsed) || parsed < 1) fail(400, 'invalid_request', `${label} inválida.`);
  return parsed;
}

function normalizeMessage(value) {
  if (typeof value !== 'string') fail(400, 'invalid_message', 'Escreva uma orientação para o estudante.');
  const normalized = value.trim().replace(/\r\n?/g, '\n');
  if (normalized.length < 10 || normalized.length > 2000 || CONTROL_CHARS.test(normalized)) {
    fail(400, 'invalid_message', 'A devolutiva deve ter entre 10 e 2.000 caracteres e não pode conter caracteres invisíveis.');
  }
  return normalized;
}

function validateBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
    || Object.keys(body).some(key => !['message', 'confirmed', 'expectedRevision'].includes(key))) {
    fail(400, 'invalid_request', 'Confira os dados da devolutiva.');
  }
  if (body.confirmed !== true) fail(400, 'confirmation_required', 'Confirme que a mensagem é somente para este estudante.');
  return {
    message: normalizeMessage(body.message),
    expectedRevision: positiveInteger(body.expectedRevision, 'A revisão da tentativa'),
  };
}

function currentActor(database, actor) {
  const current = database.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(actor?.id || 0);
  if (!current || current.role !== 'professor') fail(403, 'access_denied', 'Somente o professor responsável pode enviar a devolutiva.');
  const feature = evaluateFeatureFlag(database, FLAG, current);
  if (!feature.enabled) fail(404, 'feature_disabled', 'Esta funcionalidade ainda não está disponível para sua conta.');
  return current;
}

function operation(database, actor, key, input, execute) {
  if (typeof key !== 'string' || !KEY_PATTERN.test(key.trim())) {
    fail(400, 'invalid_key', 'Atualize a página antes de enviar a devolutiva.');
  }
  const keyHash = hash(key.trim());
  const requestHash = hash(JSON.stringify(input));
  const previous = database.prepare(`
    SELECT request_hash, receipt_json
    FROM student_assessment_feedback_operations
    WHERE actor_id=? AND key_hash=?
  `).get(actor.id, keyHash);
  if (previous) {
    if (previous.request_hash !== requestHash) {
      fail(409, 'operation_conflict', 'Este envio já foi usado com outro texto. Confira o resultado antes de tentar novamente.');
    }
    return { ...JSON.parse(previous.receipt_json), created: false, replayed: true };
  }
  const receipt = execute();
  const feedbackId = database.prepare(
    'SELECT id FROM student_assessment_feedback WHERE public_id=?'
  ).pluck().get(receipt.feedback.id);
  database.prepare(`
    INSERT INTO student_assessment_feedback_operations(actor_id,key_hash,request_hash,feedback_id,receipt_json)
    VALUES (?,?,?,?,?)
  `).run(actor.id, keyHash, requestHash, feedbackId, JSON.stringify(receipt));
  return receipt;
}

function releaseStudentFeedback(database, {
  actor,
  classPublicId,
  assessmentPublicId,
  studentPublicId,
  body,
  idempotencyKey,
  req,
  audit = logActivityStrict,
}) {
  return database.transaction(() => {
    const teacher = currentActor(database, actor);
    const input = validateBody(body);
    return operation(database, teacher, idempotencyKey, {
      classPublicId,
      assessmentPublicId,
      studentPublicId,
      message: input.message,
      expectedRevision: input.expectedRevision,
      confirmed: true,
    }, () => {
      const context = database.prepare(`
        SELECT
          assignment.id AS assignment_id, assignment.public_id AS assessment_public_id,
          assignment.status AS assessment_status, assignment.title_snapshot,
          assignment.revision AS assignment_revision,
          class.id AS class_id, class.public_id AS class_public_id,
          participant.id AS participant_id, participant.revision AS participant_revision,
          participant.student_id, student.public_id AS student_public_id,
          attempt.id AS attempt_id, attempt.public_id AS attempt_public_id,
          attempt.revision AS attempt_revision, attempt.status AS attempt_status
        FROM class_assessment_assignments assignment
        JOIN school_classes class
          ON class.id=assignment.class_id AND class.owner_teacher_id=assignment.owner_teacher_id
        JOIN class_assessment_participants participant
          ON participant.assignment_id=assignment.id
          AND participant.class_id=assignment.class_id
          AND participant.owner_teacher_id=assignment.owner_teacher_id
        JOIN students student
          ON student.id=participant.student_id AND student.owner_teacher_id=participant.owner_teacher_id
        LEFT JOIN class_assessment_attempts attempt
          ON attempt.participant_id=participant.id AND attempt.status <> 'voided'
        WHERE class.public_id=? AND assignment.public_id=?
          AND assignment.owner_teacher_id=? AND class.owner_teacher_id=?
          AND student.public_id=?
        ORDER BY attempt.attempt_number DESC
        LIMIT 1
      `).get(classPublicId, assessmentPublicId, teacher.id, teacher.id, studentPublicId);
      if (!context) fail(404, 'assessment_missing', 'Aplicação ou estudante não encontrado.');
      if (context.assessment_status !== 'closed') {
        fail(409, 'assessment_not_closed', 'Encerre a aplicação antes de liberar uma devolutiva.');
      }
      if (context.attempt_status !== 'submitted') {
        fail(409, 'attempt_not_submitted', 'A devolutiva só pode ser liberada depois que o estudante entregar a avaliação.');
      }
      if (context.attempt_revision !== input.expectedRevision) {
        fail(409, 'revision_conflict', 'O resultado mudou. Atualize a correção antes de enviar a devolutiva.');
      }
      const existing = database.prepare(`
        SELECT public_id FROM student_assessment_feedback
        WHERE assignment_id=? AND participant_id=?
      `).get(context.assignment_id, context.participant_id);
      if (existing) fail(409, 'already_released', 'Esta devolutiva já foi liberada e não pode ser substituída nesta versão.');

      const publicId = randomUUID();
      const row = database.prepare(`
        INSERT INTO student_assessment_feedback(
          public_id, assignment_id, participant_id, class_id, student_id,
          owner_teacher_id, message, created_by
        ) VALUES (?,?,?,?,?,?,?,?)
      `).run(
        publicId, context.assignment_id, context.participant_id, context.class_id,
        context.student_id, teacher.id, input.message, teacher.id,
      );
      const feedback = database.prepare(`
        SELECT public_id, message, released_at, revision
        FROM student_assessment_feedback WHERE id=?
      `).get(row.lastInsertRowid);
      database.prepare(`
        INSERT INTO student_assessment_feedback_events(feedback_id,actor_id,action,revision)
        VALUES (? ,?,'released',1)
      `).run(row.lastInsertRowid, teacher.id);
      audit({
        user: teacher,
        action: 'student_assessment_feedback_released',
        module: 'classes',
        entityType: 'student_assessment_feedback',
        entityId: row.lastInsertRowid,
        entityTitle: context.title_snapshot,
        description: 'Uma orientação pedagógica foi liberada para um estudante após a entrega da avaliação.',
        metadata: {
          classId: context.class_public_id,
          assessmentId: context.assessment_public_id,
          studentId: context.student_public_id,
          feedbackId: feedback.public_id,
          attemptId: context.attempt_public_id,
          revision: feedback.revision,
        },
        req,
      }, database);
      return { created: true, replayed: false, feedback: {
        id: feedback.public_id,
        message: feedback.message,
        releasedAt: feedback.released_at,
        revision: feedback.revision,
      } };
    });
  }).immediate();
}

function releasedFeedback(database, context) {
  if (!context || context.assignment_status !== 'closed') return null;
  const row = database.prepare(`
    SELECT feedback.message, feedback.released_at, owner.id AS owner_id, owner.role AS owner_role
    FROM student_assessment_feedback feedback
    JOIN class_assessment_assignments assignment ON assignment.id=feedback.assignment_id
      AND assignment.owner_teacher_id=feedback.owner_teacher_id
    JOIN users owner ON owner.id=feedback.owner_teacher_id
    WHERE feedback.assignment_id=? AND feedback.participant_id=? AND assignment.status='closed'
      AND EXISTS (SELECT 1 FROM class_assessment_attempts attempt
        WHERE attempt.participant_id=feedback.participant_id AND attempt.status='submitted')
  `).get(context.assignment_id, context.participant_id);
  if (!row || row.owner_role !== 'professor'
    || !evaluateFeatureFlag(database, FLAG, { id: row.owner_id, role: row.owner_role }).enabled) return null;
  return { message: row.message, releasedAt: row.released_at };
}

// Teacher-only delivery progress. Never load message bodies for the class list,
// and never add these fields to shared school/municipal analysis read models.
function withFeedbackProgress(database, actor, assignment, summary) {
  const teacher = database.prepare('SELECT id, role FROM users WHERE id=?').get(actor?.id || 0);
  if (!teacher || teacher.role !== 'professor'
    || !evaluateFeatureFlag(database, FLAG, teacher).enabled) return summary;
  const owned = database.prepare(`
    SELECT assignment.id FROM class_assessment_assignments assignment
    JOIN school_classes class ON class.id=assignment.class_id
    WHERE assignment.id=? AND assignment.status='closed'
      AND assignment.owner_teacher_id=? AND class.owner_teacher_id=?
  `).get(assignment.id, teacher.id, teacher.id);
  if (!owned) return summary;

  const released = new Set(database.prepare(`
    SELECT student.public_id FROM student_assessment_feedback feedback
    JOIN class_assessment_participants participant ON participant.id=feedback.participant_id
      AND participant.assignment_id=feedback.assignment_id
      AND participant.owner_teacher_id=feedback.owner_teacher_id
    JOIN students student ON student.id=participant.student_id
    WHERE feedback.assignment_id=? AND feedback.owner_teacher_id=?
  `).all(owned.id, teacher.id).map(row => row.public_id));
  return summarizeFeedbackProgress(summary, released);
}

module.exports = {
  FLAG,
  StudentAssessmentFeedbackError,
  releaseStudentFeedback,
  releasedFeedback,
  withFeedbackProgress,
};
