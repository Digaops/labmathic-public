const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runAdminHomeBrowser({ baseUrl, teacher, admin, tokenFor, materialId, questionSetId, db, output }) {
  assert.equal(process.env.ADMIN_HOME_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/); assert.equal(output, path.join(root, 'tmp/admin-home-qa'));
  const report = { status: 'running', syntheticDataOnly: true, cases: [], internal: [], inventory: [], pageErrors: [], reads: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Início administrativo:', description); };
  const longTitle = 'Estratégias para trabalhar problemas matemáticos com diferentes formas de pensar e explicar as respostas em sala';
  db.prepare('UPDATE materials SET title=? WHERE id=?').run(longTitle, materialId);
  for (let n = 0; n < 6; n++) {
    const id = n === 0 ? materialId : Number(db.prepare("INSERT INTO materials(title,created_by) VALUES (?,?)").run('Caderno de atividades e orientações para o planejamento das aulas ' + n, admin.id).lastInsertRowid);
    db.prepare('INSERT INTO access_history(user_id,material_id) VALUES (?,?)').run(admin.id, id);
    db.prepare('INSERT INTO favorites(user_id,material_id) VALUES (?,?)').run(admin.id, id);
  }
  for (let n = 0; n < 3; n++) db.prepare('INSERT INTO question_sets(user_id,title,is_public) VALUES (?,?,0)').run(admin.id, 'Simulado para acompanhar estratégias de resolução de problemas ' + n);
  if (process.env.ADMIN_HOME_INTERACTIVE === '1') {
    const file = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(file, JSON.stringify({ baseUrl, user: admin, token: tokenFor(admin) })); console.log('ADMIN_HOME_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const queries = [
    ['history', '**/api/materials/history?limit=4', '[data-admin-home-list="history"]', 'Atualizar histórico', 'Retomar materiais e favoritos'],
    ['favorites', '**/api/favorites?limit=3', '[data-admin-home-list="favorites"]', 'Atualizar favoritos', 'Retomar materiais e favoritos'],
    ['materials', '**/api/materials?limit=6&sort=recent', '[data-admin-home-list="materials"]', 'Atualizar materiais', 'Consultar acervo e simulados'],
    ['sets', '**/api/question-bank/question-sets?limit=3&all=1', '[data-admin-home-list="sets"]', 'Atualizar simulados', 'Consultar acervo e simulados'],
    ['stats', '**/api/materials/dashboard-stats', '[data-admin-home-stats]', 'Atualizar totais', 'Consultar acervo e simulados'],
    ['network', '**/api/institutions/read-model', '[data-admin-home-network]', 'Atualizar rede', 'Consultar resumo da rede']];
  async function context(w = 1024, h = 600, theme = 'light', user = admin) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(8000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.route('**/api/announcements/current?*', r => r.fulfill({ json: { announcement: null } }));
    await c.addInitScript(({ baseUrl, theme, user, token }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); }, { baseUrl, theme, user, token: tokenFor(user) });
    c.on('page', p => { p.on('pageerror', e => report.pageErrors.push(e.message)); p.on('request', r => { if (queries.some(([, pattern]) => r.url() === baseUrl + pattern.slice(2))) report.reads.push({ url: r.url().replace(baseUrl, ''), method: r.method() }); }); });
    return c;
  }
  const home = p => p.locator('[data-admin-home]');
  const summary = (p, name) => home(p).locator('summary').filter({ hasText: name });
  async function go(p) { await p.goto(baseUrl + '/'); await p.waitForLoadState('networkidle'); }
  async function open(p, name, selector) { await summary(p, name).click(); await p.locator(selector).waitFor(); await expect(p.locator(selector).getByRole('status')).toHaveCount(0); }
  async function capture(p, name, first = false) {
    await p.waitForTimeout(350);
    if (first) {
      for (const text of ['Abrir administração', 'Organizar instituições', 'Gerenciar usuários', 'Responder professores']) await expect(home(p).getByRole('link', { name: new RegExp('^' + text) })).toBeInViewport({ ratio: 1 });
      const dark = await p.locator('html').evaluate(e => e.classList.contains('dark'));
      await expect(p.getByTestId('dashboard-heading')).toHaveCSS('color', dark ? 'rgb(241, 245, 249)' : 'rgb(15, 23, 42)');
    }
    const metrics = await home(p).evaluate(e => ({ w: innerWidth, width: document.documentElement.scrollWidth,
      controls: [...e.querySelectorAll('a,button,summary')].filter(n => n.getClientRects().length).map(n => ({ text: n.textContent.trim(), height: n.getBoundingClientRect().height })) }));
    assert.ok(metrics.width <= metrics.w + 1, name + ' overflow'); assert.deepEqual(metrics.controls.filter(n => n.height < 43.5), [], name + ' target');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); report.cases.push({ name, ...metrics }); record();
  }
  async function frameSection(p, selector) {
    // Keep the section's heading below the shared fixed header, including tall lists.
    await p.locator(selector).evaluate(e => window.scrollTo({ top: e.getBoundingClientRect().top + scrollY - 120, behavior: 'instant' }));
  }
  try {
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) {
      const c = await context(w, h, theme), p = await c.newPage(); let initialReads = 0;
      p.on('request', r => { if (queries.slice(0, 5).some(([, pattern]) => r.url() === baseUrl + pattern.slice(2))) initialReads++; });
      await go(p); assert.equal(initialReads, 0); await capture(p, `initial-${w}-${theme}`, true);
      for (const [title, selectors] of [['Consultar resumo da rede', ['[data-admin-home-network]']], ['Retomar materiais e favoritos', ['[data-admin-home-list="history"]', '[data-admin-home-list="favorites"]']], ['Consultar acervo e simulados', ['[data-admin-home-stats]', '[data-admin-home-list="materials"]', '[data-admin-home-list="sets"]']]]) {
        await open(p, title, selectors[0]); await expect(home(p).getByRole('status')).toHaveCount(0); await expect(home(p).getByRole('alert')).toHaveCount(0);
        for (const selector of selectors) {
          await frameSection(p, selector); const name = selector.match(/list="(\w+)"/)?.[1] || selector.match(/home-(\w+)/)[1]; await capture(p, `${name}-${w}-${theme}`);
          const size = { history: 4, favorites: 3, materials: 6, sets: 3 }[name];
          if (size) { await expect(p.locator(selector).locator('ul a')).toHaveCount(size); if (w === 320) { await p.locator(selector).getByRole('link').last().scrollIntoViewIfNeeded(); await capture(p, `${name}-end-${w}-${theme}`); } }
        }
        await summary(p, title).focus(); await p.keyboard.press('Space'); await expect(p.locator(selectors[0])).toHaveCount(0);
        await p.keyboard.press('Enter'); await p.locator(selectors[0]).waitFor(); await expect(home(p).getByRole('status')).toHaveCount(0); await summary(p, title).click();
      }
      await summary(p, 'Conhecer os exemplos').click(); await home(p).getByRole('navigation', { name: 'Exemplos demonstrativos' }).waitFor(); await frameSection(p, '[data-admin-home] details:last-child');
      for (const label of ['Exemplos do Banco 2.0', 'Exemplos de devolutivas', 'Exemplos de formatos']) await expect(home(p).getByRole('link', { name: label, exact: true })).toBeInViewport({ ratio: 1 });
      await capture(p, `examples-${w}-${theme}`); await summary(p, 'Conhecer os exemplos').click(); await c.close();
    }
    check('Quatro tarefas visíveis na entrada; seis consultas opcionais e independentes, teclado, limites e nomes longos em três tamanhos e dois temas');
    const nc = await context(), np = await nc.newPage();
    const destinations = [['Abrir administração', '/admin'], ['Organizar instituições', '/instituicoes'], ['Gerenciar usuários', '/admin/usuarios'], ['Responder professores', '/fale-conosco'], ['Gerenciar materiais', '/admin/materiais'], ['Ver relatórios', '/admin/relatorios'], ['Abrir biblioteca', '/biblioteca'], ['Banco de questões', '/banco-questoes'], ['Ver simulados', '/simulados']];
    for (const [label, url] of destinations) { await go(np); await home(np).getByRole('link', { name: new RegExp('^' + label + '(?:$| )') }).click(); await expect(np).toHaveURL(baseUrl + url); await np.locator('main h1').waitFor(); }
    for (const [label, url] of [['Exemplos do Banco 2.0', '/banco-questoes/revisao'], ['Exemplos de devolutivas', '/banco-questoes/devolutivas'], ['Exemplos de formatos', '/banco-questoes/formatos']]) { await go(np); await summary(np, 'Conhecer os exemplos').click(); await home(np).getByRole('link', { name: label, exact: true }).click(); await expect(np).toHaveURL(baseUrl + url); await np.locator('main h1').waitFor(); }
    for (const [name, title, selector] of [['material', 'Retomar materiais e favoritos', '[data-admin-home-list="history"]'], ['set', 'Consultar acervo e simulados', '[data-admin-home-list="sets"]']]) {
      await go(np); await open(np, title, selector); await expect(np.locator(selector).locator('ul a').first()).toBeVisible(); const href = await np.locator(selector).locator('ul a').first().getAttribute('href'); await np.locator(selector).locator('ul a').first().click(); await expect(np).toHaveURL(baseUrl + href); await np.locator('main h1').waitFor();
    }
    for (const [title, selector, label, url] of [
      ['Consultar resumo da rede', '[data-admin-home-network]', 'Abrir instituições', '/instituicoes'],
      ['Retomar materiais e favoritos', queries[0][2], 'Ver biblioteca', '/biblioteca'],
      ['Retomar materiais e favoritos', queries[1][2], 'Ver todos os favoritos', '/favoritos'],
      ['Consultar acervo e simulados', queries[2][2], 'Ver todos os materiais', '/biblioteca'],
      ['Consultar acervo e simulados', queries[3][2], 'Ver todos os simulados', '/simulados'],
      ...[['Materiais', '/biblioteca'], ['Questões', '/banco-questoes'], ['Simulados', '/simulados'], ['Habilidades BNCC com questões', '/banco-questoes']].map(([label, url]) => ['Consultar acervo e simulados', '[data-admin-home-stats]', label, url])]) {
      await go(np); await open(np, title, selector); await np.locator(selector).getByRole('link', { name: label, exact: true }).click(); await expect(np).toHaveURL(baseUrl + url); await np.locator('main h1').waitFor();
    }
    await nc.close(); check('Atalhos administrativos, acervo, rodapés, totais, três demonstrações e conteúdos individuais chegam às rotas reais');
    for (const [name, pattern, selector, action, title] of queries) {
      const c = await context(320, 600, 'dark'), p = await c.newPage(); await go(p);
      await p.route(pattern, r => r.fulfill({ status: 503, json: {} })); await open(p, title, selector); await expect(p.locator(selector).getByRole('alert')).toBeVisible(); await frameSection(p, selector); await capture(p, 'error-' + name);
      await p.unroute(pattern); await p.getByRole('button', { name: action, exact: true }).click(); await expect(p.locator(selector).getByRole('alert')).toHaveCount(0); await expect(p.getByRole('button', { name: action, exact: true })).toBeEnabled();
      await p.route(pattern, r => r.fulfill({ json: {} })); await p.getByRole('button', { name: action, exact: true }).click(); await expect(p.locator(selector).getByRole('alert')).toBeVisible(); await c.close();
    }
    check('Cada uma das seis consultas distingue 503 e HTTP 200 inválido de vazio; atualização manual recupera os dados');
    const zc = await context(390, 664, 'light'), zp = await zc.newPage(); await go(zp);
    for (const [name, pattern] of queries) await zp.route(pattern, r => r.fulfill({ json: name === 'history' ? [] : name === 'stats' ? { scope: 'global', totalMaterials: 0, totalQuestions: 0, totalQuestionSets: 0, totalCoveredSkills: 0 } : name === 'network' ? { mode: 'admin', readOnly: true, summary: { activeMunicipalities: 0, activeSchools: 0, verifiedClasses: 0, pendingClasses: 0 } } : { data: [] } }));
    for (const [name,, selector,, title] of queries) { if (!await zp.locator(selector).count()) await open(zp, title, selector); await expect(zp.locator(selector).getByRole('alert')).toHaveCount(0); await expect(zp.locator(selector).getByRole('status')).toHaveCount(0); await frameSection(zp, selector); await capture(zp, 'zero-' + name); }
    await zc.close(); check('Zeros confirmados e listas pessoais vazias têm orientação própria; contagem global e resumo institucional não são confundidos');
    const dc = await context(320, 600, 'light'), dp = await dc.newPage(); let release, hit; const held = new Promise(r => release = r), started = new Promise(r => hit = r);
    await go(dp); await dp.route(queries[1][1], async r => { hit(); await held; await r.fulfill({ json: { data: [{ id: materialId, title: 'RESPOSTA ANTIGA QA33' }] } }).catch(() => {}); });
    await summary(dp, 'Retomar materiais e favoritos').click(); await started; await expect(dp.locator(queries[0][2]).locator('ul a')).toHaveCount(4); await frameSection(dp, queries[1][2]); await capture(dp, 'slow-favorites');
    await summary(dp, 'Retomar materiais e favoritos').click(); release(); await dp.waitForTimeout(150); await dp.unroute(queries[1][1]); await open(dp, 'Retomar materiais e favoritos', queries[1][2]); await expect(home(dp)).not.toContainText('RESPOSTA ANTIGA QA33'); await dc.close();
    check('Favoritos lentos não bloqueiam o histórico; recolher e reabrir descarta a resposta antiga');
    for (const state of ['off', 'unknown']) {
      const c = await context(320, 600, 'dark'), p = await c.newPage(); await p.route('**/api/governance/features?*', async r => { if (state === 'unknown') return r.fulfill({ status: 503, json: {} }); const response = await r.fetch(), data = await response.json(); for (const flag of ['institutions.read_model', 'question_bank.typed_preview', 'question_bank.feedback_preview', 'question_bank.catalog_preview']) data.features[flag] = false; await r.fulfill({ response, json: data }); });
      await go(p); await expect(home(p).getByRole('link', { name: /Organizar instituições/ })).toHaveCount(0); await expect(summary(p, 'Conhecer os exemplos')).toHaveCount(0); await expect(summary(p, 'Consultar resumo da rede')).toHaveCount(0); await capture(p, 'flags-' + state); await c.close();
    }
    check('Flags desconhecidas ou desligadas não liberam resumo institucional nem demonstrações');
    const tc = await context(390, 664, 'light', teacher), tp = await tc.newPage(); await go(tp); await expect(home(tp)).toHaveCount(0); await expect(tp.locator('[data-teacher-home]')).toBeVisible(); await tc.close();
    const xc = await context(390, 664, 'dark'), xp = await xc.newPage(); await go(xp); let releaseLate, hitLate; const late = new Promise(r => releaseLate = r), lateStarted = new Promise(r => hitLate = r);
    const password = 'Synthetic-admin-switch-33!'; db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 4), teacher.id);
    await xp.route(queries[0][1], async r => { hitLate(); await late; await r.fulfill({ json: [{ id: materialId, title: 'CONTEÚDO DA ADMINISTRAÇÃO ANTERIOR' }] }).catch(() => {}); });
    await summary(xp, 'Retomar materiais e favoritos').click(); await lateStarted; await xp.getByRole('button', { name: 'Menu do usuário', exact: true }).click(); await xp.getByRole('button', { name: 'Sair da conta', exact: true }).click(); await expect(xp).toHaveURL(baseUrl + '/login');
    await xp.getByLabel('E-mail', { exact: true }).fill(teacher.email); await xp.getByLabel('Senha', { exact: true }).fill(password); await xp.getByRole('button', { name: 'Entrar no sistema', exact: true }).click(); await expect(xp).toHaveURL(baseUrl + '/'); releaseLate(); await expect(xp.locator('[data-teacher-home]')).toBeVisible(); await xp.waitForTimeout(350); await expect(home(xp)).toHaveCount(0); await expect(xp.getByText('CONTEÚDO DA ADMINISTRAÇÃO ANTERIOR')).toHaveCount(0); await xc.close();
    check('Professor mantém seu início; logout e login reais durante consulta não reutilizam dados administrativos');
    assert.deepEqual(report.pageErrors, []); assert.ok(report.reads.every(r => r.method === 'GET')); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runAdminHomeBrowser };
