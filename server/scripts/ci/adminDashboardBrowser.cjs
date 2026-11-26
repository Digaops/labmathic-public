const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runAdminDashboardBrowser({ baseUrl, teacher, admin, tokenFor, materialId, questionSetId, db, output }) {
  assert.equal(process.env.ADMIN_DASHBOARD_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/); assert.equal(output, path.join(root, 'tmp/admin-dashboard-qa'));
  const report = { status: 'running', syntheticDataOnly: true, cases: [], internal: [], inventory: [], pageErrors: [], reads: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Painel administrativo:', description); };
  const longTitle = 'Estratégias para resolver problemas de matemática com diferentes formas de pensar e explicar as respostas em sala';
  db.prepare('UPDATE materials SET title=? WHERE id=?').run(longTitle, materialId);
  const typeId = db.prepare('SELECT material_type_id FROM materials WHERE id=?').pluck().get(materialId);
  db.prepare('UPDATE material_types SET name=? WHERE id=?').run('Caderno de atividades para planejamento e acompanhamento das aprendizagens', typeId);
  db.prepare("INSERT INTO materials(title,created_by) VALUES ('Material sem tipo — QA32',?)").run(admin.id);
  db.prepare('INSERT INTO access_history(user_id,material_id) VALUES (?,?)').run(admin.id, materialId);
  db.prepare('INSERT INTO question_set_access_history(user_id,question_set_id) VALUES (?,?)').run(admin.id, questionSetId);
  const unread = () => db.prepare("SELECT COUNT(*) FROM support_messages sm JOIN users u ON u.id=sm.sender_id WHERE sm.read_at IS NULL AND u.role='professor'").pluck().get();
  const initialUnread = unread();
  if (process.env.ADMIN_DASHBOARD_INTERACTIVE === '1') {
    const file = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(file, JSON.stringify({ baseUrl, user: admin, token: tokenFor(admin) })); console.log('ADMIN_DASHBOARD_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  async function context(w = 1024, h = 600, theme = 'light', user = admin) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(7000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.route('**/api/announcements/current?*', r => r.fulfill({ json: { announcement: null } }));
    await c.addInitScript(({ baseUrl, theme, user, token }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); }, { baseUrl, theme, user, token: tokenFor(user) });
    c.on('page', p => { p.on('pageerror', e => report.pageErrors.push(e.message)); p.on('request', r => { if (/\/api\/(materials\/stats|reports\/(overview|top-content))/.test(r.url())) report.reads.push({ url: r.url().replace(baseUrl, ''), method: r.method() }); }); });
    return c;
  }
  const home = p => p.locator('[data-admin-dashboard]');
  const summary = p => home(p).getByText('Consultar números do acervo', { exact: true });
  async function go(p, url = '/admin') { await p.goto(baseUrl + url); await p.waitForLoadState('networkidle'); }
  async function openNumbers(p) { await summary(p).click(); await p.locator('[data-admin-numbers]').waitFor(); await expect(home(p).getByText('Consultando…')).toHaveCount(0); }
  async function capture(p, name, first = false) {
    await p.waitForTimeout(350);
    if (first) {
      for (const title of ['Organizar instituições', 'Gerenciar usuários', 'Responder professores']) await expect(home(p).getByRole('link', { name: new RegExp(title) })).toBeInViewport({ ratio: 1 });
      const dark = await p.locator('html').evaluate(e => e.classList.contains('dark'));
      await expect(home(p).getByRole('heading', { level: 1 })).toHaveCSS('color', dark ? 'rgb(241, 245, 249)' : 'rgb(15, 23, 42)');
      await expect(home(p).locator('header > p')).toHaveCSS('color', dark ? 'rgb(203, 213, 225)' : 'rgb(71, 85, 105)');
    }
    const metrics = await home(p).evaluate(e => ({ w: innerWidth, width: document.documentElement.scrollWidth,
      controls: [...e.querySelectorAll('a,button,summary')].filter(n => n.getClientRects().length).map(n => ({ text: n.textContent.trim(), height: n.getBoundingClientRect().height })) }));
    assert.ok(metrics.width <= metrics.w + 1, name + ' overflow'); assert.deepEqual(metrics.controls.filter(n => n.height < 43.5), [], name + ' target');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); report.cases.push({ name, ...metrics }); record();
  }
  try {
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) {
      const c = await context(w, h, theme), p = await c.newPage(); let statsReads = 0;
      p.on('request', r => { if (/\/api\/(materials\/stats|reports\/top-content)/.test(r.url())) statsReads++; });
      await go(p); assert.equal(statsReads, 0); await expect(home(p).getByText(initialUnread + ' mensagem não lida no Fale Conosco.', { exact: true })).toBeVisible(); await capture(p, `initial-${w}-${theme}`, true);
      await openNumbers(p); assert.equal(statsReads, 2); await expect(p.locator('[data-admin-numbers]')).toContainText('Sem tipo informado');
      await p.locator('[data-admin-numbers]').scrollIntoViewIfNeeded(); await capture(p, `numbers-${w}-${theme}`);
      await p.locator('[data-admin-popular]').scrollIntoViewIfNeeded(); await expect(p.locator('[data-admin-popular]').getByRole('link')).toHaveCount(2); await capture(p, `popular-${w}-${theme}`);
      await summary(p).click(); await expect(p.locator('[data-admin-numbers]')).toHaveCount(0); await summary(p).focus(); await p.keyboard.press('Enter'); await expect(p.locator('[data-admin-numbers]').getByText('Materiais cadastrados')).toBeVisible(); assert.equal(statsReads, 4); await c.close();
    }
    assert.equal(unread(), initialUnread); check('Tarefas antes dos indicadores em três tamanhos e dois temas; consultas adiadas, distribuição real, títulos longos e abertura/reabertura por teclado');
    const nc = await context(), np = await nc.newPage();
    for (const [label, url] of [['Organizar instituições', '/instituicoes'], ['Gerenciar usuários', '/admin/usuarios'], ['Responder professores', '/fale-conosco'], ['Novo material', '/admin/materiais/novo'], ['Gerenciar materiais', '/admin/materiais'], ['Gerenciar categorias', '/admin/categorias'], ['Consultar relatórios', '/admin/relatorios'], ['Histórico de ações', '/admin/atividades']]) {
      await go(np); await home(np).getByRole('link', { name: new RegExp('^' + label) }).click(); await expect(np).toHaveURL(baseUrl + url); await np.locator('main h1').waitFor();
    }
    for (const url of ['/material/' + materialId, '/simulados/' + questionSetId]) { await go(np); await openNumbers(np); await np.locator('[data-admin-popular]').locator('a[href="' + url + '"]').click(); await expect(np).toHaveURL(baseUrl + url); await np.locator('main h1').waitFor(); }
    await nc.close(); check('Todos os oito atalhos e conteúdos material/simulado chegam às rotas reais sem alteração de manutenção');
    for (const [name, pattern, selector, button] of [['attention', '**/api/reports/overview', '[data-admin-attention]', 'Atualizar atendimento'], ['numbers', '**/api/materials/stats', '[data-admin-numbers]', 'Atualizar acervo'], ['popular', '**/api/reports/top-content?*', '[data-admin-popular]', 'Atualizar conteúdos']]) {
      const c = await context(320, 600, 'dark'), p = await c.newPage(); await p.route(pattern, r => r.fulfill({ status: 503, json: { error: 'Teste' } })); await go(p); if (name !== 'attention') await openNumbers(p);
      await expect(p.locator(selector).getByRole('alert')).toBeVisible(); await p.locator(selector).scrollIntoViewIfNeeded(); await capture(p, `error-${name}`);
      await p.unroute(pattern); await p.getByRole('button', { name: button }).click(); await expect(p.locator(selector).getByRole('alert')).toHaveCount(0); await expect(p.getByRole('button', { name: button })).toBeEnabled();
      await p.route(pattern, r => r.fulfill({ json: {} })); await p.getByRole('button', { name: button }).click(); await expect(p.locator(selector).getByRole('alert')).toBeVisible(); await c.close();
    }
    check('Falha 503 e contrato HTTP 200 inválido por seção não viram contagens zero ou listas vazias; atualização manual recupera a consulta');
    const zc = await context(320, 600, 'light'), zp = await zc.newPage();
    await zp.route('**/api/reports/overview', r => r.fulfill({ json: { unreadSupportMessages: 0 } })); await zp.route('**/api/materials/stats', r => r.fulfill({ json: { total: 0, thisMonth: 0, byType: [{ name: 'PDF', count: 0 }] } })); await zp.route('**/api/reports/top-content?*', r => r.fulfill({ json: [{ id: materialId, title: 'Conteúdo nunca acessado', content_type: 'material', path: '/material/' + materialId, access_count: 0 }] }));
    await go(zp); await expect(home(zp)).toContainText('Nenhuma mensagem não lida'); await openNumbers(zp); await expect(zp.locator('[data-admin-numbers]')).toContainText('Ainda não há materiais cadastrados.'); await expect(zp.locator('[data-admin-popular]')).toContainText('Ainda não há acessos registrados'); await zp.locator('[data-admin-popular]').scrollIntoViewIfNeeded(); await capture(zp, 'zero-confirmed'); await zc.close();
    check('Zero confirmado e conteúdo sem acesso têm orientação própria, sem ranking fictício');
    const dc = await context(390, 664, 'light'), dp = await dc.newPage(); let release, started;
    const held = new Promise(r => release = r), hit = new Promise(r => started = r);
    await dp.route('**/api/materials/stats', async r => { started(); await held; await r.fulfill({ json: { total: 999, thisMonth: 0, byType: [] } }).catch(() => {}); });
    await go(dp); await summary(dp).click(); await hit; await expect(dp.locator('[data-admin-popular]').getByRole('link')).toHaveCount(2); await dp.locator('[data-admin-numbers]').scrollIntoViewIfNeeded(); await capture(dp, 'slow-numbers');
    await summary(dp).click(); release(); await dp.waitForTimeout(150); await expect(dp.locator('[data-admin-numbers]')).toHaveCount(0); await dp.unroute('**/api/materials/stats'); await openNumbers(dp); await expect(dp.locator('[data-admin-numbers]')).not.toContainText('999'); await dc.close();
    check('Consulta lenta não bloqueia a outra seção; recolher descarta a resposta atrasada e reabrir consulta novamente');
    for (const state of ['off', 'unknown']) {
      const c = await context(320, 600, 'dark'), p = await c.newPage(); await p.route('**/api/governance/features?*', async r => { if (state === 'unknown') return r.fulfill({ status: 503, json: {} }); const response = await r.fetch(), data = await response.json(); data.features['institutions.read_model'] = false; await r.fulfill({ response, json: data }); });
      await go(p); await expect(home(p).getByRole('link', { name: /Organizar instituições/ })).toHaveCount(0); await expect(home(p)).toContainText(state === 'off' ? 'não está liberada' : 'Não foi possível conferir'); await capture(p, `institutions-${state}`); await c.close();
    }
    const tc = await context(390, 664, 'light', teacher), tp = await tc.newPage(); let adminReads = 0; tp.on('request', r => { if (/\/api\/(materials\/stats|reports\/)/.test(r.url())) adminReads++; }); await go(tp); await expect(tp).toHaveURL(baseUrl + '/'); await expect(home(tp)).toHaveCount(0); assert.equal(adminReads, 0);
    const forbidden = await fetch(baseUrl + '/api/reports/overview', { headers: { Authorization: 'Bearer ' + tokenFor(teacher) } }); assert.equal(forbidden.status, 403); await tc.close();
    check('Instituições respeitam flag desconhecida/desligada; professor não acessa painel nem consulta administrativa e API mantém 403');
    const xc = await context(390, 664, 'dark'), xp = await xc.newPage(); await go(xp); let releaseLate, startedLate; const late = new Promise(r => releaseLate = r), hitLate = new Promise(r => startedLate = r);
    await xp.route('**/api/reports/overview', async r => { startedLate(); await late; await r.fulfill({ json: { unreadSupportMessages: 777 } }).catch(() => {}); }); await xp.getByRole('button', { name: 'Atualizar atendimento' }).click(); await hitLate;
    await xp.getByRole('button', { name: 'Menu do usuário' }).click(); await xp.getByRole('button', { name: 'Sair da conta' }).click(); await expect(xp).toHaveURL(baseUrl + '/login'); releaseLate(); await xp.waitForTimeout(150); await expect(home(xp)).toHaveCount(0); await expect(xp.getByText(/777/)).toHaveCount(0); await xc.close();
    check('Sair durante consulta descarta o retorno da conta anterior sem confirmar números atrasados');
    assert.deepEqual(report.pageErrors, []); assert.ok(report.reads.every(r => r.method === 'GET')); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.message; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runAdminDashboardBrowser };
