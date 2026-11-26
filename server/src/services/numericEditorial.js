const { randomUUID } = require('node:crypto');
const { runIdempotent } = require('./typedQuestionAuthoring');
const { principalFor, load, serialize, numericDetail, integer, fail } = require('./numericQuestionDrafts');

function reviewRow(db, id) {
  const row = db.prepare(`SELECT r.*, v.public_id AS version_public_id, v.revision AS current_revision,
    v.status AS version_status, v.definition_hash AS current_hash, i.public_id AS item_public_id, u.name AS author_name,
    s.payload_json FROM typed_question_review_cycles r JOIN typed_question_item_versions v ON v.id=r.version_id
    JOIN typed_question_items i ON i.id=r.item_id JOIN questions q ON q.id=i.question_id
    JOIN users u ON u.id=r.submitted_by JOIN numeric_question_review_snapshots s ON s.review_id=r.id
    WHERE r.public_id=? COLLATE NOCASE AND q.question_type='numeric_draft'`).get(id);
  if (!row) fail(404,'numeric_review_not_found','Revisão não encontrada.');
  return row;
}
const reviewView = r => ({ publicId:r.public_id, revision:r.revision, status:r.status, reason:r.decision_reason,
  submittedAt:r.submitted_at, decidedAt:r.decided_at, authorName:r.author_name, versionPublicId:r.version_public_id,
  draft:JSON.parse(r.payload_json) });
function listNumericReviews(db,{actor,page=1,status='pending'}) {
  principalFor(db,actor,'admin'); integer(page,'a página');
  if(page>100000 || !['pending','approved','rejected','cancelled'].includes(status)) fail(400,'invalid_review_filter','Confira o filtro da revisão.');
  return db.transaction(()=>{
    const from=`FROM typed_question_review_cycles r JOIN numeric_question_review_snapshots s ON s.review_id=r.id
      JOIN typed_question_item_versions v ON v.id=r.version_id JOIN users u ON u.id=r.submitted_by WHERE r.status=?`;
    const total=db.prepare('SELECT count(*) '+from).pluck().get(status);
    const data=db.prepare('SELECT r.public_id AS publicId,r.revision,r.status,r.submitted_at AS submittedAt,u.name AS authorName,'
      +"json_extract(s.payload_json,'$.statement') AS statement,json_extract(s.payload_json,'$.curriculum.skillCode') AS skillCode "+from
      +' ORDER BY r.submitted_at ASC,r.id ASC LIMIT 10 OFFSET ?').all(status,(page-1)*10);
    return {data,pagination:{page,total,totalPages:Math.ceil(total/10)}};
  })();
}
function getNumericReview(db,{actor,publicId}) { principalFor(db,actor,'admin');return reviewView(reviewRow(db,publicId)); }
function submitNumericReview(db,{actor,publicId,expectedRevision,confirmed,idempotencyKey}) {
  const principal=principalFor(db,actor);integer(expectedRevision,'a revisão');
  if(confirmed!==true)fail(400,'numeric_review_confirmation_required','Confira a pergunta, a habilidade e o gabarito antes de enviar.');
  const operation=runIdempotent(db,{principal,idempotencyKey,operationType:'submit_review',
    fingerprintPayload:{scope:'numeric_editorial',publicId,expectedRevision,confirmed},perform(){
      const row=load(db,principal,publicId);
      if(row.version_status!=='draft' || row.review_status==='pending' || row.revision!==expectedRevision)fail(409,'numeric_review_conflict','A questão mudou ou já está em revisão. Reabra a versão salva.');
      const snapshot=serialize(row);
      if(snapshot.explanation.trim().length<10)fail(400,'numeric_explanation_required','Registre como chegar à resposta, com pelo menos 10 caracteres, antes de enviar para revisão.');
      const round=db.prepare('SELECT COALESCE(MAX(review_round),0)+1 FROM typed_question_review_cycles WHERE version_id=?').pluck().get(row.id);
      if(round>50)fail(409,'numeric_review_limit','Esta versão atingiu o limite de envios para revisão.');
      const reviewPublicId=randomUUID();
      const reviewId=db.prepare(`INSERT INTO typed_question_review_cycles(public_id,item_id,version_id,review_round,version_revision,definition_hash,submitted_by)
        VALUES(?,?,?,?,?,?,?)`).run(reviewPublicId,row.item_id,row.id,round,row.revision,row.definition_hash,principal.id).lastInsertRowid;
      // Freeze the exact text, answer and BNCC context sent, including rejected/withdrawn rounds.
      delete snapshot.review;
      db.prepare('INSERT INTO numeric_question_review_snapshots(review_id,payload_json) VALUES(?,?)').run(reviewId,JSON.stringify(snapshot));
      return {itemId:row.item_id,versionId:row.id,reviewId,result:{versionPublicId:row.public_id,reviewPublicId}};
    }});
  return {...numericDetail(db,load(db,principal,operation.result.versionPublicId)),replayed:operation.replayed};
}
function decideNumericReview(db,{actor,publicId,expectedRevision,decision,reason,idempotencyKey}) {
  const principal=principalFor(db,actor,decision==='cancelled'?'professor':'admin');
  integer(expectedRevision,'a revisão');
  if(!['approved','rejected','cancelled'].includes(decision))fail(400,'invalid_numeric_decision','Escolha aprovar ou pedir ajustes.');
  if(typeof reason!=='string'||reason.trim().length<10||reason.trim().length>1000)fail(400,'numeric_review_reason_required','Explique a decisão em 10 a 1.000 caracteres.');
  const normalized=reason.trim();
  const operation=runIdempotent(db,{principal,idempotencyKey,operationType:{approved:'approve_review',rejected:'reject_review',cancelled:'cancel_review'}[decision],
    fingerprintPayload:{scope:'numeric_editorial',publicId,expectedRevision,decision,reason:normalized},perform(){
      const review=reviewRow(db,publicId);
      if(decision==='cancelled' && review.submitted_by!==principal.id)fail(404,'numeric_review_not_found','Revisão não encontrada.');
      if(decision!=='cancelled' && review.submitted_by===principal.id)fail(403,'independent_reviewer_required','O autor não pode revisar a própria questão.');
      if(review.status!=='pending'||review.revision!==expectedRevision||review.current_revision!==review.version_revision
        ||review.version_status!=='draft'||review.current_hash!==review.definition_hash)fail(409,'numeric_review_conflict','Esta revisão mudou. Reabra antes de decidir.');
      db.prepare(`UPDATE typed_question_review_cycles SET status=?,decided_by=?,decided_at=CURRENT_TIMESTAMP,
        decision_reason=?,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=? AND revision=?`)
        .run(decision,principal.id,normalized,review.id,expectedRevision);
      if(decision==='approved')db.prepare(`UPDATE typed_question_item_versions SET status='published',revision=revision+1,
        published_by=?,published_at=CURRENT_TIMESTAMP,updated_by=?,updated_at=CURRENT_TIMESTAMP WHERE id=?`)
        .run(principal.id,principal.id,review.version_id);
      return {itemId:review.item_id,versionId:review.version_id,reviewId:review.id,
        result:{reviewPublicId:review.public_id,versionPublicId:review.version_public_id}};
    }});
  const review=reviewRow(db,operation.result.reviewPublicId);
  return decision==='cancelled' ? {...numericDetail(db,load(db,principal,review.version_public_id)),replayed:operation.replayed}
    : {...reviewView(review),replayed:operation.replayed};
}
function createNumericVersion(db,{actor,publicId,expectedRevision,idempotencyKey}) {
  const principal=principalFor(db,actor);integer(expectedRevision,'a revisão');
  const operation=runIdempotent(db,{principal,idempotencyKey,operationType:'create_version',
    fingerprintPayload:{scope:'numeric_editorial',publicId,expectedRevision},perform(){
      const row=load(db,principal,publicId);
      if(row.version_status!=='published'||row.revision!==expectedRevision)fail(409,'numeric_version_conflict','Crie uma nova versão a partir da questão aprovada.');
      const latest=db.prepare('SELECT MAX(version) FROM typed_question_item_versions WHERE item_id=?').pluck().get(row.item_id);
      if(latest!==row.version)fail(409,'numeric_version_exists','Já existe uma versão mais recente. Volte à lista de questões.');
      if(latest>=50)fail(409,'numeric_version_limit','Esta questão atingiu o limite de 50 versões.');
      const nextId=randomUUID();
      const versionId=db.prepare(`INSERT INTO typed_question_item_versions(public_id,item_id,version,engine_version,format_version,
        interaction_type,correction_mode,scoring_strategy,partial_credit,accessibility_ready,print_supported,
        definition_json,definition_hash,created_by,updated_by) SELECT ?,item_id,version+1,engine_version,format_version,
        interaction_type,correction_mode,scoring_strategy,partial_credit,accessibility_ready,print_supported,definition_json,definition_hash,?,?
        FROM typed_question_item_versions WHERE id=?`).run(nextId,principal.id,principal.id,row.id).lastInsertRowid;
      const snapshot=serialize(row);
      db.prepare('UPDATE questions SET difficulty=? WHERE id=?').run(snapshot.difficulty,row.question_id);
      return {itemId:row.item_id,versionId,result:{versionPublicId:nextId}};
    }});
  return {...numericDetail(db,load(db,principal,operation.result.versionPublicId)),replayed:operation.replayed};
}
module.exports={listNumericReviews,getNumericReview,submitNumericReview,decideNumericReview,createNumericVersion};
