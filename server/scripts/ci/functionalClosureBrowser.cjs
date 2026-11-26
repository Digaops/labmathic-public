// QA de fechamento: somente loopback, banco/uploads sintéticos e build isolado.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const clientRequire = createRequire(path.join(root, 'client/package.json'));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-functional-qa-'));
Object.assign(process.env, { NODE_ENV: 'test', APP_ENV: 'development',
  DB_PATH: path.join(temp, 'synthetic.sqlite'), UPLOAD_DIR: path.join(temp, 'uploads'),
  JWT_SECRET: 'synthetic-functional-browser-secret-only', SMTP_USER: '', SMTP_PASS: '' });
const express = require('express');
const db = require('../../src/database');
const app = express();
app.use(express.json());
for (const route of ['auth', 'users', 'materials', 'share', 'categories', 'favorites', 'ratings', 'comments',
  'notifications', 'support', 'announcements', 'governance', 'reports', 'collections', 'classes']) {
  app.use('/api/' + route, require('../../src/routes/' + route));
}
app.use('/uploads', require('../../src/middleware/protectedUploads'));
app.use('/api', (_req, res) => res.sendStatus(404));
const build = path.resolve(process.argv[2] || path.join(root, 'tmp/functional-close-build'));
app.use(express.static(build));
app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
app.use(require('../../src/middleware/apiErrors'));
const password = 'Synthetic-Functional-Password!';
const hash = require('bcryptjs').hashSync(password, 4);
const account = role => Number(db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)')
  .run('Conta sintética ' + role, role + '@functional.invalid', hash, role).lastInsertRowid);
const admin = account('admin');
const teacher = account('professor');
db.prepare("UPDATE feature_flags SET master_enabled = 1 WHERE flag_key = 'classes.core'").run();
const flagId = db.prepare("SELECT id FROM feature_flags WHERE flag_key = 'classes.core'").get().id;
db.prepare(`INSERT INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason,created_by,updated_by)
  VALUES (?,?,1,'QA sintético',?,?)`).run(flagId, teacher, admin, admin);
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'fixture.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="240" height="80"><rect width="240" height="80" fill="#08254d"/><text x="20" y="45" fill="white">Material de teste</text></svg>');
const material = Number(db.prepare("INSERT INTO materials(title,file_path,file_format,created_by) VALUES (?,'fixture.svg','SVG',?)")
  .run('Geometria sintética', admin).lastInsertRowid);
db.prepare("INSERT INTO materials(title,file_path,file_format,created_by) VALUES (?,'fixture.svg','SVG',?)").run('Álgebra sintética', admin);
const output = path.join(root, 'tmp/functional-close-qa');
fs.mkdirSync(output, { recursive: true });
let browser;
let server;
let base;
const errors = [];
const { chromium, expect } = clientRequire('@playwright/test');
async function context(role, options = {}) {
  const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 }, colorScheme: 'dark', ...options });
  await ctx.route('https://fonts.googleapis.com/**', route => route.abort());
  await ctx.route('https://fonts.gstatic.com/**', route => route.abort());
  const page = await ctx.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(base + '/login');
  await page.getByLabel('E-mail', { exact: true }).fill(role + '@functional.invalid');
  await page.getByLabel('Senha', { exact: true }).fill(password);
  const announcement = role === 'professor'
    ? page.waitForResponse(response => new URL(response.url()).pathname === '/api/announcements/current') : null;
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await page.waitForURL(base + '/');
  if (announcement && (await (await announcement).json()).announcement) await page.getByRole('button', { name: 'Entendi, continuar', exact: true }).click();
  return { ctx, page };
}
async function capture(page, name, region) {
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, 'overflow horizontal');
  if (region) await region.scrollIntoViewIfNeeded();
  await page.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
}
async function search(page, text) {
  await page.getByPlaceholder('Buscar por título, palavra-chave ou descrição...').fill(text);
  await page.getByRole('button', { name: 'Buscar', exact: true }).click();
}
const countLinks = () => db.prepare('SELECT COUNT(*) FROM share_links WHERE material_id = ?').pluck().get(material);
(async () => {
  server = await new Promise(resolve => { const instance = app.listen(0, '127.0.0.1', () => resolve(instance)); });
  base = `http://127.0.0.1:${server.address().port}`;
  assert.equal((await fetch(base + '/login')).status, 200);
  browser = await chromium.launch({ headless: true });
  const { ctx, page } = await context('professor');
  await page.goto(base + '/biblioteca');
  await expect(page.getByRole('heading', { name: 'Geometria sintética' })).toBeVisible();
  let releaseOld;
  let arrivedOld;
  const oldRequest = new Promise(resolve => { arrivedOld = resolve; });
  await page.route('**/api/materials?**', async route => {
    if (new URL(route.request().url()).searchParams.get('search') === 'Geometria') {
      const response = await route.fetch();
      arrivedOld();
      await new Promise(resolve => { releaseOld = resolve; });
      await route.fulfill({ response }).catch(() => {});
    } else await route.continue();
  });
  await search(page, 'Geometria'); await oldRequest;
  await search(page, 'Álgebra');
  await expect(page.getByRole('heading', { name: 'Álgebra sintética' })).toBeVisible();
  releaseOld(); await page.waitForTimeout(350);
  await expect(page.getByRole('heading', { name: 'Geometria sintética' })).toHaveCount(0);
  await page.unroute('**/api/materials?**');
  await page.route('**/api/materials?**', route => route.fulfill({ status: 503, json: { error: 'synthetic' } }));
  await search(page, 'Geometria');
  await expect(page.getByText('Sua busca e seus filtros foram mantidos.', { exact: false })).toBeVisible();
  await capture(page, 'library-error-dark-1024', page.getByRole('button', { name: 'Tentar novamente', exact: true }));
  await page.unroute('**/api/materials?**');
  await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Geometria sintética' })).toBeVisible();
  await page.route('**/api/categories/topics', route => route.fulfill({ status: 503, json: {} }));
  await page.reload();
  await expect(page.getByRole('button', { name: 'Recarregar filtros' })).toBeVisible();
  await page.unroute('**/api/categories/topics');
  await page.getByRole('button', { name: 'Recarregar filtros' }).click();
  await expect(page.getByRole('button', { name: 'Recarregar filtros' })).toHaveCount(0);
  await page.clock.install();
  await page.goto(base + '/turmas');
  await page.getByRole('button', { name: 'Criar turma', exact: true }).click();
  const field = page.getByPlaceholder('Ex.: 7º A — Matemática');
  await field.fill('7º A — rascunho preservado');
  await page.route('**/api/governance/features?**', route => route.fulfill({ status: 503, json: {} }));
  await page.clock.fastForward(61_000);
  await expect(page.getByText('Conexão instável:', { exact: false })).toBeAttached();
  await expect(field).toHaveValue('7º A — rascunho preservado');
  await capture(page, 'class-form-preserved-1024');
  await page.unroute('**/api/governance/features?**');
  await page.clock.fastForward(121_000);
  await expect(page.getByText('Conexão instável:', { exact: false })).toHaveCount(0);
  await expect(field).toHaveValue('7º A — rascunho preservado');
  await page.getByRole('button', { name: 'Cancelar', exact: true }).click();
  db.prepare('UPDATE feature_flags SET master_enabled = 0 WHERE id = ?').run(flagId);
  await page.clock.fastForward(61_000);
  await page.waitForURL(base + '/');
  // Primeira consulta indisponível não redireciona silenciosamente nem abre o formulário.
  await page.route('**/api/governance/features?**', route => route.fulfill({ status: 503, json: {} }));
  await page.goto(base + '/turmas');
  await expect(page.getByRole('heading', { name: 'Não foi possível confirmar a disponibilidade' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Criar turma', exact: true })).toHaveCount(0);
  await capture(page, 'feature-unavailable-1024');
  await ctx.close();

  const managed = await context('admin');
  const adminPage = managed.page;
  // Legacy administration dialogs now share focus/scroll lifecycle.
  for (const width of [1024, 390]) {
    await adminPage.setViewportSize({ width, height: 600 });
    await adminPage.goto(base + '/admin/usuarios');
    const createUser = adminPage.getByRole('button', { name: 'Novo usuário', exact: true });
    await createUser.click();
    const userDialog = adminPage.getByRole('dialog', { name: 'Novo usuário', exact: true });
    await expect(userDialog).toBeFocused();
    await adminPage.keyboard.press('Shift+Tab');
    await expect(userDialog.getByRole('button', { name: 'Criar usuário', exact: true })).toBeFocused();
    await adminPage.keyboard.press('Tab');
    await expect(userDialog.getByRole('button', { name: 'Fechar modal', exact: true })).toBeFocused();
    const firstInput = userDialog.locator('input').first();
    await firstInput.fill('Rascunho sintético');
    await expect(firstInput).toBeFocused();
    const box = await userDialog.boundingBox();
    assert.ok(box.y >= 0 && box.y + box.height <= 601);
    await capture(adminPage, `admin-user-modal-dark-${width}`);
    await adminPage.keyboard.press('Escape');
    await expect(createUser).toBeFocused();
    await adminPage.goto(base + '/colecoes');
    await adminPage.getByRole('button', { name: /Novo laboratório/i }).first().click();
    const laboratoryDialog = adminPage.getByRole('dialog', { name: 'Novo Laboratório', exact: true });
    await expect(laboratoryDialog).toBeFocused();
    await capture(adminPage, `laboratory-modal-dark-${width}`);
    await adminPage.keyboard.press('Escape');
    assert.equal(await adminPage.evaluate(() => document.body.style.overflow), '');
    assert.equal(await adminPage.locator('[inert]').count(), 0);
  }
  await adminPage.setViewportSize({ width: 1024, height: 600 });
  await managed.ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
  await adminPage.goto(base + '/material/' + material);
  await adminPage.getByRole('button', { name: 'Compartilhar', exact: true }).click();
  const panel = adminPage.getByRole('region', { name: 'Gerenciar compartilhamentos' });
  await expect(panel.getByText('Nenhum link ativo nesta página.')).toBeVisible();
  assert.equal(countLinks(), 0);
  await panel.getByRole('button', { name: 'Fechar compartilhamentos' }).click();
  await adminPage.getByRole('button', { name: 'Compartilhar', exact: true }).click();
  await panel.getByLabel('Validade do novo link').selectOption('24');
  await panel.getByRole('button', { name: 'Criar link', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Revogar link', exact: true })).toBeVisible();
  assert.equal(countLinks(), 1);
  await panel.getByRole('button', { name: /Copiar link/ }).click();
  await expect(panel.getByText('Link copiado.')).toBeVisible();
  const address = await panel.getByRole('textbox').inputValue();
  const token = address.split('/').pop();
  assert.equal(await adminPage.evaluate(() => navigator.clipboard.readText()), address);
  await adminPage.evaluate(() => {
    window.originalClipboardWrite = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async () => { throw new Error('synthetic clipboard unavailable'); };
  });
  await panel.getByRole('button', { name: /Copiar link/ }).click();
  await expect(panel.getByText('Não foi possível copiar.', { exact: false })).toBeVisible();
  await expect(panel.getByRole('textbox')).toHaveValue(address);
  await adminPage.evaluate(() => { navigator.clipboard.writeText = window.originalClipboardWrite; });
  await panel.getByRole('button', { name: /Copiar link/ }).click();
  assert.equal((await fetch(base + '/api/share/' + token)).status, 200);
  assert.equal((await fetch(base + '/uploads/fixture.svg?share=' + token)).status, 200);
  await panel.getByRole('button', { name: 'Revogar link', exact: true }).click();
  await capture(adminPage, 'share-confirm-dark-1024', panel);
  await panel.getByRole('button', { name: 'Cancelar', exact: true }).click();
  assert.equal(countLinks(), 1);
  await panel.getByRole('button', { name: 'Revogar link', exact: true }).click();
  await panel.getByRole('button', { name: 'Confirmar revogação', exact: true }).click();
  await expect(panel.getByText('Nenhum link ativo nesta página.')).toBeVisible();
  assert.equal((await fetch(base + '/api/share/' + token)).status, 404);
  assert.equal((await fetch(base + '/uploads/fixture.svg?share=' + token)).status, 404);
  await adminPage.route('**/api/share', async route => {
    assert.equal(route.request().method(), 'POST');
    await route.fetch(); await route.abort();
  });
  await panel.getByRole('button', { name: 'Criar link', exact: true }).click();
  await expect(panel.getByText('Não foi possível confirmar a operação.', { exact: false })).toBeVisible();
  assert.equal(countLinks(), 1);
  await expect(panel.getByRole('button', { name: 'Criar link', exact: true })).toBeDisabled();
  await adminPage.unroute('**/api/share');
  await panel.getByRole('button', { name: 'Atualizar lista', exact: true }).click();
  await expect(panel.getByRole('button', { name: 'Revogar link', exact: true })).toBeVisible();
  assert.equal(countLinks(), 1);
  const addLink = db.prepare('INSERT INTO share_links(material_id,created_by,token,expires_at) VALUES (?,?,?,?)');
  for (let index = 0; index < 21; index += 1) addLink.run(material, admin,
    require('node:crypto').randomBytes(32).toString('hex'), new Date(Date.now() + 86_400_000).toISOString());
  await panel.getByRole('button', { name: 'Atualizar lista', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(20);
  await panel.getByRole('button', { name: 'Ver links anteriores', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Atualizar lista', exact: true }).click();
  await expect(panel.getByRole('listitem')).toHaveCount(20);
  for (const theme of ['light', 'dark']) {
    // Estado visual preparado; ações de criação/cópia/revogação foram feitas pelos controles.
    await adminPage.evaluate(value => document.documentElement.classList.toggle('dark', value === 'dark'), theme);
    for (const width of [1024, 390]) {
      await adminPage.setViewportSize({ width, height: width === 390 ? 844 : 600 });
      await capture(adminPage, `share-${theme}-${width}`, panel);
    }
  }
  await adminPage.goto(base + '/biblioteca');
  const until = Date.now() + 30_000;
  let cycles = 0;
  while (Date.now() < until) {
    await search(adminPage, cycles % 2 ? 'Geometria' : 'Álgebra');
    await expect(adminPage.getByRole('heading', { name: cycles % 2 ? 'Geometria sintética' : 'Álgebra sintética' })).toBeVisible();
    await adminPage.getByRole('button', { name: 'Filtros', exact: true }).click();
    if (cycles === 0) await capture(adminPage, 'filters-mobile', adminPage.getByRole('dialog', { name: 'Filtros do acervo' }));
    await adminPage.keyboard.press('Tab');
    await adminPage.keyboard.press('Shift+Tab');
    if (cycles % 2) await adminPage.keyboard.press('Escape');
    else await adminPage.getByRole('button', { name: 'Fechar filtros', exact: true }).click();
    await expect(adminPage.getByRole('dialog', { name: 'Filtros do acervo' })).toHaveCount(0);
    cycles += 1;
  }
  assert.deepEqual(errors, []);
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify({ status: 'passed', exploratoryCycles: cycles,
    checks: ['search-race', 'search-failure', 'category-retry', 'form-preserved', 'confirmed-disable',
      'first-load-failure', 'share-management', 'share-pagination', 'lost-write-ack', 'clipboard', 'responsive-themes',
      'admin-dialog-focus-scroll', 'laboratory-dialog-focus-scroll'], pageErrors: errors }, null, 2));
  console.log('FUNCTIONAL CLOSURE PASS; exploratory cycles:', cycles);
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (server) await new Promise(resolve => server.close(resolve));
  db.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.ok(path.basename(resolved).startsWith('labmathic-functional-qa-'));
  fs.rmSync(resolved, { recursive: true, force: true });
});
