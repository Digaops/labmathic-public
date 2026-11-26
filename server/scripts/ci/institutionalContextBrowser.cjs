// Only called from the opt-in institutional API test, never from the application startup.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runInstitutionalContextBrowser({ app, db, baseUrl, admin, teacher, tokenFor }) {
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-institutional-management-[^/\\]+[/\\]database\.sqlite$/);
  const build = path.join(root, 'tmp/institutional-context-build');
  assert.ok(fs.existsSync(path.join(build, 'index.html')), 'Build isolated client first');
  const express = require('express');
  for (const route of ['auth', 'users', 'materials', 'categories', 'favorites', 'collections', 'notifications',
    'reports', 'activity', 'support', 'announcements', 'governance', 'classes']) app.use(`/api/${route}`, require(`../../src/routes/${route}`));
  app.use('/api/institutions/read-model', require('../../src/routes/institutionalReadModel'));
  app.use('/api', (_req, res) => res.sendStatus(404));
  app.use(express.static(build));
  app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
  app.use(require('../../src/middleware/apiErrors'));
  const output = path.join(root, 'tmp/institutional-context-qa');
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'running', syntheticDataOnly: true }));
  let key = 0;
  async function api(url, user = admin, body) {
    const response = await fetch(baseUrl + '/api' + url, { method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json', 'Idempotency-Key': `context-browser-fixture-${++key}` },
      body: body ? JSON.stringify(body) : undefined });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify(result));
    return result;
  }
  function flag(name, user, enabled = true) {
    const id = db.prepare('SELECT id FROM feature_flags WHERE flag_key = ?').pluck().get(name);
    assert.ok(id, name);
    db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(id);
    db.prepare(`INSERT OR REPLACE INTO feature_flag_user_rules (feature_flag_id, user_id, enabled, reason, created_by, updated_by)
      VALUES (?, ?, ?, 'QA sintético de clareza da interface', ?, ?)`).run(id, user.id, Number(enabled), admin.id, admin.id);
  }
  function addUser(label) {
    const user = { name: label, email: `context-${++key}@teste.invalid`, role: 'professor' };
    user.id = Number(db.prepare("INSERT INTO users (name, email, password, role) VALUES (?, ?, 'hash-sintetico', ?)").run(user.name, user.email, user.role).lastInsertRowid);
    for (const name of ['institutions.read_model', 'institutions.management_pilot', 'classes.core']) flag(name, user);
    return user;
  }
  for (const user of [teacher, admin]) for (const name of ['institutions.read_model', 'classes.core']) flag(name, user);
  const teacherState = await api('/institutions/management', teacher);
  const first = teacherState.guidedClasses[0];
  assert.ok(first && first.migrationStatus === 'verified');
  const municipality = db.prepare('SELECT public_id FROM municipalities LIMIT 1').pluck().get();
  const school = db.prepare('SELECT public_id FROM schools WHERE id = 1').pluck().get();
  const grade = db.prepare('SELECT id FROM grades ORDER BY sort_order, id LIMIT 1').pluck().get();
  const discipline = db.prepare('SELECT id FROM disciplines ORDER BY id LIMIT 1').pluck().get();
  const pendingTeacher = addUser('Professora com confirmação pendente');
  const noClassesAccess = addUser('Professora somente consulta das turmas');
  const emptyTeacher = addUser('Professora sem vínculos');
  const manager = addUser('Gestora municipal');
  const denseTeacher = addUser('Professora com mais de uma escola');
  async function membership(user, schoolPublicId = school, role = 'teacher') {
    return (await api('/institutions/management/memberships', admin, { userId: user.id, role,
      municipalityPublicId: municipality, ...(schoolPublicId ? { schoolPublicId } : {}) })).membership;
  }
  async function guided(user, name) {
    const link = await membership(user);
    return (await api('/institutions/management/classes', admin, { membershipPublicId: link.publicId,
      name, gradeId: grade, academicYear: 2026, disciplineIds: [discipline] })).schoolClass;
  }
  const pending = await guided(pendingTeacher, '9º Ano B · Tarde');
  await guided(noClassesAccess, '7º Ano · Consulta'); flag('classes.core', noClassesAccess, false);
  await membership(manager, null, 'municipal_manager');
  const dense = await guided(denseTeacher, '9º Ano · Turma com nome comprido para leitura em telas pequenas');
  const secondSchool = (await api(`/institutions/management/municipalities/${municipality}/schools`, admin, {
    name: 'Escola Municipal Professora Maria da Conceição de Albuquerque e Silva',
  })).school;
  await membership(denseTeacher, secondSchool.publicId);
  await api(`/institutions/management/classes/${dense.publicId}/confirm`, denseTeacher, { expectedContextUpdatedAt: dense.contextUpdatedAt });
  db.prepare("INSERT INTO school_classes (public_id, owner_teacher_id, name, grade_id, academic_year, status, archived_at, created_by) VALUES ('qa-archived-class-000001', ?, 'Turma anterior', ?, 2025, 'archived', CURRENT_TIMESTAMP, ?)").run(denseTeacher.id, grade, denseTeacher.id);
  flag('institutions.management_pilot', denseTeacher, false);
  const errors = [];
  const metrics = [];
  let captures = 0;
  let explorations = 0;
  const browser = await chromium.launch({ headless: true });
  async function context(user, viewport, theme = 'dark') {
    const instance = await browser.newContext({ viewport, colorScheme: theme, ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    await instance.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await instance.addInitScript(({ user, token, theme, origin }) => {
      if (location.origin !== origin) return;
      sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token })); localStorage.setItem('theme', theme);
    }, { user, token: tokenFor(user), theme, origin: baseUrl });
    instance.on('page', page => page.on('pageerror', error => errors.push({ page: page.url(), message: error.message })));
    return instance;
  }
  async function ready(page, user = teacher) {
    await page.goto(baseUrl + '/instituicoes');
    await page.waitForLoadState('networkidle');
    await expect(page.getByRole('heading', { name: 'Minha escola e minhas turmas', exact: true })).toBeVisible();
    await expect(page.getByText('Minha escola', { exact: true }).filter({ visible: true })).toBeVisible();
    if (user === teacher) await expect(page.getByText('Nenhuma turma aguardando sua confirmação.', { exact: true })).toBeVisible();
    const announcement = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
    if (await announcement.isVisible()) await announcement.click();
  }
  async function capture(page, name, primary) {
    await page.waitForTimeout(350);
    await expect(page.getByRole('dialog')).toHaveCount(0);
    const viewport = page.viewportSize();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, name + ': horizontal overflow');
    if (primary) {
      const bounds = await primary.boundingBox();
      assert.ok(bounds && bounds.y >= 98 && bounds.y + bounds.height <= viewport.height, `${name}: primary action must fit initial viewport (${JSON.stringify(bounds)})`);
      assert.ok(bounds.height >= 44 && bounds.width >= 44);
      metrics.push({ name, viewport, primaryBottom: Math.round(bounds.y + bounds.height) });
      assert.equal(await page.evaluate(() => scrollY), 0, 'No scrolling before initial screenshot');
    }
    await page.screenshot({ path: path.join(output, `${name}.png`), scale: 'css' }); captures++;
  }
  try {
    for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }, { width: 320, height: 640 }]) {
      for (const theme of ['dark', 'light']) {
        const instance = await context(teacher, viewport, theme); const page = await instance.newPage();
        await ready(page);
        const open = page.getByRole('link', { name: `Abrir turma ${first.name}`, exact: true });
        await capture(page, `${viewport.width}-${theme}-initial`, open);
        await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
        await expect(page.getByRole('navigation', { name: 'Navegação compacta', exact: true }).getByRole('link', { name: 'Minha escola', exact: true })).toHaveAttribute('href', '/instituicoes');
        await page.getByRole('button', { name: 'Fechar menu', exact: true }).click();
        const before = db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get();
        await open.click(); await expect(page).toHaveURL(new RegExp(`turmas\\?turma=${first.publicId}`));
        await expect(page.getByRole('heading', { name: first.name, exact: true })).toBeVisible();
        assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), before);
        await ready(page);
        const help = page.getByText('Sobre as escolas e as confirmações', { exact: true });
        await help.focus(); await page.keyboard.press('Enter');
        await expect(page.getByText('A escola não é escolhida automaticamente', { exact: false })).toBeVisible();
        await page.keyboard.press('Enter');
        await expect(page.getByText('A escola não é escolhida automaticamente', { exact: false })).toBeHidden();
        await page.getByRole('link', { name: 'Ver todas', exact: true }).click(); await expect(page).toHaveURL(baseUrl + '/turmas');
        await instance.close();
      }
    }
    const instance = await context(pendingTeacher, { width: 390, height: 664 }); const page = await instance.newPage();
    await ready(page, pendingTeacher);
    const confirm = page.getByRole('button', { name: 'Confirmar turma', exact: true });
    await expect(confirm).toBeVisible(); await expect(page.getByText(/Algo está diferente\?/)).toBeVisible();
    await capture(page, 'pending-confirmation');
    await page.route('**/api/institutions/management/classes/*/confirm', route => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'Os dados mudaram. Consulte a turma novamente antes de confirmar.' }) }));
    await confirm.click(); await expect(page.getByText('Os dados mudaram. Consulte a turma novamente antes de confirmar.')).toBeVisible();
    assert.equal((await api('/institutions/management', pendingTeacher)).pendingConfirmations.length, 1);
    await capture(page, 'confirmation-conflict'); await page.unroute('**/api/institutions/management/classes/*/confirm');
    const beforeAudit = db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get();
    await confirm.click(); await expect(page.getByText('Nenhuma turma aguardando sua confirmação.')).toBeVisible();
    assert.equal((await api('/institutions/management', pendingTeacher)).pendingConfirmations.length, 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), beforeAudit + 1);
    await capture(page, 'confirmation-completed', page.getByRole('link', { name: `Abrir turma ${pending.name}`, exact: true }));
    await page.route('**/api/institutions/management', route => route.abort());
    await ready(page, pendingTeacher); await expect(page.getByRole('alert')).toContainText('Não foi possível consultar');
    await expect(page.getByText('Nenhuma turma aguardando sua confirmação.')).toHaveCount(0);
    await expect(page.getByRole('link', { name: `Abrir turma ${pending.name}` })).toBeVisible(); await capture(page, 'confirmation-load-error');
    await page.unroute('**/api/institutions/management'); await page.getByRole('button', { name: 'Tentar novamente', exact: true }).click();
    await expect(page.getByText('Nenhuma turma aguardando sua confirmação.')).toBeVisible(); await instance.close();

    for (const [name, user] of [['classes-disabled', noClassesAccess], ['no-school-or-class', emptyTeacher], ['multiple-schools-readonly', denseTeacher]]) {
      const instance = await context(user, { width: 320, height: 640 }, 'light'); const page = await instance.newPage();
      let operationalRequests = 0; page.on('request', request => { if (request.url().endsWith('/api/institutions/management')) operationalRequests++; });
      await ready(page, user); await capture(page, name);
      if (user === noClassesAccess) {
        await expect(page.getByRole('link', { name: /^Abrir turma|^Ver todas$/ })).toHaveCount(0);
        await expect(page.getByText(/peça à administração para liberar a área Turmas/)).toBeVisible();
      }
      if (user === emptyTeacher) await expect(page.getByText('Nenhuma turma ativa por aqui.')).toBeVisible();
      if (user === denseTeacher) {
        assert.equal(operationalRequests, 0); await expect(page.getByRole('button', { name: 'Confirmar turma' })).toHaveCount(0);
        await expect(page.getByRole('link', { name: /Abrir turma Turma anterior/ })).toHaveCount(0);
        for (const label of ['Meus vínculos com escolas e rede (2)', 'Turmas arquivadas (1)']) {
          const summary = page.getByText(label, { exact: true }); await summary.focus(); await page.keyboard.press('Enter');
        }
        await expect(page.getByText(secondSchool.name, { exact: false })).toBeVisible();
        await expect(page.getByRole('heading', { name: 'Turma anterior', exact: true })).toBeVisible();
        await capture(page, 'multiple-schools-expanded');
        const start = Date.now();
        while (Date.now() - start < 30000) {
          const help = page.getByText('Sobre as escolas e as confirmações', { exact: true });
          await help.click(); await page.keyboard.press('Tab'); await page.mouse.wheel(0, 150); await help.click();
          await page.mouse.wheel(0, -600); await page.waitForTimeout(500); explorations++;
        }
      }
      await instance.close();
    }
    for (const [name, user] of [['admin-institutions', admin], ['manager-institutions', manager]]) {
      const instance = await context(user, { width: 1024, height: 600 }); const page = await instance.newPage();
      await page.goto(baseUrl + '/instituicoes');
      await page.waitForLoadState('networkidle');
      const announcement = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
      if (await announcement.isVisible()) await announcement.click();
      await expect(page.getByRole('heading', { name: user === admin ? 'Municípios, escolas, profissionais e turmas' : 'Minha rede institucional', exact: true })).toBeVisible();
      await expect(page.locator('[data-professional-context]')).toHaveCount(0); await capture(page, name);
      if (user === admin) {
        await page.goto(baseUrl + '/admin'); await expect(page.getByRole('heading', { name: 'Painel administrativo', exact: true })).toBeVisible();
        await page.waitForLoadState('networkidle');
        await capture(page, 'admin-dashboard-current');
        for (const [slug, title] of [['usuarios', 'Gerenciar usuários'], ['materiais', 'Gerenciar materiais'], ['categorias', 'Gerenciar categorias'], ['relatorios', 'Relatórios administrativos'], ['atividades', 'Timeline de auditoria']]) {
          await page.goto(`${baseUrl}/admin/${slug}`); await page.waitForLoadState('networkidle');
          await expect(page.getByRole('heading', { name: title, exact: true })).toBeVisible();
          await capture(page, `admin-${slug}-current`);
        }
        await page.setViewportSize({ width: 390, height: 664 });
        await page.goto(baseUrl + '/admin/usuarios'); await page.waitForLoadState('networkidle');
        await capture(page, 'admin-users-mobile-current');
        await page.getByRole('button', { name: 'Novo usuário', exact: true }).click();
        const dialog = page.getByRole('dialog', { name: 'Novo usuário', exact: true });
        await expect(dialog).toBeVisible();
        await page.waitForTimeout(350);
        await page.screenshot({ path: path.join(output, 'admin-user-form-mobile-current.png'), scale: 'css' }); captures++;
        await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
      }
      await instance.close();
    }
    assert.deepEqual(errors, []);
    const report = { status: 'passed', captures, explorations, metrics, pageErrors: errors, realApi: true, syntheticDataOnly: true };
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } catch (error) {
    fs.writeFileSync(path.join(output, 'report.json'), JSON.stringify({ status: 'failed', message: error.message, pageErrors: errors, syntheticDataOnly: true }, null, 2));
    for (const [index, page] of browser.contexts().flatMap(context => context.pages()).entries()) {
      await page.screenshot({ path: path.join(output, `failure-${index}.png`) }).catch(() => {});
      console.error('QA visible state', await page.locator('main').innerText().catch(() => 'No main'));
    }
    throw error;
  } finally { await browser.close(); }
}
module.exports = { runInstitutionalContextBrowser };
