// QA local isolado: tamanho do login, navegação lazy, recuperação de chunk e PDF.
// Entrada opcional: diretório do build. Saída: tmp/school-performance-qa/.
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
const build = path.resolve(process.argv[2] || path.join(root, 'tmp/school-performance-build'));
app.use(express.static(build));
app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
app.use((error, _req, res, _next) => { console.error(error.message); res.sendStatus(500); });
const password = 'Synthetic-Browser-Password!';
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
const screenshots = path.join(root, 'tmp/school-performance-qa');
fs.mkdirSync(screenshots, { recursive: true });
let server;
let browser;
let baselineServer;
async function readToken(page) {
  return page.evaluate(() => {
    const key = 'labmathic_auth_session_v1';
    const record = JSON.parse(sessionStorage.getItem(key) || localStorage.getItem(key) || 'null');
    return record?.token || localStorage.getItem('token');
  });
}
const metrics = {};
async function initialResources(page) {
  await page.getByLabel('E-mail', { exact: true }).waitFor();
  return page.evaluate(() => {
    const files = performance.getEntriesByType('resource').filter(r => /\.m?js(?:\?|$)/.test(r.name));
    return { rawBytes: files.reduce((sum, r) => sum + r.decodedBodySize, 0),
      files: files.map(r => new URL(r.name).pathname) };
  });
}
async function settleAnimations(page) {
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a =>
    a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
}
async function navigateAndDismissAnnouncement(page, action) {
  const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/announcements/current');
  await action();
  if ((await (await response).json()).announcement) {
    await page.getByRole('button', { name: 'Entendi, continuar', exact: true }).click();
  }
}
async function renderedPdf(page) {
  // Canvas existe antes da renderização: exigir pixels do texto, não só o elemento.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas || canvas.width <= 100) return false;
    const pixels = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
    let dark = 0;
    for (let i = 0; i < pixels.length; i += 4) {
      if (pixels[i + 3] > 200 && pixels[i] < 80 && pixels[i + 1] < 80 && pixels[i + 2] < 80) dark += 1;
    }
    return dark > 100;
  });
  await page.evaluate(() => Promise.all(document.getAnimations().filter(a =>
    a.effect?.getTiming().iterations !== Infinity).map(a => a.finished.catch(() => {}))));
}
async function fittedPdf(page) {
  // Não basta a página não transbordar: o canvas precisa caber dentro do leitor.
  await page.waitForFunction(() => {
    const canvas = document.querySelector('canvas');
    if (!canvas) return false;
    const container = canvas.parentElement;
    const style = getComputedStyle(container);
    const bounds = canvas.getBoundingClientRect();
    const parentBounds = container.getBoundingClientRect();
    const padding = parseFloat(style.paddingLeft) + parseFloat(style.paddingRight);
    return bounds.width > 100 && bounds.width <= container.clientWidth - padding
      && container.scrollWidth <= container.clientWidth + 1
      && bounds.left >= parentBounds.left && bounds.right <= parentBounds.right;
  });
  await renderedPdf(page);
}
(async () => {
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/login')).status, 200);
  browser = await clientRequire('playwright').chromium.launch({ headless: true });
  const baselineBuild = path.join(root, 'tmp/security-foundation-build');
  if (fs.existsSync(path.join(baselineBuild, 'index.html'))) {
    const baselineApp = express();
    baselineApp.use(express.static(baselineBuild));
    baselineApp.get('*', (_req, res) => res.sendFile(path.join(baselineBuild, 'index.html')));
    baselineServer = await new Promise(resolve => { const current = baselineApp.listen(0, '127.0.0.1', () => resolve(current)); });
    const baselineContext = await browser.newContext();
    await baselineContext.route('https://fonts.googleapis.com/**', r => r.abort());
    await baselineContext.route('https://fonts.gstatic.com/**', r => r.abort());
    const baselinePage = await baselineContext.newPage();
    await baselinePage.goto(`http://127.0.0.1:${baselineServer.address().port}/login`);
    metrics.baseline = await initialResources(baselinePage);
    await baselineContext.close();
  }
  const context = await browser.newContext({ viewport: { width: 1366, height: 768 }, deviceScaleFactor: 1, colorScheme: 'dark' });
  await context.route('https://fonts.googleapis.com/**', r => r.abort());
  await context.route('https://fonts.gstatic.com/**', r => r.abort());
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(base + '/login');
  metrics.current = await initialResources(page);
  assert.ok(metrics.current.rawBytes > 0 && metrics.current.rawBytes < 450000);
  assert.equal(metrics.current.files.some(f => /PDFViewer|pdf.worker|Admin|Classes|Library/.test(f)), false);
  await settleAnimations(page);
  await page.screenshot({ path: path.join(screenshots, 'login-dark-1366.png'), scale: 'css' });
  await page.getByLabel('E-mail', { exact: true }).fill('browser@example.invalid');
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await navigateAndDismissAnnouncement(page, () => page.locator('button[type="submit"]').click());
  await page.waitForURL(base + '/');
  const cookies = await context.cookies(base + '/uploads/browser.pdf');
  assert.ok(cookies.some(c => c.name === 'labmathic_media' && c.httpOnly && c.sameSite === 'Strict'));
  const token = await readToken(page);
  assert.ok(token);
  // Interromper temporariamente somente o chunk da biblioteca para conferir o fallback.
  let releaseLibrary; let libraryRequested;
  const libraryDelay = new Promise(resolve => { releaseLibrary = resolve; });
  const requestedLibrary = new Promise(resolve => { libraryRequested = resolve; });
  await page.route('**/assets/Library-*.js', async route => { libraryRequested(); await libraryDelay; await route.continue(); });
  await page.getByRole('button', { name: 'Recursos', exact: true }).click();
  await page.getByRole('menuitem', { name: /Biblioteca/ }).click();
  await requestedLibrary;
  // React Router usa transições: pode preservar a tela anterior em vez do spinner.
  assert.equal(await page.getByRole('button', { name: 'Menu do usuário', exact: true }).isVisible(), true);
  assert.equal(await page.getByTestId('dashboard-heading').isVisible(), true);
  await settleAnimations(page);
  await page.screenshot({ path: path.join(screenshots, 'lazy-navigation-dark-1366.png'), scale: 'css' });
  releaseLibrary();
  await page.getByRole('link', { name: /PDF de teste protegido/ }).click();
  await renderedPdf(page);
  await page.screenshot({ path: path.join(screenshots, 'pdf-authenticated-1366.png'), scale: 'css' });
  await context.clearCookies();
  await navigateAndDismissAnnouncement(page, () => page.reload());
  await renderedPdf(page);
  assert.ok((await context.cookies()).some(c => c.name === 'labmathic_media'));
  await page.setViewportSize({ width: 1024, height: 600 });
  await fittedPdf(page);
  await page.screenshot({ path: path.join(screenshots, 'pdf-authenticated-1024.png'), scale: 'css' });
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'pdf-content-1024.png'), scale: 'css' });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await fittedPdf(page);
  for (const label of ['Página anterior', 'Próxima página']) {
    assert.equal(await page.getByRole('button', { name: label, exact: true }).first().evaluate(button => {
      const bounds = button.getBoundingClientRect();
      const parent = button.parentElement.getBoundingClientRect();
      return bounds.left >= parent.left && bounds.right <= parent.right;
    }), true, 'Paginação precisa caber, mesmo sem rolagem horizontal do documento');
  }
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.locator('canvas').scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(screenshots, 'pdf-content-mobile-dark.png'), scale: 'css' });
  await page.setViewportSize({ width: 1024, height: 600 });
  // Falha de chunk: botão de recuperação deve recarregar a página e manter a conta.
  await page.route('**/assets/Profile-*.js', route => route.abort(), { times: 1 });
  await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
  await page.getByRole('link', { name: 'Minha conta', exact: true }).click();
  await page.getByRole('heading', { name: 'Algo deu errado', exact: true }).waitFor();
  await settleAnimations(page);
  await page.screenshot({ path: path.join(screenshots, 'chunk-failure-dark-1024.png'), scale: 'css' });
  await navigateAndDismissAnnouncement(page, () => page.getByRole('button', { name: 'Tentar novamente', exact: true }).click());
  await page.getByRole('heading', { name: 'Minha conta', exact: true }).waitFor();
  assert.ok(await readToken(page));
  await settleAnimations(page);
  await page.screenshot({ path: path.join(screenshots, 'chunk-recovered-dark-1024.png'), scale: 'css' });
  await page.getByRole('button', { name: 'Alternar tema', exact: true }).click();
  await page.waitForFunction(() => !document.documentElement.classList.contains('dark'));
  await settleAnimations(page);
  await page.screenshot({ path: path.join(screenshots, 'profile-light-1024.png'), scale: 'css' });
  const svg = await context.newPage();
  await svg.goto(base + '/uploads/browser.svg');
  assert.equal(await svg.locator('svg').getAttribute('data-executed'), null, 'CSP deve impedir script do SVG');
  await svg.close();
  await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
  await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
  await page.waitForURL(base + '/login');
  assert.equal((await context.request.get(base + '/uploads/browser.pdf')).status(), 404);
  assert.equal((await context.request.get(base + '/api/auth/me', { headers: { Authorization: `Bearer ${token}` } })).status(), 401);
  const anonymous = await browser.newContext({ viewport: { width: 1024, height: 600 } });
  const publicPage = await anonymous.newPage();
  publicPage.on('pageerror', e => errors.push(e.message));
  await publicPage.goto(base + '/compartilhado/' + share);
  await renderedPdf(publicPage);
  await publicPage.screenshot({ path: path.join(screenshots, 'pdf-shared-1024.png'), scale: 'css' });
  db.prepare('UPDATE share_links SET expires_at = ? WHERE token = ?').run('2000-01-01T00:00:00Z', share);
  await publicPage.reload();
  await publicPage.getByRole('heading', { name: 'Link indisponível' }).waitFor();
  await publicPage.screenshot({ path: path.join(screenshots, 'share-expired-1024.png'), scale: 'css' });
  assert.deepEqual(errors.filter(message => !/Failed to fetch dynamically imported module.*Profile-/.test(message)), []);
  if (metrics.baseline) metrics.reductionPercent = Number(((1 - metrics.current.rawBytes / metrics.baseline.rawBytes) * 100).toFixed(2));
  fs.writeFileSync(path.join(screenshots, 'metrics.json'), JSON.stringify(metrics, null, 2));
  console.log('INITIAL JAVASCRIPT:', JSON.stringify(metrics));
  console.log('BROWSER PASS: cold login budget, lazy library and PDF, header during navigation, failed chunk recovery, authenticated PDF, cookie bootstrap, notebook/mobile width, SVG sandbox, logout revocation, anonymous shared PDF, expired share.');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  if (baselineServer) await new Promise(resolve => baselineServer.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});
