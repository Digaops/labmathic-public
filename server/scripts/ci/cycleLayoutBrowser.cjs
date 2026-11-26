const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runCycleLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.CYCLE_LAYOUT_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/cycle-layout-qa'));
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Devolutivas:', description); };
  const token = tokenFor(teacher), previewToken = tokenFor(previewUser);
  const cyclePath = `/pedagogical-cycle/classes/${classPublicId}/assessments/${assessmentPublicId}`;
  const url = `/banco-questoes/devolutivas?turma=${classPublicId}&avaliacao=${assessmentPublicId}`;
  const detail = await (await fetch(baseUrl + '/api' + cyclePath, { headers: { Authorization: 'Bearer ' + token } })).json();
  assert.ok(detail.feedback); assert.ok(detail.plans[0].monitoring.comparison);
  if (process.env.CYCLE_LAYOUT_INTERACTIVE === '1') {
    const connection = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(connection, JSON.stringify({ baseUrl, teacher, token, classPublicId, assessmentPublicId, url }));
    console.log('CYCLE_LAYOUT_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250);
      const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive fixture expired')); }, 480000);
    }); } finally { if (fs.existsSync(connection)) fs.unlinkSync(connection); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  async function context(width = 390, height = 664, theme = 'dark', user = teacher) {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c);
    await c.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await c.addInitScript(({ origin, user, token, theme }) => { if (location.origin === origin) { localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); } }, { origin: baseUrl, user, token: user.id === teacher.id ? token : previewToken, theme });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message))); return c;
  }
  async function go(p, target = url) {
    await p.goto(baseUrl + target); await p.waitForLoadState('networkidle');
    const notice = p.getByRole('button', { name: 'Entendi, continuar' });
    if (await notice.isVisible()) { await notice.click(); await p.waitForLoadState('networkidle'); }
  }
  const area = (p, label) => p.getByRole('navigation', { name: 'Áreas da devolutiva' }).getByRole('button', { name: new RegExp('^' + label) });
  const field = p => p.getByLabel('Como saber se a turma avançou?', { exact: true });
  const save = p => p.getByRole('button', { name: 'Salvar nova revisão', exact: true });
  async function capture(p, name, primary) {
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
    fs.writeFileSync(path.join(output, name + '.txt'), await p.locator('body').innerText());
    const bounds = await p.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(bounds.width, p.viewportSize().width, name + ': viewport');
    assert.ok(bounds.scrollWidth <= bounds.width + 1, name + ': overflow');
    if (primary) { const r = await primary.boundingBox(); assert.ok(r && r.y >= 0 && r.y + 24 < bounds.height, name + ': primary hidden'); }
    const controls = await p.locator('[data-pedagogical-cycle]').locator('button,a,input,select,summary').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.closest('details:not([open]) :not(summary)')).map(n => ({ text: n.textContent, w: n.getBoundingClientRect().width, h: n.getBoundingClientRect().height })));
    assert.deepEqual(controls.filter(c => c.w < 43.5 || c.h < 43.5), [], name + ': small controls');
    report.cases.push({ name, ...bounds }); record();
  }
  try {
    for (const [w,h] of [[1024,600],[390,664],[320,600]]) for (const theme of ['dark','light']) {
      const c = await context(w,h,theme), p = await c.newPage(); await go(p);
      await capture(p, `results-${w}-${theme}`, p.getByRole('button', { name: 'Ver correções', exact: true }));
      await p.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary').click();
      await capture(p, `context-${w}-${theme}`); await p.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary').click();
      await area(p, 'Meu registro').click(); await capture(p, `feedback-${w}-${theme}`, p.getByRole('heading', { name: 'Meu registro sobre a turma' }));
      await field(p).fill('Texto do professor mantido ao consultar os resultados e o plano.');
      await area(p, 'Resultados').click(); await expect(area(p, 'Meu registro')).toContainText('Não salvo');
      await area(p, 'Plano de apoio').click(); await capture(p, `plan-${w}-${theme}`, p.getByRole('heading', { name: 'Plano de apoio e verificação' }));
      await p.getByRole('heading', { name: 'Verificação com evidências' }).scrollIntoViewIfNeeded(); await capture(p, `comparison-${w}-${theme}`);
      await p.getByRole('button', { name: 'Registrar próximo passo' }).click(); await expect(area(p, 'Meu registro')).toBeFocused(); await expect(field(p)).toHaveValue('Texto do professor mantido ao consultar os resultados e o plano.');
      await save(p).scrollIntoViewIfNeeded(); await capture(p, `feedback-action-${w}-${theme}`);
      await c.close();
    }
    check('Resultados/registro/plano/contexto/comparação em 3 resoluções e 2 temas; primeira ação, alvos de toque e texto preservado');
    const c = await context(1024,600), p = await c.newPage(); await go(p);
    await area(p, 'Meu registro').click();
    await field(p).fill('Nova decisão registrada pela interface com base no trabalho em sala.');
    const initial = db.prepare('SELECT MAX(revision) FROM pedagogical_feedback_versions').pluck().get();
    const originalAudit = db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='pedagogical_feedback_saved'").pluck().get();
    await save(p).click(); await expect(p.getByText(`Revisão ${initial + 1} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='pedagogical_feedback_saved'").pluck().get(), originalAudit + 1);
    await go(p); await area(p, 'Meu registro').click(); await expect(field(p)).toHaveValue(/Nova decisão registrada/);
    await p.getByText('Consultar histórico de revisões', { exact: true }).click();
    await expect(p.getByRole('heading', { name: new RegExp(`^Revisão ${initial + 1} ·`) })).toBeVisible();
    await p.getByRole('button', { name: 'Carregar revisões anteriores' }).click(); await expect(p.getByRole('heading', { name: /^Revisão 1 ·/ })).toBeVisible();
    await p.getByRole('heading', { name: /^Revisão 1 ·/ }).scrollIntoViewIfNeeded();
    await capture(p, 'history', p.getByRole('heading', { name: /^Revisão 1 ·/ }));
    await p.getByText('Consultar histórico de revisões', { exact: true }).click();
    check('Salvar/recarregar/histórico paginado e auditoria real em banco temporário');
    // Competing tabs must not silently replace either draft.
    const other = await c.newPage(); await go(other); await area(other, 'Meu registro').click();
    await field(p).fill('Decisão salva na primeira aba para conferir o controle de versões.'); await save(p).click();
    await expect(p.getByText(`Revisão ${initial + 2} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    await field(other).fill('Texto da segunda aba permanece até o professor revisar a referência.'); await save(other).click();
    await expect(other.getByText('Existe uma revisão mais recente. Recarregue antes de salvar.', { exact: true })).toBeVisible();
    await expect(field(other)).toHaveValue(/Texto da segunda aba/); await expect(save(other)).toBeDisabled();
    await expect(other.locator('#cycle-feedback [role="alert"]')).toBeFocused();
    await other.getByRole('button', { name: /Revisei; usar referência/ }).scrollIntoViewIfNeeded();
    await capture(other, 'conflict');
    await other.getByRole('button', { name: /Revisei; usar referência/ }).click(); await save(other).click();
    await expect(other.getByText(`Revisão ${initial + 3} salva. Registro privado do professor.`, { exact: true })).toBeVisible(); await other.close();
    check('Conflito entre abas bloqueia sobrescrita e exige conciliação sem apagar texto');
    await go(p); await area(p, 'Meu registro').click(); await field(p).fill('Texto preservado se a rede falhar após o servidor concluir o salvamento.');
    const feedbackUrl = baseUrl + '/api' + cyclePath + '/feedback';
    const keys = [];
    await p.route(feedbackUrl, async route => {
      if (route.request().method() !== 'POST') return route.continue();
      keys.push(route.request().headers()['idempotency-key']);
      const response = await route.fetch(); assert.equal(response.status(),201);
      await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' });
    });
    await save(p).click(); await expect(p.getByText(/Não foi possível confirmar o salvamento/)).toBeVisible();
    await capture(p, 'uncertain-save'); await p.unroute(feedbackUrl);
    p.on('request', r => { if (r.url() === feedbackUrl && r.method() === 'POST') keys.push(r.headers()['idempotency-key']); });
    await save(p).click(); await expect(p.getByText(`Revisão ${initial + 4} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    assert.equal(keys.length, 2); assert.equal(keys[0], keys[1]);
    assert.equal(db.prepare('SELECT MAX(revision) FROM pedagogical_feedback_versions').pluck().get(),initial+4);
    check('Resposta perdida após commit: reenvio com mesma chave, uma única revisão');
    await field(p).fill('Não apagar este texto durante a indisponibilidade dos resultados.');
    const readUrl = baseUrl + '/api' + cyclePath;
    await p.route(readUrl, route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"plans":[]}' }));
    await area(p, 'Resultados').click(); await p.getByRole('button', { name: 'Atualizar resultados' }).click();
    await expect(p.getByText(/O salvamento está bloqueado/)).toBeVisible(); await area(p, 'Meu registro').click();
    await expect(save(p)).toBeDisabled(); await expect(field(p)).toHaveValue(/Não apagar este texto/); await capture(p, 'invalid-refresh');
    await p.unroute(readUrl); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(save(p)).toBeEnabled();
    await p.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary').click();
    p.once('dialog', d => d.dismiss()); await p.getByRole('button', { name: 'Trocar turma' }).click(); await expect(field(p)).toHaveValue(/Não apagar este texto/);
    p.once('dialog', d => d.dismiss()); await p.getByLabel('Aplicação da turma', { exact: true }).selectOption(''); await expect(field(p)).toHaveValue(/Não apagar este texto/);
    await p.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary').click();
    await save(p).click(); await expect(p.getByText(`Revisão ${initial + 5} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    check('Consulta inválida bloqueia escrita sem falso vazio; troca de turma e avaliação respeita recusa em perder texto');
    await area(p, 'Plano de apoio').click(); await p.getByRole('button', { name: 'Abrir plano e execução' }).click(); await expect(p.getByRole('dialog')).toBeVisible();
    await p.keyboard.press('Escape'); await expect(p.getByRole('dialog')).toHaveCount(0); await expect(p.getByRole('button', { name: 'Abrir plano e execução' })).toBeFocused();
    await p.getByRole('button', { name: 'Revisar resultados da verificação' }).click(); await expect(p.getByRole('dialog')).toBeVisible();
    await p.keyboard.press('Escape'); await expect(p.getByRole('dialog')).toHaveCount(0);
    await area(p, 'Resultados').click(); await p.getByRole('button', { name: 'Ver correções', exact: true }).click(); await expect(p.getByRole('dialog')).toBeVisible(); await p.keyboard.press('Escape');
    check('Entradas/retornos do plano e das duas telas de resultados, Escape e foco');
    // History failure while paging must keep the already loaded revisions and retry the same cursor.
    await area(p, 'Meu registro').click(); await p.getByText('Consultar histórico de revisões', { exact: true }).click();
    await expect(p.getByRole('button', { name: 'Carregar revisões anteriores' })).toBeVisible();
    await p.route(feedbackUrl + '?*', route => route.fulfill({ status:503, contentType:'application/json', body:'{}' }));
    await p.getByRole('button', { name: 'Carregar revisões anteriores' }).click(); await expect(p.getByText('Não foi possível consultar o histórico. Tente novamente.')).toBeVisible();
    await capture(p, 'history-page-error'); await p.unroute(feedbackUrl + '?*');
    await p.getByRole('button', { name: 'Tentar novamente', exact:true }).click(); await expect(p.getByRole('heading', { name:/^Revisão 1 ·/ })).toBeVisible();
    const headings = await p.locator('#cycle-feedback h3').allTextContents(); assert.equal(new Set(headings).size,headings.length);
    check('Erro na página anterior do histórico preserva revisões carregadas e repete o mesmo cursor');
    // Read-only UI variants use recorded API data, not writes to the class/assessment under test.
    await p.route(readUrl, route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...detail,plans:[],feedback:null,canSaveFeedback:false,capabilities:{...detail.capabilities,recovery:false}})}));
    await go(p); await area(p,'Plano de apoio').click(); await expect(p.getByText('A recomposição não está habilitada para esta conta.')).toBeVisible();
    await expect(p.getByRole('button',{name:'Abrir plano e execução'})).toHaveCount(0); await capture(p,'recovery-disabled');
    await p.unroute(readUrl);
    await p.route(readUrl, route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...detail,assessment:{...detail.assessment,status:'draft'},evidence:null,evidenceHash:null,feedback:null,plans:[],canSaveFeedback:false})}));
    await go(p); await expect(p.getByText(/Os resultados aparecerão após abrir/)).toBeVisible(); await capture(p,'no-evidence');
    await area(p,'Meu registro').click(); await expect(save(p)).toBeDisabled(); await p.unroute(readUrl);
    await p.route(readUrl, route => route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...detail,plans:[]})}));
    await go(p); await area(p,'Plano de apoio').click(); await expect(p.getByRole('button',{name:'Ver correções e planejar apoio'})).toBeVisible(); await capture(p,'no-plan'); await p.unroute(readUrl);
    check('Sem evidências, sem plano e recomposição desabilitada: orientação específica e escrita bloqueada quando necessário');
    await go(p, '/banco-questoes/devolutivas'); await p.getByRole('searchbox', { name: 'Buscar turma' }).fill('Não existe esta turma');
    await expect(p.getByText('Nenhuma turma encontrada para essa busca.')).toBeVisible(); await capture(p, 'search-empty');
    await p.getByRole('button', { name: 'Limpar busca' }).click(); await p.getByRole('button', { name: /1º Ano A/ }).click(); await p.getByLabel('Aplicação da turma', { exact: true }).selectOption(assessmentPublicId);
    await expect(p.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary')).toBeFocused();
    await expect(p.getByRole('button', { name: 'Ver correções', exact: true })).toBeVisible();
    await p.getByText('Etapas e cuidados com a leitura dos resultados', { exact: true }).click(); await capture(p, 'cycle-details'); await p.getByText('Etapas e cuidados com a leitura dos resultados', { exact: true }).click();
    const started = Date.now(); let iterations = 0;
    while (Date.now() - started < 30000) {
      for (const label of ['Meu registro','Plano de apoio','Resultados']) await area(p, label).click();
      await p.keyboard.press('Tab'); await p.mouse.wheel(0,200); await p.mouse.wheel(0,-200); iterations++;
    }
    report.exploration = { seconds: (Date.now()-started)/1000, iterations };
    check('Busca/vazio/limpar/seleção e detalhes; exploração adicional por teclado, rolagem e troca de áreas');
    const classesUrl=baseUrl+'/api/pedagogical-cycle/classes';
    await p.route(classesUrl+'?*',route=>route.fulfill({status:503,contentType:'application/json',body:'{}'}));
    await go(p,'/banco-questoes/devolutivas'); await expect(p.getByRole('alert')).toContainText('Não foi possível carregar');
    await expect(p.getByText('Você ainda não tem turmas cadastradas.')).toHaveCount(0); await capture(p,'classes-read-error'); await p.unroute(classesUrl+'?*');
    await p.getByRole('button',{name:'Tentar novamente',exact:true}).click(); await expect(p.getByRole('button',{name:/1º Ano A/})).toBeVisible();
    const disciplineId=db.prepare('SELECT id FROM disciplines LIMIT 1').pluck().get();
    for(let i=0;i<31;i++) {
      const response=await fetch(baseUrl+'/api/classes',{method:'POST',headers:{Authorization:'Bearer '+token,'Content-Type':'application/json'},body:JSON.stringify({name:'QA24 Turma '+String(i).padStart(2,'0'),gradeId:detail.class.gradeId,academicYear:2026,disciplineIds:[disciplineId]})}); assert.equal(response.status,201);
    }
    await go(p,'/banco-questoes/devolutivas'); await p.getByRole('button',{name:'Próxima',exact:true}).click(); await expect(p.getByText('Página 2 de 2')).toBeVisible();
    await capture(p,'class-page-two'); await p.getByRole('button',{name:'Anterior',exact:true}).click(); await expect(p.getByText('Página 1 de 2')).toBeVisible();
    // Delayed search is superseded; no stale class list can replace the current search.
    let release; const gate=new Promise(resolve=>{release=resolve;});
    await p.route(classesUrl+'?*',async route=>{if(new URL(route.request().url()).searchParams.get('search')==='QA24 Turma 00'){await gate; await route.continue().catch(()=>{});}else await route.continue();});
    const startedSearch=p.waitForRequest(r=>r.url().includes('search=QA24%20Turma%2000'));
    await p.getByRole('searchbox',{name:'Buscar turma'}).fill('QA24 Turma 00'); await startedSearch;
    await p.getByRole('searchbox',{name:'Buscar turma'}).fill('QA24 Turma 30'); await expect(p.getByRole('button',{name:/QA24 Turma 30/})).toBeVisible(); release();
    await p.waitForLoadState('networkidle'); await expect(p.getByRole('button',{name:/QA24 Turma 00/})).toHaveCount(0); await capture(p,'latest-search'); await p.unroute(classesUrl+'?*');
    check('Falha não vira turma vazia; paginação real e busca atrasada sem substituir a busca atual');
    await p.route(classesUrl+'?*',route=>route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data:[],pagination:{page:1,limit:30,total:0,totalPages:0}})}));
    await go(p,'/banco-questoes/devolutivas'); await expect(p.getByText('Você ainda não tem turmas cadastradas.')).toBeVisible();
    await expect(p.getByRole('link',{name:'Cadastrar ou revisar turmas'})).toBeVisible(); await capture(p,'classes-empty'); await p.unroute(classesUrl+'?*');
    const restricted = await context(390,664,'light',previewUser), r = await restricted.newPage();
    // Direct API remains forbidden for another teacher, irrespective of UI routes/flags.
    const denied = await fetch(baseUrl + '/api' + cyclePath, { headers: { Authorization: 'Bearer ' + previewToken } }); assert.ok([403,404].includes(denied.status));
    await go(r); await expect(r.getByRole('button', { name: 'Salvar nova revisão', exact: true })).toHaveCount(0);
    assert.doesNotMatch(await r.locator('body').innerText(), /Texto preservado se a rede|Texto da segunda aba/);
    await capture(r, 'restricted-account'); await restricted.close();
    check('Conta sem o piloto não recebe o registro nem controles de escrita');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) {
    for (const [i,p] of browser.contexts().flatMap(c => c.pages()).entries()) { await p.screenshot({ path: path.join(output, `failure-${i}.png`), scale:'css' }).catch(()=>{}); console.error(await p.locator('main').innerText().catch(()=>'')); }
    throw error;
  } finally { for (const c of contexts) await c.close().catch(()=>{}); await browser.close(); }
}
module.exports = { runCycleLayoutBrowser };
