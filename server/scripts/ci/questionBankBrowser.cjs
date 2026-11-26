const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runQuestionBankBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, db, output }) {
  assert.equal(process.env.QUESTION_BANK_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Banco:', description); };
  const browser = await chromium.launch({ headless: true }), contexts = [];
  const dialog = p => p.getByRole('dialog').last(), rows = p => p.locator('[data-bank-question]');
  async function context(width = 390, height = 664, theme = 'dark', user = teacher) {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c);
    await c.route('**/*', r => r.request().url().startsWith(baseUrl + '/') ? r.continue() : r.abort());
    await c.addInitScript(({ origin, user, token, theme }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message))); return c;
  }
  async function go(p, url = '/banco-questoes?search=QA-BANK') {
    await p.goto(baseUrl + url, { waitUntil: 'domcontentloaded' }); await p.waitForTimeout(400);
    const notice = p.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    await p.waitForLoadState('networkidle');
  }
  async function capture(p, id, firstVisible = false) {
    await p.waitForTimeout(160);
    const m = await p.evaluate(() => {
      const panel = [...document.querySelectorAll('[role=dialog]')].at(-1), scope = panel || document.querySelector('[data-question-bank]');
      const box = el => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, width: b.width, height: b.height, right: b.right, bottom: b.bottom }; };
      const first = document.querySelector('[data-bank-question] > p');
      return { width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, panel: panel && box(panel), panelScrollWidth: panel?.scrollWidth, panelWidth: panel?.clientWidth, first: first && box(first),
        controls: [...scope.querySelectorAll('button,a,input,select,textarea,summary')].filter(el => el.getClientRects().length && getComputedStyle(el).visibility !== 'hidden').map(el => ({ label: el.getAttribute('aria-label') || el.textContent.trim().slice(0, 45), ...box(el.matches('input[type=radio],input[type=checkbox],input[type=file]') ? el.closest('label') : el) })) };
    });
    await p.screenshot({ path: path.join(output, id + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, id + '.txt'), await p.locator('body').innerText());
    report.cases.push({ id, ...m }); record(); assert.ok(m.scrollWidth <= m.width, id + ': page overflow');
    if (m.panel) { assert.ok(m.panel.y >= 0 && m.panel.bottom <= m.height, id + ': panel height'); assert.ok(m.panelScrollWidth <= m.panelWidth + 1, id + ': panel overflow'); }
    if (firstVisible) assert.ok(m.first && m.first.y >= 0 && m.first.y + 24 <= m.height, id + ': statement before scrolling');
    for (const c of m.controls) { assert.ok(c.width >= 44 && c.height >= 44, id + ': 44px ' + c.label + ' ' + c.width + 'x' + c.height); assert.ok(c.x >= -1 && c.right <= m.width + 1, id + ': target bounds ' + c.label); }
  }
  async function api(url, method = 'GET', body, user = teacher) {
    const r = await fetch(baseUrl + '/api' + url, { method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + tokenFor(user) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: r.status, data: await r.json() };
  }
  const search = async (p, value) => { await p.getByRole('searchbox', { name: 'Buscar questão' }).fill(value); await p.getByRole('button', { name: 'Buscar', exact: true }).click(); await p.waitForLoadState('networkidle'); };
  const selectFirst = p => rows(p).first().getByRole('button', { name: /^Selecionar / }).click();
  const openSet = p => p.getByRole('button', { name: 'Conferir e gerar simulado' }).click();
  try {
    const skill = db.prepare('SELECT id,grade_id,unit_id FROM bncc_skills ORDER BY id LIMIT 1').get();
    const alternate = db.prepare('SELECT id,grade_id,unit_id FROM bncc_skills WHERE grade_id <> ? ORDER BY id LIMIT 1').get(skill.grade_id);
    assert.ok(alternate, 'fixture needs two grades');
    const payload = (i, extra = {}) => ({ question_code: 'QA-BANK-' + String(i).padStart(2, '0'), skill_id: skill.id, statement: 'Em uma escola, a turma organizou 24 livros em 4 grupos. Quantos livros ficaram em cada grupo?', support_text: 'Leia os dados e explique sua estratégia.', official_explanation: 'Divida 24 por 4 para encontrar 6 livros por grupo.', difficulty: 'media', status: 'active', reviewed: true, development_space: 'medium', options: ['6','4','24','8'].map((text, index) => ({ option_label: 'ABCD'[index], option_text: text, is_correct: Number(index === 0), sort_order: index + 1 })), ...extra });
    const created = [];
    for (let i = 1; i <= 14; i++) { const result = await api('/question-bank/questions', 'POST', payload(i, i === 14 ? { skill_id: alternate.id, difficulty: 'facil' } : {}), admin); assert.equal(result.status, 201, JSON.stringify(result.data)); created.push(result.data); }
    const own = await api('/question-bank/author-questions', 'POST', payload('OWN'), teacher);
    assert.equal(own.status, 201, JSON.stringify(own.data));
    check('Fixture isolada: questões oficiais e autoral criadas pelas rotas autenticadas; dois anos escolares');
    for (const [width, height] of [[1024,600],[390,664],[320,600]]) for (const theme of ['light','dark']) {
      const c = await context(width, height, theme), p = await c.newPage(); await go(p, '/banco-questoes'); await expect(rows(p).first()).toBeVisible();
      await capture(p, `bank-${width}-${theme}`, true);
      await p.getByRole('button', { name: /^Filtros/ }).click(); await capture(p, `filters-${width}-${theme}`);
      await p.getByRole('button', { name: 'Concluir filtros' }).click();
      await rows(p).first().getByRole('button', { name: 'Ver questão e gabarito' }).click(); await capture(p, `details-${width}-${theme}`);
      await expect(rows(p).first()).toContainText('Alternativa correta'); await selectFirst(p); await openSet(p);
      await capture(p, `selection-${width}-${theme}`); await dialog(p).getByRole('button', { name: 'Salvar simulado' }).click();
      await expect(dialog(p).getByRole('alert')).toContainText('Informe um título'); await expect(dialog(p).getByRole('alert')).toBeFocused();
      await p.keyboard.press('Escape'); await expect(p.getByRole('button', { name: 'Conferir e gerar simulado' })).toBeFocused(); await c.close();
    }
    check('Enunciado antes da rolagem em 1024/390/320 e dois temas; filtros/detalhes/seleção, alvos de 44 px, erro local com foco e Escape');
    const c = await context(), p = await c.newPage(); await go(p); await expect(rows(p)).toHaveCount(10);
    let queries = 0; p.on('request', r => { if (r.url().includes('/api/question-bank/questions?')) queries++; });
    await p.getByRole('searchbox').fill('QA-BANK-14'); await p.waitForTimeout(450); assert.equal(queries, 0, 'typing must not fetch every key');
    await p.getByRole('button', { name: 'Buscar', exact: true }).click(); await expect(rows(p)).toHaveCount(1);
    await search(p, 'QA-BANK'); await expect(rows(p)).toHaveCount(10); await selectFirst(p); const firstId = await rows(p).first().getAttribute('data-bank-question');
    await p.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(p.getByRole('heading', { name: /questões encontradas/ })).toBeFocused(); await expect(rows(p)).toHaveCount(4);
    await selectFirst(p); await openSet(p); await expect(dialog(p).locator('[data-selected-question]')).toHaveCount(2);
    await dialog(p).locator(`[data-selected-question="${firstId}"]`).getByRole('button').click(); await expect(dialog(p).locator('[data-selected-question]')).toHaveCount(1);
    await dialog(p).getByLabel('Título do simulado').fill('Rascunho preservado'); await p.keyboard.press('Escape'); await openSet(p); await expect(dialog(p).getByLabel('Título do simulado')).toHaveValue('Rascunho preservado'); await p.keyboard.press('Escape');
    await p.getByRole('button', { name: /^Filtros/ }).click(); await p.getByLabel('Ano escolar', { exact: true }).selectOption(String(alternate.grade_id)); await expect(rows(p)).toHaveCount(1); await expect(p.getByLabel('Unidade temática')).toBeEnabled();
    await p.getByLabel('Unidade temática').selectOption(String(alternate.unit_id)); await expect(p.getByLabel('Habilidade BNCC', { exact: true })).toBeEnabled(); await p.getByLabel('Habilidade BNCC', { exact: true }).selectOption(String(alternate.id));
    await p.getByLabel('Dificuldade', { exact: true }).selectOption('facil'); await expect(rows(p)).toHaveCount(1);
    await p.getByRole('button', { name: 'Limpar filtros' }).click(); await expect(p.getByLabel('Ano escolar', { exact: true })).toHaveValue(''); await expect(p.getByLabel('Habilidade BNCC', { exact: true })).toHaveValue('');
    await p.getByLabel('Ano escolar', { exact: true }).selectOption('mine'); await p.waitForLoadState('networkidle'); assert.equal(new URL(p.url()).searchParams.get('grade_id'), 'mine');
    await p.getByRole('button', { name: 'Limpar filtros' }).click(); await p.getByRole('button', { name: 'Concluir filtros' }).click();
    await search(p, 'sem correspondência QA'); await expect(p.getByText('Nenhuma questão encontrada', { exact: true })).toBeVisible(); await capture(p, 'empty');
    await go(p, '/banco-questoes?search=QA-BANK&page=999'); await expect(p).toHaveURL(/page=2/); await expect(rows(p)).toHaveCount(4);
    check('Busca explícita, seleção/remover em outra página, formulário preservado, filtros encadeados/meus anos/limpar, vazio e normalização de página');
    for (const [id, status, body] of [['503',503,{error:'Indisponível'}],['invalid',200,{}]]) {
      await c.route('**/api/question-bank/questions?**', r => r.fulfill({ status, json: body })); await go(p); await expect(p.getByRole('heading', { name: 'Não foi possível carregar as questões' })).toBeVisible();
      await expect(p.getByText('Nenhuma questão encontrada', { exact: true })).toHaveCount(0); await capture(p, 'read-' + id);
      await c.unroute('**/api/question-bank/questions?**'); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(rows(p)).toHaveCount(10);
    }
    await c.route('**/api/question-bank/grades', r => r.fulfill({ status: 503, json: {} })); await go(p); await expect(rows(p)).toHaveCount(10); await expect(p.getByRole('alert')).toContainText('anos escolares'); await capture(p, 'independent-filter-error');
    await c.unroute('**/api/question-bank/grades'); await p.getByRole('button', { name: 'Recarregar anos escolares' }).click(); await expect(p.getByRole('alert')).toHaveCount(0);
    let releaseOld, entered; const gate = new Promise(r => { releaseOld = r; }), started = new Promise(r => { entered = r; });
    await c.route('**/api/question-bank/units?grade_id=' + skill.grade_id, async r => { const response = await r.fetch(); entered(); await gate; await r.fulfill({ response }).catch(() => {}); });
    await p.getByRole('button', { name: /^Filtros/ }).click(); await p.getByLabel('Ano escolar', { exact: true }).selectOption(String(skill.grade_id)); await started;
    await p.getByLabel('Ano escolar', { exact: true }).selectOption(String(alternate.grade_id)); await expect(p.getByLabel('Unidade temática')).toBeEnabled(); releaseOld(); await p.waitForTimeout(250);
    const expectedUnits = (await api('/question-bank/units?grade_id=' + alternate.grade_id)).data.map(u => String(u.id));
    assert.deepEqual(await p.getByLabel('Unidade temática').locator('option').evaluateAll(items => items.slice(1).map(i => i.value)), expectedUnits); await c.unroute('**/api/question-bank/units?grade_id=' + skill.grade_id);
    check('GET 503 e 200 inválido sem falso vazio; categorias independentes; resposta atrasada de ano anterior descartada');
    await go(p, '/banco-questoes?turma=' + classPublicId + '&search=QA-BANK'); await expect(p.locator('[data-bank-context]')).toContainText('Turma:'); await capture(p, 'cycle-context');
    await selectFirst(p); await openSet(p); await dialog(p).getByLabel('Título do simulado').fill('QA-BANK simulado único');
    let releaseSet, startedSet, writes = 0; const writeGate = new Promise(r => { releaseSet = r; }), writeStarted = new Promise(r => { startedSet = r; });
    await c.route('**/api/question-bank/question-sets', async r => { if (r.request().method() !== 'POST') return r.continue(); writes++; startedSet(); await writeGate; await r.continue(); });
    await dialog(p).getByRole('button', { name: 'Salvar simulado' }).click(); await writeStarted; await expect(dialog(p).getByRole('button', { name: 'Fechar', exact: true })).toBeDisabled(); await p.keyboard.press('Escape'); await expect(p.getByRole('dialog')).toHaveCount(1);
    releaseSet(); await expect(p).toHaveURL(/\/simulados\/\d+\?turma=/); assert.equal(new URL(p.url()).searchParams.get('turma'), classPublicId); assert.equal(writes, 1); await c.unroute('**/api/question-bank/question-sets');
    await go(p); await selectFirst(p); await openSet(p); await dialog(p).getByLabel('Título do simulado').fill('QA-BANK resposta incerta');
    let uncertainWrites = 0; await c.route('**/api/question-bank/question-sets', async r => { if (r.request().method() !== 'POST') return r.continue(); uncertainWrites++; const response = await r.fetch(); assert.equal(response.status(), 201); await r.fulfill({ status: 503, json: { error: 'Resposta perdida após gravar' } }); });
    await dialog(p).getByRole('button', { name: 'Salvar simulado' }).click(); await expect(dialog(p).getByRole('alert')).toContainText('pode ter sido salvo'); await expect(dialog(p).getByRole('button', { name: 'Salvar simulado' })).toBeDisabled(); await capture(p, 'uncertain-set');
    await p.waitForTimeout(500); assert.equal(uncertainWrites, 1); assert.equal(db.prepare('SELECT COUNT(*) FROM question_sets WHERE title=?').pluck().get('QA-BANK resposta incerta'), 1);
    await p.keyboard.press('Escape'); await openSet(p); await expect(dialog(p).getByRole('button', { name: 'Salvar simulado' })).toBeDisabled();
    p.once('dialog', d => d.dismiss()); await dialog(p).getByRole('button', { name: 'Já conferi: liberar nova tentativa' }).click(); await expect(dialog(p).getByRole('button', { name: 'Salvar simulado' })).toBeDisabled();
    p.once('dialog', d => d.accept()); await dialog(p).getByRole('button', { name: 'Já conferi: liberar nova tentativa' }).click(); await expect(dialog(p).getByRole('button', { name: 'Salvar simulado' })).toBeEnabled(); await p.keyboard.press('Escape'); await c.unroute('**/api/question-bank/question-sets');
    check('Simulado manual salvo uma única vez, bloqueio de fechar durante envio, turma preservada; resposta perdida não gera repetição automática');
    await go(p, '/banco-questoes?turma=' + classPublicId); await p.getByText('Mais ações', { exact: true }).click(); await p.getByRole('button', { name: 'Gerar diagnóstico', exact: true }).click(); await expect(p.getByRole('dialog')).toHaveCount(1); await p.keyboard.press('Escape');
    await p.getByRole('button', { name: 'Minhas questões', exact: true }).click(); await expect(p).toHaveURL(/tab=author/); await p.getByRole('button', { name: 'Questões do banco', exact: true }).click(); assert.equal(new URL(p.url()).searchParams.get('turma'), classPublicId);
    const pc = await context(390,664,'light',previewUser), pp = await pc.newPage(); await go(pp, '/banco-questoes?search=' + own.data.question_code + '&status=inactive'); await expect(pp.getByText('Nenhuma questão encontrada', { exact: true })).toBeVisible(); await expect(pp.getByRole('button', { name: 'Nova questão', exact: true })).toHaveCount(0); await expect(pp.locator('[data-bank-context]')).toHaveCount(0);
    assert.equal((await api('/question-bank/questions/' + own.data.id, 'GET', null, previewUser)).status, 404); assert.equal((await api('/question-bank/questions', 'POST', payload('DENIED'), teacher)).status, 403); await pc.close();
    check('Entradas/retornos de diagnóstico e autorais preservados; outro docente não vê questão privada nem manutenção administrativa');
    for (const [width,height,theme] of [[1024,600,'light'],[390,664,'dark'],[320,600,'light']]) {
      const ac = await context(width,height,theme,admin), ap = await ac.newPage(); await go(ap); await rows(ap).first().getByRole('button', { name: 'Editar questão' }).click(); await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled();
      await expect(dialog(ap).locator('#bank-editor-skill-description')).toContainText('EF07MA01');
      await capture(ap, `editor-${width}-${theme}`); await dialog(ap).getByRole('radio', { name: 'Alternativa correta D' }).scrollIntoViewIfNeeded(); await capture(ap, `editor-options-${width}-${theme}`); await ap.keyboard.press('Escape');
      await expect(rows(ap).first().getByRole('button', { name: 'Editar questão' })).toBeFocused(); await ac.close();
    }
    const ac = await context(390,664,'dark',admin), ap = await ac.newPage(); await go(ap); await rows(ap).first().getByRole('button', { name: 'Editar questão' }).click();
    await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled(); const code = await dialog(ap).getByLabel('Código da questão').inputValue();
    await dialog(ap).getByLabel('Enunciado', { exact: true }).fill('Enunciado preservado após falha de gravação');
    await ac.route('**/api/question-bank/questions/*', r => r.request().method() === 'PUT' ? r.fulfill({ status: 503, json: {} }) : r.continue());
    await dialog(ap).getByRole('button', { name: 'Salvar alterações' }).click(); await expect(dialog(ap).getByRole('alert')).toContainText('Não foi possível confirmar'); await expect(dialog(ap).getByLabel('Enunciado', { exact: true })).toHaveValue('Enunciado preservado após falha de gravação'); await capture(ap, 'editor-write-error');
    ap.once('dialog', d => d.dismiss()); await ap.keyboard.press('Escape'); await expect(ap.getByRole('dialog')).toHaveCount(1);
    await ac.unroute('**/api/question-bank/questions/*'); await dialog(ap).getByRole('button', { name: 'Salvar alterações' }).click(); await expect(ap.getByRole('dialog')).toHaveCount(0);
    assert.equal(db.prepare('SELECT statement FROM questions WHERE question_code=?').pluck().get(code), 'Enunciado preservado após falha de gravação');
    const row = rows(ap).filter({ hasText: code }); await row.getByRole('button', { name: 'Ver questão e gabarito' }).click();
    ap.once('dialog', d => d.dismiss()); await row.getByRole('button', { name: 'Desativar questão' }).click(); assert.equal(db.prepare('SELECT status FROM questions WHERE question_code=?').pluck().get(code), 'active');
    ap.once('dialog', d => d.accept()); await row.getByRole('button', { name: 'Desativar questão' }).click(); await expect(row.getByRole('button', { name: 'Ativar questão' })).toBeVisible(); await expect(row.getByRole('button', { name: 'Selecionar ' + code, exact: true })).toBeDisabled();
    ap.once('dialog', d => d.accept()); await row.getByRole('button', { name: 'Ativar questão' }).click(); await expect(row.getByRole('button', { name: 'Desativar questão' })).toBeVisible();
    await ap.getByText('Mais ações', { exact: true }).click(); await ap.getByRole('button', { name: 'Nova questão', exact: true }).click(); await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled(); await dialog(ap).getByRole('button', { name: 'Criar questão', exact: true }).click(); await expect(dialog(ap).getByRole('alert')).toContainText('Código');
    await ap.evaluate(() => { window.blobAudit = { made: [], revoked: [] }; const create = URL.createObjectURL, revoke = URL.revokeObjectURL; URL.createObjectURL = b => { const u = create(b); window.blobAudit.made.push(u); return u; }; URL.revokeObjectURL = u => { window.blobAudit.revoked.push(u); revoke(u); }; });
    await dialog(ap).getByLabel('Anexar imagem da questão').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2nUAAAAASUVORK5CYII=', 'base64') });
    await expect(dialog(ap).getByRole('button', { name: 'Remover imagem' })).toBeVisible(); await dialog(ap).getByRole('button', { name: 'Remover imagem' }).click();
    ap.once('dialog', d => d.accept()); await ap.keyboard.press('Escape');
    const blobs = await ap.evaluate(() => window.blobAudit); assert.ok(blobs.made.length > 0 && blobs.made.every(u => blobs.revoked.includes(u)));
    assert.ok(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='update_question_status'").pluck().get() >= 2);
    check('Administração em telas baixas, gabarito/foco, edição preservada após erro, descarte confirmado, ativar/desativar auditados e liberação da prévia de imagem');
    await ap.getByRole('button', { name: 'Nova questão', exact: true }).click(); await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled();
    await dialog(ap).getByLabel('Código da questão').fill('QA-IMAGE-CREATED'); await dialog(ap).getByLabel('Enunciado', { exact: true }).fill('Observe a imagem e marque a alternativa correta.');
    await dialog(ap).getByLabel('Habilidade BNCC da questão').selectOption(String(skill.id)); await dialog(ap).getByLabel('Dificuldade', { exact: true }).selectOption('dificil');
    await dialog(ap).getByLabel('Texto de apoio opcional').fill('Texto de apoio completo.'); await dialog(ap).getByLabel('Comentário pedagógico', { exact: true }).fill('Explique o raciocínio.');
    await dialog(ap).getByLabel('Espaço para desenvolvimento na prova').selectOption('large'); await dialog(ap).getByLabel('Marcar questão como revisada').check();
    for (const label of ['A','B','C','D']) await dialog(ap).getByRole('textbox', { name: 'Alternativa ' + label, exact: true }).fill('Opção ' + label);
    await dialog(ap).getByRole('radio', { name: 'Alternativa correta C' }).check();
    await dialog(ap).getByLabel('Anexar imagem da questão').setInputFiles({ name: 'fixture.png', mimeType: 'image/png', buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2nUAAAAASUVORK5CYII=', 'base64') });
    let creates = 0; await ac.route('**/api/question-bank/questions', async r => { if (r.request().method() === 'POST') creates++; await r.continue(); });
    await dialog(ap).getByRole('button', { name: 'Criar questão', exact: true }).dblclick(); await expect(ap.getByRole('dialog')).toHaveCount(0); assert.equal(creates, 1); await ac.unroute('**/api/question-bank/questions');
    const imageQuestion = db.prepare('SELECT * FROM questions WHERE question_code=?').get('QA-IMAGE-CREATED'); assert.ok(imageQuestion.image_path); assert.equal(imageQuestion.difficulty, 'dificil'); assert.equal(imageQuestion.development_space, 'large'); assert.equal(imageQuestion.reviewed, 1);
    assert.equal(db.prepare('SELECT option_label FROM question_options WHERE question_id=? AND is_correct=1').pluck().get(imageQuestion.id), 'C');
    await go(p, '/banco-questoes?search=QA-IMAGE-CREATED'); await expect(rows(p)).toHaveCount(1); await rows(p).first().getByRole('button', { name: 'Ver questão e gabarito' }).click();
    const img = rows(p).getByRole('img', { name: 'Imagem da questão QA-IMAGE-CREATED' }); await img.scrollIntoViewIfNeeded(); await expect(img).toBeVisible(); await expect.poll(() => img.evaluate(i => i.naturalWidth)).toBeGreaterThan(0);
    await selectFirst(p); await openSet(p); await dialog(p).getByLabel('Mostrar imagem desta questão no simulado').uncheck(); await dialog(p).getByLabel('Título do simulado').fill('QA-IMAGE sem imagem'); await dialog(p).getByLabel('Compartilhar este simulado com outros professores').check();
    await capture(p, 'image-selection'); await dialog(p).getByRole('button', { name: 'Salvar simulado' }).click(); await expect(p).toHaveURL(/\/simulados\/\d+/);
    const setId = Number(new URL(p.url()).pathname.split('/').at(-1)); const savedSet = (await api('/question-bank/question-sets/' + setId)).data;
    assert.equal(savedSet.is_public, 1); assert.equal(savedSet.questions[0].show_image, 0);
    await go(p, '/banco-questoes?search=' + own.data.question_code); await selectFirst(p); await openSet(p); await expect(dialog(p).getByRole('checkbox')).toBeDisabled(); await dialog(p).getByLabel('Título do simulado').fill('QA-PRIVATE autoral'); await dialog(p).getByRole('button', { name: 'Salvar simulado' }).click(); await expect(p).toHaveURL(/\/simulados\/\d+/);
    const privateSetId = Number(new URL(p.url()).pathname.split('/').at(-1)); assert.equal((await api('/question-bank/question-sets/' + privateSetId)).data.is_public, 0); assert.notEqual((await api('/question-bank/question-sets/' + privateSetId, 'GET', null, previewUser)).status, 200);
    await search(ap, 'QA-IMAGE-CREATED'); await rows(ap).first().getByRole('button', { name: 'Editar questão' }).click(); await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled();
    await dialog(ap).getByRole('button', { name: 'Remover imagem' }).click(); await dialog(ap).getByLabel('Texto de apoio opcional').fill(''); await dialog(ap).getByLabel('Comentário pedagógico', { exact: true }).fill(''); await dialog(ap).getByRole('button', { name: 'Salvar alterações' }).click(); await expect(ap.getByRole('dialog')).toHaveCount(0);
    const cleared = db.prepare('SELECT image_path,support_text,official_explanation FROM questions WHERE id=?').get(imageQuestion.id); assert.deepEqual(cleared, { image_path: null, support_text: null, official_explanation: null });
    check('Criação administrativa única com campos/gabarito/imagem; leitura autorizada, simulado público sem imagem, autoral privado e limpeza explícita de campos');
    await go(p); await selectFirst(p); await c.route('**/api/question-bank/questions?**', r => r.fulfill({ status: 503, json: {} })); await search(p, 'QA-BANK-02');
    await expect(p.getByRole('heading', { name: 'Não foi possível carregar as questões' })).toBeVisible(); await expect(p.getByRole('region', { name: 'Seleção para o simulado' })).toContainText('1 questão selecionada');
    await c.unroute('**/api/question-bank/questions?**'); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(rows(p)).toHaveCount(1); await openSet(p); await expect(dialog(p).locator('[data-selected-question]')).toHaveCount(1); await p.keyboard.press('Escape');
    await ac.route('**/api/question-bank/skills', r => r.fulfill({ status: 503, json: {} })); await rows(ap).first().getByRole('button', { name: 'Editar questão' }).click(); await expect(dialog(ap).getByRole('alert')).toContainText('campos foram preservados'); await expect(dialog(ap).getByRole('button', { name: 'Salvar alterações' })).toBeDisabled();
    await ac.unroute('**/api/question-bank/skills'); await dialog(ap).getByRole('button', { name: 'Recarregar habilidades do editor' }).click(); await expect(dialog(ap).getByLabel('Habilidade BNCC da questão')).toBeEnabled(); await ap.keyboard.press('Escape');
    check('Falha de busca preserva seleção fora do resultado; falha de habilidades bloqueia salvar e permite retomar sem perder campos');
    await go(p); const until = Date.now() + 30000; let cycles = 0;
    while (Date.now() < until) { await p.getByRole('button', { name: /^Filtros/ }).click(); await p.getByRole('button', { name: 'Concluir filtros' }).click(); await rows(p).first().getByRole('button', { name: 'Ver questão e gabarito' }).click(); await rows(p).first().getByRole('button', { name: 'Ocultar detalhes' }).click(); cycles++; await p.waitForTimeout(120); }
    report.internal.push({ explorationSeconds: 30, cycles }); await capture(p, 'exploration-final'); check('Exploração adicional de 30 segundos sem gravações: repetição de filtros e detalhes');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.error = error.stack; record(); throw error; }
  finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runQuestionBankBrowser };
