const { randomUUID, createHash } = require('node:crypto');
const { evaluateFeatureFlag } = require('./featureFlags');
const { runIdempotent, TypedQuestionAuthoringError } = require('./typedQuestionAuthoring');
const { compileTypedQuestionDefinition, scoreTypedQuestionResponse } = require('./typedQuestionEngine');

const FEATURE_KEY = 'question_bank.numeric_drafts';
const fail = (status, code, message) => { throw new TypedQuestionAuthoringError(status, code, message); };
function integer(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) fail(400, 'invalid_numeric_draft', `Confira ${label}.`);
  return value;
}
function text(value, label, max, optional = false) {
  if (typeof value !== 'string') fail(400, 'invalid_numeric_draft', `Confira ${label}.`);
  const result = value.trim().replace(/\r\n?/g, '\n');
  if ((!optional && !result) || result.length > max) fail(400, 'invalid_numeric_draft', `Confira ${label}: até ${max} caracteres.`);
  return result;
}
function numericValue(value) {
  // Deliberately bounded decimal input: no silent rounding of long answers, units or thousands.
  if (typeof value !== 'string' || !/^[+-]?(?:\d{1,9}(?:[.,]\d{1,6})?|[.,]\d{1,6})$/.test(value.trim())) {
    fail(400, 'invalid_numeric_value', 'Use apenas um número, sem separador de milhar: até 9 algarismos antes e 6 depois da vírgula. Ex.: -2,5.');
  }
  const result = Number(value.trim().replace(',', '.'));
  return Object.is(result, -0) ? 0 : result;
}
function principalFor(db, actor, role = 'professor') {
  const principal = db.prepare('SELECT id, email, role FROM users WHERE id = ?').get(integer(actor?.id, 'a sessão'));
  if (!principal) fail(401, 'invalid_principal', 'Entre novamente para continuar.');
  if (principal.role !== role) fail(403, 'role_required', role === 'admin' ? 'Este espaço é reservado à administração revisora.' : 'Este espaço é reservado ao professor autor.');
  if (!evaluateFeatureFlag(db, FEATURE_KEY, principal).enabled) fail(404, 'feature_disabled', 'Os rascunhos numéricos não estão disponíveis para esta conta.');
  return principal;
}
function curriculum(db, input) {
  const row = db.prepare(`SELECT s.id AS skillId, s.code AS skillCode, s.description AS skillDescription,
    g.id AS gradeId, g.name AS gradeName, u.id AS unitId, u.name AS unitName
    FROM bncc_skills s JOIN grades g ON g.id = s.grade_id JOIN bncc_units u ON u.id = s.unit_id
    WHERE s.id = ? AND s.grade_id = ? AND s.unit_id = ?`).get(
    integer(input.skillId, 'a habilidade'), integer(input.gradeId, 'o ano escolar'), integer(input.unitId, 'a unidade temática'));
  if (!row) fail(400, 'invalid_curriculum', 'A habilidade deve pertencer ao ano escolar e à unidade selecionados.');
  return row;
}
function compileInput(input) {
  const stem = text(input.statement, 'o enunciado', 10000);
  const supportText = text(input.supportText, 'o texto de apoio', 10000, true);
  const unit = text(input.unit, 'a unidade da resposta', 100, true);
  const explanation = text(input.explanation, 'a resolução', 5000, true);
  if (!['facil', 'media', 'dificil'].includes(input.difficulty)) fail(400, 'invalid_numeric_draft', 'Selecione a dificuldade.');
  return compileTypedQuestionDefinition({
    interactionType: 'numeric', content: { stem, supportText: supportText || null, unit: unit || null },
    scoring: { strategy: 'numeric_exact', partialCredit: false }, answerKey: { value: numericValue(input.answer) },
    accessibility: { responseLabel: 'Resposta numérica', instructions: 'Digite apenas o número. Use vírgula ou ponto decimal, sem separador de milhar.' },
    print: { supported: true, layout: 'answer_box', instructions: 'Escreva apenas o número no espaço de resposta.', answerSpaceLines: 2 },
    feedback: { releasePolicy: 'teacher_only', general: explanation || null, correct: null, incorrect: null, choiceFeedback: {} },
  });
}
const SELECT = `SELECT v.id, v.public_id, v.item_id, v.revision, v.version, v.status AS version_status, v.definition_hash, v.definition_json, v.updated_at,
  i.public_id AS item_public_id, q.id AS question_id, q.question_code, q.difficulty,
  r.public_id AS review_public_id, r.status AS review_status, r.revision AS review_revision, r.decision_reason,
  r.submitted_at, r.decided_at, rs.payload_json AS review_snapshot,
  s.id AS skillId, s.code AS skillCode, s.description AS skillDescription,
  g.id AS gradeId, g.name AS gradeName, u.id AS unitId, u.name AS unitName
  FROM typed_question_item_versions v JOIN typed_question_items i ON i.id = v.item_id
  JOIN questions q ON q.id = i.question_id JOIN bncc_skills s ON s.id = q.skill_id
  JOIN grades g ON g.id = s.grade_id JOIN bncc_units u ON u.id = s.unit_id
  LEFT JOIN typed_question_review_cycles r ON r.id=(SELECT id FROM typed_question_review_cycles WHERE version_id=v.id ORDER BY review_round DESC LIMIT 1)
  LEFT JOIN numeric_question_review_snapshots rs ON rs.review_id=r.id
  WHERE q.question_type = 'numeric_draft' AND q.source = 'teacher' AND q.status = 'inactive'
    AND q.created_by = ? AND i.created_by = q.created_by AND v.status IN ('draft','published') AND i.status = 'draft'`;
function load(db, principal, publicId) {
  if (typeof publicId !== 'string' || !/^[a-f0-9-]{36}$/i.test(publicId)) fail(404, 'numeric_draft_not_found', 'Rascunho não encontrado.');
  const row = db.prepare(SELECT + ' AND v.public_id = ? COLLATE NOCASE').get(principal.id, publicId);
  if (!row) fail(404, 'numeric_draft_not_found', 'Rascunho não encontrado.');
  return row;
}
function serialize(row, includeAnswer = true) {
  const definition = JSON.parse(row.definition_json);
  const frozen = row.version_status === 'published' && row.review_snapshot ? JSON.parse(row.review_snapshot) : null;
  const result = {
    publicId: row.public_id, revision: row.revision, version: row.version, code: row.question_code, status: row.version_status === 'published' ? 'approved' : 'draft',
    statement: definition.content.stem, difficulty: frozen?.difficulty || row.difficulty, updatedAt: row.updated_at,
    curriculum: frozen?.curriculum || Object.fromEntries(['skillId','skillCode','skillDescription','gradeId','gradeName','unitId','unitName'].map(key => [key, row[key]])),
    review: row.review_public_id ? { publicId: row.review_public_id, status: row.review_status, revision: row.review_revision,
      reason: row.decision_reason, submittedAt: row.submitted_at, decidedAt: row.decided_at } : null,
  };
  if (includeAnswer) Object.assign(result, { supportText: definition.content.supportText || '', unit: definition.content.unit || '',
    answer: String(definition.answerKey.value).replace('.', ','), explanation: definition.feedback.general || '', strategy: 'numeric_exact' });
  return result;
}
function getNumericDraft(db, { actor, publicId }) {
  const principal = principalFor(db, actor);
  return numericDetail(db, load(db, principal, publicId));
}
function numericDetail(db, row) {
  return { ...serialize(row), versions: db.prepare(`SELECT public_id AS publicId, version, CASE status WHEN 'published' THEN 'approved' ELSE 'draft' END AS status
    FROM typed_question_item_versions WHERE item_id=? ORDER BY version DESC LIMIT 50`).all(row.item_id),
    reviews: db.prepare(`SELECT public_id AS publicId, status, revision, decision_reason AS reason, submitted_at AS submittedAt, decided_at AS decidedAt
      FROM typed_question_review_cycles WHERE version_id=? ORDER BY review_round DESC LIMIT 50`).all(row.id) };
}
function listNumericDrafts(db, { actor, page = 1, search = '' }) {
  const principal = principalFor(db, actor);
  integer(page, 'a página');
  if (page > 100000) fail(400, 'invalid_page', 'Página inválida.');
  const term = text(search, 'a busca', 100, true);
  return db.transaction(() => {
    const where = ` AND v.version=(SELECT MAX(version) FROM typed_question_item_versions WHERE item_id=i.id)
      AND (? = '' OR instr(lower(q.statement), lower(?)) > 0 OR instr(lower(q.question_code), lower(?)) > 0)`;
    const params = [principal.id, term, term, term];
    const total = db.prepare(`SELECT count(*) AS total FROM (${SELECT + where})`).get(...params).total;
    const rows = db.prepare(SELECT + where + ' ORDER BY v.updated_at DESC, v.id DESC LIMIT 10 OFFSET ?').all(...params, (page - 1) * 10);
    return { data: rows.map(row => serialize(row, false)), pagination: { page, total, totalPages: Math.ceil(total / 10) } };
  })();
}
function saveNumericDraft(db, { actor, publicId, input, idempotencyKey }) {
  const principal = principalFor(db, actor);
  const compiled = compileInput(input);
  const context = curriculum(db, input);
  const expectedRevision = publicId ? integer(input.expectedRevision, 'a revisão') : null;
  const operation = runIdempotent(db, {
    principal, idempotencyKey, operationType: publicId ? 'update_draft' : 'adopt_question',
    fingerprintPayload: { scope: 'numeric_draft', publicId: publicId || null, expectedRevision,
      skillId: context.skillId, definitionHash: compiled.definitionHash, difficulty: input.difficulty },
    perform() {
      let itemId, versionId, versionPublicId, itemPublicId;
      if (publicId) {
        const row = load(db, principal, publicId);
        if (row.version_status !== 'draft' || row.review_status === 'pending') fail(409, 'numeric_draft_locked', 'A versão está aprovada ou em revisão. Retire o envio ou crie uma nova versão antes de editar.');
        if (row.skillId !== context.skillId) fail(409, 'numeric_curriculum_locked', 'O vínculo BNCC deste rascunho é preservado. Crie outro para mudar a habilidade.');
        if (row.revision !== expectedRevision) fail(409, 'stale_numeric_draft', 'Este rascunho foi alterado em outro acesso. Reabra a versão salva antes de editar novamente.');
        db.prepare(`UPDATE typed_question_item_versions SET definition_json = ?, definition_hash = ?,
          revision = revision + 1, updated_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND revision = ?`)
          .run(compiled.definitionJson, compiled.definitionHash, principal.id, row.id, expectedRevision);
        db.prepare(`UPDATE questions SET statement = ?, support_text = ?, difficulty = ?, official_explanation = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`)
          .run(compiled.definition.content.stem, compiled.definition.content.supportText, input.difficulty, compiled.definition.feedback.general, row.question_id);
        itemId = row.item_id; versionId = row.id; versionPublicId = row.public_id; itemPublicId = row.item_public_id;
      } else {
        const questionId = db.prepare(`INSERT INTO questions (question_code, skill_id, statement, support_text,
          difficulty, question_type, official_explanation, status, reviewed, source, created_by)
          VALUES (?, ?, ?, ?, ?, 'numeric_draft', ?, 'inactive', 0, 'teacher', ?)`).run(
          'NUM-' + randomUUID(), context.skillId, compiled.definition.content.stem, compiled.definition.content.supportText,
          input.difficulty, compiled.definition.feedback.general, principal.id).lastInsertRowid;
        itemPublicId = randomUUID(); versionPublicId = randomUUID();
        itemId = db.prepare('INSERT INTO typed_question_items(public_id,question_id,created_by,updated_by) VALUES(?,?,?,?)')
          .run(itemPublicId, questionId, principal.id, principal.id).lastInsertRowid;
        const m = compiled.metadata;
        versionId = db.prepare(`INSERT INTO typed_question_item_versions(public_id,item_id,version,engine_version,
          format_version,interaction_type,correction_mode,scoring_strategy,partial_credit,accessibility_ready,
          print_supported,definition_json,definition_hash,created_by,updated_by) VALUES(?,?,1,?,?,?,?,?,0,1,1,?,?,?,?)`)
          .run(versionPublicId, itemId, m.engineVersion, m.formatVersion, m.interactionType, m.correctionMode,
            m.scoringStrategy, compiled.definitionJson, compiled.definitionHash, principal.id, principal.id).lastInsertRowid;
      }
      return { itemId, versionId, result: { itemPublicId, versionPublicId, reviewPublicId: null,
        savedRevision: expectedRevision === null ? 1 : expectedRevision + 1,
        definitionHash: compiled.definitionHash, skillId: context.skillId, difficulty: input.difficulty } };
    },
  });
  return { ...numericDetail(db, load(db, principal, operation.result.versionPublicId)), replayed: operation.replayed };
}
function checkNumericDraft(db, { actor, publicId, expectedRevision, response }) {
  const principal = principalFor(db, actor);
  const row = load(db, principal, publicId);
  if (row.revision !== integer(expectedRevision, 'a revisão')) fail(409, 'stale_numeric_draft', 'Reabra o rascunho: a versão salva mudou.');
  const value = response === '' ? null : numericValue(response);
  const score = scoreTypedQuestionResponse(row.definition_json, { value });
  return { answered: value !== null, accepted: score.score === 1, revision: row.revision };
}
function previewNumericDraft(db, { actor, publicId, expectedRevision }) {
  const principal = principalFor(db, actor);
  const row = load(db, principal, publicId);
  if (row.revision !== integer(expectedRevision, 'a revisão')) fail(409, 'stale_numeric_draft', 'Reabra o rascunho: a versão salva mudou.');
  const draft = serialize(row);
  // Include curriculum and difficulty, not just the typed definition: either can affect the copy.
  const fingerprint = createHash('sha256').update(JSON.stringify(draft)).digest('hex');
  return { kind: 'numeric-draft-preview-v1', draft, fingerprint };
}
function prepareNumericDraftPrint(db, input, recordAudit) {
  const audience = input.audience ?? 'teacher';
  if (!['teacher','student'].includes(audience)) fail(400,'invalid_print_audience','Escolha a cópia do professor ou do estudante.');
  if (typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    fail(400, 'invalid_numeric_preview', 'Abra a prévia salva antes de preparar a cópia.');
  }
  return db.transaction(() => {
    const preview = previewNumericDraft(db, input);
    if (audience === 'student' && preview.draft.status !== 'approved') fail(409,'numeric_approval_required','A cópia sem gabarito fica disponível após a aprovação editorial.');
    if (preview.fingerprint !== input.expectedFingerprint) fail(409, 'stale_numeric_preview', 'A questão ou sua classificação mudou. Reabra o rascunho e confira a prévia novamente.');
    // The route supplies the strict recorder; no database singleton is imported by this service.
    if (typeof recordAudit !== 'function') throw new Error('numeric_print_audit_required');
    recordAudit({ user: input.actor, action: 'numeric_draft_print_prepared', module: 'question_bank',
      entityType: 'question', description: audience === 'student' ? 'Professor preparou uma cópia aprovada sem gabarito para uso em papel.' : 'Professor preparou uma cópia privada com gabarito para conferência.',
      metadata: { versionPublicId: preview.draft.publicId, revision: preview.draft.revision, fingerprint: preview.fingerprint,
        purpose: audience === 'student' ? 'approved_student_paper' : 'teacher_draft_review' } }, db);
    return preview;
  }).immediate();
}
module.exports = { FEATURE_KEY, numericValue, getNumericDraft, listNumericDrafts, saveNumericDraft, checkNumericDraft,
  previewNumericDraft, prepareNumericDraftPrint, principalFor, load, serialize, numericDetail, integer, fail };
