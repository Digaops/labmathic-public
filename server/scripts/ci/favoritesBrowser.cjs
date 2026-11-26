const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runFavoritesBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, materialId, db, output }) {
  assert.equal(process.env.FAVORITES_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [], queries: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Favoritos:', description); };
  const browser = await chromium.launch({ headless: true }); const contexts = [];
  const view = page => page.locator('[data-favorites]');
  const rows = page => page.locator('[data-favorites-materials] > a');
  const heading = page => view(page).getByRole('heading', { level: 2 });
  const pager = page => page.getByRole('navigation', { name: 'Páginas de favoritos', exact: true });
  async function context(user = teacher, width = 390, height = 664, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(ctx);
    ctx.on('response', async response => { if (!response.url().startsWith(baseUrl + '/api/favorites?')) return;
      const payload = await response.json().catch(() => ({})); report.queries.push({ initialUserId: user.id, url: response.url().slice(baseUrl.length), status: response.status(), pagination: payload.pagination, error: payload.error }); });
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => { if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message))); return ctx;
  }
  async function go(page, url = '/favoritos', idle = true) {
    await page.goto(baseUrl + url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(550);
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle'); await page.waitForTimeout(250);
  }
  async function capture(page, id, initial = false) {
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => { const box = e => { const r = e?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
      const first = document.querySelector('[data-favorites-materials] > a');
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        title: box(first?.querySelector('h3')), action: box(first?.lastElementChild?.lastElementChild),
        controls: [...document.querySelectorAll('[data-favorites] a,[data-favorites] button')].filter(e => e.getClientRects().length).map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim(), ...box(e) })) }; });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record(); assert.ok(metrics.scrollWidth <= metrics.width, id + ': no horizontal overflow');
    if (initial) { assert.equal(metrics.scrollY, 0); assert.ok(metrics.title?.y > 108 && metrics.title?.bottom < metrics.height, id + ': title in first viewport'); assert.ok(metrics.action?.bottom <= metrics.height, id + ': action in first viewport'); }
    for (const item of metrics.controls) { assert.ok(item.height >= 44 && item.width >= 44, id + ': touch target ' + item.label); assert.ok(item.x >= 0 && item.right <= metrics.width + 1, id + ': target bounds ' + item.label); }
  }
  async function expectPage(page, number, count) {
    await expect(page).toHaveURL(new RegExp(number === 1 ? '/favoritos$' : `/favoritos\\?page=${number}$`));
    await expect(rows(page)).toHaveCount(count); await expect(pager(page).getByRole('button', { name: `Ir à página ${number}`, exact: true })).toHaveAttribute('aria-current', 'page');
  }
  try {
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const ctx = await context(teacher, width, height, theme); const page = await ctx.newPage(); await go(page); await expect(rows(page)).toHaveCount(1);
      await expect(heading(page)).toHaveText('1 material salvo'); await capture(page, `favorites-${width}-${theme}`, true);
      await rows(page).first().focus(); await expect(rows(page).first()).toBeFocused();
      await rows(page).first().press('Enter'); await expect(page.locator('[data-pdf-viewer] canvas')).toBeVisible();
      const back = page.getByRole('link', { name: 'Voltar para Favoritos', exact: true }); await expect(back).toBeVisible(); await back.click(); await expect(rows(page)).toHaveCount(1);
      await view(page).getByRole('link', { name: 'Buscar materiais', exact: true }).click(); await expect(page.locator('[data-library-materials]')).toBeVisible(); await ctx.close();
    }
    check('Primeiro material e ação visíveis em 3 resoluções × 2 temas; abrir por teclado, PDF, retorno correto e Biblioteca');

    for (const theme of ['dark', 'light']) {
      const ctx = await context(previewUser, 320, 600, theme); const page = await ctx.newPage(); await go(page);
      await expect(heading(page)).toHaveText('0 materiais salvos'); await expect(view(page).getByText('Você ainda não tem favoritos', { exact: true })).toBeVisible();
      await capture(page, 'empty-' + theme); await view(page).getByRole('link', { name: 'Buscar materiais', exact: true }).click(); await expect(page.locator('[data-library]')).toBeVisible(); await ctx.close();
    }
    check('Vazio verdadeiro orienta salvar material; conta sem favoritos não recebe favoritos de outra pessoa');

    // More than two pages, deterministic dates and only synthetic material files.
    const typeId = db.prepare('SELECT material_type_id FROM materials WHERE id=?').pluck().get(materialId);
    const add = db.prepare("INSERT INTO materials(title,description,material_type_id,file_path,file_format,created_by) VALUES (?,?,?,'layout-fixture.pdf','PDF',?)");
    db.prepare("UPDATE favorites SET created_at='2026-08-01 10:00:00' WHERE user_id=?").run(teacher.id);
    for (let n = 1; n <= 41; n++) {
      const id = Number(add.run(`Atividade salva ${String(n).padStart(2, '0')}`, 'Material sintético com descrição para conferir o acesso e a leitura.', typeId, admin.id).lastInsertRowid);
      db.prepare('INSERT INTO favorites(user_id,material_id,created_at) VALUES (?,?,?)').run(teacher.id, id, `2026-09-01 10:${String(n).padStart(2, '0')}:00`);
    }
    const adminMaterial = Number(add.run('Favorito exclusivo da administração', 'Material sintético privado na lista de favoritos.', typeId, admin.id).lastInsertRowid);
    db.prepare('INSERT INTO favorites(user_id,material_id) VALUES (?,?)').run(admin.id, adminMaterial);
    const denseCtx = await context(teacher, 320, 600); const dense = await denseCtx.newPage(); await go(dense); await expectPage(dense, 1, 20);
    await expect(heading(dense)).toHaveText('42 materiais salvos'); await capture(dense, 'many-favorites', true);
    await pager(dense).scrollIntoViewIfNeeded(); await capture(dense, 'pagination-320');
    await pager(dense).getByRole('button', { name: 'Próxima', exact: true }).click(); await expectPage(dense, 2, 20); await expect(heading(dense)).toBeFocused();
    const headingY = await heading(dense).evaluate(e => e.getBoundingClientRect().y); assert.ok(headingY >= 108 && headingY < 200);
    const secondPage = await rows(dense).evaluateAll(items => items.map(e => e.getAttribute('href'))); await capture(dense, 'page-two');
    await rows(dense).first().click(); await dense.getByRole('link', { name: 'Voltar para Favoritos', exact: true }).click(); await expectPage(dense, 2, 20);
    assert.deepEqual(await rows(dense).evaluateAll(items => items.map(e => e.getAttribute('href'))), secondPage);
    await dense.reload(); await expectPage(dense, 2, 20); await pager(dense).getByRole('button', { name: 'Ir à página 3', exact: true }).click(); await expectPage(dense, 3, 2);
    await expect(pager(dense).getByRole('button', { name: 'Próxima', exact: true })).toBeDisabled(); await dense.goBack(); await expectPage(dense, 2, 20); await dense.goForward(); await expectPage(dense, 3, 2);
    await pager(dense).getByRole('button', { name: 'Anterior', exact: true }).click(); await expectPage(dense, 2, 20); await pager(dense).getByRole('button', { name: 'Ir à página 1', exact: true }).click(); await expectPage(dense, 1, 20);
    await expect(pager(dense).getByRole('button', { name: 'Anterior', exact: true })).toBeDisabled(); await denseCtx.close();
    check('42 favoritos: páginas numeradas, próxima/anterior, foco/rolagem, retorno à página 2, recarga e histórico do navegador');

    for (const [name, status, payload] of [['offline', 503, {}], ['invalid', 200, {}]]) {
      const ctx = await context(); let fail = true; await ctx.route(/\/api\/favorites\?/, route => fail ? route.fulfill({ status, json: payload }) : route.continue());
      const page = await ctx.newPage(); await go(page, '/favoritos?page=2'); await expect(heading(page)).toHaveText('Não foi possível carregar seus favoritos');
      await expect(view(page)).not.toContainText('0 materiais salvos'); await expect(rows(page)).toHaveCount(0); await capture(page, 'error-' + name);
      fail = false; await view(page).getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expectPage(page, 2, 20); await ctx.close();
    }
    const slowCtx = await context(); let release; let started; const gate = new Promise(resolve => { release = resolve; }); const pending = new Promise(resolve => { started = resolve; });
    await slowCtx.route(/\/api\/favorites\?/, async route => { started(); await gate; await route.continue(); });
    const slow = await slowCtx.newPage(); await go(slow, '/favoritos', false); await pending; await expect(heading(slow)).toHaveText('Carregando seus favoritos…'); await expect(view(slow)).not.toContainText('0 materiais salvos'); await capture(slow, 'loading');
    release(); await expect(rows(slow)).toHaveCount(20); await slowCtx.close();
    const errorCtx = await context(); const errorPage = await errorCtx.newPage(); await go(errorPage); await expectPage(errorPage, 1, 20);
    await errorCtx.route(/\/api\/favorites\?page=2&/, route => route.fulfill({ status: 503, json: {} }));
    await pager(errorPage).getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(heading(errorPage)).toHaveText('Não foi possível carregar seus favoritos'); await expect(rows(errorPage)).toHaveCount(0); await capture(errorPage, 'page-two-error');
    await errorCtx.unroute(/\/api\/favorites\?page=2&/); await view(errorPage).getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expectPage(errorPage, 2, 20); await errorCtx.close();
    check('Carregamento, 503, resposta inválida e falha na segunda página não exibem zero nem lista anterior; repetição conserva a página');

    const beyondCtx = await context(); const beyond = await beyondCtx.newPage(); await go(beyond, '/favoritos?page=9999'); await expect(view(beyond).getByText('Esta página não tem materiais', { exact: true })).toBeVisible();
    await expect(heading(beyond)).toHaveText('42 materiais salvos'); await capture(beyond, 'beyond-last-page'); await view(beyond).getByRole('button', { name: 'Ir à última página disponível', exact: true }).click(); await expectPage(beyond, 3, 2);
    for (const value of ['-1', 'abc', '1.5', '9007199254740991']) { await go(beyond, '/favoritos?page=' + value); await expect(rows(beyond)).toHaveCount(20); await expect(pager(beyond).getByRole('button', { name: 'Ir à página 1', exact: true })).toHaveAttribute('aria-current', 'page'); }
    await beyondCtx.close(); check('Página inexistente mantém total real e oferece última página; URLs inválidas usam primeira página sem loop');

    const editCtx = await context(); const edit = await editCtx.newPage(); await go(edit, '/favoritos?page=3'); await expectPage(edit, 3, 2); const removed = [];
    for (let n = 0; n < 2; n++) {
      removed.push(await rows(edit).first().getAttribute('href')); await rows(edit).first().click(); const remove = edit.getByRole('button', { name: 'Remover dos favoritos', exact: true }); await expect(remove).toBeEnabled(); await remove.click();
      await expect(edit.getByRole('button', { name: 'Salvar nos favoritos', exact: true })).toHaveAttribute('aria-pressed', 'false'); await edit.getByRole('link', { name: 'Voltar para Favoritos', exact: true }).click(); await expect(rows(edit)).toHaveCount(1 - n);
    }
    await expect(view(edit).getByText('Esta página não tem materiais', { exact: true })).toBeVisible(); await expect(heading(edit)).toHaveText('40 materiais salvos'); await capture(edit, 'last-item-removed');
    await view(edit).getByRole('button', { name: 'Ir à última página disponível', exact: true }).click(); await expectPage(edit, 2, 20);
    assert.equal(db.prepare('SELECT COUNT(*) FROM favorites WHERE user_id=?').pluck().get(teacher.id), 40);
    assert.equal(db.prepare('SELECT COUNT(*) FROM favorites WHERE user_id=?').pluck().get(admin.id), 1);
    await go(edit, removed[0]); await edit.getByRole('button', { name: 'Salvar nos favoritos', exact: true }).click(); await expect(edit.getByRole('button', { name: 'Remover dos favoritos', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await go(edit); await expect(rows(edit).first()).toHaveAttribute('href', removed[0]); await expect(heading(edit)).toHaveText('41 materiais salvos'); await editCtx.close();
    check('Remover últimos itens e restaurar favorito por ações reais atualiza lista; demais materiais e favoritos administrativos preservados');

    const lateCtx = await context(); let releaseLate; let startLate; const lateGate = new Promise(resolve => { releaseLate = resolve; }); const lateStarted = new Promise(resolve => { startLate = resolve; });
    await lateCtx.route(/\/api\/favorites\?page=2&/, async route => { const response = await route.fetch(); startLate(); await lateGate; await route.fulfill({ response }).catch(() => {}); });
    const late = await lateCtx.newPage(); await go(late); await expect(rows(late)).toHaveCount(20); const firstPage = await rows(late).evaluateAll(items => items.map(e => e.getAttribute('href')));
    await pager(late).getByRole('button', { name: 'Próxima', exact: true }).click(); await lateStarted; await late.goBack(); await expectPage(late, 1, 20); releaseLate(); await late.waitForTimeout(350);
    assert.deepEqual(await rows(late).evaluateAll(items => items.map(e => e.getAttribute('href'))), firstPage); await lateCtx.close();
    const adminCtx = await context(admin, 1024, 600, 'light'); const adminPage = await adminCtx.newPage(); await go(adminPage); await expect(rows(adminPage)).toHaveCount(1); await expect(rows(adminPage).first()).toContainText('Favorito exclusivo da administração'); await capture(adminPage, 'admin-own-favorites', true); await adminCtx.close();
    check('Resposta tardia de outra página descartada; administrador consulta apenas seus favoritos');

    const password = 'Favorites-fixture-only-9!'; db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 4), previewUser.id);
    const switchCtx = await context(); let releaseOld; let startOld; const oldGate = new Promise(resolve => { releaseOld = resolve; }); const oldStarted = new Promise(resolve => { startOld = resolve; }); let hold = true;
    await switchCtx.route(/\/api\/favorites\?/, async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); startOld(); await oldGate; await route.fulfill({ response }).catch(() => {}); });
    const switched = await switchCtx.newPage(); await go(switched, '/favoritos', false); await oldStarted;
    await switched.getByRole('button', { name: 'Menu do usuário', exact: true }).click(); await switched.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await switched.getByLabel('E-mail', { exact: true }).fill(previewUser.email); await switched.getByLabel('Senha', { exact: true }).fill(password); await switched.getByRole('button', { name: 'Entrar no sistema', exact: true }).click(); await expect(switched).toHaveURL(baseUrl + '/');
    await switched.waitForTimeout(600); const notice = switched.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    await switched.locator('[data-teacher-home] a[href="/favoritos"]').first().click(); await expect(heading(switched)).toHaveText('0 materiais salvos'); releaseOld(); await switched.waitForTimeout(350); await expect(rows(switched)).toHaveCount(0); await capture(switched, 'account-switched'); await switchCtx.close();
    check('Logout/login reais durante consulta não exibem favoritos da conta anterior');

    const longId = db.prepare('SELECT material_id FROM favorites WHERE user_id=? ORDER BY created_at DESC LIMIT 1').pluck().get(teacher.id);
    db.prepare('UPDATE materials SET title=?,description=? WHERE id=?').run('Estratégias de resolução de problemas para conversar, comparar e registrar o raciocínio em sala de aula', 'Descrição detalhada. '.repeat(100), longId);
    const longCtx = await context(teacher, 320, 600); const long = await longCtx.newPage(); await go(long); await expect(rows(long)).toHaveCount(20); await capture(long, 'long-title-320', true);
    await rows(long).first().focus(); await capture(long, 'keyboard-focus'); await long.setViewportSize({ width: 1024, height: 600 }); await capture(long, 'resized-desktop'); await longCtx.close();
    const exploreCtx = await context(); const explore = await exploreCtx.newPage(); await go(explore);
    const start = Date.now(); while (Date.now() - start < 30000) { await explore.keyboard.press('Tab'); await explore.mouse.wheel(0, 140); await explore.waitForTimeout(650); }
    await capture(explore, 'exploration'); await exploreCtx.close(); check('Nome longo, foco, resize e exploração de teclado/rolagem por 30 segundos');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack;
    for (const ctx of contexts) for (const page of ctx.pages()) {
      await page.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {});
      report.lastPage = { url: page.url(), text: await page.locator('body').innerText().catch(() => '') };
    }
    record(); throw error;
  }
  finally { for (const ctx of contexts) await ctx.close().catch(() => {}); await browser.close(); }
}
module.exports = { runFavoritesBrowser };
