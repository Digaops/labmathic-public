const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-class-assessments-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'class-assessment-tests-only-secret-with-safe-length';
process.env.CLASS_ENTRY_CODE_SECRET = 'class-assessment-entry-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const classAssessmentsRouter = require('../src/routes/classAssessments');

const app = express();
app.use(express.json());
app.use('/api/classes', classAssessmentsRouter);
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
let adminToken;
let schoolClass;
let otherClass;
let studentOne;
let studentTwo;
let otherStudent;
let ownQuestionSetId;
let publicQuestionSetId;
let otherPrivateQuestionSetId;
let pendingDiagnosticSetId;
let reviewedDiagnosticSetId;
let officialQuestionId;
let ownTeacherQuestionId;
let createdAssessment;

function uuid() {
  return crypto.randomUUID();
}

function insertUser(name, email, role) {
  const result = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-de-teste', ?)
  `).run(name, email, role);
  return { id: result.lastInsertRowid, name, email, role };
}

function tokenFor(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function enableFlagForUser(flagKey, user) {
  const flag = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = ?
  `).get(flagKey);
  db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(flag.id);
  db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Piloto automatizado de aplicação', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

function insertClass(owner, gradeId, name) {
  const publicId = uuid();
  const result = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 2026, ?, ?)
  `).run(publicId, owner.id, name, gradeId, owner.id, owner.id);
  return { id: result.lastInsertRowid, publicId };
}

function insertStudent(owner, schoolClassRow, displayName, reference) {
  const publicId = uuid();
  const studentResult = db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(publicId, owner.id, displayName, reference, owner.id, owner.id);
  const enrollmentResult = db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?)
  `).run(
    schoolClassRow.id,
    studentResult.lastInsertRowid,
    owner.id,
    owner.id,
    owner.id
  );
  return {
    id: studentResult.lastInsertRowid,
    publicId,
    enrollmentId: enrollmentResult.lastInsertRowid,
  };
}

function insertQuestion({ skillId, code, source = 'official', createdBy = null, complete = true }) {
  const result = db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, support_text, image_path,
      development_space, difficulty, question_type, official_explanation,
      status, reviewed, created_by, source
    ) VALUES (?, ?, ?, 'Texto de apoio', '/uploads/apoio.png',
      'small', 'media', 'multiple_choice', 'Explicação', 'active', 1, ?, ?)
  `).run(code, skillId, `Enunciado original ${code}`, createdBy, source);
  const questionId = result.lastInsertRowid;
  const labels = complete ? ['A', 'B', 'C', 'D'] : ['A', 'B', 'C'];
  labels.forEach((label, index) => {
    db.prepare(`
      INSERT INTO question_options (
        question_id, option_label, option_text, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `).run(questionId, label, `Alternativa ${label}`, label === 'B' ? 1 : 0, index);
  });
  return questionId;
}

function insertQuestionSet(owner, title, questionIds, { isPublic = false, containsAuthor = false } = {}) {
  const result = db.prepare(`
    INSERT INTO question_sets (
      user_id, title, description, is_public, contains_author_questions
    ) VALUES (?, ?, 'Descrição do simulado', ?, ?)
  `).run(owner.id, title, isPublic ? 1 : 0, containsAuthor ? 1 : 0);
  questionIds.forEach((questionId, index) => {
    db.prepare(`
      INSERT INTO question_set_items (question_set_id, question_id, sort_order, show_image)
      VALUES (?, ?, ?, ?)
    `).run(result.lastInsertRowid, questionId, index, index === 0 ? 1 : 0);
  });
  return result.lastInsertRowid;
}

function insertDiagnosticQuestionSet(owner, title, questionIds, gradeId, skillId, reviewed = false) {
  const questionSetId = insertQuestionSet(owner, title, questionIds, { containsAuthor: true });
  db.prepare(`
    INSERT INTO diagnostic_question_sets (
      question_set_id, owner_teacher_id, grade_id,
      questions_per_skill, total_questions
    ) VALUES (?, ?, ?, 2, 2)
  `).run(questionSetId, owner.id, gradeId);
  db.prepare(`
    INSERT INTO diagnostic_question_set_skills (
      question_set_id, owner_teacher_id, grade_id, skill_id,
      requested_count, selected_count, easy_count, medium_count,
      difficult_count, candidate_count
    ) VALUES (?, ?, ?, ?, 2, 2, 0, 2, 0, 2)
  `).run(questionSetId, owner.id, gradeId, skillId);
  if (reviewed) {
    db.prepare(`
      INSERT INTO diagnostic_question_set_reviews (
        question_set_id, owner_teacher_id, reviewed_by
      ) VALUES (?, ?, ?)
    `).run(questionSetId, owner.id, owner.id);
  }
  return questionSetId;
}

async function request(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body;
  if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body,
  });
  return { status: response.status, payload: await response.json() };
}

test.before(async () => {
  admin = insertUser('Admin Teste', 'admin-aplicacoes@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-aplicacoes@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-aplicacoes@teste.local', 'professor');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);
  adminToken = tokenFor(admin);

  const gradeId = db.prepare("INSERT INTO grades (name, sort_order) VALUES ('8º Ano - EF', 8)")
    .run().lastInsertRowid;
  const unitId = db.prepare("INSERT INTO bncc_units (name, sort_order) VALUES ('Números', 1)")
    .run().lastInsertRowid;
  const skillId = db.prepare(`
    INSERT INTO bncc_skills (code, description, grade_id, unit_id)
    VALUES ('EF08MA01', 'Habilidade de teste', ?, ?)
  `).run(gradeId, unitId).lastInsertRowid;

  schoolClass = insertClass(professor, gradeId, '8º A — Matemática');
  otherClass = insertClass(otherProfessor, gradeId, '8º B — Matemática');
  studentOne = insertStudent(professor, schoolClass, 'Estudante Um', 'APP-001');
  studentTwo = insertStudent(professor, schoolClass, 'Estudante Dois', 'APP-002');
  otherStudent = insertStudent(otherProfessor, otherClass, 'Estudante Externo', 'APP-003');

  officialQuestionId = insertQuestion({ skillId, code: 'EF08MA01-Q001' });
  ownTeacherQuestionId = insertQuestion({
    skillId,
    code: 'EF08MA01-AUTORAL-001',
    source: 'teacher',
    createdBy: professor.id,
  });
  const otherTeacherQuestionId = insertQuestion({
    skillId,
    code: 'EF08MA01-AUTORAL-OUTRO',
    source: 'teacher',
    createdBy: otherProfessor.id,
  });

  ownQuestionSetId = insertQuestionSet(
    professor,
    'Simulado da professora',
    [officialQuestionId, ownTeacherQuestionId],
    { containsAuthor: true }
  );
  publicQuestionSetId = insertQuestionSet(
    otherProfessor,
    'Simulado público oficial',
    [officialQuestionId],
    { isPublic: true }
  );
  otherPrivateQuestionSetId = insertQuestionSet(
    otherProfessor,
    'Simulado privado de outro professor',
    [otherTeacherQuestionId],
    { containsAuthor: true }
  );
  pendingDiagnosticSetId = insertDiagnosticQuestionSet(
    professor,
    'Diagnóstico ainda não revisado',
    [officialQuestionId, ownTeacherQuestionId],
    gradeId,
    skillId
  );
  reviewedDiagnosticSetId = insertDiagnosticQuestionSet(
    professor,
    'Diagnóstico revisado',
    [officialQuestionId, ownTeacherQuestionId],
    gradeId,
    skillId,
    true
  );

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

test('falha fechada pela flag e recusa perfil administrativo', async () => {
  const disabled = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: professorToken,
  });
  assert.equal(disabled.status, 404);
  assert.match(disabled.payload.error, /indisponível/i);

  enableFlagForUser('classes.assessment_assignments', professor);
  const missingCoreDependency = await request(
    `/api/classes/${schoolClass.publicId}/assessments`,
    { token: professorToken }
  );
  assert.equal(missingCoreDependency.status, 404);

  const adminResponse = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: adminToken,
  });
  assert.equal(adminResponse.status, 403);
});

test('bootstrap respeita visibilidade dos simulados e isolamento da turma', async () => {
  enableFlagForUser('classes.core', professor);
  enableFlagForUser('classes.core', otherProfessor);
  enableFlagForUser('classes.assessment_assignments', otherProfessor);

  const response = await request(`/api/classes/${schoolClass.publicId}/assessments/bootstrap`, {
    token: professorToken,
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.deepEqual(response.payload.participants.map((item) => item.id).sort(), [
    studentOne.publicId,
    studentTwo.publicId,
  ].sort());
  assert.deepEqual(response.payload.sources.map((item) => item.id).sort((a, b) => a - b), [
    ownQuestionSetId,
    publicQuestionSetId,
    reviewedDiagnosticSetId,
  ].sort((a, b) => a - b));
  assert.equal(response.payload.sources.some((item) => item.id === otherPrivateQuestionSetId), false);
  assert.equal(response.payload.sources.some((item) => item.id === pendingDiagnosticSetId), false);

  const isolated = await request(`/api/classes/${schoolClass.publicId}/assessments/bootstrap`, {
    token: otherProfessorToken,
  });
  assert.equal(isolated.status, 404);
});

test('diagnóstico pendente não pode ser aplicado nem por requisição direta', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count;
  const response = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: pendingDiagnosticSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(response.status, 409, JSON.stringify(response.payload));
  assert.match(response.payload.error, /confirme a revisão pedagógica/i);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count,
    before
  );
});

test('cria snapshot e participantes atomicamente sem depender de edições posteriores', async () => {
  const created = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: ownQuestionSetId,
      participantIds: [studentOne.publicId, studentTwo.publicId],
      instructions: 'Leia com atenção.\nRevise antes de finalizar.',
      opensAt: '2026-09-01T10:00:00.000Z',
      closesAt: '2026-09-02T10:00:00.000Z',
      timeLimitMinutes: 50,
      randomizeQuestions: true,
      randomizeOptions: false,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.status, 'draft');
  assert.equal(created.payload.questionCount, 2);
  assert.equal(created.payload.participantCount, 2);
  assert.equal(created.payload.items.length, 2);
  assert.match(created.payload.snapshotHash, /^[0-9a-f]{64}$/);
  assert.equal(created.payload.items[0].showImage, true);
  assert.equal(created.payload.items[1].showImage, false);
  assert.equal(created.payload.items[0].options.filter((item) => item.isCorrect).length, 1);
  assert.equal(created.payload.answerKey.balanced, true);

  const assignmentRow = db.prepare(`
    SELECT id, snapshot_hash FROM class_assessment_assignments WHERE public_id = ?
  `).get(created.payload.id);
  assert.ok(assignmentRow);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM class_assessment_items WHERE assignment_id = ?')
      .get(assignmentRow.id).count,
    2
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM class_assessment_item_options WHERE assignment_id = ?')
      .get(assignmentRow.id).count,
    8
  );

  db.prepare("UPDATE questions SET statement = 'Enunciado alterado depois' WHERE id = ?")
    .run(officialQuestionId);
  db.prepare("UPDATE question_options SET option_text = 'Alternativa alterada' WHERE question_id = ? AND option_label = 'A'")
    .run(officialQuestionId);
  const detail = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}`,
    { token: professorToken }
  );
  assert.equal(detail.status, 200);
  assert.match(detail.payload.items[0].statement, /Enunciado original/);
  assert.ok(detail.payload.items[0].options.some(({ text }) => text === 'Alternativa A'));
  assert.equal(detail.payload.snapshotHash, assignmentRow.snapshot_hash);

  const activity = db.prepare(`
    SELECT metadata_json FROM activity_log
    WHERE action = 'create_class_assessment'
    ORDER BY id DESC LIMIT 1
  `).get();
  assert.ok(activity);
  assert.doesNotMatch(activity.metadata_json, /Estudante Um|Estudante Dois/);

  const list = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: professorToken,
  });
  assert.equal(list.status, 200);
  assert.equal(list.payload.length, 1);
  assert.equal(list.payload[0].participantCount, 2);

  createdAssessment = created.payload;
});

test('impede fontes e participantes de outro professor sem escrita parcial', async () => {
  const before = db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count;
  const privateSource = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: otherPrivateQuestionSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(privateSource.status, 404);

  const foreignParticipant = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: publicQuestionSetId,
      participantIds: [otherStudent.publicId],
    },
  });
  assert.equal(foreignParticipant.status, 400);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count,
    before
  );
});

test('entrega falha fechada e controla agendamento, abertura e encerramento', async () => {
  const deliveryCreated = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: publicQuestionSetId,
      participantIds: [studentOne.publicId, studentTwo.publicId],
    },
  });
  assert.equal(deliveryCreated.status, 201);
  const deliveryAssessmentId = deliveryCreated.payload.id;
  const current = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}`,
    { token: professorToken }
  );
  assert.equal(current.status, 200);

  const disabled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'open', expectedRevision: current.payload.revision },
    }
  );
  assert.equal(disabled.status, 404);
  enableFlagForUser('classes.assessment_delivery', professor);

  const pastSchedule = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        action: 'schedule',
        expectedRevision: current.payload.revision,
        opensAt: '2020-01-01T10:00:00.000Z',
      },
    }
  );
  assert.equal(pastSchedule.status, 400);

  const scheduled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        action: 'schedule',
        expectedRevision: current.payload.revision,
        opensAt: '2099-09-01T10:00:00.000Z',
        closesAt: '2099-09-02T10:00:00.000Z',
      },
    }
  );
  assert.equal(scheduled.status, 200, JSON.stringify(scheduled.payload));
  assert.equal(scheduled.payload.status, 'scheduled');
  assert.equal(scheduled.payload.revision, current.payload.revision + 1);
  assert.equal(scheduled.payload.openedAt, null);

  const stale = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'open', expectedRevision: current.payload.revision },
    }
  );
  assert.equal(stale.status, 409);

  const editScheduled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { expectedRevision: scheduled.payload.revision, instructions: 'Não alterar' },
    }
  );
  assert.equal(editScheduled.status, 409);

  const returned = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'return_to_draft', expectedRevision: scheduled.payload.revision },
    }
  );
  assert.equal(returned.status, 200);
  assert.equal(returned.payload.status, 'draft');

  const opened = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        action: 'open',
        expectedRevision: returned.payload.revision,
        closesAt: '2099-09-02T10:00:00.000Z',
      },
    }
  );
  assert.equal(opened.status, 200, JSON.stringify(opened.payload));
  assert.equal(opened.payload.status, 'open');
  assert.ok(opened.payload.openedAt);
  assert.equal(opened.payload.opensAt, opened.payload.openedAt);

  const frozenEdit = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { expectedRevision: opened.payload.revision, participantIds: [studentOne.publicId] },
    }
  );
  assert.equal(frozenEdit.status, 409);
  assert.throws(() => db.prepare(`
    UPDATE class_assessment_assignments SET title_snapshot = 'Alterado'
    WHERE public_id = ?
  `).run(deliveryAssessmentId), /published_assessment_snapshot_is_immutable/);

  const closed = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'close', expectedRevision: opened.payload.revision },
    }
  );
  assert.equal(closed.status, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.status, 'closed');
  assert.ok(closed.payload.closedAt);

  const reopen = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${deliveryAssessmentId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'open', expectedRevision: closed.payload.revision },
    }
  );
  assert.equal(reopen.status, 409);

  const activity = db.prepare(`
    SELECT action, metadata_json FROM activity_log
    WHERE entity_type = 'class_assessment'
      AND action IN (
        'schedule_class_assessment',
        'return_class_assessment_to_draft',
        'open_class_assessment',
        'close_class_assessment'
      )
    ORDER BY id
  `).all();
  assert.deepEqual(activity.map((item) => item.action), [
    'schedule_class_assessment',
    'return_class_assessment_to_draft',
    'open_class_assessment',
    'close_class_assessment',
  ]);
  assert.equal(activity.some((item) => /Estudante Um|Estudante Dois/.test(item.metadata_json)), false);
});

test('sincroniza abertura e encerramento por data e preserva isolamento', async () => {
  const created = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: publicQuestionSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(created.status, 201);
  const scheduled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        action: 'schedule',
        expectedRevision: created.payload.revision,
        opensAt: '2099-01-01T10:00:00.000Z',
        closesAt: '2099-01-02T10:00:00.000Z',
      },
    }
  );
  assert.equal(scheduled.status, 200);

  db.prepare(`
    UPDATE class_assessment_assignments
    SET opens_at = '2020-01-01T10:00:00.000Z',
        closes_at = '2099-01-02T10:00:00.000Z'
    WHERE public_id = ?
  `).run(created.payload.id);
  const deliveryFlagId = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'classes.assessment_delivery'
  `).get().id;
  db.prepare(`
    UPDATE feature_flags
    SET kill_switch_active = 1, kill_switch_reason = 'Ensaio de regressão',
        revision = revision + 1
    WHERE id = ?
  `).run(deliveryFlagId);
  const pausedList = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: professorToken,
  });
  assert.equal(pausedList.status, 200);
  assert.equal(
    pausedList.payload.find((item) => item.id === created.payload.id).status,
    'scheduled'
  );
  db.prepare(`
    UPDATE feature_flags
    SET kill_switch_active = 0, kill_switch_reason = NULL,
        revision = revision + 1
    WHERE id = ?
  `).run(deliveryFlagId);
  const list = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: professorToken,
  });
  assert.equal(list.status, 200);
  const autoOpened = list.payload.find((item) => item.id === created.payload.id);
  assert.equal(autoOpened.status, 'open');
  assert.equal(autoOpened.openedAt, '2020-01-01T10:00:00.000Z');

  db.prepare(`
    UPDATE class_assessment_assignments
    SET closes_at = '2020-01-02T10:00:00.000Z'
    WHERE public_id = ?
  `).run(created.payload.id);
  const detail = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}`,
    { token: professorToken }
  );
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.status, 'closed');
  assert.equal(detail.payload.closedAt, '2020-01-02T10:00:00.000Z');

  enableFlagForUser('classes.assessment_delivery', otherProfessor);
  const isolated = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: otherProfessorToken,
      body: { action: 'cancel', expectedRevision: detail.payload.revision },
    }
  );
  assert.equal(isolated.status, 404);
});

test('cancela aplicação agendada sem apagar o snapshot', async () => {
  const created = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: publicQuestionSetId,
      participantIds: [studentTwo.publicId],
    },
  });
  assert.equal(created.status, 201);
  const scheduled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        action: 'schedule',
        expectedRevision: created.payload.revision,
        opensAt: '2099-05-01T10:00:00.000Z',
      },
    }
  );
  assert.equal(scheduled.status, 200);
  const cancelled = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'cancel', expectedRevision: scheduled.payload.revision },
    }
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.payload.status, 'cancelled');
  assert.ok(cancelled.payload.cancelledAt);
  assert.equal(cancelled.payload.items.length, created.payload.items.length);
  assert.equal(cancelled.payload.snapshotHash, created.payload.snapshotHash);
});

test('permite interromper uma aplicação aberta mesmo com a turma arquivada', async () => {
  const created = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: publicQuestionSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(created.status, 201);
  const opened = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'open', expectedRevision: created.payload.revision },
    }
  );
  assert.equal(opened.status, 200);

  db.prepare(`
    UPDATE school_classes
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(schoolClass.id);
  const closed = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.payload.id}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { action: 'close', expectedRevision: opened.payload.revision },
    }
  );
  db.prepare(`
    UPDATE school_classes SET status = 'active', archived_at = NULL WHERE id = ?
  `).run(schoolClass.id);

  assert.equal(closed.status, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.status, 'closed');
});

test('edita somente rascunho com revisão otimista e lista ativa', async () => {
  const created = createdAssessment;
  assert.ok(created);
  const updated = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.id}`,
    {
      method: 'PATCH',
      token: professorToken,
      body: {
        expectedRevision: created.revision,
        participantIds: [studentTwo.publicId],
        instructions: 'Nova orientação',
        timeLimitMinutes: 60,
        randomizeOptions: true,
      },
    }
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.revision, created.revision + 1);
  assert.equal(updated.payload.participantCount, 1);
  assert.equal(updated.payload.participants[0].id, studentTwo.publicId);
  assert.equal(updated.payload.randomizeOptions, true);

  const stale = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.id}`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { expectedRevision: created.revision, instructions: 'Edição antiga' },
    }
  );
  assert.equal(stale.status, 409);

  db.prepare(`
    UPDATE school_classes
    SET status = 'archived', archived_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(schoolClass.id);
  const archived = await request(
    `/api/classes/${schoolClass.publicId}/assessments/${created.id}`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { expectedRevision: updated.payload.revision, instructions: 'Não deve salvar' },
    }
  );
  assert.equal(archived.status, 409);
  db.prepare(`
    UPDATE school_classes SET status = 'active', archived_at = NULL WHERE id = ?
  `).run(schoolClass.id);
});

test('recusa questão incompleta e preserva a atomicidade', async () => {
  const skillId = db.prepare("SELECT id FROM bncc_skills WHERE code = 'EF08MA01'").get().id;
  const incompleteQuestionId = insertQuestion({
    skillId,
    code: 'EF08MA01-INCOMPLETA',
    complete: false,
  });
  const incompleteSetId = insertQuestionSet(
    professor,
    'Simulado incompleto',
    [incompleteQuestionId]
  );
  const before = db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count;
  const response = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: incompleteSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(response.status, 400);
  assert.match(response.payload.error, /não está pronta/i);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM class_assessment_assignments').get().count,
    before
  );
});

async function rosterFixture() {
  const grade = db.prepare('SELECT grade_id FROM school_classes WHERE id=?').pluck().get(schoolClass.id);
  const group = insertClass(professor, grade, `Matrículas ${uuid()}`);
  const one = insertStudent(professor, group, 'Participante ativo', uuid());
  const two = insertStudent(professor, group, 'Participante a revisar', uuid());
  const path = `/api/classes/${group.publicId}/assessments`;
  const created = await request(path, { method: 'POST', token: professorToken, body: { sourceQuestionSetId: publicQuestionSetId, participantIds: [one.publicId, two.publicId] } });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  const entry = db.prepare('SELECT * FROM class_assessment_assignments WHERE public_id=?').get(created.payload.id);
  return { group, one, two, path: `${path}/${created.payload.id}`, listPath: path, entry, payload: created.payload };
}
function withdrawRosterStudent(student) {
  db.prepare("UPDATE school_class_enrollments SET status='withdrawn', ended_at=CURRENT_TIMESTAMP, revision=revision+1 WHERE id=?").run(student.enrollmentId);
}

test('matrículas: edição preserva inativo, IDs retidos e retirada explícita auditada', async () => {
  const f = await rosterFixture();
  const before = db.prepare('SELECT * FROM class_assessment_participants WHERE assignment_id=? ORDER BY id').all(f.entry.id);
  withdrawRosterStudent(f.two);
  const detail = await request(f.path, { token: professorToken });
  assert.equal(detail.payload.participants.length, 2);
  const inactive = detail.payload.participants.find(p => p.id === f.two.publicId);
  assert.equal(inactive.eligible, false); assert.equal(inactive.canRemove, true);
  assert.deepEqual(detail.payload.roster, { eligibleCount: 1, ineligibleCount: 1, exemptedCount: 0 });
  const { parseSavedRoster } = await import('../../client/src/services/assessmentRoster.mjs');
  parseSavedRoster(detail.payload.participants);
  const metadataOnly = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: detail.payload.revision, instructions: 'Guardar antes de revisar a matrícula.' } });
  assert.equal(metadataOnly.status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM class_assessment_participants WHERE assignment_id=? ORDER BY id').all(f.entry.id), before);
  const removed = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: metadataOnly.payload.revision, participantIds: [f.one.publicId] } });
  assert.equal(removed.status, 200); assert.equal(removed.payload.participantCount, 1);
  assert.deepEqual(db.prepare('SELECT * FROM class_assessment_participants WHERE assignment_id=?').get(f.entry.id), before.find(p => p.student_id === f.one.id));
  assert.ok(db.prepare('SELECT 1 FROM students WHERE id=?').get(f.two.id));
  assert.equal(db.prepare('SELECT status FROM school_class_enrollments WHERE id=?').pluck().get(f.two.enrollmentId), 'withdrawn');
  const audit = JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE entity_id=? AND action='update_class_assessment' ORDER BY id DESC LIMIT 1").pluck().get(f.entry.id));
  assert.deepEqual(audit.removed_participant_ids, [f.two.publicId]); assert.equal(audit.roster_changed, true);
  assert.equal(removed.payload.snapshotHash, f.payload.snapshotHash);
});

test('matrículas: conferência privada e leitura antiga não permitem abrir/agendar inativos', async () => {
  const f = await rosterFixture();
  const path = `${f.path}/readiness`;
  const { parseRosterReadiness } = await import('../../client/src/services/assessmentRoster.mjs');
  const check = await request(path, { token: professorToken });
  parseRosterReadiness(check.payload); assert.equal(check.payload.assignment.roster.ineligibleCount, 0);
  assert.equal((await request(path)).status, 401);
  assert.equal((await request(path, { token: otherProfessorToken })).status, 404);
  assert.equal((await request(path, { token: adminToken })).status, 403);
  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='classes.assessment_delivery'").run();
  try { assert.equal((await request(path, { token: professorToken })).status, 404); }
  finally { db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='classes.assessment_delivery'").run(); }
  // Membership changes after the UI received a successful preflight.
  withdrawRosterStudent(f.two);
  for (const action of ['open', 'schedule']) {
    const response = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action, expectedRevision: f.payload.revision, opensAt: '2099-09-15T12:00:00.000Z' } });
    assert.equal(response.status, 409); assert.match(response.payload.error, /matrículas/);
  }
  assert.equal(db.prepare('SELECT revision FROM class_assessment_assignments WHERE id=?').pluck().get(f.entry.id), f.payload.revision);
  db.prepare("UPDATE school_class_enrollments SET status='active', ended_at=NULL WHERE id=?").run(f.two.enrollmentId);
  db.prepare("UPDATE students SET status='archived', archived_at=CURRENT_TIMESTAMP WHERE id=?").run(f.two.id);
  const archived = await request(path, { token: professorToken });
  assert.equal(archived.payload.participants.find(p => p.id === f.two.publicId).studentStatus, 'archived');
  assert.equal((await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'open', expectedRevision: f.payload.revision } })).status, 409);
  assert.equal(db.prepare('SELECT status FROM class_assessment_assignments WHERE id=?').pluck().get(f.entry.id), 'draft');
});

test('matrículas: agendamento vencido aguarda regularização sem mudar participantes', async () => {
  const f = await rosterFixture();
  const scheduled = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'schedule', expectedRevision: f.payload.revision, opensAt: '2099-09-15T12:00:00.000Z' } });
  assert.equal(scheduled.status, 200);
  db.prepare("UPDATE class_assessment_assignments SET opens_at='2020-01-01T12:00:00.000Z' WHERE id=?").run(f.entry.id);
  withdrawRosterStudent(f.two);
  const held = await request(f.listPath, { token: professorToken });
  assert.equal(held.payload[0].status, 'scheduled'); assert.equal(held.payload[0].participantCount, 2);
  assert.equal(held.payload[0].roster.ineligibleCount, 1);
  const returned = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'return_to_draft', expectedRevision: scheduled.payload.revision } });
  assert.equal(returned.status, 200); assert.equal(returned.payload.status, 'draft');
  assert.equal(returned.payload.participantCount, 2);
});

test('matrículas: códigos anteriores são preservados e não se apaga todo o elenco ao editar', async () => {
  const f = await rosterFixture();
  const scheduled = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'schedule', expectedRevision: f.payload.revision, opensAt: '2099-09-15T12:00:00.000Z' } });
  assert.equal(scheduled.status, 200);
  const person = db.prepare('SELECT * FROM class_assessment_participants WHERE assignment_id=? AND student_id=?').get(f.entry.id, f.one.id);
  db.prepare(`INSERT INTO class_assessment_access_credentials
    (public_id,participant_id,assignment_id,class_id,student_id,owner_teacher_id,code_digest,code_hint,issued_at,expires_at,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(), person.id, f.entry.id, f.group.id, f.one.id, professor.id, crypto.randomBytes(32).toString('hex'), 'ABCD', new Date().toISOString(), '2099-09-15T15:00:00.000Z', professor.id, professor.id);
  const returned = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'return_to_draft', expectedRevision: scheduled.payload.revision } });
  const locked = returned.payload.participants.find(p => p.id === f.one.publicId);
  assert.equal(locked.canRemove, false);
  const blocked = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: returned.payload.revision, participantIds: [f.two.publicId], instructions: 'Não deve salvar' } });
  assert.equal(blocked.status, 409); assert.match(blocked.payload.error, /histórico/);
  const saved = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: returned.payload.revision, participantIds: [f.one.publicId] } });
  assert.equal(saved.status, 200);
  assert.deepEqual(db.prepare('SELECT * FROM class_assessment_participants WHERE id=?').get(person.id), person);
  assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_access_credentials WHERE participant_id=?').pluck().get(person.id), 1);
});

test('matrículas: falha de auditoria reverte retirada e revisão do rascunho', async () => {
  const f = await rosterFixture();
  db.exec("CREATE TRIGGER fail_roster_audit BEFORE INSERT ON activity_log WHEN NEW.action='update_class_assessment' BEGIN SELECT RAISE(ABORT,'forced_audit_failure'); END");
  try {
    const response = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: f.payload.revision, participantIds: [f.one.publicId] } });
    assert.equal(response.status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_participants WHERE assignment_id=?').pluck().get(f.entry.id), 2);
    assert.equal(db.prepare('SELECT revision FROM class_assessment_assignments WHERE id=?').pluck().get(f.entry.id), f.payload.revision);
  } finally { db.exec('DROP TRIGGER fail_roster_audit'); }
});

test('dispensa exige flag e confirmação; preserva matrícula, participante, auditoria e revoga código', async () => {
  const f = await rosterFixture();
  const target = `${f.path}/participants/${f.one.publicId}/exemption`;
  const body = { expectedRevision: f.payload.revision, confirmation: 'DISPENSAR_ESTUDANTE', reason: 'enrollment_changed' };
  assert.equal((await request(target, { method: 'POST', token: professorToken, body })).status, 404);
  enableFlagForUser('classes.assessment_exemptions', professor);
  enableFlagForUser('classes.assessment_exemptions', otherProfessor);
  assert.equal((await request(target, { method: 'POST', body })).status, 401);
  assert.equal((await request(target, { method: 'POST', token: otherProfessorToken, body })).status, 404);
  assert.equal((await request(target, { method: 'POST', token: adminToken, body })).status, 403);
  assert.equal((await request(target, { method: 'POST', token: professorToken, body: { ...body, confirmation: '' } })).status, 400);
  const scheduled = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'schedule', expectedRevision: body.expectedRevision, opensAt: '2099-09-15T12:00:00.000Z' } });
  assert.equal(scheduled.status, 200);
  const person = db.prepare('SELECT * FROM class_assessment_participants WHERE assignment_id=? AND student_id=?').get(f.entry.id, f.one.id);
  db.prepare(`INSERT INTO class_assessment_access_credentials
    (public_id,participant_id,assignment_id,class_id,student_id,owner_teacher_id,code_digest,code_hint,issued_at,expires_at,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(uuid(), person.id, f.entry.id, f.group.id, f.one.id, professor.id, crypto.randomBytes(32).toString('hex'), 'ABCD', new Date().toISOString(), '2099-09-15T15:00:00.000Z', professor.id, professor.id);
  assert.equal((await request(target, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: scheduled.payload.revision } })).status, 409);
  const returned = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'return_to_draft', expectedRevision: scheduled.payload.revision } });
  withdrawRosterStudent(f.one);
  const enrollment = db.prepare('SELECT * FROM school_class_enrollments WHERE id=?').get(f.one.enrollmentId);
  const credentials = db.prepare('SELECT * FROM class_assessment_access_credentials WHERE participant_id=?').get(person.id);
  const exempt = await request(target, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: returned.payload.revision } });
  assert.equal(exempt.status, 200, JSON.stringify(exempt.payload));
  assert.deepEqual(exempt.payload.roster, { eligibleCount: 1, ineligibleCount: 0, exemptedCount: 1 });
  assert.equal(exempt.payload.participantCount, 2);
  const after = db.prepare('SELECT * FROM class_assessment_access_credentials WHERE id=?').get(credentials.id);
  assert.equal(after.status, 'revoked'); assert.equal(after.code_digest, credentials.code_digest); assert.ok(after.revoked_at);
  assert.deepEqual(db.prepare('SELECT * FROM school_class_enrollments WHERE id=?').get(f.one.enrollmentId), enrollment);
  assert.equal(db.prepare('SELECT status FROM class_assessment_participants WHERE id=?').pluck().get(person.id), 'exempted');
  const audit = db.prepare("SELECT metadata_json FROM activity_log WHERE action='exempt_class_assessment_participant' AND entity_id=?").pluck().get(f.entry.id);
  assert.equal(JSON.parse(audit).revoked_access_count, 1); assert.ok(!audit.includes(credentials.code_digest));
  assert.equal((await request(target, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: exempt.payload.revision } })).status, 409);
  assert.equal((await request(`${f.path}/participants/${f.two.publicId}/exemption`, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: exempt.payload.revision } })).status, 409);
  const edit = await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: exempt.payload.revision, participantIds: [f.two.publicId], instructions: 'Preservar dispensa' } });
  assert.equal(edit.status, 200); assert.equal(edit.payload.participants.length, 2);
  assert.equal((await request(f.path, { method: 'PATCH', token: professorToken, body: { expectedRevision: edit.payload.revision, participantIds: [f.one.publicId, f.two.publicId] } })).status, 409);
  const opened = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'open', expectedRevision: edit.payload.revision } });
  assert.equal(opened.status, 200);
  const analysis = require('../src/services/classAssessmentAnalysis').analyzeClassAssessment(db, { ...f.entry, class_name: 'Sintética' });
  assert.equal(analysis.overview.participantCount, 1); assert.equal(analysis.overview.exemptedCount, 1); assert.equal(analysis.overview.pendingCount, 1); assert.equal(analysis.overview.meanPercentage, null);
});

test('dispensa bloqueia tentativa anterior, revisão antiga e reverte tudo se auditoria falhar', async () => {
  const f = await rosterFixture();
  const target = `${f.path}/participants/${f.one.publicId}/exemption`;
  const body = { expectedRevision: f.payload.revision, confirmation: 'DISPENSAR_ESTUDANTE', reason: 'selection_correction' };
  assert.equal((await request(target, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: body.expectedRevision + 1 } })).status, 409);
  db.exec("CREATE TRIGGER fail_exemption_audit BEFORE INSERT ON activity_log WHEN NEW.action='exempt_class_assessment_participant' BEGIN SELECT RAISE(ABORT,'forced_audit_failure'); END");
  try {
    assert.equal((await request(target, { method: 'POST', token: professorToken, body })).status, 500);
    assert.equal(db.prepare('SELECT revision FROM class_assessment_assignments WHERE id=?').pluck().get(f.entry.id), body.expectedRevision);
    assert.equal(db.prepare("SELECT COUNT(*) FROM class_assessment_participants WHERE assignment_id=? AND status='exempted'").pluck().get(f.entry.id), 0);
  } finally { db.exec('DROP TRIGGER fail_exemption_audit'); }
  const participant = db.prepare('SELECT id FROM class_assessment_participants WHERE assignment_id=? AND student_id=?').get(f.entry.id, f.one.id);
  const opened = await request(`${f.path}/delivery`, { method: 'PATCH', token: professorToken, body: { action: 'open', expectedRevision: body.expectedRevision } });
  assert.equal(opened.status, 200);
  // Existing attempt identity, even without answers, must never be erased by exemption.
  db.prepare(`INSERT INTO class_assessment_attempts(public_id,participant_id,assignment_id,class_id,student_id,owner_teacher_id,question_count,created_by,updated_by)
    VALUES (?,?,?,?,?,?,?,?,?)`).run(uuid(), participant.id, f.entry.id, f.group.id, f.one.id, professor.id, f.entry.question_count, professor.id, professor.id);
  assert.equal((await request(target, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: opened.payload.revision } })).status, 409);
});

test('identifica aplicações diagnósticas no contrato entregue à interface', async () => {
  const created = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: reviewedDiagnosticSetId,
      participantIds: [studentOne.publicId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.isDiagnostic, true);

  const list = await request(`/api/classes/${schoolClass.publicId}/assessments`, {
    token: professorToken,
  });
  assert.equal(list.status, 200, JSON.stringify(list.payload));
  assert.equal(
    list.payload.find(({ id }) => id === created.payload.id)?.isDiagnostic,
    true
  );
});

test('quarentena curricular impede nova aplicação e preserva o snapshot de aplicação anterior', async () => {
  const skillId = db.prepare('SELECT skill_id FROM questions WHERE id=?').pluck().get(officialQuestionId);
  const held = insertQuestion({ skillId, code: 'QA-EM-CURADORIA' });
  const setId = insertQuestionSet(professor, 'Simulado anterior à curadoria', [held]);
  const endpoint = `/api/classes/${schoolClass.publicId}/assessments`;
  const submit = () => request(endpoint, { method: 'POST', token: professorToken,
    body: { sourceQuestionSetId: setId, participantIds: [studentOne.publicId] } });
  const created = await submit();
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  db.prepare(`INSERT INTO question_editorial_curation (question_id,batch_key,state,reason,content_sha256)
    VALUES (?, 'fixture', 'held', 'Divergência confirmada com a habilidade', ?)`).run(held, 'a'.repeat(64));

  const preparation = await request(`${endpoint}/sources/${setId}/preparation`, { token: professorToken });
  assert.equal(preparation.status, 409);
  assert.match(preparation.payload.error, /QA-EM-CURADORIA/);
  const denied = await submit();
  assert.equal(denied.status, 409);
  assert.match(denied.payload.error, /Substitua a questão no simulado/);
  const detail = await request(`${endpoint}/${created.payload.id}`, { token: professorToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.snapshotHash, created.payload.snapshotHash);
  assert.deepEqual(detail.payload.items, created.payload.items);
  assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_assignments WHERE source_question_set_id=?').pluck().get(setId), 1);
});
