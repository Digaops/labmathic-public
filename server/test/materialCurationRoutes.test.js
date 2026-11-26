const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-material-curation-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-curation-tests-only';
const db = require('../src/database'), express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const { materialSnapshot, searchSkills, reviewMaterial } = require('../src/services/materialCuration');
const { eligibleMaterialSkill } = require('../src/services/materialSkillEligibility');
const app = express(); app.use(express.json()); app.use('/api/materials', require('../src/routes/materials')); app.use('/api/lesson-planner', require('../src/routes/lessonPlanner')); app.use(require('../src/middleware/apiErrors'));
let server, base, admin, other, teacher, auth, otherAuth, teacherAuth, materialId, skillId;
const count = table => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
const flags = value => db.prepare("UPDATE feature_flags SET master_enabled=?,default_enabled=?,rollout_percentage=? WHERE flag_key='materials.bncc_curation'").run(value, value, value ? 100 : 0);
async function request(url, { token = auth, method = 'GET', body, key = randomUUID() } = {}) {
  const res = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json', 'Idempotency-Key': key, ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), cache: res.headers.get('Cache-Control') };
}
function payload(extras = {}) {
  const skill = searchSkills(db, { q: 'QA-BNCC-00' }).skills[0];
  return { expectedVersion: materialSnapshot(db, materialId).version, skillId, skillVersion: skill.version, decision: 'confirm', reason: 'A atividade sintética trabalha a habilidade de forma explícita.', location: 'Atividade 2', confirmed: true, ...extras };
}
const write = (body = payload(), options = {}) => request(`/api/materials/curation/materials/${materialId}/reviews`, { method: 'POST', body, ...options });
test.before(async () => {
  const account = role => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run('QA ' + role, randomUUID() + '@example.invalid', 'hash', role).lastInsertRowid);
  admin = account('admin'); other = account('admin'); teacher = account('professor'); auth = issueUserToken(admin); otherAuth = issueUserToken(other); teacherAuth = issueUserToken(teacher);
  const grade = Number(db.prepare("INSERT INTO grades(name) VALUES ('Ano sintético curação')").run().lastInsertRowid);
  const unit = Number(db.prepare("INSERT INTO bncc_units(name) VALUES ('Unidade sintética curação')").run().lastInsertRowid);
  for (let n = 0; n < 25; n++) db.prepare('INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES (?,?,?,?)').run('QA-BNCC-' + String(n).padStart(2, '0'), 'Habilidade sintética ' + n, grade, unit);
  skillId = db.prepare("SELECT id FROM bncc_skills WHERE code='QA-BNCC-00'").pluck().get();
  materialId = Number(db.prepare("INSERT INTO materials(title,external_url,created_by) VALUES ('Material sintético','https://example.invalid/recurso',?)").run(admin).lastInsertRowid);
  db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (?,?,?)').run(materialId, skillId, admin);
  await new Promise(r => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; r(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-material-curation-/); fs.rmSync(temp, { recursive: true, force: true }); });
test('leitura identifica legado sem inventar revisão; administração, sessão e flag obrigatórias', async () => {
  assert.equal(materialSnapshot(db, materialId).associations[0].status, 'legacy'); assert.equal(count('material_bncc_reviews'), 0);
  assert.equal((await write()).body.code, 'feature_disabled'); assert.equal((await write(payload(), { token: null })).status, 401); assert.equal((await write(payload(), { token: teacherAuth })).status, 403);
  const publicRead = await request(`/api/materials/curation/materials/${materialId}/skills`, { token: teacherAuth }); assert.equal(publicRead.status, 200); assert.match(publicRead.cache, /no-store/); assert.equal(publicRead.body.associations[0].reviewer, undefined);
  for (const suffix of ['', '/history']) assert.equal((await request(`/api/materials/curation/materials/${materialId}${suffix}`, { token: teacherAuth })).status, 403);
  flags(1);
});
test('busca literal e paginada não inventa cobertura nem disciplina', async () => {
  const first = await request('/api/materials/curation/skills?q=QA-BNCC'), second = await request('/api/materials/curation/skills?q=QA-BNCC&page=2');
  assert.equal(first.body.skills.length, 20); assert.equal(second.body.skills.length, 5); assert.equal(first.body.skills[0].coverage, 1); assert.equal(first.body.skills[0].pending, 0); assert.equal(first.body.skills[0].discipline, undefined);
  assert.equal((await request('/api/materials/curation/skills?q=%25_')).body.total, 0);
  for (const url of ['?q=x', '?q=valid&page=0', '?q=valid&page=1.5']) assert.equal((await request('/api/materials/curation/skills' + url)).status, 400);
});
test('revisão exige confirmação, justificativa, localização e versões válidas', async () => {
  for (const extra of [{ confirmed: false }, { reason: 'curto' }, { location: '' }, { ignored: true }, { expectedVersion: 'invalid' }, { skillId: 1.5 }]) assert.equal((await write(payload(extra))).status, 400);
  assert.equal((await write(payload({ skillId: 999999 }))).status, 409);
  db.prepare('UPDATE materials SET external_url=NULL WHERE id=?').run(materialId); assert.equal((await write()).body.code, 'content_missing');
  db.prepare("UPDATE materials SET external_url='https://example.invalid/recurso' WHERE id=?").run(materialId);
});
test('confirmação concorrente é atômica e idempotente e preserva metadados do vínculo legado', async () => {
  const previous = db.prepare('SELECT * FROM material_bncc_skills WHERE material_id=?').get(materialId), body = payload(), key = randomUUID();
  const before = count('material_bncc_reviews'), values = await Promise.all([write(body, { key }), write(body, { key })]);
  assert.ok(values.every(v => v.status === 200), JSON.stringify(values)); assert.deepEqual(values[0].body, values[1].body); assert.equal(count('material_bncc_reviews'), before + 1);
  assert.deepEqual(db.prepare('SELECT * FROM material_bncc_skills WHERE material_id=?').get(materialId), previous);
  assert.equal(materialSnapshot(db, materialId).associations[0].status, 'confirmed'); assert.equal((await write(body, { token: otherAuth })).body.code, 'review_conflict');
  assert.equal((await write({ ...body, reason: 'Outro texto de justificativa de teste.' }, { key })).body.code, 'operation_conflict');
  assert.deepEqual((await request('/api/materials/curation/operations/' + key)).body, values[0].body); assert.equal((await request('/api/materials/curation/operations/' + key, { token: otherAuth })).body.code, 'operation_unconfirmed');
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='review_material_skill'").pluck().get(), 1);
  flags(0); assert.deepEqual((await write(body, { key })).body, values[0].body); flags(1);
});
test('mudança de conteúdo ou habilidade invalida somente revisões gerenciadas; flag não contorna segurança', async () => {
  const eligible = () => db.prepare(`SELECT COUNT(*) FROM material_bncc_skills mapping WHERE material_id=? AND ${eligibleMaterialSkill()}`).pluck().get(materialId);
  assert.equal(eligible(), 1);
  db.prepare('UPDATE materials SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(materialId); assert.equal(eligible(), 1);
  db.prepare("UPDATE materials SET description='Novo conteúdo' WHERE id=?").run(materialId); assert.equal(eligible(), 0); assert.equal(materialSnapshot(db, materialId).associations[0].status, 'needs_review');
  flags(0); assert.equal(eligible(), 0); flags(1); assert.equal((await write()).status, 200); assert.equal(eligible(), 1);
  const previous = payload(); db.prepare("UPDATE bncc_skills SET description='Nova habilidade sintética' WHERE id=?").run(skillId); assert.equal(eligible(), 0); assert.equal((await write(previous)).body.code, 'review_conflict');
  assert.equal((await write()).status, 200); assert.equal(eligible(), 1);
  db.prepare("UPDATE feature_flags SET master_enabled=1,default_enabled=1 WHERE flag_key='planning.lesson_planner'").run();
  db.prepare(`INSERT OR REPLACE INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by)
    SELECT id,?,1,'Teste sintético',?,? FROM feature_flags WHERE flag_key='planning.lesson_planner'`).run(teacher, admin, admin);
  const catalog = () => request('/api/lesson-planner/catalog/resources?skillIds=' + skillId, { token: teacherAuth });
  const available = await catalog(); assert.equal(available.status, 200, JSON.stringify(available.body)); assert.equal(available.body.materials.find(m => m.id === materialId).skillMatch, 1);
  db.prepare("UPDATE materials SET title='Título alterado para conferência' WHERE id=?").run(materialId);
  assert.equal((await catalog()).body.materials.find(m => m.id === materialId).skillMatch, 0);
});
test('falha de auditoria reverte vínculo, estado, revisão e recibo', async () => {
  const before = ['material_bncc_skills', 'material_bncc_review_state', 'material_bncc_reviews', 'material_bncc_operations'].map(t => db.prepare(`SELECT * FROM ${t}`).all());
  assert.throws(() => reviewMaterial(db, { actor: { id: admin, role: 'admin' }, materialId, key: randomUUID(), body: payload(), audit() { throw Error('auditoria indisponível'); } }), /auditoria indisponível/);
  assert.deepEqual(['material_bncc_skills', 'material_bncc_review_state', 'material_bncc_reviews', 'material_bncc_operations'].map(t => db.prepare(`SELECT * FROM ${t}`).all()), before);
});
test('retirada é explícita, auditada, imutável e não remove material nem evidências históricas', async () => {
  const before = count('materials'); assert.equal((await write(payload({ decision: 'remove', reason: 'A atividade não corresponde mais a esta habilidade.', location: '' }))).status, 200);
  assert.equal(materialSnapshot(db, materialId).associations.length, 0); assert.equal(count('materials'), before);
  const history = await request(`/api/materials/curation/materials/${materialId}/history`); assert.equal(history.body.events[0].decision, 'remove'); assert.equal(history.body.events[0].skill.id, skillId);
  assert.throws(() => db.exec('UPDATE material_bncc_reviews SET reason=reason'), /immutable/); assert.throws(() => db.exec('DELETE FROM material_bncc_reviews'), /immutable/);
  assert.equal((await write()).status, 200); assert.equal(materialSnapshot(db, materialId).associations[0].status, 'confirmed');
  const historyCount = count('material_bncc_reviews'); db.prepare('DELETE FROM materials WHERE id=?').run(materialId); assert.equal(count('material_bncc_reviews'), historyCount); assert.equal(count('material_bncc_review_state'), 0); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(db.pragma('foreign_key_check'), []);
});

test('histórico é paginado sem repetição e permanece consultável após exclusão do material', async () => {
  // Previous history is deliberately retained after catalog deletion; new events use a new material.
  materialId = Number(db.prepare("INSERT INTO materials(title,external_url,created_by) VALUES ('Histórico paginado QA','https://example.invalid/recurso',?)").run(admin).lastInsertRowid);
  for (let n = 0; n < 23; n++) assert.equal((await write(payload({ reason: 'Conferência sintética para testar paginação ' + n }))).status, 200);
  const first = (await request(`/api/materials/curation/materials/${materialId}/history`)).body;
  const second = (await request(`/api/materials/curation/materials/${materialId}/history?before=${first.nextBefore}`)).body;
  assert.equal(first.events.length, 20); assert.equal(second.events.length, 3); assert.equal(second.nextBefore, null); assert.equal(new Set([...first.events, ...second.events].map(e => e.id)).size, 23);
  db.prepare('DELETE FROM materials WHERE id=?').run(materialId);
  assert.deepEqual((await request(`/api/materials/curation/materials/${materialId}/history`)).body, first);
});
test('sessão revogada e papel removido não conseguem registrar revisão', async () => {
  const before = count('material_bncc_reviews');
  db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(other);
  const body = { skillId, skillVersion: 'a'.repeat(64), expectedVersion: 'b'.repeat(64), decision: 'confirm', reason: 'Tentativa sintética de revisão não permitida.', location: 'Atividade 1', confirmed: true };
  assert.equal((await write(body, { token: otherAuth })).status, 401);
  const changed = issueUserToken(other); db.prepare("UPDATE users SET role='professor' WHERE id=?").run(other);
  assert.equal((await write(body, { token: changed })).status, 401);
  assert.equal((await write(body, { token: issueUserToken(other) })).status, 403);
  assert.equal(count('material_bncc_reviews'), before);
});
