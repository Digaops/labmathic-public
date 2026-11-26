const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-content-issues-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-content-issues-tests-only';
const db = require('../src/database'), express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const { createIssue, reviewIssue } = require('../src/services/contentIssues');
const app = express(); app.use(express.json()); app.use('/api/content-issues', require('../src/routes/contentIssues'));
app.use(require('../src/middleware/apiErrors'));
let server, base, teacher, other, admin, secondAdmin, material, question, privateQuestion, teacherAuth, otherAuth, adminAuth, secondAuth, issue;
const flag = enabled => db.prepare("UPDATE feature_flags SET master_enabled=?,default_enabled=?,rollout_percentage=? WHERE flag_key='content.issue_review'").run(enabled, enabled, enabled ? 100 : 0);
const actor = id => ({ id });
const count = table => db.prepare('SELECT COUNT(*) FROM ' + table).pluck().get();
async function request(url = '', { token = teacherAuth, method = 'GET', body, key = randomUUID() } = {}) {
  const response = await fetch(base + '/api/content-issues' + url, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control') };
}
const payload = extras => ({ targetType: 'material', targetId: material, reason: 'media', description: 'A imagem da página 3 não aparece para leitura.', ...extras });
const create = (body = payload(), options = {}) => request('', { method: 'POST', body, ...options });
const review = (body, options = {}) => request('/' + issue + '/reviews', { method: 'POST', token: adminAuth, body, ...options });
test.before(async () => {
  const account = (role, name) => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run(name, name + '@example.invalid', 'hash', role).lastInsertRowid);
  teacher = account('professor', 'docente.qa'); other = account('professor', 'outro.qa'); admin = account('admin', 'admin.qa'); secondAdmin = account('admin', 'admin2.qa');
  teacherAuth = issueUserToken(teacher); otherAuth = issueUserToken(other); adminAuth = issueUserToken(admin); secondAuth = issueUserToken(secondAdmin);
  material = Number(db.prepare("INSERT INTO materials(title,description,created_by) VALUES ('Frações na prática — material de teste','Recurso sintético para revisão.',?)").run(admin).lastInsertRowid);
  const grade = Number(db.prepare("INSERT INTO grades(name) VALUES ('5º Ano — teste')").run().lastInsertRowid);
  const unit = Number(db.prepare("INSERT INTO bncc_units(name) VALUES ('Números — teste')").run().lastInsertRowid);
  const skill = Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES ('QA05MA01','Comparar frações em situações do cotidiano.',?,?)").run(grade, unit).lastInsertRowid);
  const q = (code, source, author) => Number(db.prepare("INSERT INTO questions(question_code,skill_id,statement,created_by,source) VALUES (?,?,?, ?,?)").run(code, skill, 'Qual fração representa metade de uma quantidade?', author, source).lastInsertRowid);
  question = q('QA-FRACOES-01', 'official', admin); privateQuestion = q('QA-AUTORAL-01', 'teacher', other);
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries()) db.prepare('INSERT INTO question_options(question_id,option_label,option_text,is_correct,sort_order) VALUES (?,?,?,?,?)').run(question, label, ['1/2', '1/3', '1/4', '1/5'][i], i === 0 ? 1 : 0, i);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-content-issues-/); fs.rmSync(temp, { recursive: true, force: true }); });

test('flag desativada por padrão, sessão obrigatória e nova migração reaplicável', async () => {
  assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='content.issue_review'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
  assert.equal((await request()).status, 404); assert.equal((await create()).status, 404); assert.equal((await request('', { token: null })).status, 401);
  assert.equal(require('../src/migrations').runMigrations(db, { logger: { info() {} } }).appliedNow.length, 0); flag(1);
});
test('valida campos, não vaza existência de questão privada e rejeita envio sem chave', async () => {
  for (const extras of [{ description: 'curto' }, { description: 'a'.repeat(2001) }, { description: 'texto inválido\u0000 para testar' }, { reason: 'answer' }, { targetType: 'student' }, { targetId: -1 }, { targetId: 1.5 }, { surprise: true }]) assert.equal((await create(payload(extras))).status, 400);
  assert.equal((await create(payload(), { key: null })).status, 400);
  assert.equal((await create(payload({ targetId: [material] }))).status, 400);
  assert.equal((await create(payload({ targetType: 'question', targetId: privateQuestion }))).status, 404);
  assert.equal((await create(payload({ targetId: 999999 }))).status, 404);
  db.prepare("UPDATE questions SET status='inactive' WHERE id=?").run(question);
  assert.equal((await create(payload({ targetType: 'question', targetId: question }))).status, 404);
  db.prepare("UPDATE questions SET status='active' WHERE id=?").run(question);
});
test('envio concorrente é idempotente; duplicação ativa leva ao relato existente sem substituir texto', async () => {
  const key = randomUUID(), before = count('content_issues');
  const responses = await Promise.all([create(payload(), { key }), create(payload(), { key })]);
  responses.forEach(r => assert.equal(r.status, 200, JSON.stringify(r.data))); assert.deepEqual(responses[0].data, responses[1].data);
  issue = responses[0].data.id; assert.equal(count('content_issues'), before + 1);
  assert.equal((await create(payload({ description: 'Outra descrição para testar idempotência.' }), { key })).status, 409);
  const duplicate = await create(payload({ description: 'Novo texto que não deve substituir o anterior.' })); assert.equal(duplicate.data.id, issue); assert.equal(duplicate.data.alreadyOpen, true);
  const detail = await request('/' + issue); assert.equal(detail.data.description, payload().description); assert.equal(detail.data.events.length, 1); assert.match(detail.cache, /no-store/);
  const audit = db.prepare("SELECT metadata_json FROM activity_log WHERE action='content_issue_created'").all(); assert.equal(audit.length, 1); assert.doesNotMatch(JSON.stringify(audit), /imagem|página/);
});
test('professor só vê os próprios relatos, administração consulta fila, filtros inválidos são rejeitados', async () => {
  assert.equal((await request('', { token: otherAuth })).data.total, 0); assert.equal((await request('/' + issue, { token: otherAuth })).status, 404);
  assert.equal((await review({ action: 'claim', expectedRevision: 1 }, { token: teacherAuth })).status, 403);
  assert.equal((await request('?status=pending', { token: adminAuth })).data.total, 1);
  for (const url of ['?status=wrong', '?page=0', '?page=1.5', '?page=10001']) assert.equal((await request(url)).status, 400);
});
test('assumir revisão usa versão; outro administrador não pode concluir nem tomar atendimento ativo', async () => {
  assert.equal((await review({ action: 'resolved', expectedRevision: 1, reply: 'Conferência sintética do conteúdo.', confirmed: true })).status, 409);
  const key = randomUUID(), body = { action: 'claim', expectedRevision: 1 };
  const responses = await Promise.all([review(body, { key }), review(body, { key })]); assert.deepEqual(responses[0].data, responses[1].data); assert.equal(responses[0].status, 200);
  assert.equal((await review(body, { token: secondAuth })).data.code, 'review_conflict');
  assert.equal((await review({ action: 'claim', expectedRevision: 2 }, { token: secondAuth })).status, 409);
  assert.equal((await review({ action: 'resolved', expectedRevision: 2, reply: 'Resposta sintética do outro administrador.', confirmed: true }, { token: secondAuth })).status, 409);
  assert.equal((await request('/' + issue, { token: adminAuth })).data.canReview, true);
});
test('perfil atual e revogação são respeitados; responsável removido do papel pode ser substituído', async () => {
  db.prepare("UPDATE users SET role='professor' WHERE id=?").run(admin);
  assert.equal((await review({ action: 'claim', expectedRevision: 2 })).status, 401);
  adminAuth = issueUserToken(admin);
  assert.equal((await review({ action: 'claim', expectedRevision: 2 })).status, 403);
  assert.equal((await request('/' + issue, { token: adminAuth })).status, 404);
  assert.equal((await request('/' + issue, { token: secondAuth })).data.canClaim, true);
  assert.equal((await review({ action: 'claim', expectedRevision: 2 }, { token: secondAuth })).status, 200);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin);
  adminAuth = issueUserToken(admin);
  db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(other);
  assert.equal((await request('', { token: otherAuth })).status, 401); otherAuth = issueUserToken(other);
});
test('conclusão exige confirmação e resposta; preserva acervo e histórico, não permite reescrever decisão', async () => {
  const before = ['materials', 'questions', 'question_options', 'class_assessment_assignments', 'class_assessment_items'].map(t => db.prepare('SELECT * FROM ' + t).all());
  const body = { action: 'not_changed', expectedRevision: 3, reply: 'Conferimos o recurso: a imagem está na página seguinte. Nenhuma alteração foi necessária.', confirmed: true };
  assert.equal((await review({ ...body, confirmed: false }, { token: secondAuth })).status, 400); assert.equal((await review({ ...body, reply: 'curto' }, { token: secondAuth })).status, 400);
  assert.equal((await review(body, { token: secondAuth })).status, 200);
  assert.deepEqual(['materials', 'questions', 'question_options', 'class_assessment_assignments', 'class_assessment_items'].map(t => db.prepare('SELECT * FROM ' + t).all()), before);
  const detail = (await request('/' + issue)).data; assert.equal(detail.status, 'not_changed'); assert.equal(detail.events.length, 4); assert.equal(detail.events[3].reply, body.reply); assert.equal(detail.canReview, false);
  assert.equal((await review({ ...body, expectedRevision: 4 }, { token: secondAuth })).status, 409);
  assert.throws(() => db.exec("UPDATE content_issue_events SET reply='alterado'"), /immutable/); assert.throws(() => db.exec('DELETE FROM content_issue_events'), /immutable/);
});
test('falha de auditoria reverte criação e revisão sem deixar recibo ou histórico parcial', async () => {
  const before = ['content_issues', 'content_issue_events', 'content_issue_operations'].map(t => db.prepare('SELECT * FROM ' + t).all());
  assert.throws(() => createIssue(db, { actor: actor(teacher), key: randomUUID(), body: payload(), audit() { throw Error('auditoria indisponível'); } }), /auditoria indisponível/);
  assert.deepEqual(['content_issues', 'content_issue_events', 'content_issue_operations'].map(t => db.prepare('SELECT * FROM ' + t).all()), before);
  const next = await create(); issue = next.data.id;
  const state = (await request('/' + issue, { token: adminAuth })).data;
  assert.throws(() => reviewIssue(db, { actor: actor(admin), publicId: issue, key: randomUUID(), body: { action: 'claim', expectedRevision: 1 }, audit() { throw Error('auditoria indisponível'); } }), /auditoria indisponível/);
  assert.deepEqual((await request('/' + issue, { token: adminAuth })).data, state);
});
test('kill switch bloqueia leitura e escrita inclusive repetição; histórico resiste à exclusão do material', async () => {
  const key = randomUUID(), body = payload({ targetType: 'question', targetId: question, reason: 'answer' });
  const created = await create(body, { key }); assert.equal(created.status, 200);
  db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Pausa sintética de segurança' WHERE flag_key='content.issue_review'").run();
  assert.equal((await create(body, { key })).status, 404); assert.equal((await request()).status, 404);
  db.prepare("UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key='content.issue_review'").run();
  assert.deepEqual((await create(body, { key })).data, created.data);
  db.prepare('DELETE FROM materials WHERE id=?').run(material);
  const detail = (await request('/' + issue)).data; assert.equal(detail.targetAvailable, false); assert.equal(detail.targetPath, null); assert.match(detail.targetLabel, /Frações/);
});
test('limite diário persistente, proprietário autoral e paginação sem duplicação', async () => {
  assert.equal((await create(payload({ targetType: 'question', targetId: privateQuestion }), { token: otherAuth })).status, 200);
  for (let i = 0; i < 10; i++) {
    const id = Number(db.prepare('INSERT INTO materials(title,created_by) VALUES (?,?)').run('Material extra ' + i, admin).lastInsertRowid);
    const response = await create(payload({ targetId: id }));
    assert.equal(response.status, i < 7 ? 200 : 429, JSON.stringify(response.data));
  }
  // Seed older, synthetic reports to exercise paginated reads without bypassing API quotas for current writes.
  for (let i = 0; i < 25; i++) db.prepare("INSERT INTO content_issues(public_id,reporter_id,target_type,target_id,target_label,reason,description,created_at) VALUES (?,?,'material',?,'Exemplo antigo','content','Descrição sintética para paginação.',datetime('now','-2 days'))").run(randomUUID(), other, 10000 + i);
  const first = (await request('', { token: otherAuth })).data, next = (await request('?page=2', { token: otherAuth })).data;
  assert.equal(first.items.length, 20); assert.equal(next.items.length, 6); assert.equal(new Set([...first.items, ...next.items].map(i => i.id)).size, 26);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
});
test('reenvios com chaves novas não fazem crescer recibos sem limite', async () => {
  const body = payload({ targetType: 'question', targetId: privateQuestion });
  const current = db.prepare('SELECT COUNT(*) FROM content_issue_operations WHERE actor_id=?').pluck().get(other);
  for (let i = current; i < 30; i++) assert.equal((await create(body, { token: otherAuth })).status, 200);
  assert.equal((await create(body, { token: otherAuth })).status, 429);
});

test('conclusão com ajuste é explícita e não executa edição automática na questão', async () => {
  const before = db.prepare('SELECT * FROM questions WHERE id=?').get(question);
  const report = await create(payload({ targetType: 'question', targetId: question, reason: 'answer' }), { token: adminAuth });
  assert.equal(report.status, 200);
  const path = '/' + report.data.id + '/reviews';
  const claim = await request(path, { token: adminAuth, method: 'POST', body: { action: 'claim', expectedRevision: 1 } });
  assert.equal(claim.status, 200);
  const body = { action: 'resolved', expectedRevision: 2, reply: 'Registro sintético de revisão. Edição do acervo ocorre em outra operação.', confirmed: true }, key = randomUUID();
  const resolved = await request(path, { token: adminAuth, method: 'POST', body, key });
  assert.equal(resolved.status, 200);
  assert.deepEqual((await request(path, { token: adminAuth, method: 'POST', body, key })).data, resolved.data);
  assert.equal((await request('/' + report.data.id, { token: adminAuth })).data.status, 'resolved');
  assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id=?').get(question), before);
});

test('conferência visual operacional opt-in, somente localhost e banco descartável', { skip: process.env.CONTENT_ISSUE_INTERACTIVE_QA !== '1', timeout: 1260000 }, async () => {
  assert.match(db.name, /labmathic-content-issues-[^/\\]+[/\\]database\.sqlite$/); assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
  const build = path.resolve(__dirname, '../../tmp/content-issues-build'); assert.ok(fs.existsSync(path.join(build, 'index.html')));
  const config = require('../src/config'); config.smtp.user = ''; config.smtp.pass = ''; config.appEnvironment = 'development';
  const password = await require('bcryptjs').hash('Visual-QA-Only-2026!', 10);
  db.prepare('UPDATE users SET password=?').run(password);
  // Date-shift synthetic fixture quotas, without changing the production quota implementation.
  db.prepare("UPDATE content_issues SET created_at=datetime('now','-2 days')").run();
  db.prepare("UPDATE content_issue_operations SET created_at=datetime('now','-2 days')").run();
  material = Number(db.prepare("INSERT INTO materials(title,description,created_by) VALUES ('Frações na prática — conferência visual','Material sintético, sem estudantes reais.',?)").run(admin).lastInsertRowid);
  for (const route of ['auth', 'governance', 'classes', 'notifications', 'announcements', 'categories', 'materials', 'favorites', 'ratings', 'comments', 'support', 'reports']) app.use('/api/' + route, require('../src/routes/' + route));
  app.use('/api/question-bank', require('../src/routes/questionBank'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API de teste não disponível.' }));
  let finish; const done = new Promise(resolve => { finish = resolve; });
  app.get('/__qa', (_req, res) => res.send('<h1>Conferência sintética isolada</h1><form method="post" action="/__qa/finish"><button>Encerrar conferência local</button></form>'));
  app.post('/__qa/finish', (_req, res) => { res.send('Conferência encerrada.'); setTimeout(finish, 100); });
  app.use(express.static(build)); app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
  console.log('CONTENT_ISSUE_QA_READY', JSON.stringify({ baseUrl: base, teacher: 'docente.qa@example.invalid', admin: 'admin.qa@example.invalid', materialId: material, questionId: question }));
  const timer = setTimeout(finish, 1200000); try { await done; } finally { clearTimeout(timer); }
});
