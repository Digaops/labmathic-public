const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runTeacherHomeBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, plan, materialId, db, output }) {
  assert.equal(process.env.TEACHER_HOME_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [], checks: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = name => { report.checks.push(name); report.inventory.push({ id: `check-${report.checks.length}`, description: name }); record(); console.log('Início docente:', name); };
  const browser = await chromium.launch({ headless: true });
  const contexts = [];
  async function context(user = teacher, viewport = { width: 390, height: 664 }, theme = 'dark') {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    contexts.push(ctx);
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('theme', theme);
      sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message)));
    return ctx;
  }
  async function ready(page, url = '/', idle = true) {
    await page.goto(baseUrl + url, { waitUntil: 'domcontentloaded' });
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
    // The announcement can arrive independently from route rendering.
    await page.waitForTimeout(550);
    if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle');
    await page.waitForTimeout(400);
  }
  async function capture(page, id, firstClass = false, fullPage = false) {
    await page.waitForTimeout(400);
    const metrics = await page.evaluate(() => {
      const box = element => { const rect = element?.getBoundingClientRect(); return rect ? { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height } : null; };
      const home = document.querySelector('[data-teacher-home]');
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        firstClass: box(home?.querySelector('[data-home-class]')),
        controls: [...(home?.querySelectorAll('a,button,summary') || [])].filter(e => e.getBoundingClientRect().height).map(e => ({ text: e.textContent.trim(), ...box(e) })) };
    });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css', fullPage });
    fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record();
    assert.ok(metrics.scrollWidth <= metrics.width, id + ': no document overflow');
    if (firstClass) {
      assert.equal(metrics.scrollY, 0, id + ': initial view');
      assert.ok(metrics.firstClass && metrics.firstClass.y >= 64 && metrics.firstClass.bottom <= metrics.height, id + ': first class entirely visible');
    }
    for (const control of metrics.controls) {
      assert.ok(control.width >= 24 && control.height >= 44, id + ': touch target ' + control.text);
      assert.ok(control.x >= 0 && control.right <= metrics.width + 1, id + ': control within width ' + control.text);
    }
  }
  const cls = page => page.locator('[data-home-class]').first();
  const home = page => page.locator('[data-teacher-home]');
  try {
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }, { width: 320, height: 600 }]) {
      for (const theme of ['dark', 'light']) {
        const ctx = await context(teacher, viewport, theme); const page = await ctx.newPage(); await ready(page);
        await expect(cls(page)).toBeVisible();
        await expect(home(page).getByRole('alert')).toHaveCount(0);
        await capture(page, `home-${viewport.width}-${theme}`, true);
        if ((viewport.width === 390 && theme === 'dark') || (viewport.width === 1024 && theme === 'light')) {
          await capture(page, `home-${viewport.width}-${theme}-full`, false, true);
        }
        assert.equal(await page.getByTestId('dashboard-heading').evaluate(e => getComputedStyle(e).color), theme === 'light' ? 'rgb(15, 23, 42)' : 'rgb(255, 255, 255)', 'Heading uses the intended theme color');
        await ctx.close();
      }
    }
    check('Turma inteira e ação na primeira tela, 3 larguras × 2 temas');

    const ctx = await context(); const page = await ctx.newPage(); await ready(page);
    await cls(page).click(); await expect(page).toHaveURL(new RegExp(`/turmas\\?turma=${classPublicId}$`));
    await expect(page.getByRole('tablist', { name: 'Conteúdo da turma' })).toBeVisible();
    await ready(page);
    await home(page).getByRole('link', { name: new RegExp('^Abrir planejamento: ' + plan.title) }).click();
    await expect(page).toHaveURL(baseUrl + '/planejamento/' + plan.publicId);
    // Existing drafts open on their lessons since Entrega 27; context is a separate area.
    await page.getByRole('button', { name: 'Turma e período', exact: true }).click();
    await expect(page.getByLabel('Título do planejamento', { exact: true })).toHaveValue(plan.title);
    await ready(page);
    const application = home(page).getByRole('link', { name: /^Ver aplicações da turma:/ }).first();
    await application.click(); await expect(page).toHaveURL(new RegExp(`turma=${classPublicId}&secao=avaliacoes`));
    await expect(page.getByRole('tab', { name: 'Aplicações', exact: true })).toHaveAttribute('aria-selected', 'true');
    await ready(page);
    await home(page).getByRole('link', { name: /Problemas para conversar em sala/ }).first().click();
    await expect(page).toHaveURL(baseUrl + '/material/' + materialId); await expect(page.locator('canvas').first()).toBeVisible();
    check('Links de turma, aplicações, planejamento e material chegam ao destino real');

    await ready(page);
    const examples = home(page).locator('summary').filter({ hasText: 'Conhecer os exemplos' });
    await examples.focus(); await page.keyboard.press('Enter');
    await expect(home(page).getByRole('link', { name: 'Exemplos de formatos' })).toBeVisible();
    await home(page).getByRole('link', { name: 'Pedir ajuda', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'examples-open');
    await examples.focus(); await page.keyboard.press('Enter');
    await expect(home(page).getByRole('link', { name: 'Exemplos de formatos' })).not.toBeVisible();
    await page.evaluate(() => scrollTo(0, 0));
    await home(page).getByRole('link', { name: 'Buscar material', exact: true }).focus();
    const outline = await home(page).getByRole('link', { name: 'Buscar material', exact: true }).evaluate(e => getComputedStyle(e).outlineStyle);
    assert.equal(outline, 'solid');
    await capture(page, 'keyboard-focus');
    check('Exemplos abrem/fecham por teclado, ciclo real separado e foco visível');

    for (const [label, url] of [['Buscar material', '/biblioteca'], ['Buscar questões', '/banco-questoes'], ['Planejamentos', '/planejamento'],
      ['Meus simulados', '/simulados'], ['Planos de recomposição', '/recomposicao'], ['Devolutivas da turma', '/banco-questoes/devolutivas'],
      ['Laboratórios de materiais', '/colecoes'], ['Minha escola', '/instituicoes'], ['Pedir ajuda', '/fale-conosco']]) {
      await ready(page); await home(page).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(baseUrl + url);
    }
    check('Atalhos do professor mantêm os destinos existentes');
    for (const [section, label, url] of [['Minhas turmas', 'Ver todas', '/turmas'], ['Novos materiais', 'Ver biblioteca', '/biblioteca'],
      ['Seus favoritos', 'Ver todos', '/favoritos'], ['Simulados recentes', 'Ver todos', '/simulados']]) {
      await ready(page); await home(page).getByRole('region', { name: section, exact: true }).getByRole('link', { name: label, exact: true }).click();
      await expect(page).toHaveURL(baseUrl + url);
    }
    check('Ações Ver todas/Ver todos/Ver biblioteca preservadas');
    await ctx.close();

    const resources = [
      ['classes', /\/api\/classes\?status=active$/, 'suas turmas'],
      ['overview', /\/api\/classes\/home-overview$/, 'suas avaliações e planos de recomposição'],
      ['planning', /\/api\/lesson-plans$/, 'seus planejamentos'],
      ['history', /\/api\/materials\/history\?limit=3$/, 'os materiais que você abriu'],
      ['materials', /\/api\/materials\?limit=3&sort=recent$/, 'os novos materiais'],
      ['favorites', /\/api\/favorites\?limit=3$/, 'seus favoritos'],
      ['sets', /\/api\/question-bank\/question-sets\?limit=3$/, 'seus simulados'],
    ];
    for (const [id, pattern, label] of resources) {
      const errorCtx = await context(); let fail = true;
      await errorCtx.route(pattern, route => fail ? route.fulfill({ status: 503, json: { error: 'Falha sintética' } }) : route.continue());
      const errorPage = await errorCtx.newPage(); await ready(errorPage);
      await expect(home(errorPage).getByRole('alert').filter({ hasText: label })).toBeVisible();
      await expect(home(errorPage).getByText(/Você ainda não tem turmas ativas|Criar primeira turma/)).toHaveCount(0);
      if (id === 'classes' || id === 'favorites') {
        await home(errorPage).getByRole('button', { name: `Tentar novamente: ${label}`, exact: true }).scrollIntoViewIfNeeded();
        await capture(errorPage, id + '-error');
      }
      fail = false;
      await home(errorPage).getByRole('button', { name: `Tentar novamente: ${label}`, exact: true }).click();
      await expect(home(errorPage).getByRole('alert')).toHaveCount(0);
      await expect(cls(errorPage)).toBeVisible();
      if (id === 'classes') await capture(errorPage, 'classes-recovered', true);
      await errorCtx.close();
    }
    check('7 consultas: erro explícito, sem vazio falso, com recuperação pelo botão');

    const slowCtx = await context(); let release; let requested;
    const gate = new Promise(resolve => { release = resolve; }); const started = new Promise(resolve => { requested = resolve; });
    await slowCtx.route(/\/api\/favorites\?limit=3$/, async route => { requested(); await gate; await route.continue().catch(() => {}); });
    const slow = await slowCtx.newPage(); await ready(slow, '/', false); await started;
    await expect(cls(slow)).toBeVisible(); await expect(home(slow).getByText('Carregando seus favoritos…', { exact: true })).toBeVisible();
    await capture(slow, 'slow-favorites-classes-ready', true); release(); await slow.waitForLoadState('networkidle');
    await slowCtx.close(); check('Favoritos lentos não bloqueiam as turmas');

    const invalidCtx = await context(); await invalidCtx.route(resources[0][1], route => route.fulfill({ status: 200, json: {} }));
    const invalid = await invalidCtx.newPage(); await ready(invalid); await expect(home(invalid).getByRole('alert')).toContainText('suas turmas');
    await invalidCtx.close(); check('Resposta HTTP 200 inválida é erro, não ausência de turmas');

    const offCtx = await context(); const gatedRequests = [];
    await offCtx.route(/\/api\/governance\/features\?/, async route => { const response = await route.fetch(); const json = await response.json();
      json.features = Object.fromEntries(Object.keys(json.features).map(key => [key, false])); await route.fulfill({ response, json }); });
    offCtx.on('request', request => { if (/\/api\/(classes|lesson-plans)(\/|\?|$)/.test(request.url())) gatedRequests.push(request.url()); });
    const off = await offCtx.newPage(); await ready(off);
    await expect(home(off).getByRole('heading', { name: 'Minhas turmas', exact: true })).toHaveCount(0);
    for (const href of ['/turmas', '/planejamento', '/recomposicao', '/instituicoes', '/banco-questoes/devolutivas']) await expect(home(off).locator(`a[href^="${href}"]`)).toHaveCount(0);
    assert.deepEqual(gatedRequests, []); await capture(off, 'features-off'); await offCtx.close();
    check('Flags desligadas: sem consultas ou atalhos das áreas restritas');

    const unavailableCtx = await context(); await unavailableCtx.route(/\/api\/governance\/features\?/, route => route.fulfill({ status: 503, json: { error: 'Falha sintética' } }));
    const unavailable = await unavailableCtx.newPage(); await ready(unavailable);
    await expect(unavailable.getByText(/Conexão instável: mantendo/)).toBeVisible();
    await expect(home(unavailable).locator('a[href^="/turmas"]')).toHaveCount(0);
    await capture(unavailable, 'features-unavailable'); await unavailableCtx.close();
    check('Disponibilidade desconhecida não vira conta sem turmas');

    const knownCtx = await context(); const known = await knownCtx.newPage(); await ready(known);
    await expect(cls(known)).toBeVisible(); await knownCtx.setOffline(true);
    await expect(known.getByText(/Conexão instável: mantendo/)).toBeVisible();
    await expect(cls(known)).toBeVisible(); await capture(known, 'known-options-offline', true);
    await knownCtx.setOffline(false); await known.getByRole('button', { name: 'Verificar conexão', exact: true }).click();
    await expect(known.getByText(/Conexão instável: mantendo/)).toHaveCount(0);
    await knownCtx.close(); check('Oscilação de conexão preserva opções confirmadas, sem ampliar permissões');

    const emptyCtx = await context(previewUser); const empty = await emptyCtx.newPage(); await ready(empty);
    await expect(home(empty).getByText('Você ainda não tem turmas ativas.', { exact: true })).toBeVisible();
    await expect(home(empty).getByRole('alert')).toHaveCount(0); await capture(empty, 'empty-account');
    await emptyCtx.close(); check('Conta sintética vazia recebe orientação sem erro nem dados da outra conta');

    const switchPassword = 'Teacher-home-fixture-only-9!';
    db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(switchPassword, 4), previewUser.id);
    const switchCtx = await context(); let resumeOld; let oldStarted; let holdFirst = true;
    const oldGate = new Promise(resolve => { resumeOld = resolve; }); const oldRequest = new Promise(resolve => { oldStarted = resolve; });
    await switchCtx.route(/\/api\/classes\/home-overview$/, async route => {
      if (!holdFirst) return route.continue();
      holdFirst = false; oldStarted(); await oldGate;
      await route.continue().catch(() => {});
    });
    const switched = await switchCtx.newPage(); await ready(switched, '/', false); await oldRequest;
    await expect(cls(switched)).toBeVisible();
    await switched.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
    await switched.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await expect(switched).toHaveURL(baseUrl + '/login');
    await switched.getByLabel('E-mail', { exact: true }).fill(previewUser.email);
    await switched.getByLabel('Senha', { exact: true }).fill(switchPassword);
    await switched.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
    await expect(switched).toHaveURL(baseUrl + '/'); resumeOld();
    await switched.waitForTimeout(600);
    const accessNotice = switched.getByRole('button', { name: 'Entendi, continuar', exact: true });
    if (await accessNotice.isVisible()) await accessNotice.click();
    await expect(home(switched).getByText('Você ainda não tem turmas ativas.', { exact: true })).toBeVisible();
    await expect(home(switched)).not.toContainText(plan.title);
    await capture(switched, 'account-switch'); await switchCtx.close();
    check('Saída e entrada reais em outra conta durante consulta não reaproveitam dados');

    // Dense layout only, still using real API rows in the fixture-owned database.
    const original = db.prepare('SELECT * FROM school_classes WHERE public_id=?').get(classPublicId);
    const longName = 'A turma com um nome muito comprido para conferir a leitura em telas pequenas';
    for (let n = 0; n < 3; n++) db.prepare(`INSERT INTO school_classes(public_id,owner_teacher_id,name,grade_id,academic_year,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?)`).run('home-layout-dense-fixture-' + n, teacher.id, n ? 'Outra turma ' + n : longName, original.grade_id, 2027, teacher.id, teacher.id);
    const denseCtx = await context(teacher, { width: 320, height: 600 }); const dense = await denseCtx.newPage(); await ready(dense);
    await expect(home(dense).locator('[data-home-class]')).toHaveCount(3);
    await expect(home(dense).getByText(/Mostrando três turmas/)).toBeVisible(); await capture(dense, 'dense-320', true);
    await denseCtx.close(); check('Nomes longos quebram linha e recorte de 3 turmas é explícito');

    const adminCtx = await context(admin); const adminPage = await adminCtx.newPage(); await ready(adminPage);
    await expect(adminPage.getByTestId('dashboard-heading')).toHaveText('Início da administração');
    await expect(home(adminPage)).toHaveCount(0); await capture(adminPage, 'admin-preserved'); await adminCtx.close();
    check('Início administrativo separado da experiência docente');

    const exploreCtx = await context(); const explore = await exploreCtx.newPage(); await ready(explore);
    const startedAt = Date.now();
    while (Date.now() - startedAt < 30000) {
      await explore.mouse.wheel(0, 180); await explore.keyboard.press('Tab'); await explore.mouse.wheel(0, -100); await explore.waitForTimeout(600);
    }
    await capture(explore, 'exploration'); await exploreCtx.close();
    check('30 segundos de exploração por teclado/rolagem sem erro JavaScript');
    assert.deepEqual(report.pageErrors, []);
    report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'failed'; report.failure = error.stack; record(); throw error;
  } finally { for (const ctx of contexts) await ctx.close().catch(() => {}); await browser.close(); }
}

module.exports = { runTeacherHomeBrowser };
