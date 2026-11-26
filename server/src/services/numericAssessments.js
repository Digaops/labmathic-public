const { evaluateFeatureFlag } = require('./featureFlags');
const { load, serialize, numericValue, fail } = require('./numericQuestionDrafts');
const FEATURE = 'classes.numeric_assessments';
function enabled(db, actor) { return evaluateFeatureFlag(db, FEATURE, actor).enabled; }
// Migration rehearsals also use the submission service before migration 39.
function scoredResponses(db) {
  return db.prepare("SELECT 1 FROM sqlite_master WHERE type='view' AND name='class_assessment_scored_responses'").get()
    ? 'class_assessment_scored_responses' : '(SELECT *,NULL AS numeric_value FROM class_assessment_responses)';
}
function numericItems(db, assignmentId) {
  return new Map(db.prepare(`SELECT s.* FROM class_assessment_typed_item_snapshots s
    JOIN class_assessment_items a ON a.id=s.assessment_item_id
    JOIN class_assessment_numeric_origins origin ON origin.assignment_id=a.assignment_id
    WHERE a.assignment_id=? AND s.interaction_type='numeric' AND s.scoring_strategy='numeric_exact'`).all(assignmentId)
    .map(row => [row.assessment_item_id, JSON.parse(row.definition_json)]));
}
function normalizeNumericResponse(value) {
  if (value === null || value === '') return null;
  return JSON.stringify(numericValue(value));
}
function saveNumericResponse(db, attempt, itemId, value, definition) {
  const correct = value !== null && Number(value) === definition.answerKey.value ? 1 : 0;
  db.prepare(`INSERT INTO class_assessment_numeric_responses(attempt_id,assessment_item_id,assignment_id,class_id,owner_teacher_id,numeric_value,is_correct,answered_at)
    VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(attempt_id,assessment_item_id) DO UPDATE SET numeric_value=excluded.numeric_value,
      is_correct=excluded.is_correct,answered_at=excluded.answered_at,updated_at=CURRENT_TIMESTAMP`).run(
    attempt.id,itemId,attempt.assignment_id,attempt.class_id,attempt.owner_teacher_id,value,correct,value===null?null:new Date().toISOString());
}
function approvedNumeric(db, actor, publicId) {
  const row=load(db,actor,publicId);
  if(row.version_status!=='published' || row.review_status!=='approved' || !row.review_snapshot)
    fail(409,'numeric_approval_required','Escolha uma versão numérica aprovada pela administração.');
  return {row,draft:serialize(row)};
}
function numericSources(db, actor) {
  if(!enabled(db,actor))return [];
  const ids=db.prepare(`SELECT v.public_id FROM typed_question_item_versions v
    JOIN typed_question_items i ON i.id=v.item_id JOIN questions q ON q.id=i.question_id
    WHERE q.created_by=? AND q.question_type='numeric_draft' AND v.status='published'
      AND EXISTS(SELECT 1 FROM typed_question_review_cycles r JOIN numeric_question_review_snapshots s ON s.review_id=r.id
        WHERE r.version_id=v.id AND r.status='approved' AND r.definition_hash=v.definition_hash)
    ORDER BY v.updated_at DESC,v.id DESC LIMIT 200`).all(actor.id);
  return ids.map(({public_id})=>{const {draft}=approvedNumeric(db,actor,public_id);
    return {id:draft.publicId,questionCode:draft.code,title:draft.statement,version:draft.version,skillCode:draft.curriculum.skillCode,
      gradeName:draft.curriculum.gradeName,unit:draft.unit,supportText:draft.supportText};});
}
const sourceSearchConnections = new WeakSet();
const normalizeSourceText = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
function searchNumericSources(db, actor, { search = '', page = '1' } = {}) {
  if (!enabled(db, actor)) fail(404, 'numeric_feature_disabled', 'As atividades numéricas não estão disponíveis para esta conta.');
  if (typeof search !== 'string' || search.length > 100 || typeof page !== 'string'
    || !/^[1-9]\d{0,5}$/.test(page) || Number(page) > 100000) {
    fail(400, 'invalid_numeric_search', 'Confira a busca (até 100 caracteres) e a página.');
  }
  if (!sourceSearchConnections.has(db)) {
    db.function('numeric_source_text', { deterministic: true }, normalizeSourceText);
    sourceSearchConnections.add(db);
  }
  // Search the approved immutable definition and curriculum, not the mutable question draft.
  // Only safe display fields are selected; answer keys and review reasons never leave this query.
  const selection = `SELECT v.public_id AS id, q.question_code AS questionCode, v.version,
      json_extract(v.definition_json,'$.content.stem') AS title,
      coalesce(json_extract(v.definition_json,'$.content.unit'),'') AS unit,
      coalesce(json_extract(v.definition_json,'$.content.supportText'),'') AS supportText,
      json_extract(s.payload_json,'$.curriculum.skillCode') AS skillCode,
      json_extract(s.payload_json,'$.curriculum.gradeName') AS gradeName,
      v.updated_at AS sortDate, v.id AS sortId
    FROM typed_question_item_versions v JOIN typed_question_items i ON i.id=v.item_id
    JOIN questions q ON q.id=i.question_id
    JOIN typed_question_review_cycles r ON r.id=(SELECT id FROM typed_question_review_cycles
      WHERE version_id=v.id ORDER BY review_round DESC LIMIT 1)
    JOIN numeric_question_review_snapshots s ON s.review_id=r.id
    WHERE q.created_by=? AND i.created_by=q.created_by AND q.question_type='numeric_draft'
      AND q.source='teacher' AND q.status='inactive' AND i.status='draft'
      AND v.status='published' AND r.status='approved' AND r.definition_hash=v.definition_hash`;
  const term = normalizeSourceText(search.trim());
  const where = ` FROM (${selection}) WHERE (?='' OR instr(numeric_source_text(
    title || ' ' || skillCode || ' ' || gradeName || ' ' || questionCode),?)>0)`;
  const params = [actor.id, term, term];
  return db.transaction(() => {
    const total = db.prepare('SELECT count(*) AS total' + where).get(...params).total;
    const data = db.prepare('SELECT id,questionCode,version,title,unit,supportText,skillCode,gradeName' + where
      + ' ORDER BY sortDate DESC,sortId DESC LIMIT 20 OFFSET ?').all(...params, (Number(page) - 1) * 20);
    return { data, pagination: { page: Number(page), pageSize: 20, total, totalPages: Math.ceil(total / 20) } };
  })();
}
function loadNumericQuestions(db, actor, ids) {
  if(!enabled(db,actor))fail(404,'numeric_feature_disabled','As atividades numéricas não estão disponíveis para esta conta.');
  if(!Array.isArray(ids)||ids.length<1||ids.length>100||new Set(ids).size!==ids.length)
    fail(400,'invalid_numeric_selection','Selecione de 1 a 100 questões numéricas aprovadas, sem repetir versões.');
  const result=ids.map((id,sortOrder)=>{
    const {row,draft:d}=approvedNumeric(db,actor,id);
    return {sourceQuestionId:row.question_id,sourceSkillId:d.curriculum.skillId,questionCode:d.code,
      skillCode:d.curriculum.skillCode,skillDescription:d.curriculum.skillDescription,statement:d.statement,
      supportText:d.supportText||null,imagePath:null,developmentSpace:'medium',difficulty:d.difficulty,
      // The immutable typed snapshot is authoritative; the legacy CHECK is untouched.
      questionType:'multiple_choice',explanation:d.explanation,sortOrder,showImage:0,options:[],typed:row};
  });
  if(new Set(result.map(q=>q.sourceQuestionId)).size!==result.length)
    fail(400,'duplicate_numeric_question','Escolha apenas uma versão de cada questão nesta atividade.');
  return result;
}
function insertNumericSnapshot(db,itemId,row) {
  db.prepare(`INSERT INTO class_assessment_typed_item_snapshots(assessment_item_id,typed_item_id,typed_version_id,
    engine_version,format_version,interaction_type,correction_mode,scoring_strategy,partial_credit,definition_json,definition_hash)
    SELECT ?,item_id,id,engine_version,format_version,interaction_type,correction_mode,scoring_strategy,partial_credit,definition_json,definition_hash
    FROM typed_question_item_versions WHERE id=?`).run(itemId,row.id);
}
function numericDiagnostic(db, assignment) {
  const origin=db.prepare('SELECT teacher_reviewed_at FROM class_assessment_numeric_origins WHERE assignment_id=? AND owner_teacher_id=?')
    .get(assignment.id,assignment.owner_teacher_id);
  return origin ? {algorithm_version:'teacher-numeric-exact-v1',confirmation_version:'numeric-teacher-review-v1',reviewed_at:origin.teacher_reviewed_at} : null;
}
module.exports={FEATURE,enabled,scoredResponses,numericItems,normalizeNumericResponse,saveNumericResponse,
  numericSources,searchNumericSources,loadNumericQuestions,insertNumericSnapshot,numericDiagnostic};
