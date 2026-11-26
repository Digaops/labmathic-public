const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
async function runInstitutionalNetworkBrowser({ baseUrl, teacher, admin, manager, tokenFor, db, output, mun, school }) {
  assert.equal(process.env.INSTITUTIONAL_NETWORK_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/); assert.equal(output, path.join(root, 'tmp/institutional-network-qa'));
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [], requests: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = text => { report.inventory.push(text); record(); console.log('Consulta da rede:', text); };
  let key = 0;
  async function api(url, user = admin, body) { const r = await fetch(baseUrl + '/api' + url, { method: body ? 'POST' : 'GET', headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json', 'Idempotency-Key': 'institutional-network-qa39-' + ++key }, body: body ? JSON.stringify(body) : undefined }); const result = await r.json(); assert.equal(r.ok, true, JSON.stringify(result)); return result; }
  db.prepare('UPDATE municipalities SET name=? WHERE public_id=?').run('Águas de São João', mun.publicId);
  const longSchool = 'Escola Municipal Conceição de Educação e Desenvolvimento das Comunidades do Campo';
  db.prepare('UPDATE schools SET name=? WHERE public_id=?').run(longSchool, school.publicId);
  for (let n = 0; n < 7; n++) await api(`/institutions/management/municipalities/${mun.publicId}/schools`, admin, { name: 'Unidade Municipal ' + n });
  for (let n = 0; n < 11; n++) await api('/institutions/management/municipalities', admin, { name: 'Vila de Teste ' + String(n).padStart(2, '0') });
  const schoolManagerId = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES ('Gestora de uma escola','gestora-qa39@example.invalid','hash-sintetico','professor')").run().lastInsertRowid);
  db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync('Qa39-Only-Test!', 4), schoolManagerId);
  const schoolManager = db.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(schoolManagerId);
  for (const flag of db.prepare('SELECT id FROM feature_flags').all()) db.prepare("INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES (?,?,1,'QA39 sintético',?,?)").run(flag.id, schoolManager.id, admin.id, admin.id);
  await api('/institutions/management/memberships', admin, { userId: schoolManager.id, role: 'school_manager', municipalityPublicId: mun.publicId, schoolPublicId: school.publicId });
  const adminModel = await api('/institutions/read-model'), managerModel = await api('/institutions/read-model', manager), schoolModel = await api('/institutions/read-model', schoolManager);
  assert.equal(managerModel.municipalities.length, 1); assert.equal(schoolModel.municipalities[0].schools.length, 1); assert.equal(schoolModel.municipalities[0].schools[0].name, longSchool);
  if (process.env.INSTITUTIONAL_NETWORK_INTERACTIVE === '1') {
    const file = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop'); if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(file, JSON.stringify({ baseUrl, user: admin, token: tokenFor(admin), longSchool })); console.log('INSTITUTIONAL_NETWORK_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const main = p => p.locator('main [data-institutional-network]').first();
  async function context(w = 390, h = 664, theme = 'dark', user = admin) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(8000);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort()); await c.route('**/api/announcements/current?*', r => r.fulfill({ json: { announcement: null } }));
    await c.addInitScript(({ baseUrl, theme, user, token }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); }, { baseUrl, theme, user, token: tokenFor(user) });
    c.on('page', p => { p.on('pageerror', e => report.pageErrors.push(e.message)); p.on('request', r => { if (r.url().startsWith(baseUrl + '/api/')) report.requests.push({ method: r.method(), url: r.url().replace(baseUrl, '') }); }); }); return c;
  }
  async function go(p) { await p.goto(baseUrl + '/instituicoes'); await p.waitForLoadState('networkidle'); }
  async function capture(p, name, controls = true) {
    await p.waitForTimeout(150); const metrics = await p.evaluate(() => ({ width: document.documentElement.scrollWidth, viewport: innerWidth, controls: [...document.querySelectorAll('[data-institutional-network] button,[data-institutional-network] input,[data-institutional-network] select,[data-institutional-network] summary')].filter(e => e.getClientRects().length && e.checkVisibility() && !e.closest('[data-network-management]')).map(e => ({ text: e.textContent || e.id, height: e.getBoundingClientRect().height })) }));
    assert.ok(metrics.width <= metrics.viewport + 1, name + ' overflow'); if (controls) assert.deepEqual(metrics.controls.filter(c => c.height < 43.5), [], name + ' targets');
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); report.cases.push({ name, ...metrics }); record();
  }
  try {
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['light', 'dark']) for (const [role, user] of [['admin', admin], ['manager', manager], ['school-manager', schoolManager]]) {
      const c = await context(w, h, theme, user), p = await c.newPage(); const start = report.requests.length; await go(p); await expect(main(p).getByRole('heading', { name: role === 'admin' ? 'Escolas e rede' : 'Minha rede', exact: true })).toBeVisible();
      const first = await main(p).locator('[data-network-municipality]').first().boundingBox(); assert.ok(first && first.y >= 0 && first.y + first.height <= h, role + w + ' first municipality');
      assert.equal(report.requests.slice(start).filter(r => r.url === '/api/institutions/management').length, 0);
      if (role !== 'admin') { await expect(main(p)).not.toContainText('Vila de Teste'); await expect(main(p).getByRole('button', { name: 'Cadastros e turmas' })).toHaveCount(0); }
      if (role === 'school-manager') await expect(main(p)).not.toContainText('Unidade Municipal');
      if (role !== 'admin') await expect(main(p).getByLabel('Filtrar município')).toHaveCount(0);
      const firstSchool = await main(p).getByRole('heading', { name: longSchool, exact: true }).boundingBox(); assert.ok(firstSchool && firstSchool.y + firstSchool.height <= h, role + w + ' first school title');
      await capture(p, `${role}-${w}-${theme}`); await main(p).getByRole('region', { name: 'Consulta de municípios e escolas' }).getByText('Vínculos por função', { exact: true }).first().click(); await capture(p, `${role}-details-${w}-${theme}`); await c.close();
    }
    check('Administração, gestão municipal e escolar nos três tamanhos/dois temas; primeiro município, alvos de 44 px e isolamento real por vínculo');
    const c = await context(320, 600), p = await c.newPage(); await go(p);
    const region = main(p).getByRole('region', { name: 'Consulta de municípios e escolas' });
    const total = await api('/institutions/read-model'); const start = report.requests.length;
    await main(p).getByRole('searchbox').fill('conceicao'); await expect(region.getByRole('heading', { name: longSchool, exact: true })).toBeVisible(); await expect(region).not.toContainText('Unidade Municipal'); await capture(p, 'search-school');
    await main(p).getByLabel('Filtrar município').selectOption({ label: 'Vila de Teste 00' }); await expect(region).toContainText('Nenhum município ou escola encontrado'); await capture(p, 'search-empty'); await main(p).getByRole('button', { name: 'Limpar busca' }).click(); await expect(main(p).getByRole('searchbox')).toBeFocused();
    await main(p).getByRole('searchbox').fill('aguas de sao joao'); await expect(region.getByRole('heading', { name: 'Águas de São João', exact: true })).toBeVisible(); await main(p).getByRole('button', { name: 'Limpar busca' }).click();
    await main(p).getByRole('button', { name: /Mostrar mais municípios/ }).click(); assert.equal(await main(p).locator('[data-network-municipality]').count(), total.municipalities.length); await main(p).getByRole('button', { name: /Mostrar mais escolas/ }).click(); await expect(region.getByRole('heading', { name: 'Unidade Municipal 6', exact: true })).toBeVisible(); await capture(p, 'schools-expanded');
    assert.equal(report.requests.slice(start).filter(r => r.url.includes('/institutions/read-model')).length, 0);
    await main(p).locator('[data-network-totals] > summary').click(); await expect(main(p).locator('[data-network-totals]')).toContainText('Profissionais vinculados'); await capture(p, 'summary'); await main(p).locator('[data-network-totals]').getByText('Vínculos por função', { exact: true }).click(); await capture(p, 'role-totals'); await main(p).locator('[data-network-totals]').getByText('Vínculos por função', { exact: true }).click(); await main(p).locator('[data-network-totals] > summary').click();
    await main(p).getByText('Como ler estes dados', { exact: true }).click(); await capture(p, 'explanations'); await main(p).getByText('Como ler estes dados', { exact: true }).click(); check('Busca sem acento, filtro combinado, limpar, listas progressivas e detalhes ida/volta sem consultas adicionais nem alteração dos totais');
    await main(p).getByRole('button', { name: 'Cadastros e turmas', exact: true }).click(); await expect(main(p).getByRole('heading', { name: 'Cadastrar município', exact: true })).toBeVisible(); const management = main(p).locator('[data-network-management]'); await management.getByRole('button', { name: 'Incluir manualmente', exact: true }).first().click(); await management.getByLabel('Nome do município', { exact: true }).fill('Rascunho local de consulta QA39'); await management.locator(':scope > summary').click(); await management.locator(':scope > summary').click(); await expect(management.getByLabel('Nome do município', { exact: true })).toHaveValue('Rascunho local de consulta QA39'); await main(p).getByRole('button', { name: 'Atualizar', exact: true }).click(); await expect(main(p).getByRole('button', { name: 'Atualizar', exact: true })).toBeEnabled(); await expect(management.getByLabel('Nome do município', { exact: true })).toHaveValue('Rascunho local de consulta QA39');
    for (const title of ['Cadastrar município', 'Adicionar escola', 'Cadastrar ou vincular profissional', 'Preparar turma para o professor']) await expect(management.getByRole('heading', { name: title, exact: true, includeHidden: true })).toBeAttached(); await capture(p, 'management-draft', false); await management.locator(':scope > summary').click(); check('Cadastros carregam ao abrir, conservam os quatro fluxos e mantêm preenchimento após recolher/reabrir e atualizar a consulta');
    await c.close();
    for (const [name, response] of [['error', { status: 503, json: { error: 'Falha sintética' } }], ['invalid', { json: {} }]]) {
      const c = await context(), p = await c.newPage(); await c.route('**/api/institutions/read-model', r => r.fulfill(response)); await go(p); await expect(main(p).getByRole('alert')).toContainText('Não foi possível consultar'); await expect(main(p).locator('[data-network-municipality]')).toHaveCount(0); await capture(p, name); await c.unroute('**/api/institutions/read-model'); await main(p).getByRole('button', { name: 'Tentar novamente' }).click(); await expect(main(p).locator('[data-network-municipality]').first()).toBeVisible(); await c.route('**/api/institutions/read-model', r => r.fulfill(response)); await main(p).getByRole('button', { name: 'Atualizar', exact: true }).click(); await expect(main(p).getByRole('alert')).toContainText('última consulta'); await expect(main(p).locator('[data-network-municipality]').first()).toBeVisible(); await capture(p, name + '-refresh'); await c.unroute('**/api/institutions/read-model'); await main(p).getByRole('button', { name: 'Atualizar', exact: true }).click(); await expect(main(p).getByRole('alert')).toHaveCount(0); await c.close();
    }
    check('Falha e resposta inválida não viram zero; recuperação, atualização com aviso de dados antigos e preservação da tela');
    {
      const c = await context(), p = await c.newPage(), empty = structuredClone(adminModel); empty.municipalities = []; Object.keys(empty.summary).forEach(k => { if (typeof empty.summary[k] === 'number') empty.summary[k] = 0; }); Object.keys(empty.summary.roleCoverage).forEach(k => empty.summary.roleCoverage[k] = 0); await c.route('**/api/institutions/read-model', r => r.fulfill({ json: empty })); await go(p); await expect(main(p)).toContainText('Nenhum município disponível'); await capture(p, 'network-empty'); await c.close();
      const mc = await context(390, 664, 'dark', schoolManager), mp = await mc.newPage(); await go(mp); await main(mp).getByRole('button', { name: 'Minhas confirmações' }).click(); await expect(main(mp)).not.toContainText('Cadastrar município'); await capture(mp, 'manager-confirmations', false); await mc.close();
    }
    {
      const c = await context(), p = await c.newPage(); await c.route('**/api/governance/features?*', async r => { const response = await r.fetch(), value = await response.json(); value.features['institutions.management_pilot'] = false; await r.fulfill({ json: value }); }); await go(p); await expect(main(p).getByRole('button', { name: 'Cadastros e turmas' })).toHaveCount(0); await main(p).getByText('Como ler estes dados', { exact: true }).click(); await expect(main(p)).toContainText('Somente consulta'); await capture(p, 'read-only'); await c.close();
    }
    check('Rede vazia, gestor sem cadastro administrativo e flag operacional desligada preservam a consulta e orientações');
    {
      const c = await context(), p = await c.newPage(); let release; const held = new Promise(resolve => release = resolve); await c.route('**/api/institutions/read-model', async r => { await held; await r.fulfill({ json: adminModel }).catch(() => {}); }); await p.goto(baseUrl + '/instituicoes'); await expect(main(p)).toContainText('Consultando a rede'); await capture(p, 'loading'); release(); await expect(main(p).locator('[data-network-municipality]').first()).toBeVisible(); await c.unroute('**/api/institutions/read-model');
      let releaseRefresh; const refreshHold = new Promise(resolve => releaseRefresh = resolve); await c.route('**/api/institutions/read-model', async r => { await refreshHold; await r.fulfill({ json: adminModel }).catch(() => {}); }); await main(p).getByRole('button', { name: 'Atualizar', exact: true }).click(); await expect(main(p)).toContainText('A lista atual continua disponível'); await capture(p, 'refreshing'); await p.getByRole('button', { name: 'Menu do usuário', exact: true }).click(); await p.getByRole('button', { name: /Sair/ }).click(); await expect(p).toHaveURL(/\/login/); await c.unroute('**/api/institutions/read-model');
      await p.getByLabel('E-mail', { exact: true }).fill(schoolManager.email); await p.getByLabel('Senha', { exact: true }).fill('Qa39-Only-Test!'); await p.getByRole('button', { name: 'Entrar no sistema', exact: true }).click(); await expect(p).toHaveURL(baseUrl + '/'); await p.getByRole('button', { name: 'Abrir menu', exact: true }).click(); await p.getByRole('link', { name: 'Minha rede', exact: true }).click(); await expect(main(p).getByRole('heading', { name: 'Minha rede', exact: true })).toBeVisible(); releaseRefresh(); await p.waitForTimeout(250); await expect(main(p)).not.toContainText('Vila de Teste'); await expect(main(p)).not.toContainText('Unidade Municipal'); await expect(main(p)).not.toContainText('Cadastros e turmas'); await capture(p, 'account-switched'); await c.close();
    }
    check('Consulta lenta e atualização têm estados próprios; sair e entrar como gestora descarta resposta atrasada da administração');
    {
      const c = await context(390, 664, 'light', teacher), p = await c.newPage(); await go(p); await expect(p.getByRole('heading', { name: 'Minha escola e minhas turmas' })).toBeVisible(); await expect(p.getByRole('heading', { name: 'Minhas turmas', exact: true })).toBeVisible(); await expect(p.getByRole('button', { name: 'Cadastros e turmas' })).toHaveCount(0); await capture(p, 'teacher-regression'); await c.close();
    }
    check('Visão docente permanece própria, com turmas e confirmações, sem controles administrativos');
    {
      const c = await context(), p = await c.newPage(); await go(p); await c.route('**/api/institutions/read-model', r => r.fulfill({ status: 403, json: { error: 'Acesso removido para QA' } })); await main(p).getByRole('button', { name: 'Atualizar', exact: true }).click(); await expect(main(p).getByRole('alert')).toBeVisible(); await expect(main(p).locator('[data-network-municipality]')).toHaveCount(0); await capture(p, 'access-revoked'); await c.close();
      const off = await context(), op = await off.newPage(); const start = report.requests.length; await off.route('**/api/governance/features?*', async r => { const response = await r.fetch(), value = await response.json(); value.features['institutions.read_model'] = false; await r.fulfill({ json: value }); }); await go(op); await expect(op).toHaveURL(baseUrl + '/'); await expect(op.locator('[data-network-municipality]')).toHaveCount(0); assert.equal(report.requests.slice(start).filter(r => r.url === '/api/institutions/read-model').length, 0); await off.close();
    }
    check('Permissão removida limpa dados da tela; flag de consulta desligada não consulta nem mostra a rede');

    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.requests.filter(r => r.method !== 'GET' && !['/api/auth/logout', '/api/auth/login'].includes(r.url)), []); report.status = 'captured'; record(); console.log(JSON.stringify({ status: report.status, scenarios: report.inventory.length, captures: report.cases.length, pageErrors: report.pageErrors })); return report;
  } catch (error) { report.status = 'failed'; report.error = error.stack; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runInstitutionalNetworkBrowser };
