const test=require('node:test'), assert=require('node:assert/strict');
const fs=require('node:fs'), os=require('node:os'), path=require('node:path'), {randomUUID}=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'labmathic-numeric-editorial-'));
process.env.DB_PATH=path.join(directory,'database.sqlite');process.env.UPLOAD_DIR=path.join(directory,'uploads');
process.env.NODE_ENV='test';process.env.APP_ENV='development';process.env.JWT_SECRET='numeric-editorial-synthetic-secret-only-long-enough';
const db=require('../src/database'), express=require('express'), jwt=require('jsonwebtoken');
const app=express();app.use(express.json());app.use('/numeric',require('../src/routes/numericQuestionDrafts'));
app.use('/bank',require('../src/routes/questionBank'));
let server,origin,teacher,other,admin,unreleased,input;
function user(name,role='professor') {return {id:Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES(?,?,'synthetic',?)").run(name,name+'@test.invalid',role).lastInsertRowid),role};}
async function req(url,{who=teacher,method='GET',body,key=randomUUID()}={}) {
  const r=await fetch(origin+url,{method,headers:{'Content-Type':'application/json','Idempotency-Key':key,...(who?{Authorization:'Bearer '+jwt.sign(who,process.env.JWT_SECRET,{expiresIn:'15m'})}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
async function ok(url,options,status=200){const r=await req(url,options);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;}
const create=()=>ok('/numeric',{method:'POST',body:input},201);
const submit=(d,key=randomUUID())=>ok(`/numeric/${d.publicId}/submit-review`,{method:'POST',body:{expectedRevision:d.revision,confirmed:true},key});
const decision=(d,action='approved',key=randomUUID())=>ok(`/numeric/reviews/${d.review.publicId}/decision`,{who:admin,method:'POST',body:{expectedRevision:d.review.revision,decision:action,reason:action==='approved'?'Enunciado e resolução conferidos.':'Explique melhor a divisão na resolução.'},key});
test.before(async()=>{
  teacher=user('author');other=user('other');admin=user('reviewer','admin');unreleased=user('unreleased','admin');
  db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key IN ('question_bank.numeric_drafts','question_bank.typed_engine')").run();
  for(const flag of db.prepare("SELECT id FROM feature_flags WHERE flag_key IN ('question_bank.numeric_drafts','question_bank.typed_engine')").all())for(const u of [teacher,other,admin])db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES(?,?,1,'Teste isolado',?,?)").run(flag.id,u.id,admin.id,admin.id);
  const gradeId=Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('6º Ano editorial',6)").run().lastInsertRowid);
  const unitId=Number(db.prepare("INSERT INTO bncc_units(name,sort_order) VALUES('Números editorial',1)").run().lastInsertRowid);
  const skillId=Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES('EF06MA11-ED','Resolver problemas decimais.',?,?)").run(gradeId,unitId).lastInsertRowid);
  input={gradeId,unitId,skillId,statement:'Qual é a metade de 5 litros?',answer:'2,5',unit:'litros',explanation:'Divida 5 por 2 para encontrar 2,5.',supportText:'',difficulty:'media'};
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(directory,{recursive:true,force:true});});

test('envio exige confirmação, resolução, dono e revisão atual; fila exige administrador liberado',async()=>{
  const d=await create(),url=`/numeric/${d.publicId}/submit-review`;
  assert.equal((await req(url,{method:'POST',body:{expectedRevision:d.revision}})).status,400);
  assert.equal((await req(url,{who:other,method:'POST',body:{expectedRevision:1,confirmed:true}})).status,404);
  assert.equal((await req(url,{method:'POST',body:{expectedRevision:9,confirmed:true}})).status,409);
  const short=await ok('/numeric',{method:'POST',body:{...input,explanation:''}},201);
  assert.equal((await req(`/numeric/${short.publicId}/submit-review`,{method:'POST',body:{expectedRevision:1,confirmed:true}})).status,400);
  for(const [who,status] of [[null,401],[teacher,403],[unreleased,404]])assert.equal((await req('/numeric/reviews/queue',{who})).status,status);
  for(const query of ['?page=0','?page=100001','?status=unknown'])assert.equal((await req('/numeric/reviews/queue'+query,{who:admin})).status,400);
});
test('envio idempotente congela versão e classificação; revisão antiga não acessa fila numérica',async()=>{
  const d=await create(),key=randomUUID(),sent=await submit(d,key);
  assert.equal(sent.review.status,'pending');assert.equal((await submit(d,key)).replayed,true);
  assert.equal((await req(`/numeric/${d.publicId}/submit-review`,{method:'POST',body:{expectedRevision:1,confirmed:true}})).status,409);
  assert.equal((await req(`/numeric/${d.publicId}`,{method:'PATCH',body:{...input,expectedRevision:1}})).status,409);
  const review=await ok(`/numeric/reviews/${sent.review.publicId}`,{who:admin});
  assert.equal(review.draft.answer,'2,5');assert.equal(review.draft.curriculum.skillCode,input.skillId?'EF06MA11-ED':'');
  assert.throws(()=>db.prepare("UPDATE numeric_question_review_snapshots SET payload_json='{}'").run(),/immutable/);
  const {listTypedReviewQueue,decideTypedReview}=require('../src/services/typedQuestionAuthoring');
  assert.equal(listTypedReviewQueue(db,{actor:admin}).some(r=>r.publicId===sent.review.publicId),false);
  assert.throws(()=>decideTypedReview(db,{actor:admin,reviewPublicId:sent.review.publicId,expectedRevision:1,decision:'approved',reason:'Revisão antiga deve recusar.',idempotencyKey:randomUUID()}));
});
test('retirar, ajustar e reenviar preserva histórico e não permite retirada por outro professor',async()=>{
  const d=await create(),sent=await submit(d),url=`/numeric/reviews/${sent.review.publicId}/withdraw`;
  assert.equal((await req(url,{who:other,method:'POST',body:{expectedRevision:1}})).status,404);
  const cancelled=await ok(url,{method:'POST',body:{expectedRevision:1}});assert.equal(cancelled.review.status,'cancelled');
  const updated=await ok(`/numeric/${d.publicId}`,{method:'PATCH',body:{...input,explanation:'Divida o total de litros em duas partes iguais.',expectedRevision:1}});
  const again=await submit(updated);assert.equal(again.reviews.length,2);assert.notEqual(again.review.publicId,sent.review.publicId);
  const prior=await ok(`/numeric/reviews/${sent.review.publicId}`,{who:admin});assert.equal(prior.draft.explanation,input.explanation);
  assert.equal(prior.status,'cancelled');
});
test('pedido de ajustes explica a decisão e aprovação exige a revisão atual sem duplicar',async()=>{
  const sent=await submit(await create());
  assert.equal((await req(`/numeric/reviews/${sent.review.publicId}/decision`,{who:admin,method:'POST',body:{expectedRevision:1,decision:'rejected',reason:'curto'}})).status,400);
  await decision(sent,'rejected');
  const returned=await ok(`/numeric/${sent.publicId}`);assert.equal(returned.review.status,'rejected');assert.match(returned.review.reason,/divisão/);
  const changed=await ok(`/numeric/${sent.publicId}`,{method:'PATCH',body:{...input,explanation:'Separe cinco litros igualmente entre duas pessoas.',expectedRevision:1}});
  const again=await submit(changed),key=randomUUID();await decision(again,'approved',key);
  assert.equal((await decision(again,'approved',key)).replayed,true);
  assert.equal((await req(`/numeric/reviews/${again.review.publicId}/decision`,{who:admin,method:'POST',body:{expectedRevision:1,decision:'rejected',reason:'Não sobrescrever uma decisão final.'}})).status,409);
  const approved=await ok(`/numeric/${sent.publicId}`);assert.equal(approved.status,'approved');assert.equal(approved.revision,3);
  assert.equal((await req(`/numeric/${sent.publicId}`,{method:'PATCH',body:{...input,expectedRevision:3}})).status,409);
});
test('nova versão preserva aprovação, BNCC e gabarito anteriores; lista traz só a mais recente',async()=>{
  const sent=await submit(await create());await decision(sent);const approved=await ok(`/numeric/${sent.publicId}`);
  const key=randomUUID(),url=`/numeric/${approved.publicId}/versions`,body={expectedRevision:approved.revision};
  const next=await ok(url,{method:'POST',body,key});assert.equal(next.version,2);assert.equal(next.status,'draft');assert.equal(next.versions.length,2);
  assert.equal((await ok(url,{method:'POST',body,key})).publicId,next.publicId);assert.equal((await req(url,{method:'POST',body})).status,409);
  await ok(`/numeric/${next.publicId}`,{method:'PATCH',body:{...input,statement:'Qual é a metade de 6 litros?',answer:'3',difficulty:'facil',expectedRevision:1}});
  const prior=await ok(`/numeric/${approved.publicId}`);assert.equal(prior.answer,'2,5');assert.equal(prior.difficulty,'media');assert.equal(prior.statement,input.statement);
  const description=db.prepare('SELECT description FROM bncc_skills WHERE id=?').pluck().get(input.skillId);
  try{db.prepare("UPDATE bncc_skills SET description='Descrição atualizada' WHERE id=?").run(input.skillId);
    assert.equal((await ok(`/numeric/${approved.publicId}`)).curriculum.skillDescription,description);
  }finally{db.prepare('UPDATE bncc_skills SET description=? WHERE id=?').run(description,input.skillId);}
  const latest=await ok('/numeric');assert.equal(latest.data.some(r=>r.publicId===approved.publicId),false);assert.equal(latest.data.some(r=>r.publicId===next.publicId),true);
  const q=db.prepare('SELECT * FROM questions WHERE question_code=?').get(approved.code);
  assert.equal(q.status,'inactive');assert.equal((await req(`/bank/questions/${q.id}`,{who:admin})).status,404);
  const item=db.prepare('SELECT * FROM typed_question_items WHERE question_id=?').get(q.id);assert.equal(item.status,'draft');
  assert.throws(()=>db.prepare("UPDATE typed_question_items SET status='active' WHERE id=?").run(item.id));
});
test('cópia do estudante só é preparada após aprovação e não contém gabarito ou resolução',async()=>{
  let d=await create();
  let p=await ok(`/numeric/${d.publicId}/preview`,{method:'POST',body:{expectedRevision:1}});
  assert.equal((await req(`/numeric/${d.publicId}/print`,{method:'POST',body:{expectedRevision:1,expectedFingerprint:p.fingerprint,audience:'student'}})).status,409);
  d=await submit(d);await decision(d);d=await ok(`/numeric/${d.publicId}`);
  p=await ok(`/numeric/${d.publicId}/preview`,{method:'POST',body:{expectedRevision:d.revision}});
  const printed=await ok(`/numeric/${d.publicId}/print`,{method:'POST',body:{expectedRevision:d.revision,expectedFingerprint:p.fingerprint,audience:'student'}});
  const {getNumericDraftPrintDocument}=await import('../../client/src/services/numericDraftPrint.mjs');
  const html=getNumericDraftPrintDocument(printed,d.publicId,d.revision,'student');assert.match(html,/Nome/);assert.match(html,/Qual é a metade/);
  assert.doesNotMatch(html,/2,5|Divida 5|Resposta esperada|<section class="teacher-key"|<h3>Como chegar/i);
  const audit=JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE action='numeric_draft_print_prepared' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.equal(audit.purpose,'approved_student_paper');assert.ok(!('answer' in audit));
});
test('falha do recibo reverte envio e aprovação por inteiro; autoaprovação é proibida',async()=>{
  const d=await create();
  db.exec("CREATE TRIGGER editorial_failure BEFORE INSERT ON typed_question_write_operations BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  try{assert.equal((await req(`/numeric/${d.publicId}/submit-review`,{method:'POST',body:{expectedRevision:1,confirmed:true}})).status,500);
    assert.equal((await ok(`/numeric/${d.publicId}`)).review,null);
  }finally{db.exec('DROP TRIGGER editorial_failure');}
  const sent=await submit(d);
  db.exec("CREATE TRIGGER editorial_failure BEFORE INSERT ON typed_question_write_operations BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  try{assert.equal((await req(`/numeric/reviews/${sent.review.publicId}/decision`,{who:admin,method:'POST',body:{expectedRevision:1,decision:'approved',reason:'Enunciado e resolução conferidos.'}})).status,500);
    const unchanged=await ok(`/numeric/${d.publicId}`);assert.equal(unchanged.status,'draft');assert.equal(unchanged.review.status,'pending');
  }finally{db.exec('DROP TRIGGER editorial_failure');}
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher.id);
  try{const {decideNumericReview}=require('../src/services/numericEditorial');assert.throws(()=>decideNumericReview(db,{actor:{...teacher,role:'admin'},publicId:sent.review.publicId,expectedRevision:1,decision:'approved',reason:'Não aprovar a própria questão.',idempotencyKey:randomUUID()}),e=>e.code==='independent_reviewer_required');}
  finally{db.prepare("UPDATE users SET role='professor' WHERE id=?").run(teacher.id);teacher.authVersion=db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(teacher.id);}
});
test('kill switch bloqueia decisão, fila e envio; integridade permanece válida',async()=>{
  const sent=await submit(await create());
  db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Teste do bloqueio editorial',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='question_bank.numeric_drafts'").run();
  assert.equal((await req('/numeric/reviews/queue',{who:admin})).status,404);
  assert.equal((await req(`/numeric/reviews/${sent.review.publicId}/decision`,{who:admin,method:'POST',body:{expectedRevision:1,decision:'approved',reason:'Enunciado e resolução conferidos.'}})).status,404);
  assert.equal((await req(`/numeric/${sent.publicId}/submit-review`,{method:'POST',body:{expectedRevision:1,confirmed:true}})).status,404);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.equal(db.pragma('foreign_key_check').length,0);
});
