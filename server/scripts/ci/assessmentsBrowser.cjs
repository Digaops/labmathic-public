const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runAssessmentsBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.ASSESSMENTS_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Aplicações:', description); };
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const appPath = `/turmas?turma=${classPublicId}&secao=avaliacoes`;
  const main = p => p.locator('[data-class-assessments]');
  const dialog = p => p.getByRole('dialog').last();
  async function context(width = 390, height = 664, theme = 'dark', user = teacher) {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c);
    await c.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await c.addInitScript(({ origin, user, token, theme }) => { if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    c.on('page', p => p.on('pageerror', error => report.pageErrors.push(error.message))); return c;
  }
  async function go(p, url = appPath) {
    await p.goto(baseUrl + url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(550);
    const notice = p.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    await p.waitForLoadState('networkidle'); await p.waitForTimeout(150);
  }
  async function capture(p, name, primary = null) {
    await p.waitForTimeout(200);
    const metrics = await p.evaluate(() => {
      const box = e => { const r = e?.getBoundingClientRect(); return r && { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height }; };
      const panel = [...document.querySelectorAll('[role="dialog"]')].at(-1), scope = panel || document.querySelector('[data-class-assessments]') || document.querySelector('[data-classes]');
      return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, panel: box(panel), panelWidth: panel?.clientWidth, panelScrollWidth: panel?.scrollWidth,
        controls: [...scope.querySelectorAll('button,a,input,select,summary')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 55), ...box(e.matches('input[type=checkbox],input[type=radio]') ? e.closest('label') || e : e) })) };
    });
    if (primary) metrics.primary = await primary.boundingBox();
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, name + '.txt'), await p.locator('body').innerText());
    report.cases.push({ id: name, ...metrics }); record();
    assert.ok(metrics.documentWidth <= metrics.width, name + ': document fits');
    if (metrics.panel) { assert.ok(metrics.panel.y >= 0 && metrics.panel.bottom <= metrics.height, name + ': dialog fits'); assert.ok(metrics.panelScrollWidth <= metrics.panelWidth + 1, name + ': dialog reflows'); }
    if (primary) assert.ok(metrics.primary && metrics.primary.y >= 0 && metrics.primary.y + metrics.primary.height <= metrics.height, name + ': primary action visible');
    for (const c of metrics.controls) { assert.ok(c.width >= 44 && c.height >= 44, name + ': target ' + c.label); assert.ok(c.x >= 0 && c.right <= metrics.width + 1, name + ': control bounds ' + c.label); }
  }
  async function api(url, method = 'GET', body, user = teacher) {
    const r = await fetch(baseUrl + '/api' + url, { method, headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  const article = (p, title) => main(p).locator('article').filter({ has: p.getByRole('heading', { name: title, exact: true }) }).last();
  async function showResults(p, title) { await article(p, title).getByRole('button', { name: 'Corrigir e analisar resultados', exact: true }).click(); await expect(dialog(p).locator('[data-result-participant]').first()).toBeVisible(); }
  async function confirmDelivery(p, row, name, submit = name) {
    await row.getByRole('button', { name, exact: true }).click(); await dialog(p).getByRole('checkbox').check(); await dialog(p).getByRole('button', { name: submit, exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
  }
  try {
    const sourceTitle = db.prepare('SELECT title_snapshot FROM class_assessment_assignments WHERE public_id=?').pluck().get(assessmentPublicId);
    const currentSourceTitle = db.prepare('SELECT q.title FROM question_sets q JOIN class_assessment_assignments a ON a.source_question_set_id=q.id WHERE a.public_id=?').pluck().get(assessmentPublicId);
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const c = await context(width, height, theme), p = await c.newPage(); await go(p);
      await expect(main(p).locator('article').first()).toBeVisible(); await capture(p, `applications-${width}-${theme}`, main(p).getByRole('button', { name: 'Nova aplicação', exact: true }));
      await showResults(p, sourceTitle); await capture(p, `results-${width}-${theme}`, dialog(p).getByRole('button', { name: 'Ver correção', exact: true }).first());
      await dialog(p).getByRole('tab', { name: 'Questões', exact: true }).focus(); await p.keyboard.press('Enter'); await capture(p, `questions-${width}-${theme}`);
      await p.keyboard.press('ArrowRight'); await expect(dialog(p).getByRole('tab', { name: 'Habilidades BNCC' })).toHaveAttribute('aria-selected', 'true'); await capture(p, `skills-${width}-${theme}`);
      await p.keyboard.press('Home'); await expect(dialog(p).getByRole('tab', { name: 'Estudantes', exact: true })).toHaveAttribute('aria-selected', 'true');
      const summary = dialog(p).locator('summary').filter({ hasText: 'Resumo e como interpretar' }); await summary.click(); await capture(p, `summary-${width}-${theme}`); await summary.click();
      await dialog(p).getByRole('button', { name: 'Ver correção', exact: true }).first().click(); await expect(dialog(p)).toContainText('Correção concluída — respostas não podem ser alteradas');
      await expect(dialog(p).getByRole('button', { name: 'Salvar e corrigir' })).toHaveCount(0); assert.ok(await dialog(p).getByRole('radio').evaluateAll(radios => radios.every(r => r.matches(':disabled'))));
      await capture(p, `correction-${width}-${theme}`, dialog(p).locator('[data-correction-question]').first().getByRole('radio').first().locator('..'));
      await p.keyboard.press('Escape'); await expect(dialog(p).locator('[data-results-summary]')).toBeVisible(); await p.keyboard.press('Escape'); await expect(p.getByRole('dialog')).toHaveCount(0); await c.close();
    }
    check('Lista, resultados, questões, habilidades, resumo opcional e correção imutável: três resoluções × dois temas; teclado e primeira ação visível');

    const c = await context(320, 600), p = await c.newPage(); await go(p);
    await main(p).getByRole('button', { name: 'Nova aplicação', exact: true }).click(); await expect(dialog(p)).toContainText('Etapa 1 de 4'); await capture(p, 'wizard-source');
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p).getByRole('alert')).toContainText('Escolha');
    await dialog(p).getByRole('textbox', { name: 'Buscar simulado' }).fill('nada corresponde'); await expect(dialog(p)).toContainText('Nenhum simulado'); await dialog(p).getByRole('textbox', { name: 'Buscar simulado' }).fill('');
    const sourceButton = dialog(p).getByRole('button', { pressed: false }).filter({ has: p.locator('strong').filter({ hasText: currentSourceTitle }) }).first(); await sourceButton.click();
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p)).toContainText('Etapa 2 de 4'); await capture(p, 'wizard-students');
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p).getByRole('alert')).toContainText('Selecione');
    await dialog(p).getByRole('textbox', { name: 'Buscar estudante' }).fill('Alice'); await dialog(p).getByRole('button', { name: 'Selecionar visíveis' }).click(); await dialog(p).getByRole('button', { name: 'Desmarcar visíveis' }).click(); await dialog(p).getByRole('textbox', { name: 'Buscar estudante' }).fill(''); await dialog(p).getByRole('button', { name: 'Selecionar visíveis' }).click();
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p)).toContainText('Etapa 3 de 4'); await capture(p, 'wizard-configuration');
    await dialog(p).getByRole('spinbutton').fill('3'); await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p).getByRole('alert')).toContainText('5 e 300');
    await dialog(p).getByRole('spinbutton').fill('30'); await dialog(p).getByRole('textbox', { name: /^Orientações aos estudantes/ }).fill('Orientações sintéticas para a turma.');
    await dialog(p).getByRole('checkbox', { name: 'Questões', exact: true }).check(); await dialog(p).getByRole('checkbox', { name: 'Alternativas', exact: true }).check();
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(p)).toContainText('Etapa 4 de 4'); await capture(p, 'wizard-review');
    await dialog(p).getByRole('button', { name: 'Voltar', exact: true }).click(); await expect(dialog(p).getByRole('spinbutton')).toHaveValue('30'); await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click();
    let writes = 0, release; const gate = new Promise(resolve => { release = resolve; });
    const createUrl = baseUrl + `/api/classes/${classPublicId}/assessments`;
    await c.route(createUrl, async route => { if (route.request().method() !== 'POST') return route.continue(); writes++; await gate; await route.continue(); });
    await dialog(p).getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await expect(dialog(p).getByRole('button', { name: 'Fechar' })).toBeDisabled(); await p.keyboard.press('Escape'); await expect(dialog(p)).toBeVisible(); release(); await expect(p.getByRole('dialog')).toHaveCount(0); assert.equal(writes, 1); await c.unroute(createUrl);
    const created = db.prepare('SELECT * FROM class_assessment_assignments ORDER BY id DESC LIMIT 1').get(); assert.equal(created.status, 'draft'); const row = main(p).locator('article').filter({ hasText: 'Rascunho' }).first();
    await row.getByRole('button', { name: /^Editar / }).click(); await expect(dialog(p)).toContainText('Etapa 2 de 4'); await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await dialog(p).getByRole('textbox', { name: /^Orientações aos estudantes/ }).fill('Orientações revisadas.'); await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await dialog(p).getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
    check('Preparação completa por quatro etapas, busca/seleção, validações, configurações, criação/edição de rascunho; sem divulgação ou escrita repetida');

    await row.getByRole('button', { name: 'Disponibilizar', exact: true }).click(); await capture(p, 'delivery-now'); await dialog(p).getByRole('button', { name: /^Agendar/ }).click();
    await expect(dialog(p).getByRole('button', { name: 'Confirmar agendamento' })).toBeDisabled();
    const tomorrow = new Date(Date.now() + 86400000), localTomorrow = new Date(tomorrow.getTime() - tomorrow.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await dialog(p).getByLabel('Abertura', { exact: true }).fill(localTomorrow); await dialog(p).getByRole('checkbox').check(); await capture(p, 'delivery-schedule'); await dialog(p).getByRole('button', { name: 'Confirmar agendamento' }).scrollIntoViewIfNeeded(); await capture(p, 'delivery-confirm-action', dialog(p).getByRole('button', { name: 'Confirmar agendamento' })); await dialog(p).getByRole('button', { name: 'Confirmar agendamento' }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
    let scheduled = main(p).locator('article').filter({ hasText: 'Agendado' }).first(); await confirmDelivery(p, scheduled, 'Retirar agendamento', 'Voltar ao rascunho');
    await row.getByRole('button', { name: 'Disponibilizar', exact: true }).click(); await dialog(p).getByRole('button', { name: /^Agora/ }).click(); await dialog(p).getByRole('checkbox').check(); await dialog(p).getByRole('button', { name: 'Disponibilizar agora', exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
    let liveRow = main(p).locator('article').filter({ hasText: 'Disponível' }).first(); await liveRow.getByRole('button', { name: 'Corrigir e analisar resultados' }).click(); await expect(dialog(p).locator('[data-result-participant]')).toHaveCount(3);
    await dialog(p).getByRole('tab', { name: 'Questões', exact: true }).click(); await expect(dialog(p)).toContainText('Conclua ao menos uma correção'); await capture(p, 'results-empty'); await dialog(p).getByRole('tab', { name: 'Estudantes', exact: true }).click();
    await dialog(p).getByRole('button', { name: 'Lançar respostas', exact: true }).first().click(); await expect(dialog(p).locator('[data-correction-question]')).not.toHaveCount(0);
    await dialog(p).locator('[data-correction-question]').first().getByRole('radio').first().check(); p.once('dialog', d => d.dismiss()); await p.keyboard.press('Escape'); await expect(dialog(p).locator('[data-correction-entry]')).toBeVisible();
    await capture(p, 'correction-draft'); await dialog(p).getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await expect(dialog(p).getByRole('status')).toContainText('Rascunho salvo');
    const entryPath = `/classes/${classPublicId}/assessments/${created.public_id}/results/participants/`;
    await c.route(new RegExp('/api' + entryPath), async route => { if (route.request().method() !== 'PUT') return route.continue(); const result = await route.fetch(); assert.equal(result.status(), 200); await route.fulfill({ status: 503, json: {} }); });
    await dialog(p).locator('[data-correction-question]').first().getByRole('radio', { name: 'Em branco' }).check(); await dialog(p).getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await expect(dialog(p).getByRole('alert')).toContainText('Não foi possível confirmar'); await capture(p, 'correction-uncertain');
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Recarregar correção' }).click(); await expect(dialog(p).getByRole('alert')).toHaveCount(0); await c.unroute(new RegExp('/api' + entryPath));
    await dialog(p).locator('[data-correction-question]').first().getByRole('radio').first().check(); p.once('dialog', d => d.dismiss()); await dialog(p).getByRole('button', { name: 'Salvar e corrigir' }).click(); await expect(dialog(p).getByRole('button', { name: 'Salvar e corrigir' })).toBeVisible();
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Salvar e corrigir' }).click(); await expect(dialog(p)).toContainText('Correção concluída — respostas não podem ser alteradas'); await capture(p, 'correction-submitted');
    await p.keyboard.press('Escape'); await expect(dialog(p)).toContainText('1 corrigidos'); await p.keyboard.press('Escape');
    await liveRow.getByRole('button', { name: 'Acessos dos estudantes', exact: true }).click(); await expect(dialog(p)).toBeVisible(); await p.keyboard.press('Escape');
    await confirmDelivery(p, liveRow, 'Encerrar', 'Encerrar agora'); assert.equal(db.prepare('SELECT status FROM class_assessment_assignments WHERE id=?').pluck().get(created.id), 'closed');
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_attempts WHERE assignment_id=? AND status=?').pluck().get(created.id, 'submitted'), 1);
    const audit = new Set(db.prepare('SELECT action FROM activity_log WHERE user_id=? AND entity_type=? AND entity_id=?').all(teacher.id, 'class_assessment', created.id).map(row => row.action));
    for (const action of ['create_class_assessment', 'update_class_assessment', 'schedule_class_assessment', 'return_class_assessment_to_draft', 'open_class_assessment', 'close_class_assessment']) assert.ok(audit.has(action), 'Audit preserved: ' + action);
    const attempt = db.prepare('SELECT id FROM class_assessment_attempts WHERE assignment_id=? AND status=?').get(created.id, 'submitted');
    assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE user_id=? AND entity_id=? AND action='submit_assessment_results'").pluck().get(teacher.id, attempt.id), 1);
    check('Agendar/retirar/abrir/encerrar, resultados vazios, salvar/resposta perdida/recarregar, saída com alterações, confirmação de correção e resultado somente leitura');

    await go(p); await showResults(p, sourceTitle); const recovery = dialog(p).getByRole('button', { name: 'Revisar recomposição', exact: true });
    if (await recovery.count()) { await recovery.click(); await expect(dialog(p)).toContainText('recomposição'); await dialog(p).getByRole('button', { name: 'Voltar aos resultados', exact: true }).first().click(); await expect(dialog(p).locator('[data-results-summary]')).toBeVisible(); await p.keyboard.press('Escape'); } else await p.keyboard.press('Escape');
    const primarySourceId = db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE public_id=?').pluck().get(assessmentPublicId);
    for (let n = 0; n < 6; n++) assert.equal((await api(`/classes/${classPublicId}/students`, 'POST', { displayName: `Estudante ${n} com nome completo longo para verificar a chamada`, externalReference: `ASSESS-QA-${n}` })).status, 201);
    const larger = (await api(`/classes/${classPublicId}/assessments/bootstrap`)).data;
    const extra = await api(`/classes/${classPublicId}/assessments`, 'POST', { sourceQuestionSetId: primarySourceId, participantIds: larger.participants.map(p => p.id) }); assert.equal(extra.status, 201);
    await go(p); const extraRow = main(p).locator(`[data-assessment-id="${extra.data.id}"]`);
    await extraRow.getByRole('button', { name: /^Editar / }).click();
    // Advance the server revision only after the old revision reached the editor.
    await expect(dialog(p).getByRole('heading', { name: 'Quem participará?', exact: true })).toBeVisible();
    db.prepare('UPDATE class_assessment_assignments SET revision=revision+1 WHERE public_id=?').run(extra.data.id);
    await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await dialog(p).getByRole('textbox', { name: /^Orientações aos estudantes/ }).fill('Rascunho mantido em caso de conflito.'); await dialog(p).getByRole('button', { name: 'Continuar', exact: true }).click(); await dialog(p).getByRole('button', { name: 'Salvar rascunho', exact: true }).click(); await expect(dialog(p).getByRole('alert')).toBeVisible(); await capture(p, 'draft-conflict');
    await dialog(p).getByRole('button', { name: 'Voltar', exact: true }).click(); await expect(dialog(p).getByRole('textbox', { name: /^Orientações aos estudantes/ })).toHaveValue('Rascunho mantido em caso de conflito.'); await p.keyboard.press('Escape');
    await extraRow.getByRole('button', { name: 'Disponibilizar', exact: true }).click(); await dialog(p).getByRole('button', { name: 'Agendar', exact: true }).click(); await dialog(p).getByLabel('Abertura', { exact: true }).fill(localTomorrow); await dialog(p).getByRole('checkbox').check(); await dialog(p).getByRole('button', { name: 'Confirmar agendamento', exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(0);
    await confirmDelivery(p, extraRow, 'Abrir agora', 'Disponibilizar agora');
    await extraRow.getByRole('button', { name: 'Corrigir e analisar resultados' }).click(); await expect(dialog(p).locator('[data-result-participant]')).toHaveCount(9); await capture(p, 'results-many');
    await dialog(p).getByRole('textbox', { name: 'Buscar estudante nos resultados' }).fill('Estudante 5'); await expect(dialog(p).locator('[data-result-participant]')).toHaveCount(1); await capture(p, 'results-search');
    await dialog(p).getByRole('textbox', { name: 'Buscar estudante nos resultados' }).fill('Sem correspondência'); await expect(dialog(p)).toContainText('Nenhum estudante encontrado'); await dialog(p).getByRole('textbox', { name: 'Buscar estudante nos resultados' }).fill(''); await p.keyboard.press('Escape');
    await extraRow.getByRole('button', { name: 'Cancelar', exact: true }).click(); await capture(p, 'delivery-cancel'); await dialog(p).getByRole('button', { name: 'Voltar', exact: true }).click(); await expect(extraRow).toContainText('Disponível'); await confirmDelivery(p, extraRow, 'Cancelar', 'Cancelar aplicação'); await expect(extraRow).toContainText('Cancelado');
    const extraDbId = db.prepare('SELECT id FROM class_assessment_assignments WHERE public_id=?').pluck().get(extra.data.id);
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_participants WHERE assignment_id=?').pluck().get(extraDbId), 9);
    check('Auditoria, rascunho com conflito preservado, nove participantes/nomes longos, busca/limpeza e cancelamento explícito sem apagar participantes');
    await c.close();
    for (const [name, endpoint, status, body] of [['list-failed', `/classes/${classPublicId}/assessments`, 503, {}], ['list-invalid', `/classes/${classPublicId}/assessments`, 200, {}], ['results-failed', `/classes/${classPublicId}/assessments/${assessmentPublicId}/results`, 503, {}], ['results-invalid', `/classes/${classPublicId}/assessments/${assessmentPublicId}/results`, 200, {}]]) {
      const c = await context(), p = await c.newPage(); let fail = true; await c.route(baseUrl + '/api' + endpoint, route => fail ? route.fulfill({ status, json: body }) : route.continue()); await go(p);
      if (name.startsWith('results')) await article(p, sourceTitle).getByRole('button', { name: 'Corrigir e analisar resultados' }).click();
      await expect(p.getByRole('alert').first()).toBeVisible(); await capture(p, name); fail = false; await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(p.getByRole('alert')).toHaveCount(0); await c.close();
    }
    assert.equal((await api(`/classes/${classPublicId}/assessments`, 'GET', null, previewUser)).status, 404);
    assert.equal((await api(`/classes/${classPublicId}/assessments`, 'GET', null, admin)).status, 403);
    const delayed = await context(), dp = await delayed.newPage(); await go(dp); await showResults(dp, sourceTitle);
    let finishRead; const holdRead = new Promise(resolve => { finishRead = resolve; });
    await delayed.route(new RegExp(`/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/participants/`), async route => { await holdRead; await route.continue().catch(() => {}); });
    await dialog(dp).getByRole('button', { name: 'Ver correção', exact: true }).first().click(); await dialog(dp).getByRole('button', { name: 'Fechar' }).click(); finishRead(); await dp.waitForTimeout(300); await expect(dp.getByRole('dialog')).toHaveCount(0); await delayed.close();
    check('Erros HTTP e payload inválido sem falso vazio, repetição explícita, outro professor/admin sem acesso aos dados docentes');
    const light = await context(390, 664, 'light'), lp = await light.newPage(); await go(lp);
    await main(lp).getByRole('button', { name: 'Nova aplicação', exact: true }).click();
    await dialog(lp).getByRole('button', { name: 'Continuar', exact: true }).focus(); await lp.keyboard.press('Tab'); await expect(dialog(lp).getByRole('button', { name: 'Fechar', exact: true })).toBeFocused();
    await capture(lp, 'wizard-source-light');
    await dialog(lp).getByRole('button', { pressed: false }).filter({ has: lp.locator('strong').filter({ hasText: currentSourceTitle }) }).first().click(); await dialog(lp).getByRole('button', { name: 'Continuar', exact: true }).click();
    await dialog(lp).getByRole('checkbox').first().check(); await capture(lp, 'wizard-students-light'); await dialog(lp).getByRole('button', { name: 'Continuar', exact: true }).click(); await capture(lp, 'wizard-configuration-light');
    await dialog(lp).getByRole('button', { name: 'Continuar', exact: true }).click(); await capture(lp, 'wizard-review-light'); await lp.keyboard.press('Escape'); await expect(lp.getByRole('dialog')).toHaveCount(0);
    await main(lp).getByRole('button', { name: 'Nova aplicação', exact: true }).click(); await dialog(lp).getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(main(lp).getByRole('button', { name: 'Nova aplicação', exact: true })).toBeFocused(); await light.close();
    check('Preparação no tema claro, foco circular, Escape, cancelamento e retorno ao acionador; plano de apoio volta aos resultados');
    const emptyContext = await context(390, 664, 'light'), emptyPage = await emptyContext.newPage();
    const options = (await api('/classes/bootstrap')).data;
    const emptyClass = await api('/classes', 'POST', { name: 'Turma sem aplicações', gradeId: options.grades[0].id, academicYear: 2026, disciplineIds: [options.disciplines[0].id] }); assert.equal(emptyClass.status, 201);
    const emptyPath = `/turmas?turma=${emptyClass.data.id}&secao=avaliacoes`;
    await go(emptyPage, emptyPath); await expect(main(emptyPage)).toContainText('Prepare a primeira aplicação'); await capture(emptyPage, 'applications-empty');
    await main(emptyPage).getByRole('button', { name: 'Criar rascunho', exact: true }).click(); await dialog(emptyPage).getByRole('button', { pressed: false }).filter({ has: emptyPage.locator('strong').filter({ hasText: currentSourceTitle }) }).first().click(); await dialog(emptyPage).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(emptyPage)).toContainText('0 de 0 estudantes'); await dialog(emptyPage).getByRole('button', { name: 'Continuar', exact: true }).click(); await expect(dialog(emptyPage).getByRole('alert')).toContainText('Cadastre os estudantes'); await expect(dialog(emptyPage)).toContainText('cadastre-os na aba Estudantes'); await expect(dialog(emptyPage).getByRole('button', { name: 'Selecionar visíveis' })).toHaveCount(0); await capture(emptyPage, 'wizard-no-students'); await emptyPage.keyboard.press('Escape');
    assert.equal((await api(`/classes/${emptyClass.data.id}/status`, 'PATCH', { status: 'archived', expectedRevision: emptyClass.data.revision })).status, 200);
    await go(emptyPage, emptyPath); await expect(main(emptyPage)).toContainText('Nenhuma aplicação nesta turma'); await expect(main(emptyPage).getByRole('button', { name: 'Nova aplicação' })).toHaveCount(0); await capture(emptyPage, 'applications-empty-archived');
    await go(emptyPage, `/banco-questoes/devolutivas?turma=${classPublicId}&avaliacao=${assessmentPublicId}`); await emptyPage.getByRole('button', { name: /^Revisar correções/ }).click(); await expect(dialog(emptyPage).locator('[data-result-participant]')).toHaveCount(3); await capture(emptyPage, 'results-from-cycle'); await emptyPage.keyboard.press('Escape'); await emptyContext.close();
    check('Turma sem aplicações/sem estudantes, arquivada sem convite indevido para criar, e entrada real nos resultados pelo ciclo pedagógico');
    const explore = await context(), ep = await explore.newPage(); await go(ep); await showResults(ep, sourceTitle);
    const start = Date.now(); while (Date.now() - start < 30000) { for (const name of ['Questões', 'Habilidades BNCC', 'Estudantes']) { await dialog(ep).getByRole('tab', { name, exact: true }).click(); await ep.mouse.wheel(0, 400); await ep.waitForTimeout(350); } }
    await ep.keyboard.press('Escape'); await explore.close(); check('Exploração de 30 segundos por abas/rolagem e encerramento limpo');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.stack; record(); for (const c of contexts) for (const p of c.pages()) { await p.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await p.locator('body').innerText().catch(() => '')); } throw error; }
  finally { await Promise.all(contexts.map(c => c.close().catch(() => {}))); await browser.close(); }
}
module.exports = { runAssessmentsBrowser };
