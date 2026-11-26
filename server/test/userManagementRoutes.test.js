const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-users-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-users-qa37';
const express = require('express'), db = require('../src/database'), { issueUserToken, verifyUserToken } = require('../src/services/authSessions');
const app = express(); app.use(express.json()); app.use('/api/users', require('../src/routes/users')); app.use(require('../src/middleware/apiErrors'));
const passwords = require('../src/services/passwordOperations');
let server, base, admin, teacher, auth, teacherAuth;
const insert = (role = 'professor') => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run('Pessoa sintética', randomUUID() + '@example.invalid', 'hash', role).lastInsertRowid);
test.before(async () => { admin = insert('admin'); teacher = insert(); auth = issueUserToken(admin); teacherAuth = issueUserToken(teacher); await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api/users`; resolve(); }); }); });
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-users-/); fs.rmSync(temp, { recursive: true, force: true }); });
async function request(route = '', method = 'GET', body, token = auth) {
  const r = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body && method !== 'GET' ? { body: JSON.stringify(body) } : {}) });
  return { status: r.status, body: await r.json(), cache: r.headers.get('cache-control') };
}
async function detail(id) { const r = await request('/' + id); assert.equal(r.status, 200); return r.body; }
const input = patch => ({ name: 'Pessoa QA37', email: randomUUID() + '@example.invalid', password: 'Senha-Sintetica-37!', role: 'professor', ...patch });

test('lista legada, detalhe privado, autorização e ausência de hashes', async () => {
  assert.equal((await request('', 'GET', null, null)).status, 401);
  for (const [route, method] of [['', 'GET'], ['/' + teacher, 'GET'], ['', 'POST'], ['/' + teacher, 'PUT'], ['/' + teacher + '/reset-password', 'PUT'], ['/' + teacher, 'DELETE']]) assert.equal((await request(route, method, input(), teacherAuth)).status, 403);
  const list = await request(); assert.equal(list.status, 200); assert.ok(Array.isArray(list.body)); assert.match(list.cache, /no-store/);
  const text = JSON.stringify(list.body); assert.equal(text.includes('password'), false); assert.equal(text.includes('auth_version'), false);
  assert.match((await detail(teacher)).version, /^[a-f0-9]{64}$/);
  for (const id of ['0', '01', '1x', '99999999999999999999']) assert.equal((await request('/' + id)).status, 400);
  assert.equal((await request('/999999')).status, 404);
});
test('criar, editar e excluir conta sem vínculos mantém auditoria e contrato legado', async () => {
  const data = input({ name: '  Nome QA37  ', email: '  NOVO-QA37@EXAMPLE.INVALID  ' });
  const created = await request('', 'POST', data); assert.equal(created.status, 201); const id = created.body.id;
  assert.equal(created.body.name, 'Nome QA37'); assert.equal(created.body.email, 'novo-qa37@example.invalid');
  assert.equal(await passwords.compare(data.password, db.prepare('SELECT password FROM users WHERE id=?').pluck().get(id)), true);
  assert.equal((await detail(id)).deletion_block, null);
  const updated = await request('/' + id, 'PUT', { name: 'Revisada', expectedVersion: created.body.version }); assert.equal(updated.status, 200); assert.notEqual(updated.body.version, created.body.version);
  assert.equal((await request('/' + id, 'PUT', { name: 'Legado' })).status, 200);
  const removed = await request('/' + id, 'DELETE', { expectedVersion: (await detail(id)).version }); assert.equal(removed.status, 200); assert.equal(removed.body.deleted, id);
  assert.equal(db.prepare('SELECT id FROM users WHERE id=?').get(id), undefined);
  assert.equal((await request('/' + id, 'PUT', { name: 'Edição atrasada', expectedVersion: updated.body.version })).status, 404);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM activity_log WHERE module='users' AND entity_id=?").get(id).n, 4);
});
test('versão desatualizada e alteração que volta ao valor anterior não sobrescrevem', async () => {
  const id = insert(), original = await detail(id);
  await request('/' + id, 'PUT', { name: 'Intermediário' }); await request('/' + id, 'PUT', { name: original.name });
  for (const [route, method, body] of [['/' + id, 'PUT', { name: 'Perder' }], ['/' + id, 'DELETE', {}], ['/' + id + '/reset-password', 'PUT', { password: 'Nova-Senha-37!' }]]) {
    const r = await request(route, method, { ...body, expectedVersion: original.version }); assert.equal(r.status, 409); assert.equal(r.body.code, 'USER_CHANGED');
  }
  assert.equal((await detail(id)).name, original.name);
  assert.equal((await request('/' + id, 'PUT', { expectedVersion: 'invalid' })).status, 400);
});
test('normalização de e-mail impede duplicidade; campos inválidos não gravam', async () => {
  const id = insert(), other = insert(); db.prepare('UPDATE users SET email=? WHERE id=?').run('  OUTRA@EXAMPLE.INVALID  ', other);
  assert.equal((await request('/' + id, 'PUT', { email: 'outra@example.invalid' })).status, 409);
  assert.equal((await request('', 'POST', input({ email: 'OUTRA@example.invalid' }))).status, 409);
  for (const body of [{ name: ' ' }, { name: 'x'.repeat(101) }, { email: '' }, { email: ['a'] }, { role: 'root' }, { password: 'senha-ignorada' }]) assert.equal((await request('/' + id, 'PUT', body)).status, 400);
  for (const password of ['', 'curta', 'x'.repeat(1025), []]) assert.equal((await request('', 'POST', input({ password }))).status, 400);
});
test('último administrador e própria conta permanecem protegidos', async () => {
  assert.equal((await request('/' + admin, 'PUT', { role: 'professor' })).status, 409);
  assert.equal((await request('/' + admin, 'DELETE')).status, 400);
  assert.match((await detail(admin)).deletion_block, /própria conta/); assert.equal((await detail(admin)).role, 'admin');
});
test('referências CASCADE e SET NULL atuais ou futuras bloqueiam exclusão sem apagar vínculos', async () => {
  const id = insert(); await detail(id); // populate metadata cache before future schema
  const grade = db.prepare('SELECT id FROM grades LIMIT 1').pluck().get() || Number(db.prepare("INSERT INTO grades(name) VALUES ('QA37')").run().lastInsertRowid);
  db.prepare('INSERT INTO teacher_grade_preference_profiles(teacher_id) VALUES (?)').run(id);
  db.prepare('INSERT INTO teacher_grade_preferences(teacher_id,grade_id) VALUES (?,?)').run(id, grade);
  assert.equal((await request('/' + id, 'PUT', { role: 'admin' })).body.code, 'ROLE_LINKED'); assert.match((await detail(id)).role_change_block, /anos escolares/);
  assert.equal((await request('/' + id, 'DELETE')).status, 409); assert.ok(db.prepare('SELECT 1 FROM teacher_grade_preferences WHERE teacher_id=?').get(id));
  const other = insert(); db.exec('CREATE TABLE qa37_future_link(user_id INTEGER REFERENCES users(id) ON DELETE SET NULL)'); db.prepare('INSERT INTO qa37_future_link VALUES (?)').run(other);
  assert.match((await detail(other)).deletion_block, /histórico/); assert.equal((await request('/' + other, 'DELETE')).status, 409); assert.equal(db.prepare('SELECT user_id FROM qa37_future_link').pluck().get(), other);
  const future = insert(); db.exec('CREATE TABLE qa37_future_key(email TEXT REFERENCES users(email) ON DELETE CASCADE)');
  assert.equal((await request('/' + future, 'DELETE')).status, 409); db.exec('DROP TABLE qa37_future_key');
});
test('reset exclusivo revoga sessões e tokens sem colocar senha na auditoria', async () => {
  const id = insert(), token = issueUserToken(id), version = (await detail(id)).version;
  db.prepare('INSERT INTO password_reset_tokens(user_id,token,expires_at) VALUES (?,?,?)').run(id, 'qa37-reset-link', new Date(Date.now() + 60000).toISOString());
  const r = await request('/' + id + '/reset-password', 'PUT', { password: 'Nova-Senha-Secreta-37!', expectedVersion: version }); assert.equal(r.status, 200); assert.equal(r.body.user.id, id);
  assert.throws(() => verifyUserToken(token)); assert.notEqual(r.body.user.version, version);
  assert.equal(db.prepare('SELECT used FROM password_reset_tokens WHERE user_id=?').pluck().get(id), 1);
  const audit = JSON.stringify(db.prepare('SELECT * FROM activity_log WHERE entity_id=?').all(id)); assert.equal(audit.includes('Nova-Senha-Secreta-37!'), false); assert.equal(audit.includes('$2'), false);
});
test('conta renomeada durante processamento de senha não recebe reset de uma revisão antiga', async () => {
  const id = insert(), item = await detail(id), originalHash = passwords.hash;
  let release, started; const ready = new Promise(r => started = r);
  passwords.hash = () => { started(); return new Promise(r => release = r); };
  try {
    const pending = request('/' + id + '/reset-password', 'PUT', { password: 'Senha-Nova-QA37!', expectedVersion: item.version });
    await ready; db.prepare('UPDATE users SET name=? WHERE id=?').run('Nome mudou durante hash', id); release('hash-nao-deve-ser-salvo');
    const result = await pending; assert.equal(result.status, 409); assert.equal(result.body.code, 'USER_CHANGED'); assert.equal(db.prepare('SELECT password FROM users WHERE id=?').pluck().get(id), 'hash');
  } finally { passwords.hash = originalHash; }
});
test('falha de auditoria desfaz criação, edição, reset e exclusão', async () => {
  const id = insert(), before = db.prepare('SELECT * FROM users WHERE id=?').get(id), token = issueUserToken(id), data = input();
  db.exec("CREATE TRIGGER qa37_fail_audit BEFORE INSERT ON activity_log BEGIN SELECT RAISE(ABORT, 'qa37 audit unavailable'); END");
  try {
    assert.equal((await request('', 'POST', data)).status, 500); assert.equal(db.prepare('SELECT id FROM users WHERE email=?').get(data.email), undefined);
    for (const [route, method, body] of [['/' + id, 'PUT', { name: 'Não salvar' }], ['/' + id + '/reset-password', 'PUT', { password: 'Nao-Salvar-37!' }], ['/' + id, 'DELETE', {}]]) assert.equal((await request(route, method, body)).status, 500);
    assert.deepEqual(db.prepare('SELECT * FROM users WHERE id=?').get(id), before); assert.equal(verifyUserToken(token).user.id, id);
  } finally { db.exec('DROP TRIGGER qa37_fail_audit'); }
});

test('consulta docente: somente administrador atual, conta existente e sem simulação por query', async () => {
  const route = '/' + teacher + '/access-check';
  assert.equal((await request(route, 'GET', null, null)).status, 401);
  assert.equal((await request(route, 'GET', null, teacherAuth)).status, 403);
  assert.equal((await request('/999999/access-check')).status, 404);
  assert.equal((await request('/01/access-check')).status, 400);
  assert.equal((await request('/' + admin + '/access-check')).status, 409);
  assert.equal((await request(route + '?role=admin')).status, 400);
  const demoted = insert('admin'), token = issueUserToken(demoted);
  db.prepare("UPDATE users SET role='professor' WHERE id=?").run(demoted);
  assert.equal((await request(route, 'GET', null, token)).status, 401);
});

test('consulta docente: auditoria sem alterar versão, contas, regras ou dados pedagógicos', async () => {
  const tables = ['users', 'feature_flags', 'feature_flag_user_rules', 'feature_flag_group_rules', 'feature_flag_role_rules', 'pilot_groups', 'pilot_group_members', 'school_classes'];
  const snapshot = () => Object.fromEntries(tables.map(table => [table, db.prepare('SELECT * FROM ' + table).all()]));
  const before = snapshot(), version = (await detail(teacher)).version;
  const response = await request('/' + teacher + '/access-check'); assert.equal(response.status, 200); assert.match(response.cache, /no-store/);
  assert.deepEqual(Object.keys(response.body.user).sort(), ['email', 'id', 'name', 'role']);
  assert.deepEqual(snapshot(), before); assert.equal((await detail(teacher)).version, version);
  const log = db.prepare("SELECT * FROM activity_log WHERE action='check_teacher_access' ORDER BY id DESC LIMIT 1").get();
  assert.equal(log.user_id, admin); assert.equal(log.entity_id, teacher); assert.equal(log.entity_type, 'user_access');
  assert.deepEqual(JSON.parse(log.metadata_json).features, response.body.features);
  assert.deepEqual(JSON.parse(log.metadata_json).pilots, response.body.pilots);
  const m = await import('../../client/src/services/teacherAccessView.mjs'); assert.equal(m.teacherAccessView(response.body, teacher).features.length, 12);
  assert.equal(m.teacherAccessView(response.body, teacher).pilotFeatures.length, 4);
  for (const forbidden of ['password', 'auth_version', 'student', 'bucket', 'group_id', 'feedback_history']) assert.equal(JSON.stringify(response.body).includes('"' + forbidden + '"'), false);
});

test('consulta docente: usa regras reais, bloqueios de dependências e exceção de homologação', async () => {
  const config = require('../src/config'), previousEnvironment = config.appEnvironment;
  db.exec('SAVEPOINT access_check_test');
  try {
    const catalog = require('../../shared/teacherAccessCatalog.json');
    for (const key of Object.keys(catalog.flags)) {
      db.prepare('INSERT OR IGNORE INTO feature_flags(flag_key,name) VALUES (?,?)').run(key, key);
      db.prepare('UPDATE feature_flags SET master_enabled=1,default_enabled=1,kill_switch_active=0,release_id=NULL,rollout_percentage=0 WHERE flag_key=?').run(key);
    }
    db.exec('DELETE FROM feature_flag_user_rules; DELETE FROM feature_flag_role_rules; DELETE FROM feature_flag_group_rules');
    const flagId = key => db.prepare('SELECT id FROM feature_flags WHERE flag_key=?').pluck().get(key);
    const get = async () => (await request('/' + teacher + '/access-check')).body;
    const row = (data, id) => data.features.find(feature => feature.id === id);
    assert.ok((await get()).features.every(feature => feature.enabled));
    db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) VALUES (?,?,0,'Teste sintético')").run(flagId('pedagogy.operational_cycle'), teacher);
    let data = await get(); assert.equal(row(data, 'bank').enabled, false); assert.equal(row(data, 'feedback').checks[0].reason, 'user_rule'); assert.equal(row(data, 'feedback_example').enabled, true);
    db.prepare('UPDATE feature_flag_user_rules SET enabled=1 WHERE user_id=?').run(teacher);
    db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Interrupção sintética do teste' WHERE flag_key=?").run('classes.assessment_results');
    data = await get(); assert.equal(row(data, 'feedback').enabled, false); assert.equal(row(data, 'bank').enabled, true); assert.equal(row(data, 'recovery').enabled, false);
    assert.equal(row(data, 'results').checks.at(-1).reason, 'kill_switch');
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run('classes.core');
    assert.equal(row(await get(), 'classes').checks[0].reason, 'master_disabled');
    config.appEnvironment = 'homologation';
    data = await get(); assert.equal(row(data, 'classes').checks[0].reason, 'homologation_open_testing'); assert.equal(row(data, 'results').enabled, false);
    db.prepare('DELETE FROM feature_flags WHERE flag_key=?').run('question_bank.typed_preview');
    assert.equal(row(await get(), 'formats_example').checks[0].reason, 'not_found');
    config.appEnvironment = 'development';
    const group = Number(db.prepare("INSERT INTO pilot_groups(group_key,name) VALUES ('access-qa','Grupo sintético')").run().lastInsertRowid);
    db.prepare('INSERT INTO pilot_group_members(group_id,user_id) VALUES (?,?)').run(group, teacher);
    db.prepare("INSERT INTO feature_flag_group_rules(feature_flag_id,group_id,enabled,reason) VALUES (?,?,0,'Teste sintético')").run(flagId('pedagogy.operational_cycle'), group);
    assert.equal(row(await get(), 'bank').checks[0].reason, 'user_rule');
    db.prepare('DELETE FROM feature_flag_user_rules WHERE user_id=?').run(teacher);
    assert.equal(row(await get(), 'bank').checks[0].reason, 'pilot_group_disabled');
    db.prepare('UPDATE feature_flag_group_rules SET enabled=1 WHERE group_id=?').run(group);
    assert.equal(row(await get(), 'bank').checks[0].reason, 'pilot_group_enabled');
  } finally { config.appEnvironment = previousEnvironment; db.exec('ROLLBACK TO access_check_test; RELEASE access_check_test'); }
});

test('consulta docente: erro de auditoria não entrega resultado não registrado', async () => {
  const before = (await detail(teacher)).version;
  db.exec("CREATE TRIGGER access_fail_audit BEFORE INSERT ON activity_log WHEN NEW.action='check_teacher_access' BEGIN SELECT RAISE(ABORT, 'synthetic audit unavailable'); END");
  try {
    const response = await request('/' + teacher + '/access-check'); assert.equal(response.status, 500); assert.equal(response.body.features, undefined);
    assert.equal(response.body.pilots, undefined);
    assert.equal((await detail(teacher)).version, before);
  } finally { db.exec('DROP TRIGGER access_fail_audit'); }
});

test('consulta docente: novos pilotos refletem as dependências reais sem ativação implícita na homologação', async () => {
  const config = require('../src/config'), previousEnvironment = config.appEnvironment;
  db.exec('SAVEPOINT pilot_access_check_test');
  try {
    const catalog = require('../../shared/teacherAccessCatalog.json'), pilots = require('../../shared/teacherPilotAccessCatalog.json');
    for (const key of Object.keys({ ...catalog.flags, ...pilots.flags })) {
      db.prepare('INSERT OR IGNORE INTO feature_flags(flag_key,name) VALUES (?,?)').run(key, key);
      db.prepare('UPDATE feature_flags SET master_enabled=1,default_enabled=1,kill_switch_active=0,release_id=NULL,rollout_percentage=0 WHERE flag_key=?').run(key);
    }
    db.exec('DELETE FROM feature_flag_user_rules; DELETE FROM feature_flag_role_rules; DELETE FROM feature_flag_group_rules');
    const flagId = key => db.prepare('SELECT id FROM feature_flags WHERE flag_key=?').pluck().get(key);
    const get = async () => { const r = await request('/' + teacher + '/access-check'); assert.equal(r.status, 200); return r.body; };
    const row = (data, id) => data.pilots.features.find(feature => feature.id === id);
    let data = await get(); assert.ok(data.pilots.features.every(f => f.enabled));
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run('question_bank.numeric_drafts');
    data = await get(); assert.equal(row(data, 'numeric_authoring').enabled, false); assert.equal(row(data, 'numeric_assessments').enabled, true);
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run('classes.numeric_assessments');
    config.appEnvironment = 'homologation';
    data = await get();
    for (const id of ['numeric_authoring', 'numeric_assessments']) {
      assert.equal(row(data, id).enabled, false); assert.equal(row(data, id).checks.at(-1).reason, 'master_disabled');
    }
    db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Interrupção sintética do teste' WHERE flag_key=?").run('classes.assessment_results');
    data = await get(); assert.equal(row(data, 'student_feedback').enabled, false);
    assert.equal(row(data, 'student_feedback').checks.find(c => c.key === 'classes.assessment_results').reason, 'kill_switch');
    assert.equal(row(data, 'content_issues').enabled, true);
    config.appEnvironment = 'development';
    db.prepare('UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key=?').run('classes.assessment_results');
    db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) VALUES (?,?,0,'Teste sintético')").run(flagId('classes.student_feedback_release'), teacher);
    data = await get(); assert.equal(row(data, 'student_feedback').checks.at(-1).reason, 'user_rule');
    assert.equal(row(data, 'student_feedback').enabled, false);
    assert.equal(data.features.find(f => f.id === 'feedback').enabled, true);
    db.prepare('DELETE FROM feature_flags WHERE flag_key=?').run('content.issue_review');
    data = await get(); assert.equal(row(data, 'content_issues').checks[0].reason, 'not_found');
    const m = await import('../../client/src/services/teacherAccessView.mjs');
    assert.equal(m.teacherAccessView(data, teacher).pilotFeatures.filter(f => !f.enabled).length, 4);
  } finally { config.appEnvironment = previousEnvironment; db.exec('ROLLBACK TO pilot_access_check_test; RELEASE pilot_access_check_test'); }
});
