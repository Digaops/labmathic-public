// Isolated component QA: loopback only, synthetic PDFs, no API/database/secrets.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { pathToFileURL } = require('node:url');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const clientRequire = createRequire(path.join(root, 'client/package.json'));
const { chromium, expect } = clientRequire('@playwright/test');
const output = path.join(root, 'tmp/performance-polish-qa');
fs.mkdirSync(output, { recursive: true });
const errors = [];
let browser, server, retries = 0;

function syntheticPdf() {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 600 800] /Resources << /Font << /F1 5 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    ...[1, 2].map(n => { const stream = `BT /F1 24 Tf 60 700 Td (Documento sintetico - pagina ${n}) Tj ET`; return `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`; }),
  ];
  let pdf = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, i) => { offsets.push(pdf.length); pdf += `${i + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = pdf.length;
  pdf += `xref\n0 ${offsets.length}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  pdf += `trailer\n<< /Size ${offsets.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(pdf);
}
async function capture(page, name) {
  await page.waitForTimeout(350);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
  await page.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
}
async function checkFocus(page, dialog) {
  for (const key of ['Tab', 'Shift+Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab', 'Tab']) {
    await page.keyboard.press(key);
    assert.equal(await dialog.evaluate(element => element.contains(document.activeElement)), true, key);
  }
}
(async () => {
  process.chdir(path.join(root, 'client'));
  const { createServer } = await import(pathToFileURL(clientRequire.resolve('vite')).href);
  const pdf = syntheticPdf();
  server = await createServer({ root: path.join(root, 'client'),
    configFile: path.join(root, 'client/vite.config.js'), server: { host: '127.0.0.1', port: 0, open: false },
    plugins: [{ name: 'synthetic-pdf-fixtures', configureServer(vite) {
      vite.middlewares.use((req, res, next) => {
        if (!req.url.startsWith('/__qa/')) return next();
        if (req.url === '/__qa/retry.pdf' && ++retries === 1) { res.writeHead(503); return res.end(); }
        const send = () => { if (!res.destroyed) { res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': pdf.length, 'Cache-Control': 'no-store' }); res.end(pdf); } };
        if (req.url === '/__qa/slow.pdf') { const timer = setTimeout(send, 1200); res.on('close', () => clearTimeout(timer)); }
        else send();
      });
    } }],
  });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const url = base + '/tests/fixtures/performance-polish.html';
  assert.equal((await fetch(url)).status, 200);
  browser = await chromium.launch({ headless: true });
  for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }]) {
    const context = await browser.newContext({ viewport, colorScheme: 'dark' });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(url);
    await page.evaluate(() => { document.documentElement.classList.add('dark'); document.body.style.overflow = 'auto'; document.body.style.paddingRight = '3px'; });
    const opener = page.getByRole('button', { name: 'Abrir formulário', exact: true });
    await opener.click();
    const dialog = page.getByRole('dialog', { name: 'Formulário de validação' });
    await expect(dialog).toBeFocused();
    await page.keyboard.press('Shift+Tab');
    await expect(page.getByRole('button', { name: 'Concluir formulário' })).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(dialog.getByRole('button', { name: 'Fechar', exact: true })).toBeFocused();
    const field = page.getByLabel('Rascunho');
    await field.fill('Texto preservado durante renderizações');
    await expect(field).toBeFocused();
    const combo = page.getByRole('combobox');
    await combo.click();
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();
    await expect(page.getByRole('listbox')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Abrir confirmação' }).click();
    const child = page.getByRole('dialog', { name: 'Confirmação', exact: true });
    await expect(child).toBeFocused();
    assert.equal(await opener.evaluate(element => !!element.closest('[inert]')), true);
    await checkFocus(page, child);
    await page.getByLabel('Aguardar salvamento').check();
    await page.keyboard.press('Escape');
    await expect(child).toBeVisible();
    await page.getByLabel('Aguardar salvamento').uncheck();
    await capture(page, `nested-modal-dark-${viewport.width}`);
    await page.keyboard.press('Escape');
    await expect(child).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Abrir confirmação' })).toBeFocused();
    assert.equal(await page.evaluate(() => document.body.style.overflow), 'hidden');
    await expect(field).toHaveValue('Texto preservado durante renderizações');
    const bounds = await dialog.boundingBox();
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= viewport.height + 1);
    await capture(page, `scrollable-modal-dark-${viewport.width}`);
    const before = await page.evaluate(() => scrollY);
    await page.mouse.move(viewport.width - 4, viewport.height / 2);
    await page.mouse.wheel(0, 700);
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => scrollY), before, 'fundo não rola');
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    assert.deepEqual(await page.evaluate(() => [document.body.style.overflow, document.body.style.paddingRight]), ['auto', '3px']);
    assert.equal(await page.locator('[inert]').count(), 0);
    // Parent removed before child: restore the real original opener, not a detached node.
    await opener.click();
    await page.getByRole('button', { name: 'Abrir confirmação' }).click();
    await page.getByRole('button', { name: 'Fechar janela anterior' }).click();
    await page.keyboard.press('Escape');
    await expect(opener).toBeFocused();
    await page.getByRole('button', { name: 'Abrir sem controles' }).click();
    const empty = page.getByRole('dialog', { name: 'Sem controles' });
    await checkFocus(page, empty);
    await page.keyboard.press('Escape');
    await expect(empty).toHaveCount(0);
    // Real PDF.js worker lifecycle, navigation, resize, retry, close-before-load.
    for (let cycle = 0; cycle < 3; cycle += 1) {
      await page.getByRole('button', { name: 'Abrir PDF', exact: true }).click();
      await expect(page.locator('canvas')).toBeVisible();
      await expect.poll(() => page.workers().length).toBe(1);
      await expect(page.getByRole('button', { name: 'Próxima página' }).first()).toBeEnabled();
      await page.getByRole('button', { name: 'Próxima página' }).first().click();
      await expect(page.getByText('Página 2 de 2', { exact: true }).first()).toBeVisible();
      await expect(page.getByRole('button', { name: 'Página anterior' }).first()).toBeEnabled();
      await page.getByRole('button', { name: 'Página anterior' }).first().click();
      await expect(page.getByText('Página 1 de 2', { exact: true }).first()).toBeVisible();
      if (cycle === 0) await capture(page, `pdf-dark-${viewport.width}`);
      await page.getByRole('button', { name: 'Fechar PDF', exact: true }).click();
      await expect.poll(() => page.workers().length).toBe(0);
    }
    await page.getByRole('button', { name: 'Abrir PDF lento' }).click();
    await expect(page.getByText('Carregando PDF...', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Trocar PDF' }).click();
    await expect(page.locator('canvas')).toBeVisible();
    await expect.poll(() => page.workers().length).toBe(1);
    await page.getByRole('button', { name: 'Fechar PDF', exact: true }).click();
    await expect.poll(() => page.workers().length).toBe(0);
    await page.getByRole('button', { name: 'Abrir PDF lento' }).click();
    await page.getByRole('button', { name: 'Fechar PDF', exact: true }).click();
    await expect.poll(() => page.workers().length).toBe(0);
    retries = 0;
    await page.getByRole('button', { name: 'Abrir PDF com falha' }).click();
    await expect(page.getByText('Não foi possível carregar o PDF.', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
    await expect(page.locator('canvas')).toBeVisible();
    await page.setViewportSize({ width: viewport.width - 30, height: viewport.height });
    await expect(page.getByRole('button', { name: 'Próxima página' }).first()).toBeEnabled();
    await page.getByRole('button', { name: 'Fechar PDF', exact: true }).click();
    await expect.poll(() => page.workers().length).toBe(0);
    await context.close();
  }
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ status: 'passed', viewports: ['1024x600', '390x664'],
    strictMode: true, pdfCycles: 6, workersAfterClose: 0, consoleErrors: errors, screenshots: output }, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await browser?.close();
  await server?.close();
});
