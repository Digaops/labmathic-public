const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runCollectionsBrowser({ baseUrl, teacher, admin, tokenFor, materialId, collectionId, db, output }) {
  assert.equal(process.env.COLLECTIONS_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Coleções:', description); };
  const browser = await chromium.launch({ headless: true }); const contexts = [];
  const view = page => page.locator('[data-collections], [data-collection-view]');
  const rows = page => page.locator('[data-collection-materials] > div > a');
  const cards = page => page.locator('[data-collection-list] article');
  async function context(user = teacher, width = 390, height = 664, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(ctx);
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => { if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
      window.qaObjectUrls = { created: [], revoked: [] };
      const create = URL.createObjectURL.bind(URL), revoke = URL.revokeObjectURL.bind(URL);
      URL.createObjectURL = value => { const url = create(value); window.qaObjectUrls.created.push(url); return url; };
      URL.revokeObjectURL = url => { window.qaObjectUrls.revoked.push(url); revoke(url); };
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message))); return ctx;
  }
  async function go(page, url = '/colecoes', idle = true) {
    await page.goto(baseUrl + url, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(550);
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle'); await page.waitForTimeout(200);
  }
  async function capture(page, id, initial = false) {
    await page.waitForTimeout(250);
    const metrics = await page.evaluate(() => {
      const box = e => { const r = e?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
      const first = document.querySelector('[data-collection-materials] > div > a') || document.querySelector('[data-collection-list] article > a');
      const panel = document.querySelector('[role="dialog"]'); const scope = panel || document.querySelector('[data-collections], [data-collection-view]');
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        title: box(first?.querySelector('h2,h3')), action: box(first?.lastElementChild?.lastElementChild), modal: box(panel), alert: box(panel?.querySelector('[role="alert"]')),
        controls: [...scope.querySelectorAll('a,button,select,summary,input:not([type="checkbox"]),textarea')].filter(e => e.getClientRects().length).map(e => ({ label: e.getAttribute('aria-label') || e.textContent.trim().slice(0, 90) || e.type, ...box(e) })) };
    });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record(); assert.ok(metrics.scrollWidth <= metrics.width, id + ': no horizontal overflow');
    if (initial) { assert.equal(metrics.scrollY, 0); assert.ok(metrics.title?.y >= 108 && metrics.title?.bottom < metrics.height, id + ': title initially visible'); assert.ok(metrics.action?.bottom <= metrics.height, id + ': action initially visible'); }
    if (metrics.modal) assert.ok(metrics.modal.y >= 0 && metrics.modal.bottom <= metrics.height, id + ': dialog fits viewport');
    if (metrics.alert) assert.ok(metrics.alert.y >= metrics.modal.y && metrics.alert.bottom <= metrics.modal.bottom, id + ': error visible inside dialog');
    for (const control of metrics.controls) {
      assert.ok(control.height >= 44 && control.width >= 44, id + ': target ' + control.label); assert.ok(control.x >= 0 && control.right <= metrics.width + 1, id + ': bounds ' + control.label);
      if (metrics.modal && /^(Fechar|Cancelar|Criar laboratório|Salvar alterações|Salvando…)$/.test(control.label)) assert.ok(control.y >= metrics.modal.y && control.bottom <= metrics.modal.bottom, id + ': modal action remains visible ' + control.label);
    }
  }
  const api = (url, user = teacher, method = 'GET', body) => fetch(baseUrl + '/api' + url, { method, headers: { Authorization: 'Bearer ' + tokenFor(user), 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const svg = color => ({ name: `capa-${color}.svg`, mimeType: 'image/svg+xml', buffer: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="240" height="120"><rect width="240" height="120" fill="${color}"/><circle cx="120" cy="60" r="35" fill="white"/></svg>`) });
  try {
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const ctx = await context(teacher, width, height, theme), page = await ctx.newPage(); await go(page); await expect(cards(page)).toHaveCount(1);
      await capture(page, `list-${width}-${theme}`, true); await cards(page).first().getByRole('link').focus(); await page.keyboard.press('Enter');
      await expect(rows(page)).toHaveCount(1); await capture(page, `materials-${width}-${theme}`, true);
      await rows(page).first().focus(); await page.keyboard.press('Enter'); await expect(page.locator('[data-pdf-viewer] canvas')).toBeVisible();
      await page.getByRole('link', { name: 'Voltar para o laboratório', exact: true }).click(); await expect(rows(page)).toHaveCount(1);
      await expect(view(page).getByRole('button', { name: /Remover/ })).toHaveCount(0);
      await view(page).getByRole('link', { name: 'Voltar para laboratórios', exact: true }).click(); await expect(cards(page)).toHaveCount(1); await ctx.close();
    }
    check('Título e acesso na primeira tela: lista e materiais em 3 resoluções × 2 temas; teclado, PDF e retorno; professor sem ações administrativas');

    const otherId = Number(db.prepare("INSERT INTO materials(title,description,file_path,file_format,created_by) VALUES ('Atividade sem classificação','Material sintético.','layout-fixture.pdf','PDF',?)").run(admin.id).lastInsertRowid);
    db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collectionId, otherId);
    const ctx = await context(), page = await ctx.newPage(); await go(page, `/colecoes/${collectionId}`); await expect(rows(page)).toHaveCount(2);
    await page.getByLabel('Ano escolar', { exact: true }).selectOption({ label: '7º Ano - EF' }); await expect(rows(page)).toHaveCount(1);
    await page.getByLabel('Tipo de material', { exact: true }).selectOption({ label: 'PDF de teste' });
    const legacyUrl = page.url(); await page.reload(); await expect(rows(page)).toHaveCount(1);
    await rows(page).first().click(); await page.getByRole('link', { name: 'Voltar para o laboratório', exact: true }).click(); await expect(page).toHaveURL(legacyUrl);
    await page.getByLabel('Ano escolar', { exact: true }).selectOption('Sem ano definido'); await expect(page.getByLabel('Tipo de material', { exact: true })).toHaveValue(''); await expect(rows(page)).toHaveCount(1);
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
    await page.goBack(); await expect(rows(page)).toHaveCount(1); await page.goForward(); await expect(rows(page)).toHaveCount(2);
    await go(page, `/colecoes/${collectionId}?ano=Inexistente&tipo=PDF`); await expect(rows(page)).toHaveCount(0); await capture(page, 'unavailable-filter');
    await page.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
    await page.getByText('Sobre este laboratório', { exact: true }).click(); await expect(page.getByText('Materiais para planejar a aula.', { exact: true })).toBeVisible(); await capture(page, 'description-expanded');
    await page.getByText('Sobre este laboratório', { exact: true }).click(); await ctx.close();
    check('Filtros opcionais, categoria sem classificação, URL antiga, retorno do material, recarga, histórico, limpar e descrição sob demanda');

    const emptyId = Number(db.prepare("INSERT INTO collections(user_id,name,is_public) VALUES (?,'Coleção vazia',1)").run(admin.id).lastInsertRowid);
    const privateId = Number(db.prepare("INSERT INTO collections(user_id,name,is_public) VALUES (?,'Coleção restrita',0)").run(admin.id).lastInsertRowid);
    for (const [name, url, payload, status] of [['list-empty', '/colecoes', [], 200], ['list-error', '/colecoes', {}, 503], ['list-invalid', '/colecoes', {}, 200], ['detail-error', `/colecoes/${collectionId}`, {}, 503], ['detail-invalid', `/colecoes/${collectionId}`, { id: collectionId }, 200]]) {
      const c = await context(); let fail = true; const endpoint = url.replace('/colecoes', '/api/collections');
      await c.route(baseUrl + endpoint, route => fail ? route.fulfill({ status, json: payload }) : route.continue());
      const p = await c.newPage(); await go(p, url);
      if (name === 'list-empty') await expect(view(p).getByText('Nenhum laboratório disponível', { exact: true })).toBeVisible();
      else { await expect(view(p).getByRole('alert')).toBeVisible(); await expect(view(p)).not.toContainText('Nenhum laboratório disponível'); }
      await capture(p, name);
      if (name !== 'list-empty') { fail = false; await view(p).getByRole('button', { name: /Tentar novamente/ }).click(); await expect(p.locator('[data-collection-list], [data-collection-materials]')).toBeVisible(); }
      else { await view(p).getByRole('link', { name: 'Ir para Biblioteca', exact: true }).click(); await expect(p.locator('[data-library]')).toBeVisible(); }
      await c.close();
    }
    for (const [name, id] of [['empty', emptyId], ['restricted', privateId], ['missing', 99999999]]) {
      const c = await context(), p = await c.newPage(); await go(p, '/colecoes/' + id);
      if (name === 'empty') await expect(view(p).getByText('Este laboratório ainda não tem materiais', { exact: true })).toBeVisible();
      else await expect(view(p).getByRole('alert')).toBeVisible();
      await capture(p, 'detail-' + name); await c.close();
    }
    assert.equal((await api(`/collections/${privateId}`)).status, 403);
    for (const [url, method, body] of [['/collections', 'POST', { name: 'Proibido' }], [`/collections/${collectionId}`, 'PUT', { name: 'Proibido' }], [`/collections/${collectionId}`, 'DELETE'], [`/collections/${collectionId}/items/${materialId}`, 'DELETE']]) assert.equal((await api(url, teacher, method, body)).status, 403);
    check('Vazio real, 503, payload inválido, 403/404 e repetição: sem falso vazio; professor impedido de gravar também pela API');

    const slowCtx = await context(); let release; const gate = new Promise(resolve => { release = resolve; });
    await slowCtx.route(baseUrl + '/api/collections/' + collectionId, async route => { await gate; await route.continue(); });
    const slow = await slowCtx.newPage(); await go(slow, `/colecoes/${collectionId}`, false); await expect(view(slow).getByRole('status')).toBeVisible(); await capture(slow, 'detail-loading');
    await view(slow).getByRole('link', { name: 'Voltar para laboratórios', exact: true }).click(); await expect(cards(slow)).toHaveCount(2);
    await cards(slow).filter({ hasText: 'Coleção vazia' }).getByRole('link').click(); await expect(view(slow).getByRole('heading', { level: 1 })).toHaveText('Coleção vazia');
    release(); await slow.waitForTimeout(400); await expect(view(slow).getByRole('heading', { level: 1 })).toHaveText('Coleção vazia'); await expect(rows(slow)).toHaveCount(0); await slowCtx.close();
    check('Consulta lenta cancelada: navegar para outra coleção não mostra resposta da coleção anterior');

    const adminCtx = await context(admin, 320, 600), ap = await adminCtx.newPage(); await go(ap); await capture(ap, 'admin-list');
    await ap.getByRole('button', { name: 'Novo laboratório', exact: true }).click(); const dialog = ap.getByRole('dialog');
    await expect(dialog).toBeFocused();
    await dialog.getByLabel('Nome do laboratório', { exact: true }).fill('Coleção criada pela interface');
    await dialog.getByLabel('Descrição (opcional)', { exact: true }).fill('Materiais de teste para organizar aulas com diferentes estratégias.');
    await dialog.getByLabel('Capa (opcional)', { exact: true }).setInputFiles({ name: 'arquivo.exe', mimeType: 'application/octet-stream', buffer: Buffer.from('invalid') });
    await expect(dialog.getByRole('alert')).toContainText('Tipo de arquivo não permitido'); await capture(ap, 'admin-invalid-upload');
    await dialog.getByLabel('Capa (opcional)', { exact: true }).setInputFiles(svg('blue')); await expect(dialog.getByAltText('Prévia da capa')).toBeVisible();
    await dialog.getByLabel('Capa (opcional)', { exact: true }).setInputFiles(svg('teal'));
    await dialog.getByRole('button', { name: 'Criar laboratório', exact: true }).scrollIntoViewIfNeeded(); await capture(ap, 'admin-create-footer');
    await dialog.getByRole('button', { name: 'Criar laboratório', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const created = db.prepare("SELECT * FROM collections WHERE name='Coleção criada pela interface'").get(); assert.ok(created?.image_path);
    const urls = await ap.evaluate(() => window.qaObjectUrls); assert.ok(urls.created.length >= 2); assert.deepEqual(new Set(urls.revoked), new Set(urls.created));
    await expect(cards(ap).filter({ hasText: created.name })).toHaveCount(1); await capture(ap, 'admin-real-cover');
    await ap.getByRole('button', { name: `Editar ${created.name}`, exact: true }).click();
    await dialog.getByLabel('Visível para professores', { exact: true }).uncheck(); await dialog.getByLabel('Capa (opcional)', { exact: true }).setInputFiles(svg('purple'));
    await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click(); await expect(dialog).toHaveCount(0);
    assert.equal((await api(`/collections/${created.id}`)).status, 403);
    assert.equal(db.prepare('SELECT is_public FROM collections WHERE id=?').pluck().get(created.id), 0);
    assert.ok(fs.existsSync(path.join(path.dirname(db.name), 'uploads', created.image_path)), 'Previous cover preserved');
    await ap.getByRole('button', { name: `Editar ${created.name}`, exact: true }).click(); await dialog.getByLabel('Visível para professores', { exact: true }).check();
    await dialog.getByRole('button', { name: 'Salvar alterações', exact: true }).click(); await expect(dialog).toHaveCount(0); assert.equal((await api(`/collections/${created.id}`)).status, 200);
    check('Administração cria e edita pela interface, valida arquivo, troca capas, libera URLs temporárias e alterna visibilidade sem expor coleção restrita');

    await go(ap, `/material/${materialId}`); await ap.getByRole('button', { name: 'Adicionar ao laboratório', exact: true }).click();
    await ap.getByRole('region', { name: 'Escolher laboratório', exact: true }).getByRole('button', { name: created.name, exact: true }).click();
    await expect(ap.getByRole('region', { name: 'Escolher laboratório', exact: true })).toHaveCount(0);
    await go(ap, `/colecoes/${created.id}`); await expect(rows(ap)).toHaveCount(1); await capture(ap, 'admin-material');
    await ap.getByRole('button', { name: /Remover Problemas para conversar/ }).click(); await capture(ap, 'admin-remove-confirm');
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(rows(ap)).toHaveCount(1);
    await ap.getByRole('button', { name: /Remover Problemas para conversar/ }).click(); await dialog.getByRole('button', { name: 'Remover do laboratório', exact: true }).click(); await expect(rows(ap)).toHaveCount(0);
    assert.ok(db.prepare('SELECT id FROM materials WHERE id=?').get(materialId)); assert.ok(db.prepare('SELECT id FROM collection_items WHERE collection_id=? AND material_id=?').get(collectionId, materialId));
    await view(ap).getByRole('link', { name: 'Voltar para laboratórios', exact: true }).click(); await ap.getByRole('button', { name: `Excluir ${created.name}`, exact: true }).click();
    await capture(ap, 'admin-delete-confirm'); await ap.keyboard.press('Escape'); await expect(dialog).toHaveCount(0); await expect(ap.getByRole('button', { name: `Excluir ${created.name}`, exact: true })).toBeFocused();
    await ap.getByRole('button', { name: `Excluir ${created.name}`, exact: true }).click(); await dialog.getByRole('button', { name: 'Excluir laboratório', exact: true }).click(); await expect(dialog).toHaveCount(0);
    assert.equal(db.prepare('SELECT id FROM collections WHERE id=?').get(created.id), undefined); assert.ok(db.prepare('SELECT id FROM materials WHERE id=?').get(materialId));
    await expect(cards(ap).filter({ hasText: created.name })).toHaveCount(0);
    const audited = db.prepare('SELECT action FROM activity_log WHERE entity_id=?').all(created.id).map(row => row.action);
    for (const action of ['create_collection', 'update_collection', 'preserve_collection_image', 'add_collection_item', 'remove_collection_item', 'delete_collection']) assert.ok(audited.includes(action), 'Audit preserved: ' + action);
    check('Adicionar material, cancelar/remover vínculo e cancelar/excluir agrupamento; arquivo/material e vínculo em outra coleção preservados; Escape restaura foco');

    let writes = 0, unblock; const writeGate = new Promise(resolve => { unblock = resolve; });
    await adminCtx.route(baseUrl + '/api/collections', async route => { if (route.request().method() !== 'POST') return route.continue(); writes++; await writeGate; await route.continue(); });
    await ap.getByRole('button', { name: 'Novo laboratório', exact: true }).click(); await dialog.getByLabel('Nome do laboratório', { exact: true }).fill('Escrita única');
    await dialog.getByRole('button', { name: 'Criar laboratório', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Salvando…', exact: true })).toBeDisabled();
    await ap.keyboard.press('Escape'); await expect(dialog).toBeVisible(); await capture(ap, 'admin-saving'); unblock(); await expect(dialog).toHaveCount(0); assert.equal(writes, 1);
    await adminCtx.unroute(baseUrl + '/api/collections'); writes = 0;
    await adminCtx.route(baseUrl + '/api/collections', async route => { if (route.request().method() !== 'POST') return route.continue(); writes++; const result = await route.fetch(); assert.equal(result.status(), 201); await route.fulfill({ status: 503, json: {} }); });
    await ap.getByRole('button', { name: 'Novo laboratório', exact: true }).click(); await dialog.getByLabel('Nome do laboratório', { exact: true }).fill('Resposta perdida');
    await dialog.getByRole('button', { name: 'Criar laboratório', exact: true }).click(); await expect(dialog.getByRole('alert')).toContainText('Não foi possível confirmar');
    await expect(dialog.getByLabel('Nome do laboratório', { exact: true })).toHaveValue('Resposta perdida'); await capture(ap, 'admin-uncertain'); await ap.waitForTimeout(700); assert.equal(writes, 1);
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(cards(ap).filter({ hasText: 'Resposta perdida' })).toHaveCount(1);
    await adminCtx.unroute(baseUrl + '/api/collections');
    await adminCtx.route(baseUrl + '/api/collections', route => route.request().method() === 'POST' ? route.fulfill({ status: 403, json: { error: 'Sem permissão para salvar este laboratório.' } }) : route.continue());
    await ap.getByRole('button', { name: 'Novo laboratório', exact: true }).click(); await dialog.getByLabel('Nome do laboratório', { exact: true }).fill('Rascunho preservado');
    await dialog.getByRole('button', { name: 'Criar laboratório', exact: true }).click(); await expect(dialog.getByRole('alert')).toHaveText('Sem permissão para salvar este laboratório.');
    await expect(dialog.getByLabel('Nome do laboratório', { exact: true })).toHaveValue('Rascunho preservado'); await capture(ap, 'admin-save-denied');
    await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click(); await adminCtx.unroute(baseUrl + '/api/collections');
    check('Gravação única, fechamento bloqueado enquanto salva; resposta perdida após gravação real mantém rascunho e reconcilia lista por GET, sem repetir POST');

    for (const theme of ['dark', 'light']) {
      const c = await context(admin, 320, 600, theme), p = await c.newPage(); await go(p); await p.getByRole('button', { name: 'Novo laboratório', exact: true }).click();
      const d = p.getByRole('dialog'); await capture(p, 'modal-top-' + theme);
      await d.getByRole('button', { name: 'Criar laboratório', exact: true }).focus(); await p.keyboard.press('Tab'); await expect(d.getByRole('button', { name: 'Fechar', exact: true })).toBeFocused();
      await p.keyboard.press('Shift+Tab'); await expect(d.getByRole('button', { name: 'Criar laboratório', exact: true })).toBeFocused(); await capture(p, 'modal-bottom-' + theme);
      await d.getByLabel('Capa (opcional)', { exact: true }).setInputFiles(svg('navy')); await expect(d.getByAltText('Prévia da capa')).toBeVisible();
      await d.getByRole('button', { name: 'Cancelar', exact: true }).click(); await expect(d).toHaveCount(0);
      const urls = await p.evaluate(() => window.qaObjectUrls); assert.deepEqual(urls.created, urls.revoked); await c.close();
    }
    // Short exploration through normal controls, including long content and unusual filter order.
    const longName = 'Investigações matemáticas e estratégias para aprender em diferentes anos da escola pública';
    db.prepare('UPDATE collections SET name=?,description=? WHERE id=?').run(longName, 'Descrição longa de teste. '.repeat(40), emptyId);
    const started = Date.now(); await go(ap); await capture(ap, 'long-list'); await cards(ap).filter({ hasText: longName }).getByRole('link').click(); await capture(ap, 'long-detail');
    await ap.getByText('Sobre este laboratório', { exact: true }).click(); await ap.getByText('Sobre este laboratório', { exact: true }).click();
    await view(ap).getByRole('link', { name: 'Voltar para laboratórios', exact: true }).click(); await cards(ap).filter({ hasText: 'Números e estratégias' }).getByRole('link').click();
    while (Date.now() - started < 30000) {
      await ap.getByLabel('Tipo de material', { exact: true }).selectOption('Sem tipo definido'); await expect(rows(ap)).toHaveCount(1);
      await ap.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await expect(rows(ap)).toHaveCount(2);
      await ap.getByLabel('Ano escolar', { exact: true }).selectOption('7º Ano - EF'); await expect(rows(ap)).toHaveCount(1);
      await ap.getByRole('button', { name: 'Limpar filtros', exact: true }).click(); await ap.waitForTimeout(600);
    }
    check('Modal claro/escuro a 320px, foco circular e cancelamento; exploração por 30s com texto longo e alternância rápida de filtros');
    for (let n = 1; n <= 12; n++) {
      const id = Number(db.prepare("INSERT INTO materials(title,description,file_path,file_format,created_by) VALUES (?,?,'layout-fixture.pdf','PDF',?)").run(`Proposta ${n}: estratégias para resolver problemas e conversar sobre os caminhos escolhidos`, 'Descrição sintética de uma atividade com contexto e orientações para o professor.', admin.id).lastInsertRowid);
      db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collectionId, id);
    }
    await go(ap, `/colecoes/${collectionId}`); await expect(rows(ap)).toHaveCount(14); await capture(ap, 'dense-admin');
    await ap.getByRole('button', { name: /Remover Proposta 2:/ }).scrollIntoViewIfNeeded(); await capture(ap, 'dense-admin-scrolled');
    for (const [width, height, theme] of [[390, 664, 'dark'], [1024, 600, 'light']]) {
      const c = await context(teacher, width, height, theme), p = await c.newPage(); await go(p, `/colecoes/${collectionId}`); await expect(rows(p)).toHaveCount(14); await capture(p, `dense-${width}-${theme}`); await c.close();
    }
    check('Coleção com 14 materiais: grade mais densa, textos longos, rolagem e ações administrativas sem depender de hover');
    await adminCtx.close(); assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'failed'; report.error = error.stack; record();
    for (const ctx of contexts) for (const p of ctx.pages()) { await p.screenshot({ path: path.join(output, 'failure.png'), scale: 'css' }).catch(() => {}); fs.writeFileSync(path.join(output, 'failure.txt'), await p.locator('body').innerText().catch(() => '')); }
    throw error;
  } finally { await Promise.all(contexts.map(ctx => ctx.close().catch(() => {}))); await browser.close(); }
}
module.exports = { runCollectionsBrowser };
