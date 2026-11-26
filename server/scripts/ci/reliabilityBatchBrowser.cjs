const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const tempRoot = fs.realpathSync(path.join(root, 'tmp'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
const draftPrefix = 'labmathic_question_set_draft_v1:';
const createPath = '/api/question-bank/question-sets';
const wait = { timeout: 15000 };

function readFixture() {
  const fixtureDir = path.join(tempRoot, 'platform-journey-audit');
  const connection = path.join(fixtureDir, 'connection.json');
  assert.equal(fs.realpathSync(fixtureDir), fixtureDir, 'A pasta da conexão deve pertencer ao workspace.');
  assert.ok(fs.lstatSync(connection).isFile(), 'Inicie a fixture sintética antes do navegador.');
  const fixture = JSON.parse(fs.readFileSync(connection, 'utf8'));
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'Use somente o listener local da fixture.');
  const uploads = fs.realpathSync(fixture.uploadDir);
  const dataDir = path.dirname(uploads);
  assert.equal(path.dirname(dataDir), tempRoot);
  assert.match(path.basename(dataDir), /^labmathic-recovery-preview-api-[^/\\]+$/);
  assert.equal(path.basename(uploads), 'uploads');
  assert.ok(fs.lstatSync(path.join(dataDir, 'database.sqlite')).isFile());
  assert.ok(fixture.accounts?.teacher?.email === 'ana-recovery@teste.local'
    && fixture.accounts?.previewUser?.email?.endsWith('@audit.invalid')
    && fixture.accounts.teacher.role === 'professor'
    && fixture.accounts.previewUser.role === 'professor'
    && typeof fixture.password === 'string', 'Use as contas docentes da fixture sintética.');
  return fixture;
}

async function login(page, origin, account, password) {
  await page.goto(origin + '/login');
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await expect(page.getByTestId('dashboard-heading')).toBeVisible(wait);
  await page.waitForLoadState('networkidle');
  const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
  if (await notice.isVisible()) await notice.click();
}

async function selectQuestions(page, count) {
  const available = page.locator('[data-bank-question]').filter({
    has: page.getByRole('button', { name: /^Selecionar / }),
  });
  const ids = [];
  for (let index = 0; index < count; index++) {
    await expect(available.first()).toBeVisible(wait);
    const questionId = Number(await available.first().getAttribute('data-bank-question'));
    assert.ok(Number.isSafeInteger(questionId) && questionId > 0);
    await available.first().getByRole('button', { name: /^Selecionar / }).click();
    ids.push(questionId);
  }
  assert.equal(new Set(ids).size, count);
  return ids;
}

function openCreation(page) {
  return page.getByRole('button', { name: 'Conferir e gerar simulado', exact: true }).click();
}

function readDraft(page, userId) {
  return page.evaluate(key => JSON.parse(sessionStorage.getItem(key)), draftPrefix + userId);
}

async function capture(page, output, name) {
  const { width, contentWidth } = await page.evaluate(() => ({
    width: innerWidth, contentWidth: document.documentElement.scrollWidth,
  }));
  assert.equal(width, page.viewportSize().width, 'O viewport deve manter a largura configurada.');
  assert.ok(contentWidth <= width + 1, name + ' tem rolagem horizontal.');
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}

async function exerciseStorageAndDeletedReceipt({ page, context, origin, teacherId, posts, loseNextConfirmation, output }) {
  const dialog = page.getByRole('dialog', { name: 'Gerar simulado' });
  const input = dialog.getByRole('textbox', { name: 'Título do simulado' });
  const save = dialog.getByRole('button', { name: 'Salvar simulado', exact: true });
  const confirm = dialog.getByRole('button', { name: 'Confirmar salvamento', exact: true });

  await page.goto(origin + '/banco-questoes');
  const quotaSelection = await selectQuestions(page, 1);
  await openCreation(page);
  const quotaTitle = 'QA Rascunho com cota ' + randomUUID().slice(0, 8);
  await input.fill(quotaTitle);
  await expect.poll(async () => (await readDraft(page, teacherId))?.form.title, wait).toBe(quotaTitle);
  const restoreStorage = await page.evaluateHandle(prefix => {
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (this === sessionStorage && String(key).startsWith(prefix)) {
        throw new DOMException('Cota de rascunho simulada', 'QuotaExceededError');
      }
      return setItem.call(this, key, value);
    };
    return () => { Storage.prototype.setItem = setItem; };
  }, draftPrefix);
  const quotaStart = posts.length;
  try {
    await save.click();
    await expect(dialog.getByText('Nenhum simulado foi enviado.', { exact: false })).toBeVisible(wait);
    assert.equal(posts.length, quotaStart, 'Falha ao persistir a confirmação deve evitar qualquer POST.');
    await expect(input).toHaveValue(quotaTitle);
    await expect(dialog.locator('[data-selected-question="' + quotaSelection[0] + '"]')).toBeVisible();
    await capture(page, output, 'envio-bloqueado-cota-1024-light');
  } finally {
    await restoreStorage.evaluate(restore => restore());
    await restoreStorage.dispose();
  }
  await save.click();
  await expect(page.getByRole('heading', { name: quotaTitle, exact: true })).toBeVisible(wait);
  assert.equal(posts.length, quotaStart + 1);
  assert.equal(posts[quotaStart].status, 201);
  await expect.poll(() => readDraft(page, teacherId), wait).toBeNull();

  await page.goto(origin + '/banco-questoes');
  const deletedSelection = await selectQuestions(page, 1);
  await openCreation(page);
  const deletedTitle = 'QA Recibo excluído ' + randomUUID().slice(0, 8);
  await input.fill(deletedTitle);
  const deletedStart = posts.length;
  loseNextConfirmation();
  await save.click();
  await expect(confirm).toBeVisible(wait);
  const created = posts[deletedStart];
  assert.equal(created?.status, 201);
  assert.ok(Number.isSafeInteger(created.id) && created.id > 0);
  const token = await page.evaluate(() => JSON.parse(sessionStorage.getItem('labmathic_auth_session_v1'))?.token);
  assert.ok(typeof token === 'string' && token.length > 20, 'O login da fixture deve estar na sessão.');
  const deletion = await context.request.delete(origin + createPath + '/' + created.id, {
    headers: { Authorization: 'Bearer ' + token }, maxRedirects: 0,
  });
  assert.equal(deletion.status(), 200);
  await confirm.click();
  await expect(dialog.getByText('O simulado deste envio foi excluído.', { exact: false }).first()).toBeVisible(wait);
  await expect(confirm).toHaveCount(0);
  assert.equal(posts.length, deletedStart + 2);
  assert.equal(posts[deletedStart + 1].status, 410);
  assert.ok(posts[deletedStart + 1].key === created.key, 'O recibo excluído deve corresponder à mesma chave.');
  await page.reload();
  await expect(input).toHaveValue(deletedTitle, wait);
  await expect(dialog.locator('[data-selected-question="' + deletedSelection[0] + '"]')).toBeVisible();
  await expect(confirm).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Descartar rascunho', exact: true })).toBeVisible();
  assert.equal((await readDraft(page, teacherId))?.pending?.terminal, 'question_set_deleted');
  await capture(page, output, 'recibo-excluido-1024-light');
  return { postDuringQuotaFailure: 0, restoredStorageStatus: 201, deletedReceiptStatus: 410 };
}

async function exercise(browser, fixture, output, viewport, theme) {
  const { baseUrl: origin, accounts: { teacher, previewUser }, password } = fixture;
  const label = viewport.width + '-' + theme;
  const context = await browser.newContext({
    viewport, colorScheme: theme, serviceWorkers: 'block',
    ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}),
  });
  try {
    await context.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(({ origin, theme }) => {
      if (location.origin === origin) localStorage.setItem('theme', theme);
    }, { origin, theme });
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('dialog', dialog => dialog.type() === 'beforeunload' ? dialog.accept() : dialog.dismiss());
    const title = 'QA Simulado ' + label + ' ' + randomUUID().slice(0, 8);
    const description = 'Nota sintética para testar retomada nesta aba.';
    const bank = page.locator('[data-question-bank]');
    const dialog = page.getByRole('dialog', { name: 'Gerar simulado' });
    const titleField = dialog.getByRole('textbox', { name: 'Título do simulado' });
    const notesField = dialog.getByRole('textbox', { name: 'Observações (opcional)', exact: true });
    const verifyDraft = async () => {
      await expect(titleField).toHaveValue(title, wait);
      await expect(notesField).toHaveValue(description, wait);
      assert.deepEqual(await dialog.locator('[data-selected-question]').evaluateAll(items =>
        items.map(item => Number(item.dataset.selectedQuestion))), selectedIds);
    };

    await login(page, origin, teacher, password);
    await page.goto(origin + '/banco-questoes');
    const selectedIds = await selectQuestions(page, 2);
    await openCreation(page);
    await titleField.fill(title);
    await notesField.fill(description);
    await expect.poll(async () => (await readDraft(page, teacher.id))?.form.title, wait).toBe(title);
    await dialog.getByRole('button', { name: 'Continuar depois', exact: true }).click();
    await bank.getByText('Mais ações', { exact: true }).click();
    await bank.getByRole('button', { name: 'Meus simulados', exact: true }).click();
    await expect(page).toHaveURL(origin + '/simulados', wait);
    await expect(page.getByRole('link', { name: 'Montar simulado', exact: true })).toBeVisible(wait);
    await page.goBack();
    await expect(page).toHaveURL(origin + '/banco-questoes', wait);
    await openCreation(page);
    await verifyDraft();
    await dialog.getByRole('button', { name: 'Continuar depois', exact: true }).click();
    await page.reload();
    await openCreation(page);
    await verifyDraft();
    await capture(page, output, 'rascunho-' + label);

    const posts = [];
    let dropNextConfirmation = true;
    await context.route(url => url.origin === origin && url.pathname === createPath, async route => {
      const request = route.request();
      if (request.method() !== 'POST') return route.fallback();
      const record = { key: request.headers()['idempotency-key'], body: request.postDataJSON() };
      posts.push(record);
      const response = await route.fetch({ maxRedirects: 0, maxRetries: 0 });
      record.status = response.status();
      record.id = (await response.json()).id;
      if (dropNextConfirmation && record.status === 201) {
        dropNextConfirmation = false;
        await route.fulfill({ status: 503, json: { error: 'Interrupção simulada após o salvamento.' } });
      } else {
        await route.fulfill({ response });
      }
    });
    await dialog.getByRole('button', { name: 'Salvar simulado', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Confirmar salvamento', exact: true })).toBeVisible(wait);
    await expect(titleField).toBeDisabled(wait);
    assert.equal(posts.length, 1);
    assert.equal(posts[0].status, 201);
    assert.ok(Number.isSafeInteger(posts[0].id) && posts[0].id > 0);
    assert.ok(typeof posts[0].key === 'string' && posts[0].key.length >= 16, 'O POST deve incluir uma chave.');
    assert.deepEqual(posts[0].body.question_ids, selectedIds);
    assert.equal(posts[0].body.is_public, false);

    await page.reload();
    await expect(dialog.getByRole('button', { name: 'Confirmar salvamento', exact: true })).toBeVisible(wait);
    await verifyDraft();
    await expect(titleField).toBeDisabled(wait);
    assert.equal(posts.length, 1, 'Recarregar deve aguardar a ação explícita de confirmação.');
    await capture(page, output, 'envio-pendente-' + label);
    await dialog.getByRole('button', { name: 'Confirmar salvamento', exact: true }).click();
    await expect(page).toHaveURL(url => url.origin === origin && url.pathname === '/simulados/' + posts[0].id, wait);
    assert.equal(posts.length, 2);
    assert.equal(posts[1].status, 200);
    assert.equal(posts[1].id, posts[0].id);
    assert.ok(posts[1].key === posts[0].key, 'A confirmação deve reutilizar a mesma chave.');
    assert.deepEqual(posts[1].body, posts[0].body);
    await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible(wait);
    await expect.poll(() => readDraft(page, teacher.id), wait).toBeNull();
    await capture(page, output, 'confirmado-' + label);

    await page.goto(origin + '/simulados');
    await page.getByRole('searchbox', { name: 'Buscar simulado' }).fill(title);
    const search = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.origin === origin && url.pathname === createPath && url.searchParams.get('search') === title;
    });
    await page.getByRole('button', { name: 'Buscar', exact: true }).click();
    assert.equal((await search).status(), 200);
    await expect(page.locator('[data-question-set]')).toHaveCount(1, wait);
    await expect(page.locator('[data-question-set="' + posts[0].id + '"]')).toContainText(title);

    await page.goto(origin + '/banco-questoes');
    await selectQuestions(page, 1);
    await openCreation(page);
    await titleField.fill('Rascunho descartado ao encerrar sessão');
    await expect.poll(async () => (await readDraft(page, teacher.id))?.form.title, wait)
      .toBe('Rascunho descartado ao encerrar sessão');
    await dialog.getByRole('button', { name: 'Continuar depois', exact: true }).click();
    await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
    await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
    await expect(page).toHaveURL(url => url.pathname === '/login', wait);
    await expect.poll(() => readDraft(page, teacher.id), wait).toBeNull();

    await login(page, origin, previewUser, password);
    await page.goto(origin + '/banco-questoes');
    await expect(page.getByRole('region', { name: 'Questões encontradas' })).toBeVisible(wait);
    await expect(page.getByRole('region', { name: 'Seleção para o simulado' })).toHaveCount(0);
    const result = { viewport, theme, questionIds: selectedIds, setId: posts[0].id, posts: posts.map(({ status }) => status), uniqueRows: 1 };
    if (viewport.width === 1024 && theme === 'light') {
      await page.getByRole('button', { name: 'Menu do usuário', exact: true }).click();
      await page.getByRole('button', { name: 'Sair da conta', exact: true }).click();
      await expect(page).toHaveURL(url => url.pathname === '/login', wait);
      await login(page, origin, teacher, password);
      result.failureCases = await exerciseStorageAndDeletedReceipt({
        page, context, origin, teacherId: teacher.id, posts, output,
        loseNextConfirmation: () => { dropNextConfirmation = true; },
      });
    }
    assert.deepEqual(pageErrors, []);
    return result;
  } finally {
    await context.close();
  }
}

async function main() {
  const fixture = readFixture();
  const output = path.join(tempRoot, 'reliability-20261119-qa');
  fs.mkdirSync(output, { recursive: true });
  assert.equal(fs.realpathSync(output), output, 'As capturas devem permanecer no workspace.');
  const channel = process.env.RELIABILITY_BROWSER_CHANNEL;
  assert.ok(!channel || ['chrome', 'msedge'].includes(channel), 'Use um canal Chrome ou Edge local.');
  const browser = await chromium.launch({ headless: true, channel });
  const report = { status: 'running', data: 'synthetic', cases: [] };
  try {
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }]) {
      for (const theme of ['light', 'dark']) {
        const result = await exercise(browser, fixture, output, viewport, theme);
        report.cases.push(result);
        console.info('Fluxo de simulado aprovado:', viewport.width, theme);
      }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    throw error;
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
