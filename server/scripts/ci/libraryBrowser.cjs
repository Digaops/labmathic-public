const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runLibraryBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, materialId, db, output }) {
  assert.equal(process.env.LIBRARY_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Biblioteca:', description); };
  const browser = await chromium.launch({ headless: true }); const contexts = [];
  const library = page => page.locator('[data-library]');
  const rows = page => page.locator('[data-library-materials] > a');
  const filters = page => library(page).getByRole('button', { name: /^Filtros/ });
  const results = page => page.getByRole('region', { name: 'Resultados da biblioteca', exact: true });
  async function context(user = teacher, width = 390, height = 664, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme,
      ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(ctx);
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('theme', theme);
      sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
    return ctx;
  }
  async function ready(page, suffix = '', idle = true) {
    await page.goto(baseUrl + '/biblioteca' + suffix, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(550);
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
    if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle');
    await page.waitForTimeout(350);
  }
  async function capture(page, id, initial = false) {
    await page.waitForTimeout(300);
    const metrics = await page.evaluate(() => {
      const box = element => { const r = element?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
      const first = document.querySelector('[data-library-materials] > a');
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        title: box(first?.querySelector('h3')), action: box(first?.lastElementChild?.lastElementChild),
        controls: [...document.querySelectorAll('[data-library] button,[data-library] input,[data-library] select,[data-library-materials]>a,[data-library-drawer] button,[data-library-drawer] select')]
          .filter(e => e.getClientRects().length && !e.closest('[inert]')).map(e => ({ text: e.getAttribute('aria-label') || e.textContent.trim(), ...box(e) })) };
    });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' });
    fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record();
    assert.ok(metrics.scrollWidth <= metrics.width, id + ': no horizontal overflow');
    for (const item of metrics.controls) {
      assert.ok(item.height >= 44 && item.width >= 24, id + ': usable target ' + item.text);
      assert.ok(item.x >= 0 && item.right <= metrics.width + 1, id + ': horizontal bounds ' + item.text);
    }
    if (initial) {
      assert.equal(metrics.scrollY, 0);
      assert.ok(metrics.title?.y >= 108 && metrics.title.bottom <= metrics.height, id + ': first title above fold');
      assert.ok(metrics.action?.bottom <= metrics.height, id + ': first action above fold');
    }
  }
  async function search(page, text, enter = false) {
    await page.getByLabel('Buscar material', { exact: true }).fill(text);
    if (enter) await page.getByLabel('Buscar material', { exact: true }).press('Enter');
    else await library(page).getByRole('button', { name: 'Buscar', exact: true }).click();
    await expect(page).toHaveURL(url => url.searchParams.get('search') === text.trim());
    await expect(results(page)).toHaveAttribute('aria-busy', 'false');
  }
  try {
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const ctx = await context(teacher, width, height, theme); const page = await ctx.newPage(); await ready(page);
      await expect(rows(page).first()).toBeVisible(); await capture(page, `library-${width}-${theme}`, true);
      assert.equal(await library(page).getByRole('heading', { name: 'Biblioteca', exact: true }).evaluate(e => getComputedStyle(e).color), theme === 'light' ? 'rgb(15, 23, 42)' : 'rgb(255, 255, 255)');
      assert.equal(await page.getByLabel('Ordenar materiais').evaluate(e => getComputedStyle(e).colorScheme), theme);
      if (width === 1024) {
        await page.getByLabel('Ordenar materiais').click(); await capture(page, `sort-options-${theme}`);
        await page.keyboard.press('Escape');
      }
      await ctx.close();
    }
    check('Busca, primeiro título e ação visíveis em 3 resoluções × 2 temas');

    const ctx = await context(teacher, 1024, 600); const page = await ctx.newPage(); await ready(page);
    await filters(page).click(); await expect(page.getByRole('complementary', { name: 'Filtros da biblioteca' })).toBeVisible();
    await page.waitForTimeout(300); await expect(filters(page)).toHaveAttribute('aria-expanded', 'true');
    await capture(page, 'desktop-filters');
    const original = db.prepare('SELECT * FROM materials WHERE id=?').get(materialId);
    const topicId = Number(db.prepare("INSERT INTO topics(name) VALUES ('Assunto da inspeção da Biblioteca')").run().lastInsertRowid);
    db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(materialId, topicId);
    await ready(page); await filters(page).click();
    for (const [label, value, key] of [['Disciplina', original.discipline_id, 'discipline_id'], ['Ano escolar', original.grade_id, 'grade_id'],
      ['Tipo de material', original.material_type_id, 'material_type_id'], ['Assunto', topicId, 'topic_id'], ['Formato do arquivo', 'PDF', 'file_format']]) {
      const select = page.getByLabel(label, { exact: true }); await select.focus(); await select.selectOption(String(value));
      await expect(select).toBeFocused();
      await expect(page).toHaveURL(new RegExp(`${key}=${value}`));
      await expect(results(page)).toHaveAttribute('aria-busy', 'false');
      if (key === 'topic_id' || key === 'material_type_id') await expect(rows(page)).toHaveCount(1);
      else await expect(rows(page)).toHaveCount(2);
      await library(page).getByRole('button', { name: new RegExp('^Remover ' + label + ':') }).click();
      await expect(select).toHaveValue('');
    }
    await page.getByLabel('Ano escolar', { exact: true }).selectOption('mine');
    await expect(page.getByText(/Usa os anos escolhidos no seu perfil/)).toBeVisible();
    await page.getByRole('button', { name: 'Limpar busca e filtros', exact: true }).click();
    await filters(page).click(); await expect(page.getByRole('complementary', { name: 'Filtros da biblioteca' })).toHaveCount(0);
    check('Painel desktop permanece aberto; cinco filtros, remoção e Meus anos preservados');

    await search(page, 'Problemas', true); await expect(rows(page)).toHaveCount(1);
    await page.getByLabel('Ordenar materiais').selectOption('title_asc');
    const consultation = page.url();
    await rows(page).first().click(); await expect(page).toHaveURL(baseUrl + '/material/' + materialId);
    await expect(page.locator('canvas').first()).toBeVisible();
    await page.getByRole('link', { name: 'Voltar para Biblioteca', exact: true }).first().click();
    await expect(page).toHaveURL(consultation); await expect(page.getByLabel('Buscar material', { exact: true })).toHaveValue('Problemas');
    await page.reload(); await expect(page.getByLabel('Ordenar materiais')).toHaveValue('title_asc');
    await search(page, 'Caderno'); await expect(rows(page)).toHaveCount(1); await expect(rows(page).first()).toContainText('Caderno');
    await page.goBack(); await expect(page).toHaveURL(consultation); await expect(page.getByLabel('Buscar material', { exact: true })).toHaveValue('Problemas');
    await page.goForward(); await expect(page).toHaveURL(/search=Caderno/); await expect(page.getByLabel('Buscar material', { exact: true })).toHaveValue('Caderno');
    await library(page).getByRole('button', { name: /^Remover Busca:/ }).click(); await expect(page.getByLabel('Buscar material', { exact: true })).toHaveValue('');
    for (const value of ['oldest', 'title_desc', 'most_viewed', 'best_rated', 'recent']) {
      await page.getByLabel('Ordenar materiais').selectOption(value); await expect(results(page)).toHaveAttribute('aria-busy', 'false'); await expect(rows(page).first()).toBeVisible();
    }
    await search(page, 'sem-resultado-fixture'); await expect(results(page)).toContainText('Nenhum material encontrado'); await capture(page, 'empty-search');
    await library(page).getByRole('button', { name: 'Limpar busca e filtros', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
    await ctx.close(); check('Busca, ordenação, vazio, PDF e retorno preservam consulta; voltar/avançar e recarga funcionam');

    const mobileCtx = await context(teacher, 320, 600); const mobile = await mobileCtx.newPage(); await ready(mobile);
    await filters(mobile).click(); const dialog = mobile.getByRole('dialog', { name: 'Filtrar materiais' });
    await expect(dialog).toBeVisible(); assert.equal(await mobile.evaluate(() => document.body.style.overflow), 'hidden');
    await capture(mobile, 'mobile-filters');
    await mobile.keyboard.press('Tab'); await expect(dialog.getByRole('button', { name: 'Fechar filtros' })).toBeFocused();
    await mobile.keyboard.press('Shift+Tab'); await expect(dialog.getByRole('button', { name: 'Ver resultados' })).toBeFocused();
    const format = mobile.getByLabel('Formato do arquivo', { exact: true });
    await format.focus(); await format.press('Home'); await format.press('ArrowDown');
    await expect(format).toHaveValue('PDF'); await expect(format).toBeFocused();
    await expect(dialog.getByRole('status')).toContainText('materiais encontrados');
    await capture(mobile, 'mobile-filters-selected');
    const lastField = await format.boundingBox(); const footer = await dialog.getByRole('button', { name: 'Ver resultados' }).boundingBox();
    assert.ok(lastField.y + lastField.height < footer.y, 'Focused field is fully above the footer');
    await dialog.getByRole('button', { name: 'Limpar busca e filtros', exact: true }).scrollIntoViewIfNeeded();
    await capture(mobile, 'mobile-filters-bottom');
    await dialog.getByRole('button', { name: 'Ver resultados' }).click(); await expect(dialog).toHaveCount(0); await expect(filters(mobile)).toBeFocused();
    assert.notEqual(await mobile.evaluate(() => document.body.style.overflow), 'hidden');
    await filters(mobile).click(); await mobile.keyboard.press('Escape'); await expect(filters(mobile)).toBeFocused();
    await filters(mobile).click(); await dialog.getByRole('button', { name: 'Fechar filtros' }).click();
    await filters(mobile).click(); await mobile.mouse.click(4, 200); await expect(dialog).toHaveCount(0);
    await filters(mobile).click(); await mobile.setViewportSize({ width: 1024, height: 600 }); await expect(dialog).toHaveCount(0);
    assert.notEqual(await mobile.evaluate(() => document.body.style.overflow), 'hidden');
    await filters(mobile).click(); await expect(mobile.getByRole('complementary', { name: 'Filtros da biblioteca' })).toBeVisible();
    await mobile.setViewportSize({ width: 320, height: 600 }); await expect(filters(mobile)).toHaveAttribute('aria-expanded', 'false');
    await library(mobile).getByRole('button', { name: 'Limpar tudo', exact: true }).click();
    await mobile.getByLabel('Buscar material', { exact: true }).focus(); await mobile.keyboard.press('Tab'); await capture(mobile, 'keyboard-focus');
    await mobileCtx.close(); check('Diálogo móvel: rolagem, foco, Tab, quatro formas de fechar e resize liberam o fundo');
    const lightCtx = await context(teacher, 390, 664, 'light'); const light = await lightCtx.newPage(); await ready(light); await filters(light).click();
    await capture(light, 'mobile-filters-light'); await lightCtx.close();

    for (const invalid of [false, true]) {
      const errorCtx = await context(); let fail = true;
      await errorCtx.route(/\/api\/materials\?/, route => fail ? route.fulfill({ status: invalid ? 200 : 503, json: invalid ? {} : { error: 'Falha sintética' } }) : route.continue());
      const errorPage = await errorCtx.newPage(); await ready(errorPage, '?search=Problemas');
      await expect(results(errorPage).getByRole('alert')).toBeVisible(); await expect(results(errorPage)).not.toContainText('Nenhum material encontrado');
      await expect(rows(errorPage)).toHaveCount(0); await capture(errorPage, invalid ? 'invalid-response' : 'materials-error');
      fail = false; await results(errorPage).getByRole('button', { name: 'Tentar novamente' }).click();
      await expect(rows(errorPage)).toHaveCount(1); await expect(errorPage.getByLabel('Buscar material', { exact: true })).toHaveValue('Problemas'); await errorCtx.close();
    }
    check('HTTP 503 e HTTP 200 inválido não viram lista vazia; tentar novamente preserva busca');

    const categoryCtx = await context(); let failedCategory = true;
    await categoryCtx.route(/\/api\/categories\/disciplines$/, route => failedCategory ? route.fulfill({ status: 503, json: {} }) : route.continue());
    const categoryPage = await categoryCtx.newPage(); await ready(categoryPage); await expect(rows(categoryPage)).toHaveCount(2);
    await filters(categoryPage).click(); await expect(categoryPage.getByLabel('Disciplina', { exact: true })).toBeDisabled();
    await expect(categoryPage.getByLabel('Ano escolar', { exact: true })).toBeEnabled(); await capture(categoryPage, 'category-error');
    failedCategory = false; await categoryPage.getByRole('button', { name: 'Recarregar Disciplina' }).click(); await expect(categoryPage.getByLabel('Disciplina', { exact: true })).toBeEnabled(); await categoryCtx.close();
    const slowCtx = await context(); let releaseCategory;
    const categoryGate = new Promise(resolve => { releaseCategory = resolve; });
    await slowCtx.route(/\/api\/categories\/topics$/, async route => { await categoryGate; await route.continue().catch(() => {}); });
    const slow = await slowCtx.newPage(); await ready(slow, '', false); await expect(rows(slow)).toHaveCount(2);
    await filters(slow).click(); await expect(slow.getByLabel('Assunto', { exact: true })).toBeDisabled(); await capture(slow, 'category-loading');
    releaseCategory(); await expect(slow.getByLabel('Assunto', { exact: true })).toBeEnabled(); await slowCtx.close();
    check('Categorias com erro ou lentas não bloqueiam materiais nem os demais filtros');

    const raceCtx = await context(); let releaseOld; let startedOld;
    const gate = new Promise(resolve => { releaseOld = resolve; }); const started = new Promise(resolve => { startedOld = resolve; });
    await raceCtx.route(/\/api\/materials\?/, async route => {
      if (new URL(route.request().url()).searchParams.get('search') !== 'Problemas') return route.continue();
      const response = await route.fetch(); startedOld(); await gate; await route.fulfill({ response }).catch(() => {});
    });
    const race = await raceCtx.newPage(); await ready(race); await race.getByLabel('Buscar material', { exact: true }).fill('Problemas');
    await library(race).getByRole('button', { name: 'Buscar', exact: true }).click(); await started;
    await expect(rows(race)).toHaveCount(0); await search(race, 'Caderno'); await expect(rows(race)).toHaveCount(1); releaseOld();
    await race.waitForTimeout(400); await expect(rows(race).first()).toContainText('Caderno'); await capture(race, 'newest-query-wins'); await raceCtx.close();
    check('Resposta antiga atrasada não substitui os resultados da busca mais recente');

    const denseTitle = 'Atividade 01 — Resolução de problemas com diferentes estratégias para conversar e aprender em sala de aula';
    for (let i = 1; i <= 15; i++) db.prepare(`INSERT INTO materials(title,description,discipline_id,grade_id,file_path,file_format,material_type_id,created_by)
      VALUES (?,?,?,?,?,?,?,?)`).run(i === 1 ? denseTitle : `Atividade ${String(i).padStart(2, '0')} — Biblioteca de teste`, 'Material somente para validação isolada.', original.discipline_id, original.grade_id, original.file_path, original.file_format, original.material_type_id, admin.id);
    const denseCtx = await context(teacher, 320, 600); const dense = await denseCtx.newPage(); await ready(dense, '?sort=title_asc');
    await expect(rows(dense)).toHaveCount(12); await capture(dense, 'dense-long-title', true);
    await dense.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(dense).toHaveURL(/page=2/); await expect(rows(dense)).toHaveCount(5);
    await expect(results(dense).getByRole('heading').first()).toBeFocused(); await capture(dense, 'page-two');
    const pageTwo = dense.url(); await rows(dense).first().click(); await expect(dense.locator('canvas').first()).toBeVisible();
    await dense.getByRole('link', { name: 'Voltar para Biblioteca', exact: true }).first().click(); await expect(dense).toHaveURL(pageTwo); await expect(rows(dense)).toHaveCount(5);
    await dense.reload(); await expect(dense.getByText('Página 2 de 2', { exact: true })).toBeVisible();
    await dense.getByRole('button', { name: 'Anterior', exact: true }).click(); await expect(rows(dense)).toHaveCount(12);
    await ready(dense, '?page=999'); await expect(dense.getByText('Esta página não tem materiais', { exact: true })).toBeVisible();
    await dense.getByRole('button', { name: 'Ir à primeira página' }).click(); await expect(rows(dense)).toHaveCount(12);
    await ready(dense, '?discipline_id=999999'); await expect(dense.getByRole('button', { name: /Remover Disciplina: Opção selecionada/ })).toBeVisible(); await capture(dense, 'unknown-filter');
    const filterBounds = await filters(dense).boundingBox(); const sortBounds = await dense.getByLabel('Ordenar materiais').boundingBox();
    assert.equal(filterBounds.y, sortBounds.y, 'Active count does not push sort onto another row at 320px');
    await dense.getByRole('button', { name: 'Limpar tudo', exact: true }).click(); await expect(rows(dense)).toHaveCount(12);
    await denseCtx.close(); check('Densidade, nome longo, paginação, retorno à página 2 e filtro antigo têm saída clara');

    const adminCtx = await context(admin, 1024, 600, 'light'); const adminPage = await adminCtx.newPage(); await ready(adminPage); await filters(adminPage).click();
    await expect(adminPage.getByLabel('Ano escolar', { exact: true }).locator('option[value="mine"]')).toHaveCount(0);
    await expect(rows(adminPage)).toHaveCount(12); await capture(adminPage, 'admin-library'); await adminCtx.close();
    const preservedCtx = await context(); const preserved = await preservedCtx.newPage(); await ready(preserved);
    await preserved.goto(baseUrl + '/favoritos'); const favorite = preserved.locator('a[href="/material/' + materialId + '"]').first();
    await expect(favorite.locator('p').first()).toBeHidden(); await favorite.click(); await expect(preserved.getByRole('link', { name: 'Voltar para Favoritos', exact: true })).toBeVisible();
    await preserved.getByRole('link', { name: 'Voltar para Favoritos', exact: true }).click(); await expect(preserved.locator('[data-favorites]')).toBeVisible(); await preservedCtx.close();
    check('Administração pode consultar; Favoritos usa cartão móvel compacto e retorno com o nome correto');

    const switchPassword = 'Library-fixture-only-9!'; db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(switchPassword, 4), previewUser.id);
    const switchCtx = await context(); let releaseSwitch; let switchStarted;
    const switchGate = new Promise(resolve => { releaseSwitch = resolve; }); const switching = new Promise(resolve => { switchStarted = resolve; }); let hold = true;
    await switchCtx.route(/\/api\/materials\?/, async route => {
      if (!hold) return route.continue(); hold = false;
      const response = await route.fetch(); const json = await response.json(); json.data[0].title = 'Resposta da sessão anterior — não exibir';
      switchStarted(); await switchGate; await route.fulfill({ response, json }).catch(() => {});
    });
    const switched = await switchCtx.newPage(); await ready(switched, '', false); await switching;
    await switched.getByRole('button', { name: 'Menu do usuário', exact: true }).click(); await switched.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await switched.getByLabel('E-mail', { exact: true }).fill(previewUser.email); await switched.getByLabel('Senha', { exact: true }).fill(switchPassword);
    await switched.getByRole('button', { name: 'Entrar no sistema', exact: true }).click(); await expect(switched).toHaveURL(baseUrl + '/');
    await switched.waitForTimeout(600); const notice = switched.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    await switched.getByRole('link', { name: 'Buscar material', exact: true }).click(); releaseSwitch(); await expect(rows(switched)).toHaveCount(12);
    await expect(library(switched)).not.toContainText('Resposta da sessão anterior'); await switchCtx.close();
    check('Sair e entrar em outra conta durante consulta não reapresenta resposta anterior');

    const exploreCtx = await context(); const explore = await exploreCtx.newPage(); await ready(explore);
    const start = Date.now(); while (Date.now() - start < 30000) { await explore.keyboard.press('Tab'); await explore.mouse.wheel(0, 160); await explore.waitForTimeout(650); }
    await capture(explore, 'exploration'); await exploreCtx.close(); check('Exploração por teclado e rolagem por 30 segundos');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.failure = error.stack; record(); throw error; }
  finally { for (const ctx of contexts) await ctx.close().catch(() => {}); await browser.close(); }
}
module.exports = { runLibraryBrowser };
