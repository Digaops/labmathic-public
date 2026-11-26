const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runQuestionSetsBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, questionSetId, db, output }) {
  assert.equal(process.env.QUESTION_SETS_BROWSER, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(output, path.join(root, 'tmp/question-sets-qa'));
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Simulados:', description); };
  async function api(url, method = 'GET', body, user = teacher) {
    const multipart = body instanceof FormData;
    const response = await fetch(baseUrl + '/api' + url, { method, headers: { ...(!multipart ? { 'Content-Type': 'application/json' } : {}), Authorization: 'Bearer ' + tokenFor(user) }, ...(body ? { body: multipart ? body : JSON.stringify(body) } : {}) });
    return { status: response.status, data: await response.json() };
  }
  const skill = db.prepare('SELECT id,grade_id FROM bncc_skills ORDER BY id LIMIT 1').get();
  const questions = [];
  for (let i = 1; i <= 2; i++) {
    const form = new FormData();
    for (const [key, value] of Object.entries({ skill_id: skill.id, statement: 'QA23 Questão ' + i + ': A turma separou 24 livros igualmente em quatro grupos. Quantos livros ficaram em cada grupo?', support_text: 'Use os dados para justificar sua resposta.', official_explanation: 'COMENTÁRIO-DO-PROFESSOR: 24 dividido por 4 é igual a 6.', difficulty: 'media', development_space: 'medium', options: JSON.stringify(['6','4','8','24'].map((text, index) => ({ option_label: 'ABCD'[index], option_text: text, is_correct: Number(index === 0) }))) })) form.append(key, String(value));
    form.append('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2nUAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'qa23.png');
    const q = await api('/question-bank/author-questions', 'POST', form); assert.equal(q.status, 201); questions.push(q.data);
  }
  const sets = [];
  for (let i = 1; i <= 12; i++) {
    const result = await api('/question-bank/question-sets', 'POST', { title: 'QA23 Simulado ' + String(i).padStart(2,'0') + ' — Operações e estratégias', description: 'Atividades para conferir o que a turma aprendeu.', question_ids: questions.map(q => q.id), is_public: false });
    assert.equal(result.status, 201); sets.push(result.data);
  }
  const diagnostic = await api('/question-bank/diagnostics/generate', 'POST', { title: 'QA23 Diagnóstico de números', gradeId: skill.grade_id, skillIds: [skill.id], questionsPerSkill: 2 }); assert.equal(diagnostic.status, 201);
  const official = db.prepare("SELECT id FROM questions WHERE source='official' AND status='active' LIMIT 1").pluck().get(); assert.ok(official);
  const shared = await api('/question-bank/question-sets', 'POST', { title: 'QA23 Compartilhado pela escola', question_ids: [official], is_public: true }, previewUser); assert.equal(shared.status, 201);
  const details = { baseUrl, teacher, admin, previewUser, teacherToken: tokenFor(teacher), adminToken: tokenFor(admin), previewToken: tokenFor(previewUser), classPublicId, questionSetId, questions, sets, diagnostic: diagnostic.data, shared: shared.data };
  if (process.env.QUESTION_SETS_INTERACTIVE === '1') {
    const connection = path.join(output, 'interactive-connection.json'), stop = path.join(output, 'interactive-stop');
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
    fs.writeFileSync(connection, JSON.stringify(details)); console.log('QUESTION_SETS_INTERACTIVE_READY');
    try { await new Promise((resolve, reject) => {
      const timer = setInterval(() => { if (fs.existsSync(stop)) { clearInterval(timer); clearTimeout(expiry); resolve(); } }, 250);
      const expiry = setTimeout(() => { clearInterval(timer); reject(Error('Interactive fixture expired')); }, 480000);
    }); } finally { if (fs.existsSync(connection)) fs.unlinkSync(connection); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
    return { ...report, status: 'captured' };
  }
  return await runChecks({ details, db, output, report, record, check, api });
}

async function runChecks({ details, db, output, report, record, check, api }) {
  const { baseUrl, teacher, admin, previewUser, teacherToken, adminToken, previewToken, sets, diagnostic, shared, questions, classPublicId } = details;
  const browser = await chromium.launch({ headless: true }), contexts = [];
  async function context(width = 390, height = 664, theme = 'dark', user = teacher) {
    const c = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(c);
    await c.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await c.addInitScript(({ origin, user, token, theme }) => { if (location.origin === origin) { localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); } }, { origin: baseUrl, user, token: user.id === teacher.id ? teacherToken : user.id === admin.id ? adminToken : previewToken, theme });
    c.on('page', p => p.on('pageerror', e => report.pageErrors.push(e.message)));
    return c;
  }
  async function go(p, url = '/simulados') {
    await p.goto(baseUrl + url); await p.waitForLoadState('networkidle');
    const announcement = p.getByRole('button', { name: 'Entendi, continuar' });
    if (await announcement.isVisible()) { await announcement.click(); await p.waitForLoadState('networkidle'); }
  }
  async function capture(p, name, primary) {
    await p.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
    fs.writeFileSync(path.join(output, name + '.txt'), await p.locator('body').innerText());
    const bounds = await p.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth }));
    assert.equal(bounds.width, p.viewportSize().width, name + ': virtual mobile viewport shrinks the interface');
    assert.ok(bounds.scrollWidth <= bounds.width + 1, name + ': horizontal overflow');
    if (primary) { const rect = await primary.boundingBox(); assert.ok(rect && rect.y >= 0 && rect.y + 24 < bounds.height, name + ': primary task hidden'); }
    const scope = await p.getByRole('dialog').count() ? p.getByRole('dialog').last() : p.locator('[data-question-sets],[data-question-set-detail]');
    if (await scope.count()) {
      const controls = await scope.locator('button,a,input,select,summary').evaluateAll(nodes => nodes.filter(n => n.getClientRects().length && !n.closest('details:not([open]) :not(summary)')).map(n => ({ label: n.getAttribute('aria-label') || n.textContent?.trim(), width: n.getBoundingClientRect().width, height: n.getBoundingClientRect().height })));
      assert.deepEqual(controls.filter(c => c.height < 43.5 || c.width < 43.5), [], name + ': small controls');
      if (await p.getByRole('dialog').count()) { const rect = await scope.boundingBox(); assert.ok(rect.y >= 0 && rect.y + rect.height <= bounds.height + 1, name + ': clipped dialog'); }
    }
    report.cases.push({ name, ...bounds }); record();
  }
  async function printPreview(p, teacherVersion = false) {
    await p.getByRole('button', { name: 'Imprimir', exact: true }).click();
    const popup = p.waitForEvent('popup');
    await p.getByRole('button', { name: teacherVersion ? 'Gerar versão do professor' : 'Gerar versão do aluno' }).click();
    const preview = await popup;
    await expect(preview.getByRole('button', { name: 'Imprimir / salvar PDF' })).toBeEnabled({ timeout: 20000 });
    return preview;
  }
  const rows = p => p.locator('[data-question-set]'), dialog = p => p.getByRole('dialog').last();
  async function search(p, value) {
    const response = p.waitForResponse(r => new URL(r.url()).pathname === '/api/question-bank/question-sets' && new URL(r.url()).searchParams.get('search') === value);
    await p.getByRole('searchbox', { name: 'Buscar simulado' }).fill(value);
    await p.getByRole('button', { name: 'Buscar', exact: true }).click(); await response; await p.waitForLoadState('networkidle');
  }
  try {
    for (const [width, height] of [[1024,600],[390,664],[320,600]]) for (const theme of ['light','dark']) {
      const c = await context(width, height, theme), p = await c.newPage(); let listCalls = 0, detailCalls = 0;
      p.on('request', r => { const url = new URL(r.url()); if (url.pathname === '/api/question-bank/question-sets') listCalls++; if (/\/api\/question-bank\/question-sets\/\d+$/.test(url.pathname)) detailCalls++; });
      await go(p); await expect(rows(p)).toHaveCount(10); assert.equal(listCalls,1); assert.equal(detailCalls,0);
      await capture(p, 'sets-' + width + '-' + theme, rows(p).first().getByRole('heading'));
      await rows(p).first().getByText('Detalhes e opções', { exact: true }).click(); await capture(p, 'sets-options-' + width + '-' + theme);
      await rows(p).first().getByRole('link', { name: /^Abrir / }).click(); await p.locator('[data-set-statement]').first().waitFor();
      await capture(p, 'set-detail-' + width + '-' + theme, p.locator('[data-set-statement]').first());
      await p.getByText('Sobre o simulado', { exact: true }).click(); await expect(p.getByText('Gabarito equilibrado.', { exact: true })).toBeVisible(); await capture(p, 'set-about-' + width + '-' + theme); await p.getByText('Sobre o simulado', { exact: true }).click();
      await p.getByRole('button', { name: 'Imprimir', exact: true }).click(); await capture(p, 'set-print-options-' + width + '-' + theme); await p.keyboard.press('Escape'); await expect(p.getByRole('button', { name: 'Imprimir', exact: true })).toBeFocused();
      await go(p, '/simulados/' + diagnostic.id); await capture(p, 'set-diagnostic-' + width + '-' + theme, p.locator('[data-set-statement]').first());
      await p.getByRole('button', { name: 'Imprimir', exact: true }).click(); await expect(dialog(p).getByRole('button', { name: 'Gerar versão do aluno' })).toBeDisabled(); await p.keyboard.press('Escape');
      await c.close();
    }
    check('Lista sem N+1; detalhe, metadados, revisão pendente e impressão em três resoluções e dois temas, foco/alvos/primeira tarefa');
    const c = await context(), p = await c.newPage();
    await go(p); await p.getByRole('button', { name: 'Próxima', exact: true }).click(); await expect(p).toHaveURL(/set_page=2/); await p.getByRole('heading', { name: /simulados encontrados/ }).waitFor();
    await rows(p).first().getByRole('link', { name: /^Abrir / }).click(); await p.locator('[data-set-statement]').first().waitFor(); await p.getByRole('link', { name: 'Voltar aos simulados' }).click(); await expect(p).toHaveURL(/set_page=2/); await expect(rows(p)).toHaveCount(6);
    await search(p, 'QA23 Simulado 12'); await expect(rows(p)).toHaveCount(1); await rows(p).getByRole('link', { name: /^Abrir / }).click(); await p.locator('[data-set-statement]').first().waitFor(); await p.getByRole('link', { name: 'Voltar aos simulados' }).click(); await expect(p.getByRole('searchbox', { name: 'Buscar simulado' })).toHaveValue('QA23 Simulado 12');
    await p.getByRole('button', { name: 'Minhas questões', exact: true }).click(); await expect(p.locator('[data-author-questions]')).toBeVisible(); await expect(p).toHaveURL(/tab=questions/); await p.getByRole('button', { name: 'Simulados', exact: true }).click(); await expect(rows(p)).toHaveCount(1); await p.getByRole('button', { name: 'Limpar busca' }).click(); await expect(rows(p)).toHaveCount(10);
    await search(p, 'QA23-NÃO-EXISTE'); await expect(p.getByRole('heading', { name: 'Nenhum simulado corresponde à busca' })).toBeVisible(); await capture(p, 'sets-empty-search');
    for (const status of [503,200]) {
      await c.route('**/api/question-bank/question-sets?**', r => r.fulfill({ status, json: {} })); await go(p); await expect(p.getByRole('heading', { name: 'Não foi possível carregar os simulados' })).toBeVisible(); await capture(p, 'sets-read-' + status); await c.unroute('**/api/question-bank/question-sets?**'); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await expect(rows(p)).toHaveCount(10);
    }
    await go(p, '/simulados/' + sets[0].id); await c.route('**/api/question-bank/question-sets/' + sets[0].id, r => r.fulfill({ status:200,json:{} })); await p.reload(); await expect(p.getByRole('heading', { name: 'Não foi possível abrir o simulado' })).toBeVisible(); await capture(p, 'set-read-invalid'); await c.unroute('**/api/question-bank/question-sets/' + sets[0].id); await p.getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await p.locator('[data-set-statement]').first().waitFor();
    check('Busca/página/retorno/abas preservados; vazios reais, 503 e respostas inválidas com repetição somente da leitura');
    await c.route('**/uploads/*.png', r => r.fulfill({ status:503,body:'' }));await p.reload();await p.getByRole('button',{name:'Recarregar imagem'}).first().waitFor();await capture(p,'set-image-load-error');await c.unroute('**/uploads/*.png');await p.getByRole('button',{name:'Recarregar imagem'}).first().click();await expect(p.locator('[data-set-question]').first().getByRole('button',{name:'Recarregar imagem'})).toHaveCount(0);
    const first = p.locator('[data-set-question]').first(), second = p.locator('[data-set-question]').nth(1);
    let releaseWrite, startedWrite; const gate = new Promise(r => releaseWrite = r), entered = new Promise(r => startedWrite = r); let imageWrites = 0;
    const imageRoute = '**/api/question-bank/question-sets/' + sets[0].id + '/items/*/image-visibility';
    await c.route(imageRoute, async r => { imageWrites++; const response = await r.fetch(); startedWrite(); await gate; await r.fulfill({ response }); });
    await first.getByRole('button', { name: 'Ocultar imagem' }).click(); await entered; await expect(first.getByRole('button', { name: 'Ocultar imagem' })).toBeDisabled(); await expect(second.getByRole('button', { name: 'Ocultar imagem' })).toBeDisabled(); await expect(p.getByRole('button', { name: 'Imprimir', exact:true })).toBeDisabled(); releaseWrite(); await expect(first.getByRole('button', { name: 'Incluir imagem' })).toBeEnabled(); assert.equal(imageWrites,1); await c.unroute(imageRoute);
    await first.getByRole('button', { name: 'Incluir imagem' }).click(); await expect(first.getByRole('button', { name: 'Ocultar imagem' })).toBeEnabled();
    await c.route(imageRoute, async r => { imageWrites++; assert.equal((await r.fetch()).status(),200); await r.fulfill({status:503,json:{}}); });
    await first.getByRole('button', { name:'Ocultar imagem' }).click(); await expect(p.getByRole('button', { name: 'Conferir situação salva' })).toBeVisible(); await expect(p.getByRole('button', { name:'Imprimir',exact:true })).toBeDisabled(); await capture(p,'set-image-uncertain'); assert.equal(imageWrites,2); await c.unroute(imageRoute); await p.getByRole('button',{name:'Conferir situação salva'}).click(); await expect(p.locator('[data-set-question]').first().getByRole('button',{name:'Incluir imagem'})).toBeEnabled(); await p.locator('[data-set-question]').first().getByRole('button',{name:'Incluir imagem'}).click(); await expect(p.locator('[data-set-question]').first().getByRole('button',{name:'Ocultar imagem'})).toBeEnabled();
    check('Imagens sem confirmação otimista; escritas serializadas e impressão bloqueada até reconciliar resposta perdida por GET');
    await go(p, '/simulados/' + diagnostic.id + '?turma=' + classPublicId);
    p.once('dialog', d => d.dismiss()); await p.getByRole('button', { name:'Confirmar revisão e liberar' }).click(); assert.equal(db.prepare('SELECT COUNT(*) FROM diagnostic_question_set_reviews WHERE question_set_id=?').pluck().get(diagnostic.id),0);
    let reviews = 0; const reviewRoute = '**/api/question-bank/question-sets/' + diagnostic.id + '/diagnostic-review';
    await c.route(reviewRoute, async r => { reviews++; assert.equal((await r.fetch()).status(),201); await r.fulfill({status:503,json:{}}); });
    p.once('dialog', d => d.accept()); await p.getByRole('button', { name:'Confirmar revisão e liberar' }).click(); await expect(p.getByRole('button',{name:'Conferir situação salva'})).toBeVisible(); await expect(p.getByRole('button',{name:'Confirmar revisão e liberar'})).toBeDisabled(); await capture(p,'set-review-uncertain'); assert.equal(reviews,1); await c.unroute(reviewRoute); await p.getByRole('button',{name:'Conferir situação salva'}).click(); await expect(p.getByRole('link',{name:'Preparar aplicação nesta turma'})).toBeVisible(); await capture(p,'set-reviewed-with-class');
    assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='review_diagnostic_question_set' AND entity_id=?").pluck().get(diagnostic.id),1);
    assert.match(await p.getByRole('link',{name:'Preparar aplicação nesta turma'}).getAttribute('href'),new RegExp('simulado='+diagnostic.id));
    await go(p,'/simulados/'+diagnostic.id+'?turma=inexistente'); await expect(p.getByRole('link',{name:'Preparar aplicação nesta turma'})).toHaveCount(0); await expect(p.getByRole('region',{name:'Contexto do ciclo pedagógico'}).getByRole('alert')).toBeVisible();
    const otherC = await context(390,664,'dark',previewUser), otherP = await otherC.newPage(); await go(otherP,'/simulados/'+sets[0].id); await expect(otherP.getByRole('heading',{name:'Não foi possível abrir o simulado'})).toBeVisible(); await go(otherP,'/simulados/'+shared.id+'?turma='+classPublicId); await expect(otherP.getByRole('button',{name:'Confirmar revisão e liberar'})).toHaveCount(0); await expect(otherP.getByRole('region',{name:'Contexto do ciclo pedagógico'})).toHaveCount(0); await capture(otherP,'set-other-teacher');
    assert.equal((await api('/question-bank/question-sets/'+sets[0].id+'/items/'+questions[0].id+'/image-visibility','PATCH',{show_image:false},previewUser)).status,403);
    const adminC=await context(1024,600,'light',admin),adminP=await adminC.newPage();await go(adminP,'/simulados/'+diagnostic.id);await expect(adminP.getByRole('button',{name:'Confirmar revisão e liberar'})).toHaveCount(0);await capture(adminP,'set-admin');await adminC.close();await otherC.close();
    check('Revisão explicitamente confirmada e auditada uma vez; resposta perdida reconciliada; turma/perfil/acesso não ampliados');
    await go(p);const removable=await api('/question-bank/question-sets','POST',{title:'QA23 Exclusão confirmada',question_ids:[questions[0].id]});assert.equal(removable.status,201);await search(p,'QA23 Exclusão confirmada');await rows(p).getByText('Detalhes e opções',{exact:true}).click();p.once('dialog',d=>d.dismiss());await rows(p).getByRole('button',{name:'Excluir simulado'}).click();assert.ok(db.prepare('SELECT id FROM question_sets WHERE id=?').get(removable.data.id));p.once('dialog',d=>d.accept());await rows(p).getByRole('button',{name:'Excluir simulado'}).click();await expect(rows(p)).toHaveCount(0);assert.equal(db.prepare('SELECT id FROM question_sets WHERE id=?').get(removable.data.id),undefined);assert.ok(db.prepare("SELECT id FROM activity_log WHERE action='delete_question_set' AND entity_id=?").get(removable.data.id));
    check('Exclusão com título, cancelamento e confirmação auditada na base temporária');
    await go(p,'/simulados/'+sets[0].id);
    for (const teacherVersion of [false,true]) {
      const preview=await printPreview(p,teacherVersion);await capture(preview,teacherVersion?'print-teacher':'print-student');assert.equal(await preview.evaluate(()=>window.opener===null),true);
      if(teacherVersion){await expect(preview.locator('.answer-key')).toHaveCount(1);await expect(preview.locator('.explanation')).toHaveCount(2);}else{await expect(preview.locator('.answer-key,.answer-mark,.explanation')).toHaveCount(0);await expect(preview.locator('.student-fields')).toHaveCount(1);}
      assert.equal(await preview.locator('img').evaluateAll(xs=>xs.every(x=>x.complete&&x.naturalWidth>0)),true);
      await preview.evaluate(()=>{window.__printCount=0;window.print=()=>{window.__printCount++;};});await preview.getByRole('button',{name:'Imprimir / salvar PDF'}).click();assert.equal(await preview.evaluate(()=>window.__printCount),1);
      await preview.pdf({path:path.join(output,teacherVersion?'teacher.pdf':'student.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true});
      const closed = preview.waitForEvent('close');await preview.getByRole('button',{name:'Fechar prévia'}).click();await closed;await p.keyboard.press('Escape');
    }
    await c.route('**/uploads/*.png',r=>r.fulfill({status:503,body:''}));await p.getByRole('button',{name:'Imprimir',exact:true}).click();let nextPopup=p.waitForEvent('popup');await dialog(p).getByRole('button',{name:'Gerar versão do aluno'}).click();let badPrint=await nextPopup;await expect(badPrint.getByRole('alert')).toContainText('impressão continua bloqueada');await expect(badPrint.getByRole('button',{name:'Imprimir / salvar PDF'})).toBeDisabled();await capture(badPrint,'print-images-failed');await c.unroute('**/uploads/*.png');await badPrint.getByRole('button',{name:'Tentar carregar imagens'}).click();await expect(badPrint.getByRole('button',{name:'Imprimir / salvar PDF'})).toBeEnabled();await badPrint.close();await p.keyboard.press('Escape');
    await p.evaluate(()=>{window.__openForQA=window.open;window.open=()=>null;});await p.getByRole('button',{name:'Imprimir',exact:true}).click();await dialog(p).getByRole('button',{name:'Gerar versão do aluno'}).click();await expect(dialog(p).getByRole('alert')).toContainText('Permita pop-ups');await capture(p,'print-popup-blocked');await p.evaluate(()=>{window.open=window.__openForQA;delete window.__openForQA;});await p.keyboard.press('Escape');
    check('Prévia aluno/professor com imagens confirmadas, sem gabarito para aluno, A4, impressão explícita, falha/repetição de mídia e popup bloqueado');
    let releaseImage, imageStarted; const imageGate=new Promise(r=>releaseImage=r), imageEntered=new Promise(r=>imageStarted=r);
    await c.route('**/uploads/*.png',async r=>{const response=await r.fetch();imageStarted();await imageGate;await r.fulfill({response}).catch(()=>{});});
    await p.getByRole('button',{name:'Imprimir',exact:true}).click();nextPopup=p.waitForEvent('popup');await dialog(p).getByRole('button',{name:'Gerar versão do aluno'}).click();const slowPrint=await nextPopup;await imageEntered;await expect(slowPrint.getByRole('button',{name:'Imprimir / salvar PDF'})).toBeDisabled();await capture(slowPrint,'print-images-loading');releaseImage();await expect(slowPrint.getByRole('button',{name:'Imprimir / salvar PDF'})).toBeEnabled();await slowPrint.close();await c.unroute('**/uploads/*.png');await p.keyboard.press('Escape');
    const fresh=await api('/question-bank/diagnostics/generate','POST',{title:'QA23 Revisão concluída',gradeId:diagnostic.grade.id,skillIds:[db.prepare('SELECT skill_id FROM questions WHERE id=?').pluck().get(questions[0].id)],questionsPerSkill:2});assert.equal(fresh.status,201);
    const pendingAdminC=await context(1024,600,'dark',admin),pendingAdminP=await pendingAdminC.newPage();await go(pendingAdminP,'/simulados/'+fresh.data.id);await expect(pendingAdminP.getByRole('button',{name:'Confirmar revisão e liberar'})).toHaveCount(0);await expect(pendingAdminP.getByText('A confirmação cabe ao professor responsável pelo diagnóstico.')).toBeVisible();assert.equal((await api('/question-bank/question-sets/'+fresh.data.id+'/diagnostic-review','POST',{confirmed:true},admin)).status,403);await capture(pendingAdminP,'set-admin-pending-review');await pendingAdminC.close();
    await go(p,'/simulados/'+fresh.data.id);p.once('dialog',d=>d.accept());await p.getByRole('button',{name:'Confirmar revisão e liberar'}).click();await expect(p.locator('[data-set-review]').getByRole('heading',{name:'Revisão confirmada'})).toBeFocused();await expect(p.getByRole('button',{name:'Confirmar revisão e liberar'})).toHaveCount(0);await capture(p,'set-review-success');
    await go(p);let releaseOld, oldStarted;const oldGate=new Promise(r=>releaseOld=r),oldEntered=new Promise(r=>oldStarted=r);
    await c.route('**/api/question-bank/question-sets?**',async r=>{if(new URL(r.request().url()).searchParams.get('search')!=='QA23 Simulado 01')return r.continue();const response=await r.fetch();oldStarted();await oldGate;await r.fulfill({response}).catch(()=>{});});
    await p.getByRole('searchbox',{name:'Buscar simulado'}).fill('QA23 Simulado 01');await p.getByRole('button',{name:'Buscar',exact:true}).click();await oldEntered;await p.getByRole('searchbox',{name:'Buscar simulado'}).fill('QA23 Simulado 12');await p.getByRole('button',{name:'Buscar',exact:true}).click();await expect(rows(p).getByRole('heading')).toHaveText(sets[11].title);releaseOld();await p.waitForTimeout(150);await expect(rows(p).getByRole('heading')).toHaveText(sets[11].title);await c.unroute('**/api/question-bank/question-sets?**');
    await c.route('**/api/question-bank/question-sets?**',r=>r.fulfill({status:200,json:{data:[],pagination:{page:1,limit:10,total:0,totalPages:0}}}));await go(p);await expect(p.getByRole('heading',{name:'Você ainda não tem simulados disponíveis'})).toBeVisible();await capture(p,'sets-empty');await c.unroute('**/api/question-bank/question-sets?**');
    check('Imagem atrasada não libera impressão; revisão bem-sucedida recupera foco; resposta de busca antiga é descartada e vazio inicial orienta criação');
    const longQuestion=await api('/question-bank/author-questions','POST',{skill_id:questions[0].skill_id,statement:'QA23 TEXTO-LONGO '+('Compare as estratégias e justifique cada resultado com os dados do problema. '.repeat(38))+' FIM-DO-ENUNCIADO',support_text:'APOIO-'+('palavra'.repeat(80)),difficulty:'media',development_space:'none',official_explanation:'FIM-COMENTÁRIO-LONGO',options:['CORRETA','Segunda resposta','Terceira resposta','Quarta resposta'].map((text,i)=>({option_label:'ABCD'[i],option_text:text,is_correct:Number(i===0)}))});assert.equal(longQuestion.status,201);
    const longSet=await api('/question-bank/question-sets','POST',{title:'QA23 Impressão de texto longo <script>teste</script>',question_ids:[longQuestion.data.id]});assert.equal(longSet.status,201);await go(p,'/simulados/'+longSet.data.id);let longPreview=await printPreview(p,true);await capture(longPreview,'print-long-text');await expect(longPreview.locator('script')).toHaveCount(0);await longPreview.pdf({path:path.join(output,'teacher-long.pdf'),format:'A4',preferCSSPageSize:true,printBackground:true});await longPreview.close();await p.keyboard.press('Escape');
    check('Texto longo e conteúdo com marcação permanecem completos e escapados na prévia e em A4');
    await go(p);const until=Date.now()+30000;let cycles=0;while(Date.now()<until){await rows(p).first().getByText('Detalhes e opções',{exact:true}).click();await rows(p).first().getByText('Detalhes e opções',{exact:true}).click();await p.keyboard.press('Tab');cycles++;await p.waitForTimeout(150);}report.exploration={seconds:30,cycles};await capture(p,'sets-exploration');check('Exploração adicional de detalhes, foco e teclado por 30 segundos');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.stack;
    for (const c of contexts) for (const [index, p] of c.pages().entries()) {
      fs.writeFileSync(path.join(output, 'failure-' + index + '.txt'), await p.locator('body').innerText().catch(() => 'unavailable'));
    }
    record(); throw error;
  } finally { for (const c of contexts) await c.close().catch(() => {}); await browser.close(); }
}
module.exports = { runQuestionSetsBrowser };
