const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runClassesBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output }) {
  assert.equal(process.env.CLASSES_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Turmas:', description); };
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const view = page => page.locator('[data-classes]');
  const list = page => page.locator('[data-class-list] > button');
  const rows = page => page.locator('[data-class-students] > div');
  const detail = page => page.locator('[data-class-detail]');
  async function context(user = teacher, width = 390, height = 664, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(ctx);
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => { if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message))); return ctx;
  }
  async function go(page, url = '/turmas', idle = true) {
    await page.goto(baseUrl + url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(550);
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle'); await page.waitForTimeout(200);
  }
  async function capture(page, id, initial = '') {
    await page.waitForTimeout(250);
    const metrics = await page.evaluate(() => {
      const box = e => { const r = e?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
      const panel = document.querySelector('[data-class-dialog]'); const scope = panel || document.querySelector('[data-classes]');
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        firstClass: box(document.querySelector('[data-class-list] > button')), firstStudent: box(document.querySelector('[data-class-students] > div')), modal: box(panel),
        controls: [...scope.querySelectorAll('a,button,select,input,summary')].filter(e => e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden').map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 70), ...box(e) })) };
    });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record(); assert.ok(metrics.scrollWidth <= metrics.width, id + ': no horizontal overflow');
    if (initial) { const target = initial === 'list' ? metrics.firstClass : metrics.firstStudent; assert.equal(metrics.scrollY, 0); assert.ok(target?.y >= 108 && target.bottom <= metrics.height, id + ': core item visible in first viewport'); }
    if (metrics.modal) assert.ok(metrics.modal.y >= 0 && metrics.modal.bottom <= metrics.height, id + ': modal fits viewport');
    for (const c of metrics.controls) { assert.ok(c.height >= 44 && c.width >= 44, id + ': touch target ' + c.label); assert.ok(c.x >= 0 && c.right <= metrics.width + 1, id + ': target bounds ' + c.label); }
  }
  async function api(url, method = 'GET', body, user = teacher) {
    const response = await fetch(baseUrl + '/api' + url, { method, headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  async function organize(page, name) {
    const summary = detail(page).locator('summary').filter({ hasText: 'Organizar turma' });
    if (!(await summary.evaluate(e => e.parentElement.open))) await summary.click();
    await detail(page).getByRole('button', { name, exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible();
  }
  try {
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const ctx = await context(teacher, width, height, theme), page = await ctx.newPage(); await go(page);
      await expect(list(page)).toHaveCount(1); await capture(page, `list-${width}-${theme}`, 'list');
      await list(page).first().focus(); await page.keyboard.press('Enter'); await expect(rows(page)).toHaveCount(3);
      await capture(page, `detail-${width}-${theme}`, 'detail');
      await expect(detail(page).getByRole('heading', { name: '1º Ano A', exact: true })).toBeFocused();
      if (width < 1024) { await expect(list(page)).not.toBeVisible(); await page.getByRole('button', { name: 'Voltar para turmas', exact: true }).click(); await expect(list(page)).toBeVisible(); }
      await go(page, `/turmas?turma=${classPublicId}`); await expect(rows(page)).toHaveCount(3); await capture(page, `direct-${width}-${theme}`, 'detail'); await ctx.close();
    }
    check('Lista e primeiro estudante/ações na primeira tela: 3 resoluções × 2 temas; seleção por teclado, foco, retorno e link direto');

    const setup = (await api('/classes/bootstrap')).data;
    const classBody = name => ({ name, gradeId: setup.grades[0].id, academicYear: 2026, disciplineIds: [setup.disciplines[0].id] });
    const second = (await api('/classes', 'POST', classBody('7º B — Tarde'))).data;
    const archived = (await api('/classes', 'POST', classBody('Turma do ano anterior'))).data;
    await api(`/classes/${archived.id}/status`, 'PATCH', { status: 'archived', expectedRevision: archived.revision });
    const ctx = await context(), page = await ctx.newPage(); await go(page); await expect(list(page)).toHaveCount(2);
    await page.getByRole('textbox', { name: 'Buscar turma' }).fill('7º B'); await expect(list(page)).toHaveCount(1); await expect(page).toHaveURL(/busca=/);
    await list(page).click(); await expect(detail(page)).toContainText('7º B — Tarde'); await page.goBack(); await expect(list(page)).toBeVisible(); await expect(page.getByRole('textbox', { name: 'Buscar turma' })).toHaveValue('7º B');
    await page.getByRole('textbox', { name: 'Buscar turma' }).fill('não encontrada'); await expect(view(page).getByRole('heading', { name: 'Nenhuma turma encontrada' })).toBeVisible(); await capture(page, 'no-matching-class');
    await page.getByRole('button', { name: 'Limpar busca', exact: true }).click(); await expect(list(page)).toHaveCount(2);
    await page.getByRole('button', { name: 'Arquivadas', exact: true }).click(); await expect(list(page)).toHaveCount(1); await list(page).click(); await expect(detail(page)).toContainText('Arquivada'); await expect(detail(page).getByRole('button', { name: 'Adicionar', exact: true })).toHaveCount(0); await capture(page, 'archived-direct');
    await go(page, `/turmas?turma=${archived.id}`); await expect(detail(page)).toContainText('Turma do ano anterior');
    await go(page, `/turmas?turma=${classPublicId}&secao=avaliacoes`); await expect(page.getByRole('tab', { name: 'Aplicações', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('button', { name: 'Corrigir e analisar resultados', exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: 'Corrigir e analisar resultados', exact: true }).first().click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
    await page.getByRole('tab', { name: 'Aplicações', exact: true }).focus(); await page.keyboard.press('ArrowLeft'); await expect(page.getByRole('tab', { name: 'Estudantes', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(rows(page)).toHaveCount(3);
    const sourceId = db.prepare('SELECT source_question_set_id FROM class_assessment_assignments WHERE public_id=?').pluck().get(assessmentPublicId);
    await go(page, `/turmas?turma=${classPublicId}&secao=avaliacoes&simulado=${sourceId}`); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape'); await ctx.close();
    check('Busca/situação/histórico, turma arquivada por link, abas por teclado e continuidade para aplicações/resultados/rascunho por simulado');

    for (const [id, url, status, payload] of [['list-error', '/classes?status=active', 503, {}], ['list-invalid', '/classes?status=active', 200, {}], ['detail-error', '/classes/' + classPublicId, 503, {}], ['detail-invalid', '/classes/' + classPublicId, 200, {}], ['bootstrap-error', '/classes/bootstrap', 503, {}]]) {
      const c = await context(); let fail = true; await c.route(baseUrl + '/api' + url, route => fail ? route.fulfill({ status, json: payload }) : route.continue());
      const p = await c.newPage(); await go(p, id.startsWith('list') ? '/turmas' : `/turmas?turma=${classPublicId}`);
      await expect(view(p).getByRole('alert')).toBeVisible(); await expect(view(p)).not.toContainText('Nenhuma turma ativa');
      if (id.startsWith('detail')) await expect(rows(p)).toHaveCount(0);
      if (id.startsWith('bootstrap')) { await expect(rows(p)).toHaveCount(3); await expect(view(p).locator('header button')).toBeDisabled(); }
      await capture(p, id); fail = false; await view(p).getByRole('button', { name: /Tentar novamente/ }).click(); await expect(view(p).getByRole('alert')).toHaveCount(0); await c.close();
    }
    const other = await context(previewUser), otherPage = await other.newPage(); await go(otherPage); await expect(view(otherPage).getByRole('heading', { name: 'Nenhuma turma ativa' })).toBeVisible(); await capture(otherPage, 'empty-account');
    await otherPage.getByRole('button', { name: 'Arquivadas', exact: true }).click(); await expect(view(otherPage).getByRole('heading', { name: 'Nenhuma turma arquivada' })).toBeVisible(); await capture(otherPage, 'empty-archived'); await otherPage.getByRole('button', { name: 'Ver turmas ativas' }).click();
    await go(otherPage, `/turmas?turma=${classPublicId}`); await expect(view(otherPage).getByRole('alert')).toBeVisible(); await capture(otherPage, 'other-teacher-denied'); await other.close();
    assert.equal((await api('/classes/' + classPublicId, 'GET', null, previewUser)).status, 404); assert.equal((await api('/classes', 'GET', null, admin)).status, 403);
    const slowCtx = await context(); let release; const gate = new Promise(resolve => { release = resolve; });
    await slowCtx.route(baseUrl + '/api/classes/' + classPublicId, async route => { await gate; await route.continue(); });
    const slow = await slowCtx.newPage(); await go(slow, `/turmas?turma=${classPublicId}`, false); await expect(view(slow).getByRole('status')).toBeVisible(); await capture(slow, 'loading-detail');
    await slow.getByRole('button', { name: 'Voltar para turmas', exact: true }).click(); await list(slow).filter({ hasText: '7º B — Tarde' }).click(); await expect(detail(slow)).toContainText('7º B — Tarde'); release(); await slow.waitForTimeout(500); await expect(detail(slow)).not.toContainText('Alice Estudante'); await slowCtx.close();
    check('503, payload inválido, bootstrap independente, vazios reais, isolamento por professor/admin e descarte de resposta atrasada de outra turma');

    const editCtx = await context(teacher, 320, 600), p = await editCtx.newPage(); await go(p);
    await p.getByRole('button', { name: 'Criar turma', exact: true }).click(); const dialog = p.getByRole('dialog'); await expect(dialog).toBeFocused(); await capture(p, 'create-class');
    await dialog.getByLabel('Nome da turma', { exact: true }).fill('Turma criada pela interface'); await dialog.getByLabel('Ano escolar', { exact: true }).selectOption(String(setup.grades[0].id));
    await dialog.getByRole('button', { name: 'Criar turma', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Escolha pelo menos um');
    await dialog.getByRole('button', { name: setup.disciplines[0].name, exact: true }).click(); await dialog.getByRole('button', { name: 'Criar turma', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(detail(p)).toContainText('Turma criada pela interface');
    const created = db.prepare("SELECT * FROM school_classes WHERE name='Turma criada pela interface'").get(); assert.ok(created);
    await expect(detail(p)).toContainText('A turma ainda está vazia'); await capture(p, 'empty-class');
    await organize(p, 'Editar turma'); await dialog.getByLabel('Nome da turma', { exact: true }).fill('Turma revisada pela interface'); await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(detail(p)).toContainText('Turma revisada pela interface');
    await detail(p).getByRole('button', { name: 'Adicionar', exact: true }).click(); await capture(p, 'create-student'); await dialog.getByLabel('Nome do estudante', { exact: true }).fill('José da Silva'); await dialog.getByLabel('Identificador ou matrícula (opcional)', { exact: true }).fill('QA-001'); await dialog.getByRole('button', { name: 'Salvar', exact: true }).click(); await expect(rows(p)).toHaveCount(1);
    await detail(p).getByRole('button', { name: 'Editar José da Silva', exact: true }).click(); await dialog.getByLabel('Nome do estudante', { exact: true }).fill('José da Silva Santos'); await dialog.getByRole('button', { name: 'Salvar', exact: true }).click(); await expect(rows(p).first()).toContainText('José da Silva Santos');
    await detail(p).getByRole('button', { name: 'Retirar José da Silva Santos', exact: true }).click(); await capture(p, 'withdraw-confirm'); await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(rows(p).first()).toContainText('Matriculado');
    await detail(p).getByRole('button', { name: 'Retirar José da Silva Santos', exact: true }).click(); await dialog.getByRole('button', { name: 'Retirar estudante', exact: true }).click(); await expect(rows(p).first()).toContainText('Retirado da turma');
    await detail(p).getByRole('button', { name: 'Rematricular José da Silva Santos', exact: true }).click(); await dialog.getByRole('button', { name: 'Rematricular estudante', exact: true }).click(); await expect(rows(p).first()).toContainText('Matriculado');
    check('Criar/editar turma e estudante; seleção obrigatória de componente; retirar/cancelar/rematricular sem perder cadastro ou histórico');

    await organize(p, 'Importar estudantes'); await capture(p, 'import-entry'); const download = p.waitForEvent('download'); await dialog.getByRole('button', { name: 'Baixar modelo CSV' }).click(); assert.equal((await download).suggestedFilename(), 'modelo-estudantes-labmathic.csv');
    const before = db.prepare('SELECT COUNT(*) FROM school_class_enrollments WHERE class_id=?').pluck().get(created.id);
    await dialog.locator('input[type=file]').setInputFiles({ name: 'turma.csv', mimeType: 'text/csv', buffer: Buffer.from('Nome;Matrícula\nAna Importada com nome completo para conferência;QA-002\nBruno Importado;QA-003\n') });
    await expect(dialog.getByRole('button', { name: 'Confirmar importação' })).toBeEnabled(); await capture(p, 'import-preview'); assert.equal(db.prepare('SELECT COUNT(*) FROM school_class_enrollments WHERE class_id=?').pluck().get(created.id), before);
    assert.ok(await dialog.locator('[data-import-name]').evaluateAll(names => names.every(e => e.scrollWidth <= e.clientWidth && getComputedStyle(e).textOverflow !== 'ellipsis')), 'Import preview retains complete names');
    await dialog.getByRole('button', { name: 'Confirmar importação' }).click(); await expect(dialog).toHaveCount(0); await expect(rows(p)).toHaveCount(3);
    await organize(p, 'Código de entrada'); await expect(dialog.getByText('Nenhum código criado para esta turma.', { exact: true })).toBeVisible(); await capture(p, 'entry-code');
    await dialog.getByLabel('Quantidade máxima de entradas', { exact: true }).fill('3'); await dialog.getByLabel('Validade', { exact: true }).selectOption('1'); await dialog.getByRole('button', { name: 'Gerar código de entrada' }).click(); await expect(dialog.locator('[data-generated-code]')).toBeVisible(); await capture(p, 'generated-code');
    await editCtx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: baseUrl }); await dialog.getByRole('button', { name: 'Copiar código', exact: true }).click(); assert.equal(await p.evaluate(() => navigator.clipboard.readText()), await dialog.locator('[data-generated-code]').innerText());
    await dialog.getByRole('button', { name: 'Copiar link de entrada', exact: true }).click(); assert.match(await p.evaluate(() => navigator.clipboard.readText()), /entrar-na-turma\?codigo=/);
    p.once('dialog', d => d.accept()); await dialog.getByRole('button', { name: 'Revogar', exact: true }).click(); await expect(dialog).toContainText('Revogado'); await expect(dialog.locator('[data-generated-code]')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Gerar código de entrada' }).click(); await expect(dialog.locator('[data-generated-code]')).toBeVisible(); await p.keyboard.press('Escape');
    await organize(p, 'Arquivar turma'); await capture(p, 'archive-confirm'); await dialog.getByRole('button', { name: 'Arquivar turma', exact: true }).click(); await expect(detail(p)).toContainText('Arquivada'); assert.equal(db.prepare('SELECT COUNT(*) FROM school_class_entry_codes WHERE class_id=? AND revoked_at IS NULL').pluck().get(created.id), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM school_class_enrollments WHERE class_id=?').pluck().get(created.id), 3);
    await organize(p, 'Restaurar turma'); await dialog.getByRole('button', { name: 'Restaurar turma', exact: true }).click(); await expect(detail(p)).not.toContainText('Arquivada'); await expect(rows(p)).toHaveCount(3);
    const audited = new Set(db.prepare('SELECT action FROM activity_log WHERE user_id=? AND entity_id=?').all(teacher.id, created.public_id).map(row => row.action));
    for (const action of ['create_class', 'update_class', 'import_students', 'create_class_entry_code', 'revoke_class_entry_code', 'archive_class', 'restore_class']) assert.ok(audited.has(action), 'Audit preserved: ' + action);
    check('Importação conferida com nomes completos antes de gravar, modelo CSV, código/cópia/revogação, arquivar/restaurar preservando matrículas, códigos encerrados e auditoria');

    let writes = 0, releaseWrite; const writeGate = new Promise(resolve => { releaseWrite = resolve; });
    await editCtx.route(baseUrl + `/api/classes/${created.public_id}/students`, async route => { writes++; await writeGate; await route.continue(); });
    await detail(p).getByRole('button', { name: 'Adicionar', exact: true }).click(); await dialog.getByLabel('Nome do estudante', { exact: true }).fill('Gravação única'); await dialog.getByRole('button', { name: 'Salvar', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Salvando…' })).toBeDisabled(); await p.keyboard.press('Escape'); await expect(dialog).toBeVisible(); releaseWrite(); await expect(dialog).toHaveCount(0); assert.equal(writes, 1);
    await editCtx.unroute(baseUrl + `/api/classes/${created.public_id}/students`); writes = 0;
    await editCtx.route(baseUrl + `/api/classes/${created.public_id}/students`, async route => { writes++; const response = await route.fetch(); assert.equal(response.status(), 201); await route.fulfill({ status: 503, json: {} }); });
    await detail(p).getByRole('button', { name: 'Adicionar', exact: true }).click(); await dialog.getByLabel('Nome do estudante', { exact: true }).fill('Resposta perdida'); await dialog.getByRole('button', { name: 'Salvar', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar'); await expect(dialog.getByLabel('Nome do estudante')).toHaveValue('Resposta perdida'); await capture(p, 'uncertain-save'); await p.waitForTimeout(500); assert.equal(writes, 1); await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(rows(p).filter({ hasText: 'Resposta perdida' })).toHaveCount(1);
    await editCtx.unroute(baseUrl + `/api/classes/${created.public_id}/students`);
    await organize(p, 'Editar turma'); db.prepare('UPDATE school_classes SET revision=revision+1 WHERE id=?').run(created.id);
    await dialog.getByLabel('Nome da turma').fill('Rascunho com conflito'); await dialog.getByRole('button', { name: 'Salvar alterações' }).click(); await expect(dialog.getByRole('alert')).toBeVisible(); await expect(dialog.getByLabel('Nome da turma')).toHaveValue('Rascunho com conflito'); await capture(p, 'revision-conflict'); await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
    check('Escrita única, Escape bloqueado durante gravação, resposta perdida reconciliada sem replay e revisão concorrente mantendo o rascunho');

    for (let n = 0; n < 8; n++) assert.equal((await api(`/classes/${created.public_id}/students`, 'POST', { displayName: `Estudante ${n} com nome longo para conferir a leitura sem abreviar`, externalReference: `QA-DENSE-${n}` })).status, 201);
    await go(p, `/turmas?turma=${created.public_id}`); await expect(rows(p)).toHaveCount(13); await capture(p, 'many-students');
    const organizeSummary = detail(p).locator('summary').filter({ hasText: 'Organizar turma' });
    assert.ok((await organizeSummary.boundingBox()).y < 600, 'Organization remains accessible before the full roster');
    await organizeSummary.click(); await capture(p, 'class-tools'); await organizeSummary.click();
    await p.getByRole('textbox', { name: 'Buscar estudante' }).fill('jose'); await expect(rows(p)).toHaveCount(1); await capture(p, 'student-search');
    await p.getByRole('textbox', { name: 'Buscar estudante' }).fill('não existe'); await expect(detail(p)).toContainText('Nenhum estudante encontrado'); await p.getByRole('button', { name: 'Limpar busca de estudantes' }).click(); await expect(rows(p)).toHaveCount(13);
    const start = Date.now(); while (Date.now() - start < 30000) { await p.getByRole('textbox', { name: 'Buscar estudante' }).fill('QA-DENSE'); await expect(rows(p)).toHaveCount(8); await rows(p).last().scrollIntoViewIfNeeded(); await p.getByRole('textbox', { name: 'Buscar estudante' }).fill(''); await expect(rows(p)).toHaveCount(13); await p.waitForTimeout(600); }
    await editCtx.close();
    for (const theme of ['dark', 'light']) { const c = await context(teacher, 320, 600, theme), p = await c.newPage(); await go(p); await p.getByRole('button', { name: 'Criar turma', exact: true }).click(); const d = p.getByRole('dialog'); await capture(p, 'class-form-' + theme); await d.getByRole('button', { name: 'Criar turma', exact: true }).focus(); await p.keyboard.press('Tab'); await expect(d.getByRole('button', { name: 'Fechar', exact: true })).toBeFocused(); await p.keyboard.press('Escape'); await expect(d).toHaveCount(0); await expect(p.getByRole('button', { name: 'Criar turma', exact: true })).toBeFocused(); await c.close(); }
    check('13 estudantes, nomes longos e busca por nome/acento/matrícula; exploração por 30s; modal nos dois temas, foco circular/Escape');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.stack; record(); for (const c of contexts) for (const p of c.pages()) { await p.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await p.locator('body').innerText().catch(() => '')); } throw error; }
  finally { await Promise.all(contexts.map(c => c.close().catch(() => {}))); await browser.close(); }
}
module.exports = { runClassesBrowser };
