const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const { logActivity } = require('../helpers/activity');
const {
  digestAccessCode,
  generateAccessCode,
  normalizeAccessCode,
} = require('../services/studentAssessmentAccess');

const router = express.Router();
const RESULT_MODES = new Set(['hidden', 'score_after_submit', 'score_after_close']);

function requireProfessor(req, res, next) {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'Acesso restrito a professores.' });
  }
  return next();
}

function requireStudentAccessSecret(_req, res, next) {
  if (!config.studentAssessmentAccessSecret) {
    return res.status(503).json({ error: 'A aplicação on-line ainda não foi configurada neste ambiente.' });
  }
  return next();
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function ownedAssessment(classPublicId, assessmentPublicId, teacherId) {
  return db.prepare(`
    SELECT
      assignment.*,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class ON school_class.id = assignment.class_id
    WHERE school_class.public_id = ?
      AND assignment.public_id = ?
      AND assignment.owner_teacher_id = ?
      AND school_class.owner_teacher_id = ?
  `).get(classPublicId, assessmentPublicId, teacherId, teacherId);
}

function participantAccessRows(assignmentId) {
  return db.prepare(`
    SELECT
      participant.id AS participant_id,
      participant.status AS participant_status,
      student.id AS student_id,
      student.public_id AS student_public_id,
      student.display_name,
      credential.public_id AS credential_public_id,
      credential.code_hint,
      credential.status AS credential_status,
      credential.revision AS credential_revision,
      credential.access_count,
      credential.issued_at,
      credential.expires_at,
      credential.first_accessed_at,
      credential.last_accessed_at,
      attempt.status AS attempt_status,
      attempt.submission_channel
    FROM class_assessment_participants participant
    JOIN students student ON student.id = participant.student_id
    LEFT JOIN class_assessment_access_credentials credential
      ON credential.participant_id = participant.id
      AND credential.status IN ('active', 'used')
    LEFT JOIN class_assessment_attempts attempt
      ON attempt.participant_id = participant.id AND attempt.status <> 'voided'
    WHERE participant.assignment_id = ?
    ORDER BY student.display_name COLLATE NOCASE, student.public_id
  `).all(assignmentId);
}

function serializeAccess(assignment) {
  const now = Date.now();
  const participants = participantAccessRows(assignment.id).map((row) => ({
    id: row.student_public_id,
    displayName: row.display_name,
    participantStatus: row.participant_status,
    attemptStatus: row.attempt_status || 'pending',
    submissionChannel: row.submission_channel || null,
    credential: row.credential_public_id ? {
      id: row.credential_public_id,
      hint: row.code_hint,
      status: Date.parse(row.expires_at) <= now && row.credential_status === 'active'
        ? 'expired'
        : row.credential_status,
      revision: row.credential_revision,
      accessCount: row.access_count,
      issuedAt: row.issued_at,
      expiresAt: row.expires_at,
      firstAccessedAt: row.first_accessed_at,
      lastAccessedAt: row.last_accessed_at,
    } : null,
  }));
  return {
    assessment: {
      id: assignment.public_id,
      title: assignment.title_snapshot,
      status: assignment.status,
      revision: assignment.revision,
      className: assignment.class_name,
      opensAt: assignment.opens_at,
      closesAt: assignment.closes_at,
      timeLimitMinutes: assignment.time_limit_minutes,
      studentAccessEnabled: assignment.student_access_enabled === 1,
      studentResultMode: assignment.student_result_mode,
    },
    summary: {
      participantCount: participants.length,
      activeCredentialCount: participants.filter(({ credential }) => credential?.status === 'active').length,
      accessedCount: participants.filter(({ credential }) => Number(credential?.accessCount) > 0).length,
      submittedCount: participants.filter(({ attemptStatus }) => attemptStatus === 'submitted').length,
    },
    participants,
  };
}

function accessExpiration(assignment) {
  const now = Date.now();
  const defaultExpiration = now + 30 * 24 * 60 * 60 * 1000;
  const closeGrace = assignment.closes_at
    ? Date.parse(assignment.closes_at) + 7 * 24 * 60 * 60 * 1000
    : defaultExpiration;
  const maximum = now + 90 * 24 * 60 * 60 * 1000;
  return new Date(Math.min(Math.max(closeGrace, now + 24 * 60 * 60 * 1000), maximum)).toISOString();
}

function uniqueCredentialCode() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const code = generateAccessCode();
    const digest = digestAccessCode(code);
    const existing = db.prepare(`
      SELECT 1 FROM class_assessment_access_credentials WHERE code_digest = ?
    `).get(digest);
    if (!existing) return { code, digest, hint: normalizeAccessCode(code).slice(-4) };
  }
  throw new Error('credential_generation_failed');
}

router.use(
  '/:classPublicId/assessments/:assessmentPublicId/student-access',
  authenticate,
  requireProfessor,
  requireFeatureFlag('classes.core'),
  requireFeatureFlag('classes.assessment_assignments'),
  requireFeatureFlag('classes.assessment_delivery'),
  requireFeatureFlag('classes.student_assessment_portal'),
  requireStudentAccessSecret
);

router.get('/:classPublicId/assessments/:assessmentPublicId/student-access', (req, res) => {
  const assignment = ownedAssessment(
    req.params.classPublicId,
    req.params.assessmentPublicId,
    req.user.id
  );
  if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
  res.setHeader('Cache-Control', 'no-store');
  return res.json(serializeAccess(assignment));
});

router.patch('/:classPublicId/assessments/:assessmentPublicId/student-access', (req, res, next) => {
  try {
    const assignment = ownedAssessment(
      req.params.classPublicId,
      req.params.assessmentPublicId,
      req.user.id
    );
    if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
    if (assignment.status === 'cancelled') {
      return res.status(409).json({ error: 'Uma aplicação cancelada não aceita acessos.' });
    }
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) return res.status(400).json({ error: 'Informe a revisão atual da aplicação.' });
    const enabled = req.body?.enabled === true ? 1 : req.body?.enabled === false ? 0 : null;
    if (enabled === null) return res.status(400).json({ error: 'Informe se o acesso ficará habilitado.' });
    if (enabled === 1 && !['scheduled', 'open'].includes(assignment.status)) {
      return res.status(409).json({ error: 'Agende ou abra a aplicação antes de habilitar o acesso.' });
    }
    const resultMode = String(req.body?.resultMode || assignment.student_result_mode);
    if (!RESULT_MODES.has(resultMode)) {
      return res.status(400).json({ error: 'Política de resultado inválida.' });
    }
    if (['open', 'closed'].includes(assignment.status) && resultMode !== assignment.student_result_mode) {
      return res.status(409).json({ error: 'A política de resultado não pode mudar depois da abertura.' });
    }

    const update = db.prepare(`
      UPDATE class_assessment_assignments
      SET student_access_enabled = ?, student_result_mode = ?, updated_by = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_teacher_id = ? AND revision = ?
    `).run(enabled, resultMode, req.user.id, assignment.id, req.user.id, expectedRevision);
    if (update.changes !== 1) {
      return res.status(409).json({ error: 'A aplicação mudou em outro acesso. Atualize e tente novamente.' });
    }
    const updated = ownedAssessment(
      req.params.classPublicId,
      req.params.assessmentPublicId,
      req.user.id
    );
    logActivity({
      user: req.user,
      action: enabled ? 'enable_student_assessment_access' : 'disable_student_assessment_access',
      module: 'classes',
      entityType: 'class_assessment',
      entityId: assignment.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        result_mode: resultMode,
      },
      isCritical: enabled === 0,
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json(serializeAccess(updated));
  } catch (error) {
    return next(error);
  }
});

router.post('/:classPublicId/assessments/:assessmentPublicId/student-access/credentials', (req, res, next) => {
  try {
    const assignment = ownedAssessment(
      req.params.classPublicId,
      req.params.assessmentPublicId,
      req.user.id
    );
    if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
    if (!['scheduled', 'open'].includes(assignment.status)) {
      return res.status(409).json({ error: 'Agende ou abra a aplicação antes de gerar os acessos.' });
    }
    if (req.body?.confirmation !== 'GERAR_ACESSOS') {
      return res.status(400).json({ error: 'Confirme explicitamente a geração dos acessos.' });
    }
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) return res.status(400).json({ error: 'Informe a revisão atual da aplicação.' });
    const requestedIds = req.body?.participantIds === undefined
      ? null
      : [...new Set((Array.isArray(req.body.participantIds) ? req.body.participantIds : [])
        .map((value) => String(value || '').trim())
        .filter(Boolean))];
    if (requestedIds && requestedIds.length === 0) {
      return res.status(400).json({ error: 'Selecione ao menos um estudante.' });
    }

    const generate = db.transaction(() => {
      const current = ownedAssessment(
        req.params.classPublicId,
        req.params.assessmentPublicId,
        req.user.id
      );
      if (!current || current.revision !== expectedRevision) {
        throw Object.assign(new Error('revision_conflict'), { status: 409 });
      }
      const allParticipants = participantAccessRows(current.id);
      const selected = requestedIds
        ? allParticipants.filter(({ student_public_id: id }) => requestedIds.includes(id))
        : allParticipants;
      if (requestedIds && selected.length !== requestedIds.length) {
        throw Object.assign(new Error('invalid_participants'), { status: 400 });
      }

      const generated = [];
      const skipped = [];
      const expiresAt = accessExpiration(current);
      const now = new Date().toISOString();
      for (const participant of selected) {
        if (participant.participant_status === 'exempted' || participant.attempt_status === 'submitted') {
          skipped.push({ id: participant.student_public_id, reason: 'already_finished' });
          continue;
        }
        if (participant.attempt_status === 'draft' && participant.submission_channel === 'teacher_entry') {
          skipped.push({ id: participant.student_public_id, reason: 'teacher_entry_in_progress' });
          continue;
        }
        db.prepare(`
          UPDATE class_assessment_access_credentials
          SET status = 'revoked', revoked_at = ?, updated_by = ?,
              revision = revision + 1, updated_at = CURRENT_TIMESTAMP
          WHERE participant_id = ? AND status = 'active'
        `).run(now, req.user.id, participant.participant_id);

        const access = uniqueCredentialCode();
        db.prepare(`
          INSERT INTO class_assessment_access_credentials (
            public_id, participant_id, assignment_id, class_id, student_id,
            owner_teacher_id, code_digest, code_hint, issued_at, expires_at,
            created_by, updated_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          uuidv4(),
          participant.participant_id,
          current.id,
          current.class_id,
          participant.student_id,
          req.user.id,
          access.digest,
          access.hint,
          now,
          expiresAt,
          req.user.id,
          req.user.id
        );
        generated.push({
          id: participant.student_public_id,
          displayName: participant.display_name,
          code: access.code,
          expiresAt,
        });
      }

      const update = db.prepare(`
        UPDATE class_assessment_assignments
        SET student_access_enabled = 1, updated_by = ?,
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_teacher_id = ? AND revision = ?
      `).run(req.user.id, current.id, req.user.id, expectedRevision);
      if (update.changes !== 1) throw Object.assign(new Error('revision_conflict'), { status: 409 });
      return { generated, skipped };
    });

    let outcome;
    try {
      outcome = generate.immediate();
    } catch (error) {
      if (error.message === 'revision_conflict') {
        return res.status(409).json({ error: 'A aplicação mudou em outro acesso. Atualize e tente novamente.' });
      }
      if (error.message === 'invalid_participants') {
        return res.status(400).json({ error: 'Um ou mais estudantes não pertencem a esta aplicação.' });
      }
      throw error;
    }
    const updated = ownedAssessment(
      req.params.classPublicId,
      req.params.assessmentPublicId,
      req.user.id
    );
    logActivity({
      user: req.user,
      action: 'generate_student_assessment_credentials',
      module: 'classes',
      entityType: 'class_assessment',
      entityId: assignment.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        generated_count: outcome.generated.length,
        skipped_count: outcome.skipped.length,
      },
      isCritical: true,
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(201).json({
      ...outcome,
      access: serializeAccess(updated),
      warning: 'Os códigos são exibidos somente agora. Imprima ou distribua-os antes de fechar.',
    });
  } catch (error) {
    return next(error);
  }
});

router.post('/:classPublicId/assessments/:assessmentPublicId/student-access/participants/:studentPublicId/revoke', (req, res, next) => {
  try {
    const assignment = ownedAssessment(
      req.params.classPublicId,
      req.params.assessmentPublicId,
      req.user.id
    );
    if (!assignment) return res.status(404).json({ error: 'Aplicação não encontrada.' });
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) return res.status(400).json({ error: 'Informe a revisão atual do acesso.' });
    const credential = db.prepare(`
      SELECT credential.*
      FROM class_assessment_access_credentials credential
      JOIN students student ON student.id = credential.student_id
      WHERE credential.assignment_id = ?
        AND credential.owner_teacher_id = ?
        AND student.public_id = ?
        AND credential.status IN ('active', 'used')
      ORDER BY credential.id DESC LIMIT 1
    `).get(assignment.id, req.user.id, req.params.studentPublicId);
    if (!credential) return res.status(404).json({ error: 'Acesso ativo não encontrado.' });
    const now = new Date().toISOString();
    const update = db.prepare(`
      UPDATE class_assessment_access_credentials
      SET status = 'revoked', revoked_at = ?, updated_by = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ? AND status IN ('active', 'used')
    `).run(now, req.user.id, credential.id, expectedRevision);
    if (update.changes !== 1) {
      return res.status(409).json({ error: 'O acesso mudou em outro dispositivo. Atualize e tente novamente.' });
    }
    logActivity({
      user: req.user,
      action: 'revoke_student_assessment_credential',
      module: 'classes',
      entityType: 'class_assessment_access',
      entityId: credential.id,
      entityTitle: assignment.title_snapshot,
      metadata: {
        class_id: assignment.class_public_id,
        assessment_id: assignment.public_id,
        student_id: req.params.studentPublicId,
      },
      isCritical: true,
      req,
    });
    res.setHeader('Cache-Control', 'no-store');
    return res.json({ success: true });
  } catch (error) {
    return next(error);
  }
});

module.exports = router;
