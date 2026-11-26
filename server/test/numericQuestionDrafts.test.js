const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-numeric-drafts-'));
process.env.DB_PATH = path.join(directory, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development';
process.env.JWT_SECRET = 'numeric-synthetic-tests-only-secret-long-enough';
const db = require('../src/database');
const express = require('express');
const jwt = require('jsonwebtoken');
const { numericValue, saveNumericDraft } = require('../src/services/numericQuestionDrafts');
const { getTypedAuthoringState } = require('../src/services/typedQuestionAuthoring');
const { inspectMigrations, runMigrations } = require('../src/migrations');
const app = express(); app.use(express.json());
app.use('/numeric', require('../src/routes/numericQuestionDrafts'));
app.use('/bank', require('../src/routes/questionBank'));
let server, origin, saved, author, other, admin, input;
const token = user => jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '15m' });
function user(name, role = 'professor') {
  const id = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES(?,?,'synthetic',?)").run(name, name + '@test.invalid', role).lastInsertRowid);
  return { id, name, email: name + '@test.invalid', role };
}
function enable(key, users) {
  db.prepare('UPDATE feature_flags SET master_enabled=1 WHERE flag_key=?').run(key);
  const flag = db.prepare('SELECT id FROM feature_flags WHERE flag_key=?').get(key);
  for (const u of users) db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES(?,?,1,'Teste isolado',?,?)")
    .run(flag.id, u.id, admin.id, admin.id);
}
async function request(url = '/numeric', { who = author, method = 'GET', body, key = randomUUID() } = {}) {
  const response = await fetch(origin + url, { method, headers: { 'Content-Type': 'application/json', ...(who ? { Authorization: 'Bearer ' + token(who) } : {}), 'Idempotency-Key': key }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: response.status, cache: response.headers.get('cache-control'), body: await response.json() };
}
test.before(async () => {
  admin = user('numeric-admin', 'admin'); author = user('numeric-author'); other = user('numeric-other');
  const gradeId = Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('6º Ano numérico',6)").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units(name,sort_order) VALUES('Números numéricos',1)").run().lastInsertRowid);
  const skillId = Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES('EF06MA11-NUM','Resolver problemas com números decimais.',?,?)").run(gradeId,unitId).lastInsertRowid);
  input = { gradeId, unitId, skillId, statement: 'Qual é a metade de 5 litros?', supportText: '', unit: 'litros', answer: '2,5', explanation: 'Divida 5 por 2.', difficulty: 'media' };
  await new Promise(resolve => { server = app.listen(0,'127.0.0.1',() => { origin = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
});
test.after(async () => { if (server) await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(directory,{recursive:true,force:true}); });
test('migração aditiva é reaplicável sem duplicar e flag permanece desligada', () => {
  assert.equal(inspectMigrations(db).pending.length,0);
  assert.equal(runMigrations(db,{logger:{info(){}}}).appliedNow.length,0);
  const flag = db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='question_bank.numeric_drafts'").get();
  assert.deepEqual(flag,{ master_enabled:0, default_enabled:0, rollout_percentage:0 });
});
test('exige autenticação, professor atual e liberação individual', async () => {
  assert.equal((await request('/numeric',{who:null})).status,401);
  assert.equal((await request()).status,404);
  assert.equal((await request('/numeric',{who:admin})).status,403);
  enable('question_bank.numeric_drafts',[author]);
  assert.equal((await request('/numeric',{who:other})).status,404);
});
test('salva rascunho privado com auditoria, retorna decimal canônico e repete sem duplicar', async () => {
  const key = randomUUID();
  const first = await request('/numeric',{method:'POST',body:input,key});
  assert.equal(first.status,201,JSON.stringify(first.body)); saved = first.body;
  assert.equal(saved.answer,'2,5'); assert.equal(saved.status,'draft');
  assert.equal(first.cache,'private, no-store');
  const repeat = await request('/numeric',{method:'POST',body:input,key});
  assert.equal(repeat.status,200); assert.equal(repeat.body.publicId,saved.publicId); assert.equal(repeat.body.replayed,true);
  assert.equal((await request('/numeric',{method:'POST',body:{...input,answer:'3'},key})).status,409);
  assert.equal(db.prepare("SELECT count(*) FROM questions WHERE question_type='numeric_draft'").pluck().get(),1);
  const base = db.prepare('SELECT * FROM questions WHERE question_code=?').get(saved.code);
  assert.equal(base.status,'inactive'); assert.equal(base.source,'teacher'); assert.equal(base.created_by,author.id);
  assert.equal(db.prepare('SELECT count(*) FROM question_options WHERE question_id=?').pluck().get(base.id),0);
  assert.equal(db.prepare('SELECT count(*) FROM typed_question_audit_log').pluck().get(),2);
});
test('decimal exato aceita vírgula/ponto/zero/negativos, sem arredondamento silencioso', async () => {
  for (const [source,expected] of [['0',0],['-0',0],['2,500',2.5],['.5',.5],['-2,5',-2.5],['999999999.999999',999999999.999999]]) assert.equal(numericValue(source),expected);
  for (const invalid of ['',null,2.5,'1.234,56','1 000','2 cm','1e3','Infinity','1/2','0.1234567','1000000000','0x10','2,']) assert.throws(() => numericValue(invalid));
  for (const [response,accepted,answered] of [['2.500',true,true],['2,5',true,true],['2.499999',false,true],['0',false,true],['',false,false]]) {
    const checked = await request(`/numeric/${saved.publicId}/check`,{method:'POST',body:{expectedRevision:1,response}});
    assert.equal(checked.status,200); assert.deepEqual(checked.body,{revision:1,accepted,answered});
  }
  assert.equal((await request(`/numeric/${saved.publicId}/check`,{method:'POST',body:{expectedRevision:1,response:'2 litros'}})).status,400);
  assert.equal(db.prepare('SELECT count(*) FROM typed_question_write_operations').pluck().get(),1);
});
test('listagem sem gabarito, isolamento entre professores e bloqueio de acesso pela autoria antiga', async () => {
  const list = await request(); assert.equal(list.body.data.length,1); assert.ok(!('answer' in list.body.data[0]));
  assert.equal((await request('/numeric?search=metade')).body.pagination.total,1);
  assert.equal((await request('/numeric?search=ausente')).body.pagination.total,0);
  enable('question_bank.numeric_drafts',[other]);
  assert.equal((await request('/numeric',{who:other})).body.pagination.total,0);
  assert.equal((await request('/numeric/' + saved.publicId,{who:other})).status,404);
  assert.equal((await request('/numeric/' + saved.publicId,{who:other,method:'PATCH',body:{...input,expectedRevision:1}})).status,404);
  enable('question_bank.typed_engine',[author]);
  assert.throws(() => getTypedAuthoringState(db,{actor:author,versionPublicId:saved.publicId}),e => e.code === 'typed_question_not_found');
  const listOld = await request('/bank/author-questions'); assert.equal(listOld.status,200); assert.equal(listOld.body.pagination.total,0);
  const questionId = db.prepare('SELECT id FROM questions WHERE question_code=?').pluck().get(saved.code);
  for (const url of [`/bank/author-questions/${questionId}`, `/bank/questions/${questionId}`]) {
    assert.equal((await request(url,{who:admin,method:'PUT',body:{statement:'Não alterar'}})).status,404);
    assert.equal((await request(url,{who:admin,method:'DELETE'})).status,404);
  }
  assert.equal((await request(`/bank/questions/${questionId}`,{who:admin})).status,404);
  assert.equal((await request('/bank/questions?status=inactive',{who:admin})).body.pagination.total,0);
  const stats = (await request('/bank/stats',{who:admin})).body;
  assert.equal(stats.total_questions,0); assert.equal(stats.teacher_questions,0); assert.equal(stats.inactive_questions,0);
  const beforeSets = db.prepare('SELECT count(*) FROM question_sets').pluck().get();
  const attempted = await request('/bank/question-sets',{method:'POST',body:{title:'Não aplicar rascunho',question_ids:[questionId]}});
  assert.equal(attempted.status,400); assert.equal(db.prepare('SELECT count(*) FROM question_sets').pluck().get(),beforeSets);
});
test('valida BNCC e campos extras sem criar registros órfãos', async () => {
  const count = db.prepare('SELECT count(*) FROM questions').pluck().get();
  for (const bad of [{...input,gradeId:999999},{...input,skillId:true},{...input,answer:'1,000,00'},{...input,publish:true},{...input,statement:''}]) {
    assert.equal((await request('/numeric',{method:'POST',body:bad})).status,400);
  }
  assert.equal(db.prepare('SELECT count(*) FROM questions').pluck().get(),count);
});
test('edição preserva habilidade, exige revisão atual, é auditada e idempotente', async () => {
  const anotherSkill = Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES('OTHER-NUM','Outra habilidade',?,?)").run(input.gradeId,input.unitId).lastInsertRowid);
  assert.equal((await request('/numeric/' + saved.publicId,{method:'PATCH',body:{...input,skillId:anotherSkill,expectedRevision:1}})).status,409);
  const key = randomUUID();
  const changed = {...input,answer:'3',statement:'Qual é a metade de 6 litros?',expectedRevision:1};
  const updated = await request('/numeric/' + saved.publicId,{method:'PATCH',body:changed,key});
  assert.equal(updated.status,200,JSON.stringify(updated.body)); assert.equal(updated.body.revision,2);
  assert.equal((await request('/numeric/' + saved.publicId,{method:'PATCH',body:changed,key})).body.revision,2);
  assert.equal((await request('/numeric/' + saved.publicId,{method:'PATCH',body:changed})).status,409);
  assert.equal((await request(`/numeric/${saved.publicId}/check`,{method:'POST',body:{response:'3',expectedRevision:1}})).status,409);
  assert.equal((await request('/numeric/' + saved.publicId)).body.answer,'3');
  assert.equal(db.prepare("SELECT count(*) FROM typed_question_write_operations WHERE operation_type='update_draft' AND actor_id=?").pluck().get(author.id),1);
  const receipt = JSON.parse(db.prepare("SELECT result_json FROM typed_question_write_operations WHERE operation_type='update_draft'").pluck().get());
  assert.equal(receipt.savedRevision,2); assert.match(receipt.definitionHash,/^[a-f0-9]{64}$/);
});
test('falha de auditoria reverte questão, versão e recibo na mesma transação', async () => {
  const before = db.prepare('SELECT count(*) FROM questions').pluck().get();
  db.exec("CREATE TRIGGER numeric_test_audit_failure BEFORE INSERT ON typed_question_write_operations BEGIN SELECT RAISE(ABORT,'synthetic_failure'); END");
  try {
    assert.equal((await request('/numeric',{method:'POST',body:input})).status,500);
    assert.equal(db.prepare('SELECT count(*) FROM questions').pluck().get(),before);
    assert.equal((await request('/numeric/' + saved.publicId,{method:'PATCH',body:{...input,expectedRevision:2}})).status,500);
    assert.equal((await request('/numeric/' + saved.publicId)).body.revision,2);
  } finally { db.exec('DROP TRIGGER numeric_test_audit_failure'); }
});
test('banco impede ativar, transformar em alternativas e publicar rascunhos', () => {
  const row = db.prepare('SELECT * FROM questions WHERE question_code=?').get(saved.code);
  assert.throws(() => db.prepare("UPDATE questions SET status='active' WHERE id=?").run(row.id),/numeric_question_must_remain_private_draft/);
  assert.throws(() => db.prepare("UPDATE questions SET question_type='multiple_choice' WHERE id=?").run(row.id),/numeric_question_must_remain_private_draft/);
  assert.throws(() => db.prepare("UPDATE typed_question_item_versions SET status='published',revision=revision+1 WHERE public_id=?").run(saved.publicId),/numeric_review_snapshot_required/);
  assert.throws(() => db.prepare("INSERT INTO question_options(question_id,option_label,option_text,is_correct,sort_order) VALUES(?,'A','3',1,1)").run(row.id),/numeric_draft_has_no_options/);
  const setId = db.prepare("INSERT INTO question_sets(title,user_id) VALUES('Conjunto sintético',?)").run(author.id).lastInsertRowid;
  assert.throws(() => db.prepare('INSERT INTO question_set_items(question_set_id,question_id,sort_order) VALUES(?,?,1)').run(setId,row.id),/numeric_draft_not_ready_for_application/);
});

test('prévia confere revisão salva; impressão exige a mesma cópia e audita sem conteúdo ou gabarito', async () => {
  const url = `/numeric/${saved.publicId}`;
  const before = db.prepare('SELECT count(*) FROM typed_question_write_operations').pluck().get();
  const preview = await request(url + '/preview', { method:'POST', body:{expectedRevision:2} });
  assert.equal(preview.status,200); assert.equal(preview.cache,'private, no-store');
  assert.equal(preview.body.draft.answer,'3'); assert.equal(preview.body.draft.revision,2);
  assert.match(preview.body.fingerprint,/^[a-f0-9]{64}$/);
  const body = {expectedRevision:2,expectedFingerprint:preview.body.fingerprint};
  const printed = await request(url + '/print',{method:'POST',body});
  assert.equal(printed.status,200); assert.deepEqual(printed.body,preview.body);
  const event = db.prepare("SELECT * FROM activity_log WHERE action='numeric_draft_print_prepared' ORDER BY id DESC LIMIT 1").get();
  const meta = JSON.parse(event.metadata_json);
  assert.deepEqual(meta,{versionPublicId:saved.publicId,revision:2,fingerprint:preview.body.fingerprint,purpose:'teacher_draft_review'});
  assert.equal(event.user_id,author.id); assert.equal(event.module,'question_bank');
  assert.equal(db.prepare('SELECT count(*) FROM typed_question_write_operations').pluck().get(),before);
  assert.equal(db.prepare('SELECT count(*) FROM typed_question_review_cycles').pluck().get(),0);
  assert.equal((await request(url + '/print',{method:'POST',body:{...body,expectedFingerprint:'a'.repeat(64)}})).status,409);
  for (const endpoint of ['preview','print']) {
    const payload = endpoint === 'preview' ? {expectedRevision:2} : body;
    assert.equal((await request(url + '/' + endpoint,{method:'POST',body:payload,who:null})).status,401);
    assert.equal((await request(url + '/' + endpoint,{method:'POST',body:payload,who:other})).status,404);
    assert.equal((await request(url + '/' + endpoint,{method:'POST',body:payload,who:admin})).status,403);
    assert.equal((await request(url + '/' + endpoint,{method:'POST',body:{...payload,expectedRevision:1}})).status,409);
    assert.equal((await request(url + '/' + endpoint,{method:'POST',body:{...payload,answer:'99'}})).status,400);
  }
  assert.equal((await request(url + '/print',{method:'POST',body:{expectedRevision:2}})).status,400);
});

test('alteração de classificação invalida cópia mesmo sem editar a versão numérica', async () => {
  const url = `/numeric/${saved.publicId}`;
  const preview = (await request(url + '/preview',{method:'POST',body:{expectedRevision:2}})).body;
  const original = db.prepare('SELECT description FROM bncc_skills WHERE id=?').pluck().get(input.skillId);
  try {
    db.prepare('UPDATE bncc_skills SET description=? WHERE id=?').run('Descrição alterada para testar revisão da cópia.',input.skillId);
    const result = await request(url + '/print',{method:'POST',body:{expectedRevision:2,expectedFingerprint:preview.fingerprint}});
    assert.equal(result.status,409); assert.equal(result.body.code,'stale_numeric_preview');
  } finally { db.prepare('UPDATE bncc_skills SET description=? WHERE id=?').run(original,input.skillId); }
});

test('falha do registro de impressão não entrega prévia e não altera rascunho', async () => {
  const url = `/numeric/${saved.publicId}`;
  const preview = (await request(url + '/preview',{method:'POST',body:{expectedRevision:2}})).body;
  const count = db.prepare("SELECT count(*) FROM activity_log WHERE action='numeric_draft_print_prepared'").pluck().get();
  db.exec("CREATE TRIGGER numeric_print_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='numeric_draft_print_prepared' BEGIN SELECT RAISE(ABORT,'synthetic_print_failure'); END");
  try {
    const response = await request(url + '/print',{method:'POST',body:{expectedRevision:2,expectedFingerprint:preview.fingerprint}});
    assert.equal(response.status,500); assert.ok(!response.body.draft); assert.doesNotMatch(JSON.stringify(response.body),/synthetic_print_failure/);
    assert.equal(db.prepare("SELECT count(*) FROM activity_log WHERE action='numeric_draft_print_prepared'").pluck().get(),count);
    assert.equal((await request(url)).body.revision,2);
  } finally { db.exec('DROP TRIGGER numeric_print_audit_failure'); }
});
test('paginação limitada e ordenação estável, papéis revogados e kill switch', async () => {
  for (let n=0;n<11;n++) saveNumericDraft(db,{actor:author,input:{...input,statement:`Pergunta ${n}`},idempotencyKey:randomUUID()});
  const p1 = (await request()).body, p2 = (await request('/numeric?page=2')).body;
  assert.equal(p1.data.length,10); assert.equal(p2.data.length,2); assert.equal(new Set([...p1.data,...p2.data].map(x=>x.publicId)).size,12);
  assert.equal((await request('/numeric?page=-1')).status,400);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(author.id);
  assert.equal((await request()).status,401);
  db.prepare("UPDATE users SET role='professor' WHERE id=?").run(author.id);
  author.authVersion = db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(author.id);
  db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Teste isolado do bloqueio',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='question_bank.numeric_drafts'").run();
  assert.equal((await request('/numeric/' + saved.publicId)).status,404);
  assert.equal((await request('/numeric',{method:'POST',body:input})).status,404);
  assert.equal((await request(`/numeric/${saved.publicId}/preview`,{method:'POST',body:{expectedRevision:2}})).status,404);
  assert.equal((await request(`/numeric/${saved.publicId}/print`,{method:'POST',body:{expectedRevision:2,expectedFingerprint:'a'.repeat(64)}})).status,404);
  assert.equal(db.pragma('integrity_check',{simple:true}),'ok'); assert.equal(db.pragma('foreign_key_check').length,0);
});
