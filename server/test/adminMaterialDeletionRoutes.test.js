const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-material-deletion-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-material-deletion-34';
const express = require('express'), db = require('../src/database'), { issueUserToken } = require('../src/services/authSessions');
const app = express(); app.use(express.json()); app.use('/api/materials', require('../src/routes/materials')); app.use(require('../src/middleware/apiErrors'));
let server, base, token, teacherToken, admin;
test.before(async () => {
  admin = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES ('QA','material-delete@example.invalid','hash','admin')").run().lastInsertRowid);
  const teacher = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES ('QA docente','material-teacher@example.invalid','hash','professor')").run().lastInsertRowid);
  token = issueUserToken(admin); teacherToken = issueUserToken(teacher);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api/materials`; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); fs.rmSync(temp, { recursive: true, force: true }); });
async function request(url = '', body, method = body ? 'POST' : 'GET', auth = token) {
  const res = await fetch(base + url, { method, headers: { ...(auth ? { Authorization: `Bearer ${auth}` } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, body: await res.json(), cache: res.headers.get('cache-control') };
}
const create = title => Number(db.prepare('INSERT INTO materials(title,created_by) VALUES (?,?)').run(title, admin).lastInsertRowid);
const existing = id => db.prepare('SELECT * FROM materials WHERE id=?').get(id);
const preview = ids => request('/management-selection?ids=' + ids.join(','));
test('conferência é administrativa, limitada, privada e não marca acesso ao material', async () => {
  const id = create('Conferência'); const before = db.prepare('SELECT COUNT(*) FROM access_history').pluck().get();
  assert.equal((await request('/management-selection?ids=' + id, undefined, 'GET', null)).status, 401);
  assert.equal((await request('/management-selection?ids=' + id, undefined, 'GET', teacherToken)).status, 403);
  for (const input of ['', '0', '-1', '1e2', Array(51).fill(id).join(',')]) assert.equal((await request('/management-selection?ids=' + input)).status, 400);
  const result = await preview([id, 999999]); assert.equal(result.status, 200); assert.match(result.cache, /no-store/); assert.deepEqual(result.body.missingIds, [999999]); assert.match(result.body.materials[0].version, /^[a-f0-9]{64}$/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM access_history').pluck().get(), before);
});
test('exclusão conferida preserva arquivos e metadados de recuperação e auditoria', async () => {
  const id = create('Arquivo preservado'); fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'qa34.txt'), 'Arquivo sintético para recuperação'); db.prepare("UPDATE materials SET file_path='qa34.txt' WHERE id=?").run(id);
  db.prepare('INSERT INTO favorites(user_id,material_id) VALUES (?,?)').run(admin, id);
  const { version } = (await preview([id])).body.materials[0]; const result = await request('/' + id, { expectedVersion: version }, 'DELETE'); assert.equal(result.status, 200); assert.equal(existing(id), undefined);
  assert.equal(fs.readFileSync(path.join(process.env.UPLOAD_DIR, 'qa34.txt'), 'utf8'), 'Arquivo sintético para recuperação');
  const recovery = db.prepare('SELECT recovery_json FROM material_file_retirements WHERE material_id=?').get(id); assert.equal(JSON.parse(recovery.recovery_json).relatedRows.favorites.length, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='delete_material' AND entity_id=?").pluck().get(String(id)), 1);
  assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE')).status, 409);
});
test('alterar título, arquivo ou vínculo invalida a conferência sem excluir', async () => {
  const id = create('Versão original'); let version = (await preview([id])).body.materials[0].version;
  db.prepare("UPDATE materials SET title='Outra revisão' WHERE id=?").run(id); assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE')).status, 409);
  version = (await preview([id])).body.materials[0].version; db.prepare("UPDATE materials SET file_path='novo.txt' WHERE id=?").run(id); assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE')).status, 409);
  const collection = Number(db.prepare("INSERT INTO collections(user_id,name) VALUES (?,'Outro laboratório')").run(admin).lastInsertRowid);
  version = (await preview([id])).body.materials[0].version; db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collection, id); assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE')).status, 409); assert.ok(existing(id));
});
test('um conflito impede a exclusão do lote inteiro, inclusive se outro item sumiu', async () => {
  const a = create('Lote A'), b = create('Lote B'); const selection = (await preview([a, b])).body.materials; const expectedVersions = Object.fromEntries(selection.map(m => [m.id, m.version]));
  db.prepare("UPDATE materials SET description='Revisado' WHERE id=?").run(b); assert.equal((await request('/bulk-delete', { ids: [a, b], expectedVersions })).status, 409); assert.ok(existing(a)); assert.ok(existing(b));
  db.prepare('DELETE FROM materials WHERE id=?').run(b); assert.equal((await request('/bulk-delete', { ids: [a, b], expectedVersions })).status, 409); assert.ok(existing(a));
});
test('lote conferido é atômico e exige a versão de cada alvo, sem incluir outro ID', async () => {
  const ids = [create('Conjunto 1'), create('Conjunto 2')]; const expectedVersions = Object.fromEntries((await preview(ids)).body.materials.map(m => [m.id, m.version]));
  for (const invalid of [{}, null, [], { [ids[0]]: expectedVersions[ids[0]] }, { ...expectedVersions, 9999: 'a'.repeat(64) }]) assert.equal((await request('/bulk-delete', { ids, expectedVersions: invalid })).status, 400);
  assert.ok(ids.every(existing)); const result = await request('/bulk-delete', { ids, expectedVersions }); assert.equal(result.status, 200); assert.equal(result.body.deleted, 2); assert.ok(ids.every(id => !existing(id)));
});
test('falha de auditoria reverte exclusão e registros de recuperação', async () => {
  const id = create('Rollback'); const version = (await preview([id])).body.materials[0].version;
  db.exec("CREATE TRIGGER qa34_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='delete_material' BEGIN SELECT RAISE(ABORT,'qa34 failure'); END;");
  try { assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE')).status, 500); assert.ok(existing(id)); assert.equal(db.prepare('SELECT COUNT(*) FROM material_file_retirements WHERE material_id=?').pluck().get(id), 0); }
  finally { db.exec('DROP TRIGGER qa34_audit_failure'); }
});
test('clientes antigos continuam compatíveis e professor não exclui com versão válida', async () => {
  const id = create('Legado'); const version = (await preview([id])).body.materials[0].version;
  assert.equal((await request('/' + id, { expectedVersion: version }, 'DELETE', teacherToken)).status, 403);
  assert.equal((await request('/' + id, { expectedVersion: null }, 'DELETE')).status, 400);
  assert.equal((await request('/' + id, undefined, 'DELETE')).status, 200);
  const second = create('Legado lote'); assert.equal((await request('/bulk-delete', { ids: [second] })).body.deleted, 1);
});
