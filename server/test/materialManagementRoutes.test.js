const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-material-form-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-material-management-35';
const express = require('express'), Database = require('better-sqlite3'), db = require('../src/database'), { issueUserToken } = require('../src/services/authSessions');
const app = express(); app.use(express.json()); app.use('/api/materials', require('../src/routes/materials')); app.use(require('../src/middleware/apiErrors'));
let server, base, admin, other, teacher, auth, otherAuth, teacherAuth, discipline, grade, type, topic, own, publicLab, privateLab;
const account = (name, role) => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run(name, `${randomUUID()}@example.invalid`, 'hash', role).lastInsertRowid);
const material = id => db.prepare('SELECT * FROM materials WHERE id=?').get(id);
const files = () => fs.readdirSync(process.env.UPLOAD_DIR).sort();
test.before(async () => {
  admin = account('Admin A', 'admin'); other = account('Admin B', 'admin'); teacher = account('Docente', 'professor'); auth = issueUserToken(admin); otherAuth = issueUserToken(other); teacherAuth = issueUserToken(teacher);
  discipline = Number(db.prepare("INSERT INTO disciplines(name) VALUES ('Ciências QA35')").run().lastInsertRowid);
  grade = Number(db.prepare("INSERT INTO grades(name) VALUES ('7º Ano QA35')").run().lastInsertRowid);
  type = Number(db.prepare("INSERT INTO material_types(name) VALUES ('Atividade QA35')").run().lastInsertRowid);
  topic = Number(db.prepare("INSERT INTO topics(name) VALUES ('Investigar QA35')").run().lastInsertRowid);
  const lab = (owner, name, pub) => Number(db.prepare('INSERT INTO collections(user_id,name,is_public) VALUES (?,?,?)').run(owner, name, pub).lastInsertRowid);
  own = lab(admin, 'Meu laboratório', 0); publicLab = lab(other, 'Laboratório público', 1); privateLab = lab(other, 'Nome privado não deve sair', 0);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api/materials`; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-material-form-/); fs.rmSync(temp, { recursive: true, force: true }); });
function draft(extra = {}) { return { title: 'Material QA35', description: '', discipline_id: discipline, grade_id: grade, material_type_id: type, external_url: '', duration: '', page_count: null, topicIds: [topic], addCollectionIds: [], replaceFile: false, expectedVersion: null, ...extra }; }
async function read(url, token = auth) { const res = await fetch(base + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') }; }
async function save(p = draft(), { id, key = randomUUID(), token = auth, file, name = 'qa35.txt' } = {}) {
  const data = new FormData(); data.append('payload', JSON.stringify(p)); if (file !== undefined) data.append('file', new Blob([file], { type: 'text/plain' }), name);
  const res = await fetch(base + '/management' + (id ? '/' + id : ''), { method: id ? 'PUT' : 'POST', headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Idempotency-Key': key }, body: data });
  return { status: res.status, body: await res.json(), key };
}
async function editDraft(id, extra = {}) { const s = (await read('/management/' + id)).body, m = s.material; return draft({ title: m.title, description: m.description || '', discipline_id: m.discipline_id, grade_id: m.grade_id, material_type_id: m.material_type_id, external_url: m.external_url || '', duration: m.duration || '', page_count: m.page_count, topicIds: s.topics.map(t => t.id), expectedVersion: s.version, ...extra }); }
test('admin obrigatório; leitura completa privada não registra acesso nem expõe laboratório privado', async () => {
  const created = await save(); assert.equal(created.status, 201); const id = created.body.materialId;
  db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(privateLab, id);
  const before = db.prepare('SELECT COUNT(*) FROM access_history').pluck().get();
  assert.equal((await read('/management/' + id, null)).status, 401); assert.equal((await read('/management/' + id, teacherAuth)).status, 403);
  const result = await read('/management/' + id); assert.equal(result.status, 200); assert.match(result.cache, /no-store/); assert.equal(result.body.otherCollectionCount, 1); assert.equal(result.body.collections.length, 0); assert.equal(result.body.topics[0].id, topic); assert.equal(result.body.material.discipline_id, discipline); assert.doesNotMatch(JSON.stringify(result.body), /Nome privado/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM access_history').pluck().get(), before); assert.equal((await save(draft(), { token: teacherAuth })).status, 403);
});
test('pedido repetido cria um material e uma auditoria; recibo é restrito à conta', async () => {
  const key = randomUUID(), p = draft({ title: 'Idempotente QA35' }); const results = await Promise.all([save(p, { key }), save(p, { key })]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 201]); assert.equal(results[0].body.materialId, results[1].body.materialId);
  assert.equal(db.prepare("SELECT COUNT(*) FROM materials WHERE title='Idempotente QA35'").pluck().get(), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='create_material' AND entity_id=?").pluck().get(String(results[0].body.materialId)), 1);
  assert.equal((await read('/management/operations/' + key)).body.materialId, results[0].body.materialId); assert.equal((await read('/management/operations/' + key, otherAuth)).status, 404); assert.equal((await read('/management/operations/' + key, teacherAuth)).status, 403);
  assert.equal((await save({ ...p, title: 'Outro conteúdo' }, { key })).body.code, 'operation_conflict');
});
test('edição mantém disciplina e todos os laboratórios; adiciona sem substituir', async () => {
  const created = await save(draft({ addCollectionIds: [own, publicLab] })); const id = created.body.materialId; db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(privateLab, id);
  const p = await editDraft(id, { title: 'Título revisado QA35', addCollectionIds: [own] }); const result = await save(p, { id }); assert.equal(result.status, 200); assert.equal(material(id).discipline_id, discipline);
  assert.deepEqual(db.prepare('SELECT collection_id FROM collection_items WHERE material_id=? ORDER BY collection_id').pluck().all(id), [own, publicLab, privateLab].sort((a, b) => a - b));
  assert.equal((await save(await editDraft(id, { addCollectionIds: [privateLab] }), { id })).status, 403);
});
test('campos opcionais podem ser limpos; zero páginas não vira valor ausente', async () => {
  const id = (await save(draft({ external_url: 'https://example.invalid/recurso', duration: '12 minutos', page_count: 20 }))).body.materialId;
  const p = await editDraft(id, { discipline_id: null, grade_id: null, material_type_id: null, external_url: '', duration: '', page_count: 0, topicIds: [] });
  assert.equal((await save(p, { id })).status, 200); const m = material(id); assert.equal(m.discipline_id, null); assert.equal(m.grade_id, null); assert.equal(m.material_type_id, null); assert.equal(m.external_url, null); assert.equal(m.duration, null); assert.equal(m.page_count, 0); assert.equal(db.prepare('SELECT COUNT(*) FROM material_topics WHERE material_id=?').pluck().get(id), 0);
});
test('conflito impede sobrescrita e descarta somente o upload novo', async () => {
  const id = (await save()).body.materialId, p = await editDraft(id), before = files(); db.prepare("UPDATE materials SET title='Alterado por outra pessoa' WHERE id=?").run(id);
  const result = await save(p, { id, file: 'Texto sintético de tentativa conflitante.' }); assert.equal(result.status, 409); assert.equal(result.body.code, 'material_conflict'); assert.equal(material(id).title, 'Alterado por outra pessoa'); assert.deepEqual(files(), before);
});
test('substituição exige consentimento, preserva arquivo anterior e limpa repetição de upload', async () => {
  const created = await save(draft(), { file: 'Arquivo original sintético.' }); assert.equal(created.status, 201); const id = created.body.materialId, previousPath = material(id).file_path;
  const p = await editDraft(id), before = files(); assert.equal((await save(p, { id, file: 'Arquivo novo sintético.' })).body.code, 'replacement_required'); assert.deepEqual(files(), before);
  const key = randomUUID(), payload = { ...p, replaceFile: true };
  assert.equal((await save(payload, { id, key, file: 'Arquivo novo sintético.' })).status, 200); const newPath = material(id).file_path; assert.notEqual(newPath, previousPath);
  assert.equal(fs.readFileSync(path.join(process.env.UPLOAD_DIR, previousPath), 'utf8'), 'Arquivo original sintético.'); assert.ok(db.prepare('SELECT id FROM material_file_retirements WHERE file_path=?').get(previousPath));
  const after = files(); assert.equal((await save(payload, { id, key, file: 'Arquivo novo sintético.' })).status, 200); assert.deepEqual(files(), after);
  assert.equal((await save(payload, { id, key, file: 'Conteúdo diferente.' })).status, 409); assert.deepEqual(files(), after); assert.equal(material(id).file_path, newPath);
});
test('falha da auditoria reverte edição, vínculos, recibo e novo arquivo', async () => {
  const id = (await save(draft(), { file: 'Arquivo estável.' })).body.materialId, before = material(id), paths = files(), p = await editDraft(id, { title: 'Não gravar', addCollectionIds: [own], replaceFile: true }); const key = randomUUID();
  db.exec("CREATE TRIGGER qa35_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='update_material' BEGIN SELECT RAISE(ABORT,'audit QA35'); END;");
  try { assert.equal((await save(p, { id, key, file: 'Novo arquivo recusado.' })).status, 500); assert.deepEqual(material(id), before); assert.deepEqual(files(), paths); assert.equal((await read('/management/operations/' + key)).status, 404); assert.equal(db.prepare('SELECT COUNT(*) FROM collection_items WHERE material_id=?').pluck().get(id), 0); }
  finally { db.exec('DROP TRIGGER qa35_audit_failure'); }
});
test('campos, referências, link e chaves inválidos não criam materiais', async () => {
  const before = db.prepare('SELECT COUNT(*) FROM materials').pluck().get();
  for (const patch of [{ title: '' }, { title: 'x'.repeat(201) }, { description: 'x'.repeat(5001) }, { discipline_id: 999999 }, { external_url: 'javascript:alert(1)' }, { external_url: 'https://' + 'user:password@example.invalid' }, { page_count: -1 }, { page_count: 2.5 }, { topicIds: [topic, topic] }, { topicIds: [999999] }, { addCollectionIds: [privateLab] }, { collection_id: own }, { expectedVersion: 'a'.repeat(64) }]) assert.ok([400, 403].includes((await save(draft(patch))).status));
  assert.equal((await save(draft(), { key: 'short' })).status, 400); assert.equal((await save(draft(), { file: 'exe', name: 'unsafe.exe' })).status, 400); assert.equal(db.prepare('SELECT COUNT(*) FROM materials').pluck().get(), before);
});
test('recibo sobrevive à exclusão e não recria o material ao repetir o cadastro', async () => {
  const p = draft({ title: 'Não recriar QA35' }), first = await save(p); const id = first.body.materialId;
  const res = await fetch(base + '/' + id, { method: 'DELETE', headers: { Authorization: `Bearer ${auth}` } }); assert.equal(res.status, 200);
  const repeated = await save(p, { key: first.key }); assert.equal(repeated.status, 200); assert.equal(repeated.body.materialId, id); assert.equal(material(id), undefined);
});
test('perda de papel ou revogação durante o hash recusa a gravação e limpa somente o upload novo', async () => {
  const nativeStream = fs.createReadStream;
  for (const revoke of [false, true]) {
    const actor = account('Admin transitório QA35', 'admin'), token = issueUserToken(actor), key = randomUUID();
    const before = files(), count = db.prepare('SELECT COUNT(*) FROM materials').pluck().get(); let intercepted = false;
    fs.createReadStream = (...args) => {
      const stream = nativeStream(...args), iterate = stream[Symbol.asyncIterator].bind(stream);
      stream[Symbol.asyncIterator] = async function* () {
        for await (const chunk of { [Symbol.asyncIterator]: iterate }) yield chunk;
        intercepted = true;
        db.prepare(revoke ? 'UPDATE users SET auth_version=auth_version+1 WHERE id=?' : "UPDATE users SET role='professor' WHERE id=?").run(actor);
      };
      return stream;
    };
    try {
      const result = await save(draft(), { token, key, file: 'Upload sintético com acesso alterado durante o hash.' });
      assert.equal(intercepted, true); assert.equal(result.status, 401);
      assert.equal(result.body.code, 'session_expired');
      assert.deepEqual(files(), before); assert.equal(db.prepare('SELECT COUNT(*) FROM materials').pluck().get(), count);
      assert.equal(db.prepare('SELECT COUNT(*) FROM material_management_operations WHERE actor_user_id=?').pluck().get(actor), 0);
    } finally { fs.createReadStream = nativeStream; }
  }
});

test('migração 27 é aditiva e aplicada uma vez; backup preserva recibos e acervo', async () => {
  const { runMigrations } = require('../src/migrations'), migration = require('../src/migrations/027_material_management_operations');
  const isolated = new Database(':memory:'); isolated.exec("CREATE TABLE users(id INTEGER PRIMARY KEY); CREATE TABLE materials(id INTEGER PRIMARY KEY,title TEXT); INSERT INTO users VALUES (1); INSERT INTO materials VALUES (7,'Preservar');");
  const before = isolated.prepare('SELECT * FROM materials').all(); assert.equal(runMigrations(isolated, { migrations: [migration], logger: { info() {} } }).appliedNow.length, 1); assert.equal(runMigrations(isolated, { migrations: [migration], logger: { info() {} } }).appliedNow.length, 0); assert.deepEqual(isolated.prepare('SELECT * FROM materials').all(), before); isolated.close();
  const backupPath = path.join(temp, 'qa35-backup.sqlite'); await db.backup(backupPath); const restored = new Database(backupPath, { readonly: true });
  for (const table of ['materials', 'material_management_operations', 'collection_items', 'material_topics', 'activity_log', 'material_file_retirements']) assert.equal(restored.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get());
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); restored.close();
});
