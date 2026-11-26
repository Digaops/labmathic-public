const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-lesson-planner-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'lesson-planner-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const lessonPlannerRouter = require('../src/routes/lessonPlanner');

const app = express();
app.use(express.json());
app.use('/api/lesson-plans', lessonPlannerRouter);

let server;
let baseUrl;
let admin;
let professor;
let otherProfessor;
let professorToken;
let otherProfessorToken;
let adminToken;
let gradeId;
let disciplineId;
let skillId;
let classPublicId;
let targetClassPublicId;
let questionId;
let materialId;
let questionSetId;
let plan;

function insertUser(name, email, role) {
  const id = db.prepare(`INSERT INTO users (name, email, password, role) VALUES (?, ?, 'hash', ?)`)
    .run(name, email, role).lastInsertRowid;
  return { id, name, email, role };
}

function tokenFor(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function enableFlag(user) {
  const flag = db.prepare("SELECT id FROM feature_flags WHERE flag_key = 'planning.lesson_planner'").get();
  db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(flag.id);
  db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Teste do planejador', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

async function request(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET', headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, payload: await response.json() };
}

function planBody(targetClass = classPublicId) {
  return {
    title: 'Semana de resolução de problemas',
    classPublicId: targetClass,
    disciplineId,
    periodType: 'week',
    startsOn: '2026-08-17',
    endsOn: '2026-08-21',
    lessons: [{
      title: 'Problemas com números naturais',
      objective: 'Resolver problemas por estratégias diversas e comparar os procedimentos.',
      teacherNotes: 'Retomar as estratégias levantadas no diagnóstico.',
      plannedDate: '2026-08-18',
      durationMinutes: 50,
      skillIds: [skillId],
      resources: [
        { type: 'material', id: materialId },
        { type: 'question', id: questionId },
        { type: 'question_set', id: questionSetId },
        { type: 'activity', title: 'Discussão de estratégias', notes: 'Socializar duas resoluções.' },
      ],
    }],
  };
}

test.before(async () => {
  admin = insertUser('Admin', 'admin-planejamento@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-planejamento@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-planejamento@teste.local', 'professor');
  adminToken = tokenFor(admin);
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);
  enableFlag(professor);
  enableFlag(otherProfessor);

  gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('6º Ano - EF', 6)").run().lastInsertRowid);
  disciplineId = Number(db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units (name, sort_order) VALUES ('Números para planejamento', 1)").run().lastInsertRowid);
  skillId = Number(db.prepare(`INSERT INTO bncc_skills (code, description, grade_id, unit_id) VALUES ('EF06MA01-PLAN', 'Comparar e resolver problemas com números naturais.', ?, ?)`)
    .run(gradeId, unitId).lastInsertRowid);

  classPublicId = 'class-planner-public-000001';
  targetClassPublicId = 'class-planner-public-000002';
  const classId = Number(db.prepare(`
    INSERT INTO school_classes (public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by)
    VALUES (?, ?, '6º Ano A', ?, 2026, ?, ?)
  `).run(classPublicId, professor.id, gradeId, professor.id, professor.id).lastInsertRowid);
  const targetClassId = Number(db.prepare(`
    INSERT INTO school_classes (public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by)
    VALUES (?, ?, '6º Ano B', ?, 2026, ?, ?)
  `).run(targetClassPublicId, professor.id, gradeId, professor.id, professor.id).lastInsertRowid);
  db.prepare(`INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by) VALUES (?, ?, ?, ?)`)
    .run(classId, professor.id, disciplineId, professor.id);
  db.prepare(`INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by) VALUES (?, ?, ?, ?)`)
    .run(targetClassId, professor.id, disciplineId, professor.id);

  materialId = Number(db.prepare(`INSERT INTO materials (title, grade_id, discipline_id, created_by) VALUES ('Trilha de problemas', ?, ?, ?)`)
    .run(gradeId, disciplineId, admin.id).lastInsertRowid);
  questionId = Number(db.prepare(`
    INSERT INTO questions (question_code, skill_id, statement, difficulty, status, reviewed, source)
    VALUES ('EF06MA01-PLAN-Q001', ?, 'Qual estratégia resolve o problema?', 'media', 'active', 1, 'official')
  `).run(skillId).lastInsertRowid);
  for (const [index, label] of ['A', 'B', 'C', 'D'].entries()) {
    db.prepare(`INSERT INTO question_options (question_id, option_label, option_text, is_correct, sort_order) VALUES (?, ?, ?, ?, ?)`)
      .run(questionId, label, `Alternativa ${label}`, index === 0 ? 1 : 0, index + 1);
  }
  questionSetId = Number(db.prepare(`INSERT INTO question_sets (user_id, title, is_public) VALUES (?, 'Simulado de estratégias', 0)`)
    .run(professor.id).lastInsertRowid);
  db.prepare(`INSERT INTO question_set_items (question_set_id, question_id, sort_order) VALUES (?, ?, 1)`)
    .run(questionSetId, questionId);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('falha fechada para administrador e apresenta somente turmas do professor', async () => {
  const adminResponse = await request('/api/lesson-plans/bootstrap', { token: adminToken });
  assert.equal(adminResponse.status, 403);

  const bootstrap = await request('/api/lesson-plans/bootstrap', { token: professorToken });
  assert.equal(bootstrap.status, 200, JSON.stringify(bootstrap.payload));
  assert.deepEqual(bootstrap.payload.classes.map((item) => item.publicId), [classPublicId, targetClassPublicId]);
  const otherBootstrap = await request('/api/lesson-plans/bootstrap', { token: otherProfessorToken });
  assert.deepEqual(otherBootstrap.payload.classes, []);
});

test('cria rascunho idempotente, preserva snapshots e isola autoria', async () => {
  const created = await request('/api/lesson-plans', {
    method: 'POST', token: professorToken,
    headers: { 'Idempotency-Key': 'create-plan-safe-key-001' }, body: planBody(),
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.plan.lessons.length, 1);
  assert.equal(created.payload.plan.lessons[0].skills[0].code, 'EF06MA01-PLAN');
  assert.equal(created.payload.plan.lessons[0].resources.length, 4);
  plan = created.payload.plan;

  db.prepare(`UPDATE school_classes SET updated_at = '2026-08-20 10:00:00' WHERE public_id = ?`)
    .run(classPublicId);
  const replay = await request('/api/lesson-plans', {
    method: 'POST', token: professorToken,
    headers: { 'Idempotency-Key': 'create-plan-safe-key-001' }, body: planBody(),
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.plan.publicId, plan.publicId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM teaching_plans WHERE owner_teacher_id = ?').pluck().get(professor.id), 1);

  const isolated = await request(`/api/lesson-plans/${plan.publicId}`, { token: otherProfessorToken });
  assert.equal(isolated.status, 404);
  assert.equal(db.prepare(`SELECT COUNT(*) FROM activity_log WHERE action = 'create_teaching_plan'`).pluck().get(), 1);
});

test('exige revisão otimista, confirmação explícita e conclui somente após registrar aulas', async () => {
  const stale = await request(`/api/lesson-plans/${plan.publicId}`, {
    method: 'PUT', token: professorToken, body: { ...planBody(), expectedRevision: plan.revision + 10 },
  });
  assert.equal(stale.status, 409);

  const withoutReview = await request(`/api/lesson-plans/${plan.publicId}/activate`, {
    method: 'POST', token: professorToken,
    body: { expectedRevision: plan.revision, reviewConfirmed: false },
  });
  assert.equal(withoutReview.status, 400);

  const activated = await request(`/api/lesson-plans/${plan.publicId}/activate`, {
    method: 'POST', token: professorToken,
    body: { expectedRevision: plan.revision, reviewConfirmed: true },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.payload));
  plan = activated.payload.plan;

  const premature = await request(`/api/lesson-plans/${plan.publicId}/complete`, {
    method: 'POST', token: professorToken, body: { expectedRevision: plan.revision },
  });
  assert.equal(premature.status, 409);

  const lesson = plan.lessons[0];
  const taught = await request(`/api/lesson-plans/${plan.publicId}/lessons/${lesson.publicId}`, {
    method: 'PATCH', token: professorToken,
    body: {
      expectedPlanRevision: plan.revision,
      expectedLessonRevision: lesson.revision,
      status: 'taught', teacherNotes: 'Os estudantes compararam duas estratégias.',
    },
  });
  assert.equal(taught.status, 200, JSON.stringify(taught.payload));
  plan = taught.payload.plan;
  assert.equal(plan.lessons[0].status, 'taught');

  const completed = await request(`/api/lesson-plans/${plan.publicId}/complete`, {
    method: 'POST', token: professorToken, body: { expectedRevision: plan.revision },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  plan = completed.payload.plan;
  assert.equal(plan.status, 'completed');
});

test('duplica para outra turma sem copiar observações privadas e impede dupla criação', async () => {
  const duplicated = await request(`/api/lesson-plans/${plan.publicId}/duplicate`, {
    method: 'POST', token: professorToken,
    headers: { 'Idempotency-Key': 'duplicate-plan-safe-key-001' },
    body: {
      classPublicId: targetClassPublicId,
      disciplineId,
      startsOn: '2026-09-01',
      title: 'Sequência reutilizada no 6º B',
      periodType: 'week',
    },
  });
  assert.equal(duplicated.status, 201, JSON.stringify(duplicated.payload));
  assert.equal(duplicated.payload.plan.status, 'draft');
  assert.equal(duplicated.payload.plan.class.publicId, targetClassPublicId);
  assert.equal(duplicated.payload.plan.lessons[0].teacherNotes, null);

  const replay = await request(`/api/lesson-plans/${plan.publicId}/duplicate`, {
    method: 'POST', token: professorToken,
    headers: { 'Idempotency-Key': 'duplicate-plan-safe-key-001' },
    body: {
      classPublicId: targetClassPublicId, disciplineId, startsOn: '2026-09-01',
      title: 'Sequência reutilizada no 6º B', periodType: 'week',
    },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.plan.publicId, duplicated.payload.plan.publicId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM teaching_plan_write_operations').pluck().get(), 2);
});

test('catálogo de planejamento deixa de sugerir recurso em curadoria e preserva vínculo já salvo', async () => {
  const create = key => request('/api/lesson-plans', {
    method: 'POST', token: professorToken, headers: { 'Idempotency-Key': key }, body: planBody(),
  });
  const original = await create('plan-antes-curadoria-01');
  assert.equal(original.status, 201, JSON.stringify(original.payload));
  const originalPlan = original.payload.plan;
  db.prepare(`INSERT INTO question_editorial_curation(question_id,batch_key,state,reason,content_sha256)
    VALUES (?,'fixture','held','Divergência de habilidade',?)`).run(questionId, 'a'.repeat(64));

  for (const category of ['questions', 'questionSets']) {
    const page = await request(`/api/lesson-plans/catalog/resources?skillIds=${skillId}&category=${category}`, { token: professorToken });
    assert.equal(page.status, 200, JSON.stringify(page.payload));
    assert.deepEqual(page.payload.items, []);
  }
  assert.equal((await create('plan-novo-com-questao-bloqueada')).status, 409);
  const replay = await create('plan-antes-curadoria-01');
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.plan.publicId, originalPlan.publicId);
  const edited = await request(`/api/lesson-plans/${originalPlan.publicId}`, {
    method: 'PUT', token: professorToken,
    body: { ...planBody(), title: 'Título atualizado sem trocar recursos', expectedRevision: originalPlan.revision },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.payload));
  assert.equal(edited.payload.plan.lessons[0].resources.some(resource => resource.questionId === questionId), true);
});
