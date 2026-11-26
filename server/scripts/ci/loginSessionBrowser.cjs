// QA local isolado: login compacto e permanência de sessão. Ver inventário da Entrega 03.
// Entrada opcional: diretório do build. Saída: tmp/login-session-qa/.
// Login real, PDF autenticado, retomada após perda do cookie, saída,
// PDF compartilhado anônimo/expirado e SVG sem script. Viewports 1366x768/1024x600.
// Todos os dados são sintéticos; o banco e os uploads ficam em mkdtemp.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = path.resolve(__dirname, '../../..');
const serverRequire = createRequire(path.join(root, 'server/package.json'));
const clientRequire = createRequire(path.join(root, 'client/package.json'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-browser-performance-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'browser.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'synthetic-browser-only-secret-never-used-elsewhere';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
fs.mkdirSync(process.env.UPLOAD_DIR);
const express = serverRequire('express');
const db = serverRequire('./src/database');
const app = express();
app.use(serverRequire('helmet')({ contentSecurityPolicy: false, hsts: false }));
const limits = serverRequire('./src/middleware/schoolRateLimits').createSchoolRateLimits({ production: true });
app.use('/api', limits.ingressLimiter);
app.use('/api/auth/login', limits.loginOriginLimiter);
app.use(express.json());
app.use('/api', limits.identifyRateLimitPrincipal, limits.apiLimiter);
app.use('/api/auth/login', limits.authLimiter);
app.use('/uploads', serverRequire('./src/middleware/protectedUploads'));
for (const route of ['auth', 'materials', 'share', 'categories', 'favorites', 'ratings', 'comments',
  'notifications', 'support', 'announcements', 'governance', 'reports', 'collections']) {
  app.use('/api/' + route, serverRequire('./src/routes/' + route));
}
app.use('/api', (_req, res) => res.sendStatus(404));
const build = path.resolve(process.argv[2] || path.join(root, 'tmp/login-session-build'));
app.use(express.static(build));
app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
app.use((error, _req, res, _next) => { console.error(error.message); res.sendStatus(500); });
let password = 'Synthetic-Browser-Password!';
const userId = Number(db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)')
  .run('Professor sintético', 'browser@example.invalid', serverRequire('bcryptjs').hashSync(password, 4), 'professor').lastInsertRowid);
function pdf() {
  const stream = 'BT /F1 22 Tf 30 135 Td (LabMathic - PDF protegido) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 400 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(content.length); content += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = content.length;
  content += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(n => `${String(n).padStart(10, '0')} 00000 n `).join('\n')}\ntrailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return content;
}
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'browser.pdf'), pdf());
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'browser.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="blue"/><script>document.documentElement.setAttribute("data-executed","yes")</script></svg>');
const type = Number(db.prepare("INSERT INTO material_types (name,icon) VALUES ('PDF teste','pdf')").run().lastInsertRowid);
const materialId = Number(db.prepare('INSERT INTO materials (title,file_path,material_type_id,created_by) VALUES (?,?,?,?)')
  .run('PDF de teste protegido', 'browser.pdf', type, userId).lastInsertRowid);
db.prepare('INSERT INTO materials (title,file_path,created_by) VALUES (?,?,?)').run('SVG de teste', 'browser.svg', userId);
const share = 'a'.repeat(64);
db.prepare('INSERT INTO share_links (material_id,created_by,token,expires_at) VALUES (?,?,?,?)')
  .run(materialId, userId, share, new Date(Date.now() + 600000).toISOString());
const screenshots = path.join(root, 'tmp/login-session-qa');
fs.mkdirSync(screenshots, { recursive: true });

let server; let browser;
const errors = [];
const sizes = [];
const AUTH_RECORD = 'labmathic_auth_session_v1';
const secondEmail = 'second-browser@example.invalid';
const secondPassword = 'Second-synthetic-password!';
db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run('Outra professora sintética', secondEmail,
  serverRequire('bcryptjs').hashSync(secondPassword, 4), 'professor');
async function settle(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a =>
    a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
}
async function capture(page, name) {
  await settle(page);
  await page.screenshot({ path: path.join(screenshots, name + '.png'), scale: 'css' });
}
async function readSession(page) {
  return page.evaluate(key => ({
    temporary: JSON.parse(sessionStorage.getItem(key) || 'null'),
    persistent: JSON.parse(localStorage.getItem(key) || 'null'),
    legacy: localStorage.getItem('token'),
  }), AUTH_RECORD);
}
async function activeToken(page) {
  const state = await readSession(page);
  return state.temporary?.token || state.persistent?.token || state.legacy;
}
async function dismissOnNavigation(page, action) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/announcements/current');
  await action();
  if ((await (await response).json()).announcement) {
    await page.getByRole('button', { name: 'Entendi, continuar', exact: true }).click();
  }
}
async function signIn(page, remember = false, email = 'browser@example.invalid', pass = password) {
  await page.getByLabel('E-mail', { exact: true }).fill(email);
  await page.getByLabel('Senha', { exact: true }).fill(pass);
  await page.getByRole('checkbox', { name: 'Lembrar-me', exact: true }).setChecked(remember);
  await dismissOnNavigation(page, () => page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click());
  await page.getByTestId('dashboard-heading').waitFor();
}
async function signOut(page) {
  await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.getByRole('heading', { name: 'Bem-vindo de volta', exact: true }).waitFor();
}
async function fit(page, requireButton = true) {
  const bounds = await page.evaluate(() => {
    const button = document.querySelector('button[type="submit"]')?.getBoundingClientRect();
    const panel = document.querySelector('.login-form-panel')?.getBoundingClientRect();
    return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth,
      scrollHeight: document.documentElement.scrollHeight, buttonBottom: button?.bottom, panelLeft: panel?.left, panelRight: panel?.right };
  });
  assert.ok(bounds.scrollWidth <= bounds.width + 1, JSON.stringify(bounds));
  assert.ok(bounds.panelLeft >= 0 && bounds.panelRight <= bounds.width + 1, JSON.stringify(bounds));
  if (requireButton) assert.ok(bounds.buttonBottom <= bounds.height, JSON.stringify(bounds));
  sizes.push(bounds);
}
(async () => {
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const base = 'http://127.0.0.1:' + server.address().port;
  assert.equal((await fetch(base + '/login')).status, 200);
  browser = await clientRequire('playwright').chromium.launch({ headless: true });
  async function context(options = {}) {
    const current = await browser.newContext({ viewport: { width: 1024, height: 600 }, ...options });
    await current.route('https://fonts.googleapis.com/**', r => r.abort());
    await current.route('https://fonts.gstatic.com/**', r => r.abort());
    current.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return current;
  }
  const ctx = await context();
  let page = await ctx.newPage();
  for (const color of ['light', 'dark']) {
    await page.emulateMedia({ colorScheme: color });
    await page.goto(base + '/login');
    await page.evaluate(value => localStorage.setItem('theme', value), color);
    for (const [width, height] of [[1024, 600], [1280, 720], [1366, 768], [390, 844]]) {
      await page.setViewportSize({ width, height });
      await page.goto(base + '/login');
      await page.getByLabel('E-mail', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => document.documentElement.classList.contains('dark')), color === 'dark');
      assert.equal(await page.getByRole('checkbox', { name: 'Lembrar-me' }).isChecked(), false);
      await fit(page); await capture(page, 'login-' + color + '-' + width);
    }
  }
  await page.setViewportSize({ width: 320, height: 568 });
  await page.goto(base + '/login');
  await page.getByLabel('E-mail', { exact: true }).waitFor();
  await fit(page); await page.getByRole('button', { name: 'Entrar no sistema' }).scrollIntoViewIfNeeded();
  await capture(page, 'login-320');
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto(base + '/login');
  await page.getByLabel('E-mail', { exact: true }).waitFor();
  // Viewport CSS equivalente ao de 1024x600 em zoom de navegador 200%.
  // Não confundir este ensaio de reflow com teste de zoom nativo do sistema.
  await page.setViewportSize({ width: 512, height: 300 });
  await fit(page, false); await page.getByRole('button', { name: 'Entrar no sistema' }).scrollIntoViewIfNeeded();
  await capture(page, 'login-reflow-512');
  await page.setViewportSize({ width: 1024, height: 600 });
  await page.goto(base + '/login');
  for (const [label, target] of [['Privacidade', '/privacidade'], ['Termos de uso', '/termos-de-uso'], ['Esqueceu a senha?', '/esqueci-senha']]) {
    await page.getByRole('link', { name: label, exact: true }).click(); await page.waitForURL(base + target);
    await page.locator('h1,h2').first().waitFor(); await page.goBack();
  }
  await page.getByLabel('E-mail', { exact: true }).fill('browser@example.invalid');
  await page.getByLabel('Senha', { exact: true }).fill('senha-incorreta');
  await page.getByRole('button', { name: 'Mostrar senha', exact: true }).click();
  assert.equal(await page.getByLabel('Senha', { exact: true }).getAttribute('type'), 'text');
  await page.getByRole('button', { name: 'Ocultar senha', exact: true }).click();
  assert.equal(await page.getByLabel('Senha', { exact: true }).getAttribute('type'), 'password');
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await page.getByRole('alert').waitFor(); await capture(page, 'login-invalid-1024');
  assert.equal(await activeToken(page), null);
  await page.route('**/api/auth/login', route => route.abort(), { times: 1 });
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Confira a conexão' }).waitFor();
  await capture(page, 'login-network-error-1024');
  await page.route('**/api/auth/login', route => route.fulfill({ status: 429, contentType: 'application/json',
    headers: { 'Retry-After': '10' }, body: JSON.stringify({ error: 'Muitas tentativas. Aguarde 10 segundos e tente novamente.' }) }), { times: 1 });
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await page.getByRole('alert').filter({ hasText: 'Aguarde 10 segundos' }).waitFor();
  await capture(page, 'login-rate-limit');
  await page.getByRole('checkbox', { name: 'Lembrar-me' }).check();
  await page.getByText('Acesso lembrado neste navegador por até 24 horas. Use apenas em dispositivo pessoal.', { exact: true }).waitFor();
  await capture(page, 'login-remember-selected');
  await page.getByRole('checkbox', { name: 'Lembrar-me' }).uncheck();
  await page.getByLabel('Senha', { exact: true }).fill(password);
  let releaseLogin; let loginStarted; let loginRequests = 0;
  const delayedLogin = new Promise(resolve => { releaseLogin = resolve; });
  const loginRequested = new Promise(resolve => { loginStarted = resolve; });
  await page.route('**/api/auth/login', async route => {
    loginRequests += 1; loginStarted(); await delayedLogin; await route.continue();
  }, { times: 1 });
  await dismissOnNavigation(page, async () => {
    await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
    await loginRequested;
    assert.equal(await page.getByRole('button', { name: 'Entrando...', exact: true }).isDisabled(), true);
    assert.equal(await page.getByLabel('E-mail', { exact: true }).isDisabled(), true);
    await page.keyboard.press('Enter');
    await capture(page, 'login-pending');
    assert.equal(loginRequests, 1);
    releaseLogin();
  });
  await page.getByTestId('dashboard-heading').waitFor();
  assert.equal((await readSession(page)).persistent, null);
  let token = await activeToken(page);
  await dismissOnNavigation(page, () => page.reload());
  assert.equal(await activeToken(page), token);
  await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
  await page.getByRole('link', { name: 'Minha conta', exact: true }).click();
  await page.getByRole('heading', { name: 'Minha conta', exact: true }).waitFor();
  await page.getByLabel('Nome', { exact: true }).fill('Professor atualizado');
  await page.getByRole('button', { name: 'Salvar alterações', exact: true }).click();
  await page.getByText('Dados da conta atualizados.', { exact: true }).waitFor();
  assert.equal((await readSession(page)).persistent, null);
  await page.getByLabel('Senha atual', { exact: true }).fill(password);
  const newPassword = 'New-synthetic-browser-password!';
  await page.getByLabel('Nova senha', { exact: true }).fill(newPassword);
  await page.getByLabel('Confirmar nova senha', { exact: true }).fill(newPassword);
  await page.getByRole('button', { name: 'Alterar senha', exact: true }).click();
  await page.getByText('Senha alterada.', { exact: true }).waitFor();
  password = newPassword;
  assert.notEqual(await activeToken(page), token);
  assert.equal((await readSession(page)).persistent, null);
  assert.equal((await ctx.request.get(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + token } })).status(), 401);
  token = await activeToken(page);
  await capture(page, 'temporary-password-updated');
  await page.close();
  page = await ctx.newPage();
  await page.goto(base + '/'); await page.waitForURL(base + '/login');
  assert.equal(await activeToken(page), null);
  await capture(page, 'temporary-tab-reopened');
  // Cookie de mídia tem sessão de navegador: saída explícita continua necessária.
  assert.equal((await ctx.request.post(base + '/api/auth/logout', { headers: { Authorization: 'Bearer ' + token } })).status(), 200);
  await signIn(page, true);
  assert.equal((await readSession(page)).temporary, null);
  const persistentToken = await activeToken(page);
  const saved = await ctx.storageState();
  const restored = await context({ storageState: saved });
  const restoredPage = await restored.newPage();
  await dismissOnNavigation(restoredPage, () => restoredPage.goto(base + '/'));
  assert.equal(await activeToken(restoredPage), persistentToken);
  await capture(restoredPage, 'remembered-restored');
  await restored.close();
  const secondTab = await ctx.newPage();
  await dismissOnNavigation(secondTab, () => secondTab.goto(base + '/'));
  await signOut(page);
  await secondTab.waitForURL(base + '/login');
  await secondTab.getByText('A sessão foi encerrada em outra aba.', { exact: true }).waitFor();
  await capture(secondTab, 'logout-other-tab');
  assert.equal((await ctx.request.get(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + persistentToken } })).status(), 401);
  await secondTab.close();
  await signIn(page, true);
  const stale = await ctx.newPage();
  let release; let started;
  const waiting = new Promise(resolve => { release = resolve; });
  const requested = new Promise(resolve => { started = resolve; });
  await stale.route('**/api/auth/me', async route => {
    const response = await route.fetch(); started(); await waiting;
    await route.fulfill({ response }).catch(() => {});
  });
  await stale.goto(base + '/'); await requested;
  await signOut(page); await signIn(page, false, secondEmail, secondPassword);
  release();
  await stale.waitForURL(base + '/login');
  await stale.getByText('A sessão mudou em outra aba. Entre novamente para continuar com a sua conta.', { exact: true }).waitFor();
  assert.equal((await readSession(stale)).temporary, null);
  assert.equal((await readSession(page)).temporary.user.email, secondEmail);
  await capture(stale, 'stale-bootstrap-rejected');
  await signOut(page); await stale.close(); await ctx.close();

  const legacyToken = serverRequire('./src/services/authSessions').issueUserToken(userId);
  const legacy = await context({ storageState: { cookies: [], origins: [{ origin: base, localStorage: [
    { name: 'token', value: legacyToken }, { name: 'user', value: JSON.stringify({ id: userId, name: 'Professor atualizado', email: 'browser@example.invalid', role: 'professor' }) },
  ] }] } });
  const legacyPage = await legacy.newPage();
  await dismissOnNavigation(legacyPage, () => legacyPage.goto(base + '/'));
  assert.equal((await readSession(legacyPage)).persistent.token, legacyToken);
  assert.equal((await readSession(legacyPage)).legacy, null);
  await capture(legacyPage, 'legacy-session-preserved');
  await signOut(legacyPage); await legacy.close();

  const restricted = await context();
  await restricted.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function(key, value) {
      if (key === 'labmathic_auth_session_v1') throw new DOMException('Storage blocked', 'SecurityError');
      return original.call(this, key, value);
    };
  });
  const restrictedPage = await restricted.newPage();
  await restrictedPage.goto(base + '/login');
  await restrictedPage.getByLabel('E-mail', { exact: true }).fill('browser@example.invalid');
  await restrictedPage.getByLabel('Senha', { exact: true }).fill(password);
  const loginResponse = restrictedPage.waitForResponse(r => new URL(r.url()).pathname === '/api/auth/login');
  await restrictedPage.getByRole('button', { name: 'Entrar no sistema' }).click();
  const orphanToken = (await (await loginResponse).json()).token;
  await restrictedPage.getByRole('alert').filter({ hasText: 'não permitiu guardar' }).waitFor();
  assert.equal((await restricted.request.get(base + '/api/auth/me', { headers: { Authorization: 'Bearer ' + orphanToken } })).status(), 401);
  await capture(restrictedPage, 'storage-blocked');
  await restricted.close();
  const blockedRead = await context();
  await blockedRead.addInitScript(() => {
    for (const key of ['localStorage', 'sessionStorage']) {
      Object.defineProperty(window, key, { get() { throw new DOMException('Storage blocked', 'SecurityError'); } });
    }
  });
  const blockedPage = await blockedRead.newPage();
  await blockedPage.goto(base + '/login');
  await blockedPage.getByLabel('E-mail', { exact: true }).fill('browser@example.invalid');
  await blockedPage.getByLabel('Senha', { exact: true }).fill(password);
  await blockedPage.getByRole('button', { name: 'Entrar no sistema' }).click();
  await blockedPage.getByRole('alert').filter({ hasText: 'não permitiu guardar' }).waitFor();
  await capture(blockedPage, 'storage-read-blocked');
  await blockedRead.close();
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(screenshots, 'viewport-metrics.json'), JSON.stringify(sizes, null, 2));
  console.log('BROWSER PASS: viewport fit, theme, zoom/reflow, controls, invalid/offline login, temporary/remembered/legacy sessions, profile/password, logout across tabs, stale bootstrap and storage failure.');
})().catch(async error => {
  console.error(error); process.exitCode = 1;
  const page = browser?.contexts().flatMap(context => context.pages()).find(page => !page.isClosed());
  if (page) {
    await page.screenshot({ path: path.join(screenshots, 'failure.png'), scale: 'css' }).catch(() => {});
    console.error((await page.locator('body').innerText().catch(() => '')).slice(0, 3000));
  }
}).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});
