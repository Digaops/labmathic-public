const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
const { getTypedQuestionPreviewCatalog } = require('../../src/services/typedQuestionPreview');
const { getFeedbackPreviewCatalog, getFeedbackPreviewExample } = require('../../src/services/typedQuestionFeedbackPreview');
const { getQuestionBankCatalogPreview } = require('../../src/services/questionBankCatalogPreview');

async function runDemoLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, db, output }) {
  assert.equal(process.env.DEMO_LAYOUT_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/demo-layout-qa'));
  const report = { status: 'running', syntheticDataOnly: true, cases: [], inventory: [], internal: [], pageErrors: [], writes: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Demonstrações:', description); };
  if (process.env.DEMO_LAYOUT_INTERACTIVE === '1') {
    const file = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(file, JSON.stringify({ baseUrl, user: previewUser, token: tokenFor(previewUser) }));
    console.log('DEMO_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => { const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250); const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive expired')); }, 480000); }); }
    finally { if (fs.existsSync(file)) fs.unlinkSync(file); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const formats = getTypedQuestionPreviewCatalog().examples, feedback = getFeedbackPreviewCatalog().examples, reviews = getQuestionBankCatalogPreview().items;
  const urls = { formats: '/banco-questoes/formatos', feedback: '/banco-questoes/devolutivas', review: '/banco-questoes/revisao' };
  async function context(w = 1024, h = 600, theme = 'dark', user = previewUser) {
    const c = await browser.newContext({ viewport: { width: w, height: h }, colorScheme: theme, ...(w < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c); c.setDefaultTimeout(6000);
    await c.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await c.addInitScript(({ user, token, theme, baseUrl }) => { if (location.origin !== baseUrl) return; localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); window.print = () => { window.__demoPrints = (window.__demoPrints || 0) + 1; }; }, { user, token: tokenFor(user), theme, baseUrl });
    c.on('page', p => { p.on('pageerror', e => report.pageErrors.push(e.message)); p.on('request', r => { if (/\/api\/question-bank\/(typed-preview|feedback-preview|catalog-preview)/.test(r.url()) && r.method() !== 'GET') report.writes.push(r.method() + ' ' + r.url()); }); });
    return c;
  }
  async function go(p, url) { await p.goto(baseUrl + url); await p.waitForLoadState('networkidle'); const notice = p.getByRole('button', { name: 'Entendi, continuar' }); if (await notice.isVisible()) await notice.click(); }
  const scope = p => p.locator('[data-demo-formats], [data-demo-feedback], [data-demo-review]');
  async function capture(p, name) {
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
    const m = await scope(p).evaluate(el => {
      const b = e => { const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height, right: r.right }; };
      return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, controls: [...el.querySelectorAll('input,select,button,a,summary')].filter(e => e.getClientRects().length && !e.closest('details:not([open]) :not(summary)')).map(e => ({ label: e.getAttribute('aria-label') || e.textContent.slice(0, 60), ...b(e.matches('input[type=radio],input[type=checkbox]') ? e.closest('label') : e) })) };
    });
    report.cases.push({ name, ...m }); record(); assert.ok(m.scrollWidth <= m.width + 1, name + ': horizontal overflow');
    for (const c of m.controls) { assert.ok(c.w >= 43.5 && c.h >= 43.5, name + ': target ' + c.label); assert.ok(c.x >= 0 && c.right <= m.width + 1, name + ': control overflow ' + c.label); }
  }
  try {
    for (const [w, h] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const c = await context(w, h, theme), p = await c.newPage();
      await go(p, urls.formats); await expect(p.getByLabel('Escolha um formato')).toBeVisible();
      for (const f of formats) { await p.getByLabel('Escolha um formato').selectOption(f.id); await expect(p.getByRole('heading', { name: f.definition.content.stem, exact: true })).toBeVisible(); await capture(p, 'format-' + f.type + '-' + w + '-' + theme); }
      await go(p, urls.feedback);
      for (const view of ['teacher', 'before_submission', 'after_submission', 'assessment_closed']) { await p.getByLabel('Quem está vendo e quando?').selectOption(view); await expect(p.locator('[data-demo-feedback-detail]')).toBeVisible(); await capture(p, 'feedback-' + view + '-' + w + '-' + theme); }
      await go(p, urls.review); await expect(p.locator('[data-demo-review-row]').first()).toBeVisible(); await capture(p, 'review-list-' + w + '-' + theme);
      await p.getByText('Filtros', { exact: true }).click(); await capture(p, 'review-filters-' + w + '-' + theme); await p.getByText('Filtros', { exact: true }).click();
      await p.locator('[data-demo-review-row]').first().click(); await expect(p.getByRole('button', { name: 'Imprimir esta ficha' })).toBeEnabled(); await capture(p, 'review-detail-' + w + '-' + theme); await p.getByRole('button', { name: 'Voltar aos exemplos' }).click(); await expect(p.locator('[data-demo-review-row]').first()).toBeFocused(); await c.close();
    }
    check('Sete formatos, quatro visões e catálogo/ficha em três resoluções e dois temas; alvos de 44 px e sem transbordamento');
    const c = await context(), p = await c.newPage(); await go(p, urls.formats);
    await p.getByRole('radio', { name: '1/2', exact: true }).check(); await p.getByLabel('Escolha um formato').selectOption(formats[1].id); await p.getByRole('radio', { name: 'Verdadeiro', exact: true }).check();
    await p.getByLabel('Escolha um formato').selectOption(formats[0].id); await expect(p.getByRole('radio', { name: '1/2', exact: true })).toBeChecked(); await p.getByRole('button', { name: 'Limpar respostas', exact: true }).click(); await expect(p.getByRole('radio', { name: '1/2', exact: true })).not.toBeChecked();
    await p.getByLabel('Escolha um formato').selectOption(formats[2].id); await p.getByRole('checkbox', { name: '2', exact: true }).check(); await p.getByRole('checkbox', { name: '4', exact: true }).check(); await p.getByRole('checkbox', { name: '2', exact: true }).uncheck();
    await p.getByLabel('Escolha um formato').selectOption(formats[3].id); await p.getByLabel('Valor numérico (cm)').fill('12,5');
    await p.getByLabel('Escolha um formato').selectOption(formats[4].id); await p.getByLabel('Quantidade de centenas').fill('3'); await p.getByLabel('Quantidade de dezenas').fill('4');
    await p.getByLabel('Escolha um formato').selectOption(formats[5].id); await p.getByRole('button', { name: 'Mover 0,8 para baixo', exact: true }).click(); await expect(p.locator('ol:visible li').first()).toContainText('0,5'); await expect(p.locator(':focus')).toHaveAttribute('aria-label', 'Mover 0,8 para cima'); await p.keyboard.press('Enter'); await expect(p.locator('ol:visible li').first()).toContainText('0,8');
    await p.getByLabel('Escolha um formato').selectOption(formats[6].id); await p.getByLabel('Associar 1/2 com', { exact: true }).selectOption('decimal_half'); assert.equal(await p.getByLabel('Associar 1/4 com', { exact: true }).locator('option[value=decimal_half]').evaluate(e => e.disabled), true); await p.getByLabel('Associar 1/2 com', { exact: true }).selectOption(''); assert.equal(await p.getByLabel('Associar 1/4 com', { exact: true }).locator('option[value=decimal_half]').evaluate(e => e.disabled), false);
    await p.locator('summary:visible').filter({ hasText: 'Objetivo e como responder' }).click(); await capture(p, 'format-help'); await p.getByRole('button', { name: 'Imprimir os exemplos em branco' }).click(); assert.equal(await p.evaluate(() => window.__demoPrints), 1);
    await p.pdf({ path: path.join(output, 'formatos.pdf'), preferCSSPageSize: true });
    check('Respostas locais por formato, limpar, número/lacunas, ordenação com foco e associação reversível; impressão em branco');
    await go(p, urls.feedback);
    for (const e of feedback) for (const view of ['teacher', 'before_submission', 'after_submission', 'assessment_closed']) {
      await p.getByLabel('Exemplo matemático').selectOption(e.id); await p.getByLabel('Quem está vendo e quando?').selectOption(view); await expect(p.locator('[data-demo-feedback-detail]')).toBeVisible();
      const expected = getFeedbackPreviewExample(e.id, view); if (expected.feedback.available) await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeEnabled(); else { await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeDisabled(); await expect(p.getByRole('heading', { name: /^Resposta esperada:/ })).toHaveCount(0); }
    }
    await p.getByLabel('Exemplo matemático').selectOption(feedback[0].id); await p.getByLabel('Quem está vendo e quando?').selectOption('teacher'); await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeEnabled();
    for (const label of ['Ver alternativas e objetivo', 'Ver a resolução passo a passo', 'O que essa resposta pode indicar?', 'O que observar em cada alternativa']) await p.getByText(label, { exact: true }).click(); await capture(p, 'feedback-expanded'); await p.pdf({ path: path.join(output, 'devolutiva.pdf'), preferCSSPageSize: true });
    const feedbackRoute = '**/api/question-bank/feedback-preview/examples/*'; let release, started; const ready = new Promise(r => { started = r; }), gate = new Promise(r => { release = r; });
    await p.route(feedbackRoute, async r => { started(); await gate; await r.fulfill({ status: 503, json: { error: 'Falha de teste' } }).catch(() => {}); });
    await p.getByLabel('Quem está vendo e quando?').selectOption('before_submission'); await ready; await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeDisabled(); assert.equal(await p.locator('.feedback-lab-print-root').getByText('Resposta de referência:', { exact: false }).count(), 0); release(); await expect(p.getByRole('alert')).toBeVisible(); await capture(p, 'feedback-error'); await p.unroute(feedbackRoute); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Devolutiva ainda não liberada' })).toBeVisible();
    check('Três exemplos × quatro visões; expansão das explicações; falha e atraso removem devolutiva e impressão anteriores');
    await go(p, urls.review); await p.getByLabel('Buscar exemplo').fill('EF05MA03'); await p.getByRole('button', { name: 'Buscar', exact: true }).click(); await expect(p.locator('[data-demo-review-row]').first()).toBeVisible(); await p.locator('[data-demo-review-row]').first().click(); await expect(p.getByRole('button', { name: 'Imprimir esta ficha' })).toBeEnabled();
    await p.getByText('Habilidade, autoria e uso', { exact: true }).click(); await p.getByText('Conferir os critérios da revisão', { exact: true }).click(); await capture(p, 'review-expanded'); await p.pdf({ path: path.join(output, 'revisao.pdf'), preferCSSPageSize: true }); await p.getByRole('button', { name: 'Voltar aos exemplos' }).click(); await expect(p.getByLabel('Buscar exemplo')).toHaveValue('EF05MA03'); await expect(p.locator('[data-demo-review-row]').first()).toBeFocused();
    await p.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await p.getByText('Filtros', { exact: true }).click();
    for (const label of ['Formato', 'Ano escolar', 'Unidade temática', 'Situação da revisão', 'Autoria', 'Com resolução comentada', 'Pronto para impressão', 'Compatível com diagnóstico']) { const select = p.getByLabel(label, { exact: true }); const value = await select.locator('option').nth(1).getAttribute('value'); await select.selectOption(value); await p.waitForLoadState('networkidle'); await select.selectOption(''); await p.waitForLoadState('networkidle'); }
    await p.getByLabel('Buscar exemplo').fill('sem nenhum correspondente'); await p.getByRole('button', { name: 'Buscar', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Nenhum exemplo nestes filtros' })).toBeVisible(); await capture(p, 'review-empty');
    const reviewRoute = '**/api/question-bank/catalog-preview/catalog*'; await p.route(reviewRoute, r => r.fulfill({ status: 200, json: {} })); await p.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await expect(p.getByRole('alert')).toBeVisible(); await expect(p.getByRole('heading', { name: 'Nenhum exemplo disponível' })).toHaveCount(0); await capture(p, 'review-error'); await p.unroute(reviewRoute); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.locator('[data-demo-review-row]').first()).toBeVisible();
    check('Busca, oito seletores, limpar, vazio de filtro, erro de contrato, ficha e retorno com foco; três PDFs de QA');
    const itemRoute = '**/api/question-bank/catalog-preview/items/*';
    await p.route(itemRoute, r => r.fulfill({ status: 200, json: { mode: 'question_bank_catalog_preview', synthetic: true, readOnly: true, item: {} } })); await p.locator('[data-demo-review-row]').first().click(); await expect(p.getByRole('button', { name: 'Imprimir esta ficha' })).toBeDisabled(); await expect(p.getByRole('alert')).toBeVisible(); assert.ok((await p.locator('.catalog-preview-print-root').innerText()).includes('Não há um exemplo')); await capture(p, 'review-detail-error'); await p.unroute(itemRoute); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.getByRole('button', { name: 'Imprimir esta ficha' })).toBeEnabled();
    await go(p, urls.formats); const formatRoute = '**/api/question-bank/typed-preview/catalog'; await p.route(formatRoute, r => r.fulfill({ status: 200, json: {} })); await p.reload(); await expect(p.getByRole('alert')).toBeVisible(); await expect(p.getByRole('button', { name: 'Imprimir os exemplos em branco' })).toHaveCount(0); await p.unroute(formatRoute); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.getByLabel('Escolha um formato')).toBeVisible();
    await go(p, urls.feedback + '?visao=before_submission'); let releaseTeacher, teacherStarted; const teacherReady = new Promise(r => { teacherStarted = r; }), teacherGate = new Promise(r => { releaseTeacher = r; });
    await p.route(feedbackRoute, async r => { const view = new URL(r.request().url()).searchParams.get('view'); if (view === 'teacher') { teacherStarted(); await teacherGate; } await r.fulfill({ status: 200, json: getFeedbackPreviewExample(feedback[0].id, view) }).catch(() => {}); });
    await p.getByLabel('Quem está vendo e quando?').selectOption('teacher'); await teacherReady; await p.getByLabel('Quem está vendo e quando?').selectOption('before_submission'); await expect(p.getByRole('heading', { name: 'Devolutiva ainda não liberada' })).toBeVisible(); releaseTeacher(); await p.waitForLoadState('networkidle'); await expect(p.getByRole('heading', { name: /^Resposta esperada:/ })).toHaveCount(0); await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeDisabled(); await p.unroute(feedbackRoute);
    await p.route(feedbackRoute, r => r.fulfill({ status: 200, json: getFeedbackPreviewExample(feedback[0].id, 'teacher') })); await p.reload(); await expect(p.getByRole('alert')).toBeVisible(); await expect(p.getByRole('heading', { name: /^Resposta esperada:/ })).toHaveCount(0); await expect(p.getByRole('button', { name: 'Imprimir esta devolutiva' })).toBeDisabled(); await p.unroute(feedbackRoute); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.getByRole('heading', { name: 'Devolutiva ainda não liberada' })).toBeVisible();
    check('Formato/ficha malformados, visão indevida e resposta docente atrasada recusados sem imprimir ou reapresentar conteúdo anterior');
    const operational = await context(1024, 600, 'dark', teacher), op = await operational.newPage(); await go(op, urls.feedback); await expect(op.locator('[data-demo-feedback]')).toHaveCount(0); await go(op, urls.review); await expect(op.locator('[data-question-bank]')).toBeVisible();
    const administrative = await context(390, 664, 'light', admin), ap = await administrative.newPage(); await go(ap, urls.review); await expect(ap.locator('[data-demo-review-row]').first()).toBeVisible(); await capture(ap, 'review-admin');
    check('Rotas docentes operacionais preservadas e demonstração administrativa disponível conforme as flags da fixture');
    assert.deepEqual(report.pageErrors, []); assert.deepEqual(report.writes, []); report.status = 'captured'; record(); return report;
  } catch (e) { report.status = 'failed'; report.error = e.stack; record(); throw e; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runDemoLayoutBrowser };
