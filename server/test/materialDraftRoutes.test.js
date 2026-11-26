const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-material-drafts-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-draft-publication-only';
const db = require('../src/database'), express = require('express'), Database = require('better-sqlite3');
const { issueUserToken } = require('../src/services/authSessions');
const app = express(); app.use(express.json());
app.use('/api/materials', require('../src/routes/materials')); app.use('/api/collections', require('../src/routes/collections')); app.use('/api/share', require('../src/routes/share')); app.use('/uploads', require('../src/middleware/protectedUploads')); app.use(require('../src/middleware/apiErrors'));
let server, base, admin, other, teacher, auth, otherAuth, teacherAuth, lab, type;
const count = table => db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
const row = id => db.prepare('SELECT * FROM material_drafts WHERE id=?').get(id);
const flag = enabled => db.prepare("UPDATE feature_flags SET master_enabled=?, default_enabled=?,rollout_percentage=? WHERE flag_key='materials.draft_publication'").run(enabled ? 1 : 0, enabled ? 1 : 0, enabled ? 100 : 0);
function payload(extra = {}) { return { title: 'Rascunho QA', description: '', discipline_id: null, grade_id: null, material_type_id: null, external_url: '', duration: '', page_count: null, topicIds: [], addCollectionIds: [], replaceFile: false, expectedVersion: null, ...extra }; }
async function read(url, token = auth) { const r = await fetch(base + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); const text = await r.text(); let body; try { body = JSON.parse(text); } catch { body = text; } return { status: r.status, body, cache: r.headers.get('cache-control') }; }
async function save(p = payload(), { id, publish = false, key = randomUUID(), token = auth, file } = {}) {
  const data = new FormData(); data.append('payload', JSON.stringify(p)); if (file !== undefined) data.append('file', new Blob([file], { type: 'text/plain' }), 'sintetico.txt');
  const r = await fetch(base + '/api/materials/management/drafts' + (id ? '/' + id : '') + (publish ? '/publish' : ''), { method: id && !publish ? 'PUT' : 'POST', body: data, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Idempotency-Key': key } });
  return { status: r.status, body: await r.json(), key };
}
async function snapshot(id) { return (await read('/api/materials/management/drafts/' + id)).body; }
async function publish(id, options = {}) { return save({ expectedVersion: (await snapshot(id)).version }, { id, publish: true, ...options }); }
test.before(async () => {
  const account = role => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run(role, randomUUID() + '@example.invalid', 'hash', role).lastInsertRowid);
  admin = account('admin'); other = account('admin'); teacher = account('professor'); auth = issueUserToken(admin); otherAuth = issueUserToken(other); teacherAuth = issueUserToken(teacher);
  lab = Number(db.prepare("INSERT INTO collections(name,user_id,is_public) VALUES ('Laboratório QA',?,1)").run(admin).lastInsertRowid);
  type = Number(db.prepare("INSERT INTO material_types(name) VALUES ('Categoria QA rascunho')").run().lastInsertRowid);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(r => server.close(r)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-material-drafts-/); fs.rmSync(temp, { recursive: true, force: true }); });

test('flag nasce desligada; admin e liberação são obrigatórios para gravar', async () => {
  assert.equal((await save()).body.code, 'feature_disabled'); assert.equal((await save(payload(), { token: teacherAuth })).status, 403); assert.equal((await save(payload(), { token: null })).status, 401); flag(true);
  assert.equal((await read('/api/materials/management/drafts/operations/' + randomUUID())).body.code, 'operation_unconfirmed');
});
test('rascunho vazio de conteúdo é privado, sem alterar acervo, laboratórios ou avisos', async () => {
  const before = ['materials', 'collection_items', 'notifications'].map(count);
  const created = await save(payload({ title: 'Privado somente QA', addCollectionIds: [lab] })); assert.equal(created.status, 201); const id = created.body.draftId;
  assert.equal(created.body.materialId, null); assert.deepEqual(['materials', 'collection_items', 'notifications'].map(count), before);
  assert.equal((await read('/api/materials/management/drafts/' + id, teacherAuth)).status, 403); assert.equal((await read('/api/materials/management/drafts/' + id, otherAuth)).status, 404);
  const list = await read('/api/materials/management/drafts'); assert.match(list.cache, /no-store/); assert.ok(list.body.drafts.some(d => d.id === id)); assert.equal((await read('/api/materials/management/drafts', otherAuth)).body.total, 0);
  assert.equal((await publish(id)).body.code, 'content_missing'); assert.equal(row(id).published_material_id, null);
  for (const url of ['/api/materials?search=Privado', '/api/materials/recent', '/api/materials/history', '/api/collections/' + lab]) {
    const response = await read(url, teacherAuth); assert.equal(response.status, 200); assert.doesNotMatch(JSON.stringify(response.body), /Privado somente QA/);
  }
  // No catalog ID is allocated, so no share can ever refer to this draft row.
  assert.equal(db.prepare('SELECT id FROM materials WHERE title=?').get('Privado somente QA'), undefined);
});
test('arquivo só pode ser lido pelo dono administrador, inclusive com flag desligada', async () => {
  const created = await save(payload({ title: 'Arquivo privado QA' }), { file: 'Conteúdo sintético privado.' }); const id = created.body.draftId, url = '/uploads/' + row(id).file_path;
  for (const token of [null, teacherAuth, otherAuth]) assert.equal((await read(url, token)).status, 404);
  assert.equal((await read(url)).status, 200); flag(false);
  assert.equal((await read(url, teacherAuth)).status, 404); assert.equal((await read('/api/materials/management/drafts/' + id)).status, 200); assert.equal((await publish(id)).body.code, 'feature_disabled'); flag(true);
});
test('publicação é atômica, auditada e idempotente; somente então professor vê o conteúdo', async () => {
  const title = 'Ciclo público QA', created = await save(payload({ title, addCollectionIds: [lab], material_type_id: type }), { file: 'Pronto para ler.' }); const id = created.body.draftId, file = row(id).file_path, version = (await snapshot(id)).version;
  const before = count('materials'), notices = count('notifications'), key = randomUUID();
  const results = await Promise.all([save({ expectedVersion: version }, { id, publish: true, key }), save({ expectedVersion: version }, { id, publish: true, key })]);
  assert.ok(results.every(r => r.status === 200)); assert.deepEqual(results[0].body, results[1].body); assert.equal(count('materials'), before + 1); assert.equal(count('notifications'), notices + count('users') - 1);
  const materialId = results[0].body.materialId; assert.ok(db.prepare('SELECT 1 FROM collection_items WHERE collection_id=? AND material_id=?').get(lab, materialId));
  assert.equal((await read('/api/materials/' + materialId, teacherAuth)).body.title, title); assert.equal((await read('/uploads/' + file, teacherAuth)).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='publish_material_draft' AND entity_id=?").pluck().get(String(id)), 1);
  assert.equal((await publish(id)).body.code, 'material_conflict'); assert.equal((await read('/api/materials/management/drafts/operations/' + key, otherAuth)).status, 404);
  flag(false); assert.deepEqual((await save({ expectedVersion: version }, { id, publish: true, key })).body, results[0].body); flag(true);
  db.prepare('DELETE FROM materials WHERE id=?').run(materialId);
  assert.deepEqual((await save({ expectedVersion: version }, { id, publish: true, key })).body, results[0].body); assert.equal(count('materials'), before);
});
test('salvar repetido não duplica rascunho/arquivo e edição concorrente não sobrescreve', async () => {
  const key = randomUUID(), p = payload({ title: 'Idempotente privado QA' }), first = await save(p, { key, file: 'Original.' }); const id = first.body.draftId, original = row(id).file_path;
  const files = fs.readdirSync(process.env.UPLOAD_DIR).sort(); assert.deepEqual((await save(p, { key, file: 'Original.' })).body, first.body); assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), files);
  assert.equal((await save({ ...p, title: 'Outra coisa' }, { key })).body.code, 'operation_conflict');
  const version = (await snapshot(id)).version;
  assert.equal((await save({ ...p, expectedVersion: version }, { id, file: 'Novo.' })).body.code, 'replacement_required');
  assert.equal((await save({ ...p, expectedVersion: version, replaceFile: true }, { id, file: 'Novo.' })).status, 200);
  assert.equal(fs.readFileSync(path.join(process.env.UPLOAD_DIR, original), 'utf8'), 'Original.');
  assert.equal((await save({ expectedVersion: version }, { id, publish: true })).body.code, 'material_conflict');
  assert.equal((await save({ ...p, expectedVersion: version }, { id })).body.code, 'material_conflict');
  const current = row(id).file_path; require('../src/services/imageLifecycle').discardNewUpload(current); assert.ok(fs.existsSync(path.join(process.env.UPLOAD_DIR, current)));
});
test('arquivo desaparecido, referência removida e URL insegura não podem ser publicados', async () => {
  const id = (await save(payload(), { file: 'Arquivo temporário.' })).body.draftId;
  fs.renameSync(path.join(process.env.UPLOAD_DIR, row(id).file_path), path.join(temp, 'arquivo-preservado.txt'));
  assert.equal((await publish(id)).body.code, 'content_missing');
  for (const url of ['javascript:alert(1)', 'https://user:secret@example.invalid', 'sem-protocolo']) assert.equal((await save(payload({ external_url: url }))).status, 400);
  const ref = (await save(payload({ material_type_id: type, external_url: 'https://example.invalid/conteudo' }))).body.draftId;
  db.prepare('DELETE FROM material_types WHERE id=?').run(type); assert.equal((await publish(ref)).body.code, 'invalid_reference');
  const external = (await save(payload({ external_url: 'https://example.invalid/sem-consulta-de-rede' }))).body.draftId; assert.equal((await publish(external)).status, 200);
});
test('falha na auditoria reverte publicação, vínculos, avisos e recibo; rascunho continua salvo', async () => {
  const id = (await save(payload({ external_url: 'https://example.invalid/recurso', addCollectionIds: [lab] }))).body.draftId, previous = row(id), key = randomUUID();
  const before = ['materials', 'collection_items', 'notifications', 'material_draft_operations'].map(count);
  db.exec("CREATE TRIGGER qa_draft_audit BEFORE INSERT ON activity_log WHEN NEW.action='publish_material_draft' BEGIN SELECT RAISE(ABORT,'audit draft QA'); END;");
  try { assert.equal((await publish(id, { key })).status, 500); assert.deepEqual(row(id), previous); assert.deepEqual(['materials', 'collection_items', 'notifications', 'material_draft_operations'].map(count), before); assert.equal((await read('/api/materials/management/drafts/operations/' + key)).status, 404); }
  finally { db.exec('DROP TRIGGER qa_draft_audit'); }
  assert.equal((await publish(id, { key })).status, 200);
});
test('APIs antigas não contornam a preparação quando a flag está ativa; recibos anteriores permanecem', async () => {
  const p = payload();
  for (const url of ['/api/materials', '/api/materials/management']) {
    const body = new FormData(); body.append('payload', JSON.stringify(p)); body.append('title', 'Não criar diretamente');
    const r = await fetch(base + url, { method: 'POST', headers: { Authorization: `Bearer ${auth}`, 'Idempotency-Key': randomUUID() }, body }); assert.equal(r.status, 409); assert.equal((await r.json()).code, 'draft_required');
  }
});
test('listagem limitada, migração aditiva e backup restaurável preservam o acervo legado', async () => {
  assert.equal((await read('/api/materials/management/drafts?page=-1')).status, 400);
  for (let n = 0; n < 21; n++) db.prepare('INSERT INTO material_drafts(owner_id,payload_json) VALUES (?,?)').run(other, JSON.stringify(payload({ title: 'Página QA ' + n })));
  const first = (await read('/api/materials/management/drafts', otherAuth)).body, second = (await read('/api/materials/management/drafts?page=2', otherAuth)).body;
  assert.equal(first.drafts.length, 20); assert.equal(second.drafts.length, 1); assert.equal(first.totalPages, 2); assert.equal(new Set([...first.drafts, ...second.drafts].map(d => d.id)).size, 21);
  const { runMigrations } = require('../src/migrations'); const before = db.prepare('SELECT * FROM materials').all(); assert.equal(runMigrations(db, { logger: { info() {} } }).appliedNow.length, 0); assert.deepEqual(db.prepare('SELECT * FROM materials').all(), before);
  const backup = path.join(temp, 'backup.sqlite'); await db.backup(backup); const restored = new Database(backup, { readonly: true });
  for (const table of ['materials', 'material_drafts', 'material_draft_files', 'material_draft_operations', 'notifications']) assert.equal(restored.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), count(table));
  assert.equal(restored.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(restored.pragma('foreign_key_check'), []); restored.close();
});

test('revogação durante o hash bloqueia rascunho e limpa apenas o upload novo', async () => {
  const native = fs.createReadStream, before = count('material_drafts'), files = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const actor = Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run('Transitório', randomUUID() + '@example.invalid', 'hash', 'admin').lastInsertRowid), token = issueUserToken(actor);
  fs.createReadStream = (...args) => { const stream = native(...args), iterator = stream[Symbol.asyncIterator].bind(stream);
    stream[Symbol.asyncIterator] = async function* () { for await (const chunk of { [Symbol.asyncIterator]: iterator }) yield chunk; db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(actor); }; return stream; };
  try { assert.equal((await save(payload(), { token, file: 'Revogação sintética.' })).status, 401); assert.equal(count('material_drafts'), before); assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), files); }
  finally { fs.createReadStream = native; }
});
