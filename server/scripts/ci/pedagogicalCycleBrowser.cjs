// Invoked only by the opt-in synthetic API fixture. Never starts the real server/database.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runPedagogicalCycleBrowser({ app, db, baseUrl, teacher, token, classPublicId, assessmentPublicId }) {
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const express = require('express');
  for (const route of ['auth', 'users', 'materials', 'categories', 'favorites', 'collections', 'notifications',
    'reports', 'support', 'announcements', 'governance', 'classes']) {
    app.use(`/api/${route}`, require(`../../src/routes/${route}`));
  }
  app.use('/api/institutions/read-model', require('../../src/routes/institutionalReadModel'));
  app.use('/api/question-bank', require('../../src/routes/diagnostics'));
  app.use('/api/question-bank', require('../../src/routes/questionBank'));
  app.use('/api', (_req, res) => res.sendStatus(404));
  const build = path.join(root, 'tmp/pedagogical-cycle-build');
  assert.ok(fs.existsSync(path.join(build, 'index.html')), 'Build isolated client first');
  app.use(express.static(build));
  app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
  app.use(require('../../src/middleware/apiErrors'));
  const output = path.join(root, 'tmp/pedagogical-cycle-qa'); fs.mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const errors = [];
  const cycleUrl = `${baseUrl}/banco-questoes/devolutivas?turma=${classPublicId}&avaliacao=${assessmentPublicId}`;
  const field = page => page.getByLabel('Como saber se a turma avançou?', { exact: true });
  const save = page => page.getByRole('button', { name: 'Salvar nova revisão', exact: true });
  let captures = 0;
  async function capture(page, name, locator) {
    if (locator) await locator.scrollIntoViewIfNeeded();
    await page.waitForTimeout(150);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ': horizontal overflow');
    await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css' }); captures++;
  }
  async function createContext(viewport, theme) {
    const context = await browser.newContext({ viewport, colorScheme: theme });
    await context.route('https://fonts.googleapis.com/**', route => route.abort());
    await context.route('https://fonts.gstatic.com/**', route => route.abort());
    await context.addInitScript(({ user, authToken, themeName, origin }) => {
      if (window.location.origin !== origin) return;
      sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ token: authToken, user }));
      localStorage.setItem('theme', themeName);
    }, { user: teacher, authToken: token, themeName: theme, origin: baseUrl });
    context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
    return context;
  }
  async function ready(page) {
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Devolutivas da turma', exact: true })).toBeVisible();
    const announcement = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
    if (await announcement.isVisible()) await announcement.click();
    await page.getByRole('button', { name: /^Meu registro/ }).click();
    await expect(field(page)).toBeVisible();
  }
  try {
    const context = await createContext({ width: 1024, height: 600 }, 'dark');
    const page = await context.newPage();
    await page.goto(cycleUrl); await ready(page);
    await page.getByRole('heading', { name: 'Devolutivas da turma', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'notebook-cycle-context');
    const initialRevision = db.prepare('SELECT MAX(revision) FROM pedagogical_feedback_versions').pluck().get();
    await field(page).fill('Após a verificação, avançar com nova atividade e retomar com quem ainda precisar de apoio. Registro do teste de interface.');
    await save(page).click();
    await expect(page.getByText(`Revisão ${initialRevision + 1} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    await capture(page, 'notebook-feedback-saved', save(page));
    await page.reload(); await ready(page);
    await expect(field(page)).toHaveValue(/Registro do teste de interface/);
    await page.getByText('Consultar histórico de revisões', { exact: true }).click();
    await expect(page.getByRole('heading', { name: new RegExp(`^Revisão ${initialRevision + 1} ·`) })).toBeVisible();
    await expect(page.getByText(/Verificação preservada nesta revisão:/).first()).toBeVisible();
    await page.getByRole('button', { name: 'Carregar revisões anteriores', exact: true }).click();
    await expect(page.getByRole('heading', { name: /^Revisão 1 ·/ })).toBeVisible();
    await capture(page, 'notebook-history', page.getByText('Consultar histórico de revisões', { exact: true }));
    await page.getByText('Consultar histórico de revisões', { exact: true }).click();
    await page.getByRole('button', { name: 'Plano de apoio', exact: true }).click();
    await page.getByRole('button', { name: 'Abrir plano e execução' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, 'notebook-execution');
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await capture(page, 'notebook-verification', page.getByRole('heading', { name: 'Verificação com evidências' }));
    await page.getByRole('button', { name: 'Revisar resultados da verificação' }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    // Off-happy path 1: competing tabs, no silent overwrite, explicit rebase preserves text.
    const other = await context.newPage(); await other.goto(cycleUrl); await ready(other);
    await page.getByRole('button', { name: /^Meu registro/ }).click();
    await field(page).fill('Primeira aba registra uma nova decisão pedagógica para a turma.'); await save(page).click();
    await expect(page.getByText(`Revisão ${initialRevision + 2} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    const pending = 'Segunda aba mantém seu texto para conciliar com a decisão da primeira aba.';
    await field(other).fill(pending); await save(other).click();
    await expect(other.getByText('Existe uma revisão mais recente. Recarregue antes de salvar.', { exact: true })).toBeVisible();
    await expect(field(other)).toHaveValue(pending);
    await capture(other, 'conflict-keeps-draft', other.getByRole('button', { name: /Revisei; usar referência/ }));
    await other.getByRole('button', { name: /Revisei; usar referência/ }).click();
    await save(other).click();
    await expect(other.getByText(`Revisão ${initialRevision + 3} salva. Registro privado do professor.`, { exact: true })).toBeVisible();
    await other.close();
    // Off-happy path 2: failed refresh blocks writes and keeps unsaved work.
    await field(page).fill('Texto preservado enquanto a consulta dos resultados está indisponível.');
    await page.route('**/api/pedagogical-cycle/classes/*/assessments/*', route => route.request().method() === 'GET' ? route.abort() : route.continue());
    await page.getByRole('button', { name: 'Resultados', exact: true }).click();
    await page.getByRole('button', { name: 'Atualizar resultados', exact: true }).click();
    await page.getByRole('button', { name: /^Meu registro/ }).click();
    await expect(page.getByText(/O salvamento está bloqueado/)).toBeVisible(); await expect(save(page)).toBeDisabled();
    await expect(field(page)).toHaveValue(/Texto preservado/);
    await page.unroute('**/api/pedagogical-cycle/classes/*/assessments/*');
    await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
    await page.getByRole('button', { name: /Revisei; usar referência/ }).click();
    await save(page).click(); await expect(page.getByText(/Registro privado do professor\./, { exact: false }).last()).toBeVisible();
    // Real bank discovery -> teacher-reviewed diagnostic -> chosen-class application dialog.
    await page.getByRole('region', { name: 'Turma e aplicação selecionadas' }).locator('summary').click();
    await page.getByRole('link', { name: 'Abrir Banco 2.0', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Contexto do ciclo pedagógico' })).toContainText('1º Ano A');
    await page.locator('[data-question-bank] summary').filter({ hasText: 'Mais ações' }).click();
    await page.getByRole('button', { name: 'Gerar diagnóstico', exact: true }).click();
    const generator = page.getByRole('dialog'); await expect(generator).toBeVisible();
    await generator.getByLabel('Ano escolar', { exact: true }).selectOption({ label: '7º Ano - EF' });
    await generator.getByLabel('Questões por habilidade', { exact: true }).selectOption('2');
    await generator.getByRole('button', { name: 'Escolher habilidades', exact: true }).click();
    await generator.getByRole('button', { name: 'Selecionar EF07MA01', exact: true }).click();
    await generator.getByRole('button', { name: 'Conferir seleção', exact: true }).first().click();
    await generator.getByRole('button', { name: /Gerar diagnóstico/ }).click();
    await generator.getByRole('button', { name: 'Abrir e revisar', exact: true }).click();
    await expect(page).toHaveURL(/simulados\/\d+\?turma=/);
    await expect(page.getByRole('button', { name: /Confirmar revisão/ })).toBeVisible();
    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: /Confirmar revisão/ }).click();
    await page.getByRole('link', { name: 'Preparar aplicação nesta turma', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await capture(page, 'diagnostic-ready-for-class');
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: 'Devolutiva e ciclo da turma', exact: true }).first().click();
    await expect(page).toHaveURL(/banco-questoes\/devolutivas\?turma=.*&avaliacao=/);
    // Search/empty/recovery of class picker using ordinary controls.
    await page.goto(baseUrl + '/banco-questoes/devolutivas');
    await page.getByLabel('Buscar turma', { exact: true }).fill('Turma inexistente');
    await expect(page.getByText('Nenhuma turma encontrada para essa busca.', { exact: true })).toBeVisible();
    await page.getByLabel('Buscar turma', { exact: true }).fill('');
    await page.getByRole('button', { name: /1º Ano A/ }).click();
    await page.getByLabel('Aplicação da turma', { exact: true }).selectOption(assessmentPublicId);
    await ready(page);
    const start = Date.now(); let explorations = 0;
    while (Date.now() - start < 30000) {
      await page.getByRole('button', { name: 'Resultados', exact: true }).click();
      await page.getByRole('button', { name: 'Atualizar resultados', exact: true }).click();
      await page.getByRole('button', { name: /^Meu registro/ }).click();
      await expect(save(page)).toBeDisabled();
      await page.getByText('Consultar histórico de revisões', { exact: true }).click();
      await page.getByText('Consultar histórico de revisões', { exact: true }).click();
      await page.getByRole('heading', { name: 'Devolutivas da turma', exact: true }).scrollIntoViewIfNeeded();
      await page.keyboard.press('Tab'); await page.mouse.wheel(0, 300); explorations++;
    }
    await context.close();
    for (const theme of ['dark', 'light']) {
      const mobile = await createContext({ width: 390, height: 664 }, theme);
      const page = await mobile.newPage(); await page.goto(cycleUrl); await ready(page);
      await page.getByRole('heading', { name: 'Devolutivas da turma', exact: true }).scrollIntoViewIfNeeded();
      await capture(page, `mobile-${theme}-context`);
      await capture(page, `mobile-${theme}-feedback`, page.getByRole('heading', { name: 'Meu registro sobre a turma', exact: true }));
      await page.getByRole('button', { name: 'Plano de apoio', exact: true }).click();
      await capture(page, `mobile-${theme}-verification`, page.getByRole('heading', { name: 'Verificação com evidências', exact: true }));
      await mobile.close();
    }
    assert.deepEqual(errors, []);
    return { status: 'passed', captures, explorations, pageErrors: errors, isolated: true };
  } catch (error) {
    const pages = browser.contexts().flatMap(context => context.pages());
    for (let index = 0; index < pages.length; index++) {
      await pages[index].screenshot({ path: path.join(output, `failure-${index}.png`), scale: 'css' }).catch(() => {});
      console.error('QA visible state', pages[index].url(), await pages[index].locator('main').innerText().catch(() => 'No main'));
    }
    throw error;
  } finally { await browser.close(); }
}
module.exports = { runPedagogicalCycleBrowser };
