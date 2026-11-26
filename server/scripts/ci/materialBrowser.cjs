const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

function pdfFixture() {
  const objects = ['', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>']; const pageIds = [];
  for (let n = 1; n <= 3; n++) {
    const id = objects.length + 1; pageIds.push(id);
    const lines = [`Matematica em sala - pagina ${n}`, 'Nome: _______________________  Turma: _______', '',
      ...Array.from({ length: 18 }, (_, i) => `${i + 1}. Compare estrategias e registre como resolveu a atividade ${n}.`)];
    const stream = 'BT /F1 16 Tf 35 795 Td 30 TL ' + lines.map((line, i) => `${i ? 'T* ' : ''}(${line}) Tj`).join('\n') + '\nET';
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${id + 1} 0 R >>`, `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[0] = '<< /Type /Catalog /Pages 2 0 R >>'; objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => id + ' 0 R').join(' ')}] /Count 3 >>`;
  let pdf = '%PDF-1.4\n'; const offsets = [0]; objects.forEach((object, i) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}

async function runMaterialBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, materialId, collectionId, db, output }) {
  assert.equal(process.env.MATERIAL_BROWSER, '1'); assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const config = require('../../src/config'); assert.equal(path.dirname(config.uploadDir), path.dirname(db.name));
  fs.writeFileSync(path.join(config.uploadDir, 'material-three-pages.pdf'), pdfFixture());
  db.prepare('UPDATE materials SET file_path=?,description=? WHERE id=?').run('material-three-pages.pdf', 'Descrição completa para o professor.\n'.repeat(60), materialId);
  const cadernoType = Number(db.prepare("INSERT INTO material_types(name,icon) VALUES ('Caderno QA','file')").run().lastInsertRowid);
  const cadernoId = Number(db.prepare("INSERT INTO materials(title,material_type_id,file_path,file_format,created_by) VALUES ('Caderno de números racionais',?,'layout-fixture.pdf','PDF',?)").run(cadernoType, admin.id).lastInsertRowid);
  const topic = Number(db.prepare("INSERT INTO topics(name) VALUES ('Estratégias de resolução')").run().lastInsertRowid);
  db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(materialId, topic);
  const foreignCommentId = Number(db.prepare("INSERT INTO comments(user_id,material_id,text) VALUES (?,?,'Comentário de outro usuário para preservar.')").run(admin.id, materialId).lastInsertRowid);
  const report = { status: 'running', syntheticDataOnly: true, inventory: [], cases: [], internal: [], pageErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  const check = description => { report.inventory.push({ description }); record(); console.log('Material:', description); };
  const browser = await chromium.launch({ headless: true }); const contexts = [];
  const view = page => page.locator('[data-material-view]');
  const pdf = page => page.locator('[data-pdf-viewer]');
  const favorite = page => page.getByRole('button', { name: /^(Salvar nos favoritos|Remover dos favoritos|Consultando favoritos|Favoritos indisponíveis)$/ });
  async function context(user = teacher, width = 390, height = 664, theme = 'dark') {
    const ctx = await browser.newContext({ viewport: { width, height }, colorScheme: theme, ...(width < 600 ? { isMobile: true, hasTouch: true } : {}) }); contexts.push(ctx);
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => { if (location.origin !== origin) return;
      localStorage.setItem('theme', theme); sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: tokenFor(user), theme });
    ctx.on('page', page => page.on('pageerror', error => report.pageErrors.push(error.message))); return ctx;
  }
  async function ready(page, id = materialId, idle = true) {
    await page.goto(`${baseUrl}/material/${id}`, { waitUntil: 'domcontentloaded' }); await page.waitForTimeout(550);
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    if (idle) await page.waitForLoadState('networkidle'); await page.waitForTimeout(300);
  }
  async function paperReady(page, count = 1) {
    await expect(pdf(page).locator('canvas')).toHaveAttribute('aria-label', new RegExp(`^Página ${count} de `));
    await expect(pdf(page).getByRole('region')).toHaveAttribute('aria-busy', 'false');
    await expect.poll(() => pdf(page).locator('canvas').evaluate(canvas => canvas.width)).toBeGreaterThan(10);
  }
  async function capture(page, id, first = false) {
    await page.waitForTimeout(350);
    const metrics = await page.evaluate(() => { const box = e => { const r = e?.getBoundingClientRect(); return r ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width, height: r.height } : null; };
      return { width: innerWidth, height: innerHeight, scrollY, scrollWidth: document.documentElement.scrollWidth,
        canvas: box(document.querySelector('[data-material-reader] canvas')),
        controls: [...document.querySelectorAll('[data-material-view] a,[data-material-view] button,[data-material-view] textarea,[data-material-view] summary')]
          .filter(e => e.getClientRects().length && !e.closest('[aria-label="Gerenciar compartilhamentos"]')).map(e => ({ text: e.getAttribute('aria-label') || e.textContent.trim(), ...box(e) })) }; });
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' }); fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    report.cases.push({ id, ...metrics }); record(); assert.ok(metrics.scrollWidth <= metrics.width, id + ': no horizontal overflow');
    if (first) { assert.equal(metrics.scrollY, 0); assert.ok(metrics.canvas?.y <= metrics.height - 100 && metrics.canvas?.y >= 108, id + ': beginning of document visible'); }
    for (const item of metrics.controls) { assert.ok(item.height >= 44 && item.width >= 24, id + ': target ' + item.text); assert.ok(item.x >= 0 && item.right <= metrics.width + 1, id + ': bounds ' + item.text); }
  }
  async function feedback(page) { await view(page).locator('summary').filter({ hasText: 'Avaliar e comentar' }).click(); await expect(page.getByLabel('Seu comentário', { exact: true })).toBeVisible(); }
  try {
    for (const [width, height] of [[1024, 600], [390, 664], [320, 600]]) for (const theme of ['dark', 'light']) {
      const ctx = await context(teacher, width, height, theme); const page = await ctx.newPage(); const social = [];
      ctx.on('request', request => { if (/\/api\/(comments|ratings)\//.test(request.url())) social.push(request.url()); });
      await ready(page); await paperReady(page); await expect(favorite(page)).toBeEnabled();
      await capture(page, `material-${width}-${theme}`, true); assert.deepEqual(social, []);
      await expect(view(page).getByRole('link', { name: 'Baixar arquivo', exact: true })).toHaveCount(0);
      await expect(view(page).getByRole('button', { name: 'Compartilhar', exact: true })).toHaveCount(0);
      const prevented = await pdf(page).evaluate(e => !e.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
      assert.equal(prevented, true);
      const readingTop = await pdf(page).locator('canvas').evaluate(e => e.getBoundingClientRect().top);
      await favorite(page).click(); const notice = page.locator('[data-toasts] [role="alert"]').last();
      await expect(notice).toContainText('Favoritos atualizados.'); await expect(favorite(page)).toBeEnabled(); await page.waitForTimeout(350);
      const notification = await notice.evaluate(e => { const rect = e.getBoundingClientRect(); const color = getComputedStyle(e.querySelector('p')).color; const background = getComputedStyle(e).backgroundColor;
        const luma = value => value.match(/[\d.]+/g).slice(0, 3).map(Number).map(c => c / 255).map(c => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4).reduce((a, c, i) => a + c * [.2126, .7152, .0722][i], 0);
        const light = luma(color), dark = luma(background); return { x: rect.x, right: rect.right, width: innerWidth, background, contrast: (Math.max(light, dark) + .05) / (Math.min(light, dark) + .05) }; });
      assert.ok(notification.x >= 0 && notification.right <= notification.width); assert.match(notification.background, /^rgb\(/); assert.ok(notification.contrast >= 4.5);
      assert.equal(await pdf(page).locator('canvas').evaluate(e => e.getBoundingClientRect().top), readingTop, 'Favorite state does not move the reader');
      await capture(page, `notice-${width}-${theme}`); await notice.getByRole('button', { name: 'Fechar', exact: true }).click(); await expect(notice).toHaveCount(0); await ctx.close();
    }
    check('Leitura prioritária em 3 resoluções × 2 temas; descrição longa recolhida; permissões docentes mantidas');

    const ctx = await context(teacher, 1024, 600); const page = await ctx.newPage(); await ready(page); await paperReady(page);
    const region = pdf(page).getByRole('region'); const before = await pdf(page).locator('canvas').evaluate(e => e.toDataURL());
    await region.focus(); await region.press('End'); await expect.poll(() => region.evaluate(e => e.scrollTop)).toBeGreaterThan(0);
    await pdf(page).getByRole('button', { name: 'Próxima página', exact: true }).last().click(); await paperReady(page, 2);
    assert.equal(await region.evaluate(e => e.scrollTop), 0);
    await expect.poll(() => pdf(page).locator('canvas').evaluate((e, old) => e.toDataURL() !== old, before), { message: 'Page 2 must actually be painted' }).toBe(true);
    const pageTwoTop = await pdf(page).locator('canvas').evaluate(e => e.getBoundingClientRect().top);
    assert.ok(pageTwoTop >= 108 && pageTwoTop < 300, 'Bottom paginator brings the start of the new page into view below the sticky header');
    await capture(page, 'pdf-page-two'); await pdf(page).getByRole('button', { name: 'Próxima página', exact: true }).first().click(); await paperReady(page, 3);
    await expect(pdf(page).getByRole('button', { name: 'Próxima página', exact: true }).first()).toBeDisabled();
    await pdf(page).getByRole('button', { name: 'Página anterior', exact: true }).first().click(); await paperReady(page, 2);
    await page.setViewportSize({ width: 390, height: 664 }); await paperReady(page, 2); await capture(page, 'pdf-resized');
    await view(page).getByRole('button', { name: 'Detalhes', exact: true }).click(); await expect(view(page).getByText(/Descrição completa para o professor/)).toBeVisible();
    await expect(view(page).locator('summary').filter({ hasText: 'Sobre este material' })).toBeFocused(); await capture(page, 'details-open');
    await view(page).getByRole('navigation', { name: 'Buscar materiais do mesmo assunto' }).scrollIntoViewIfNeeded(); await capture(page, 'material-metadata');
    await view(page).getByRole('link', { name: 'Estratégias de resolução', exact: true }).click(); await expect(page).toHaveURL(new RegExp(`topic_id=${topic}`));
    await page.locator('[data-library-materials] a').first().click(); await paperReady(page); await view(page).getByRole('link', { name: 'Voltar para Biblioteca' }).click(); await expect(page).toHaveURL(new RegExp(`topic_id=${topic}`));
    await ready(page, cadernoId); await paperReady(page); await expect(view(page).getByRole('heading', { level: 1 })).toHaveText('Caderno de números racionais');
    await page.goto(baseUrl + '/'); await page.waitForTimeout(600); const homeNotice = page.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await homeNotice.isVisible()) await homeNotice.click();
    await page.locator('[data-teacher-home] a[href^="/material/"]').first().click(); await expect(view(page).getByRole('button', { name: 'Voltar à tela anterior' })).toBeVisible();
    await view(page).getByRole('button', { name: 'Voltar à tela anterior' }).click(); await expect(page).toHaveURL(baseUrl + '/'); await ctx.close();
    check('PDF de 3 páginas: pintura muda, próxima/anterior, início da página, resize, detalhes/assunto/retorno e PDF cadastrado como caderno');

    const writeCtx = await context(); const writer = await writeCtx.newPage(); await ready(writer); await paperReady(writer);
    await favorite(writer).click(); await expect(favorite(writer)).toHaveAttribute('aria-pressed', 'false');
    let releaseFavorite; const favoriteGate = new Promise(resolve => { releaseFavorite = resolve; }); let favoriteWrites = 0;
    await writeCtx.route(/\/api\/favorites\/toggle$/, async route => { favoriteWrites++; await favoriteGate; await route.continue(); });
    await favorite(writer).dblclick(); assert.equal(favoriteWrites, 1); releaseFavorite(); await expect(favorite(writer)).toHaveAttribute('aria-pressed', 'true');
    await writeCtx.unroute(/\/api\/favorites\/toggle$/); let uncertainWrites = 0;
    await writeCtx.route(/\/api\/favorites\/toggle$/, async route => { uncertainWrites++; await route.fetch(); await route.fulfill({ status: 503, json: { error: 'Confirmação perdida sintética' } }); });
    await favorite(writer).click(); await expect(favorite(writer)).toHaveAttribute('aria-pressed', 'false'); assert.equal(uncertainWrites, 1);
    await expect(writer.getByText(/Não foi possível confirmar a alteração/)).toBeVisible(); await writeCtx.unroute(/\/api\/favorites\/toggle$/);
    await feedback(writer); await writer.getByRole('button', { name: 'Avaliar com 4 estrelas', exact: true }).click(); await expect(writer.getByRole('button', { name: 'Avaliar com 4 estrelas', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await writer.getByLabel('Seu comentário', { exact: true }).fill('Usei o material para conversar sobre as estratégias.');
    await writer.getByRole('button', { name: 'Publicar comentário', exact: true }).click(); await expect(writer.getByText('Usei o material para conversar sobre as estratégias.', { exact: true })).toBeVisible();
    await writer.getByRole('button', { name: 'Editar comentário', exact: true }).click(); await writer.getByLabel('Editar seu comentário', { exact: true }).fill('Rascunho que será cancelado.');
    await writer.getByRole('button', { name: 'Cancelar edição', exact: true }).click(); await writer.getByRole('button', { name: 'Editar comentário', exact: true }).click();
    await writer.getByLabel('Editar seu comentário', { exact: true }).fill('Revisado: conversamos sobre duas estratégias.'); await writer.getByRole('button', { name: 'Salvar comentário', exact: true }).click();
    await expect(writer.getByText('Revisado: conversamos sobre duas estratégias.', { exact: true })).toBeVisible();
    await capture(writer, 'feedback-edited'); await expect(writer.getByRole('button', { name: 'Excluir comentário', exact: true })).toHaveCount(1);
    await writer.getByRole('button', { name: 'Excluir comentário', exact: true }).click(); await writer.getByRole('button', { name: 'Confirmar exclusão', exact: true }).scrollIntoViewIfNeeded(); await capture(writer, 'comment-delete-confirmation');
    await writer.getByRole('button', { name: 'Manter comentário', exact: true }).click(); await writer.getByRole('button', { name: 'Excluir comentário', exact: true }).click();
    await writer.getByRole('button', { name: 'Confirmar exclusão', exact: true }).click(); await expect(writer.getByText('Revisado: conversamos sobre duas estratégias.', { exact: true })).toHaveCount(0);
    assert.ok(db.prepare('SELECT id FROM comments WHERE id=?').get(foreignCommentId));
    await writeCtx.route(/\/api\/comments$/, route => route.fulfill({ status: 503, json: {} }));
    await writer.getByLabel('Seu comentário', { exact: true }).fill('Meu rascunho deve continuar aqui.'); await writer.getByRole('button', { name: 'Publicar comentário', exact: true }).click();
    await expect(writer.getByLabel('Seu comentário', { exact: true })).toHaveValue('Meu rascunho deve continuar aqui.'); await writeCtx.close();
    check('Favoritos, clique duplo, confirmação perdida sem replay; avaliação e ciclo publicar/editar/cancelar/excluir com rascunho preservado');

    for (const [routePath, label, opening] of [[`favorites/check/${materialId}`, 'seus favoritos', false], [`ratings/material/${materialId}`, 'as avaliações', true], [`comments/material/${materialId}`, 'os comentários', true]]) {
      const errorCtx = await context(); let fail = true; await errorCtx.route(baseUrl + '/api/' + routePath, route => fail ? route.fulfill({ status: 503, json: {} }) : route.continue());
      const errorPage = await errorCtx.newPage(); await ready(errorPage); await paperReady(errorPage);
      if (opening) await view(errorPage).locator('summary').filter({ hasText: 'Avaliar e comentar' }).click();
      const retry = errorPage.getByRole('button', { name: `Tentar novamente: ${label}`, exact: true }); await expect(retry).toBeVisible(); await retry.scrollIntoViewIfNeeded(); await capture(errorPage, 'error-' + routePath.split('/')[0]);
      if (label === 'os comentários') await expect(errorPage.getByText('Nenhum comentário publicado.', { exact: true })).toHaveCount(0);
      fail = false; await retry.click(); await expect(retry).toHaveCount(0); await errorCtx.close();
    }
    for (const status of [404, 503, 200]) {
      const errorCtx = await context(); let fail = true; await errorCtx.route(baseUrl + `/api/materials/${materialId}`, route => fail ? route.fulfill({ status, json: {} }) : route.continue());
      const errorPage = await errorCtx.newPage(); await ready(errorPage); await expect(view(errorPage).getByRole('heading', { level: 1 })).toHaveText('Não foi possível abrir o material');
      await expect(errorPage.locator('canvas')).toHaveCount(0); await capture(errorPage, `material-error-${status}`); fail = false;
      await errorPage.getByRole('button', { name: 'Tentar novamente: este material', exact: true }).click(); await paperReady(errorPage); await errorCtx.close();
    }
    const pdfCtx = await context(); let failPdf = true; await pdfCtx.route(/\/uploads\/material-three-pages\.pdf$/, route => failPdf ? route.fulfill({ status: 503, body: 'Indisponível' }) : route.continue());
    const pdfPage = await pdfCtx.newPage(); await ready(pdfPage); await expect(pdf(pdfPage).getByText('Não foi possível carregar o PDF.', { exact: true })).toBeVisible(); await capture(pdfPage, 'pdf-error');
    failPdf = false; await pdf(pdfPage).getByRole('button', { name: 'Tentar novamente', exact: true }).click(); await paperReady(pdfPage); await pdfCtx.close();
    check('Falhas de material, favorito, avaliação, comentários e PDF têm repetição explícita, sem vazio falso');

    const lateCtx = await context(); let release; let started; const gate = new Promise(resolve => { release = resolve; }); const pending = new Promise(resolve => { started = resolve; });
    await lateCtx.route(baseUrl + `/api/materials/${materialId}`, async route => { const response = await route.fetch(); started(); await gate; await route.fulfill({ response }).catch(() => {}); });
    const late = await lateCtx.newPage(); await ready(late, materialId, false); await pending; await view(late).getByRole('link', { name: 'Voltar para Biblioteca' }).click();
    await late.locator(`[data-library-materials] a[href="/material/${cadernoId}"]`).click(); await paperReady(late); release(); await late.waitForTimeout(350); await expect(view(late).getByRole('heading', { level: 1 })).toHaveText('Caderno de números racionais'); await lateCtx.close();
    const leavingCtx = await context(); let releasePdf; const pdfGate = new Promise(resolve => { releasePdf = resolve; });
    await leavingCtx.route(/\/uploads\/material-three-pages\.pdf$/, async route => { await pdfGate; await route.continue().catch(() => {}); });
    const leaving = await leavingCtx.newPage(); await ready(leaving, materialId, false); await view(leaving).getByRole('link', { name: 'Voltar para Biblioteca' }).click(); releasePdf(); await expect(leaving.locator('[data-library-materials]')).toBeVisible(); await expect(leaving.locator('canvas')).toHaveCount(0); await leavingCtx.close();
    check('Mudar de material com resposta atrasada e sair durante carregamento de PDF não reapresentam conteúdo anterior');

    const adminCtx = await context(admin, 1024, 600, 'light'); const adminPage = await adminCtx.newPage(); await ready(adminPage); await paperReady(adminPage);
    const management = adminPage.getByRole('region', { name: 'Gerenciar material', exact: true }); await management.scrollIntoViewIfNeeded();
    await expect(management.getByRole('link', { name: 'Baixar arquivo', exact: true })).toHaveAttribute('href', '/uploads/material-three-pages.pdf');
    const downloadPromise = adminPage.waitForEvent('download'); await management.getByRole('link', { name: 'Baixar arquivo', exact: true }).click(); const download = await downloadPromise; assert.equal(await download.failure(), null);
    await management.getByRole('button', { name: 'Compartilhar', exact: true }).click(); const shares = adminPage.getByRole('region', { name: 'Gerenciar compartilhamentos' });
    await expect(shares).toBeVisible(); await shares.getByLabel('Validade do novo link').selectOption('24');
    const countBefore = db.prepare('SELECT COUNT(*) FROM share_links WHERE material_id=?').pluck().get(materialId);
    await shares.getByRole('button', { name: 'Criar link', exact: true }).click(); await expect(shares.getByText('Link criado. Copie-o na lista abaixo.', { exact: true })).toBeVisible();
    assert.equal(db.prepare('SELECT COUNT(*) FROM share_links WHERE material_id=?').pluck().get(materialId), countBefore + 1);
    await shares.getByRole('button', { name: 'Revogar link', exact: true }).first().click(); await shares.getByRole('button', { name: 'Confirmar revogação', exact: true }).click();
    await expect(shares.getByText('Link revogado. Novos acessos por ele estão bloqueados.', { exact: true })).toBeVisible();
    await capture(adminPage, 'admin-sharing'); await shares.getByRole('button', { name: 'Fechar compartilhamentos', exact: true }).click();
    const targetId = Number(db.prepare("INSERT INTO collections(user_id,name) VALUES (?,'Laboratório adicional de QA')").run(admin.id).lastInsertRowid);
    await management.getByRole('button', { name: 'Adicionar ao laboratório', exact: true }).click(); await adminPage.getByRole('region', { name: 'Escolher laboratório' }).getByRole('button', { name: 'Laboratório adicional de QA', exact: true }).click();
    await expect(adminPage.getByRole('region', { name: 'Escolher laboratório' })).toHaveCount(0); assert.ok(db.prepare('SELECT 1 FROM collection_items WHERE collection_id=? AND material_id=?').get(targetId, materialId));
    await management.getByRole('button', { name: 'Adicionar ao laboratório', exact: true }).click(); await adminPage.getByRole('button', { name: 'Fechar lista de laboratórios', exact: true }).click(); await capture(adminPage, 'admin-actions'); await adminCtx.close();
    check('Administração mantém download, criação/revogação de link e inclusão em laboratório; escritas somente sintéticas');

    const imageType = Number(db.prepare("INSERT INTO material_types(name,icon) VALUES ('Imagem QA','image')").run().lastInsertRowid);
    const docType = Number(db.prepare("INSERT INTO material_types(name,icon) VALUES ('Documento QA','document')").run().lastInsertRowid);
    fs.copyFileSync(path.join(root, 'client/public/logos/logo-labmathic-mark.png'), path.join(config.uploadDir, 'material-image.png'));
    const imageId = Number(db.prepare("INSERT INTO materials(title,material_type_id,file_path,file_format,created_by) VALUES ('Imagem de teste',?,'material-image.png','PNG',?)").run(imageType, admin.id).lastInsertRowid);
    const docId = Number(db.prepare("INSERT INTO materials(title,material_type_id,file_path,file_format,created_by) VALUES ('Documento de teste',?,'arquivo-inexistente.docx','DOCX',?)").run(docType, admin.id).lastInsertRowid);
    const variantsCtx = await context(); const variants = await variantsCtx.newPage(); await ready(variants, imageId); const image = view(variants).getByRole('img', { name: 'Imagem de teste' }); await expect(image).toBeVisible();
    await expect.poll(() => image.evaluate(e => e.naturalWidth)).toBeGreaterThan(0); await capture(variants, 'image-material');
    await ready(variants, docId); await expect(variants.getByText('Este formato não tem leitura nesta tela', { exact: true })).toBeVisible(); await expect(view(variants).getByRole('link', { name: 'Baixar arquivo' })).toHaveCount(0); await capture(variants, 'document-fallback');
    await feedback(variants); await expect(variants.getByText('Ainda não há avaliações.', { exact: true })).toBeVisible(); await expect(variants.getByText('Nenhum comentário publicado.', { exact: true })).toBeVisible(); await capture(variants, 'feedback-empty');
    const externalId = Number(db.prepare("INSERT INTO materials(title,material_type_id,external_url,created_by) VALUES ('Material em site externo',?,'https://material-qa.invalid/origem',?)").run(docType, admin.id).lastInsertRowid);
    // The destination is fulfilled locally, never requested on the internet.
    await variantsCtx.route('https://material-qa.invalid/origem', route => route.fulfill({ contentType: 'text/html', body: '<title>Origem sintética</title><p>Destino de teste local</p>' }));
    await ready(variants, externalId); await expect(variants.getByText('Material disponível em outro site', { exact: true })).toBeVisible(); await capture(variants, 'external-material');
    const popupPromise = variants.waitForEvent('popup'); await view(variants).getByRole('link', { name: 'Abrir no site de origem' }).click(); const popup = await popupPromise; await expect(popup).toHaveURL('https://material-qa.invalid/origem'); await popup.close();
    const videoType = Number(db.prepare("INSERT INTO material_types(name,icon) VALUES ('Vídeo QA','video')").run().lastInsertRowid);
    const videoId = Number(db.prepare("INSERT INTO materials(title,material_type_id,external_url,created_by) VALUES ('Vídeo externo de teste',?,'https://www.youtube.com/watch?v=abcdefghijk',?)").run(videoType, admin.id).lastInsertRowid);
    await ready(variants, videoId); await expect(view(variants).locator('iframe')).toHaveAttribute('src', 'https://www.youtube-nocookie.com/embed/abcdefghijk');
    await expect(view(variants).locator('iframe')).toHaveAttribute('title', 'Vídeo externo de teste'); await variantsCtx.close();
    check('Imagem renderizada; vazios verdadeiros; documento sem prévia; link externo com popup local e contrato de embed (sem testar reprodução externa)');

    const password = 'Material-fixture-only-9!'; db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 4), previewUser.id);
    const switchCtx = await context(); let releaseOld; let startedOld; const oldGate = new Promise(resolve => { releaseOld = resolve; }); const oldStarted = new Promise(resolve => { startedOld = resolve; }); let hold = true;
    await switchCtx.route(baseUrl + `/api/materials/${materialId}`, async route => { if (!hold) return route.continue(); hold = false; const response = await route.fetch(); const json = await response.json(); json.title = 'Resposta antiga que não deve aparecer'; startedOld(); await oldGate; await route.fulfill({ response, json }).catch(() => {}); });
    const switched = await switchCtx.newPage(); await ready(switched, materialId, false); await oldStarted; await switched.getByRole('button', { name: 'Menu do usuário', exact: true }).click(); await switched.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await switched.getByLabel('E-mail', { exact: true }).fill(previewUser.email); await switched.getByLabel('Senha', { exact: true }).fill(password); await switched.getByRole('button', { name: 'Entrar no sistema', exact: true }).click(); await expect(switched).toHaveURL(baseUrl + '/');
    await switched.waitForTimeout(600); const notice = switched.getByRole('button', { name: 'Entendi, continuar', exact: true }); if (await notice.isVisible()) await notice.click();
    await switched.getByRole('link', { name: 'Buscar material', exact: true }).click(); await switched.locator(`[data-library-materials] a[href="/material/${materialId}"]`).click(); releaseOld(); await paperReady(switched); await expect(view(switched)).not.toContainText('Resposta antiga que não deve aparecer'); await switchCtx.close();
    check('Troca real de conta com consulta pendente descarta resposta anterior');

    const exploreCtx = await context(); const explore = await exploreCtx.newPage(); await ready(explore); await paperReady(explore);
    const start = Date.now(); while (Date.now() - start < 30000) { await explore.keyboard.press('Tab'); await explore.mouse.wheel(0, 140); await explore.waitForTimeout(650); }
    await capture(explore, 'exploration'); await exploreCtx.close(); check('Exploração de teclado/rolagem por 30 segundos sem erro JavaScript');
    assert.deepEqual(report.pageErrors, []); report.status = 'captured'; record(); return report;
  } catch (error) { report.status = 'failed'; report.failure = error.stack; record(); throw error; }
  finally { for (const ctx of contexts) await ctx.close().catch(() => {}); await browser.close(); }
}
module.exports = { runMaterialBrowser };
