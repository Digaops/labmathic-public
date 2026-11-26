const crypto = require('node:crypto');
const { analyzeClassAssessment, loadAssessmentOverview } = require('./classAssessmentAnalysis');
const { serializeLearningRecoveryMonitoring } = require('./learningRecoveryMonitoring');
const { logActivityStrict } = require('../helpers/activity');

class PedagogicalCycleError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
function fail(status, code, message) { throw new PedagogicalCycleError(status, code, message); }
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fields = ['objective', 'observation', 'action', 'verification'];
const positive = (value, fallback = 1) => /^\d{1,7}$/.test(String(value)) && Number(value) > 0 ? Number(value) : fallback;

function ownedClass(db, teacherId, publicId) {
  const row = db.prepare(`SELECT c.*, g.name AS grade_name FROM school_classes c
    JOIN grades g ON g.id = c.grade_id WHERE c.public_id = ? AND c.owner_teacher_id = ?`).get(publicId, teacherId);
  if (!row) fail(404, 'class_not_found', 'Turma não encontrada.');
  return row;
}
function context(db, row, capabilities) {
  const institution = capabilities.institutions ? db.prepare(`
    SELECT c.migration_status AS status, m.name AS municipality, s.name AS school
    FROM school_class_institution_contexts c
    LEFT JOIN municipalities m ON m.id = c.municipality_id
    LEFT JOIN schools s ON s.id = c.school_id AND s.municipality_id = c.municipality_id
    WHERE c.class_id = ? AND c.owner_teacher_id = ?`).get(row.id, row.owner_teacher_id) : null;
  return { id: row.public_id, name: row.name, gradeId: row.grade_id, gradeName: row.grade_name,
    academicYear: row.academic_year, status: row.status,
    institution: institution || { status: capabilities.institutions ? 'pending' : 'unavailable' } };
}
function listClasses(db, teacherId, query, capabilities) {
  const page = positive(query.page); const limit = 30;
  const search = typeof query.search === 'string' ? query.search.trim().slice(0, 100) : '';
  const where = "c.owner_teacher_id = ? AND (? = '' OR instr(lower(c.name), lower(?)) > 0)";
  const total = db.prepare(`SELECT COUNT(*) FROM school_classes c WHERE ${where}`).pluck().get(teacherId, search, search);
  const rows = db.prepare(`SELECT c.*, g.name AS grade_name FROM school_classes c
    JOIN grades g ON g.id = c.grade_id WHERE ${where}
    ORDER BY c.academic_year DESC, c.name, c.id LIMIT ? OFFSET ?`).all(teacherId, search, search, limit, (page - 1) * limit);
  return { data: rows.map(row => context(db, row, capabilities)), pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
function classOverview(db, teacherId, classPublicId, query, capabilities) {
  const row = ownedClass(db, teacherId, classPublicId);
  const page = positive(query.page); const limit = 30;
  const total = db.prepare('SELECT COUNT(*) FROM class_assessment_assignments WHERE class_id = ? AND owner_teacher_id = ?')
    .pluck().get(row.id, teacherId);
  const assessments = db.prepare(`SELECT a.public_id AS id, a.title_snapshot AS title, a.status,
    a.source_question_set_id AS questionSetId, a.question_count AS questionCount,
    EXISTS(SELECT 1 FROM diagnostic_question_sets d WHERE d.question_set_id = a.source_question_set_id) AS isDiagnostic,
    (SELECT r.public_id FROM learning_recovery_monitoring_cycles mc
      JOIN learning_recovery_plans r ON r.id = mc.recovery_plan_id
      WHERE mc.assignment_id = a.id AND mc.owner_teacher_id = a.owner_teacher_id) AS verificationPlanId
    FROM class_assessment_assignments a WHERE a.class_id = ? AND a.owner_teacher_id = ?
    ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(row.id, teacherId, limit, (page - 1) * limit);
  return { class: context(db, row, capabilities), assessments,
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } };
}
function ownedAssessment(db, teacherId, classPublicId, publicId) {
  const schoolClass = ownedClass(db, teacherId, classPublicId);
  const assignment = db.prepare(`SELECT * FROM class_assessment_assignments
    WHERE public_id = ? AND class_id = ? AND owner_teacher_id = ?`).get(publicId, schoolClass.id, teacherId);
  if (!assignment) fail(404, 'assessment_not_found', 'Aplicação não encontrada.');
  return { schoolClass, assignment: { ...assignment, class_name: schoolClass.name } };
}
function evidence(db, assignment) {
  if (!['open', 'closed'].includes(assignment.status)) return { snapshot: null, hash: null };
  const analysis = analyzeClassAssessment(db, assignment);
  const snapshot = { assessment: analysis.assessment, overview: analysis.overview, skills: analysis.skills,
    methodology: analysis.methodology };
  // Include attempt revisions privately: identical percentages can mask a changed correction.
  return { snapshot, hash: hash([snapshot, analysis.participants.map(p =>
    [p.id, p.attemptId, p.attemptRevision, p.attemptStatus, p.participationStatus])]) };
}
function feedback(row, capabilities = {}) {
  if (!row) return null;
  const snapshot = JSON.parse(row.evidence_json);
  if (!capabilities.recovery) delete snapshot.verifications;
  return { revision: row.revision, evidenceHash: row.evidence_hash, evidence: snapshot,
    ...Object.fromEntries(fields.map(key => [key, row[key]])), createdAt: row.created_at };
}
function latestFeedback(db, assignmentId) {
  return db.prepare('SELECT * FROM pedagogical_feedback_versions WHERE assignment_id = ? ORDER BY revision DESC LIMIT 1').get(assignmentId);
}
function cycleDetail(db, teacherId, classPublicId, publicId, capabilities) {
  const { schoolClass, assignment } = ownedAssessment(db, teacherId, classPublicId, publicId);
  const current = evidence(db, assignment);
  const plans = capabilities.recovery ? db.prepare(`SELECT r.id AS internal_id, r.public_id AS id, r.title, r.status,
    p.status AS executionStatus,
    (SELECT COUNT(*) FROM teaching_plan_lessons l WHERE l.plan_id = p.id AND l.lesson_phase = 'intervention') AS interventionCount,
    (SELECT COUNT(*) FROM teaching_plan_lessons l WHERE l.plan_id = p.id AND l.lesson_phase = 'intervention'
      AND l.status IN ('taught', 'skipped')) AS interventionHandled
    FROM learning_recovery_plans r LEFT JOIN teaching_plans p ON p.source_recovery_plan_id = r.id
      AND p.owner_teacher_id = r.owner_teacher_id
    WHERE r.source_assignment_id = ? AND r.class_id = ? AND r.owner_teacher_id = ? ORDER BY r.id DESC LIMIT 21`)
    .all(assignment.id, schoolClass.id, teacherId) : [];
  const serializedPlans = plans.slice(0, 20).map(({ internal_id, ...plan }) => {
    const monitoring = serializeLearningRecoveryMonitoring(db, { recoveryPlanId: internal_id, teacherId });
    if (monitoring?.comparison) {
      // The cycle overview is class-level; individual follow-up stays in the protected results screen.
      delete monitoring.comparison.studentsNeedingFollowUp;
    }
    return { ...plan, monitoring };
  });
  if (current.snapshot) {
    current.snapshot.verifications = serializedPlans.filter(p => p.monitoring).map(p => ({
      planId: p.id, planStatus: p.status, ...p.monitoring,
    }));
    current.hash = hash([current.hash, current.snapshot.verifications]);
  }
  const previous = latestFeedback(db, assignment.id);
  const isDiagnostic = Boolean(db.prepare('SELECT 1 FROM diagnostic_question_sets WHERE question_set_id = ?').get(assignment.source_question_set_id));
  return { class: context(db, schoolClass, capabilities), capabilities,
    assessment: { id: assignment.public_id, title: assignment.title_snapshot, status: assignment.status,
      isDiagnostic, questionSetId: assignment.source_question_set_id, revision: assignment.revision },
    evidence: current.snapshot, evidenceHash: current.hash,
    feedback: feedback(previous, capabilities), feedbackStale: Boolean(previous && previous.evidence_hash !== current.hash),
    canSaveFeedback: schoolClass.status === 'active' && assignment.status === 'closed' && current.snapshot?.overview.submittedCount > 0,
    plans: serializedPlans, morePlans: plans.length > 20,
    notice: 'Resultados descritivos, não TRI. Uma diferença percentual não demonstra efeito causal da intervenção. Considere participação, itens e observações pedagógicas.' };
}
function feedbackHistory(db, teacherId, classPublicId, publicId, query, capabilities) {
  const { assignment } = ownedAssessment(db, teacherId, classPublicId, publicId);
  const before = positive(query.before, 2147483647);
  const rows = db.prepare(`SELECT * FROM pedagogical_feedback_versions
    WHERE assignment_id = ? AND revision < ? ORDER BY revision DESC LIMIT 11`).all(assignment.id, before);
  return { data: rows.slice(0, 10).map(row => feedback(row, capabilities)), nextBefore: rows.length > 10 ? rows[9].revision : null };
}
function saveFeedback(db, teacher, classPublicId, publicId, body, requestKey, req, capabilities = {}) {
  if (typeof requestKey !== 'string' || !/^[a-zA-Z0-9_-]{16,100}$/.test(requestKey))
    fail(400, 'invalid_request_key', 'Identificador de salvamento inválido. Atualize a página.');
  if (!body || Object.keys(body).some(key => ![...fields, 'expectedRevision', 'evidenceHash'].includes(key))
      || !Number.isInteger(body.expectedRevision) || body.expectedRevision < 0 || !/^[a-f0-9]{64}$/.test(body.evidenceHash || ''))
    fail(400, 'invalid_feedback', 'Informe a revisão e a referência dos resultados.');
  const normalized = Object.fromEntries(fields.map(key => {
    if (typeof body[key] !== 'string' || body[key].trim().length < 10 || body[key].trim().length > 2000)
      fail(400, 'invalid_feedback', 'Preencha cada campo com 10 a 2.000 caracteres.');
    return [key, body[key].trim()];
  }));
  const requestHash = hash([classPublicId, publicId, body.expectedRevision, body.evidenceHash, normalized]);
  return db.transaction(() => {
    const { schoolClass, assignment } = ownedAssessment(db, teacher.id, classPublicId, publicId);
    const previousRequest = db.prepare('SELECT * FROM pedagogical_feedback_versions WHERE owner_teacher_id = ? AND request_key = ?')
      .get(teacher.id, hash(requestKey));
    if (previousRequest) {
      if (previousRequest.request_hash !== requestHash) fail(409, 'request_conflict', 'Este salvamento já foi usado com outro conteúdo.');
      return { feedback: feedback(previousRequest, capabilities), replayed: true };
    }
    if (schoolClass.status !== 'active' || assignment.status !== 'closed')
      fail(409, 'assessment_not_ready', 'Encerre a aplicação de uma turma ativa antes de registrar a devolutiva.');
    const current = cycleDetail(db, teacher.id, classPublicId, publicId, capabilities);
    if (!current.evidence?.overview.submittedCount) fail(409, 'no_evidence', 'Registre ao menos uma correção antes da devolutiva.');
    if (current.evidenceHash !== body.evidenceHash) fail(409, 'evidence_changed', 'Os resultados mudaram. Recarregue e revise a devolutiva antes de salvar.');
    const latest = latestFeedback(db, assignment.id);
    if ((latest?.revision || 0) !== body.expectedRevision)
      fail(409, 'revision_conflict', 'Existe uma revisão mais recente. Recarregue antes de salvar.');
    const revision = body.expectedRevision + 1;
    db.prepare(`INSERT INTO pedagogical_feedback_versions
      (assignment_id, class_id, owner_teacher_id, revision, request_key, request_hash, evidence_hash,
       evidence_json, objective, observation, action, verification) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(assignment.id, schoolClass.id, teacher.id, revision, hash(requestKey), requestHash, current.evidenceHash,
        JSON.stringify(current.evidence), ...fields.map(key => normalized[key]));
    logActivityStrict({ user: teacher, action: 'pedagogical_feedback_saved', module: 'planning',
      entityType: 'class_assessment', entityId: assignment.id,
      description: 'Professor registrou uma revisão da devolutiva da turma.',
      metadata: { classId: classPublicId, assessmentId: publicId, revision, evidenceHash: current.evidenceHash }, req }, db);
    return { feedback: feedback(latestFeedback(db, assignment.id), capabilities), replayed: false };
  }).immediate();
}
function periodSelection(db, teacherId, classPublicId, query) {
  const row = ownedClass(db, teacherId, classPublicId);
  let period;
  try { period = require('./pedagogicalPeriod').periodBounds(query.start, query.end); }
  catch (error) { fail(400, 'invalid_period', error.message); }
  const where = `class_id = ? AND owner_teacher_id = ? AND status IN ('open', 'closed')
    AND julianday(opened_at) >= julianday(?) AND julianday(opened_at) < julianday(?)`;
  const args = [row.id, teacherId, period.from, period.until];
  const total = db.prepare(`SELECT COUNT(*) FROM class_assessment_assignments WHERE ${where}`).pluck().get(...args);
  return { row, period, where, args, total };
}
function periodAssessment(db, assignment) {
  const { participantCount, exemptedCount, submittedCount, pendingCount, meanPercentage } = loadAssessmentOverview(db, assignment.id);
  return { id: assignment.public_id, title: assignment.title_snapshot,
    status: assignment.status, questionCount: assignment.question_count,
    openedAt: new Date(`${assignment.opened_at.replace(' ', 'T')}${/[Zz]|[+-]\d\d:\d\d$/.test(assignment.opened_at) ? '' : 'Z'}`).toISOString(),
    overview: { participantCount, exemptedCount, submittedCount, pendingCount, meanPercentage } };
}
function periodOverview(db, teacherId, classPublicId, query, capabilities) {
  return db.transaction(() => {
    const { row, period, where, args, total } = periodSelection(db, teacherId, classPublicId, query);
    const limit = 10;
    const totalPages = Math.ceil(total / limit);
    const page = Math.min(positive(query.page), Math.max(1, totalPages));
    const rows = db.prepare(`SELECT * FROM class_assessment_assignments WHERE ${where}
      ORDER BY julianday(opened_at) DESC, id DESC LIMIT ? OFFSET ?`).all(...args, limit, (page - 1) * limit);
    return { version: 'class-period-v1', classId: row.public_id, period,
      generatedAt: new Date().toISOString(),
      assessments: rows.map(assignment => periodAssessment(db, assignment)),
      pagination: { page, limit, total, totalPages } };
  }).deferred();
}

// A separate bounded snapshot keeps ordinary ten-row queries inexpensive.
const PERIOD_COPY_LIMIT = 200;
function readPeriodCopy(db, teacherId, classPublicId, query, capabilities) {
  return db.transaction(() => {
    const { row, period, where, args, total } = periodSelection(db, teacherId, classPublicId, query);
    if (total > PERIOD_COPY_LIMIT) fail(422, 'period_copy_too_large', 'Há mais de 200 avaliações neste período. Escolha menos dias para guardar a planilha completa.');
    if (!total) fail(409, 'period_copy_empty', 'Não há avaliações iniciadas neste período. Consulte outras datas.');
    const rows = db.prepare(`SELECT * FROM class_assessment_assignments WHERE ${where}
      ORDER BY julianday(opened_at) DESC, id DESC LIMIT ?`).all(...args, PERIOD_COPY_LIMIT);
    const copy = { version: 'class-period-copy-v1', class: context(db, row, capabilities), period,
      assessments: rows.map(assignment => periodAssessment(db, assignment)), total, limit: PERIOD_COPY_LIMIT,
      notice: 'Resultados atuais das avaliações iniciadas no período, incluindo correções posteriores. Cada avaliação tem seus próprios participantes e questões. Não somamos participantes nem calculamos média geral: diferenças de notas não comprovam evolução da aprendizagem.',
      privacyNotice: 'A planilha não inclui nomes de estudantes, respostas ou registros pedagógicos. Nomes da turma e títulos das avaliações podem conter dados pessoais. Confira antes de compartilhar.' };
    // Bind the copy to corrections too, even if a rounded mean stays the same.
    const revisions = rows.map(assignment => [assignment.id, assignment.revision,
      db.prepare(`SELECT p.id, p.status, a.id AS attemptId, a.revision, a.status AS attemptStatus
        FROM class_assessment_participants p LEFT JOIN class_assessment_attempts a ON a.participant_id = p.id
        WHERE p.assignment_id = ? ORDER BY p.id, a.id`).all(assignment.id)]);
    return { ...copy, revision: hash([copy, revisions]), generatedAt: new Date().toISOString() };
  }).deferred();
}
module.exports = { PedagogicalCycleError, listClasses, classOverview, periodOverview, readPeriodCopy, cycleDetail, feedbackHistory, saveFeedback };
