// Runner Chromium com API real e banco efêmero; inventário em docs/QA_AVALIACAO_RECUPERACAO_2026-09-08.md.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-student-online-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(tempDir, 'uploads');
fs.mkdirSync(process.env.UPLOAD_DIR);
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'student-visible.png'), 'synthetic visible image');
fs.writeFileSync(path.join(process.env.UPLOAD_DIR, 'student-hidden.png'), 'synthetic hidden image');
process.env.JWT_SECRET = 'student-online-tests-only-secret-with-safe-length';
process.env.STUDENT_ASSESSMENT_ACCESS_SECRET = 'student-online-access-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../../src/database');
const accessRouter = require('../../src/routes/classAssessmentStudentAccess');
const portalRouter = require('../../src/routes/studentAssessmentPortal');
const resultsRouter = require('../../src/routes/classAssessmentResults');
const assessmentsRouter = require('../../src/routes/classAssessments');

const root = path.resolve(__dirname, '../../..');
const { chromium } = require(path.join(root, 'client/node_modules/@playwright/test'));
const { expect } = require(path.join(root, 'client/node_modules/@playwright/test'));
const app = express();
app.use(express.json());
app.use('/api/classes', accessRouter);
app.use('/api/classes', resultsRouter);
app.use('/api/classes', assessmentsRouter);
app.use('/api/student-assessments', portalRouter);
app.use('/uploads', require('../../src/middleware/protectedUploads'));
app.use((error, _req, res, _next) => res.status(500).json({
  error: 'Erro interno no teste.',
  detail: error.message,
}));

let server;
let baseUrl;
let admin;
let professor;
let otherProfessor;
let professorToken;
let otherProfessorToken;
let classPublicId;
let assessmentPublicId;
let studentPublicIds;

function insertUser(name, email, role) {
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-de-teste', ?)
  `).run(name, email, role).lastInsertRowid);
  return { id, name, email, role };
}

function tokenFor(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function enableFlagForUser(flagKey, user) {
  const flag = db.prepare('SELECT id FROM feature_flags WHERE flag_key = ?').get(flagKey);
  db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(flag.id);
  db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Teste automatizado do portal do estudante', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

async function request(urlPath, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, headers: response.headers, payload: await response.json() };
}

function accessPath(suffix = '') {
  return `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/student-access${suffix}`;
}


async function seed() {
  admin = insertUser('Admin', 'admin-online@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-online@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-online@teste.local', 'professor');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);

  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('6º Ano - EF', 6)")
    .run().lastInsertRowid);
  const disciplineId = Number(db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')")
    .run().lastInsertRowid);
  classPublicId = 'class-student-online-public-001';
  const classId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
    ) VALUES (?, ?, '6º A', ?, 2026, ?, ?)
  `).run(classPublicId, professor.id, gradeId, professor.id, professor.id).lastInsertRowid);
  db.prepare(`
    INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by)
    VALUES (?, ?, ?, ?)
  `).run(classId, professor.id, disciplineId, professor.id);

  studentPublicIds = [
    'student-online-public-0001',
    'student-online-public-0002',
    'student-online-public-0003',
  ];
  const participantRows = studentPublicIds.map((publicId, index) => {
    const studentId = Number(db.prepare(`
      INSERT INTO students (
        public_id, owner_teacher_id, display_name, external_reference, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      publicId,
      professor.id,
      ['Ana Estudante', 'Beto Estudante', 'Carla Estudante'][index],
      `ONLINE-${index + 1}`,
      professor.id,
      professor.id
    ).lastInsertRowid);
    const enrollmentId = Number(db.prepare(`
      INSERT INTO school_class_enrollments (
        class_id, student_id, owner_teacher_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?)
    `).run(classId, studentId, professor.id, professor.id, professor.id).lastInsertRowid);
    return { studentId, enrollmentId };
  });

  assessmentPublicId = 'assessment-student-online-0001';
  const assignmentId = Number(db.prepare(`
    INSERT INTO class_assessment_assignments (
      public_id, class_id, owner_teacher_id, title_snapshot, instructions,
      snapshot_hash, question_count, status, randomize_questions,
      randomize_options, created_by, updated_by
    ) VALUES (?, ?, ?, 'Avaliação on-line', 'Leia antes de responder.', ?, 2,
      'draft', 1, 1, ?, ?)
  `).run(
    assessmentPublicId,
    classId,
    professor.id,
    'f'.repeat(64),
    professor.id,
    professor.id
  ).lastInsertRowid);

  for (let itemIndex = 0; itemIndex < 2; itemIndex += 1) {
    const itemId = Number(db.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id,
        question_code_snapshot, statement_snapshot,
        difficulty_snapshot, sort_order, image_path_snapshot, show_image
      ) VALUES (?, ?, ?, ?, ?, 'media', ?, ?, ?)
    `).run(
      assignmentId,
      classId,
      professor.id,
      `ONLINE-Q00${itemIndex + 1}`,
      `Enunciado ${itemIndex + 1}`,
      itemIndex,
      itemIndex === 0 ? 'student-visible.png' : 'student-hidden.png',
      0
    ).lastInsertRowid);
    ['A', 'B', 'C', 'D'].forEach((label, optionIndex) => {
      db.prepare(`
        INSERT INTO class_assessment_item_options (
          assessment_item_id, assignment_id, class_id, owner_teacher_id,
          option_label, option_text_snapshot, is_correct, sort_order
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        itemId,
        assignmentId,
        classId,
        professor.id,
        label,
        `Questão ${itemIndex + 1} - alternativa ${label}`,
        label === 'B' ? 1 : 0,
        optionIndex
      );
    });
  }
  participantRows.forEach(({ studentId, enrollmentId }) => {
    db.prepare(`
      INSERT INTO class_assessment_participants (
        assignment_id, class_id, student_id, enrollment_id,
        owner_teacher_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId,
      classId,
      studentId,
      enrollmentId,
      professor.id,
      professor.id,
      professor.id
    );
  });
  db.prepare(`
    UPDATE class_assessment_assignments
    SET status = 'scheduled', opens_at = '2099-08-15T12:00:00.000Z',
        closes_at = '2099-08-15T13:00:00.000Z', revision = revision + 1,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(assignmentId);

  for (const user of [professor, otherProfessor]) {
    for (const flag of [
      'classes.core',
      'classes.assessment_assignments',
      'classes.assessment_delivery',
      'classes.assessment_results',
      'classes.student_assessment_portal',
    ]) enableFlagForUser(flag, user);
  }

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
}

const build = path.resolve(process.argv[2] || path.join(root, 'tmp/assessment-resilience-build'));
app.use(express.static(build));
app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
const output = path.join(root, 'tmp/assessment-resilience-qa');
fs.mkdirSync(output, { recursive: true });
const errors = []; const dimensions = [];
let browser;
async function capture(page, name) {
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.mouse.move(0, 0);
  await page.evaluate(() => Promise.all(document.getAnimations()
    .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
    .map((animation) => animation.finished.catch(() => {}))));
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth, header: document.querySelector('header')?.getBoundingClientRect().height,
    status: document.querySelector('[role="status"]')?.getBoundingClientRect().toJSON() }));
  assert.ok(size.scrollWidth <= size.width, name + ': horizontal overflow');
  if (size.status) assert.ok(size.status.y >= 0 && size.status.bottom <= size.height, name + ': status clipped');
  dimensions.push({ name, ...size });
  await page.screenshot({ path: path.join(output, name + '.png'), scale: 'css' });
}
async function enter(context, code) {
  const page = await context.newPage(); page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(baseUrl + '/responder');
  await page.getByLabel('Código individual de acesso').fill(code);
  await page.getByRole('button', { name: 'Entrar na avaliação' }).click();
  await expect(page.getByRole('radiogroup')).toBeVisible();
  return page;
}
const status = (page) => page.getByRole('status');
const confirmed = (page) => expect(status(page)).toContainText('Respostas salvas');
async function retry(page) { await page.getByRole('button', { name: /Conferir conexão e salvar|Conferir entrega/ }).click(); }
(async () => {
  try {
    await seed();
    const initial = await request(accessPath(), { token: professorToken });
    const configured = await request(accessPath(), { method: 'PATCH', token: professorToken,
      body: { expectedRevision: initial.payload.assessment.revision, enabled: false, resultMode: 'score_after_submit' } });
    assert.equal(configured.status, 200);
    const generated = await request(accessPath('/credentials'), { method: 'POST', token: professorToken,
      body: { expectedRevision: configured.payload.assessment.revision, confirmation: 'GERAR_ACESSOS' } });
    assert.equal(generated.status, 201);
    const codes = generated.payload.generated.map((entry) => entry.code);
    db.prepare("UPDATE class_assessment_assignments SET status='open', opens_at=NULL, closes_at=NULL, opened_at=?, revision=revision+1 WHERE public_id=?")
      .run(new Date().toISOString(), assessmentPublicId);
    browser = await chromium.launch({ headless: true });
    const ctx = await browser.newContext({ viewport: { width: 1024, height: 600 }, colorScheme: 'light' });
    const page = await enter(ctx, codes[0]);
    await capture(page, '01-desktop-inicial');
    await page.getByRole('radio').nth(0).click(); await confirmed(page);
    // A rede inteira cai: escolhas continuam disponíveis no documento já aberto.
    await ctx.setOffline(true);
    await page.getByRole('radio').nth(1).click();
    await expect(status(page)).toContainText(/Sem conexão|Não foi possível confirmar/);
    await expect(page.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    await capture(page, '02-pendente-desktop');
    await page.getByRole('button', { name: 'Próxima', exact: true }).click();
    await page.getByRole('radio').nth(0).click();
    await page.getByRole('button', { name: 'Anterior', exact: true }).click();
    await page.getByRole('button', { name: 'Ir para questão 2', exact: true }).click();
    // Conteúdo estático volta, mas a API ainda falha: retomada não inventa confirmação.
    await page.route('**/api/student-assessments/me', (route) => route.abort());
    await ctx.setOffline(false);
    page.once('dialog', (dialog) => dialog.accept());
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Retomar sua avaliação' })).toBeVisible();
    await expect(status(page)).toContainText(/Sem conexão|Não foi possível confirmar/);
    await capture(page, '03-retomada-api-indisponivel');
    await page.unroute('**/api/student-assessments/me'); await retry(page); await confirmed(page);
    await expect(page.getByRole('radio').nth(1)).toHaveAttribute('aria-checked', 'true');
    // Duas sessões do mesmo código alteram a mesma questão.
    const otherCtx = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    const other = await enter(otherCtx, codes[0]);
    await ctx.setOffline(true); await page.getByRole('radio').nth(0).click();
    await other.getByRole('radio').nth(2).click(); await confirmed(other);
    await ctx.setOffline(false);
    await expect(status(page)).toContainText('Há respostas diferentes');
    await capture(page, '04-conflito');
    await page.getByRole('button', { name: 'Manter minha escolha · 1', exact: true }).click(); await confirmed(page);
    await other.reload(); await confirmed(other);
    await ctx.setOffline(true); await page.getByRole('radio').nth(1).click();
    await other.getByRole('radio').nth(3).click(); await confirmed(other);
    await ctx.setOffline(false);
    await expect(status(page)).toContainText('Há respostas diferentes');
    await page.getByRole('button', { name: 'Usar resposta já salva · 1', exact: true }).click(); await confirmed(page);
    await expect(page.getByRole('radio').nth(3)).toHaveAttribute('aria-checked', 'true');
    await otherCtx.close();
    // Servidor efetivou PUT mas a confirmação foi perdida.
    let writes = 0;
    await page.route('**/api/student-assessments/responses', async (route) => { writes++; await route.fetch(); await route.abort(); });
    await page.getByRole('radio').nth(0).click();
    await expect(status(page)).toContainText(/Sem conexão|Não foi possível confirmar/);
    await page.unroute('**/api/student-assessments/responses');
    await retry(page); await confirmed(page); assert.equal(writes, 1);
    // Continua escolhendo com PUT em andamento.
    let release; let started;
    const start = new Promise((resolve) => { started = resolve; });
    const gate = new Promise((resolve) => { release = resolve; });
    await page.route('**/api/student-assessments/responses', async (route) => { started(); await gate; await route.continue(); });
    await page.getByRole('radio').nth(1).click(); await start;
    await page.getByRole('radio').nth(2).click();
    await page.getByRole('button', { name: 'Próxima', exact: true }).click();
    await page.getByRole('radio').nth(1).click();
    release(); await confirmed(page); await page.unroute('**/api/student-assessments/responses');
    await page.getByRole('button', { name: 'Anterior', exact: true }).click();
    await expect(page.getByRole('radio').nth(2)).toHaveAttribute('aria-checked', 'true');
    // Exploração curta por controles reais: alternar questões, escolhas e teclado fora da sequência principal.
    const explorationUntil = Date.now() + 30000;
    let explorationRounds = 0;
    while (Date.now() < explorationUntil) {
      await page.getByRole('button', { name: 'Ir para questão ' + (explorationRounds % 2 + 1), exact: true }).click();
      const alternative = page.getByRole('radio', { checked: false }).nth(explorationRounds % 3);
      if (explorationRounds % 2) { await alternative.focus(); await page.keyboard.press('Space'); }
      else await alternative.click();
      await confirmed(page);
      assert.equal(await page.getByRole('radio', { checked: true }).count(), 1);
      explorationRounds++;
    }
    console.log('Exploração por clique/teclado: ' + explorationRounds + ' ciclos em pelo menos 30 segundos.');
    // Responsividade: documentos roláveis, cabeçalho compacto e status acima da questão.
    for (const [width, height, dark] of [[390,844,false], [390,844,true], [320,640,true], [1024,600,true]]) {
      await page.setViewportSize({ width, height });
      await page.evaluate((value) => localStorage.setItem('theme', value ? 'dark' : 'light'), dark);
      await page.reload(); await confirmed(page);
      assert.equal(await page.locator('html').evaluate((el) => el.classList.contains('dark')), dark);
      await capture(page, '05-layout-' + width + '-' + (dark ? 'dark' : 'light'));
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await ctx.setOffline(true); await page.getByRole('radio', { checked: false }).first().click();
    await expect(status(page)).toContainText(/Sem conexão|Não foi possível confirmar/);
    await expect(status(page)).toContainText('1 resposta aguardando confirmação');
    await expect(page.locator('article')).toContainText('Pendente');
    await capture(page, '06-mobile-pendente-dark');
    await ctx.setOffline(false); await confirmed(page);
    if (await page.getByRole('button', { name: /Ver todas as questões/ }).isVisible()) await page.getByRole('button', { name: /Ver todas as questões/ }).click();
    // Cancelar entrega é inofensivo; confirmação HTTP perdida não duplica submissão/auditoria.
    page.once('dialog', (dialog) => dialog.dismiss());
    await page.getByRole('button', { name: 'Entregar avaliação', exact: true }).click();
    assert.equal(db.prepare("SELECT COUNT(*) FROM class_assessment_attempts WHERE status='submitted'").pluck().get(), 0);
    let submits = 0;
    await page.route('**/api/student-assessments/submit', async (route) => { submits++; await route.fetch(); await route.abort(); });
    page.once('dialog', (dialog) => dialog.accept());
    await page.getByRole('button', { name: 'Entregar avaliação', exact: true }).click();
    await expect(status(page)).toContainText('Verificando a entrega');
    await capture(page, '07-entrega-incerta');
    await page.unroute('**/api/student-assessments/submit');
    await retry(page);
    await expect(page.getByRole('heading', { name: 'Avaliação entregue' })).toBeVisible();
    assert.equal(submits, 1);
    assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='submit_student_online_assessment'").pluck().get(), 1);
    await capture(page, '08-entrega-confirmada');
    await page.getByRole('button', { name: 'Sair deste dispositivo' }).click();
    await expect(page.getByLabel('Código individual de acesso')).toBeVisible();
    assert.equal(await page.evaluate(() => sessionStorage.getItem('labmathic.studentAssessmentDraft.v1')), null);
    await ctx.close();
    // Aluno B: prazo termina na ausência de rede, sem aceitar respostas locais atrasadas.
    const expiredCtx = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'dark' });
    const expired = await enter(expiredCtx, codes[1]);
    await expiredCtx.setOffline(true); await expired.getByRole('radio').nth(0).click();
    await expect(status(expired)).toContainText(/Sem conexão|Não foi possível confirmar/);
    db.prepare("UPDATE class_assessment_assignments SET time_limit_minutes=5 WHERE public_id=?").run(assessmentPublicId);
    db.prepare("UPDATE class_assessment_attempts SET started_at='2020-01-01T00:00:00.000Z' WHERE status='draft'").run();
    await expiredCtx.setOffline(false);
    await expect(expired.getByRole('heading', { name: 'Avaliação entregue' })).toBeVisible();
    await expect(status(expired)).toContainText('não foram incluídas');
    await capture(expired, '09-prazo-pendencia-nao-incluida');
    assert.equal(db.prepare("SELECT answered_count FROM class_assessment_attempts ORDER BY id DESC LIMIT 1").pluck().get(), 0);
    await expiredCtx.close();
    // Aluno C: falta de quota para cópia, sem impedir estado em memória.
    db.prepare("UPDATE class_assessment_assignments SET time_limit_minutes=NULL WHERE public_id=?").run(assessmentPublicId);
    const quotaCtx = await browser.newContext({ viewport: { width: 1024, height: 600 } });
    await quotaCtx.addInitScript(() => {
      const set = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key === 'labmathic.studentAssessmentDraft.v1') throw new DOMException('quota', 'QuotaExceededError');
        return set.call(this, key, value);
      };
    });
    const quota = await enter(quotaCtx, codes[2]);
    await quotaCtx.setOffline(true); await quota.getByRole('radio').nth(0).click();
    await expect(status(quota)).toContainText('não conseguiu guardar');
    await capture(quota, '10-quota-indisponivel');
    await quotaCtx.setOffline(false); await confirmed(quota);
    await quota.route('**/api/student-assessments/me', (route) => route.fulfill({ status: 429,
      headers: { 'Content-Type': 'application/json', 'Retry-After': '120' },
      body: JSON.stringify({ error: 'Muitas tentativas. Aguarde 120 segundos antes de tentar novamente.' }) }));
    await quota.getByRole('radio').nth(1).click();
    await expect(status(quota)).toContainText('Aguarde 120');
    await capture(quota, '11-limite-de-tentativas');
    await quotaCtx.close();
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(output, 'viewport-checks.json'), JSON.stringify(dimensions, null, 2));
    console.log('PASS: escolhas/rede/retomada/conflitos/ack perdido/gravação lenta/entrega única/prazo/quota/429 e layouts.');
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
