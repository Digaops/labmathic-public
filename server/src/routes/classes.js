const crypto = require('crypto');
const express = require('express');
const multer = require('multer');
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const config = require('../config');
const { authenticate } = require('../middleware/auth');
const { requireFeatureFlag } = require('../middleware/featureFlag');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const { logActivity } = require('../helpers/activity');
const {
  parseStudentSpreadsheet,
  validateSubmittedRows,
} = require('../services/studentImport');
const {
  listLearningRecoveryPlans,
  recoveryPlanCounts,
} = require('../services/learningRecoveryPlans');

const router = express.Router();
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 1024 * 1024, fields: 0, parts: 2 },
  fileFilter: (_req, file, callback) => {
    const allowed = /\.(csv|xlsx)$/i.test(file.originalname || '');
    callback(allowed ? null : new Error('unsupported_spreadsheet'), allowed);
  },
});
const MAX_CONCURRENT_SPREADSHEET_PREVIEWS = 2;
let activeSpreadsheetPreviews = 0;
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const VALID_CLASS_STATUSES = new Set(['active', 'archived']);

function cleanText(value, maxLength) {
  const raw = String(value ?? '');
  if (/[\u0000-\u001F\u007F]/.test(raw)) return null;
  const text = raw.replace(/\s+/g, ' ').trim();
  return text && text.length <= maxLength ? text : null;
}

function optionalText(value, maxLength) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return { value: null };
  }
  const cleaned = cleanText(value, maxLength);
  return cleaned ? { value: cleaned } : { error: true };
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requireProfessor(req, res, next) {
  if (req.user.role !== 'professor') {
    return res.status(403).json({ error: 'A gestão de turmas é exclusiva para professores.' });
  }
  return next();
}

function ownedClass(publicId, ownerId) {
  return db.prepare(`
    SELECT sc.*, g.name AS grade_name
    FROM school_classes sc
    JOIN grades g ON g.id = sc.grade_id
    WHERE sc.public_id = ? AND sc.owner_teacher_id = ?
  `).get(publicId, ownerId);
}

function classDisciplines(classId) {
  return db.prepare(`
    SELECT d.id, d.name
    FROM school_class_disciplines scd
    JOIN disciplines d ON d.id = scd.discipline_id
    WHERE scd.class_id = ?
    ORDER BY d.name COLLATE NOCASE
  `).all(classId);
}

function serializeClass(row, includeDisciplines = true) {
  if (!row) return null;
  return {
    id: row.public_id,
    name: row.name,
    grade: { id: row.grade_id, name: row.grade_name },
    academicYear: row.academic_year,
    status: row.status,
    revision: row.revision,
    studentCount: Number(row.student_count || 0),
    disciplines: includeDisciplines ? classDisciplines(row.id) : undefined,
    archivedAt: row.archived_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function classStudents(classId) {
  return db.prepare(`
    SELECT
      s.public_id,
      s.display_name,
      s.external_reference,
      s.status AS student_status,
      s.revision,
      sce.status AS enrollment_status,
      sce.revision AS enrollment_revision,
      sce.enrolled_at,
      sce.ended_at
    FROM school_class_enrollments sce
    JOIN students s ON s.id = sce.student_id
    WHERE sce.class_id = ?
    ORDER BY
      CASE sce.status WHEN 'active' THEN 0 ELSE 1 END,
      s.display_name COLLATE NOCASE
  `).all(classId).map((row) => ({
    id: row.public_id,
    displayName: row.display_name,
    externalReference: row.external_reference,
    status: row.student_status,
    revision: row.revision,
    enrollmentStatus: row.enrollment_status,
    enrollmentRevision: row.enrollment_revision,
    enrolledAt: row.enrolled_at,
    endedAt: row.ended_at,
  }));
}

function serializeCode(row) {
  const now = Date.now();
  const expired = new Date(row.expires_at).getTime() <= now;
  return {
    id: row.public_id,
    maxUses: row.max_uses,
    useCount: row.use_count,
    remainingUses: Math.max(0, row.max_uses - row.use_count),
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    revision: row.revision,
    status: row.revoked_at ? 'revoked' : expired || row.use_count >= row.max_uses ? 'closed' : 'active',
    createdAt: row.created_at,
  };
}

function normalizeDisciplineIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = [...new Set(value.map(positiveInteger).filter(Boolean))];
  return ids.length > 0 && ids.length <= 10 ? ids : null;
}

function validateClassInput(body) {
  const currentYear = new Date().getFullYear();
  const name = cleanText(body?.name, 120);
  const gradeId = positiveInteger(body?.gradeId);
  const academicYear = positiveInteger(body?.academicYear);
  const disciplineIds = normalizeDisciplineIds(body?.disciplineIds);

  if (!name) return { error: 'Informe um nome para a turma com até 120 caracteres.' };
  if (!gradeId) return { error: 'Selecione o ano escolar.' };
  if (!academicYear || academicYear < 2000 || academicYear > currentYear + 5) {
    return { error: 'Informe um ano letivo válido.' };
  }
  if (!disciplineIds) return { error: 'Selecione ao menos um componente curricular.' };

  const gradeExists = db.prepare('SELECT 1 FROM grades WHERE id = ?').get(gradeId);
  const disciplineCount = db.prepare(`
    SELECT COUNT(*) AS count FROM disciplines WHERE id IN (${disciplineIds.map(() => '?').join(',')})
  `).get(...disciplineIds).count;
  if (!gradeExists || disciplineCount !== disciplineIds.length) {
    return { error: 'Ano escolar ou componente curricular inválido.' };
  }
  return { name, gradeId, academicYear, disciplineIds };
}

function logClassActivity(req, action, entityType, entityId, metadata = null) {
  logActivity({
    user: req.user,
    action,
    module: 'classes',
    entityType,
    entityId,
    entityTitle: entityType === 'school_class' ? metadata?.className : 'Cadastro de estudante',
    metadata,
    req,
  });
}

function normalizeEntryCode(value) {
  const code = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 16 ? code : null;
}

function digestEntryCode(code) {
  if (!config.classEntryCodeSecret) throw new Error('entry_code_secret_missing');
  return crypto.createHmac('sha256', config.classEntryCodeSecret)
    .update(`labmathic:class-entry:v1:${code}`)
    .digest('hex');
}

function normalizeJoinRequestId(value) {
  const requestId = String(value || '').trim();
  return /^[A-Za-z0-9_-]{20,100}$/.test(requestId) ? requestId : null;
}

function digestJoinRequest(requestId) {
  return crypto.createHash('sha256')
    .update(`labmathic:class-entry-request:v1:${requestId}`)
    .digest('hex');
}

function generateEntryCode() {
  let code = '';
  while (code.length < 16) {
    const bytes = crypto.randomBytes(24);
    for (const byte of bytes) {
      if (byte >= 224) continue;
      code += CODE_ALPHABET[byte % CODE_ALPHABET.length];
      if (code.length === 16) break;
    }
  }
  return code;
}

function displayEntryCode(code) {
  return code.match(/.{1,4}/g).join('-');
}

function genericJoinError(res) {
  return res.status(400).json({
    error: 'Não foi possível usar esse código. Confira os dados ou peça um novo código ao professor.',
  });
}

// Entrada pública e limitada: a decisão da flag é avaliada para o professor dono do código.
router.post('/join', (req, res, next) => {
  const code = normalizeEntryCode(req.body?.code);
  const displayName = cleanText(req.body?.displayName, 120);
  const requestId = normalizeJoinRequestId(req.body?.requestId);
  if (!code || !displayName || !requestId) return genericJoinError(res);

  if (!config.classEntryCodeSecret) return genericJoinError(res);
  const digest = digestEntryCode(code);
  const requestDigest = digestJoinRequest(requestId);
  const entryCode = db.prepare(`
    SELECT sec.*, sc.name AS class_name, sc.status AS class_status, u.name AS teacher_name
    FROM school_class_entry_codes sec
    JOIN school_classes sc ON sc.id = sec.class_id
    JOIN users u ON u.id = sec.owner_teacher_id
    WHERE sec.code_digest = ?
  `).get(digest);

  const candidateDigest = Buffer.from(digest, 'hex');
  const storedDigest = Buffer.from(entryCode?.code_digest || '0'.repeat(64), 'hex');
  const digestMatches = crypto.timingSafeEqual(candidateDigest, storedDigest);
  if (!entryCode || !digestMatches || entryCode.class_status !== 'active') return genericJoinError(res);
  const flagDecision = evaluateFeatureFlag(db, 'classes.entry_codes', {
    id: entryCode.owner_teacher_id,
    role: 'professor',
  });
  if (!flagDecision.enabled) return genericJoinError(res);

  const previousRedemption = db.prepare(`
    SELECT 1
    FROM school_class_entry_code_redemptions
    WHERE entry_code_id = ? AND request_digest = ?
  `).get(entryCode.id, requestDigest);
  if (previousRedemption) {
    return res.json({
      joined: true,
      alreadyJoined: true,
      className: entryCode.class_name,
      teacherName: entryCode.teacher_name,
      message: 'Esta solicitação já havia sido confirmada.',
    });
  }

  const unavailable = entryCode.revoked_at
    || entryCode.use_count >= entryCode.max_uses
    || new Date(entryCode.expires_at).getTime() <= Date.now();
  if (unavailable) return genericJoinError(res);

  try {
    const result = db.transaction(() => {
      const previous = db.prepare(`
        SELECT s.public_id
        FROM school_class_entry_code_redemptions r
        JOIN students s ON s.id = r.student_id
        WHERE r.entry_code_id = ? AND r.request_digest = ?
      `).get(entryCode.id, requestDigest);
      if (previous) return { alreadyJoined: true, studentId: previous.public_id };

      const studentPublicId = uuidv4();
      const studentResult = db.prepare(`
        INSERT INTO students (
          public_id, owner_teacher_id, display_name, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        studentPublicId,
        entryCode.owner_teacher_id,
        displayName,
        entryCode.owner_teacher_id,
        entryCode.owner_teacher_id
      );
      const enrollment = db.prepare(`
        INSERT INTO school_class_enrollments (
          class_id, student_id, owner_teacher_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        entryCode.class_id,
        studentResult.lastInsertRowid,
        entryCode.owner_teacher_id,
        entryCode.owner_teacher_id,
        entryCode.owner_teacher_id
      );
      db.prepare(`
        INSERT INTO school_class_entry_code_redemptions (
          entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id,
          request_digest
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        entryCode.id,
        entryCode.class_id,
        studentResult.lastInsertRowid,
        enrollment.lastInsertRowid,
        entryCode.owner_teacher_id,
        requestDigest
      );
      return { alreadyJoined: false, studentId: studentPublicId };
    })();

    return res.status(result.alreadyJoined ? 200 : 201).json({
      joined: true,
      alreadyJoined: result.alreadyJoined,
      className: entryCode.class_name,
      teacherName: entryCode.teacher_name,
      message: result.alreadyJoined
        ? 'Seu nome já estava registrado nesta turma.'
        : 'Entrada confirmada. Seu professor já pode visualizar seu cadastro.',
    });
  } catch (error) {
    if (String(error.message).includes('entry_code_unavailable')) return genericJoinError(res);
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      const previous = db.prepare(`
        SELECT 1
        FROM school_class_entry_code_redemptions
        WHERE entry_code_id = ? AND request_digest = ?
      `).get(entryCode.id, requestDigest);
      if (previous) {
        return res.json({
          joined: true,
          alreadyJoined: true,
          className: entryCode.class_name,
          teacherName: entryCode.teacher_name,
          message: 'Esta solicitação já havia sido confirmada.',
        });
      }
    }
    return next(error);
  }
});

router.use(authenticate, requireProfessor, requireFeatureFlag('classes.core'));

router.get('/bootstrap', (req, res) => {
  const overview = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM school_classes WHERE owner_teacher_id = ? AND status = 'active') AS active_classes,
      (SELECT COUNT(*) FROM students WHERE owner_teacher_id = ? AND status = 'active') AS active_students,
      (
        SELECT COUNT(*)
        FROM school_class_enrollments sce
        JOIN school_classes sc ON sc.id = sce.class_id
        WHERE sce.owner_teacher_id = ? AND sce.status = 'active' AND sc.status = 'active'
      ) AS active_enrollments
  `).get(req.user.id, req.user.id, req.user.id);
  const importEnabled = evaluateFeatureFlag(db, 'classes.student_import', req.user).enabled;
  const entryCodesEnabled = evaluateFeatureFlag(db, 'classes.entry_codes', req.user).enabled;

  res.json({
    grades: db.prepare('SELECT id, name FROM grades ORDER BY sort_order, name').all(),
    disciplines: db.prepare('SELECT id, name FROM disciplines ORDER BY name COLLATE NOCASE').all(),
    overview: {
      activeClasses: overview.active_classes,
      activeStudents: overview.active_students,
      activeEnrollments: overview.active_enrollments,
    },
    capabilities: {
      importStudents: importEnabled,
      entryCodes: entryCodesEnabled && Boolean(config.classEntryCodeSecret),
    },
  });
});

router.get('/home-overview', (req, res) => {
  const overview = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM school_classes
        WHERE owner_teacher_id = ? AND status = 'active') AS active_classes,
      (
        SELECT COUNT(DISTINCT enrollment.student_id)
        FROM school_class_enrollments enrollment
        JOIN school_classes school_class ON school_class.id = enrollment.class_id
        JOIN students student ON student.id = enrollment.student_id
        WHERE enrollment.owner_teacher_id = ?
          AND enrollment.status = 'active'
          AND school_class.status = 'active'
          AND student.status = 'active'
      ) AS active_students,
      (SELECT COUNT(*) FROM class_assessment_assignments
        WHERE owner_teacher_id = ? AND status = 'draft') AS draft_assessments,
      (SELECT COUNT(*) FROM class_assessment_assignments
        WHERE owner_teacher_id = ? AND status = 'scheduled') AS scheduled_assessments,
      (SELECT COUNT(*) FROM class_assessment_assignments
        WHERE owner_teacher_id = ? AND status = 'open') AS open_assessments,
      (SELECT COUNT(*) FROM class_assessment_assignments
        WHERE owner_teacher_id = ? AND status = 'closed') AS closed_assessments
  `).get(
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id,
    req.user.id
  );

  const recentAssessments = db.prepare(`
    SELECT
      assignment.public_id,
      assignment.title_snapshot,
      assignment.status,
      assignment.updated_at,
      assignment.question_count,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      COUNT(participant.id) AS participant_count,
      SUM(CASE WHEN participant.status = 'submitted' THEN 1 ELSE 0 END) AS submitted_count,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic
    FROM class_assessment_assignments assignment
    JOIN school_classes school_class
      ON school_class.id = assignment.class_id
      AND school_class.owner_teacher_id = assignment.owner_teacher_id
    LEFT JOIN class_assessment_participants participant
      ON participant.assignment_id = assignment.id
    LEFT JOIN diagnostic_question_sets diagnostic
      ON diagnostic.question_set_id = assignment.source_question_set_id
      AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
    WHERE assignment.owner_teacher_id = ?
      AND assignment.status <> 'cancelled'
    GROUP BY assignment.id
    ORDER BY assignment.updated_at DESC, assignment.id DESC
    LIMIT 5
  `).all(req.user.id).map((row) => ({
    id: row.public_id,
    title: row.title_snapshot,
    status: row.status,
    updatedAt: row.updated_at,
    questionCount: Number(row.question_count) || 0,
    participantCount: Number(row.participant_count) || 0,
    submittedCount: Number(row.submitted_count) || 0,
    isDiagnostic: row.is_diagnostic === 1,
    class: { id: row.class_public_id, name: row.class_name },
  }));

  res.set('Cache-Control', 'private, no-store');
  return res.json({
    metrics: {
      activeClasses: Number(overview.active_classes) || 0,
      activeStudents: Number(overview.active_students) || 0,
      assessments: {
        draft: Number(overview.draft_assessments) || 0,
        scheduled: Number(overview.scheduled_assessments) || 0,
        open: Number(overview.open_assessments) || 0,
        closed: Number(overview.closed_assessments) || 0,
      },
      recoveryPlans: recoveryPlanCounts(db, req.user.id),
    },
    recentAssessments,
    recentRecoveryPlans: listLearningRecoveryPlans(db, {
      teacherId: req.user.id,
      limit: 4,
    }),
  });
});

router.get('/', (req, res) => {
  const status = VALID_CLASS_STATUSES.has(req.query.status) ? req.query.status : 'active';
  const search = cleanText(req.query.search, 80);
  const params = [req.user.id, status];
  let searchClause = '';
  if (search) {
    searchClause = 'AND instr(lower(sc.name), lower(?)) > 0';
    params.push(search);
  }

  const rows = db.prepare(`
    SELECT sc.*, g.name AS grade_name,
      COUNT(CASE WHEN sce.status = 'active' THEN 1 END) AS student_count
    FROM school_classes sc
    JOIN grades g ON g.id = sc.grade_id
    LEFT JOIN school_class_enrollments sce ON sce.class_id = sc.id
    WHERE sc.owner_teacher_id = ? AND sc.status = ? ${searchClause}
    GROUP BY sc.id
    ORDER BY sc.academic_year DESC, sc.name COLLATE NOCASE
    LIMIT 100
  `).all(...params);
  res.json(rows.map((row) => serializeClass(row)));
});

router.post('/', (req, res, next) => {
  const input = validateClassInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  try {
    const publicId = uuidv4();
    db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO school_classes (
          public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        publicId,
        req.user.id,
        input.name,
        input.gradeId,
        input.academicYear,
        req.user.id,
        req.user.id
      );
      const insertDiscipline = db.prepare(`
        INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by)
        VALUES (?, ?, ?, ?)
      `);
      input.disciplineIds.forEach((id) => insertDiscipline.run(
        result.lastInsertRowid, req.user.id, id, req.user.id
      ));
    })();
    const created = ownedClass(publicId, req.user.id);
    logClassActivity(req, 'create_class', 'school_class', publicId, { className: created.name });
    return res.status(201).json(serializeClass(created));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Você já possui uma turma com esse nome no ano informado.' });
    }
    return next(error);
  }
});

router.put('/:classPublicId', (req, res, next) => {
  const existing = ownedClass(req.params.classPublicId, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Turma não encontrada.' });
  if (existing.status !== 'active') {
    return res.status(409).json({ error: 'Restaure a turma antes de editá-la.' });
  }
  const expectedRevision = positiveInteger(req.body?.expectedRevision);
  if (!expectedRevision) return res.status(400).json({ error: 'Revisão da turma não informada.' });
  const input = validateClassInput(req.body);
  if (input.error) return res.status(400).json({ error: input.error });

  try {
    const updated = db.transaction(() => {
      const result = db.prepare(`
        UPDATE school_classes
        SET name = ?, grade_id = ?, academic_year = ?, updated_by = ?,
            revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND owner_teacher_id = ? AND revision = ?
      `).run(
        input.name,
        input.gradeId,
        input.academicYear,
        req.user.id,
        existing.id,
        req.user.id,
        expectedRevision
      );
      if (!result.changes) return false;
      db.prepare('DELETE FROM school_class_disciplines WHERE class_id = ?').run(existing.id);
      const insert = db.prepare(`
        INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by)
        VALUES (?, ?, ?, ?)
      `);
      input.disciplineIds.forEach((id) => insert.run(existing.id, req.user.id, id, req.user.id));
      return true;
    })();
    if (!updated) return res.status(409).json({ error: 'A turma foi alterada em outra sessão. Atualize a tela.' });
    const row = ownedClass(req.params.classPublicId, req.user.id);
    logClassActivity(req, 'update_class', 'school_class', row.public_id, { className: row.name });
    return res.json(serializeClass(row));
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Você já possui uma turma com esse nome no ano informado.' });
    }
    return next(error);
  }
});

router.patch('/:classPublicId/status', (req, res) => {
  const existing = ownedClass(req.params.classPublicId, req.user.id);
  if (!existing) return res.status(404).json({ error: 'Turma não encontrada.' });
  const expectedRevision = positiveInteger(req.body?.expectedRevision);
  const status = req.body?.status;
  if (!expectedRevision || !VALID_CLASS_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Estado ou revisão inválida.' });
  }

  const changed = db.transaction(() => {
    const result = db.prepare(`
      UPDATE school_classes
      SET status = ?, archived_at = CASE WHEN ? = 'archived' THEN CURRENT_TIMESTAMP ELSE NULL END,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_teacher_id = ? AND revision = ?
    `).run(status, status, req.user.id, existing.id, req.user.id, expectedRevision);
    if (!result.changes) return false;
    if (status === 'archived') {
      db.prepare(`
        UPDATE school_class_entry_codes
        SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP), revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ? AND revoked_at IS NULL
      `).run(existing.id);
    }
    return true;
  })();
  if (!changed) return res.status(409).json({ error: 'A turma foi alterada em outra sessão. Atualize a tela.' });

  const row = ownedClass(req.params.classPublicId, req.user.id);
  logClassActivity(req, status === 'archived' ? 'archive_class' : 'restore_class', 'school_class', row.public_id, {
    className: row.name,
  });
  return res.json(serializeClass(row));
});

router.get('/students/roster', (req, res) => {
  const status = VALID_CLASS_STATUSES.has(req.query.status) ? req.query.status : 'active';
  const rows = db.prepare(`
    SELECT s.*, COUNT(CASE
      WHEN sce.status = 'active' AND sc.status = 'active' THEN 1
    END) AS class_count
    FROM students s
    LEFT JOIN school_class_enrollments sce ON sce.student_id = s.id
    LEFT JOIN school_classes sc ON sc.id = sce.class_id
    WHERE s.owner_teacher_id = ? AND s.status = ?
    GROUP BY s.id
    ORDER BY s.display_name COLLATE NOCASE
    LIMIT 1000
  `).all(req.user.id, status);
  res.json(rows.map((row) => ({
    id: row.public_id,
    displayName: row.display_name,
    externalReference: row.external_reference,
    status: row.status,
    revision: row.revision,
    classCount: row.class_count,
  })));
});

router.post('/:classPublicId/students', (req, res, next) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass || schoolClass.status !== 'active') {
    return res.status(404).json({ error: 'Turma ativa não encontrada.' });
  }
  const displayName = cleanText(req.body?.displayName, 120);
  const externalReferenceInput = optionalText(req.body?.externalReference, 80);
  if (!displayName) return res.status(400).json({ error: 'Informe o nome do estudante.' });
  if (externalReferenceInput.error) {
    return res.status(400).json({ error: 'O identificador deve ter até 80 caracteres válidos.' });
  }
  const externalReference = externalReferenceInput.value;

  try {
    const publicId = uuidv4();
    db.transaction(() => {
      const student = db.prepare(`
        INSERT INTO students (
          public_id, owner_teacher_id, display_name, external_reference, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(publicId, req.user.id, displayName, externalReference, req.user.id, req.user.id);
      db.prepare(`
        INSERT INTO school_class_enrollments (
          class_id, student_id, owner_teacher_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?)
      `).run(schoolClass.id, student.lastInsertRowid, req.user.id, req.user.id, req.user.id);
    })();
    logClassActivity(req, 'create_student', 'student', publicId, { classId: schoolClass.public_id });
    const student = classStudents(schoolClass.id).find((row) => row.id === publicId);
    return res.status(201).json(student);
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Esse identificador já está associado a outro estudante.' });
    }
    return next(error);
  }
});

router.post('/:classPublicId/enrollments', (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass || schoolClass.status !== 'active') {
    return res.status(404).json({ error: 'Turma ativa não encontrada.' });
  }
  const student = db.prepare(`
    SELECT * FROM students WHERE public_id = ? AND owner_teacher_id = ? AND status = 'active'
  `).get(req.body?.studentId, req.user.id);
  if (!student) return res.status(404).json({ error: 'Estudante ativo não encontrado.' });

  const existing = db.prepare(`
    SELECT * FROM school_class_enrollments WHERE class_id = ? AND student_id = ?
  `).get(schoolClass.id, student.id);
  if (existing?.status === 'active') return res.status(409).json({ error: 'O estudante já está nesta turma.' });
  if (existing) {
    const expectedRevision = positiveInteger(req.body?.expectedRevision);
    if (!expectedRevision) {
      return res.status(409).json({
        error: 'A matrícula já existe. Atualize a turma antes de rematricular o estudante.',
      });
    }
    const result = db.prepare(`
      UPDATE school_class_enrollments
      SET status = 'active', ended_at = NULL, enrolled_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(req.user.id, existing.id, expectedRevision);
    if (!result.changes) {
      return res.status(409).json({ error: 'A matrícula foi alterada em outra sessão. Atualize a turma.' });
    }
  } else {
    db.prepare(`
      INSERT INTO school_class_enrollments (
        class_id, student_id, owner_teacher_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?)
    `).run(schoolClass.id, student.id, req.user.id, req.user.id, req.user.id);
  }
  logClassActivity(req, 'enroll_student', 'student', student.public_id, { classId: schoolClass.public_id });
  return res.status(201).json(classStudents(schoolClass.id).find((row) => row.id === student.public_id));
});

router.patch('/:classPublicId/enrollments/:studentPublicId', (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });
  if (schoolClass.status !== 'active') {
    return res.status(409).json({ error: 'Restaure a turma antes de alterar matrículas.' });
  }
  const status = req.body?.status;
  const expectedRevision = positiveInteger(req.body?.expectedRevision);
  if (!['active', 'withdrawn'].includes(status) || !expectedRevision) {
    return res.status(400).json({ error: 'Estado ou revisão da matrícula inválida.' });
  }

  const enrollment = db.prepare(`
    SELECT sce.id, sce.revision, s.public_id
    FROM school_class_enrollments sce
    JOIN students s ON s.id = sce.student_id
    WHERE sce.class_id = ? AND s.public_id = ? AND sce.owner_teacher_id = ?
  `).get(schoolClass.id, req.params.studentPublicId, req.user.id);
  if (!enrollment) return res.status(404).json({ error: 'Matrícula não encontrada.' });
  const result = db.prepare(`
    UPDATE school_class_enrollments
    SET status = ?, ended_at = CASE WHEN ? = 'withdrawn' THEN CURRENT_TIMESTAMP ELSE NULL END,
        enrolled_at = CASE WHEN ? = 'active' THEN CURRENT_TIMESTAMP ELSE enrolled_at END,
        revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND revision = ?
  `).run(status, status, status, req.user.id, enrollment.id, expectedRevision);
  if (!result.changes) {
    return res.status(409).json({ error: 'A matrícula foi alterada em outra sessão. Atualize a turma.' });
  }
  logClassActivity(req, status === 'withdrawn' ? 'withdraw_student' : 'enroll_student', 'student', enrollment.public_id, {
    classId: schoolClass.public_id,
  });
  return res.json(classStudents(schoolClass.id).find((row) => row.id === enrollment.public_id));
});

router.patch('/students/:studentPublicId', (req, res, next) => {
  const student = db.prepare('SELECT * FROM students WHERE public_id = ? AND owner_teacher_id = ?')
    .get(req.params.studentPublicId, req.user.id);
  if (!student) return res.status(404).json({ error: 'Estudante não encontrado.' });
  const displayName = cleanText(req.body?.displayName, 120);
  const externalReferenceInput = optionalText(req.body?.externalReference, 80);
  const expectedRevision = positiveInteger(req.body?.expectedRevision);
  if (!displayName || !expectedRevision) return res.status(400).json({ error: 'Dados ou revisão inválidos.' });
  if (externalReferenceInput.error) {
    return res.status(400).json({ error: 'O identificador deve ter até 80 caracteres válidos.' });
  }
  const externalReference = externalReferenceInput.value;

  try {
    const result = db.prepare(`
      UPDATE students
      SET display_name = ?, external_reference = ?, revision = revision + 1,
          updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND owner_teacher_id = ? AND revision = ?
    `).run(displayName, externalReference, req.user.id, student.id, req.user.id, expectedRevision);
    if (!result.changes) return res.status(409).json({ error: 'O cadastro foi alterado em outra sessão. Atualize a tela.' });
    const updated = db.prepare('SELECT * FROM students WHERE id = ?').get(student.id);
    logClassActivity(req, 'update_student', 'student', updated.public_id);
    return res.json({
      id: updated.public_id,
      displayName: updated.display_name,
      externalReference: updated.external_reference,
      status: updated.status,
      revision: updated.revision,
    });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'Esse identificador já está associado a outro estudante.' });
    }
    return next(error);
  }
});

function classifyImportRows(rows, schoolClass) {
  const seenReferences = new Set();
  const seenNamesWithoutReference = new Set();
  const findByReference = db.prepare(`
    SELECT * FROM students WHERE owner_teacher_id = ? AND external_reference = ? COLLATE NOCASE
  `);
  const findEnrollment = db.prepare(`
    SELECT status FROM school_class_enrollments WHERE class_id = ? AND student_id = ?
  `);
  const findEnrolledByName = db.prepare(`
    SELECT sce.status
    FROM school_class_enrollments sce
    JOIN students s ON s.id = sce.student_id
    WHERE sce.class_id = ? AND s.display_name = ? COLLATE NOCASE
    LIMIT 1
  `);

  return rows.map((row) => {
    const errors = [...row.errors];
    const referenceKey = row.externalReference?.toLocaleLowerCase('pt-BR');
    const nameKey = row.displayName?.toLocaleLowerCase('pt-BR');
    if (referenceKey && seenReferences.has(referenceKey)) errors.push('Identificador repetido na planilha.');
    if (!referenceKey && nameKey && seenNamesWithoutReference.has(nameKey)) {
      errors.push('Nome repetido sem identificador na planilha.');
    }
    if (referenceKey) seenReferences.add(referenceKey);
    if (!referenceKey && nameKey) seenNamesWithoutReference.add(nameKey);
    if (errors.length) return { ...row, errors, action: 'invalid' };

    if (row.externalReference) {
      const student = findByReference.get(schoolClass.owner_teacher_id, row.externalReference);
      if (!student) return { ...row, action: 'create' };
      const enrollment = findEnrollment.get(schoolClass.id, student.id);
      if (!enrollment) return { ...row, action: 'enroll_existing' };
      return { ...row, action: enrollment.status === 'active' ? 'skip' : 'reactivate' };
    }

    const enrollment = findEnrolledByName.get(schoolClass.id, row.displayName);
    return { ...row, action: enrollment ? (enrollment.status === 'active' ? 'skip' : 'reactivate_by_name') : 'create' };
  });
}

function uploadSpreadsheet(req, res, next) {
  upload.single('file')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({ error: 'A planilha deve ter no máximo 1 MB.' });
    }
    return res.status(400).json({ error: 'Envie uma planilha .xlsx ou .csv válida.' });
  });
}

router.post(
  '/:classPublicId/import/preview',
  requireFeatureFlag('classes.student_import'),
  (req, res, next) => {
    const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
    if (!schoolClass || schoolClass.status !== 'active') {
      return res.status(404).json({ error: 'Turma ativa não encontrada.' });
    }
    res.locals.importClass = schoolClass;
    return next();
  },
  uploadSpreadsheet,
  async (req, res) => {
    if (!req.file) return res.status(400).json({ error: 'Selecione uma planilha.' });
    if (activeSpreadsheetPreviews >= MAX_CONCURRENT_SPREADSHEET_PREVIEWS) {
      return res.set('Retry-After', '3').status(503).json({ error: 'A prévia de planilha está ocupada. Tente novamente em instantes.' });
    }
    activeSpreadsheetPreviews += 1;
    try {
      const rows = classifyImportRows(await parseStudentSpreadsheet(req.file), res.locals.importClass);
      const summary = rows.reduce((counts, row) => {
        counts[row.action] = (counts[row.action] || 0) + 1;
        return counts;
      }, {});
      return res.set('Cache-Control', 'private, no-store').json({ rows, summary, canImport: !rows.some((row) => row.action === 'invalid') });
    } catch (error) {
      const messages = {
        spreadsheet_empty: 'A planilha está vazia ou não possui estudantes.',
        spreadsheet_missing_name: 'Inclua uma coluna chamada “Nome”.',
        spreadsheet_too_many_rows: 'A planilha deve conter no máximo 500 estudantes.',
        csv_invalid_encoding: 'Salve o arquivo CSV no formato UTF-8.',
        csv_invalid_quotes: 'O arquivo CSV possui aspas não fechadas.',
        xlsx_invalid_archive: 'O arquivo XLSX está incompleto ou corrompido.',
        xlsx_unsafe_archive: 'O arquivo XLSX excede os limites seguros de processamento.',
        xlsx_unsafe_grid: 'Reduza a planilha para até 2.048 linhas e 256 colunas. Importe no máximo 500 estudantes por vez.',
        xlsx_formulas_not_allowed: 'Fórmulas não são aceitas na planilha de estudantes.',
      };
      return res.status(400).json({ error: messages[error.message] || 'Não foi possível ler a planilha.' });
    } finally {
      activeSpreadsheetPreviews -= 1;
    }
  }
);

router.post('/:classPublicId/import', requireFeatureFlag('classes.student_import'), (req, res, next) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass || schoolClass.status !== 'active') {
    return res.status(404).json({ error: 'Turma ativa não encontrada.' });
  }
  let classified;
  try {
    classified = classifyImportRows(validateSubmittedRows(req.body?.rows), schoolClass);
  } catch {
    return res.status(400).json({ error: 'Os dados da importação são inválidos.' });
  }
  if (classified.some((row) => row.action === 'invalid')) {
    return res.status(400).json({ error: 'Revise as linhas inválidas antes de importar.' });
  }

  try {
    const result = db.transaction(() => {
      const counts = { created: 0, enrolled: 0, reactivated: 0, skipped: 0 };
      const findByReference = db.prepare(`
        SELECT * FROM students WHERE owner_teacher_id = ? AND external_reference = ? COLLATE NOCASE
      `);
      const findByNameInClass = db.prepare(`
        SELECT s.*, sce.id AS enrollment_id, sce.status AS enrollment_status
        FROM school_class_enrollments sce
        JOIN students s ON s.id = sce.student_id
        WHERE sce.class_id = ? AND s.display_name = ? COLLATE NOCASE
        LIMIT 1
      `);
      const findEnrollment = db.prepare(`
        SELECT * FROM school_class_enrollments WHERE class_id = ? AND student_id = ?
      `);
      const insertStudent = db.prepare(`
        INSERT INTO students (
          public_id, owner_teacher_id, display_name, external_reference, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?)
      `);
      const insertEnrollment = db.prepare(`
        INSERT INTO school_class_enrollments (
          class_id, student_id, owner_teacher_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?)
      `);
      const reactivateEnrollment = db.prepare(`
        UPDATE school_class_enrollments
        SET status = 'active', ended_at = NULL, enrolled_at = CURRENT_TIMESTAMP,
            revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `);
      const reactivateStudent = db.prepare(`
        UPDATE students
        SET status = 'active', archived_at = NULL, revision = revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'archived'
      `);

      classified.forEach((row) => {
        let student = row.externalReference
          ? findByReference.get(req.user.id, row.externalReference)
          : findByNameInClass.get(schoolClass.id, row.displayName);
        if (!student) {
          const inserted = insertStudent.run(
            uuidv4(), req.user.id, row.displayName, row.externalReference, req.user.id, req.user.id
          );
          student = { id: inserted.lastInsertRowid };
          counts.created += 1;
        }
        if (student.status === 'archived') reactivateStudent.run(req.user.id, student.id);
        const enrollment = student.enrollment_id
          ? { id: student.enrollment_id, status: student.enrollment_status }
          : findEnrollment.get(schoolClass.id, student.id);
        if (!enrollment) {
          insertEnrollment.run(schoolClass.id, student.id, req.user.id, req.user.id, req.user.id);
          counts.enrolled += 1;
        } else if (enrollment.status === 'withdrawn') {
          reactivateEnrollment.run(req.user.id, enrollment.id);
          counts.reactivated += 1;
        } else {
          counts.skipped += 1;
        }
      });
      return counts;
    })();
    logClassActivity(req, 'import_students', 'school_class', schoolClass.public_id, {
      className: schoolClass.name,
      counts: result,
    });
    return res.status(201).json({ ...result, students: classStudents(schoolClass.id) });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A lista mudou desde a pré-visualização. Revise a planilha novamente.' });
    }
    return next(error);
  }
});

router.get('/:classPublicId/codes', requireFeatureFlag('classes.entry_codes'), (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });
  const rows = db.prepare(`
    SELECT * FROM school_class_entry_codes WHERE class_id = ? ORDER BY id DESC LIMIT 20
  `).all(schoolClass.id);
  res.json(rows.map(serializeCode));
});

router.post('/:classPublicId/codes', requireFeatureFlag('classes.entry_codes'), (req, res, next) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass || schoolClass.status !== 'active') {
    return res.status(404).json({ error: 'Turma ativa não encontrada.' });
  }
  if (!config.classEntryCodeSecret) {
    return res.status(503).json({ error: 'Os códigos de entrada ainda não estão configurados neste ambiente.' });
  }
  const maxUses = positiveInteger(req.body?.maxUses);
  const validDays = positiveInteger(req.body?.validDays);
  if (!maxUses || maxUses > 500 || !validDays || validDays > 14) {
    return res.status(400).json({ error: 'Use entre 1 e 500 vagas e validade de até 14 dias.' });
  }

  try {
    let code;
    let publicId;
    let expiresAt;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      code = generateEntryCode();
      publicId = uuidv4();
      expiresAt = new Date(Date.now() + validDays * 24 * 60 * 60 * 1000).toISOString();
      try {
        db.prepare(`
          INSERT INTO school_class_entry_codes (
            public_id, class_id, owner_teacher_id, code_digest, max_uses,
            expires_at, created_by
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `).run(
          publicId,
          schoolClass.id,
          req.user.id,
          digestEntryCode(code),
          maxUses,
          expiresAt,
          req.user.id
        );
        break;
      } catch (error) {
        if (attempt === 2 || error.code !== 'SQLITE_CONSTRAINT_UNIQUE') throw error;
      }
    }
    const row = db.prepare('SELECT * FROM school_class_entry_codes WHERE public_id = ?').get(publicId);
    logClassActivity(req, 'create_class_entry_code', 'school_class', schoolClass.public_id, {
      className: schoolClass.name,
      maxUses,
      validDays,
    });
    return res.status(201).json({ ...serializeCode(row), code: displayEntryCode(code) });
  } catch (error) {
    return next(error);
  }
});

router.post('/:classPublicId/codes/:codePublicId/revoke', requireFeatureFlag('classes.entry_codes'), (req, res) => {
  const schoolClass = ownedClass(req.params.classPublicId, req.user.id);
  if (!schoolClass) return res.status(404).json({ error: 'Turma não encontrada.' });
  const expectedRevision = positiveInteger(req.body?.expectedRevision);
  if (!expectedRevision) return res.status(400).json({ error: 'Revisão do código não informada.' });
  const result = db.prepare(`
    UPDATE school_class_entry_codes
    SET revoked_at = CURRENT_TIMESTAMP, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE public_id = ? AND class_id = ? AND owner_teacher_id = ?
      AND revision = ? AND revoked_at IS NULL
  `).run(req.params.codePublicId, schoolClass.id, req.user.id, expectedRevision);
  if (!result.changes) return res.status(409).json({ error: 'O código já foi alterado ou encerrado.' });
  const row = db.prepare('SELECT * FROM school_class_entry_codes WHERE public_id = ?').get(req.params.codePublicId);
  logClassActivity(req, 'revoke_class_entry_code', 'school_class', schoolClass.public_id, {
    className: schoolClass.name,
  });
  return res.json(serializeCode(row));
});

router.get('/:classPublicId', (req, res) => {
  const row = db.prepare(`
    SELECT sc.*, g.name AS grade_name,
      COUNT(CASE WHEN sce.status = 'active' THEN 1 END) AS student_count
    FROM school_classes sc
    JOIN grades g ON g.id = sc.grade_id
    LEFT JOIN school_class_enrollments sce ON sce.class_id = sc.id
    WHERE sc.public_id = ? AND sc.owner_teacher_id = ?
    GROUP BY sc.id
  `).get(req.params.classPublicId, req.user.id);
  if (!row) return res.status(404).json({ error: 'Turma não encontrada.' });
  return res.json({ ...serializeClass(row), students: classStudents(row.id) });
});

module.exports = router;
