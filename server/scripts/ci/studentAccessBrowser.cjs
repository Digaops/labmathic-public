const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runStudentAccessBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.STUDENT_ACCESS_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, cases: [], internal: [], inventory: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Acessos:', description); };
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const dialog = p => p.getByRole('dialog').last();
  async function context(width = 390, height = 664, theme = 'dark', user = teacher) {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.addInitScript(({ origin, user, token, theme }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('theme', theme);
      if (user) sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: user ? tokenFor(user) : null, theme });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message))); return c;
  }
  async function go(p, url = `/turmas?turma=${classPublicId}&secao=avaliacoes`) {
    await p.goto(baseUrl + url, { waitUntil: 'domcontentloaded' });
    const notice = p.getByRole('button', { name: 'Entendi, continuar', exact: true });
    await p.waitForTimeout(400); if (await notice.isVisible()) await notice.click();
    await p.waitForLoadState('networkidle');
  }
  async function capture(p, id, primary = null) {
    await p.waitForTimeout(250);
    const metrics = await p.evaluate(() => {
      const panel = [...document.querySelectorAll('[role=dialog]')].at(-1), scope = panel || document.querySelector('[data-student-assessment]');
      const box = el => { const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height, right: r.right, bottom: r.bottom }; };
      const toolbar = document.querySelector('[data-student-toolbar]');
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, toolbar: toolbar && box(toolbar), panel: panel && box(panel), panelWidth: panel?.clientWidth, panelScrollWidth: panel?.scrollWidth,
        controls: [...scope.querySelectorAll('button,input,summary')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => ({ label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 50), ...box(el.matches('input[type=radio]') ? el.closest('label') : el) })) };
    });
    if (primary) metrics.primary = await primary.boundingBox();
    await p.screenshot({ path: path.join(output, id + '.png'), scale: 'css' });
    fs.writeFileSync(path.join(output, id + '.txt'), await p.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record();
    assert.ok(metrics.scrollWidth <= metrics.width, id + ': page width');
    if (metrics.toolbar) assert.ok(metrics.toolbar.y >= 0 && metrics.toolbar.bottom <= metrics.height && metrics.toolbar.height <= 76, id + ': compact timer visible');
    if (metrics.panel) { assert.ok(metrics.panel.y >= 0 && metrics.panel.bottom <= metrics.height, id + ': panel height'); assert.ok(metrics.panelScrollWidth <= metrics.panelWidth + 1, id + ': panel width'); }
    if (primary) assert.ok(metrics.primary && metrics.primary.y >= 0 && metrics.primary.bottom !== null && metrics.primary.y + metrics.primary.height <= metrics.height, id + ': primary visible');
    for (const c of metrics.controls) { assert.ok(c.width >= 44 && c.height >= 44, id + ': target ' + c.label); assert.ok(c.x >= -1 && c.right <= metrics.width + 1, id + ': bounds ' + c.label); }
  }
  async function api(url, method = 'GET', body, user = teacher) {
    const r = await fetch(baseUrl + '/api' + url, { method, headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: 'Bearer ' + tokenFor(user) } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  let assignment, accessPath;
  async function openAccess(p) {
    await go(p); await p.locator(`[data-assessment-id="${assignment.id}"]`).getByRole('button', { name: 'Acessos dos estudantes', exact: true }).click();
    await expect(dialog(p).locator('[data-access-participant]')).toHaveCount(9);
  }
  async function student(c, code) {
    const p = await c.newPage(); await go(p, '/responder');
    await p.getByLabel('Código individual de acesso', { exact: true }).fill(code);
    await p.getByRole('button', { name: 'Entrar na avaliação', exact: true }).click();
    await expect(p.getByRole('radiogroup')).toBeVisible(); return p;
  }
  try {
    for (let i = 0; i < 6; i++) assert.equal((await api(`/classes/${classPublicId}/students`, 'POST', { displayName: `Estudante ${i} com nome completo longo para conferir o cartão individual`, externalReference: 'ACCESS-QA-' + i })).status, 201);
    const bootstrap = (await api(`/classes/${classPublicId}/assessments/bootstrap`)).data;
    const sourceId = db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE public_id=?').pluck().get(assessmentPublicId);
    const created = await api(`/classes/${classPublicId}/assessments`, 'POST', { sourceQuestionSetId: sourceId, participantIds: bootstrap.participants.map(p => p.id), instructions: 'Leia com atenção. Você pode voltar às questões antes de entregar.', timeLimitMinutes: 30 });
    assert.equal(created.status, 201); assignment = created.data;
    const assignmentPath = `/classes/${classPublicId}/assessments/${assignment.id}`; accessPath = assignmentPath + '/student-access';
    const scheduled = await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: assignment.revision, action: 'schedule', opensAt: new Date(Date.now() + 86400000).toISOString() }); assert.equal(scheduled.status, 200);
    const draftContext = await context(), draft = await draftContext.newPage(); await openAccess(draft);
    const returned = await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: scheduled.data.revision, action: 'return_to_draft' }); assert.equal(returned.status, 200);
    await dialog(draft).getByRole('button', { name: 'Atualizar situação' }).click();
    await expect(dialog(draft)).toContainText('use Disponibilizar'); await capture(draft, 'access-draft'); await draft.keyboard.press('Escape'); await draftContext.close();
    assert.equal((await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: returned.data.revision, action: 'schedule', opensAt: new Date(Date.now() + 86400000).toISOString() })).status, 200);
    for (const [width, height] of [[1024,600],[390,664],[320,600]]) for (const theme of ['light','dark']) {
      const c = await context(width, height, theme), p = await c.newPage(); await openAccess(p);
      await capture(p, `access-${width}-${theme}`, dialog(p).getByRole('button', { name: 'Gerar acessos', exact: true }));
      await dialog(p).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click(); await capture(p, `settings-${width}-${theme}`);
      await dialog(p).getByRole('radio').last().scrollIntoViewIfNeeded(); await capture(p, `settings-options-${width}-${theme}`);
      await dialog(p).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click();
      await dialog(p).getByRole('textbox', { name: 'Buscar estudante' }).fill('sem correspondência'); await expect(dialog(p)).toContainText('Nenhum estudante encontrado');
      await dialog(p).getByRole('textbox', { name: 'Buscar estudante' }).fill(''); await p.keyboard.press('Escape'); await expect(p.locator(`[data-assessment-id="${assignment.id}"]`).getByRole('button', { name: 'Acessos dos estudantes' })).toBeFocused(); await c.close();
    }
    check('Acessos/ajuda em três resoluções e dois temas; busca/vazio/limpar, título completo, foco/Escape e ação inicial visível');
    const c = await context(), p = await c.newPage(); await openAccess(p);
    await dialog(p).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click();
    for (const name of ['Somente para o professor', 'Logo após o envio']) {
      await dialog(p).getByRole('radio', { name }).check(); await dialog(p).getByRole('button', { name: 'Salvar escolha' }).click(); await expect(dialog(p).getByRole('button', { name: 'Salvar escolha' })).toHaveCount(0);
    }
    await c.grantPermissions(['clipboard-read','clipboard-write']); await dialog(p).getByRole('button', { name: 'Copiar link' }).click(); assert.equal(await p.evaluate(() => navigator.clipboard.readText()), baseUrl + '/responder');
    await p.evaluate(() => { navigator.clipboard.writeText = async () => { throw Error('clipboard indisponível'); }; });
    await dialog(p).getByRole('button', { name: 'Copiar link' }).click(); await expect(dialog(p).getByRole('alert')).toContainText('Não foi possível copiar'); await capture(p, 'access-copy-error');
    await dialog(p).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click();
    let release, started, writes = 0, generated;
    const entered = new Promise(r => { started = r; }), gate = new Promise(r => { release = r; });
    await c.route('**/api' + accessPath + '/credentials', async route => { writes++; started(); await gate; const response = await route.fetch(); generated = await response.json(); await route.fulfill({ response }); });
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Gerar acessos', exact: true }).click(); await entered;
    await expect(dialog(p).getByRole('button', { name: 'Fechar', exact: true })).toBeDisabled(); await p.keyboard.press('Escape'); await expect(p.getByRole('dialog')).toHaveCount(1);
    release(); await expect(dialog(p).locator('[data-generated-code]')).toHaveCount(9); await c.unroute('**/api' + accessPath + '/credentials'); assert.equal(writes, 1);
    await capture(p, 'access-generated');
    await p.evaluate(() => { window.savedOpen = window.open; window.open = () => null; });
    await dialog(p).getByRole('button', { name: 'Imprimir cartões' }).click(); await expect(dialog(p).getByRole('alert')).toContainText('bloqueou a impressão');
    await p.evaluate(() => { window.open = (...args) => { const child = window.savedOpen(...args); if (child) child.print = () => {}; return child; }; });
    const popupPromise = p.waitForEvent('popup'); await dialog(p).getByRole('button', { name: 'Imprimir cartões' }).click(); const popup = await popupPromise;
    await expect(popup.locator('.card')).toHaveCount(9); assert.equal(await popup.evaluate(() => window.opener), null); await popup.setViewportSize({ width: 960, height: 720 }); await popup.screenshot({ path: path.join(output, 'printed-cards.png'), scale: 'css' }); report.internal.push({ id: 'printed-cards', cards: 9 }); await popup.close();
    p.once('dialog', d => d.dismiss()); await p.keyboard.press('Escape'); await expect(dialog(p).locator('[data-generated-code]')).toHaveCount(9);
    const first = generated.generated[0], second = generated.generated[1];
    const rows = dialog(p).locator('[data-access-participant]');
    p.once('dialog', d => d.accept()); await rows.filter({ hasText: first.displayName }).getByRole('button', { name: 'Renovar código' }).click();
    await expect(dialog(p).getByLabel('Código completo de ' + first.displayName, { exact: true })).not.toHaveText(first.code);
    await expect(dialog(p).locator('[data-generated-code]')).toHaveCount(9); await expect(dialog(p).getByLabel('Código completo de ' + second.displayName, { exact: true })).toHaveText(second.code);
    first.code = await dialog(p).getByLabel('Código completo de ' + first.displayName, { exact: true }).innerText();
    p.once('dialog', d => d.accept()); await rows.filter({ hasText: second.displayName }).getByRole('button', { name: 'Revogar acesso de ' + second.displayName }).click(); await expect(dialog(p).locator('[data-generated-code]')).toHaveCount(8);
    assert.notEqual((await api('/student-assessments/session', 'POST', { code: second.code }, null)).status, 200);
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Bloquear acessos' }).click(); await expect(dialog(p)).toContainText('Resposta on-line bloqueada');
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Reabrir acessos' }).click(); await expect(dialog(p)).toContainText('Resposta on-line liberada');
    await capture(p, 'access-renewed-revoked');
    p.once('dialog', d => d.accept()); await p.keyboard.press('Escape');
    check('Configuração salva, clipboard permitido/negado, geração única, cartões/impressão sem opener, renovação parcial preserva os demais códigos; revogação/bloqueio/reabertura explícitos');
    let access = (await api(accessPath)).data;
    assert.equal((await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: access.assessment.revision, action: 'open' })).status, 200);
    await openAccess(p); await dialog(p).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click(); for (const radio of await dialog(p).getByRole('radio').all()) await expect(radio).toBeDisabled(); await p.keyboard.press('Escape');
    for (const [width, height] of [[1024,600],[390,664],[320,600]]) for (const theme of ['light','dark']) {
      const sc = await context(width, height, theme, null), sp = await sc.newPage(); await go(sp, '/responder'); await capture(sp, `entry-${width}-${theme}`, sp.getByRole('button', { name: 'Entrar na avaliação' }));
      await sp.getByRole('button', { name: 'Entrar na avaliação' }).click(); await expect(sp.getByRole('alert')).toContainText('16 caracteres');
      await sp.getByLabel('Código individual de acesso').fill(first.code); await sp.getByRole('button', { name: 'Entrar na avaliação' }).click(); await expect(sp.getByRole('radiogroup')).toBeVisible();
      await capture(sp, `answer-${width}-${theme}`, sp.getByRole('radio').first());
      await sp.getByText('Orientações do professor', { exact: true }).click(); await expect(sp.getByText('Leia com atenção.', { exact: false })).toBeVisible();
      if (width === 320 && theme === 'dark') await capture(sp, 'answer-instructions');
      await sp.getByText('Orientações do professor', { exact: true }).click();
      await sp.getByRole('radio').first().focus(); await sp.keyboard.press('ArrowDown'); await expect(sp.getByRole('radio').nth(1)).toBeChecked(); await expect(sp.getByRole('status')).toContainText('Respostas salvas');
      await sp.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(sp.getByRole('region', { name: 'Questão atual e salvamento' })).toBeFocused(); await expect(sp.getByRole('radiogroup')).toHaveAttribute('aria-label', 'Alternativas da questão 2');
      await capture(sp, `next-${width}-${theme}`, sp.getByRole('radio').first());
      if (width < 600) await sp.getByRole('button', { name: /Ver todas as questões/ }).click();
      if (width === 320 && theme === 'dark') await capture(sp, 'answer-question-map');
      await sp.getByRole('button', { name: 'Ir para questão 1', exact: true }).click(); await expect(sp.getByRole('radio').nth(1)).toBeChecked();
      await sc.close();
    }
    check('Entrada/erro local, responder por teclado, orientações, tempo, mapa de questões e retorno preservado em três resoluções × dois temas');
    // Uncertain credential write: no replay and no old card presented as current.
    await openAccess(p); let uncertainWrites = 0;
    await c.route('**/api' + accessPath + '/credentials', async route => { uncertainWrites++; const response = await route.fetch(); assert.equal(response.status(), 201); await route.fulfill({ status: 503, contentType: 'application/json', body: '{}' }); });
    p.once('dialog', d => d.accept()); await dialog(p).locator('[data-access-participant]').filter({ hasText: first.displayName }).getByRole('button', { name: 'Renovar código' }).click();
    await expect(dialog(p).getByRole('alert')).toContainText('cuja resposta se perdeu'); await expect(dialog(p).locator('[data-generated-code]')).toHaveCount(0); assert.equal(uncertainWrites, 1); await capture(p, 'access-uncertain'); await c.unroute('**/api' + accessPath + '/credentials'); await p.keyboard.press('Escape'); await c.close();
    for (const invalid of [false, true]) {
      const ec = await context(320,600,'light'), ep = await ec.newPage(); let fail = true;
      await ec.route('**/api' + accessPath, route => fail && route.request().method() === 'GET' ? route.fulfill({ status: invalid ? 200 : 503, contentType: 'application/json', body: '{}' }) : route.continue());
      await go(ep); await ep.locator(`[data-assessment-id="${assignment.id}"]`).getByRole('button', { name: 'Acessos dos estudantes' }).click(); await expect(dialog(ep).getByRole('alert')).toContainText('Não foi possível conferir'); await capture(ep, invalid ? 'access-invalid' : 'access-unavailable'); fail = false;
      await dialog(ep).getByRole('button', { name: 'Tentar novamente' }).click(); await expect(dialog(ep).locator('[data-access-participant]')).toHaveCount(9); await ep.keyboard.press('Escape'); await ec.close();
    }
    assert.equal((await api(accessPath, 'GET', null, previewUser)).status, 404); assert.equal((await api(accessPath, 'GET', null, admin)).status, 403);
    const audits = new Set(db.prepare('SELECT action FROM activity_log').pluck().all());
    for (const action of ['generate_student_assessment_credentials','revoke_student_assessment_credential','disable_student_assessment_access','enable_student_assessment_access']) assert.ok(audits.has(action));
    check('Resposta de geração perdida sem repetição, falha de consulta/payload inválido com recuperação, política bloqueada após abertura, auditoria e isolamento docente');
    const delayedContext = await context(), delayedPage = await delayedContext.newPage(); await go(delayedPage);
    let finishRead, readStarted; const readGate = new Promise(r => { finishRead = r; }), readEntered = new Promise(r => { readStarted = r; });
    await delayedContext.route('**/api' + accessPath, async route => { readStarted(); await readGate; await route.continue().catch(() => {}); });
    await delayedPage.locator(`[data-assessment-id="${assignment.id}"]`).getByRole('button', { name: 'Acessos dos estudantes' }).click(); await readEntered;
    await dialog(delayedPage).getByRole('button', { name: 'Fechar', exact: true }).click(); finishRead(); await delayedPage.waitForTimeout(200); await expect(delayedPage.getByRole('dialog')).toHaveCount(0); await delayedContext.close();
    const invalidContext = await context(320,600,'dark',null), invalidPage = await invalidContext.newPage();
    await invalidContext.route('**/api/student-assessments/session', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"token":"not-a-real-token","portal":{}}' }));
    await go(invalidPage, '/responder'); await invalidPage.getByLabel('Código individual de acesso').fill(first.code); await invalidPage.getByRole('button', { name: 'Entrar na avaliação' }).click(); await expect(invalidPage.getByRole('alert')).toContainText('Não foi possível abrir');
    assert.equal(await invalidPage.evaluate(() => sessionStorage.getItem('labmathic.studentAssessmentSession')), null); await capture(invalidPage, 'entry-invalid-payload'); await invalidContext.close();
    check('Leitura atrasada não reabre janela fechada e entrada com HTTP 200 inválido não grava sessão nem exibe avaliação falsa');
    for (const mode of ['hidden', 'score_after_close']) {
      const extra = await api(`/classes/${classPublicId}/assessments`, 'POST', { sourceQuestionSetId: sourceId, participantIds: [bootstrap.participants[0].id] }); assert.equal(extra.status, 201);
      const extraPath = `/classes/${classPublicId}/assessments/${extra.data.id}`;
      const settings = await api(extraPath + '/student-access', 'PATCH', { expectedRevision: extra.data.revision, enabled: false, resultMode: mode }); assert.equal(settings.status, 200);
      const open = await api(extraPath + '/delivery', 'PATCH', { expectedRevision: settings.data.assessment.revision, action: 'open' }); assert.equal(open.status, 200);
      const codes = await api(extraPath + '/student-access/credentials', 'POST', { expectedRevision: open.data.revision, confirmation: 'GERAR_ACESSOS' }); assert.equal(codes.status, 201);
      const rc = await context(390,664, mode === 'hidden' ? 'dark' : 'light', null), rp = await student(rc, codes.data.generated[0].code);
      await rp.getByRole('button', { name: /Ver todas as questões/ }).click();
      rp.once('dialog', d => d.dismiss()); await rp.getByRole('button', { name: 'Entregar avaliação', exact: true }).click(); await expect(rp.getByRole('radiogroup')).toBeVisible();
      rp.once('dialog', d => { assert.match(d.message(), /sem resposta/); d.accept(); }); await rp.getByRole('button', { name: 'Entregar avaliação', exact: true }).click(); await expect(rp.getByRole('heading', { name: 'Avaliação entregue' })).toBeVisible();
      await expect(rp.getByRole('radio')).toHaveCount(0); await expect(rp.getByText('Seu resultado', { exact: true })).toHaveCount(0); await capture(rp, 'submitted-' + mode);
      if (mode === 'score_after_close') {
        await expect(rp.getByText(/depois que o professor encerrar/)).toBeVisible(); const latest = (await api(extraPath + '/student-access')).data;
        assert.equal((await api(extraPath + '/delivery', 'PATCH', { expectedRevision: latest.assessment.revision, action: 'close' })).status, 200);
        await rp.reload(); await expect(rp.getByText('Seu resultado', { exact: true })).toBeVisible(); await capture(rp, 'submitted-result-after-close');
      } else await expect(rp.getByText(/resultado ficará disponível para o professor/)).toBeVisible();
      await rp.getByRole('button', { name: 'Sair deste dispositivo' }).click(); await expect(rp.getByLabel('Código individual de acesso')).toBeVisible(); await rc.close();
    }
    check('Entrega com questões em branco exige confirmação; modos oculto e após encerramento não antecipam pontuação, não mostram gabarito e permitem saída');
    const exploreContext = await context(390,664,'dark'), explorePage = await exploreContext.newPage(); await openAccess(explorePage);
    const until = Date.now() + 30000; let rounds = 0;
    while (Date.now() < until) {
      await dialog(explorePage).getByRole('textbox', { name: 'Buscar estudante' }).fill(rounds % 2 ? 'Alice' : 'sem correspondência');
      await dialog(explorePage).getByRole('textbox', { name: 'Buscar estudante' }).fill('');
      await dialog(explorePage).getByText('Como entregar os acessos e mostrar resultados', { exact: true }).click();
      await explorePage.keyboard.press('Tab'); await explorePage.mouse.wheel(0, rounds % 2 ? 400 : -400); await explorePage.waitForTimeout(350); rounds++;
    }
    await explorePage.keyboard.press('Escape'); await exploreContext.close();
    check('Exploração de pelo menos 30 segundos em busca, ajuda, teclado e rolagem, sem gerar ou divulgar novos códigos');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; record();
    for (const c of contexts) for (const p of c.pages()) { await p.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await p.locator('body').innerText().catch(() => '')); }
    throw error;
  } finally { await Promise.all(contexts.map(c => c.close().catch(() => {}))); await browser.close(); }
}
module.exports = { runStudentAccessBrowser };
