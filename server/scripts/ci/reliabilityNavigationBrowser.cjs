const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { createRequire } = require('node:module');

const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const tempRoot = fs.realpathSync(path.join(root, 'tmp'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');
const wait = { timeout: 15000 };
const feedbackPath = '/banco-questoes/devolutivas';
const overviewPath = '/api/classes/home-overview';
const feedbackFlag = 'pedagogy.operational_cycle';

function readFixture() {
  const fixtureDir = path.join(tempRoot, 'platform-journey-audit');
  const connection = path.join(fixtureDir, 'connection.json');
  assert.equal(fs.realpathSync(fixtureDir), fixtureDir, 'A conexão deve estar na pasta de fixture do workspace.');
  assert.ok(fs.lstatSync(connection).isFile(), 'Inicie a fixture sintética antes do navegador.');
  const fixture = JSON.parse(fs.readFileSync(connection, 'utf8'));
  assert.match(fixture.baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/, 'Use somente o listener local da fixture.');
  const uploads = fs.realpathSync(fixture.uploadDir);
  const dataDir = path.dirname(uploads);
  assert.equal(path.dirname(dataDir), tempRoot);
  assert.match(path.basename(dataDir), /^labmathic-recovery-preview-api-[^/\\]+$/);
  assert.equal(path.basename(uploads), 'uploads');
  assert.ok(fs.lstatSync(path.join(dataDir, 'database.sqlite')).isFile());
  const { teacher, previewUser } = fixture.accounts || {};
  assert.ok(teacher?.role === 'professor' && teacher.email === 'ana-recovery@teste.local'
    && previewUser?.role === 'professor' && previewUser.email.endsWith('@audit.invalid')
    && typeof fixture.password === 'string', 'Use as contas descartáveis da fixture sintética.');
  assert.equal(fixture.seed?.classPublicId, 'class-recovery-public-id-0001');
  return fixture;
}

// The shared synthetic host may start without recovery data. Seed a separate
// diagnostic through the real API so the original fixture application stays intact.
async function ensureRecoveryPlan(fixture) {
  const { baseUrl, seed: { classPublicId, questionSetId }, accounts: { teacher } } = fixture;
  const title = 'Apoio aos números · teste de retomada';
  async function api(pathname, method = 'GET', data) {
    const url = new URL(pathname, baseUrl);
    assert.equal(url.origin, baseUrl);
    const response = await fetch(url, {
      method, redirect: 'error', signal: AbortSignal.timeout(wait.timeout),
      headers: {
        Authorization: 'Bearer ' + teacher.token, 'Content-Type': 'application/json',
        ...(method === 'POST' ? { 'Idempotency-Key': randomUUID() } : {}),
      },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
    assert.ok(response.ok, 'Preparação da fixture respondeu HTTP ' + response.status + ' em ' + pathname);
    return response.json();
  }
  const overview = await api(overviewPath);
  if (overview.recentRecoveryPlans.some(item => item.title === title && item.status === 'draft')) return title;
  const basePath = '/api/classes/' + classPublicId + '/assessments';
  const bootstrap = await api(basePath + '/bootstrap');
  const participantIds = bootstrap.participants.slice(0, 2).map(participant => participant.id);
  assert.equal(participantIds.length, 2);
  const draft = await api(basePath, 'POST', { sourceQuestionSetId: questionSetId, participantIds });
  const assignmentPath = basePath + '/' + draft.id;
  const opened = await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: draft.revision, action: 'open' });
  for (const id of participantIds) {
    const participantPath = assignmentPath + '/results/participants/' + id;
    const entry = await api(participantPath);
    const responses = entry.items.map(item => {
      const option = item.options.find(candidate => candidate.label === 'B');
      assert.ok(option, 'O diagnóstico da fixture precisa das alternativas sintéticas.');
      return { itemId: item.id, optionId: option.id };
    });
    const saved = await api(participantPath, 'PUT', { expectedRevision: 0, responses });
    await api(participantPath + '/submit', 'POST', { expectedRevision: saved.attempt.revision });
  }
  await api(assignmentPath + '/delivery', 'PATCH', { expectedRevision: opened.revision, action: 'close' });
  const preview = await api(assignmentPath + '/results/recovery-preview');
  const priority = preview.priorities.find(item => item.suggestedGroup?.students.length);
  assert.ok(preview.isActionable && priority, 'A recomposição sintética precisa de uma prioridade confirmável.');
  await api(assignmentPath + '/results/recovery-plans', 'POST', {
    expectedAssessmentRevision: preview.source.assessment.revision,
    expectedResultRevision: preview.source.resultRevision,
    methodologyVersion: preview.methodology.version,
    title,
    acceptedPriorities: [{
      skillId: priority.skill.id, suggestedQuestionCount: 2,
      group: {
        title: priority.suggestedGroup.title, objective: priority.suggestedGroup.objective,
        studentIds: priority.suggestedGroup.students.map(student => student.id),
      },
    }],
  });
  return title;
}

function waitForGet(page, origin, pathname) {
  const pending = page.waitForResponse(response => {
    const url = new URL(response.url());
    return url.origin === origin && url.pathname === pathname && response.request().method() === 'GET';
  }, wait);
  // The original navigation error remains authoritative if the page closes.
  void pending.catch(() => {});
  return pending;
}

async function login(page, origin, account, password) {
  const features = waitForGet(page, origin, '/api/governance/features');
  await page.goto(origin + '/login');
  await page.getByLabel('E-mail', { exact: true }).fill(account.email);
  await page.getByLabel('Senha', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Entrar no sistema', exact: true }).click();
  await expect(page.getByTestId('dashboard-heading')).toBeVisible(wait);
  const response = await features;
  assert.equal(response.status(), 200);
  const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
  if (await notice.isVisible()) await notice.click();
  return (await response.json()).features;
}

async function capture(page, output, name) {
  const dimensions = await page.evaluate(() => {
    const dialog = document.querySelector('[role="dialog"]');
    return {
      width: innerWidth, content: document.documentElement.scrollWidth,
      dialogOverflow: dialog ? dialog.scrollWidth - dialog.clientWidth : 0,
    };
  });
  assert.equal(dimensions.width, page.viewportSize().width);
  assert.ok(dimensions.content <= dimensions.width + 1, name + ' tem rolagem horizontal.');
  assert.ok(dimensions.dialogOverflow <= 1, name + ' tem um diálogo com rolagem horizontal.');
  await page.screenshot({ path: path.join(output, name + '.png'), animations: 'disabled' });
}

async function feedbackMenu(page, viewport, allowed) {
  const compact = viewport.width < 1280;
  await page.getByRole('button', { name: compact ? 'Abrir menu' : 'Avaliações', exact: true }).click();
  const menu = page.locator(compact ? '#mobile-main-menu' : '#desktop-assessments-menu');
  await expect(menu).toBeVisible(wait);
  const shortcut = menu.getByRole('link', { name: /^Devolutivas da turma/ });
  if (allowed) await expect(shortcut).toHaveAttribute('href', feedbackPath, wait);
  else await expect(shortcut).toHaveCount(0, wait);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0, wait);
}

function recoveryAction(plan) {
  return plan.status === 'draft' ? 'Continuar revisão' : plan.status === 'completed' ? 'Ver histórico'
    : plan.execution ? 'Acompanhar aulas' : 'Organizar aulas';
}

async function expectPlan(page, origin, plan, navigate) {
  const detailPath = '/api/classes/' + plan.class.id + '/assessments/' + plan.sourceAssessment.id + '/results/recovery-plans/' + plan.id;
  const detail = waitForGet(page, origin, detailPath);
  await navigate();
  const dialog = page.getByRole('dialog', { name: 'Plano de recomposição', exact: true });
  await expect(dialog).toBeVisible(wait);
  assert.equal((await detail).status(), 200, 'O detalhe deve vir da leitura autorizada do plano exato.');
  if (plan.status === 'draft') await expect(dialog.getByLabel('Título do plano')).toHaveValue(plan.title, wait);
  else await expect(dialog.getByText(plan.title + ' · ' + plan.class.name, { exact: true })).toBeVisible(wait);
  return dialog;
}

async function teacherFlow(page, fixture, output, label, viewport) {
  const { baseUrl: origin, accounts, password } = fixture;
  const overviewRequest = waitForGet(page, origin, overviewPath);
  const flags = await login(page, origin, accounts.teacher, password);
  assert.ok([feedbackFlag, 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'classes.learning_recovery']
    .every(flag => flags[flag] === true), 'A conta da fixture deve estar liberada para o fluxo de avaliação e recomposição.');
  const overviewResponse = await overviewRequest;
  assert.equal(overviewResponse.status(), 200);
  const overview = await overviewResponse.json();
  const home = page.locator('[data-teacher-home]');
  const work = home.getByRole('region', { name: 'Retome seu trabalho' });
  const plan = overview.recentRecoveryPlans.find(item => item.title === fixture.recoveryTitle && item.status === 'draft');
  const assessment = overview.recentAssessments.find(item => item.id === fixture.seed.assessmentPublicId);
  assert.ok(plan && assessment, 'A fixture deve incluir uma aplicação e um plano de recomposição consultáveis.');
  const planPath = '/recomposicao?' + new URLSearchParams({ plano: plan.id });
  const assessmentPath = '/turmas?' + new URLSearchParams({ turma: assessment.class.id, secao: 'avaliacoes', avaliacao: assessment.id });
  const planLink = work.locator('a[href="' + planPath + '"]');
  const assessmentLink = work.locator('a[href="' + assessmentPath + '"]');
  await expect(planLink).toContainText(recoveryAction(plan), wait);
  await expect(assessmentLink).toContainText(assessment.status === 'open' ? 'Acompanhar aplicação' : 'Consultar aplicação', wait);
  const rows = await work.locator('a').evaluateAll(links => links.map(link => link.getAttribute('href')));
  if (assessment.status === 'open') assert.ok(rows.indexOf(assessmentPath) < rows.indexOf(planPath), 'A aplicação em andamento deve aparecer antes do plano em revisão.');
  if (assessment.status === 'closed') assert.ok(rows.indexOf(planPath) < rows.indexOf(assessmentPath), 'Plano em revisão deve preceder aplicação encerrada.');
  await expect(home.getByRole('link', { name: 'Devolutivas da turma', exact: true })).toHaveAttribute('href', feedbackPath, wait);
  await feedbackMenu(page, viewport, true);
  await work.evaluate(section => {
    const headerBottom = document.querySelector('[data-main-header]').getBoundingClientRect().bottom;
    window.scrollTo({ top: scrollY + section.getBoundingClientRect().top - headerBottom - 8, behavior: 'instant' });
  });
  await capture(page, output, 'inicio-' + label);
  await assessmentLink.click();
  await expect(page).toHaveURL(origin + assessmentPath, wait);
  await expect(page.locator('[data-assessment-located]')).toHaveAttribute('data-assessment-id', assessment.id, wait);
  await page.goBack();
  await expect(planLink).toBeVisible(wait);

  const direct = await expectPlan(page, origin, plan, () => planLink.click());
  await expect(page).toHaveURL(origin + planPath, wait);
  await capture(page, output, 'plano-' + label);
  await direct.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page).toHaveURL(origin + '/recomposicao', wait);
  const row = page.locator('[data-recovery-plan="' + plan.id + '"]');
  await expect(row.getByRole('button', { name: recoveryAction(plan), exact: true })).toBeFocused(wait);

  const filters = new URLSearchParams({ busca: plan.title.slice(0, 80), situacao: plan.status });
  const filteredPath = '/recomposicao?' + filters;
  filters.set('plano', plan.id);
  const filtered = await expectPlan(page, origin, plan, () => page.goto(origin + '/recomposicao?' + filters));
  await filtered.getByRole('button', { name: 'Fechar', exact: true }).click();
  await expect(page).toHaveURL(origin + filteredPath, wait);
  await expect(page.getByRole('searchbox', { name: 'Buscar plano', exact: true })).toHaveValue(plan.title.slice(0, 80), wait);
  await expect(page.getByRole('combobox', { name: 'Situação', exact: true })).toHaveValue(plan.status, wait);
  await expect(row.getByRole('button', { name: recoveryAction(plan), exact: true })).toBeFocused(wait);
  return { planId: plan.id, checks: ['ordenação por situação', 'aplicação localizada', 'plano exato', 'filtros e foco preservados'] };
}

async function restrictedFlow(page, fixture, output, label, viewport, planId) {
  const { baseUrl: origin, accounts, password } = fixture;
  const flags = await login(page, origin, accounts.previewUser, password);
  assert.equal(flags[feedbackFlag], false, 'A conta de comparação deve ter o ciclo desligado.');
  const home = page.locator('[data-teacher-home]');
  await expect(home).toBeVisible(wait);
  await expect(home.getByRole('link', { name: 'Devolutivas da turma', exact: true })).toHaveCount(0, wait);
  await feedbackMenu(page, viewport, false);
  await page.goto(origin + feedbackPath);
  await expect(page.locator('[data-bank-access="not_released"]')).toBeVisible(wait);
  await capture(page, output, 'sem-liberacao-' + label);
  const forbiddenDetails = [];
  page.on('request', request => {
    if (new URL(request.url()).pathname.endsWith('/results/recovery-plans/' + planId)) forbiddenDetails.push(request.method());
  });
  await page.goto(origin + '/recomposicao?' + new URLSearchParams({ plano: planId }));
  await expect(page.getByText('O plano do link não apareceu nesta consulta.', { exact: false })).toBeVisible(wait);
  await expect(page.getByRole('dialog', { name: 'Plano de recomposição', exact: true })).toHaveCount(0, wait);
  assert.deepEqual(forbiddenDetails, [], 'O link de outra conta não deve carregar o detalhe.');
}

async function exercise(browser, fixture, output, viewport, theme) {
  const label = viewport.width + '-' + theme;
  const makeContext = async () => {
    const context = await browser.newContext({
      viewport, colorScheme: theme, serviceWorkers: 'block',
      ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}),
    });
    await context.route('**/*', route => {
      const request = route.request();
      const url = new URL(request.url());
      const allowed = ['GET', 'HEAD'].includes(request.method()) || (request.method() === 'POST' && url.pathname === '/api/auth/login');
      return url.origin === fixture.baseUrl && allowed ? route.continue() : route.abort();
    });
    await context.routeWebSocket('**/*', socket => socket.close());
    await context.addInitScript(({ origin, theme }) => {
      if (location.origin === origin) localStorage.setItem('theme', theme);
    }, { origin: fixture.baseUrl, theme });
    return context;
  };
  const pageErrors = [];
  const newPage = async context => {
    const page = await context.newPage();
    page.on('pageerror', () => pageErrors.push('erro de execução'));
    return page;
  };
  const teacherContext = await makeContext();
  let planId, checks;
  try {
    ({ planId, checks } = await teacherFlow(await newPage(teacherContext), fixture, output, label, viewport));
  } finally { await teacherContext.close(); }
  const restrictedContext = await makeContext();
  try {
    await restrictedFlow(await newPage(restrictedContext), fixture, output, label, viewport, planId);
  } finally { await restrictedContext.close(); }
  assert.equal(pageErrors.length, 0, 'O navegador registrou erro de execução.');
  return { viewport, theme, checks: [...checks, 'atalhos condicionados à liberação', 'plano de outra conta oculto'], pageErrors: 0 };
}

async function main() {
  const fixture = readFixture();
  const output = path.join(tempRoot, 'reliability-20261119-qa');
  fs.mkdirSync(output, { recursive: true });
  assert.equal(fs.realpathSync(output), output);
  const channel = process.env.RELIABILITY_BROWSER_CHANNEL;
  assert.ok(!channel || ['chrome', 'msedge'].includes(channel));
  const browser = await chromium.launch({ headless: true, channel, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'] });
  const report = { status: 'running', data: 'synthetic', cases: [] };
  try {
    fixture.recoveryTitle = await ensureRecoveryPlan(fixture);
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }]) {
      for (const theme of ['light', 'dark']) {
        report.cases.push(await exercise(browser, fixture, output, viewport, theme));
        console.info('Fluxo de retomada aprovado', viewport.width, theme);
      }
    }
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    // Login failures can include typed values in Playwright's call log.
    const privateValues = [fixture.password, ...Object.values(fixture.accounts).flatMap(account => [account.token, account.email])].filter(Boolean);
    const redacted = privateValues.reduce((message, value) => message.replaceAll(value, '[oculto]'), error.message);
    throw new Error(redacted);
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(output, 'navigation-report.json'), JSON.stringify(report, null, 2));
  }
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 1;
});
