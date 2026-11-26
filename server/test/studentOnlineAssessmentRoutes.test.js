const test = require('node:test');
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
const db = require('../src/database');
const accessRouter = require('../src/routes/classAssessmentStudentAccess');
const portalRouter = require('../src/routes/studentAssessmentPortal');
const resultsRouter = require('../src/routes/classAssessmentResults');
const assessmentsRouter = require('../src/routes/classAssessments');

const app = express();
app.use(express.json());
app.use('/api/classes', accessRouter);
app.use('/api/classes', resultsRouter);
app.use('/api/classes', assessmentsRouter);
app.use('/api/student-assessments', portalRouter);
app.use('/uploads', require('../src/middleware/protectedUploads'));
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
  const headers = { 'Content-Type': 'application/json', ...options.headers };
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

test.before(async () => {
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
      itemIndex === 0 ? 1 : 0
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
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

let firstCode;
let secondCode;
let thirdCode;
let studentSession;
let firstPortal;

test('professor configura resultado e gera códigos individuais exibidos somente uma vez', async () => {
  const initial = await request(accessPath(), { token: professorToken });
  assert.equal(initial.status, 200);
  assert.equal(initial.payload.assessment.studentAccessEnabled, false);

  const configured = await request(accessPath(), {
    method: 'PATCH',
    token: professorToken,
    body: {
      expectedRevision: initial.payload.assessment.revision,
      enabled: false,
      resultMode: 'score_after_submit',
    },
  });
  assert.equal(configured.status, 200, JSON.stringify(configured.payload));

  const generated = await request(accessPath('/credentials'), {
    method: 'POST',
    token: professorToken,
    body: {
      expectedRevision: configured.payload.assessment.revision,
      confirmation: 'GERAR_ACESSOS',
    },
  });
  assert.equal(generated.status, 201, JSON.stringify(generated.payload));
  assert.equal(generated.payload.generated.length, 3);
  [firstCode, secondCode, thirdCode] = generated.payload.generated.map(({ code }) => code);
  assert.match(firstCode, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);
  assert.notEqual(firstCode, secondCode);
  assert.equal(generated.payload.access.assessment.studentAccessEnabled, true);

  const stored = db.prepare(`
    SELECT code_digest, code_hint FROM class_assessment_access_credentials ORDER BY id
  `).all();
  assert.equal(stored.length, 3);
  assert.equal(stored.some(({ code_digest: digest }) => digest.includes(firstCode.replaceAll('-', ''))), false);
  assert.equal(db.pragma('table_info(class_assessment_access_credentials)').some(({ name }) => name === 'code'), false);

  const refreshed = await request(accessPath(), { token: professorToken });
  assert.equal(JSON.stringify(refreshed.payload).includes(firstCode), false);
  assert.equal(refreshed.payload.summary.activeCredentialCount, 3);

  const hiddenFromOtherTeacher = await request(accessPath(), { token: otherProfessorToken });
  assert.equal(hiddenFromOtherTeacher.status, 404);
});

test('portal não abre agendamento vencido com matrícula retirada e preserva acessos', async () => {
  const entry = db.prepare('SELECT * FROM class_assessment_assignments WHERE public_id=?').get(assessmentPublicId);
  const enrollment = db.prepare('SELECT * FROM school_class_enrollments WHERE class_id=? ORDER BY id DESC LIMIT 1').get(entry.class_id);
  const credentials = db.prepare('SELECT * FROM class_assessment_access_credentials ORDER BY id').all();
  db.prepare("UPDATE class_assessment_assignments SET opens_at='2020-01-01T12:00:00.000Z' WHERE id=?").run(entry.id);
  db.prepare("UPDATE school_class_enrollments SET status='withdrawn',ended_at=CURRENT_TIMESTAMP WHERE id=?").run(enrollment.id);
  try {
    const blocked = await request('/api/student-assessments/session', { method: 'POST', body: { code: firstCode } });
    assert.equal(blocked.status, 423); assert.match(blocked.payload.error, /conferência do professor/);
    assert.equal(db.prepare('SELECT status FROM class_assessment_assignments WHERE id=?').pluck().get(entry.id), 'scheduled');
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_attempts WHERE assignment_id=?').pluck().get(entry.id), 0);
    assert.deepEqual(db.prepare('SELECT * FROM class_assessment_access_credentials ORDER BY id').all(), credentials);
    assert.doesNotMatch(blocked.payload.error, /Ana Estudante|Bruno Estudante/);
  } finally {
    db.prepare('UPDATE class_assessment_assignments SET opens_at=? WHERE id=?').run(entry.opens_at, entry.id);
    db.prepare('UPDATE school_class_enrollments SET status=?,ended_at=? WHERE id=?').run(enrollment.status, enrollment.ended_at, enrollment.id);
  }
});

test('portal bloqueia participante dispensado mesmo se uma credencial antiga estiver ativa', async () => {
  db.exec('SAVEPOINT exemption_portal_test');
  try {
    db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP").run();
    const blocked = await request('/api/student-assessments/session', { method: 'POST', body: { code: firstCode } });
    assert.equal(blocked.status, 401);
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_attempts').pluck().get(), 0);
  } finally { db.exec('ROLLBACK TO exemption_portal_test; RELEASE exemption_portal_test'); }
});

test('portal respeita agendamento, rejeita código inválido e inicia tentativa on-line', async () => {
  const invalid = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD' },
  });
  assert.equal(invalid.status, 401);

  const early = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: firstCode },
  });
  assert.equal(early.status, 423);
  assert.equal(early.payload.opensAt, '2099-08-15T12:00:00.000Z');

  db.prepare(`
    UPDATE class_assessment_assignments
    SET status = 'open', opens_at = '2026-08-15T10:00:00.000Z',
        closes_at = '2099-08-15T13:00:00.000Z', opened_at = '2026-08-15T10:00:00.000Z',
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE public_id = ?
  `).run(assessmentPublicId);

  const opened = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: firstCode },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.payload));
  studentSession = opened.payload.token;
  firstPortal = opened.payload.portal;
  assert.equal(firstPortal.student.displayName, 'Ana Estudante');
  assert.equal(firstPortal.attempt.status, 'draft');
  assert.equal(firstPortal.items.length, 2);
  const correctDisplayLabels = firstPortal.items.map((item) => (
    item.options.find(({ text }) => text.endsWith('B')).label
  ));
  assert.equal(new Set(correctDisplayLabels).size, 2);
  assert.equal(JSON.stringify(firstPortal).includes('isCorrect'), false);
  assert.equal(JSON.stringify(firstPortal).includes('correctOption'), false);
  assert.equal(
    db.prepare(`
      SELECT submission_channel FROM class_assessment_attempts
      WHERE participant_id = (
        SELECT id FROM class_assessment_participants
        WHERE student_id = (SELECT id FROM students WHERE public_id = ?)
      )
    `).pluck().get(studentPublicIds[0]),
    'student_online'
  );
});

test('mídia do estudante respeita imagem visível, dono, feature flag e saída do dispositivo', async () => {
  const cookie = `labmathic_student_media=${studentSession}`;
  async function imageStatus(name, headers = {}) {
    const response = await fetch(`${baseUrl}/uploads/${name}`, { headers });
    await response.arrayBuffer();
    return response.status;
  }
  assert.equal(await imageStatus('student-visible.png'), 404);
  assert.equal(await imageStatus('student-visible.png', { Cookie: cookie }), 200);
  assert.equal(await imageStatus('student-hidden.png', { Cookie: cookie }), 404);
  assert.equal(await imageStatus('student-visible.png', { Authorization: `Bearer ${otherProfessorToken}` }), 404);
  assert.equal(await imageStatus('student-visible.png', { Authorization: `Bearer ${professorToken}` }), 200);
  db.prepare("UPDATE feature_flags SET kill_switch_active = 1, kill_switch_reason = 'Teste sintético de mídia' WHERE flag_key = 'classes.student_assessment_portal'").run();
  try { assert.equal(await imageStatus('student-visible.png', { Cookie: cookie }), 404); }
  finally { db.prepare("UPDATE feature_flags SET kill_switch_active = 0 WHERE flag_key = 'classes.student_assessment_portal'").run(); }
  const logout = await fetch(`${baseUrl}/api/student-assessments/logout`, {
    method: 'POST', headers: { Authorization: `Bearer ${studentSession}` },
  });
  assert.equal(logout.status, 204);
  assert.match(logout.headers.get('set-cookie'), /labmathic_student_media=;/);
  assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
});

test('estudante salva, servidor corrige pelo snapshot e resultado entra no painel da turma', async () => {
  const responses = firstPortal.items.map((item, index) => ({
    itemId: item.id,
    optionId: item.options.find(({ text }) => text.endsWith(index === 0 ? 'B' : 'C')).id,
  }));
  const tampered = await request('/api/student-assessments/responses', {
    method: 'PUT',
    token: studentSession,
    body: {
      expectedRevision: firstPortal.attempt.revision,
      responses: responses.map((entry, index) => index === 0 ? { ...entry, optionId: 'token-forjado' } : entry),
    },
  });
  assert.equal(tampered.status, 400);

  const saved = await request('/api/student-assessments/responses', {
    method: 'PUT',
    token: studentSession,
    body: { expectedRevision: firstPortal.attempt.revision, responses },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.attempt.answeredCount, 2);
  assert.equal(saved.payload.attempt.revision, firstPortal.attempt.revision + 1);
  assert.equal(saved.payload.attempt.draftScope, firstPortal.attempt.draftScope);
  assert.match(saved.payload.attempt.draftScope, /^[A-Za-z0-9_-]{22}$/);
  const duplicateWrite = await request('/api/student-assessments/responses', {
    method: 'PUT', token: studentSession,
    body: { expectedRevision: firstPortal.attempt.revision, responses },
  });
  assert.equal(duplicateWrite.status, 409, 'repetição da revisão antiga não grava novamente');
  const reconciled = await request('/api/student-assessments/me', { token: studentSession });
  assert.equal(reconciled.payload.attempt.revision, saved.payload.attempt.revision);
  assert.deepEqual(reconciled.payload.items, saved.payload.items);

  const competingSubmissions = await Promise.all([1, 2].map(() => request('/api/student-assessments/submit', {
    method: 'POST',
    token: studentSession,
    body: { expectedRevision: saved.payload.attempt.revision },
  })));
  assert.deepEqual(competingSubmissions.map(({ status }) => status).sort(), [200, 409]);
  const submitted = competingSubmissions.find(({ status }) => status === 200);
  assert.equal(submitted.status, 200, JSON.stringify(submitted.payload));
  assert.equal(submitted.payload.attempt.status, 'submitted');
  // O portal permite rever o envio com a credencial usada ainda válida.
  // A imagem visível deve continuar acessível, sem expor a questão oculta.
  for (const [file, expected] of [['student-visible.png', 200], ['student-hidden.png', 404]]) {
    const media = await fetch(`${baseUrl}/uploads/${file}`, {
      headers: { Cookie: `labmathic_student_media=${studentSession}` },
    });
    await media.arrayBuffer();
    assert.equal(media.status, expected);
  }
  assert.deepEqual(submitted.payload.result, {
    answeredCount: 2,
    correctCount: 1,
    questionCount: 2,
    percentage: 50,
    methodology: 'classical_test_theory',
  });

  const immutable = await request('/api/student-assessments/responses', {
    method: 'PUT', token: studentSession, body: { expectedRevision: submitted.payload.attempt.revision, responses },
  });
  assert.equal(immutable.status, 409);

  const summary = await request(
    `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results`,
    { token: professorToken }
  );
  assert.equal(summary.status, 200, JSON.stringify(summary.payload));
  assert.equal(summary.payload.overview.submittedCount, 1);
  assert.equal(summary.payload.participants.find(({ id }) => id === studentPublicIds[0]).percentage, 50);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM activity_log
      WHERE action = 'submit_student_online_assessment'
        AND user_id = ?
    `).pluck().get(professor.id),
    1
  );
});

test('prazo envia respostas automaticamente, audita e a revogação bloqueia o código', async () => {
  const opened = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: secondCode },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.payload));
  assert.equal(opened.payload.portal.attempt.status, 'draft');

  db.prepare(`
    UPDATE class_assessment_assignments
    SET time_limit_minutes = 5
    WHERE public_id = ?
  `).run(assessmentPublicId);
  db.prepare(`
    UPDATE class_assessment_attempts
    SET started_at = '2020-01-01T00:00:00.000Z'
    WHERE participant_id = (
      SELECT participant.id
      FROM class_assessment_participants participant
      JOIN students student ON student.id = participant.student_id
      WHERE student.public_id = ?
    )
  `).run(studentPublicIds[1]);

  const teacherResults = await request(
    `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results`,
    { token: professorToken }
  );
  assert.equal(teacherResults.status, 200, JSON.stringify(teacherResults.payload));
  assert.equal(
    teacherResults.payload.participants.find(({ id }) => id === studentPublicIds[1]).attemptStatus,
    'submitted'
  );

  const expired = await request('/api/student-assessments/me', { token: opened.payload.token });
  assert.equal(expired.status, 200, JSON.stringify(expired.payload));
  assert.equal(expired.payload.attempt.status, 'submitted');
  assert.equal(expired.payload.attempt.answeredCount, 0);
  assert.equal(expired.payload.result.percentage, 0);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM activity_log
      WHERE action = 'auto_submit_student_online_assessment'
        AND user_id = ?
    `).pluck().get(professor.id),
    1
  );

  const current = await request(accessPath(), { token: professorToken });
  const second = current.payload.participants.find(({ id }) => id === studentPublicIds[1]);
  assert.equal(second.credential.status, 'used');
  const revoked = await request(accessPath(`/participants/${studentPublicIds[1]}/revoke`), {
    method: 'POST',
    token: professorToken,
    body: { expectedRevision: second.credential.revision },
  });
  assert.equal(revoked.status, 200);

  const denied = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: secondCode },
  });
  assert.equal(denied.status, 401);
});

test('encerramento pelo professor envia e corrige tentativas on-line ainda abertas', async () => {
  const opened = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: thirdCode },
  });
  assert.equal(opened.status, 200, JSON.stringify(opened.payload));
  const responses = opened.payload.portal.items.map((item, index) => ({
    itemId: item.id,
    optionId: index === 0
      ? item.options.find(({ text }) => text.endsWith('B')).id
      : null,
  }));
  const saved = await request('/api/student-assessments/responses', {
    method: 'PUT',
    token: opened.payload.token,
    body: { expectedRevision: opened.payload.portal.attempt.revision, responses },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.attempt.answeredCount, 1);

  const access = await request(accessPath(), { token: professorToken });
  const closed = await request(
    `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/delivery`,
    {
      method: 'PATCH',
      token: professorToken,
      body: { expectedRevision: access.payload.assessment.revision, action: 'close' },
    }
  );
  assert.equal(closed.status, 200, JSON.stringify(closed.payload));
  assert.equal(closed.payload.status, 'closed');

  const storedAttempt = db.prepare(`
    SELECT attempt.*
    FROM class_assessment_attempts attempt
    JOIN students student ON student.id = attempt.student_id
    WHERE student.public_id = ? AND attempt.status <> 'voided'
  `).get(studentPublicIds[2]);
  assert.equal(storedAttempt.status, 'submitted');
  assert.equal(storedAttempt.answered_count, 1);
  assert.equal(storedAttempt.correct_count, 1);
  assert.equal(storedAttempt.score_percentage, 50);

  const resumed = await request('/api/student-assessments/session', {
    method: 'POST', body: { code: thirdCode },
  });
  assert.equal(resumed.status, 200, JSON.stringify(resumed.payload));
  assert.equal(resumed.payload.portal.attempt.status, 'submitted');
  assert.equal(resumed.payload.portal.result.percentage, 50);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM activity_log
      WHERE action = 'auto_submit_student_online_assessment'
        AND user_id = ?
    `).pluck().get(professor.id),
    2
  );
});

test('devolutiva chega somente ao estudante escolhido e desaparece com bloqueio emergencial', async () => {
  enableFlagForUser('classes.student_feedback_release', professor);
  enableFlagForUser('classes.student_feedback_release', otherProfessor);
  const opened = await request('/api/student-assessments/session', { method: 'POST', body: { code: thirdCode } });
  assert.equal(opened.status, 200);
  assert.equal(opened.payload.portal.feedback, null);
  const path = `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/participants/${studentPublicIds[2]}/feedback`;
  const body = { message: 'Compare as frações desenhando figuras do mesmo tamanho.', confirmed: true, expectedRevision: opened.payload.portal.attempt.revision };
  const headers = { 'Idempotency-Key': 'portal-feedback-release-test-001' };
  assert.equal((await request(path, { method: 'POST', token: otherProfessorToken, body, headers })).status, 404);
  assert.equal((await request(path, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: String(body.expectedRevision) }, headers })).status, 400);
  assert.equal((await request(path, { method: 'POST', token: professorToken, body: { ...body, expectedRevision: body.expectedRevision + 1 }, headers })).status, 409);
  assert.equal((await request(path, { method: 'POST', token: professorToken, body, headers })).status, 201);
  const visible = await request('/api/student-assessments/me', { token: opened.payload.token });
  assert.deepEqual(Object.keys(visible.payload.feedback).sort(), ['message', 'releasedAt']);
  assert.equal(visible.payload.feedback.message, body.message);
  assert.doesNotMatch(JSON.stringify(visible.payload), /isCorrect|correctOptionId|owner_teacher_id|student_id/);
  const other = await request('/api/student-assessments/session', { method: 'POST', body: { code: firstCode } });
  assert.equal(other.status, 200);
  assert.equal(other.payload.portal.feedback, null);
  db.prepare("UPDATE feature_flags SET kill_switch_active=1, kill_switch_reason='Pausa sintética do piloto' WHERE flag_key='classes.student_feedback_release'").run();
  try {
    const hidden = await request('/api/student-assessments/me', { token: opened.payload.token });
    assert.equal(hidden.status, 200);
    assert.equal(hidden.payload.feedback, null);
    assert.equal((await request(path, { method: 'POST', token: professorToken, body, headers })).status, 404);
    assert.equal(db.prepare('SELECT COUNT(*) FROM student_assessment_feedback').pluck().get(), 1);
  } finally { db.prepare("UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key='classes.student_feedback_release'").run(); }
  assert.equal((await request('/api/student-assessments/me', { token: opened.payload.token })).payload.feedback.message, body.message);
});
