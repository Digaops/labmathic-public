const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-security-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'synthetic-security-test-secret-not-used-anywhere-else';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const sessions = require('../src/services/authSessions');
const { runMigrations } = require('../src/migrations');
const app = express();
app.use(express.json());
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/users', require('../src/routes/users'));
app.use('/api/materials', require('../src/routes/materials'));
app.use('/api/share', require('../src/routes/share'));
app.use('/uploads', require('../src/middleware/protectedUploads'));
app.use(require('../src/middleware/apiErrors'));
let server;
let base;
let admin;
let adminToken;
let sequence = 0;
const password = 'Senha-Sintetica-2026!';

function user(role = 'professor') {
  const email = `synthetic-${++sequence}@example.invalid`;
  const id = Number(db.prepare('INSERT INTO users (name, email, password, role) VALUES (?, ?, ?, ?)')
    .run('Conta sintética', email, bcrypt.hashSync(password, 4), role).lastInsertRowid);
  return { id, email, role };
}
async function request(url, { token, cookie, body, form, method = 'GET', headers = {} } = {}) {
  const response = await fetch(base + url, {
    method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: form || (body ? JSON.stringify(body) : undefined),
  });
  const text = await response.text();
  return { status: response.status, headers: response.headers, text,
    data: response.headers.get('content-type')?.includes('application/json') && text ? JSON.parse(text) : null };
}
function material() {
  const filename = `synthetic-${++sequence}.pdf`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, filename), '%PDF-1.4 synthetic file for range checks');
  const id = Number(db.prepare("INSERT INTO materials (title, file_path, file_format, created_by) VALUES (?, ?, 'PDF', ?)")
    .run('Material sintético', filename, admin.id).lastInsertRowid);
  return { id, filename };
}
function form(fields = {}) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, String(value));
  data.set('file', new Blob(['%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF\n']), 'novo.pdf');
  return data;
}
function failAudit(t, action) {
  db.exec(`CREATE TRIGGER synthetic_audit_failure BEFORE INSERT ON activity_log
    WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'synthetic_audit_failure'); END;`);
  t.after(() => db.exec('DROP TRIGGER IF EXISTS synthetic_audit_failure'));
}

test.before(async () => {
  admin = user('admin');
  adminToken = sessions.issueUserToken(admin.id);
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); });
  });
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('migração é idempotente e não invalida conta sem mudança de segurança', () => {
  const before = db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id);
  runMigrations(db, { logger: { info() {} } });
  assert.deepEqual(db.prepare('SELECT * FROM users WHERE id = ?').get(admin.id), before);
  db.prepare('UPDATE users SET name = ?, role = role, password = password WHERE id = ?').run('Admin sintético', admin.id);
  assert.equal(db.prepare('SELECT auth_version FROM users WHERE id = ?').get(admin.id).auth_version, 0);
});

test('login configura mídia HttpOnly e logout revoga apenas a sessão correspondente', async () => {
  const account = user();
  const login = await request('/api/auth/login', { method: 'POST', body: { email: account.email, password } });
  assert.equal(login.status, 200);
  assert.match(login.headers.get('set-cookie'), /HttpOnly/);
  assert.match(login.headers.get('set-cookie'), /Path=\/uploads/);
  assert.match(login.headers.get('set-cookie'), /SameSite=Strict/);
  const second = sessions.issueUserToken(account.id);
  assert.notEqual(second, login.data.token);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/auth/me', { cookie })).status, 401, 'cookie não autoriza a API');
  assert.equal((await request('/api/auth/logout', { method: 'POST', token: login.data.token })).status, 200);
  assert.equal((await request('/api/auth/me', { token: login.data.token })).status, 401);
  assert.equal((await request('/api/auth/me', { token: second })).status, 200);
  const row = db.prepare('SELECT * FROM revoked_auth_tokens WHERE user_id = ?').get(account.id);
  assert.equal(row.token_digest, sessions.digestToken(login.data.token));
  assert.equal(JSON.stringify(row).includes(login.data.token), false);
});

test('troca de senha renova sessão atual e invalida todas as anteriores', async () => {
  const account = user();
  const old = sessions.issueUserToken(account.id);
  const changed = await request('/api/auth/change-password', { method: 'PUT', token: old,
    body: { currentPassword: password, newPassword: 'Nova-Senha-Sintetica!' } });
  assert.equal(changed.status, 200);
  assert.equal((await request('/api/auth/me', { token: old })).status, 401);
  assert.equal((await request('/api/auth/me', { token: changed.data.token })).status, 200);
});

test('perfil atual não depende das alegações antigas e mudança de papel invalida sessão', async () => {
  const account = user();
  const legacy = jwt.sign({ ...account, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal((await request('/api/users', { token: legacy })).status, 403);
  assert.equal((await request(`/api/users/${account.id}`, { method: 'PUT', token: adminToken, body: { role: 'admin' } })).status, 200);
  assert.equal((await request('/api/auth/me', { token: legacy })).status, 401);
  const fresh = sessions.issueUserToken(account.id);
  assert.equal((await request('/api/users', { token: fresh })).status, 200);
  assert.equal((await request(`/api/users/${account.id}`, { method: 'DELETE', token: adminToken })).status, 200);
  assert.equal((await request('/api/auth/me', { token: fresh })).status, 401);
});

test('reset administrativo invalida sessões e último administrador não pode ser rebaixado', async () => {
  const account = user();
  const token = sessions.issueUserToken(account.id);
  assert.equal((await request(`/api/users/${account.id}/reset-password`, { method: 'PUT', token: adminToken,
    body: { password: 'Nova-Senha-Administrativa!' } })).status, 200);
  assert.equal((await request('/api/auth/me', { token })).status, 401);
  assert.equal((await request(`/api/users/${admin.id}`, { method: 'PUT', token: adminToken, body: { role: 'professor' } })).status, 409);
});

test('falha de auditoria desfaz alteração de senha', async t => {
  const account = user();
  const token = sessions.issueUserToken(account.id);
  failAudit(t, 'change_password');
  const before = db.prepare('SELECT password, auth_version FROM users WHERE id = ?').get(account.id);
  const response = await request('/api/auth/change-password', { method: 'PUT', token,
    body: { currentPassword: password, newPassword: 'Nao-Deve-Ser-Gravada!' } });
  assert.equal(response.status, 500);
  assert.deepEqual(db.prepare('SELECT password, auth_version FROM users WHERE id = ?').get(account.id), before);
});

test('falha de auditoria não deixa uma conta criada parcialmente', async t => {
  failAudit(t, 'create_user');
  const response = await request('/api/users', { method: 'POST', token: adminToken,
    body: { name: 'Conta não persistida', email: 'rollback@example.invalid', password } });
  assert.equal(response.status, 500);
  assert.equal(db.prepare("SELECT id FROM users WHERE email = 'rollback@example.invalid'").get(), undefined);
});

test('recuperação de senha invalida token legado e não permite reutilizar link', async () => {
  const account = user();
  const legacy = jwt.sign(account, process.env.JWT_SECRET, { expiresIn: '1h' });
  const reset = require('node:crypto').randomBytes(32).toString('hex');
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(account.id, reset, new Date(Date.now() + 60000).toISOString());
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: reset, password: 'Senha-Recuperada!' } })).status, 200);
  assert.equal((await request('/api/auth/me', { token: legacy })).status, 401);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: reset, password } })).status, 400);
});

test('imagem de laboratório privado respeita proprietário e caminhos inválidos não são servidos', async () => {
  const owner = user();
  const stranger = user();
  const filename = 'private-collection.png';
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, filename), 'synthetic image');
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'orphan.txt'), 'synthetic orphan');
  db.prepare('INSERT INTO collections (user_id, name, image_path) VALUES (?, ?, ?)').run(owner.id, 'Privado', filename);
  assert.equal((await request(`/uploads/${filename}`, { token: sessions.issueUserToken(owner.id) })).status, 200);
  assert.equal((await request(`/uploads/${filename}`, { token: sessions.issueUserToken(stranger.id) })).status, 404);
  for (const url of ['/uploads/orphan.txt', '/uploads/%2e%2e%2fdatabase.sqlite', '/uploads/sub/file.pdf', '/uploads/.hidden']) {
    assert.equal((await request(url, { token: adminToken })).status, 404);
  }
});

test('novos resets guardam digest, recusam digest como credencial e invalidam pedidos anteriores', async () => {
  const account = user();
  const raw = require('node:crypto').randomBytes(32).toString('hex');
  const digest = `sha256:${sessions.digestToken(raw)}`;
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(account.id, digest, new Date(Date.now() + 60_000).toISOString());
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: digest, password } })).status, 400);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: sessions.digestToken(raw), password } })).status, 400);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password } })).status, 200);
  assert.equal((await request('/api/auth/reset-password', { method: 'POST', body: { token: raw, password } })).status, 400);
  for (let index = 0; index < 2; index += 1) {
    const result = await request('/api/auth/forgot-password', { method: 'POST', body: { email: account.email } });
    assert.equal(result.status, 200);
    const records = db.prepare('SELECT token FROM password_reset_tokens WHERE user_id = ? AND used = 0').all(account.id);
    assert.equal(records.length, 1);
    assert.match(records[0].token, /^sha256:[a-f0-9]{64}$/);
    assert.equal(result.text.includes(records[0].token), false);
  }
});

test('perfil é auditado atomicamente e invalida recuperação após mudança de e-mail', async t => {
  const account = user();
  const token = sessions.issueUserToken(account.id);
  db.prepare('INSERT INTO password_reset_tokens (user_id, token, expires_at) VALUES (?, ?, ?)')
    .run(account.id, 'b'.repeat(64), new Date(Date.now() + 60_000).toISOString());
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: { name: '   ' } })).status, 400);
  const changedEmail = { email: 'updated@example.invalid' };
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: changedEmail })).status, 400);
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: { ...changedEmail, currentPassword: 'Senha errada' } })).status, 403);
  assert.equal(db.prepare('SELECT email FROM users WHERE id = ?').pluck().get(account.id), account.email);
  assert.equal(db.prepare('SELECT used FROM password_reset_tokens WHERE user_id = ?').get(account.id).used, 0);
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: { ...changedEmail, currentPassword: password } })).status, 200);
  assert.equal(db.prepare('SELECT used FROM password_reset_tokens WHERE user_id = ?').get(account.id).used, 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='update_profile' AND user_id=?").pluck().get(account.id), 1);
  failAudit(t, 'update_profile');
  const before = db.prepare('SELECT name, email FROM users WHERE id = ?').get(account.id);
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: { name: 'Não persistir' } })).status, 500);
  assert.deepEqual(db.prepare('SELECT name, email FROM users WHERE id = ?').get(account.id), before);
});

test('confirmação de senha tem limite por conta sem impedir edição de nome', async () => {
  const account = user();
  const token = sessions.issueUserToken(account.id);
  const body = { email: 'limited-change@example.invalid', currentPassword: 'Senha errada' };
  for (let index = 0; index < 10; index += 1) {
    assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body })).status, 403);
  }
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body })).status, 429);
  assert.equal((await request('/api/auth/profile', { method: 'PUT', token, body: { name: 'Nome atualizado' } })).status, 200);
});

test('inventário de compartilhamentos é administrativo, paginado e não inclui expirados ou outro material', async () => {
  const item = material();
  const other = material();
  const insert = db.prepare('INSERT INTO share_links (material_id, created_by, token, expires_at) VALUES (?, ?, ?, ?)');
  for (let index = 0; index < 23; index += 1) insert.run(item.id, admin.id,
    require('node:crypto').randomBytes(32).toString('hex'), new Date(Date.now() + 60_000).toISOString());
  insert.run(item.id, admin.id, require('node:crypto').randomBytes(32).toString('hex'), '2000-01-01T00:00:00Z');
  insert.run(other.id, admin.id, require('node:crypto').randomBytes(32).toString('hex'), new Date(Date.now() + 60_000).toISOString());
  const endpoint = `/api/share/material/${item.id}`;
  assert.equal((await request(endpoint)).status, 401);
  assert.equal((await request(endpoint, { token: sessions.issueUserToken(user().id) })).status, 403);
  assert.equal((await request(endpoint + '?before=invalid', { token: adminToken })).status, 400);
  const first = await request(endpoint, { token: adminToken });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get('cache-control'), 'no-store');
  assert.equal(first.data.links.length, 20);
  const second = await request(endpoint + '?before=' + first.data.nextCursor, { token: adminToken });
  assert.equal(second.data.links.length, 3);
  assert.equal(second.data.nextCursor, null);
  assert.equal(new Set([...first.data.links, ...second.data.links].map(link => link.id)).size, 23);
  const revoked = first.data.links[0];
  assert.equal((await request('/api/share/' + revoked.token, { method: 'DELETE', token: adminToken })).status, 204);
  assert.equal((await request('/api/share/' + revoked.token)).status, 404);
});

test('arquivos exigem autorização, suportam PDF/Range e compartilham somente o material correto', async () => {
  const first = material();
  const second = material();
  const token = sessions.issueUserToken(user().id);
  const cookie = `${sessions.MEDIA_COOKIE}=${token}`;
  assert.equal((await request(`/uploads/${first.filename}`)).status, 404);
  assert.equal((await request(`/api/materials/${first.id}/public`)).status, 404);
  const read = await request(`/uploads/${first.filename}`, { cookie, headers: { Range: 'bytes=0-7' } });
  assert.equal(read.status, 206);
  assert.equal(read.text, '%PDF-1.4');
  assert.match(read.headers.get('cache-control'), /private, no-store/);
  assert.match(read.headers.get('content-security-policy'), /sandbox/);
  assert.equal((await request(`/uploads/${first.filename}`, { method: 'HEAD', cookie })).status, 200);
  const share = await request('/api/share', { method: 'POST', token: adminToken, body: { material_id: first.id } });
  assert.equal(share.status, 201);
  const shareToken = share.data.token;
  assert.equal((await request(`/uploads/${first.filename}?share=${shareToken}`)).status, 200);
  assert.equal((await request(`/api/materials/${first.id}/public?token=${shareToken}`)).status, 200);
  assert.equal((await request(`/uploads/${second.filename}?share=${shareToken}`, { cookie })).status, 404);
  assert.equal((await request(`/api/materials/${second.id}/public?token=${shareToken}`)).status, 404);
  db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00Z', shareToken);
  assert.equal((await request(`/api/share/${shareToken}`)).status, 410);
  assert.equal((await request(`/uploads/${first.filename}?share=${shareToken}`, { cookie })).status, 404);
  assert.equal((await request(`/api/materials/${first.id}/public?token=${shareToken}`)).status, 404);
  assert.equal((await request(`/api/share/${shareToken}`, { method: 'DELETE', token: adminToken })).status, 204);
  assert.equal((await request(`/uploads/${first.filename}?share=${shareToken}`)).status, 404);
  await request('/api/auth/logout', { method: 'POST', token });
  assert.equal((await request(`/uploads/${first.filename}`, { cookie })).status, 404);
});

test('upload substituído preserva original e recuperação sem disponibilizar arquivo retirado', async () => {
  const item = material();
  const response = await request(`/api/materials/${item.id}`, { method: 'PUT', token: adminToken, form: form({ title: 'Novo título' }) });
  assert.equal(response.status, 200);
  assert.notEqual(response.data.file_path, item.filename);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, item.filename)), true);
  const retired = db.prepare('SELECT * FROM material_file_retirements WHERE material_id = ?').get(item.id);
  assert.equal(retired.reason, 'replaced');
  assert.equal(JSON.parse(retired.recovery_json).material.file_path, item.filename);
  assert.equal((await request(`/uploads/${item.filename}`, { token: adminToken })).status, 404);
  assert.equal((await request(`/uploads/${response.data.file_path}`, { token: adminToken })).status, 200);
});

test('falha de atualização preserva banco e arquivo anterior, descartando apenas upload novo', async t => {
  const item = material();
  const before = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  failAudit(t, 'update_material');
  const response = await request(`/api/materials/${item.id}`, { method: 'PUT', token: adminToken, form: form() });
  assert.equal(response.status >= 400, true);
  assert.equal(db.prepare('SELECT file_path FROM materials WHERE id = ?').get(item.id).file_path, item.filename);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), before);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_file_retirements WHERE material_id = ?').get(item.id).n, 0);
});

test('vínculo inválido não deixa material parcial nem upload órfão', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  const response = await request('/api/materials', { method: 'POST', token: adminToken,
    form: form({ title: 'Não persistir', topics: '[99999999]' }) });
  assert.equal(response.status, 400);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM materials WHERE title = 'Não persistir'").get().n, 0);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), before);
  assert.equal((await request('/api/materials/99999999', { method: 'PUT', token: adminToken, form: form() })).status, 404);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), before);
});

test('exclusão retira do catálogo mas mantém arquivo e metadados para recuperação', async () => {
  const item = material();
  assert.equal((await request(`/api/materials/${item.id}`, { method: 'DELETE', token: adminToken })).status, 200);
  assert.equal(db.prepare('SELECT id FROM materials WHERE id = ?').get(item.id), undefined);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, item.filename)), true);
  assert.equal(db.prepare('SELECT reason FROM material_file_retirements WHERE material_id = ?').get(item.id).reason, 'deleted');
  assert.equal((await request(`/uploads/${item.filename}`, { token: adminToken })).status, 404);
});

test('exclusão em massa é atômica mesmo quando auditoria falha', async t => {
  const items = [material(), material()];
  failAudit(t, 'bulk_delete_materials');
  const result = await request('/api/materials/bulk-delete', { method: 'POST', token: adminToken, body: { ids: items.map(item => item.id) } });
  assert.equal(result.status >= 400, true);
  for (const item of items) {
    assert.equal(db.prepare('SELECT id FROM materials WHERE id = ?').get(item.id).id, item.id);
    assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, item.filename)), true);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM material_file_retirements WHERE material_id = ?').get(item.id).n, 0);
  }
});

test('qs atualizado suporta round-trip de entrada hostil sem derrubar requisição', () => {
  const qs = require('qs');
  assert.doesNotThrow(() => qs.stringify(qs.parse('x[constructor][isBuffer]=y', { plainObjects: true })));
});

test('multipart malformado é recusado sem derrubar API nem deixar arquivos', async () => {
  const before = fs.readdirSync(process.env.UPLOAD_DIR).sort();
  for (const contentType of ['multipart/form-data', 'multipart/form-data; boundary=synthetic-boundary']) {
    const response = await fetch(base + '/api/materials', { method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': contentType }, body: 'incomplete synthetic payload' });
    assert.equal(response.status, 400);
    await response.text();
  }
  const unexpected = new FormData();
  unexpected.set('unexpected', new Blob(['not accepted']), 'file.pdf');
  assert.equal((await request('/api/materials', { method: 'POST', token: adminToken, form: unexpected })).status, 400);
  assert.deepEqual(fs.readdirSync(process.env.UPLOAD_DIR).sort(), before);
  assert.equal((await request('/api/auth/me', { token: adminToken })).status, 200);
});
