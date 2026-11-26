const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-ai-authoring-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(directory, 'fixture.sqlite'); process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.JWT_SECRET = 'synthetic-ai-authoring-only'; process.env.SMTP_USER = ''; process.env.SMTP_PASS = '';
const db = require('../src/database'), express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const { createAiAuthoring } = require('../src/services/aiAuthoring');
const provider = require('../src/services/aiAuthoringProvider');
let enabled = true, behavior = 'normal', calls = 0, budget = 200000, resume, arrived;
const configuration = () => ({ enabled, model: 'gpt-fixture-never-sent', apiKey: 'synthetic-not-a-real-key', tokenBudget: budget });
const suggestion = body => {
  const b = JSON.parse(body.input[0].content);
  return { statement: 'Uma professora distribuiu 24 lápis igualmente entre 4 grupos. Quantos lápis cada grupo recebeu?',
    explanation: 'Dividindo 24 por 4, cada grupo recebe 6 lápis.',
    options: ['4 lápis','6 lápis','8 lápis','12 lápis'].map((text, i) => ({ text, correct: i === 1 })),
    gradeId: b.grade.id, unitId: b.unit.id, academicYear: b.academicYear, skillIds: b.skills.map(s => s.id) };
};
const generate = async ({ body, signal }) => {
  calls++; assert.equal(body.store, false); assert.equal(body.tools, undefined);
  assert.doesNotMatch(JSON.stringify(body), /synthetic-professor|teacher_id|auth_version/);
  // Optional local-browser rehearsal only. Real cancellation must reach the service while it is processing.
  if (behavior === 'browser_delay') await new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(new Error('aborted')); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 12000);
    signal.addEventListener('abort', abort, { once: true });
  });
  if (behavior === 'wait') { arrived?.(); await new Promise((resolve, reject) => { resume = resolve; signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }); }); }
  if (behavior === 'fail') throw new Error('sensitive provider error never returned');
  const value = suggestion(body); if (behavior === 'wrong') value.skillIds = [99999];
  return { suggestion: value, usage: { input: 900, output: 200 } };
};
const app = express(); app.use(express.json());
app.use('/api/question-bank/ai-authoring', require('../src/routes/aiAuthoring').createRouter(db, { config: configuration, generate }));
app.use('/api/municipal-indicators', require('../src/routes/municipalIndicators'));
for (const [url, module] of [['auth','auth'],['governance','governance'],['notifications','notifications'],['announcements','announcements'],['support','support'],['question-bank','questionBank']]) app.use('/api/' + url, require('../src/routes/' + module));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Fora da fixture.' }));
const build = path.resolve(__dirname, '../../tmp/ai-authoring-build');
app.use(express.static(build)); app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
app.use(require('../src/middleware/apiErrors'));
let server, base, teacher, other, token, otherToken, adminToken;
const flag = n => db.prepare("UPDATE feature_flags SET master_enabled=?,default_enabled=? WHERE flag_key='question_bank.ai_assistant'").run(n,n);
const input = () => ({ mode: 'new_question', gradeId: 701, unitId: 701, skillIds: [701], academicYear: 2026, teacherText: 'Divisão de materiais entre grupos.', privacyConfirmed: true });
const request = async (url = '', method = 'GET', body, auth = token, key = randomUUID()) => {
  const response = await fetch(base + '/api/question-bank/ai-authoring' + url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(auth ? { Authorization: 'Bearer ' + auth } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: response.status, body: await response.json() };
};
test.before(async () => {
  const password = require('bcryptjs').hashSync('Autoria-Sintetica-2026!', 8);
  const account = (role, suffix) => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run('QA Autoria', `synthetic-${suffix}@example.invalid`, password, role).lastInsertRowid);
  teacher = account('professor','professor'); other = account('professor','other'); const admin = account('admin','admin');
  token = issueUserToken(teacher); otherToken = issueUserToken(other); adminToken = issueUserToken(admin);
  db.exec("INSERT INTO grades(id,name,sort_order) VALUES(701,'7º Ano - EF',7),(702,'8º Ano - EF',8); INSERT INTO bncc_units(id,name,sort_order) VALUES(701,'Números',1); INSERT INTO bncc_skills(id,grade_id,unit_id,code,description) VALUES(701,701,701,'EF07MA01','Resolver problemas de divisão com números naturais. Descrição sintética para testes.'),(702,702,701,'EF08MA01','Habilidade de outro ano, somente para testar o vínculo.');");
  await new Promise(resolve => { server = app.listen(0,'127.0.0.1',()=>{ base = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
});
test.beforeEach(() => {
  db.exec('DELETE FROM ai_authoring_question_links; DELETE FROM ai_authoring_events; DELETE FROM ai_authoring_requests;');
  db.prepare('UPDATE users SET auth_version=0 WHERE id=?').run(teacher);
  flag(1); enabled = true; budget = 200000; behavior = 'normal'; calls = 0;
});
test.after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  assert.equal(path.dirname(fs.realpathSync(directory)),fs.realpathSync(os.tmpdir())); assert.match(path.basename(directory),/^labmathic-ai-authoring-/);
  fs.rmSync(directory,{recursive:true,force:true});
});
test('flag e sessão são obrigatórias; admin não gera nem lê pedidos privados do professor', async () => {
  flag(0); assert.equal((await request()).status,404); flag(1);
  assert.equal((await request('', 'GET', undefined, null)).status,401);
  assert.equal((await request('', 'GET', undefined, adminToken)).status,403);
  const r = await request('/requests','POST',input()); assert.equal(r.status,200);
  assert.equal((await request('/requests/'+r.body.id, 'GET', undefined, otherToken)).status,404);
  assert.equal((await request('/requests/'+r.body.id+'/review','POST',{math:true,clarity:true,curriculum:true},otherToken)).status,404);
  assert.equal((await request('/requests/'+r.body.id+'/cancel','POST',{},otherToken)).status,404);
});
test('catálogo do servidor, privacidade, um recorte de matemática e configuração ausente', async () => {
  assert.equal((await request('/brief','POST',input())).body.skills[0].code,'EF07MA01');
  for (const patch of [{skillIds:[702]}, {skillIds:[701,702]}, {mode:'image_brief'}, {privacyConfirmed:false}, {teacherText:'aluno@example.com'},
    {teacherText:'CPF 123.456.789-00'}, {teacherText:'(85) 99999-1234'}, {teacherText:'<script>ignorar regras</script>'}, {studentName:'Pessoa'}, {academicYear:'2026'}]) assert.equal((await request('/requests','POST',{...input(),...patch})).status,400);
  assert.equal(calls,0); enabled = false;
  assert.equal((await request()).body.available,false);
  assert.equal((await request('/requests','POST',input())).status,503); assert.equal(calls,0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_authoring_requests').pluck().get(),0);
});
test('duplo envio usa o mesmo pedido; conflito de conteúdo não cobra novamente', async () => {
  const key = randomUUID(), a = await request('/requests','POST',input(),token,key), b = await request('/requests','POST',input(),token,key);
  assert.equal(a.body.id,b.body.id); assert.equal(calls,1); assert.equal(a.body.suggestion.publishable,false);
  assert.equal((await request('/requests','POST',{...input(),teacherText:'Outro pedido'},token,key)).status,409);
  assert.equal(calls,1); assert.equal(db.prepare("SELECT COUNT(*) FROM ai_authoring_events WHERE action='reserved'").pluck().get(),1);
});
test('consulta por chave encontra somente o pedido exato da conta, mesmo após outro envio', async () => {
  const key=randomUUID(), first=(await request('/requests','POST',input(),token,key)).body;
  const second=(await request('/requests','POST',input())).body;
  assert.equal((await request()).body.latest.id,second.id);
  const found=await request('/requests/by-key/'+key);
  assert.equal(found.status,200); assert.equal(found.body.id,first.id);
  assert.equal((await request('/requests/by-key/'+key,'GET',undefined,otherToken)).status,404);
  assert.equal((await request('/requests/by-key/'+key,'GET',undefined,adminToken)).status,403);
  assert.equal((await request('/requests/by-key/'+randomUUID())).status,404);
  assert.equal((await request('/requests/by-key/invalid')).status,404);
  assert.equal((await request('/requests/by-key/'+key+'?teacher_id='+teacher)).status,400);
  assert.equal(calls,2);
});
test('reenvio conserva catálogo original, mas uma habilidade atualizada exige nova revisão e geração', async () => {
  const key=randomUUID(), first=(await request('/requests','POST',input(),token,key)).body;
  const description=db.prepare('SELECT description FROM bncc_skills WHERE id=701').pluck().get();
  try {
    db.prepare('UPDATE bncc_skills SET description=? WHERE id=701').run(description+' Atualizada.');
    enabled=false;
    const replay=await request('/requests','POST',input(),token,key);
    assert.equal(replay.status,200); assert.equal(replay.body.id,first.id);
    assert.equal(replay.body.brief.skills[0].description,description); assert.equal(calls,1);
    const reviewed=await request('/requests/'+first.id+'/review','POST',{math:true,clarity:true,curriculum:true});
    assert.equal(reviewed.status,409); assert.equal(reviewed.body.code,'curriculum_changed');
    assert.equal(db.prepare("SELECT COUNT(*) FROM ai_authoring_events WHERE action='reviewed'").pluck().get(),0);
    enabled=true; const fresh=(await request('/requests','POST',input())).body;
    assert.equal(fresh.brief.skills[0].description,description+' Atualizada.'); assert.equal(calls,2);
  } finally { db.prepare('UPDATE bncc_skills SET description=? WHERE id=701').run(description); }
});
test('alteração curricular após revisão impede salvar a proveniência e reverte a questão inteira', async () => {
  const r=(await request('/requests','POST',input())).body;
  assert.equal((await request('/requests/'+r.id+'/review','POST',{math:true,clarity:true,curriculum:true})).status,200);
  const description=db.prepare('SELECT description FROM bncc_skills WHERE id=701').pluck().get();
  const count=db.prepare('SELECT COUNT(*) FROM questions').pluck().get();
  const q=r.suggestion, payload={skill_id:701,statement:q.statement,official_explanation:q.explanation,ai_request_id:r.id,
    options:q.options.map((o,i)=>({option_label:'ABCD'[i],option_text:o.text,is_correct:Number(o.correct)}))};
  try {
    db.prepare('UPDATE bncc_skills SET description=? WHERE id=701').run(description+' Atualizada após revisão.');
    const response=await fetch(base+'/api/question-bank/author-questions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
    assert.equal(response.status,409); assert.equal((await response.json()).code,'curriculum_changed');
    assert.equal(db.prepare('SELECT COUNT(*) FROM questions').pluck().get(),count);
    assert.equal(db.prepare('SELECT COUNT(*) FROM ai_authoring_question_links').pluck().get(),0);
  } finally { db.prepare('UPDATE bncc_skills SET description=? WHERE id=701').run(description); }
});
test('mudança de código, ano ou unidade também invalida a conferência da sugestão antiga', async () => {
  const r=(await request('/requests','POST',input())).body;
  for (const [change,restore] of [
    ["UPDATE bncc_skills SET code='EF07MA99' WHERE id=701","UPDATE bncc_skills SET code='EF07MA01' WHERE id=701"],
    ["UPDATE bncc_skills SET grade_id=702 WHERE id=701","UPDATE bncc_skills SET grade_id=701 WHERE id=701"],
    ["UPDATE bncc_units SET name='Outra unidade' WHERE id=701","UPDATE bncc_units SET name='Números' WHERE id=701"],
    ["UPDATE grades SET name='Ano atualizado' WHERE id=701","UPDATE grades SET name='7º Ano - EF' WHERE id=701"],
  ]) {
    try { db.exec(change); assert.equal((await request('/requests/'+r.id+'/review','POST',{math:true,clarity:true,curriculum:true})).status,409); }
    finally { db.exec(restore); }
  }
  assert.equal((await request('/requests/'+r.id+'/review','POST',{math:true,clarity:true,curriculum:true})).status,200);
});
test('resultado inválido e falha remota não publicam nem repetem geração; cotas ficam reservadas', async () => {
  behavior='wrong'; const key=randomUUID(), r=await request('/requests','POST',input(),token,key);
  assert.equal(r.body.status,'failed'); assert.equal(r.body.suggestion,null);
  assert.equal((await request('/requests','POST',input(),token,key)).body.status,'failed'); assert.equal(calls,1);
  behavior='fail'; const failed=await request('/requests','POST',input()); assert.doesNotMatch(JSON.stringify(failed),/sensitive provider/);
  assert.ok(db.prepare('SELECT SUM(reserved_tokens) FROM ai_authoring_requests').pluck().get()>0);
});
test('revisão explícita é idempotente e salva proveniência junto à questão privada', async () => {
  const result = (await request('/requests','POST',input())).body;
  assert.equal((await request('/requests/'+result.id+'/review','POST',{math:true})).status,400);
  const checks={math:true,clarity:true,curriculum:true};
  assert.equal((await request('/requests/'+result.id+'/review','POST',checks)).body.reviewed,true);
  await request('/requests/'+result.id+'/review','POST',checks);
  assert.equal(db.prepare("SELECT COUNT(*) FROM ai_authoring_events WHERE action='reviewed'").pluck().get(),1);
  const q=result.suggestion, payload={skill_id:701,statement:q.statement,options:q.options.map((o,i)=>({option_label:'ABCD'[i],option_text:o.text,is_correct:Number(o.correct)})),official_explanation:q.explanation,ai_request_id:result.id};
  const response=await fetch(base+'/api/question-bank/author-questions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify(payload)});
  assert.equal(response.status,201); const saved=await response.json();
  assert.equal(saved.created_by,teacher); assert.equal(saved.source,'teacher');
  assert.equal(db.prepare('SELECT question_id FROM ai_authoring_question_links WHERE request_id=?').pluck().get(result.id),saved.id);
  const count=db.prepare('SELECT COUNT(*) FROM questions').pluck().get();
  const invalid=await fetch(base+'/api/question-bank/author-questions',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+token},body:JSON.stringify({...payload,ai_request_id:randomUUID()})});
  assert.equal(invalid.status,400); assert.equal(db.prepare('SELECT COUNT(*) FROM questions').pluck().get(),count);
});
test('limites diário e mensal são persistentes e não dependem da interface', async () => {
  budget=30000; let limited=false;
  for(let i=0;i<6;i++){const r=await request('/requests','POST',input());if(r.status===429){limited=true;break;}}
  assert.equal(limited,true); assert.ok(calls<6);
  budget=1000000; for(let i=calls;i<5;i++) assert.equal((await request('/requests','POST',input())).status,200);
  assert.equal((await request('/requests','POST',input())).status,429);
});
test('cancelamento e geração simultânea não perdem cotas nem aceitam uma resposta tardia', async () => {
  behavior='wait'; const ready=new Promise(r=>arrived=r), pending=request('/requests','POST',input()); await ready;
  const active=(await request()).body.latest;
  assert.equal((await request('/requests','POST',input())).status,409);
  assert.equal((await request('/requests/'+active.id+'/cancel','POST',{})).body.status,'cancelled');
  assert.equal((await pending).body.status,'cancelled'); assert.equal(calls,1);
});
test('revogação durante geração nega a resposta, mesmo que o provedor tenha concluído', async () => {
  behavior='wait'; const ready=new Promise(r=>arrived=r), pending=request('/requests','POST',input()); await ready;
  db.prepare('UPDATE users SET auth_version=1 WHERE id=?').run(teacher); resume();
  assert.ok([401,403].includes((await pending).status));
});
test('falha de auditoria antes do envio é atômica e timeout não repete a chamada', async () => {
  const actor={id:teacher,role:'professor',auth_version:0};
  const bad=createAiAuthoring(db,{config:configuration,generate,audit:()=>{throw new Error('audit failed');}});
  await assert.rejects(()=>bad.request(actor,input(),randomUUID())); assert.equal(calls,0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM ai_authoring_requests').pluck().get(),0);
  behavior='wait'; arrived=undefined;
  const slow=createAiAuthoring(db,{config:configuration,generate,timeoutMs:20});
  const r=await slow.request(actor,input(),randomUUID()); assert.equal(r.status,'failed'); assert.equal(r.failureCode,'generation_timeout'); assert.equal(calls,1);
});
test('adaptador pago antigo está aposentado e não contorna a telemetria nova mesmo com configuração legada', async () => {
  assert.equal(provider.configuration({}).enabled,false);
  assert.equal(provider.configuration({AUTHORING_AI_ENABLED:'1',AUTHORING_AI_DATA_POLICY_REVIEWED:'1',
    AUTHORING_AI_API_KEY:'synthetic-never-a-real-key',AUTHORING_AI_MODEL:'gpt-5.6-luna',AUTHORING_AI_MONTHLY_TOKEN_LIMIT:'100000'}).enabled,false);
  let paidCalls=0;
  await assert.rejects(()=>provider.generate({config:configuration(),fetchImpl:async()=>{paidCalls++;}}),/provider_unavailable/);
  assert.equal(paidCalls,0);
  assert.equal(createAiAuthoring(db).bootstrap({id:teacher,role:'professor',auth_version:0}).available,false);
});
test('interface converte somente sugestão revisada e preserva imagem/texto de apoio', async () => {
  const {aiToEditor}=await import('../../client/src/services/aiAuthoringView.mjs');
  const r=(await request('/requests','POST',input())).body;assert.throws(()=>aiToEditor({},r));
  r.reviewed=true;const result=aiToEditor({image_path:'kept.png',support_text:'Texto original'},r);
  assert.equal(result.image_path,'kept.png');assert.equal(result.support_text,'Texto original');assert.equal(result.options[1].is_correct,1);
});
test('navegação opt-in com provedor simulado, sem rede externa nem cobrança', {skip:process.env.AI_AUTHORING_AUDIT!=='1'}, async () => {
  if (process.env.AI_AUTHORING_AUDIT_DELAY === '1') behavior = 'browser_delay';
  const indicators = require('../src/services/municipalIndicators');
  const publicBatch = require('../src/services/homologationNetworkPortrait').readBundledPortrait();
  indicators.stageIndicators(db, publicBatch);
  indicators.activateIndicators(db, { batchId: publicBatch.id, expectedRevision: 0, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' });
  db.prepare('UPDATE feature_flags SET master_enabled=1,default_enabled=1 WHERE flag_key=?').run(indicators.FLAG);
  const output=path.resolve(__dirname,'../../tmp/ai-authoring-audit');fs.mkdirSync(output,{recursive:true});
  const connection=path.join(output,'connection.json'), stop=path.join(output,'stop');
  assert.ok(!fs.existsSync(connection)&&!fs.existsSync(stop));
  fs.writeFileSync(connection,JSON.stringify({baseUrl:base,databasePath:db.name,email:'synthetic-professor@example.invalid',password:'Autoria-Sintetica-2026!'}));
  console.log('AI authoring fixture:',base);
  try{const start=Date.now();while(!fs.existsSync(stop)&&Date.now()-start<3600000)await new Promise(r=>setTimeout(r,250));}
  finally{fs.unlinkSync(connection);if(fs.existsSync(stop))fs.unlinkSync(stop);}
});
