const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-assessment-results-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'assessment-results-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const resultsRouter = require('../src/routes/classAssessmentResults');

const app = express();
app.use(express.json());
app.use('/api/classes', resultsRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

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
let itemIds;
let optionIds;

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
    ) VALUES (?, ?, 1, 'Teste automatizado de resultados', ?, ?)
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

function resultPath(studentPublicId = '') {
  const base = `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results`;
  return studentPublicId ? `${base}/participants/${studentPublicId}` : base;
}

test.before(async () => {
  admin = insertUser('Admin', 'admin-resultados@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-resultados@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-resultados@teste.local', 'professor');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);

  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)")
    .run().lastInsertRowid);
  const disciplineId = Number(db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')")
    .run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units (name) VALUES ('Números')")
    .run().lastInsertRowid);
  const skillIds = [
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA01', 'Resolver problemas com números inteiros.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA02', 'Comparar números racionais.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
  ];
  classPublicId = 'class-results-public-id-0001';
  const classId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
    ) VALUES (?, ?, '7º A', ?, 2026, ?, ?)
  `).run(classPublicId, professor.id, gradeId, professor.id, professor.id).lastInsertRowid);
  db.prepare(`
    INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by)
    VALUES (?, ?, ?, ?)
  `).run(classId, professor.id, disciplineId, professor.id);

  studentPublicIds = ['student-results-public-0001', 'student-results-public-0002'];
  const participantRows = studentPublicIds.map((publicId, index) => {
    const studentId = Number(db.prepare(`
      INSERT INTO students (
        public_id, owner_teacher_id, display_name, external_reference, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      publicId,
      professor.id,
      index === 0 ? 'Ana Estudante' : 'Beto Estudante',
      `MAT-${index + 1}`,
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

  assessmentPublicId = 'assessment-results-public-0001';
  const assignmentId = Number(db.prepare(`
    INSERT INTO class_assessment_assignments (
      public_id, class_id, owner_teacher_id, title_snapshot, snapshot_hash,
      question_count, status, created_by, updated_by
    ) VALUES (?, ?, ?, 'Diagnóstico de números', ?, 2, 'draft', ?, ?)
  `).run(
    assessmentPublicId,
    classId,
    professor.id,
    'a'.repeat(64),
    professor.id,
    professor.id
  ).lastInsertRowid);

  itemIds = [];
  optionIds = [];
  skillIds.forEach((skillId, index) => {
    const code = index === 0 ? 'EF07MA01-Q001' : 'EF07MA02-Q001';
    const itemId = Number(db.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id, source_skill_id,
        question_code_snapshot, skill_code_snapshot, skill_description_snapshot,
        statement_snapshot, difficulty_snapshot, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'media', ?)
    `).run(
      assignmentId,
      classId,
      professor.id,
      skillId,
      code,
      index === 0 ? 'EF07MA01' : 'EF07MA02',
      index === 0 ? 'Resolver problemas com números inteiros.' : 'Comparar números racionais.',
      `Enunciado seguro ${index + 1}`,
      index
    ).lastInsertRowid);
    itemIds.push(itemId);
    const itemOptions = {};
    ['A', 'B', 'C', 'D'].forEach((label, optionIndex) => {
      const optionId = Number(db.prepare(`
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
        `Alternativa ${label}`,
        optionIndex === 0 ? 1 : 0,
        optionIndex
      ).lastInsertRowid);
      itemOptions[label] = optionId;
    });
    optionIds.push(itemOptions);
  });
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
    SET status = 'open', opened_at = CURRENT_TIMESTAMP, revision = revision + 1,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'draft'
  `).run(professor.id, assignmentId);

  enableFlagForUser('classes.core', professor);
  enableFlagForUser('classes.assessment_assignments', professor);

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

test('resultados falham fechados enquanto a capacidade está desligada', async () => {
  const response = await request(resultPath(), { token: professorToken });
  assert.equal(response.status, 404);
  enableFlagForUser('classes.assessment_results', professor);
});

test('salva marcações sem aceitar gabarito do cliente e corrige no servidor', async () => {
  const studentId = studentPublicIds[0];
  const saved = await request(resultPath(studentId), {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: 0,
      responses: [
        { itemId: itemIds[0], optionId: optionIds[0].A, isCorrect: false },
        { itemId: itemIds[1], optionId: null, isCorrect: true },
      ],
    },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  assert.equal(saved.payload.attempt.status, 'draft');
  assert.equal(saved.payload.attempt.revision, 1);
  assert.equal(saved.payload.attempt.answeredCount, 1);
  assert.equal(saved.payload.items[0].correctOptionId, null);

  const invalidLink = await request(resultPath(studentId), {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: 1,
      responses: [
        { itemId: itemIds[0], optionId: optionIds[1].A },
        { itemId: itemIds[1], optionId: null },
      ],
    },
  });
  assert.equal(invalidLink.status, 400);

  const submitted = await request(`${resultPath(studentId)}/submit`, {
    method: 'POST', token: professorToken, body: { expectedRevision: 1 },
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.payload));
  assert.equal(submitted.payload.attempt.status, 'submitted');
  assert.equal(submitted.payload.attempt.correctCount, 1);
  assert.equal(submitted.payload.attempt.percentage, 50);
  assert.equal(submitted.payload.items[0].isCorrect, true);
  assert.equal(submitted.payload.items[1].isCorrect, false);
  assert.equal(submitted.payload.items[0].correctOptionId, optionIds[0].A);
});

test('apresenta turma, indivíduo, questão, habilidade e acompanhamento', async () => {
  const summary = await request(resultPath(), { token: professorToken });
  assert.equal(summary.status, 200, JSON.stringify(summary.payload));
  assert.deepEqual(summary.payload.overview, {
    participantCount: 2,
    exemptedCount: 0,
    submittedCount: 1,
    pendingCount: 1,
    meanPercentage: 50,
  });
  assert.equal(summary.payload.participants[0].percentage, 50);
  assert.equal(summary.payload.questions[0].successRate, 100);
  assert.equal(summary.payload.questions[1].errorRate, 100);
  assert.equal(summary.payload.skills.find(({ code }) => code === 'EF07MA01').level, 'consolidated');
  assert.equal(summary.payload.skills.find(({ code }) => code === 'EF07MA02').level, 'below_expected');
  assert.equal(summary.payload.skills.find(({ code }) => code === 'EF07MA02').evidence.level, 'limited');
  assert.deepEqual(summary.payload.studentsNeedingFollowUp.map(({ id }) => id), [studentPublicIds[0]]);
  assert.equal(summary.payload.methodology, 'classical_test_theory');
});

test('atualiza indicadores quando outro estudante é corrigido', async () => {
  const studentId = studentPublicIds[1];
  const saved = await request(resultPath(studentId), {
    method: 'PUT', token: professorToken, body: {
      expectedRevision: 0,
      responses: [
        { itemId: itemIds[0], optionId: optionIds[0].A },
        { itemId: itemIds[1], optionId: optionIds[1].A },
      ],
    },
  });
  assert.equal(saved.status, 200);
  const submitted = await request(`${resultPath(studentId)}/submit`, {
    method: 'POST', token: professorToken, body: { expectedRevision: saved.payload.attempt.revision },
  });
  assert.equal(submitted.payload.attempt.percentage, 100);

  const summary = await request(resultPath(), { token: professorToken });
  assert.equal(summary.payload.overview.meanPercentage, 75);
  assert.equal(summary.payload.overview.submittedCount, 2);
  assert.equal(summary.payload.questions[0].successRate, 100);
  assert.equal(summary.payload.questions[1].successRate, 50);
});

test('correção concluída é imutável e a revisão posterior está descontinuada', async () => {
  const studentId = studentPublicIds[0];
  const current = await request(resultPath(studentId), { token: professorToken });
  const attemptsBefore = db.prepare(`
    SELECT id, status, revision, score_percentage
    FROM class_assessment_attempts
    WHERE participant_id = (
      SELECT id FROM class_assessment_participants WHERE student_id = (
        SELECT id FROM students WHERE public_id = ?
      )
    )
    ORDER BY attempt_number
  `).all(studentId);
  const responsesBefore = db.prepare(`
    SELECT attempt_id, assessment_item_id, selected_option_id, is_correct
    FROM class_assessment_responses
    WHERE attempt_id IN (${attemptsBefore.map(() => '?').join(',')})
    ORDER BY attempt_id, assessment_item_id
  `).all(...attemptsBefore.map(({ id }) => id));

  const revised = await request(`${resultPath(studentId)}/revise`, {
    method: 'POST', token: professorToken, body: { expectedRevision: current.payload.attempt.revision },
  });
  assert.equal(revised.status, 410, JSON.stringify(revised.payload));
  assert.match(revised.payload.error, /descontinuada|imutável/i);
  assert.deepEqual(
    db.prepare(`
      SELECT id, status, revision, score_percentage
      FROM class_assessment_attempts
      WHERE participant_id = (
        SELECT id FROM class_assessment_participants WHERE student_id = (
          SELECT id FROM students WHERE public_id = ?
        )
      )
      ORDER BY attempt_number
    `).all(studentId),
    attemptsBefore
  );
  assert.deepEqual(
    db.prepare(`
      SELECT attempt_id, assessment_item_id, selected_option_id, is_correct
      FROM class_assessment_responses
      WHERE attempt_id IN (${attemptsBefore.map(() => '?').join(',')})
      ORDER BY attempt_id, assessment_item_id
    `).all(...attemptsBefore.map(({ id }) => id)),
    responsesBefore
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'revise_assessment_results'").pluck().get(),
    0
  );
});

test('outro professor não descobre resultados da turma', async () => {
  enableFlagForUser('classes.core', otherProfessor);
  enableFlagForUser('classes.assessment_assignments', otherProfessor);
  enableFlagForUser('classes.assessment_results', otherProfessor);
  const response = await request(resultPath(), { token: otherProfessorToken });
  assert.equal(response.status, 404);
});

test('devolutiva só é liberada após encerramento, é idempotente e fica auditada', async () => {
  enableFlagForUser('classes.student_feedback_release', professor);
  const openProgress = await request(resultPath(), { token: professorToken });
  assert.equal(openProgress.payload.feedbackProgress, undefined, 'avaliação aberta não gera pendência de orientação');
  assert.ok(openProgress.payload.participants.every(p => p.feedbackStatus === undefined));
  const studentId = studentPublicIds[0];
  const attempt = db.prepare(`
    SELECT attempt.revision
    FROM class_assessment_attempts attempt
    JOIN class_assessment_participants participant ON participant.id=attempt.participant_id
    JOIN students student ON student.id=participant.student_id
    WHERE student.public_id=? AND attempt.status='submitted'
  `).get(studentId);
  const body = {
    message: 'Revise a comparação de frações e explique seu raciocínio com um desenho.',
    confirmed: true,
    expectedRevision: attempt.revision,
  };
  const early = await request(`${resultPath(studentId)}/feedback`, {
    method: 'POST', token: professorToken, body,
  });
  assert.equal(early.status, 400, 'a chave de idempotência é obrigatória');
  const earlyWithKey = await fetch(`${baseUrl}${resultPath(studentId)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${professorToken}`, 'Idempotency-Key': 'feedback-open-assessment-001' },
    body: JSON.stringify(body),
  });
  assert.equal(earlyWithKey.status, 409);
  db.prepare("UPDATE class_assessment_assignments SET status='closed', closed_at=CURRENT_TIMESTAMP WHERE public_id=?")
    .run(assessmentPublicId);
  const beforeRelease = await request(resultPath(), { token: professorToken });
  assert.deepEqual(beforeRelease.payload.feedbackProgress, { eligibleCount: 2, pendingCount: 2, releasedCount: 0 });
  const key = 'feedback-release-test-key-001';
  const released = await request(`${resultPath(studentId)}/feedback`, {
    method: 'POST', token: professorToken, body,
  });
  assert.equal(released.status, 400, 'a chave de idempotência é obrigatória');
  const releasedWithKey = await fetch(`${baseUrl}${resultPath(studentId)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${professorToken}`, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  const receipt = await releasedWithKey.json();
  assert.equal(releasedWithKey.status, 201, JSON.stringify(receipt));
  assert.equal(receipt.feedback.message, body.message);
  const replay = await fetch(`${baseUrl}${resultPath(studentId)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${professorToken}`, 'Idempotency-Key': key },
    body: JSON.stringify(body),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).replayed, true);
  const detail = await request(resultPath(studentId), { token: professorToken });
  assert.equal(detail.payload.feedback.message, body.message);
  const progress = await request(resultPath(), { token: professorToken });
  assert.match(progress.headers.get('cache-control'), /no-store/);
  assert.deepEqual(progress.payload.feedbackProgress, { eligibleCount: 2, pendingCount: 1, releasedCount: 1 });
  assert.equal(progress.payload.participants.find(p => p.id === studentId).feedbackStatus, 'released');
  assert.equal(progress.payload.participants.find(p => p.id === studentPublicIds[1]).feedbackStatus, 'pending');
  assert.equal(JSON.stringify(progress.payload).includes(body.message), false, 'lista não carrega textos individuais');
  assert.doesNotMatch(JSON.stringify(progress.payload.feedbackProgress), /message|readAt|feedbackId|owner_teacher/);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='student_assessment_feedback_released'").pluck().get(), 1);
  const secondStudent = studentPublicIds[1];
  const secondAttempt = db.prepare(`
    SELECT attempt.revision
    FROM class_assessment_attempts attempt
    JOIN class_assessment_participants participant ON participant.id=attempt.participant_id
    JOIN students student ON student.id=participant.student_id
    WHERE student.public_id=? AND attempt.status='submitted'
  `).get(secondStudent);
  db.exec("CREATE TRIGGER reject_feedback_audit BEFORE INSERT ON activity_log WHEN NEW.action='student_assessment_feedback_released' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try {
    const rejected = await fetch(`${baseUrl}${resultPath(secondStudent)}/feedback`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${professorToken}`, 'Idempotency-Key': 'feedback-audit-failure-001' },
      body: JSON.stringify({ ...body, expectedRevision: secondAttempt.revision }),
    });
    assert.equal(rejected.status, 500);
    assert.equal(db.prepare('SELECT COUNT(*) FROM student_assessment_feedback WHERE student_id=(SELECT id FROM students WHERE public_id=?)').pluck().get(secondStudent), 0);
  } finally { db.exec('DROP TRIGGER reject_feedback_audit'); }
  const conflict = await fetch(`${baseUrl}${resultPath(studentId)}/feedback`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${professorToken}`, 'Idempotency-Key': key },
    body: JSON.stringify({ ...body, message: 'Outro texto completamente diferente para conflito.' }),
  });
  assert.equal(conflict.status, 409);
});

test('progresso respeita flag, bloqueio, perfil vigente e isolamento sem apagar mensagens', async () => {
  const flag = db.prepare("SELECT id FROM feature_flags WHERE flag_key='classes.student_feedback_release'").get();
  const records = db.prepare('SELECT * FROM student_assessment_feedback').all();
  db.prepare("UPDATE feature_flags SET kill_switch_reason='Pausa sintética para verificar isolamento' WHERE id=?").run(flag.id);
  for (const field of ['master_enabled', 'kill_switch_active']) {
    const blocked = field === 'master_enabled' ? 0 : 1;
    db.prepare(`UPDATE feature_flags SET ${field}=? WHERE id=?`).run(blocked, flag.id);
    try {
      const response = await request(resultPath(), { token: professorToken });
      assert.equal(response.status, 200);
      assert.equal(response.payload.feedbackProgress, undefined);
      assert.ok(response.payload.participants.every(p => p.feedbackStatus === undefined));
    } finally { db.prepare(`UPDATE feature_flags SET ${field}=? WHERE id=?`).run(1 - blocked, flag.id); }
  }
  db.prepare('UPDATE feature_flag_user_rules SET enabled=0 WHERE feature_flag_id=? AND user_id=?').run(flag.id, professor.id);
  try {
    assert.equal((await request(resultPath(), { token: professorToken })).payload.feedbackProgress, undefined);
  } finally { db.prepare('UPDATE feature_flag_user_rules SET enabled=1 WHERE feature_flag_id=? AND user_id=?').run(flag.id, professor.id); }
  assert.equal((await request(resultPath())).status, 401);
  assert.equal((await request(resultPath(), { token: otherProfessorToken })).status, 404);
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(professor.id);
  try {
    assert.equal((await request(resultPath(), { token: professorToken })).status, 401, 'sessão de papel anterior é revogada');
    assert.equal((await request(resultPath(), { token: require('../src/services/authSessions').issueUserToken(professor.id) })).status, 403);
  }
  finally { db.prepare("UPDATE users SET role='professor' WHERE id=?").run(professor.id); }
  professorToken = require('../src/services/authSessions').issueUserToken(professor.id);
  const restored = await request(resultPath(), { token: professorToken });
  assert.equal(restored.payload.feedbackProgress.releasedCount, 1);
  assert.deepEqual(db.prepare('SELECT * FROM student_assessment_feedback').all(), records);
  const { parseResults } = await import('../../client/src/services/assessmentView.mjs');
  assert.equal(parseResults(restored.payload), restored.payload);
});
