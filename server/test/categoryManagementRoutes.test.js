const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-categories-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-categories-qa36';
const express = require('express'), db = require('../src/database'), { issueUserToken } = require('../src/services/authSessions');
const app = express(); app.use(express.json()); app.use('/api/categories', require('../src/routes/categories')); app.use(require('../src/middleware/apiErrors'));
const kinds = ['disciplines', 'grades', 'topics', 'material-types'];
let server, base, admin, teacher, auth, teacherAuth;
test.before(async () => {
  const user = role => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run('Pessoa sintética', randomUUID() + '@example.invalid', 'hash', role).lastInsertRowid);
  admin = user('admin'); teacher = user('professor'); auth = issueUserToken(admin); teacherAuth = issueUserToken(teacher);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api/categories`; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-categories-/); fs.rmSync(temp, { recursive: true, force: true }); });
async function request(route, method = 'GET', body, token = auth) {
  const res = await fetch(base + route, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}
async function create(kind, patch = {}) { const r = await request('/' + kind, 'POST', { name: randomUUID(), ...patch }); assert.equal(r.status, 201); return r.body; }
async function detail(kind, id) { return (await request('/management/' + kind + '/' + id)).body.item; }

test('leituras docentes mantêm contrato; gestão e escritas exigem administrador', async () => {
  for (const kind of kinds) {
    assert.equal((await request('/' + kind, 'GET', null, null)).status, 401);
    const read = await request('/' + kind, 'GET', null, teacherAuth); assert.equal(read.status, 200); assert.ok(Array.isArray(read.body)); assert.match(read.cache, /no-store/);
    assert.equal((await request('/management/' + kind, 'GET', null, teacherAuth)).status, 403);
    assert.equal((await request('/' + kind, 'POST', { name: 'Recusar' }, teacherAuth)).status, 403);
  }
  assert.equal((await request('/management/invalid')).status, 404);
  assert.equal((await request('/management/grades/0')).status, 400);
});
for (const kind of kinds) test('ciclo auditado e contrato legado: ' + kind, async () => {
  const item = await create(kind, { name: 'QA36 ' + kind, ...(kind === 'grades' ? { sort_order: 6 } : {}), ...(kind === 'material-types' ? { icon: 'pdf' } : {}) });
  assert.match(item.version, /^[a-f0-9]{64}$/); assert.equal(item.other_usage_count, 0);
  assert.equal((await detail(kind, item.id)).name, item.name);
  const change = await request('/' + kind + '/' + item.id, 'PUT', { name: item.name + ' revisada', expectedVersion: item.version }); assert.equal(change.status, 200); assert.notEqual(change.body.version, item.version);
  if (kind === 'grades') assert.equal(change.body.sort_order, 6); if (kind === 'material-types') assert.equal(change.body.icon, 'pdf');
  const legacy = await request('/' + kind + '/' + item.id, 'PUT', { name: item.name }); assert.equal(legacy.status, 200);
  const duplicate = await request('/' + kind, 'POST', { name: item.name }); assert.equal(duplicate.status, 409);
  const gone = await request('/' + kind + '/' + item.id, 'DELETE', { expectedVersion: legacy.body.version }); assert.equal(gone.status, 200); assert.equal(gone.body.deleted, item.id);
  assert.equal((await request('/management/' + kind + '/' + item.id)).status, 404);
  const events = db.prepare('SELECT action,metadata_json FROM activity_log WHERE entity_type=? AND entity_id=? ORDER BY id').all('category_' + (kind === 'material-types' ? 'material_types' : kind), item.id);
  assert.deepEqual(events.map(e => e.action), ['create_category', 'update_category', 'update_category', 'delete_category']); assert.equal(JSON.parse(events.at(-1).metadata_json).before.name, item.name);
});
test('edição de outra pessoa e ida/volta de nome invalidam a versão anterior', async () => {
  const item = await create('topics');
  const update = await request('/topics/' + item.id, 'PUT', { name: item.name + ' nova', expectedVersion: item.version }); assert.equal(update.status, 200);
  assert.equal((await request('/topics/' + item.id, 'PUT', { name: item.name })).status, 200);
  const conflict = await request('/topics/' + item.id, 'DELETE', { expectedVersion: item.version }); assert.equal(conflict.status, 409); assert.equal(conflict.body.code, 'category_changed');
  assert.equal((await request('/topics/' + item.id, 'PUT', { name: 'Não sobrescrever', expectedVersion: item.version })).status, 409);
  assert.equal((await detail('topics', item.id)).name, item.name);
});
test('nenhum tipo de categoria exclui ou desclassifica material vinculado', async () => {
  for (const kind of kinds) {
    const item = await create(kind); const column = { disciplines: 'discipline_id', grades: 'grade_id', 'material-types': 'material_type_id' }[kind];
    const material = Number(db.prepare('INSERT INTO materials(title' + (column ? ',' + column : '') + ') VALUES (?'+(column ? ',?' : '')+')').run('Acervo sintético', ...(column ? [item.id] : [])).lastInsertRowid);
    if (kind === 'topics') db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(material, item.id);
    assert.equal((await detail(kind, item.id)).material_count, 1);
    assert.equal((await request('/' + kind + '/' + item.id, 'DELETE', { expectedVersion: item.version })).body.code, 'category_in_use');
    assert.ok(db.prepare('SELECT id FROM materials WHERE id=?').get(material)); if (column) assert.equal(db.prepare('SELECT '+column+' FROM materials WHERE id=?').pluck().get(material), item.id);
    else assert.equal(db.prepare('SELECT COUNT(*) FROM material_topics WHERE material_id=?').pluck().get(material), 1);
  }
});
test('preferências docentes, BNCC e questões sobrevivem à tentativa de excluir ano sem materiais', async () => {
  const item = await create('grades'), before = item.version;
  db.prepare('INSERT INTO teacher_grade_preference_profiles(teacher_id) VALUES (?)').run(teacher);
  db.prepare('INSERT INTO teacher_grade_preferences(teacher_id,grade_id) VALUES (?,?)').run(teacher, item.id);
  const unit = Number(db.prepare('INSERT INTO bncc_units(name) VALUES (?)').run('Unidade QA36').lastInsertRowid);
  const skill = Number(db.prepare('INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES (?,?,?,?)').run('QA36', 'Habilidade sintética', item.id, unit).lastInsertRowid);
  const question = Number(db.prepare('INSERT INTO questions(question_code,skill_id,statement) VALUES (?,?,?)').run('QA36', skill, 'Questão sintética').lastInsertRowid);
  const info = await detail('grades', item.id); assert.equal(info.material_count, 0); assert.equal(info.other_usage_count, 2); assert.doesNotMatch(JSON.stringify(info), /Pessoa sintética|example.invalid|teacher_id/);
  assert.equal((await request('/grades/' + item.id, 'DELETE', { expectedVersion: before })).status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) FROM teacher_grade_preferences WHERE grade_id=?').pluck().get(item.id), 1); assert.ok(db.prepare('SELECT id FROM bncc_skills WHERE id=?').get(skill)); assert.ok(db.prepare('SELECT id FROM questions WHERE id=?').get(question));
});
test('novas referências SET NULL e CASCADE são descobertas após alteração de schema', async () => {
  const item = await create('disciplines'); await detail('disciplines', item.id);
  db.exec('CREATE TABLE qa36_future_link(id INTEGER PRIMARY KEY,discipline_id INTEGER REFERENCES disciplines(id) ON DELETE SET NULL)');
  db.prepare('INSERT INTO qa36_future_link VALUES (1,?)').run(item.id);
  assert.equal((await detail('disciplines', item.id)).other_usage_count, 1);
  assert.equal((await request('/disciplines/' + item.id, 'DELETE')).body.code, 'category_in_use'); assert.equal(db.prepare('SELECT discipline_id FROM qa36_future_link').pluck().get(), item.id);
});
test('valida nomes, ordem, ícone, IDs e versão sem gravar parcialmente', async () => {
  for (const body of [{ name: 42 }, { name: ['A'] }, { name: '' }, { name: ' ' }, { name: 'x'.repeat(201) }]) assert.equal((await request('/topics', 'POST', body)).status, 400);
  for (const order of [-1, 2.5, '2', 10000]) assert.equal((await request('/grades', 'POST', { name: randomUUID(), sort_order: order })).status, 400);
  assert.equal((await request('/material-types', 'POST', { name: randomUUID(), icon: 'no-such-icon' })).status, 400);
  const item = await create('material-types'); db.prepare("UPDATE material_types SET icon='legacy-icon' WHERE id=?").run(item.id);
  assert.equal((await request('/material-types/' + item.id, 'PUT', { name: item.name })).body.icon, 'legacy-icon');
  assert.equal((await request('/material-types/' + item.id, 'PUT', { name: item.name, icon: 'file' })).body.icon, 'file');
  assert.equal((await request('/material-types/' + item.id, 'DELETE', { expectedVersion: 'invalid' })).status, 400);
  assert.equal((await request('/topics/search?q[]=invalid')).status, 400);
});
test('referência futura fora da chave ID bloqueia a operação em vez de apresentar zero vínculos', async () => {
  const item = await create('topics');
  db.exec('CREATE TABLE qa36_name_reference(name TEXT REFERENCES topics(name) ON DELETE CASCADE)');
  db.prepare('INSERT INTO qa36_name_reference VALUES (?)').run(item.name);
  try {
    assert.equal((await request('/topics/' + item.id, 'DELETE')).status, 500);
    assert.equal(db.prepare('SELECT name FROM qa36_name_reference').pluck().get(), item.name);
    assert.ok(db.prepare('SELECT id FROM topics WHERE id=?').get(item.id));
  } finally { db.exec('DROP TABLE qa36_name_reference'); }
});
test('falha de auditoria desfaz criar, editar e excluir', async () => {
  const item = await create('topics'), before = await detail('topics', item.id);
  db.exec("CREATE TRIGGER qa36_reject_audit BEFORE INSERT ON activity_log WHEN NEW.entity_type='category_topics' BEGIN SELECT RAISE(ABORT,'audit failure QA36'); END");
  try {
    for (const [route, method, body] of [['/topics','POST',{name:'Não criar QA36'}], ['/topics/'+item.id,'PUT',{name:'Não editar QA36',expectedVersion:before.version}], ['/topics/'+item.id,'DELETE',{expectedVersion:before.version}]]) assert.equal((await request(route,method,body)).status,500);
    assert.deepEqual(await detail('topics', item.id), before); assert.equal(db.prepare("SELECT COUNT(*) FROM topics WHERE name='Não criar QA36'").pluck().get(),0);
  } finally { db.exec('DROP TRIGGER qa36_reject_audit'); }
});
