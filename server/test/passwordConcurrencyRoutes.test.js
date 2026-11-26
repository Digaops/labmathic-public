const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-password-races-'));
Object.assign(process.env, { NODE_ENV: 'test', APP_ENV: 'development', DB_PATH: path.join(temp, 'test.sqlite'),
  UPLOAD_DIR: path.join(temp, 'uploads'), JWT_SECRET: 'synthetic-password-concurrency-secret-only', SMTP_USER: '', SMTP_PASS: '' });
const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../src/database');
const sessions = require('../src/services/authSessions');
const passwords = require('../src/services/passwordOperations');
const app = express();
app.use(express.json());
app.use('/auth', require('../src/routes/auth'));
app.use('/users', require('../src/routes/users'));
app.use('/institutions', require('../src/routes/institutionalManagement'));
app.use(require('../src/middleware/apiErrors'));
let server, base, sequence = 0;
const original = 'Senha-sintética-original';
const newHash = bcrypt.hashSync('Senha-sintética-nova', 4);
const originalHash = bcrypt.hashSync(original, 4);
function account(role = 'professor') {
  const id = Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)')
    .run('Conta sintética', `conta-${++sequence}@example.invalid`, originalHash, role).lastInsertRowid);
  return db.prepare('SELECT * FROM users WHERE id = ?').get(id);
}
async function request(url, { token, body, method = 'POST', headers = {} } = {}) {
  const response = await fetch(base + url, { method, headers: { 'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers }, body: body && JSON.stringify(body) });
  return { status: response.status, headers: response.headers, data: await response.json() };
}
function gate(t, method, count = 1, result = method === 'hash' ? newHash : true) {
  let entered, release, seen = 0;
  const arrived = new Promise(resolve => { entered = resolve; });
  const waiting = new Promise(resolve => { release = resolve; });
  t.mock.method(passwords, method, async () => {
    if (++seen === count) entered();
    await waiting;
    return result;
  });
  t.after(release);
  return { arrived, release };
}
test.before(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}`;
});
test.after(async () => {
  await passwords.close();
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

for (const mutation of ['password', 'role', 'email', 'delete']) {
  test(`login não emite sessão se ${mutation} mudar durante comparação`, async t => {
    const user = account();
    const hold = gate(t, 'compare');
    const pending = request('/auth/login', { body: { email: user.email, password: original } });
    await hold.arrived;
    if (mutation === 'delete') db.prepare('DELETE FROM users WHERE id = ?').run(user.id);
    else db.prepare(`UPDATE users SET ${mutation} = ? WHERE id = ?`).run(
      mutation === 'password' ? newHash : mutation === 'role' ? 'admin' : 'changed@example.invalid', user.id);
    hold.release();
    const result = await pending;
    assert.equal(result.status, 401);
    assert.equal(result.data.token, undefined);
    assert.equal(result.headers.get('set-cookie'), null);
  });
}

test('duas trocas simultâneas: apenas uma grava e recebe nova sessão', async t => {
  const user = account();
  const hold = gate(t, 'hash', 2);
  const token = sessions.issueUserToken(user.id);
  const body = { currentPassword: original, newPassword: 'Nova-Senha-Confirmada!' };
  const pending = [1, 2].map(() => request('/auth/change-password', { method: 'PUT', token, body }));
  await hold.arrived;
  hold.release();
  const results = await Promise.all(pending);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 401]);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='change_password' AND user_id=?").pluck().get(user.id), 1);
});

test('logout durante hash impede a gravação da nova senha', async t => {
  const user = account();
  const token = sessions.issueUserToken(user.id);
  const hold = gate(t, 'hash');
  const pending = request('/auth/change-password', { method: 'PUT', token,
    body: { currentPassword: original, newPassword: 'Nova-Senha-Não-Gravar!' } });
  await hold.arrived;
  assert.equal((await request('/auth/logout', { token })).status, 200);
  hold.release();
  assert.equal((await pending).status, 401);
  assert.equal(db.prepare('SELECT password FROM users WHERE id=?').pluck().get(user.id), originalHash);
});

test('logout durante confirmação da senha impede alteração do e-mail', async t => {
  const user = account();
  const token = sessions.issueUserToken(user.id);
  const hold = gate(t, 'compare');
  const pending = request('/auth/profile', { method: 'PUT', token,
    body: { email: 'alterado@example.invalid', currentPassword: original } });
  await hold.arrived;
  assert.equal((await request('/auth/logout', { token })).status, 200);
  hold.release();
  assert.equal((await pending).status, 401);
  assert.equal(db.prepare('SELECT email FROM users WHERE id=?').pluck().get(user.id), user.email);
});

test('reset por link é consumido uma vez, mesmo com duas requisições', async t => {
  const user = account();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO password_reset_tokens(user_id,token,expires_at) VALUES(?,?,?)')
    .run(user.id, `sha256:${sessions.digestToken(token)}`, new Date(Date.now() + 60000).toISOString());
  const hold = gate(t, 'hash', 2);
  const pending = [1, 2].map(() => request('/auth/reset-password', { body: { token, password: 'Senha-nova-sintética!' } }));
  await hold.arrived; hold.release();
  assert.deepEqual((await Promise.all(pending)).map(r => r.status).sort(), [200, 400]);
  assert.equal(db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(user.id), 1);
});

test('link expirado durante hash não altera senha nem consome o token', async t => {
  const user = account();
  const token = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO password_reset_tokens(user_id,token,expires_at) VALUES(?,?,?)')
    .run(user.id, token, new Date(Date.now() + 60000).toISOString());
  const hold = gate(t, 'hash');
  const pending = request('/auth/reset-password', { body: { token, password: 'Senha-nova-sintética!' } });
  await hold.arrived;
  db.prepare("UPDATE password_reset_tokens SET expires_at='2000-01-01' WHERE token=?").run(token);
  hold.release();
  assert.equal((await pending).status, 400);
  assert.equal(db.prepare('SELECT password FROM users WHERE id=?').pluck().get(user.id), originalHash);
});

test('criações concorrentes do mesmo e-mail retornam 201/409, nunca duplicam', async t => {
  const admin = account('admin');
  const hold = gate(t, 'hash', 2);
  const token = sessions.issueUserToken(admin.id);
  const body = { name: 'Nova conta', email: `nova-${++sequence}@example.invalid`, password: 'Nova-conta-sintética!' };
  const pending = [1, 2].map(() => request('/users', { token, body }));
  await hold.arrived; hold.release();
  assert.deepEqual((await Promise.all(pending)).map(r => r.status).sort(), [201, 409]);
});

test('admin rebaixado durante hash não pode criar uma conta', async t => {
  const admin = account('admin');
  const hold = gate(t, 'hash');
  const body = { name: 'Não criar', email: `negada-${++sequence}@example.invalid`, password: 'Senha-sintética-nova!' };
  const pending = request('/users', { token: sessions.issueUserToken(admin.id), body });
  await hold.arrived;
  db.prepare("UPDATE users SET role='professor' WHERE id=?").run(admin.id);
  hold.release();
  assert.equal((await pending).status, 401);
  assert.equal(db.prepare('SELECT 1 FROM users WHERE email=?').get(body.email), undefined);
});

test('reset administrativo não sobrescreve alteração concorrente do destinatário', async t => {
  const admin = account('admin'), user = account();
  const hold = gate(t, 'hash');
  const pending = request(`/users/${user.id}/reset-password`, { method: 'PUT', token: sessions.issueUserToken(admin.id),
    body: { password: 'Senha-sintética-nova!' } });
  await hold.arrived;
  db.prepare('UPDATE users SET password=? WHERE id=?').run(newHash, user.id);
  hold.release();
  assert.equal((await pending).status, 409);
  assert.equal(db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(user.id), 1);
});

test('saturação é tratada no Express 4 com 503 e Retry-After, sem detalhes sensíveis', async t => {
  const user = account();
  t.mock.method(passwords, 'compare', async () => { throw new passwords.PasswordOperationError(); });
  const response = await request('/auth/login', { body: { email: user.email, password: original } });
  assert.equal(response.status, 503);
  assert.equal(response.headers.get('retry-after'), '3');
  assert.equal(JSON.stringify(response.data).includes(original), false);
});

async function institutionalSetup() {
  const admin = account('admin');
  const token = sessions.issueUserToken(admin.id);
  const flag = db.prepare("SELECT id FROM feature_flags WHERE flag_key='institutions.management_pilot'").pluck().get();
  db.prepare('UPDATE feature_flags SET master_enabled=1, kill_switch_active=0 WHERE id=?').run(flag);
  db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES(?,?,1,'Teste isolado',?,?)")
    .run(flag, admin.id, admin.id, admin.id);
  const headers = () => ({ 'Idempotency-Key': crypto.randomUUID() });
  const municipality = await request('/institutions/municipalities', { token, headers: headers(), body: { name: `Município sintético ${++sequence}` } });
  assert.equal(municipality.status, 201, JSON.stringify(municipality.data));
  const municipalityPublicId = municipality.data.municipality.publicId;
  const school = await request(`/institutions/municipalities/${municipalityPublicId}/schools`, { token, headers: headers(), body: { name: 'Escola sintética' } });
  assert.equal(school.status, 201, JSON.stringify(school.data));
  return { admin, token, flag, headers: headers(), body: { name: 'Novo profissional', email: `prof-${++sequence}@example.invalid`,
    temporaryPassword: 'Senha-sintética-temporária!', role: 'teacher', municipalityPublicId, schoolPublicId: school.data.school.publicId } };
}

for (const mutation of ['kill', 'logout', 'school']) {
  test(`cadastro institucional revalida ${mutation} após hash, sem conta órfã`, async t => {
    const setup = await institutionalSetup();
    const hold = gate(t, 'hash');
    const pending = request('/institutions/professionals', setup);
    await hold.arrived;
    if (mutation === 'kill') db.prepare("UPDATE feature_flags SET kill_switch_active=1, kill_switch_reason='Bloqueio sintético durante hash' WHERE id=?").run(setup.flag);
    if (mutation === 'logout') assert.equal((await request('/auth/logout', { token: setup.token })).status, 200);
    if (mutation === 'school') db.prepare("UPDATE schools SET status='archived', archived_at=CURRENT_TIMESTAMP WHERE public_id=?").run(setup.body.schoolPublicId);
    hold.release();
    const response = await pending;
    assert.equal(response.status, mutation === 'logout' ? 401 : 404, JSON.stringify(response.data));
    assert.equal(db.prepare('SELECT 1 FROM users WHERE email=?').get(setup.body.email), undefined);
  });
}

test('cadastro profissional concorrente mantém replay idempotente e vínculo único', async t => {
  const setup = await institutionalSetup();
  const hold = gate(t, 'hash', 2);
  const pending = [1, 2].map(() => request('/institutions/professionals', setup));
  await hold.arrived; hold.release();
  const responses = await Promise.all(pending);
  assert.deepEqual(responses.map(result => result.status).sort(), [200, 201]);
  assert.equal(responses[0].data.membership.publicId, responses[1].data.membership.publicId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM users WHERE email=?').pluck().get(setup.body.email), 1);
});
