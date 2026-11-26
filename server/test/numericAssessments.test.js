const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{randomUUID}=require('node:crypto');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'labmathic-numeric-online-'));
process.env.DB_PATH=path.join(directory,'test.sqlite');process.env.UPLOAD_DIR=path.join(directory,'uploads');
process.env.JWT_SECRET='isolated-numeric-assessment-tests-long-secret';
process.env.STUDENT_ASSESSMENT_ACCESS_SECRET='isolated-numeric-access-test-long-secret';
const db=require('../src/database'),express=require('express'),jwt=require('jsonwebtoken');
const {saveNumericDraft}=require('../src/services/numericQuestionDrafts');
const {submitNumericReview,decideNumericReview,createNumericVersion}=require('../src/services/numericEditorial');
const app=express();app.use(express.json());
for(const name of ['classAssessmentStudentAccess','classAssessmentResults','classAssessments'])app.use('/classes',require('../src/routes/'+name));
app.use('/student',require('../src/routes/studentAssessmentPortal'));
app.use((e,_req,res,_next)=>res.status(500).json({error:e.message}));
let server,origin,teacher,admin,other,classId,classPublicId,students,versions,input,parsePortal;
const user=(name,role='professor')=>({id:Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES(?,?,'synthetic',?)").run(name,name+'@numeric.invalid',role).lastInsertRowid),role});
async function request(url,{who=teacher,token,method='GET',body,key=randomUUID()}={}) {
  // No pooled idle socket across synchronous fixture creation (hundreds of audited versions).
  const r=await fetch(origin+url,{method,headers:{Connection:'close','Content-Type':'application/json','Idempotency-Key':key,
    ...(token||who?{Authorization:'Bearer '+(token||jwt.sign(who,process.env.JWT_SECRET,{expiresIn:'15m'}))}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  return {status:r.status,body:await r.json()};
}
async function ok(url,options,status=200){const r=await request(url,options);assert.equal(r.status,status,JSON.stringify(r.body));return r.body;}
const base=()=>`/classes/${classPublicId}/assessments`;
const body=()=>({numericVersionIds:versions.map(v=>v.publicId),title:'Medidas e zero',participantIds:students,
  randomizeQuestions:true,randomizeOptions:true,pedagogicalConfirmed:true});
const create=()=>ok(base(),{method:'POST',body:body()},201);
async function approved(answer, overrides={}){
  const d=saveNumericDraft(db,{actor:teacher,input:{...input,answer,statement:'Qual é o valor '+answer+'?',...overrides},idempotencyKey:randomUUID()});
  const sent=submitNumericReview(db,{actor:teacher,publicId:d.publicId,expectedRevision:d.revision,confirmed:true,idempotencyKey:randomUUID()});
  decideNumericReview(db,{actor:admin,publicId:sent.review.publicId,expectedRevision:sent.review.revision,decision:'approved',reason:'Resposta, enunciado e habilidade conferidos.',idempotencyKey:randomUUID()});
  return {...d,revision:d.revision+1};
}
async function online(){
  const a=await create(),url=base()+'/'+a.id;
  const access=await ok(url+'/student-access');
  const configured=await ok(url+'/student-access',{method:'PATCH',body:{expectedRevision:access.assessment.revision,enabled:false,resultMode:'score_after_submit'}});
  const opened=await ok(url+'/delivery',{method:'PATCH',body:{action:'open',expectedRevision:configured.assessment.revision}});
  const codes=await ok(url+'/student-access/credentials',{method:'POST',body:{expectedRevision:opened.revision,confirmation:'GERAR_ACESSOS'}},201);
  const session=await ok('/student/session',{who:null,method:'POST',body:{code:codes.generated[0].code}});
  parsePortal(session.portal);
  return {a,url,...session,codes};
}
test.before(async()=>{
  assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='classes.numeric_assessments'").get(),{master_enabled:0,default_enabled:0,rollout_percentage:0});
  teacher=user('author');other=user('other');admin=user('admin','admin');
  const flags=['question_bank.numeric_drafts','classes.numeric_assessments','classes.core','classes.assessment_assignments',
    'classes.assessment_delivery','classes.assessment_results','classes.student_assessment_portal','classes.learning_recovery','classes.student_feedback_release'];
  for(const key of flags){const f=db.prepare('SELECT id FROM feature_flags WHERE flag_key=?').get(key);assert.ok(f,key);
    db.prepare('UPDATE feature_flags SET master_enabled=1 WHERE id=?').run(f.id);
    for(const u of [teacher,admin,other])db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES(?,?,1,'Teste numérico isolado',?,?)").run(f.id,u.id,admin.id,admin.id);
  }
  const gradeId=Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('6º numérico',6)").run().lastInsertRowid);
  const unitId=Number(db.prepare("INSERT INTO bncc_units(name) VALUES('Números teste')").run().lastInsertRowid);
  const skillId=Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES('EF06MA11-N','Resolver problemas com decimais.',?,?)").run(gradeId,unitId).lastInsertRowid);
  input={gradeId,unitId,skillId,statement:'Qual é a metade?',answer:'2,5',unit:'litros',supportText:'Divida em partes iguais.',difficulty:'media',explanation:'Divida a medida em duas partes iguais.'};
  versions=[await approved('2,5'),await approved('0')];classPublicId=randomUUID();
  classId=Number(db.prepare("INSERT INTO school_classes(public_id,owner_teacher_id,name,grade_id,academic_year,created_by,updated_by) VALUES(?,?,'6º A numérica',?,2026,?,?)").run(classPublicId,teacher.id,gradeId,teacher.id,teacher.id).lastInsertRowid);
  students=Array.from({length:2},(_,i)=>{const id=randomUUID();const studentId=db.prepare("INSERT INTO students(public_id,owner_teacher_id,display_name,created_by,updated_by) VALUES(?,?,?, ?,?)").run(id,teacher.id,'Estudante '+i,teacher.id,teacher.id).lastInsertRowid;
    db.prepare('INSERT INTO school_class_enrollments(class_id,student_id,owner_teacher_id,created_by,updated_by) VALUES(?,?,?,?,?)').run(classId,studentId,teacher.id,teacher.id,teacher.id);return id;});
  parsePortal=(await import('../../client/src/services/studentAssessmentView.mjs')).parseStudentPortal;
  await new Promise(resolve=>{server=app.listen(0,'127.0.0.1',()=>{origin='http://127.0.0.1:'+server.address().port;resolve();});});
});
test.after(async()=>{if(server)await new Promise(r=>server.close(r));db.close();fs.rmSync(directory,{recursive:true,force:true});});

test('seleção só oferece versões próprias aprovadas; criação idempotente preserva cópia',async()=>{
  const bootstrap=await ok(base()+'/bootstrap');assert.equal(bootstrap.numericSources.length,2);
  assert.equal(bootstrap.numericSources[0].answer,undefined);
  const key=randomUUID(),b=body();const a=await ok(base(),{method:'POST',body:b,key},201);
  assert.equal((await ok(base(),{method:'POST',body:b,key},201)).id,a.id);
  assert.equal((await request(base(),{method:'POST',body:{...b,title:'Outro título'},key})).status,409);
  assert.equal(a.items.every(i=>i.questionType==='numeric'&&i.options.length===0),true);
  assert.equal((await request(base(),{who:other,method:'POST',body:b})).status,404);
  const draft=saveNumericDraft(db,{actor:teacher,input,idempotencyKey:randomUUID()});
  assert.equal((await request(base(),{method:'POST',body:{...b,numericVersionIds:[draft.publicId]}})).status,409);
  assert.equal((await request(base(),{method:'POST',body:{...b,numericVersionIds:[versions[0].publicId,versions[0].publicId]}})).status,400);
  assert.equal((await request(base(),{method:'POST',body:{...b,numericVersionIds:[],sourceQuestionSetId:1}})).status,400);
});
test('auditoria obrigatória reverte toda criação numérica',async()=>{
  const before=db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get();
  db.exec("CREATE TRIGGER fail_numeric_audit BEFORE INSERT ON activity_log WHEN NEW.action='create_numeric_class_assessment' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;");
  try{assert.equal((await request(base(),{method:'POST',body:body()})).status,500);
    assert.equal(db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get(),before);
  }finally{db.exec('DROP TRIGGER fail_numeric_audit');}
});

test('resposta perdida é reconciliada com o mesmo pedido sem duplicar aplicação ou auditoria',async()=>{
  const {createNumericSubmission}=await import('../../client/src/services/numericAssessmentSubmission.mjs');
  const guard=createNumericSubmission(),original=body(),key=randomUUID();
  const first=guard.begin(original,key);
  const before=db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get();
  const audits=db.prepare("SELECT count(*) FROM activity_log WHERE action='create_numeric_class_assessment'").pluck().get();
  const saved=await ok(base(),{method:'POST',body:first.body,key:first.key},201);
  guard.failed(new Error('Resposta perdida após commit'));
  original.title='Título alterado não deve ser enviado';original.numericVersionIds.reverse();original.participantIds=[];
  const retry=guard.begin(original,randomUUID());
  const confirmed=await ok(base(),{method:'POST',body:retry.body,key:retry.key},201);
  assert.equal(confirmed.id,saved.id);assert.equal(confirmed.title,'Medidas e zero');
  assert.equal(db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get(),before+1);
  assert.equal(db.prepare("SELECT count(*) FROM activity_log WHERE action='create_numeric_class_assessment'").pluck().get(),audits+1);
  guard.confirmed();assert.equal(guard.uncertain,false);
});

test('falha antes do commit pode ser conferida e cria somente uma aplicação',async()=>{
  const {createNumericSubmission}=await import('../../client/src/services/numericAssessmentSubmission.mjs');
  const guard=createNumericSubmission(),requestToSend=guard.begin(body(),randomUUID());
  const before=db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get();
  db.exec("CREATE TRIGGER fail_numeric_audit BEFORE INSERT ON activity_log WHEN NEW.action='create_numeric_class_assessment' BEGIN SELECT RAISE(ABORT,'synthetic_audit_failure'); END;");
  try {
    const failed=await request(base(),{method:'POST',body:requestToSend.body,key:requestToSend.key});
    assert.equal(failed.status,500);guard.failed({response:{status:failed.status}});
    assert.equal(db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get(),before);
  } finally { db.exec('DROP TRIGGER fail_numeric_audit'); }
  const retry=guard.request;
  await ok(base(),{method:'POST',body:retry.body,key:retry.key},201);
  assert.equal(db.prepare('SELECT count(*) FROM class_assessment_assignments').pluck().get(),before+1);
  guard.confirmed();assert.equal(guard.request,null);
});

test('seleção identifica versões da mesma questão e servidor continua recusando duplicidade',async()=>{
  const first=await approved('12');
  const second=createNumericVersion(db,{actor:teacher,publicId:first.publicId,expectedRevision:first.revision,idempotencyKey:randomUUID()});
  const sent=submitNumericReview(db,{actor:teacher,publicId:second.publicId,expectedRevision:second.revision,confirmed:true,idempotencyKey:randomUUID()});
  decideNumericReview(db,{actor:admin,publicId:sent.review.publicId,expectedRevision:sent.review.revision,
    decision:'approved',reason:'Versão conferida de modo independente.',idempotencyKey:randomUUID()});
  const bootstrap=await ok(base()+'/bootstrap');
  const options=bootstrap.numericSources.filter(s=>[first.publicId,second.publicId].includes(s.id));
  assert.equal(options.length,2);
  assert.ok(options.every(s=>s.questionCode===first.code));
  assert.deepEqual(options.map(s=>s.version).sort(),[1,2]);
  const {parseAssessmentBootstrap}=await import('../../client/src/services/assessmentView.mjs');
  parseAssessmentBootstrap(bootstrap);
  assert.equal((await request(base(),{method:'POST',body:{...body(),numericVersionIds:options.map(s=>s.id)}})).status,400);
  assert.doesNotMatch(JSON.stringify(options),/answerKey|"answer"|"explanation"/);
});
test('início on-line carrega as definições numéricas uma vez dentro da transação', async () => {
  const assessment = await create();
  const url = base() + '/' + assessment.id;
  const access = await ok(url + '/student-access');
  const opened = await ok(url + '/delivery', {method: 'PATCH', body: {
    action: 'open', expectedRevision: access.assessment.revision,
  }});
  const codes = await ok(url + '/student-access/credentials', {method: 'POST', body: {
    expectedRevision: opened.revision, confirmation: 'GERAR_ACESSOS',
  }}, 201);
  const prepare = db.prepare;
  let definitionReads = 0;
  db.prepare = function (sql, ...args) {
    if (this.inTransaction && sql.includes('FROM class_assessment_typed_item_snapshots s')) definitionReads += 1;
    return prepare.call(this, sql, ...args);
  };
  try {
    const session = await ok('/student/session', {who: null, method: 'POST', body: {code: codes.generated[0].code}});
    assert.equal(session.portal.items.length, 2);
    assert.equal(definitionReads, 1);
    const rows = prepare.call(db, `SELECT numeric_value FROM class_assessment_numeric_responses
      WHERE assignment_id=(SELECT id FROM class_assessment_assignments WHERE public_id=?)`).all(assessment.id);
    assert.equal(rows.length, 2);
    assert.ok(rows.every(row => row.numeric_value === null));
  } finally {
    db.prepare = prepare;
  }
});

test('aluno responde decimal e zero; notas e resultados usam snapshot sem vazar gabarito',async()=>{
  const f=await online();let p=f.portal;
  assert.equal(p.items.every(i=>i.questionType==='numeric'&&i.numericValue===null),true);
  assert.doesNotMatch(JSON.stringify(p),/answerKey|correctNumericValue|numericDefinition|isCorrect|Divida a medida/);
  const responses=p.items.map(i=>({itemId:i.id,numericValue:i.statement.includes('2,5')?'2.500000':'-0'}));
  p=await ok('/student/responses',{token:f.token,method:'PUT',body:{expectedRevision:p.attempt.revision,responses}});parsePortal(p);
  assert.equal(p.attempt.answeredCount,2);assert.equal(p.result,null);
  assert.equal((await request('/student/responses',{token:f.token,method:'PUT',body:{expectedRevision:1,responses}})).status,409);
  const submitted=await ok('/student/submit',{token:f.token,method:'POST',body:{expectedRevision:p.attempt.revision}});
  assert.equal(submitted.result.correctCount,2);assert.equal(submitted.result.percentage,100);
  const summary=await ok(f.url+'/results');assert.equal(summary.overview.submittedCount,1);
  assert.equal(summary.overview.meanPercentage,100);assert.equal(summary.skills[0].successRate,100);
  const entry=await ok(f.url+'/results/participants/'+f.codes.generated[0].id);
  assert.equal(entry.items.every(i=>i.isCorrect),true);assert.ok(entry.items.some(i=>i.numericValue==='0'));
  assert.equal((await request(f.url+'/results',{who:other})).status,404);
  const row=db.prepare("SELECT * FROM class_assessment_numeric_responses WHERE attempt_id=(SELECT id FROM class_assessment_attempts WHERE status='submitted' ORDER BY id DESC LIMIT 1) LIMIT 1").get();
  assert.throws(()=>db.prepare("UPDATE class_assessment_numeric_responses SET numeric_value='99',is_correct=0 WHERE id=?").run(row.id),/invalid_numeric/);
  assert.throws(()=>db.prepare('DELETE FROM class_assessment_numeric_responses WHERE id=?').run(row.id),/immutable/);
});
test('validação rejeita texto, excesso de precisão, item estrangeiro e opções falsas sem perder respostas',async()=>{
  const f=await online();const p=f.portal;
  for(const value of ['2,5 litros','1.000,00','0.1234567',false,12,'1e3']){
    const responses=p.items.map(i=>({itemId:i.id,numericValue:value}));
    assert.equal((await request('/student/responses',{token:f.token,method:'PUT',body:{expectedRevision:1,responses}})).status,400,String(value));
  }
  assert.equal((await request('/student/responses',{token:f.token,method:'PUT',body:{expectedRevision:1,responses:p.items.map(i=>({itemId:i.id,optionId:'invented'}))}})).status,400);
  const unchanged=await ok('/student/me',{token:f.token});assert.equal(unchanged.attempt.revision,1);assert.equal(unchanged.attempt.answeredCount,0);
});
test('resposta em branco não vira zero; encerramento automático usa somente respostas salvas',async()=>{
  const f=await online();let p=f.portal;
  p=await ok('/student/responses',{token:f.token,method:'PUT',body:{expectedRevision:1,responses:p.items.map(i=>({itemId:i.id,numericValue:i.statement.includes('2,5')?'2,5':null}))}});
  const current=await ok(f.url);
  await ok(f.url+'/delivery',{method:'PATCH',body:{expectedRevision:current.revision,action:'close'}});
  const finished=await ok('/student/me',{token:f.token});assert.equal(finished.attempt.status,'submitted');assert.equal(finished.result.answeredCount,1);assert.equal(finished.result.correctCount,1);
  const results=await ok(f.url+'/results');assert.equal(results.overview.meanPercentage,50);
  const preview=await ok(f.url+'/results/recovery-preview');assert.equal(preview.priorities[0].result.successRate,50);
  const plan=await ok(f.url+'/results/recovery-plans',{method:'POST',body:{
    expectedAssessmentRevision:preview.source.assessment.revision,expectedResultRevision:preview.source.resultRevision,
    methodologyVersion:preview.methodology.version,title:'Retomar medidas com a turma',
    acceptedPriorities:preview.priorities.map(p=>({skillId:p.skill.id,suggestedQuestionCount:2,rationale:'Retomar com exemplos concretos.'})),
  }},201);assert.equal(plan.plan.status,'draft');
});
test('professor registra respostas numéricas em papel e não sobrescreve tentativa on-line',async()=>{
  const f=await online(),entry=await ok(f.url+'/results/participants/'+f.codes.generated[0].id);
  assert.equal((await request(f.url+'/results/participants/'+f.codes.generated[0].id,{method:'PUT',body:{expectedRevision:entry.attempt.revision,responses:entry.items.map(i=>({itemId:i.id,numericValue:'0'}))}})).status,409);
  const student=f.codes.generated[1].id,url=f.url+'/results/participants/'+student;
  let paper=await ok(url);paper=await ok(url,{method:'PUT',body:{expectedRevision:0,responses:paper.items.map(i=>({itemId:i.id,numericValue:'0'}))}});
  paper=await ok(url+'/submit',{method:'POST',body:{expectedRevision:paper.attempt.revision}});assert.equal(paper.attempt.correctCount,1);
});
test('flag interrompe novas atividades e acesso numérico sem apagar histórico',async()=>{
  const f=await online();db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='classes.numeric_assessments'").run();
  try{assert.equal((await request(base(),{method:'POST',body:body()})).status,404);
    assert.equal((await request('/student/me',{token:f.token})).status,423);
    assert.equal((await ok(base()+'/bootstrap')).numericSources.length,0);
    assert.ok((await ok(f.url+'/results')).participants.length);
  }finally{db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='classes.numeric_assessments'").run();}
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('atividade em papel reúne snapshots, separa gabarito e não muda aplicação ou tentativas',async()=>{
  const a=await create(),url=base()+'/'+a.id+'/numeric-paper';
  assert.equal(a.responseFormat,'numeric');
  const attemptsBefore=db.prepare('SELECT count(*) FROM class_assessment_attempts').pluck().get();
  const preview=await ok(url);
  assert.equal(preview.assessment.questionCount,2);assert.deepEqual(preview.items.map(i=>i.number),[1,2]);
  assert.equal(preview.audience,'student');assert.equal(preview.schoolClass.id,classPublicId);
  assert.doesNotMatch(JSON.stringify(preview),/answerKey|"answer"|"explanation"|Estudante 0|Estudante 1|"participants"/);
  const input={expectedRevision:preview.assessment.revision,expectedFingerprint:preview.fingerprint,confirmed:true};
  const student=await ok(url+'/print',{method:'POST',body:{...input,audience:'student'}});
  assert.deepEqual(student,preview);
  const teacherCopy=await ok(url+'/print',{method:'POST',body:{...input,audience:'teacher'}});
  assert.deepEqual(teacherCopy.items.map(i=>i.answer),['2,5','0']);assert.equal(teacherCopy.items[0].explanation,'Divida a medida em duas partes iguais.');
  assert.equal((await ok(base()+'/'+a.id)).revision,a.revision);
  assert.equal((await ok(base()+'/'+a.id)).status,'draft');
  assert.equal(db.prepare('SELECT count(*) FROM class_assessment_attempts').pluck().get(),attemptsBefore);
  const audit=db.prepare("SELECT metadata FROM activity_log WHERE action='numeric_assessment_print_prepared' ORDER BY id DESC LIMIT 1").get();
  assert.equal(JSON.parse(audit.metadata).audience,'teacher');assert.doesNotMatch(audit.metadata,/2,5|Divida a medida|Estudante/);
  const response=await fetch(origin+url,{headers:{Authorization:'Bearer '+jwt.sign(teacher,process.env.JWT_SECRET,{expiresIn:'15m'})}});
  assert.equal(response.status,200);
  assert.match(response.headers.get('cache-control'),/no-store/);
});

test('impressão exige professor dono, flags, conferência, público explícito e revisão atual',async()=>{
  const a=await create(),url=base()+'/'+a.id+'/numeric-paper',p=await ok(url);
  const valid={audience:'student',confirmed:true,expectedRevision:p.assessment.revision,expectedFingerprint:p.fingerprint};
  for(const who of [other,admin,null]){
    const expected=who===null?401:who===admin?403:404;
    assert.equal((await request(url,{who})).status,expected);
    assert.equal((await request(url+'/print',{who,method:'POST',body:valid})).status,expected);
  }
  for(const change of [{audience:'both'},{audience:undefined},{confirmed:false},{confirmed:'true'},{expectedRevision:'1'},{expectedFingerprint:'x'},{expectedFingerprint:[p.fingerprint]},{actor:teacher},{items:[]}]){
    assert.equal((await request(url+'/print',{method:'POST',body:{...valid,...change}})).status,400);
  }
  const otherClassUrl=`/classes/${randomUUID()}/assessments/${a.id}/numeric-paper`;
  assert.equal((await request(otherClassUrl)).status,404);
  assert.equal((await request(otherClassUrl+'/print',{method:'POST',body:valid})).status,404);
  assert.equal((await request(url+'/print',{method:'POST',body:{...valid,expectedRevision:p.assessment.revision+1}})).status,409);
  assert.equal((await request(url+'/print',{method:'POST',body:{...valid,expectedFingerprint:'f'.repeat(64)}})).status,409);
  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='classes.numeric_assessments'").run();
  try{assert.equal((await request(url)).status,404);assert.equal((await request(url+'/print',{method:'POST',body:valid})).status,404);}
  finally{db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='classes.numeric_assessments'").run();}
});

test('falha de auditoria não entrega nenhuma cópia ou gabarito',async()=>{
  const a=await create(),url=base()+'/'+a.id+'/numeric-paper',p=await ok(url);
  const count=()=>db.prepare("SELECT count(*) FROM activity_log WHERE action='numeric_assessment_print_prepared'").pluck().get();
  const before=count();
  db.exec("CREATE TRIGGER fail_paper_audit BEFORE INSERT ON activity_log WHEN NEW.action='numeric_assessment_print_prepared' BEGIN SELECT RAISE(ABORT,'synthetic_paper_audit_failure'); END;");
  try{for(const audience of ['student','teacher']){
    const r=await request(url+'/print',{method:'POST',body:{audience,confirmed:true,expectedRevision:p.assessment.revision,expectedFingerprint:p.fingerprint}});
    assert.equal(r.status,500);assert.equal(r.body.items,undefined);assert.equal(r.body.assessment,undefined);
  }assert.equal(count(),before);}finally{db.exec('DROP TRIGGER fail_paper_audit');}
});

test('alteração no banco de questões não reescreve papel; mudança na turma invalida a prévia',async()=>{
  const a=await create(),url=base()+'/'+a.id+'/numeric-paper',p=await ok(url);
  const q=db.prepare('SELECT id,statement FROM questions WHERE question_code=?').get(p.items[0].code);
  try {
    db.prepare("UPDATE questions SET statement='Texto novo no banco, não na aplicação.' WHERE id=?").run(q.id);
    assert.deepEqual(await ok(url),p);
  } finally {db.prepare('UPDATE questions SET statement=? WHERE id=?').run(q.statement,q.id);}
  const oldName=db.prepare('SELECT name FROM school_classes WHERE id=?').pluck().get(classId);
  try{
    db.prepare("UPDATE school_classes SET name='Turma renomeada' WHERE id=?").run(classId);
    assert.equal((await request(url+'/print',{method:'POST',body:{audience:'student',confirmed:true,expectedRevision:p.assessment.revision,expectedFingerprint:p.fingerprint}})).status,409);
    assert.equal((await ok(url)).schoolClass.name,'Turma renomeada');
  }finally{db.prepare('UPDATE school_classes SET name=? WHERE id=?').run(oldName,classId);}
});

test('atividade cancelada não permite preparar cópias',async()=>{
  const f=await online(),current=await ok(f.url),p=await ok(f.url+'/numeric-paper');
  await ok(f.url+'/delivery',{method:'PATCH',body:{action:'cancel',expectedRevision:current.revision}});
  assert.equal((await request(f.url+'/numeric-paper')).status,409);
  assert.equal((await request(f.url+'/numeric-paper/print',{method:'POST',body:{audience:'teacher',confirmed:true,expectedRevision:p.assessment.revision,expectedFingerprint:p.fingerprint}})).status,409);
});

test('sanitização remove respostas numéricas reais da cópia e restaura proteções, sem alterar a origem',async()=>{
  // Deliberately resembles a phone: do not rely on random UUIDs to expose this collision.
  const technicalCode='NUM-12345678-1234-4234-8234-123456789012';
  db.prepare(`INSERT INTO questions(question_code,skill_id,statement,difficulty,question_type,status,source,created_by)
    VALUES(?,?,'Contato sintético (11) 99999-9999','media','numeric_draft','inactive','teacher',?)`).run(technicalCode,input.skillId,teacher.id);
  const sourcePath=path.join(directory,'source-copy.sqlite');await db.backup(sourcePath);
  const hash=()=>require('node:crypto').createHash('sha256').update(fs.readFileSync(sourcePath)).digest('hex');
  const before=hash();const {createSanitizedDatabase,CONFIRMATION}=require('../scripts/homologation/sanitizeDatabase');
  const outputPath=path.join(directory,'homologacao','database.sqlite');
  const report=await createSanitizedDatabase({sourcePath,outputPath,manifestPath:path.join(directory,'homologacao','manifest.json'),
    confirmation:CONFIRMATION,adminEmail:'admin@homologacao.invalid',professorEmail:'teacher@homologacao.invalid',
    adminPassword:'A!'+randomUUID(),professorPassword:'P!'+randomUUID()});
  assert.equal(report.status,'sanitized');assert.equal(hash(),before);
  const copy=new (require('better-sqlite3'))(outputPath,{readonly:true});
  try{for(const name of ['class_assessment_numeric_responses','class_assessment_numeric_origins','class_assessment_attempts'])
    assert.equal(copy.prepare('SELECT count(*) FROM '+name).pluck().get(),0);
    for(const name of ['numeric_responses_delete_guard','numeric_origin_no_delete'])assert.ok(copy.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(name));
    const sanitized=copy.prepare('SELECT question_code,statement FROM questions WHERE question_code=?').get(technicalCode);
    assert.equal(sanitized.question_code,technicalCode);assert.match(sanitized.statement,/TELEFONE_REMOVIDO/);
    assert.ok(copy.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='numeric_draft_question_update_guard'").get());
    assert.equal(copy.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(copy.pragma('foreign_key_check'),[]);
  }finally{copy.close();}
});

test('busca paginada alcança versões além das 200 iniciais sem gabarito nem escrita',async()=>{
  const oldest=await approved('7',{statement:'Medição histórica única para busca.'});
  // Use the real authoring/review services, including immutable snapshots and audit.
  for(let i=0;i<205;i++)await approved('1',{statement:`Acervo paginado questão ${i}.`});
  const bootstrap=await ok(base()+'/bootstrap');
  assert.equal(bootstrap.numericSourceSearch,true);assert.equal(bootstrap.numericSources.length,200);
  assert.equal(bootstrap.numericSources.some(q=>q.id===oldest.publicId),false);
  const audits=db.prepare('SELECT count(*) FROM activity_log').pluck().get();
  const first=await ok(base()+'/numeric-sources');
  const {parseNumericSourcePage}=await import('../../client/src/services/numericAssessmentSelection.mjs');
  parseNumericSourcePage(first);
  assert.equal(first.data.length,20);assert.ok(first.pagination.total>200);
  const second=await ok(base()+'/numeric-sources?page=2');parseNumericSourcePage(second);
  assert.equal(new Set([...first.data,...second.data].map(q=>q.id)).size,40);
  const last=await ok(base()+'/numeric-sources?page='+first.pagination.totalPages);parseNumericSourcePage(last);
  assert.ok(last.data.length>0&&last.data.length<=20);
  const found=await ok(base()+'/numeric-sources?search='+encodeURIComponent('MEDICAO HISTORICA'));
  assert.deepEqual(found.data.map(q=>q.id),[oldest.publicId]);
  for(const query of [oldest.code,'EF06MA11-N','6º numerico']){
    const result=await ok(base()+'/numeric-sources?search='+encodeURIComponent(query));assert.ok(result.pagination.total>0);
  }
  const outside=await ok(base()+'/numeric-sources?page=100000');assert.deepEqual(outside.data,[]);parseNumericSourcePage(outside);
  const safeFields=['id','questionCode','version','title','unit','supportText','skillCode','gradeName'].sort();
  for(const q of [...first.data,...found.data])assert.deepEqual(Object.keys(q).sort(),safeFields);
  assert.equal(db.prepare('SELECT count(*) FROM activity_log').pluck().get(),audits);
  const response=await fetch(origin+base()+'/numeric-sources',{headers:{Authorization:'Bearer '+jwt.sign(teacher,process.env.JWT_SECRET,{expiresIn:'15m'})}});
  assert.equal(response.headers.get('cache-control'),'no-store');
});

test('busca usa enunciado e currículo aprovados, nunca rascunho novo ou de outro autor',async()=>{
  const original=await approved('11',{statement:'Área congelada aprovada.'});
  const next=createNumericVersion(db,{actor:teacher,publicId:original.publicId,expectedRevision:original.revision,idempotencyKey:randomUUID()});
  saveNumericDraft(db,{actor:teacher,publicId:next.publicId,input:{...input,expectedRevision:next.revision,statement:'Texto novo ainda não aprovado.'},idempotencyKey:randomUUID()});
  const otherDraft=saveNumericDraft(db,{actor:other,input:{...input,statement:'Área congelada de outro autor.'},idempotencyKey:randomUUID()});
  const sent=submitNumericReview(db,{actor:other,publicId:otherDraft.publicId,expectedRevision:otherDraft.revision,confirmed:true,idempotencyKey:randomUUID()});
  decideNumericReview(db,{actor:admin,publicId:sent.review.publicId,expectedRevision:sent.review.revision,decision:'approved',reason:'Revisão independente de teste.',idempotencyKey:randomUUID()});
  const found=await ok(base()+'/numeric-sources?search=area%20congelada');
  assert.deepEqual(found.data.map(q=>q.id),[original.publicId]);
  assert.equal((await ok(base()+'/numeric-sources?search=Texto%20novo')).pagination.total,0);
  const oldName=db.prepare('SELECT name FROM grades WHERE id=?').pluck().get(input.gradeId);
  try{
    db.prepare("UPDATE grades SET name='Nome curricular novo' WHERE id=?").run(input.gradeId);
    const frozen=await ok(base()+'/numeric-sources?search=6%C2%BA%20numerico');assert.ok(frozen.data.length);
    assert.ok(frozen.data.every(q=>q.gradeName===oldName));
    assert.equal((await ok(base()+'/numeric-sources?search=Nome%20curricular%20novo')).pagination.total,0);
  }finally{db.prepare('UPDATE grades SET name=? WHERE id=?').run(oldName,input.gradeId);}
});

test('busca exige dono da turma, sessão docente e flags atuais',async()=>{
  const url=base()+'/numeric-sources';
  for(const [who,status] of [[null,401],[admin,403],[other,404]])assert.equal((await request(url,{who})).status,status);
  assert.equal((await request(`/classes/${randomUUID()}/assessments/numeric-sources`)).status,404);
  for(const flag of ['classes.numeric_assessments','classes.core','classes.assessment_assignments']){
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run(flag);
    try{assert.equal((await request(url)).status,404);}finally{db.prepare('UPDATE feature_flags SET master_enabled=1 WHERE flag_key=?').run(flag);}
  }
});

test('busca rejeita filtros malformados e trata curingas e SQL como texto',async()=>{
  for(const query of ['page=0','page=-1','page=1.5','page=100001','page=1&page=2','page[x]=1','search=a&search=b','search[x]=a','search='+('x'.repeat(101))]){
    assert.equal((await request(base()+'/numeric-sources?'+query)).status,400,query);
  }
  for(const search of ['%',"' OR 1=1 --",'nada com este texto']){
    const result=await ok(base()+'/numeric-sources?search='+encodeURIComponent(search));assert.equal(result.pagination.total,0);assert.deepEqual(result.data,[]);
  }
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok');assert.deepEqual(db.pragma('foreign_key_check'),[]);
});

test('coordenação consulta habilidades numéricas e comparação usa as correções reais, sem respostas individuais', async () => {
  const previousStudents = students;
  db.exec('SAVEPOINT numeric_school_skills');
  try {
    students = [...students];
    for (let i = 0; i < 3; i++) {
      const id = randomUUID();
      const student = db.prepare("INSERT INTO students(public_id,owner_teacher_id,display_name,created_by) VALUES(?,?,'Pessoa numérica reservada',?)").run(id, teacher.id, teacher.id).lastInsertRowid;
      db.prepare('INSERT INTO school_class_enrollments(class_id,student_id,owner_teacher_id,created_by) VALUES(?,?,?,?)').run(classId, student, teacher.id, teacher.id);
      students.push(id);
    }
    const schoolPublicId = randomUUID();
    const municipality = db.prepare("INSERT INTO municipalities(public_id,name,created_by) VALUES(?,'Município sintético',?)").run(randomUUID(), admin.id).lastInsertRowid;
    const school = db.prepare("INSERT INTO schools(public_id,municipality_id,name,created_by) VALUES(?,?,'Escola sintética',?)").run(schoolPublicId, municipality, admin.id).lastInsertRowid;
    db.prepare("INSERT INTO institutional_memberships(public_id,user_id,role,municipality_id,school_id,created_by) VALUES(?,?,'teacher',?,?,?)").run(randomUUID(), teacher.id, municipality, school, admin.id);
    db.prepare("UPDATE school_class_institution_contexts SET municipality_id=?,school_id=?,migration_status='linked',linked_by=?,linked_at=CURRENT_TIMESTAMP WHERE class_id=?").run(municipality, school, admin.id, classId);
    db.prepare("UPDATE school_class_institution_contexts SET migration_status='verified',verified_by=?,verified_at=CURRENT_TIMESTAMP WHERE class_id=?").run(teacher.id, classId);
    const { classSkills, FLAGS } = require('../src/services/schoolCoordination');
    for (const key of FLAGS) db.prepare('UPDATE feature_flags SET master_enabled=1,default_enabled=1,rollout_percentage=100,release_id=NULL WHERE flag_key=?').run(key);
    const assessment = await create(), url = base() + '/' + assessment.id;
    await ok(url + '/delivery', { method: 'PATCH', body: { action: 'open', expectedRevision: assessment.revision } });
    for (const [index, student] of students.entries()) {
      const resultUrl = url + '/results/participants/' + student;
      let paper = await ok(resultUrl);
      paper = await ok(resultUrl, { method: 'PUT', body: { expectedRevision: 0,
        responses: paper.items.map(item => ({ itemId: item.id, numericValue: index === 0 ? null : '0' })) } });
      await ok(resultUrl + '/submit', { method: 'POST', body: { expectedRevision: paper.attempt.revision } });
    }
    const current = await ok(url);
    await ok(url + '/delivery', { method: 'PATCH', body: { action: 'close', expectedRevision: current.revision } });
    const result = classSkills(db, admin, schoolPublicId, classPublicId);
    assert.equal(result.result.correctedCount, 5); assert.equal(result.result.meanPercentage, 40);
    assert.deepEqual(result.result.skills, [{ code: 'EF06MA11-N', description: 'Resolver problemas com decimais.', questionCount: 2, status: 'available', successRate: 40 }]);
    assert.doesNotMatch(JSON.stringify(result), /Pessoa numérica reservada|numericValue|answerKey|numeric_value|student|attempt/);
    (await import('../../client/src/services/schoolCoordinationView.mjs')).parseCoordinationSkills(result, schoolPublicId, classPublicId);
    const next = await create(), nextUrl = base() + '/' + next.id;
    await ok(nextUrl + '/delivery', { method: 'PATCH', body: { action: 'open', expectedRevision: next.revision } });
    for (const student of students) {
      const resultUrl = nextUrl + '/results/participants/' + student;
      let paper = await ok(resultUrl);
      paper = await ok(resultUrl, { method: 'PUT', body: { expectedRevision: 0,
        responses: paper.items.map(item => ({ itemId: item.id, numericValue: '0' })) } });
      await ok(resultUrl + '/submit', { method: 'POST', body: { expectedRevision: paper.attempt.revision } });
    }
    const nextCurrent = await ok(nextUrl);
    await ok(nextUrl + '/delivery', { method: 'PATCH', body: { action: 'close', expectedRevision: nextCurrent.revision } });
    const internal = id => db.prepare('SELECT id FROM class_assessment_assignments WHERE public_id=?').pluck().get(id);
    const comparison = require('../src/services/learningRecoveryComparison').buildMatchedRecoveryComparison(db, {
      teacherId: teacher.id, classId, sourceAssignmentId: internal(assessment.id), monitoringAssignmentId: internal(next.id),
      baselineSkills: [{ skill_code_snapshot: 'EF06MA11-N', skill_description_snapshot: 'Resolver problemas com decimais.', success_rate_snapshot: 40, opportunity_count: 10 }],
    });
    assert.deepEqual([comparison.skills[0].diagnosticRate, comparison.skills[0].monitoringRate, comparison.skills[0].delta], [40, 50, 10]);
    assert.equal(comparison.skills[0].cohort.studentCount, 5);
    assert.deepEqual([comparison.skills[0].diagnosticOpportunities, comparison.skills[0].monitoringOpportunities], [10, 10]);
  } finally { students = previousStudents; db.exec('ROLLBACK TO numeric_school_skills; RELEASE numeric_school_skills'); }
});
