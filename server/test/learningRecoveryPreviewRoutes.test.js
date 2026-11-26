const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-recovery-preview-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
// Browser audits must never resolve real uploads, even while sharing this synthetic fixture.
if (process.env.SCREEN_LAYOUT_AUDIT === '1') {
  process.env.UPLOAD_DIR = path.join(tempDir, 'uploads');
  fs.mkdirSync(process.env.UPLOAD_DIR);
}
process.env.JWT_SECRET = 'recovery-preview-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const assessmentsRouter = require('../src/routes/classAssessments');
const resultsRouter = require('../src/routes/classAssessmentResults');

const app = express();
app.use(express.json());
app.use('/api/classes', assessmentsRouter);
app.use('/api/classes', resultsRouter);
app.use('/api/pedagogical-cycle', require('../src/routes/pedagogicalCycle'));
app.use('/api/question-bank', require('../src/routes/questionBank'));
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let admin;
let professor;
let otherProfessor;
let professorToken;
let otherProfessorToken;
let classId;
let classPublicId;
let assignmentId;
let assessmentPublicId;
let sourceQuestionIds;
let assessmentItems;
let studentPublicIds;
let pendingStudentPublicId;
let targetSkillId;
let latestResultRevision;
let createdPlanPublicId;
let latestPlanReview;

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

function fixtureAuthState() {
  return db.prepare('SELECT id, password, role, auth_version FROM users ORDER BY id').all();
}

function restoreFixtureAuthState(rows) {
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  db.transaction(() => {
    const restoreCredentials = db.prepare('UPDATE users SET password=?, role=? WHERE id=?');
    const restoreVersion = db.prepare('UPDATE users SET auth_version=? WHERE id=?');
    const read = db.prepare('SELECT id, password, role, auth_version FROM users WHERE id=?');
    for (const row of rows) {
      restoreCredentials.run(row.password, row.role, row.id);
      // Restoring a password/role also fires the security trigger. Restore the
      // synthetic fixture's original version only after that trigger completes.
      restoreVersion.run(row.auth_version, row.id);
      assert.deepEqual(read.get(row.id), row, 'Browser QA must restore pre-existing authentication state');
    }
  })();
}

function enableFlagForUser(flagKey, user) {
  const flag = db.prepare('SELECT id FROM feature_flags WHERE flag_key = ?').get(flagKey);
  db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(flag.id);
  db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Teste automatizado da recomposição', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

function insertQuestion({ skillId, code, difficulty, source = 'official', ownerId = admin.id,
  reviewed = 1, correctCount = 1 }) {
  const id = Number(db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, difficulty, question_type,
      status, reviewed, source, created_by
    ) VALUES (?, ?, ?, ?, 'multiple_choice', 'active', ?, ?, ?)
  `).run(
    code,
    skillId,
    `Enunciado ${code}`,
    difficulty,
    reviewed,
    source,
    ownerId
  ).lastInsertRowid);
  const options = {};
  ['A', 'B', 'C', 'D'].forEach((label, index) => {
    options[label] = Number(db.prepare(`
      INSERT INTO question_options (
        question_id, option_label, option_text, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `).run(id, label, `Alternativa ${label}`, index < correctCount ? 1 : 0, index).lastInsertRowid);
  });
  return { id, code, skillId, difficulty, options };
}

async function request(urlPath, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    headers: response.headers,
    payload: await response.json(),
  };
}

function previewPath() {
  return `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/recovery-preview`;
}

function recoveryPlanPath() {
  return `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/recovery-plans`;
}

function cyclePath() { return `/api/pedagogical-cycle/classes/${classPublicId}/assessments/${assessmentPublicId}`; }
function feedbackBody(detail, overrides = {}) {
  return { expectedRevision: detail.feedback?.revision || 0, evidenceHash: detail.evidenceHash,
    objective: 'Comparar e ordenar números com apoio da reta numérica.',
    observation: 'A turma apresenta indícios de dificuldade; confirmar com observação em aula.',
    action: 'Retomar a reta numérica em duplas e pedir justificativas para as comparações.',
    verification: 'Propor novos itens na próxima semana e decidir se é necessário retomar.', ...overrides };
}
async function saveCycle(body, key = 'cycle-feedback-test-key-0001', token = professorToken) {
  return request(`${cyclePath()}/feedback`, { method: 'POST', token, body, headers: { 'Idempotency-Key': key } });
}

function recoveryPlanDetailPath(planPublicId = createdPlanPublicId) {
  return `${recoveryPlanPath()}/${planPublicId}`;
}

function recoveryExecutionPath(planPublicId = createdPlanPublicId) {
  return `${recoveryPlanDetailPath(planPublicId)}/execution`;
}

function currentAssessmentRevision() {
  return db.prepare('SELECT revision FROM class_assessment_assignments WHERE id = ?')
    .pluck().get(assignmentId);
}

function validConfirmation(overrides = {}) {
  return {
    expectedAssessmentRevision: currentAssessmentRevision(),
    expectedResultRevision: latestResultRevision,
    methodologyVersion: 'descriptive-v1',
    title: 'Recomposição · Diagnóstico de números',
    acceptedPriorities: [{
      skillId: targetSkillId,
      suggestedQuestionCount: 4,
      rationale: 'Prioridade confirmada a partir do diagnóstico encerrado.',
      group: {
        title: 'Grupo de números racionais',
        objective: 'Retomar comparação e ordenação de números racionais.',
        studentIds: [...studentPublicIds],
      },
    }],
    ...overrides,
  };
}

async function submitStudent(studentPublicId, labels) {
  const responses = assessmentItems.map((item, index) => ({
    itemId: item.itemId,
    optionId: item.options[labels[index]],
  }));
  const saved = await request(
    `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/participants/${studentPublicId}`,
    { method: 'PUT', token: professorToken, body: { expectedRevision: 0, responses } }
  );
  assert.equal(saved.status, 200, JSON.stringify(saved.payload));
  const submitted = await request(
    `/api/classes/${classPublicId}/assessments/${assessmentPublicId}/results/participants/${studentPublicId}/submit`,
    {
      method: 'POST',
      token: professorToken,
      body: { expectedRevision: saved.payload.attempt.revision },
    }
  );
  assert.equal(submitted.status, 200, JSON.stringify(submitted.payload));
}

test.before(async () => {
  admin = insertUser('Admin', 'admin-recovery@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-recovery@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-recovery@teste.local', 'professor');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);

  const gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)")
    .run().lastInsertRowid);
  const classGradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('1º Ano - EF', 1)")
    .run().lastInsertRowid);
  const disciplineId = Number(db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')")
    .run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units (name, sort_order) VALUES ('Números', 1)")
    .run().lastInsertRowid);
  const skillIds = [
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA01', 'Resolver problemas com números inteiros.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA02', 'Comparar e ordenar números racionais.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
  ];
  targetSkillId = skillIds[1];

  sourceQuestionIds = [
    insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-D001', difficulty: 'facil' }),
    insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-D002', difficulty: 'media' }),
    insertQuestion({ skillId: skillIds[1], code: 'EF07MA02-D001', difficulty: 'facil' }),
    insertQuestion({ skillId: skillIds[1], code: 'EF07MA02-D002', difficulty: 'media' }),
  ];
  insertQuestion({ skillId: targetSkillId, code: 'EF07MA02-R001', difficulty: 'facil' });
  insertQuestion({
    skillId: targetSkillId,
    code: 'EF07MA02-R002',
    difficulty: 'media',
    source: 'teacher',
    ownerId: professor.id,
    reviewed: 0,
  });
  insertQuestion({ skillId: targetSkillId, code: 'EF07MA02-R003', difficulty: 'dificil' });
  insertQuestion({ skillId: targetSkillId, code: 'EF07MA02-R004', difficulty: 'media' });
  insertQuestion({
    skillId: targetSkillId,
    code: 'EF07MA02-PRIVADA',
    difficulty: 'facil',
    source: 'teacher',
    ownerId: otherProfessor.id,
  });
  insertQuestion({
    skillId: targetSkillId,
    code: 'EF07MA02-INVALIDA',
    difficulty: 'dificil',
    correctCount: 2,
  });

  const questionSetId = Number(db.prepare(`
    INSERT INTO question_sets (user_id, title, is_public)
    VALUES (?, 'Diagnóstico revisado de números', 0)
  `).run(professor.id).lastInsertRowid);
  sourceQuestionIds.forEach((question, index) => {
    db.prepare(`
      INSERT INTO question_set_items (question_set_id, question_id, sort_order)
      VALUES (?, ?, ?)
    `).run(questionSetId, question.id, index);
  });
  db.prepare(`
    INSERT INTO diagnostic_question_sets (
      question_set_id, owner_teacher_id, grade_id,
      questions_per_skill, total_questions
    ) VALUES (?, ?, ?, 2, 4)
  `).run(questionSetId, professor.id, gradeId);
  skillIds.forEach((skillId) => {
    db.prepare(`
      INSERT INTO diagnostic_question_set_skills (
        question_set_id, owner_teacher_id, grade_id, skill_id,
        requested_count, selected_count, easy_count, medium_count,
        difficult_count, candidate_count
      ) VALUES (?, ?, ?, ?, 2, 2, 1, 1, 0, 2)
    `).run(questionSetId, professor.id, gradeId, skillId);
  });
  db.prepare(`
    INSERT INTO diagnostic_question_set_reviews (
      question_set_id, owner_teacher_id, reviewed_by
    ) VALUES (?, ?, ?)
  `).run(questionSetId, professor.id, professor.id);

  classPublicId = 'class-recovery-public-id-0001';
  classId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
    ) VALUES (?, ?, '1º Ano A', ?, 2026, ?, ?)
  `).run(classPublicId, professor.id, classGradeId, professor.id, professor.id).lastInsertRowid);
  db.prepare(`
    INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by)
    VALUES (?, ?, ?, ?)
  `).run(classId, professor.id, disciplineId, professor.id);

  studentPublicIds = [
    '10000000-0000-4000-8000-000000000001',
    '10000000-0000-4000-8000-000000000002',
  ];
  pendingStudentPublicId = '10000000-0000-4000-8000-000000000003';
  const students = [...studentPublicIds, pendingStudentPublicId].map((publicId, index) => {
    const studentId = Number(db.prepare(`
      INSERT INTO students (
        public_id, owner_teacher_id, display_name, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?)
    `).run(
      publicId,
      professor.id,
      ['Alice Estudante', 'Bruno Estudante', 'Carla Estudante'][index],
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

  assessmentPublicId = 'assessment-recovery-public-0001';
  assignmentId = Number(db.prepare(`
    INSERT INTO class_assessment_assignments (
      public_id, class_id, owner_teacher_id, source_question_set_id,
      title_snapshot, snapshot_hash, question_count, status, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 'Diagnóstico de números', ?, 4, 'draft', ?, ?)
  `).run(
    assessmentPublicId,
    classId,
    professor.id,
    questionSetId,
    'b'.repeat(64),
    professor.id,
    professor.id
  ).lastInsertRowid);
  assessmentItems = sourceQuestionIds.map((question, index) => {
    const skillCode = index < 2 ? 'EF07MA01' : 'EF07MA02';
    const skillDescription = index < 2
      ? 'Resolver problemas com números inteiros.'
      : 'Comparar e ordenar números racionais.';
    const itemId = Number(db.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id, source_question_id, source_skill_id,
        question_code_snapshot, skill_code_snapshot, skill_description_snapshot,
        statement_snapshot, difficulty_snapshot, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId,
      classId,
      professor.id,
      question.id,
      question.skillId,
      question.code,
      skillCode,
      skillDescription,
      `Enunciado aplicado ${index + 1}`,
      question.difficulty,
      index
    ).lastInsertRowid);
    const options = {};
    ['A', 'B', 'C', 'D'].forEach((label, optionIndex) => {
      options[label] = Number(db.prepare(`
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
        `Alternativa aplicada ${label}`,
        optionIndex === 0 ? 1 : 0,
        optionIndex
      ).lastInsertRowid);
    });
    return { itemId, options };
  });
  students.forEach(({ studentId, enrollmentId }) => {
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
    SET status = 'open', opened_at = CURRENT_TIMESTAMP,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(assignmentId);

  const materialTypeId = Number(db.prepare(`
    INSERT INTO material_types (name, icon) VALUES ('Caderno de atividades', 'file')
  `).run().lastInsertRowid);
  const curatedMaterialId = Number(db.prepare(`
    INSERT INTO materials (
      title, description, discipline_id, grade_id, material_type_id, file_format, created_by
    ) VALUES ('Caderno de números racionais', 'Atividades graduadas.', ?, ?, ?, 'PDF', ?)
  `).run(disciplineId, gradeId, materialTypeId, admin.id).lastInsertRowid);
  db.prepare(`
    INSERT INTO material_bncc_skills (material_id, skill_id, linked_by)
    VALUES (?, ?, ?)
  `).run(curatedMaterialId, targetSkillId, admin.id);

  ['classes.core', 'classes.assessment_assignments', 'classes.assessment_delivery', 'classes.assessment_results']
    .forEach((flagKey) => enableFlagForUser(flagKey, professor));

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('ciclo operacional começa desligado, exige professor atual e não grava com aplicação aberta', async () => {
  assert.equal((await request(cyclePath(), { token: professorToken })).status, 404);
  const flag = db.prepare("SELECT * FROM feature_flags WHERE flag_key = 'pedagogy.operational_cycle'").get();
  assert.equal(flag.master_enabled, 0); assert.equal(flag.default_enabled, 0); assert.equal(flag.rollout_percentage, 0);
  enableFlagForUser('pedagogy.operational_cycle', professor);
  assert.equal((await request(cyclePath())).status, 401);
  assert.equal((await request(cyclePath(), { token: tokenFor(admin) })).status, 403);
  const detail = await request(cyclePath(), { token: professorToken });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.canSaveFeedback, false);
  assert.equal(detail.payload.capabilities.recovery, false);
  assert.deepEqual(detail.payload.plans, []);
  const initialReport = await request(`${cyclePath()}/report`, { token: professorToken });
  assert.equal(initialReport.status, 200);
  assert.equal(initialReport.payload.overview.submittedCount, 0);
  assert.equal(initialReport.payload.overview.meanPercentage, null);
  const { parsePedagogicalReport } = await import('../../client/src/services/pedagogicalReportView.mjs');
  parsePedagogicalReport(initialReport.payload, classPublicId, assessmentPublicId);
  assert.equal((await saveCycle(feedbackBody(detail.payload))).status, 409);
  assert.equal(db.prepare('SELECT COUNT(*) FROM pedagogical_feedback_versions').pluck().get(), 0);
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(professor.id);
  assert.equal((await request(cyclePath(), { token: professorToken })).status, 401);
  assert.equal((await request(cyclePath(), { token: require('../src/services/authSessions').issueUserToken(professor.id) })).status, 403);
  db.prepare("UPDATE users SET role = 'professor' WHERE id = ?").run(professor.id);
  professorToken = require('../src/services/authSessions').issueUserToken(professor.id);
});

test('ciclo mantém turma e instituição explícitas sem inferir vínculo nem expor outro professor', async () => {
  enableFlagForUser('institutions.read_model', professor);
  let listed = await request('/api/pedagogical-cycle/classes', { token: professorToken });
  assert.equal(listed.status, 200, JSON.stringify(listed.payload));
  assert.equal(listed.payload.data[0].institution.status, 'pending');
  assert.equal(listed.payload.pagination.total, 1);
  const municipality = db.prepare("INSERT INTO municipalities(public_id,name,created_by) VALUES ('cycle-municipality-0001','Município de teste',?)").run(admin.id).lastInsertRowid;
  const school = db.prepare("INSERT INTO schools(public_id,municipality_id,name,created_by) VALUES ('cycle-school-public-0001',?,'Escola municipal de teste',?)").run(municipality, admin.id).lastInsertRowid;
  db.prepare(`INSERT INTO institutional_memberships(public_id,user_id,role,municipality_id,school_id,created_by)
    VALUES ('cycle-teacher-membership',?,'teacher',?,?,?)`).run(professor.id, municipality, school, admin.id);
  db.prepare(`UPDATE school_class_institution_contexts SET migration_status='linked', municipality_id=?,school_id=?,linked_by=?,linked_at=CURRENT_TIMESTAMP WHERE class_id=?`)
    .run(municipality, school, admin.id, classId);
  listed = await request('/api/pedagogical-cycle/classes', { token: professorToken });
  assert.equal(listed.payload.data[0].institution.status, 'linked');
  db.prepare(`UPDATE school_class_institution_contexts SET migration_status='verified',verified_by=?,verified_at=CURRENT_TIMESTAMP WHERE class_id=?`).run(professor.id, classId);
  const overview = await request(`/api/pedagogical-cycle/classes/${classPublicId}`, { token: professorToken });
  assert.equal(overview.status, 200, JSON.stringify(overview.payload));
  assert.equal(overview.payload.class.institution.status, 'verified');
  assert.equal(overview.payload.class.institution.school, 'Escola municipal de teste');
  assert.equal(overview.payload.assessments[0].isDiagnostic, 1);
  assert.equal(overview.payload.assessments[0].questionSetId > 0, true);
  ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'pedagogy.operational_cycle']
    .forEach(flag => enableFlagForUser(flag, otherProfessor));
  assert.equal((await request('/api/pedagogical-cycle/classes', { token: otherProfessorToken })).payload.pagination.total, 0);
  assert.equal((await request(cyclePath(), { token: otherProfessorToken })).status, 404);
  assert.equal((await request(`${cyclePath()}/feedback`, { token: otherProfessorToken })).status, 404);
});

test('prévia falha fechada pela flag e exige aplicação encerrada', async () => {
  const disabled = await request(previewPath(), { token: professorToken });
  assert.equal(disabled.status, 404);
  enableFlagForUser('classes.learning_recovery', professor);

  const open = await request(previewPath(), { token: professorToken });
  assert.equal(open.status, 409);
  assert.match(open.payload.error, /Encerre a aplicação/);
});

test('gera prévia determinística, explicável e sem qualquer escrita', async () => {
  await submitStudent(studentPublicIds[0], ['A', 'A', 'B', 'B']);
  await submitStudent(studentPublicIds[1], ['A', 'A', 'A', 'B']);
  db.prepare(`
    UPDATE class_assessment_assignments
    SET status = 'closed', closed_at = CURRENT_TIMESTAMP,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND status = 'open'
  `).run(assignmentId);

  const activityBefore = db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get();
  const preview = await request(previewPath(), { token: professorToken });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  assert.match(preview.headers.get('cache-control'), /private.*no-store/);
  assert.equal(preview.payload.methodology.version, 'descriptive-v1');
  assert.equal(preview.payload.methodology.usesTri, false);
  assert.equal(preview.payload.isActionable, true);
  assert.equal(preview.payload.source.overview.submittedCount, 2);
  assert.equal(preview.payload.source.overview.meanPercentage, 62.5);
  assert.equal(preview.payload.source.assessment.revision, currentAssessmentRevision());
  assert.match(preview.payload.source.resultRevision, /^[a-f0-9]{64}$/);
  latestResultRevision = preview.payload.source.resultRevision;
  assert.equal(preview.payload.priorities.length, 1);

  const priority = preview.payload.priorities[0];
  assert.equal(priority.skill.code, 'EF07MA02');
  assert.equal(priority.result.successRate, 25);
  assert.equal(priority.result.level, 'below_expected');
  assert.equal(priority.result.evidence.level, 'limited');
  assert.equal(priority.reinforcementQuestions.length, 2);
  assert.equal(priority.monitoringQuestions.length, 2);
  assert.equal(priority.materials.length, 1);
  assert.equal(priority.materials[0].matchBasis, 'curated_bncc');
  assert.deepEqual(
    priority.studentCandidates.map(({ displayName, successRate }) => ({ displayName, successRate })),
    [
      { displayName: 'Alice Estudante', successRate: 0 },
      { displayName: 'Bruno Estudante', successRate: 50 },
    ]
  );
  assert.deepEqual(
    priority.suggestedGroup.students.map(({ displayName, successRate }) => ({ displayName, successRate })),
    [
      { displayName: 'Alice Estudante', successRate: 0 },
      { displayName: 'Bruno Estudante', successRate: 50 },
    ]
  );
  assert.equal(priority.suggestedGroup.temporary, true);
  assert.equal(priority.suggestedGroup.requiresTeacherConfirmation, true);
  assert.equal(preview.payload.monitoringAssessment.ready, true);
  assert.equal(preview.payload.monitoringAssessment.willCreateAutomatically, false);
  assert.equal(preview.payload.monitoringAssessment.questionCount, 2);
  assert.equal(preview.payload.warnings.length, 0);

  const suggestedQuestionIds = [
    ...priority.reinforcementQuestions,
    ...priority.monitoringQuestions,
  ].map(({ id }) => id);
  assert.equal(new Set(suggestedQuestionIds).size, suggestedQuestionIds.length);
  assert.equal(suggestedQuestionIds.some((id) => sourceQuestionIds.some((source) => source.id === id)), false);
  assert.equal(
    [...priority.reinforcementQuestions, ...priority.monitoringQuestions]
      .some((question) => Object.hasOwn(question, 'isCorrect') || Object.hasOwn(question, 'correctOptionId')),
    false
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM teaching_plans').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get(), activityBefore);
});

test('devolutiva preserva evidência, privacidade, idempotência e histórico imutável', async () => {
  const before = db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get();
  const detail = await request(cyclePath(), { token: professorToken });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.match(detail.headers.get('cache-control'), /no-store/);
  assert.equal(db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get(), before);
  assert.equal(detail.payload.evidence.overview.submittedCount, 2);
  assert.equal(detail.payload.canSaveFeedback, true);
  assert.doesNotMatch(JSON.stringify(detail.payload), /Alice Estudante|Bruno Estudante|selected_option|is_correct|password/);
  const body = feedbackBody(detail.payload);
  assert.equal((await saveCycle({ ...body, objective: 'Curto' })).status, 400);
  assert.equal((await saveCycle({ ...body, objective: 'x'.repeat(2001) })).status, 400);
  assert.equal((await saveCycle({ ...body, studentIds: studentPublicIds })).status, 400);
  assert.equal((await saveCycle(body, 'short')).status, 400);
  assert.equal((await saveCycle(body, undefined, otherProfessorToken)).status, 404);
  const saved = await saveCycle(body);
  assert.equal(saved.status, 201, JSON.stringify(saved.payload));
  assert.equal(saved.payload.feedback.revision, 1);
  const replay = await saveCycle(body);
  assert.equal(replay.status, 200); assert.equal(replay.payload.replayed, true);
  assert.deepEqual(replay.payload.feedback, saved.payload.feedback);
  assert.equal((await saveCycle({ ...body, objective: body.objective + ' Nova meta.' })).status, 409);
  assert.equal((await saveCycle(body, 'cycle-different-stale-key-0001')).payload.code, 'revision_conflict');
  assert.throws(() => db.prepare("UPDATE pedagogical_feedback_versions SET objective='Alteração indevida'").run(), /immutable/);
  assert.throws(() => db.prepare('DELETE FROM pedagogical_feedback_versions').run(), /immutable/);
  const activity = db.prepare("SELECT * FROM activity_log WHERE action='pedagogical_feedback_saved'").all();
  assert.equal(activity.length, 1); assert.doesNotMatch(JSON.stringify(activity), /reta numérica|Alice/);
  const history = await request(`${cyclePath()}/feedback`, { token: professorToken });
  assert.equal(history.payload.data.length, 1);
  assert.equal(history.payload.data[0].evidence.overview.submittedCount, 2);
});

test('salvamento é atômico com auditoria e duas edições concorrentes não se sobrepõem', async () => {
  const detail = await request(cyclePath(), { token: professorToken });
  const body = feedbackBody(detail.payload, { action: 'Retomar usando representações concretas e discutir as estratégias em duplas.' });
  db.exec(`CREATE TRIGGER test_feedback_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='pedagogical_feedback_saved'
    BEGIN SELECT RAISE(ABORT,'forced_feedback_audit_failure'); END;`);
  try {
    assert.equal((await saveCycle(body, 'cycle-audit-rollback-key-0001')).status, 500);
    assert.equal(db.prepare('SELECT MAX(revision) FROM pedagogical_feedback_versions').pluck().get(), 1);
  } finally { db.exec('DROP TRIGGER test_feedback_audit_failure'); }
  const concurrent = await Promise.all([saveCycle(body, 'cycle-concurrent-a-key-0001'), saveCycle(body, 'cycle-concurrent-b-key-0001')]);
  assert.deepEqual(concurrent.map(r => r.status).sort(), [201, 409]);
  assert.equal(db.prepare('SELECT COUNT(*) FROM pedagogical_feedback_versions').pluck().get(), 2);
});

test('bloqueio emergencial e dependências são conferidos em toda leitura e escrita', async () => {
  const detail = await request(cyclePath(), { token: professorToken });
  const body = feedbackBody(detail.payload);
  for (const key of ['pedagogy.operational_cycle', 'classes.assessment_results']) {
    db.prepare(`UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Teste de bloqueio do ciclo',kill_switch_activated_by=?,kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key=?`).run(admin.id, key);
    try {
      assert.equal((await request(cyclePath(), { token: professorToken })).status, 404);
      assert.equal((await saveCycle(body, 'cycle-emergency-key-0001')).status, 404);
    } finally {
      db.prepare('UPDATE feature_flags SET kill_switch_active=0,kill_switch_reason=NULL,kill_switch_activated_by=NULL,kill_switch_activated_at=NULL WHERE flag_key=?').run(key);
    }
  }
});

test('não revela a prévia a outro professor', async () => {
  ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'classes.learning_recovery']
    .forEach((flagKey) => enableFlagForUser(flagKey, otherProfessor));
  const response = await request(previewPath(), { token: otherProfessorToken });
  assert.equal(response.status, 404);
});

test('papel atual no banco prevalece sobre token antigo', async () => {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(otherProfessor.id);
  const response = await request(previewPath(), { token: otherProfessorToken });
  assert.equal(response.status, 401);
  db.prepare("UPDATE users SET role = 'professor' WHERE id = ?").run(otherProfessor.id);
  otherProfessorToken = require('../src/services/authSessions').issueUserToken(otherProfessor.id);
});

test('revisão dos resultados invalida a prévia mesmo sem mudar a revisão da aplicação', async () => {
  const oldCycle = await request(cyclePath(), { token: professorToken });
  const oldReport = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const staleBody = validConfirmation();
  const assessmentRevisionBefore = currentAssessmentRevision();
  await submitStudent(pendingStudentPublicId, ['A', 'A', 'B', 'B']);
  assert.equal(currentAssessmentRevision(), assessmentRevisionBefore);
  const staleFeedback = await saveCycle(feedbackBody(oldCycle.payload), 'cycle-stale-evidence-key-0001');
  assert.equal(staleFeedback.payload.code, 'evidence_changed');
  const newCycle = await request(cyclePath(), { token: professorToken });
  assert.equal(newCycle.payload.feedbackStale, true);
  assert.equal(newCycle.payload.feedback.evidence.overview.submittedCount, 2);
  assert.equal(newCycle.payload.evidence.overview.submittedCount, 3);
  const changedReport = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  assert.notEqual(changedReport.revision, oldReport.revision);
  assert.equal(changedReport.feedbackStale, true);
  assert.equal(changedReport.overview.submittedCount, 3);
  assert.equal((await exportPedagogicalReport({ expectedRevision: oldReport.revision, privacyConfirmed: true })).status, 409);
  assert.equal((await printPedagogicalReport({ expectedRevision: oldReport.revision, privacyConfirmed: true })).status, 409);

  const stale = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-stale-results-key-0001' },
    body: staleBody,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'stale_results');
  assert.equal(stale.payload.details, undefined);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 0);

  const refreshed = await request(previewPath(), { token: professorToken });
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.payload));
  assert.notEqual(refreshed.payload.source.resultRevision, latestResultRevision);
  latestResultRevision = refreshed.payload.source.resultRevision;
});

test('confirmação exige contrato íntegro e não grava parcialmente dados inválidos', async () => {
  const missingKey = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    body: validConfirmation(),
  });
  assert.equal(missingKey.status, 400);
  assert.equal(missingKey.payload.code, 'idempotency_key_required');

  const missingResultRevision = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-missing-result-key-0001' },
    body: validConfirmation({ expectedResultRevision: undefined }),
  });
  assert.equal(missingResultRevision.status, 400);
  assert.equal(missingResultRevision.payload.code, 'invalid_request');

  const stale = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-stale-test-key-0001' },
    body: validConfirmation({ expectedAssessmentRevision: currentAssessmentRevision() - 1 }),
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'stale_preview');
  assert.equal(stale.payload.details, undefined);

  const invalidSkill = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-invalid-skill-key-0001' },
    body: validConfirmation({
      acceptedPriorities: [{ skillId: 999999, suggestedQuestionCount: 3 }],
    }),
  });
  assert.equal(invalidSkill.status, 409);
  assert.equal(invalidSkill.payload.code, 'priority_not_actionable');

  const invalidStudent = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-invalid-student-key-0001' },
    body: validConfirmation({
      acceptedPriorities: [{
        skillId: targetSkillId,
        suggestedQuestionCount: 3,
        group: { studentIds: ['student-not-in-assessment-0001'] },
      }],
    }),
  });
  assert.equal(invalidStudent.status, 409);
  assert.equal(invalidStudent.payload.code, 'invalid_group_member');

  for (const table of [
    'learning_recovery_plans',
    'learning_recovery_plan_skills',
    'learning_recovery_student_groups',
    'learning_recovery_student_group_members',
  ]) assert.equal(db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0, table);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'create_learning_recovery_plan'")
      .pluck().get(),
    0
  );
});

test('falha na auditoria reverte plano, snapshots e grupos na mesma transação', async () => {
  db.exec(`
    CREATE TRIGGER test_recovery_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'create_learning_recovery_plan'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_audit_failure');
    END;
  `);
  try {
    const response = await request(recoveryPlanPath(), {
      method: 'POST',
      token: professorToken,
      headers: { 'Idempotency-Key': 'recovery-audit-failure-key-0001' },
      body: validConfirmation(),
    });
    assert.equal(response.status, 500);
    assert.match(response.payload.error, /forced_recovery_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_audit_failure');
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plan_skills').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_student_groups').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_student_group_members').pluck().get(), 0);
});

test('confirma plano uma vez, preserva snapshots e repete resposta com idempotência', async () => {
  const idempotencyKey = 'recovery-confirmation-key-0000001';
  const body = validConfirmation();
  const created = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body,
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.created, true);
  assert.equal(created.payload.replayed, false);
  assert.equal(created.payload.plan.status, 'draft');
  assert.equal(created.payload.plan.revision, 1);
  assert.equal(created.payload.plan.methodologyVersion, 'descriptive-v1');
  assert.equal(created.payload.plan.sourceAssessmentRevision, currentAssessmentRevision());
  assert.equal(created.payload.plan.sourceResultRevision, latestResultRevision);
  createdPlanPublicId = created.payload.plan.id;
  assert.deepEqual(created.payload.plan.diagnosticSnapshot, {
    algorithmVersion: 'balanced-v1',
    confirmationVersion: 'teacher-review-v1',
  });
  assert.equal(created.payload.plan.skills.length, 1);
  assert.deepEqual(created.payload.plan.skills[0], {
    skillId: targetSkillId,
    code: 'EF07MA02',
    description: 'Comparar e ordenar números racionais.',
    successRateSnapshot: 16.67,
    opportunityCount: 6,
    diagnosticLevel: 'below_expected',
    priority: 1,
    suggestedQuestionCount: 4,
    rationale: 'Prioridade confirmada a partir do diagnóstico encerrado.',
  });
  assert.equal(created.payload.plan.groups.length, 1);
  assert.deepEqual(
    created.payload.plan.groups[0].students.map(({ displayName, successRateSnapshot, opportunityCount }) => ({
      displayName,
      successRateSnapshot,
      opportunityCount,
    })),
    [
      { displayName: 'Alice Estudante', successRateSnapshot: 0, opportunityCount: 2 },
      { displayName: 'Bruno Estudante', successRateSnapshot: 50, opportunityCount: 2 },
    ]
  );

  const stored = db.prepare(`
    SELECT idempotency_key_hash, request_fingerprint
    FROM learning_recovery_plans
  `).get();
  assert.equal(stored.idempotency_key_hash.length, 64);
  assert.equal(stored.request_fingerprint.length, 64);
  assert.notEqual(stored.idempotency_key_hash, idempotencyKey);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'create_learning_recovery_plan'")
      .pluck().get(),
    1
  );

  const replayed = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body,
  });
  assert.equal(replayed.status, 200, JSON.stringify(replayed.payload));
  assert.equal(replayed.payload.created, false);
  assert.equal(replayed.payload.replayed, true);
  assert.equal(replayed.payload.plan.id, created.payload.plan.id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'create_learning_recovery_plan'")
      .pluck().get(),
    1
  );

  const changedRequest = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': idempotencyKey },
    body: validConfirmation({ title: 'Outro conteúdo com a mesma chave' }),
  });
  assert.equal(changedRequest.status, 409);
  assert.equal(changedRequest.payload.code, 'idempotency_conflict');

  const duplicateSource = await request(recoveryPlanPath(), {
    method: 'POST',
    token: professorToken,
    headers: { 'Idempotency-Key': 'recovery-second-key-same-source-0001' },
    body,
  });
  assert.equal(duplicateSource.status, 409);
  assert.equal(duplicateSource.payload.code, 'recovery_plan_exists');
  assert.equal(duplicateSource.payload.details.planId, created.payload.plan.id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 1);
});

test('lista somente os planos do professor com contexto suficiente para acompanhamento', async () => {
  const listed = await request('/api/classes/recovery-plans', { token: professorToken });
  assert.equal(listed.status, 200, JSON.stringify(listed.payload));
  assert.match(listed.headers.get('cache-control'), /private.*no-store/);
  assert.deepEqual(listed.payload.counts, {
    total: 1,
    draft: 1,
    active: 0,
    completed: 0,
    archived: 0,
  });
  assert.equal(listed.payload.data.length, 1);
  assert.equal(listed.payload.data[0].id, createdPlanPublicId);
  assert.equal(listed.payload.data[0].status, 'draft');
  assert.equal(listed.payload.data[0].class.id, classPublicId);
  assert.equal(listed.payload.data[0].class.name, '1º Ano A');
  assert.equal(listed.payload.data[0].sourceAssessment.id, assessmentPublicId);
  assert.equal(listed.payload.data[0].sourceAssessment.isDiagnostic, true);
  assert.equal(listed.payload.data[0].priorityCount, 1);
  assert.equal(listed.payload.data[0].groupCount, 1);
  assert.equal(listed.payload.data[0].studentCount, 2);
  assert.equal(listed.payload.data[0].plannedQuestionCount, 4);

  const filtered = await request('/api/classes/recovery-plans?status=active', {
    token: professorToken,
  });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.payload.data.length, 0);
  assert.equal(filtered.payload.counts.total, 1);

  const isolated = await request('/api/classes/recovery-plans', {
    token: otherProfessorToken,
  });
  assert.equal(isolated.status, 200);
  assert.equal(isolated.payload.data.length, 0);
  assert.equal(isolated.payload.counts.total, 0);
});

test('reabre somente o próprio rascunho e preserva o contrato completo de revisão', async () => {
  const loaded = await request(recoveryPlanDetailPath(), { token: professorToken });
  assert.equal(loaded.status, 200, JSON.stringify(loaded.payload));
  assert.match(loaded.headers.get('cache-control'), /private.*no-store/);
  assert.equal(loaded.payload.plan.id, createdPlanPublicId);
  assert.equal(loaded.payload.plan.status, 'draft');
  assert.equal(loaded.payload.plan.revision, 1);
  assert.equal(loaded.payload.plan.skills.length, 1);
  assert.equal(loaded.payload.plan.groups.length, 1);

  const hidden = await request(recoveryPlanDetailPath(), { token: otherProfessorToken });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.payload.code, 'recovery_plan_not_found');
});

test('revisão otimista e auditoria impedem alterações parciais no rascunho', async () => {
  latestPlanReview = validConfirmation({
    expectedPlanRevision: 1,
    title: 'Recomposição revisada · Números racionais',
    acceptedPriorities: [{
      skillId: targetSkillId,
      suggestedQuestionCount: 5,
      rationale: 'Intervenção curta antes do próximo monitoramento.',
      group: {
        title: 'Grupo focal · Números racionais',
        objective: 'Retomar comparação de racionais com exemplos graduados.',
        studentIds: [studentPublicIds[0]],
      },
    }],
  });

  const stale = await request(recoveryPlanDetailPath(), {
    method: 'PUT',
    token: professorToken,
    body: { ...latestPlanReview, expectedPlanRevision: 99 },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'stale_plan');
  assert.equal(stale.payload.details.currentRevision, 1);

  db.exec(`
    CREATE TRIGGER test_recovery_update_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'update_learning_recovery_plan'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_update_audit_failure');
    END;
  `);
  try {
    const failed = await request(recoveryPlanDetailPath(), {
      method: 'PUT',
      token: professorToken,
      body: latestPlanReview,
    });
    assert.equal(failed.status, 500);
    assert.match(failed.payload.error, /forced_recovery_update_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_update_audit_failure');
  }
  const unchanged = await request(recoveryPlanDetailPath(), { token: professorToken });
  assert.equal(unchanged.payload.plan.revision, 1);
  assert.equal(unchanged.payload.plan.title, 'Recomposição · Diagnóstico de números');
  assert.equal(unchanged.payload.plan.groups[0].students.length, 2);

  const updated = await request(recoveryPlanDetailPath(), {
    method: 'PUT',
    token: professorToken,
    body: latestPlanReview,
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.updated, true);
  assert.equal(updated.payload.plan.revision, 2);
  assert.equal(updated.payload.plan.title, latestPlanReview.title);
  assert.equal(updated.payload.plan.skills[0].suggestedQuestionCount, 5);
  assert.equal(updated.payload.plan.groups[0].students.length, 1);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'update_learning_recovery_plan'")
      .pluck().get(),
    1
  );
  latestPlanReview = { ...latestPlanReview, expectedPlanRevision: 2 };
});

test('conclusão exige confirmação explícita, é transacional e congela o plano', async () => {
  const missingConfirmation = await request(`${recoveryPlanDetailPath()}/activate`, {
    method: 'POST',
    token: professorToken,
    body: latestPlanReview,
  });
  assert.equal(missingConfirmation.status, 400);
  assert.equal(missingConfirmation.payload.code, 'review_confirmation_required');

  db.exec(`
    CREATE TRIGGER test_recovery_activation_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'activate_learning_recovery_plan'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_activation_audit_failure');
    END;
  `);
  try {
    const failed = await request(`${recoveryPlanDetailPath()}/activate`, {
      method: 'POST',
      token: professorToken,
      body: { ...latestPlanReview, reviewConfirmed: true },
    });
    assert.equal(failed.status, 500);
    assert.match(failed.payload.error, /forced_recovery_activation_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_activation_audit_failure');
  }
  const stillDraft = await request(recoveryPlanDetailPath(), { token: professorToken });
  assert.equal(stillDraft.payload.plan.status, 'draft');
  assert.equal(stillDraft.payload.plan.revision, 2);

  const activated = await request(`${recoveryPlanDetailPath()}/activate`, {
    method: 'POST',
    token: professorToken,
    body: { ...latestPlanReview, reviewConfirmed: true },
  });
  assert.equal(activated.status, 200, JSON.stringify(activated.payload));
  assert.equal(activated.payload.activated, true);
  assert.equal(activated.payload.plan.status, 'active');
  assert.equal(activated.payload.plan.revision, 3);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'activate_learning_recovery_plan'")
      .pluck().get(),
    1
  );

  const listed = await request('/api/classes/recovery-plans?status=active', {
    token: professorToken,
  });
  assert.equal(listed.status, 200);
  assert.equal(listed.payload.data.length, 1);
  assert.equal(listed.payload.data[0].id, createdPlanPublicId);
  assert.equal(listed.payload.counts.draft, 0);
  assert.equal(listed.payload.counts.active, 1);
  assert.ok(listed.payload.data[0].activatedAt);

  const replay = await request(`${recoveryPlanDetailPath()}/activate`, {
    method: 'POST',
    token: professorToken,
    body: { ...latestPlanReview, reviewConfirmed: true },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.activated, false);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.plan.revision, 3);

  const frozen = await request(recoveryPlanDetailPath(), {
    method: 'PUT',
    token: professorToken,
    body: { ...latestPlanReview, expectedPlanRevision: 3 },
  });
  assert.equal(frozen.status, 409);
  assert.equal(frozen.payload.code, 'recovery_plan_frozen');
});

test('execução da recomposição é única, privada, transacional e acompanhável', async () => {
  const crossGradeContext = db.prepare(`
    SELECT school_class.grade_id AS class_grade_id, skill.grade_id AS skill_grade_id
    FROM school_classes school_class
    JOIN learning_recovery_plans recovery ON recovery.class_id = school_class.id
    JOIN learning_recovery_plan_skills recovery_skill ON recovery_skill.plan_id = recovery.id
    JOIN bncc_skills skill ON skill.id = recovery_skill.source_skill_id
    WHERE recovery.public_id = ?
  `).get(createdPlanPublicId);
  assert.notEqual(
    crossGradeContext.class_grade_id,
    crossGradeContext.skill_grade_id,
    'a regressão deve cobrir uma recomposição com habilidade de outro ano'
  );

  const hidden = await request(recoveryExecutionPath(), {
    method: 'POST',
    token: otherProfessorToken,
    body: { startDate: '2026-08-20', cadenceDays: 2 },
  });
  assert.equal(hidden.status, 404);
  assert.equal(hidden.payload.code, 'recovery_plan_not_found');

  const invalidDate = await request(recoveryExecutionPath(), {
    method: 'POST',
    token: professorToken,
    body: { startDate: '2026-02-30', cadenceDays: 2 },
  });
  assert.equal(invalidDate.status, 400);
  assert.equal(invalidDate.payload.code, 'invalid_request');

  db.exec(`
    CREATE TRIGGER test_recovery_execution_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'start_learning_recovery_execution'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_execution_audit_failure');
    END;
  `);
  try {
    const failed = await request(recoveryExecutionPath(), {
      method: 'POST',
      token: professorToken,
      body: { startDate: '2026-08-20', cadenceDays: 2 },
    });
    assert.equal(failed.status, 500);
    assert.match(failed.payload.error, /forced_recovery_execution_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_execution_audit_failure');
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM teaching_plans').pluck().get(), 0);

  const created = await request(recoveryExecutionPath(), {
    method: 'POST',
    token: professorToken,
    body: { startDate: '2026-08-20', cadenceDays: 2 },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.created, true);
  assert.equal(created.payload.execution.status, 'active');
  assert.equal(created.payload.execution.progress.total, 2);
  assert.equal(created.payload.execution.progress.planned, 2);
  assert.equal(created.payload.plan.execution.id, created.payload.execution.id);
  assert.ok(created.payload.plan.revision > 3);
  assert.equal(created.payload.execution.lessons[0].skills[0].code, 'EF07MA02');
  assert.equal(
    created.payload.execution.lessons[0].resources.some(({ type }) => type === 'material'),
    true
  );
  assert.equal(created.payload.execution.lessons[1].title, 'Verificar a evolução');
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'start_learning_recovery_execution'")
      .pluck().get(),
    1
  );

  const replay = await request(recoveryExecutionPath(), {
    method: 'POST',
    token: professorToken,
    body: { startDate: '2026-09-01', cadenceDays: 7 },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.created, false);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.execution.id, created.payload.execution.id);
  assert.equal(db.prepare('SELECT COUNT(*) FROM teaching_plans').pluck().get(), 1);

  const detail = await request(recoveryPlanDetailPath(), { token: professorToken });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.plan.execution.id, created.payload.execution.id);
  assert.equal(detail.payload.plan.execution.progress.percentage, 0);

  const firstLesson = created.payload.execution.lessons[0];
  const resourceOptionsPath = `${recoveryExecutionPath()}/lessons/${firstLesson.id}/resources/options`;
  const hiddenResources = await request(resourceOptionsPath, { token: otherProfessorToken });
  assert.equal(hiddenResources.status, 404);

  const resourceOptions = await request(resourceOptionsPath, { token: professorToken });
  assert.equal(resourceOptions.status, 200, JSON.stringify(resourceOptions.payload));
  assert.equal(resourceOptions.payload.lesson.phase, 'intervention');
  assert.ok(resourceOptions.payload.questions.length >= 2);
  assert.equal(resourceOptions.payload.materials.length, 1);
  const selectedQuestionIds = resourceOptions.payload.questions.slice(0, 2).map(({ id }) => id);
  const selectedMaterialIds = resourceOptions.payload.materials.map(({ id }) => id);
  // A source change must stop new exact suggestions, not erase an existing choice.
  db.exec('SAVEPOINT curation_resource_qa');
  try {
    db.prepare('INSERT INTO material_bncc_review_state(material_id,skill_id,needs_review) VALUES (?,?,1)').run(selectedMaterialIds[0], targetSkillId);
    const staleOptions = await request(resourceOptionsPath, { token: professorToken });
    assert.equal(staleOptions.payload.materials[0].selected, true); assert.equal(staleOptions.payload.materials[0].needsReview, true);
    const stalePreview = await request(previewPath(), { token: professorToken });
    assert.equal(stalePreview.payload.priorities[0].materials.length, 0);
    assert.equal(stalePreview.payload.priorities[0].materialDiscoveryCandidates[0].requiresTeacherReview, true);
    db.prepare('DELETE FROM material_bncc_skills WHERE material_id=?').run(selectedMaterialIds[0]);
    const removedOptions = await request(resourceOptionsPath, { token: professorToken });
    assert.equal(removedOptions.payload.materials[0].id, selectedMaterialIds[0]); assert.equal(removedOptions.payload.materials[0].selected, true);
    const retained = await request(resourceOptionsPath.replace('/options', ''), { method: 'PUT', token: professorToken,
      body: { expectedExecutionRevision: resourceOptions.payload.executionRevision, questionIds: selectedQuestionIds, materialIds: selectedMaterialIds } });
    assert.equal(retained.status, 200, JSON.stringify(retained.payload));
    assert.ok(retained.payload.execution.lessons[0].resources.some(r => r.type === 'material'));
  } finally { db.exec('ROLLBACK TO curation_resource_qa; RELEASE curation_resource_qa'); }

  db.exec(`
    CREATE TRIGGER test_recovery_resources_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'update_learning_recovery_resources'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_resources_audit_failure');
    END;
  `);
  try {
    const failedResources = await request(resourceOptionsPath.replace('/options', ''), {
      method: 'PUT',
      token: professorToken,
      body: {
        expectedExecutionRevision: resourceOptions.payload.executionRevision,
        questionIds: selectedQuestionIds,
        materialIds: selectedMaterialIds,
      },
    });
    assert.equal(failedResources.status, 500);
    assert.match(failedResources.payload.error, /forced_recovery_resources_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_resources_audit_failure');
  }

  const updatedResources = await request(resourceOptionsPath.replace('/options', ''), {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedExecutionRevision: resourceOptions.payload.executionRevision,
      questionIds: selectedQuestionIds,
      materialIds: selectedMaterialIds,
    },
  });
  assert.equal(updatedResources.status, 200, JSON.stringify(updatedResources.payload));
  assert.equal(
    updatedResources.payload.execution.lessons[0].resources.filter(({ type }) => type === 'question').length,
    selectedQuestionIds.length
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'update_learning_recovery_resources'")
      .pluck().get(),
    1
  );

  const stale = await request(`${recoveryExecutionPath()}/lessons/${firstLesson.id}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: 99,
      plannedDate: '2026-08-21',
      durationMinutes: 60,
      teacherNotes: 'Intervenção com exemplos graduados.',
      status: 'taught',
    },
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'stale_execution_lesson');

  const updatedFirst = await request(`${recoveryExecutionPath()}/lessons/${firstLesson.id}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: firstLesson.revision,
      plannedDate: '2026-08-21',
      durationMinutes: 60,
      teacherNotes: 'Intervenção com exemplos graduados.',
      status: 'taught',
    },
  });
  assert.equal(updatedFirst.status, 200, JSON.stringify(updatedFirst.payload));
  assert.equal(updatedFirst.payload.execution.progress.taught, 1);
  assert.equal(updatedFirst.payload.plan.execution.progress.percentage, 50);
  assert.ok(updatedFirst.payload.plan.revision > created.payload.plan.revision);
  assert.equal(updatedFirst.payload.execution.lessons[0].teacherNotes, 'Intervenção com exemplos graduados.');
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'update_learning_recovery_execution'")
      .pluck().get(),
    1
  );

  const activeList = await request('/api/classes/recovery-plans?status=active', {
    token: professorToken,
  });
  assert.equal(activeList.status, 200, JSON.stringify(activeList.payload));
  const listedExecution = activeList.payload.data.find(({ id }) => id === createdPlanPublicId)?.execution;
  assert.deepEqual(listedExecution, {
    status: 'active',
    total: 2,
    handled: 1,
    percentage: 50,
  });

  const pendingCompletion = await request(`${recoveryExecutionPath()}/complete`, {
    method: 'POST',
    token: professorToken,
    body: { expectedExecutionRevision: updatedFirst.payload.execution.revision },
  });
  assert.equal(pendingCompletion.status, 409);
  assert.equal(pendingCompletion.payload.code, 'recovery_execution_has_pending_lessons');
  assert.equal(pendingCompletion.payload.details.pending, 1);

  const monitoringLesson = updatedFirst.payload.execution.lessons[1];
  const prematureMonitoring = await request(`${recoveryExecutionPath()}/lessons/${monitoringLesson.id}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: monitoringLesson.revision,
      plannedDate: monitoringLesson.plannedDate,
      durationMinutes: 50,
      teacherNotes: 'Verificação aplicada com questões inéditas.',
      status: 'taught',
    },
  });
  assert.equal(prematureMonitoring.status, 409);
  assert.equal(prematureMonitoring.payload.code, 'monitoring_evidence_required');
  const undocumentedSkip = await request(`${recoveryExecutionPath()}/lessons/${monitoringLesson.id}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: monitoringLesson.revision,
      plannedDate: monitoringLesson.plannedDate,
      durationMinutes: 50,
      teacherNotes: 'Faltou',
      status: 'skipped',
    },
  });
  assert.equal(undocumentedSkip.status, 400);
  assert.equal(undocumentedSkip.payload.code, 'monitoring_skip_reason_required');

  const monitoringOptionsPath = `${recoveryExecutionPath()}/monitoring/options`;
  const hiddenMonitoring = await request(monitoringOptionsPath, { token: otherProfessorToken });
  assert.equal(hiddenMonitoring.status, 404);
  // Isolated fixture: distinguish an unavailable BNCC reference from an empty bank.
  const originalSkillCode = db.prepare('SELECT code FROM bncc_skills WHERE id = ?').pluck().get(targetSkillId);
  try {
    db.prepare('UPDATE bncc_skills SET code = ? WHERE id = ?').run('QA-RENAMED-SKILL', targetSkillId);
    const missingSkill = await request(monitoringOptionsPath, { token: professorToken });
    assert.equal(missingSkill.status, 200);
    assert.equal(missingSkill.payload.ready, false);
    assert.equal(missingSkill.payload.skills[0].availability, 'skill_unavailable');
    assert.equal(missingSkill.payload.skills[0].skill.code, originalSkillCode);
    assert.match(missingSkill.payload.warnings[0], /administração/);
  } finally {
    db.prepare('UPDATE bncc_skills SET code = ? WHERE id = ?').run(originalSkillCode, targetSkillId);
  }
  const originalQuestionStatuses = db.prepare('SELECT id, status FROM questions WHERE skill_id = ?').all(targetSkillId);
  db.prepare("UPDATE questions SET status = 'inactive' WHERE skill_id = ?").run(targetSkillId);
  const emptyMonitoring = await request(monitoringOptionsPath, { token: professorToken });
  assert.equal(emptyMonitoring.status, 200);
  assert.equal(emptyMonitoring.payload.ready, false);
  assert.equal(emptyMonitoring.payload.skills[0].availability, 'no_questions');
  assert.equal(emptyMonitoring.payload.questionCount, 0);
  const onlyCandidate = insertQuestion({ skillId: targetSkillId, code: 'QA-ONLY-UNUSED',
    difficulty: 'facil', source: 'teacher', ownerId: professor.id, reviewed: 0 });
  const monitoringOptions = await request(monitoringOptionsPath, { token: professorToken });
  assert.equal(monitoringOptions.status, 200, JSON.stringify(monitoringOptions.payload));
  assert.equal(monitoringOptions.payload.ready, true);
  assert.equal(monitoringOptions.payload.skills.length, 1);
  assert.equal(monitoringOptions.payload.selectionMethodology, 'unused-questions-v2');
  assert.equal(monitoringOptions.payload.skills[0].minimum, 1);
  assert.equal(monitoringOptions.payload.skills[0].recommended, 2);
  assert.deepEqual(monitoringOptions.payload.skills[0].questions.map(q => q.id), [onlyCandidate.id]);
  const monitoringQuestions = monitoringOptions.payload.skills
    .flatMap(({ questions }) => questions.map(({ id, hasImage }) => ({ id, showImage: hasImage })));

  const questionSetCountBefore = db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get();
  const existingSetTitles = db.prepare('SELECT id, title, description FROM question_sets ORDER BY id').all();
  const cycleCountBefore = db.prepare('SELECT COUNT(*) FROM learning_recovery_monitoring_cycles').pluck().get();
  const auditCountBefore = db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get();
  // A question can change between selection and creation; revalidate inside the transaction.
  for (const change of ['inactive', 'invalid_answer_key']) {
    if (change === 'inactive') db.prepare("UPDATE questions SET status = 'inactive' WHERE id = ?").run(onlyCandidate.id);
    else db.prepare('UPDATE question_options SET is_correct = 0 WHERE question_id = ?').run(onlyCandidate.id);
    const staleQuestion = await request(`${recoveryExecutionPath()}/monitoring`, {
      method: 'POST', token: professorToken,
      body: { expectedExecutionRevision: monitoringOptions.payload.executionRevision, questions: monitoringQuestions },
    });
    assert.equal(staleQuestion.status, 409);
    assert.equal(staleQuestion.payload.code, 'monitoring_questions_unavailable');
    assert.equal(db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get(), questionSetCountBefore);
    assert.equal(db.prepare('SELECT COUNT(*) FROM learning_recovery_monitoring_cycles').pluck().get(), cycleCountBefore);
    assert.equal(db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get(), auditCountBefore);
    db.prepare("UPDATE questions SET status = 'active' WHERE id = ?").run(onlyCandidate.id);
    db.prepare('UPDATE question_options SET is_correct = 1 WHERE id = ?').run(onlyCandidate.options.A);
  }
  db.exec(`
    CREATE TRIGGER test_recovery_monitoring_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'create_learning_recovery_monitoring'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_monitoring_audit_failure');
    END;
  `);
  try {
    const failedMonitoring = await request(`${recoveryExecutionPath()}/monitoring`, {
      method: 'POST',
      token: professorToken,
      body: {
        expectedExecutionRevision: monitoringOptions.payload.executionRevision,
        questions: monitoringQuestions,
      },
    });
    assert.equal(failedMonitoring.status, 500);
    assert.match(failedMonitoring.payload.error, /forced_recovery_monitoring_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_monitoring_audit_failure');
  }
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get(), questionSetCountBefore);

  const createdMonitoring = await request(`${recoveryExecutionPath()}/monitoring`, {
    method: 'POST',
    token: professorToken,
    body: {
      expectedExecutionRevision: monitoringOptions.payload.executionRevision,
      questions: monitoringQuestions,
    },
  });
  assert.equal(createdMonitoring.status, 201, JSON.stringify(createdMonitoring.payload));
  assert.equal(createdMonitoring.payload.monitoring.state, 'needs_application');
  const createdSetId = createdMonitoring.payload.monitoring.questionSet.id;
  const expectedTitle = `Verificação · ${createdMonitoring.payload.plan.title}`.slice(0, 200);
  assert.equal(createdMonitoring.payload.monitoring.questionSet.title, expectedTitle);
  assert.equal(db.prepare('SELECT title FROM question_sets WHERE id=?').pluck().get(createdSetId), expectedTitle);
  assert.equal(db.prepare("SELECT entity_title FROM activity_log WHERE action='create_learning_recovery_monitoring' ORDER BY id DESC LIMIT 1").pluck().get(), expectedTitle);
  assert.deepEqual(db.prepare('SELECT id, title, description FROM question_sets WHERE id<>? ORDER BY id').all(createdSetId), existingSetTitles);
  const createdItems = db.prepare('SELECT question_id, option_order FROM question_set_items WHERE question_set_id = ?').all(createdSetId);
  assert.deepEqual(createdItems.map(item => item.question_id), [onlyCandidate.id]);
  assert.equal([...createdItems[0].option_order].sort().join(''), 'ABCD');
  assert.equal(db.prepare('SELECT contains_author_questions FROM question_sets WHERE id = ?').pluck().get(createdSetId), 1);
  assert.equal(db.prepare('SELECT is_correct FROM question_options WHERE id = ?').pluck().get(onlyCandidate.options.A), 1);
  const replayMonitoring = await request(`${recoveryExecutionPath()}/monitoring`, {
    method: 'POST', token: professorToken,
    body: { expectedExecutionRevision: monitoringOptions.payload.executionRevision, questions: monitoringQuestions },
  });
  assert.equal(replayMonitoring.status, 200);
  assert.equal(replayMonitoring.payload.monitoring.questionSet.id, createdSetId);
  assert.equal(replayMonitoring.payload.monitoring.questionSet.title, expectedTitle);
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get(), questionSetCountBefore + 1);
  for (const question of originalQuestionStatuses) db.prepare('UPDATE questions SET status = ? WHERE id = ?').run(question.status, question.id);
  const cycleBeforeApplication = await request(cyclePath(), { token: professorToken });
  assert.equal(cycleBeforeApplication.status, 200, JSON.stringify(cycleBeforeApplication.payload));
  assert.equal(cycleBeforeApplication.payload.plans[0].monitoring.state, 'needs_application');
  assert.equal(cycleBeforeApplication.payload.plans[0].interventionHandled, cycleBeforeApplication.payload.plans[0].interventionCount);
  assert.equal(createdMonitoring.payload.plan.execution.monitoring.questionSet.id, createdMonitoring.payload.monitoring.questionSet.id);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'create_learning_recovery_monitoring'")
      .pluck().get(),
    1
  );
  assert.throws(
    () => db.prepare('UPDATE question_sets SET title = ? WHERE id = ?')
      .run('Tentativa de alteração', createdMonitoring.payload.monitoring.questionSet.id),
    /recovery_monitoring_question_set_is_frozen/
  );

  const preparationPath = `/api/classes/${classPublicId}/assessments/sources/${createdSetId}/preparation`;
  const preservedGroups = db.prepare('SELECT * FROM learning_recovery_student_group_members ORDER BY group_id, student_id').all();
  const auditBeforePreparation = db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get();
  const preparation = await request(preparationPath, { token: professorToken });
  assert.equal(preparation.status, 200, JSON.stringify(preparation.payload));
  assert.deepEqual(preparation.payload.recovery, { participantIds: [studentPublicIds[0]], unavailableCount: 0 });
  assert.equal(preparation.payload.existingAssignment, null);
  assert.equal(preparation.payload.source.title, expectedTitle);
  const { parseAssessmentPreparation } = await import('../../client/src/services/assessmentPreparation.mjs');
  parseAssessmentPreparation(preparation.payload, createdSetId);
  assert.equal((await request(preparationPath)).status, 401);
  assert.equal((await request(preparationPath, { token: otherProfessorToken })).status, 404);
  assert.equal(db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get(), auditBeforePreparation);

  // The synthetic roster changes temporarily; historical group membership stays intact.
  const enrollment = db.prepare(`SELECT enrollment.* FROM school_class_enrollments enrollment JOIN students student ON student.id=enrollment.student_id WHERE enrollment.class_id=? AND student.public_id=?`).get(classId, studentPublicIds[0]);
  db.prepare("UPDATE school_class_enrollments SET status='withdrawn', ended_at=CURRENT_TIMESTAMP WHERE id=?").run(enrollment.id);
  try {
    const inactive = await request(preparationPath, { token: professorToken });
    assert.deepEqual(inactive.payload.recovery, { participantIds: [], unavailableCount: 1 });
  } finally { db.prepare('UPDATE school_class_enrollments SET status=?, ended_at=? WHERE id=?').run(enrollment.status, enrollment.ended_at, enrollment.id); }
  assert.deepEqual(db.prepare('SELECT * FROM learning_recovery_student_group_members ORDER BY group_id, student_id').all(), preservedGroups);

  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='classes.learning_recovery'").run();
  try {
    assert.equal((await request(preparationPath, { token: professorToken })).status, 404);
    const blockedCreate = await request(`/api/classes/${classPublicId}/assessments`, { method: 'POST', token: professorToken, body: { sourceQuestionSetId: createdSetId, participantIds: studentPublicIds } });
    assert.equal(blockedCreate.status, 404);
  } finally { db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='classes.learning_recovery'").run(); }

  const alternateClass = 'class-verification-wrong-context-0001';
  db.prepare(`INSERT INTO school_classes (public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by)
    SELECT ?, owner_teacher_id, 'Outra turma sintética', grade_id, academic_year, created_by, updated_by FROM school_classes WHERE id=?`).run(alternateClass, classId);
  assert.equal((await request(preparationPath.replace(classPublicId, alternateClass), { token: professorToken })).status, 404);
  const wrongClass = await request(`/api/classes/${alternateClass}/assessments`, { method: 'POST', token: professorToken, body: { sourceQuestionSetId: createdSetId, participantIds: studentPublicIds } });
  assert.equal(wrongClass.status, 404);

  const monitorApplication = await request(`/api/classes/${classPublicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: createdMonitoring.payload.monitoring.questionSet.id,
      participantIds: studentPublicIds,
      randomizeQuestions: false,
      randomizeOptions: false,
    },
  });
  assert.equal(monitorApplication.status, 201, JSON.stringify(monitorApplication.payload));
  assert.equal(monitorApplication.payload.status, 'draft');
  assert.equal(
    db.prepare('SELECT assignment_id IS NOT NULL FROM learning_recovery_monitoring_cycles').pluck().get(),
    1
  );

  const duplicateApplication = await request(`/api/classes/${classPublicId}/assessments`, {
    method: 'POST',
    token: professorToken,
    body: {
      sourceQuestionSetId: createdMonitoring.payload.monitoring.questionSet.id,
      participantIds: studentPublicIds,
    },
  });
  assert.equal(duplicateApplication.status, 409);
  const existingPreparation = await request(preparationPath, { token: professorToken });
  assert.equal(existingPreparation.payload.existingAssignment.id, monitorApplication.payload.id);
  assert.equal(existingPreparation.payload.existingAssignment.participantCount, studentPublicIds.length);
  assert.equal(existingPreparation.payload.existingAssignment.status, 'draft');
  parseAssessmentPreparation(existingPreparation.payload, createdSetId);

  const openedMonitoring = await request(`/api/classes/${classPublicId}/assessments/${monitorApplication.payload.id}/delivery`, {
    method: 'PATCH',
    token: professorToken,
    body: { expectedRevision: monitorApplication.payload.revision, action: 'open' },
  });
  assert.equal(openedMonitoring.status, 200, JSON.stringify(openedMonitoring.payload));

  const monitoringAssignmentInternalId = db.prepare(`
    SELECT id FROM class_assessment_assignments WHERE public_id = ?
  `).pluck().get(monitorApplication.payload.id);
  const monitoringResponses = db.prepare(`
    SELECT item.id AS item_id, option.id AS option_id
    FROM class_assessment_items item
    JOIN class_assessment_item_options option
      ON option.assessment_item_id = item.id
      AND option.assignment_id = item.assignment_id
      AND option.is_correct = 1
    WHERE item.assignment_id = ?
    ORDER BY item.sort_order, item.id
  `).all(monitoringAssignmentInternalId).map(({ item_id: itemId, option_id: optionId }) => ({
    itemId,
    optionId,
  }));
  const savedMonitoring = await request(`/api/classes/${classPublicId}/assessments/${monitorApplication.payload.id}/results/participants/${studentPublicIds[0]}`, {
    method: 'PUT',
    token: professorToken,
    body: { expectedRevision: 0, responses: monitoringResponses },
  });
  assert.equal(savedMonitoring.status, 200, JSON.stringify(savedMonitoring.payload));
  const submittedMonitoring = await request(`/api/classes/${classPublicId}/assessments/${monitorApplication.payload.id}/results/participants/${studentPublicIds[0]}/submit`, {
    method: 'POST',
    token: professorToken,
    body: { expectedRevision: savedMonitoring.payload.attempt.revision },
  });
  assert.equal(submittedMonitoring.status, 200, JSON.stringify(submittedMonitoring.payload));

  const currentMonitorRevision = db.prepare(`
    SELECT revision FROM class_assessment_assignments WHERE id = ?
  `).pluck().get(monitoringAssignmentInternalId);
  const closedMonitoring = await request(`/api/classes/${classPublicId}/assessments/${monitorApplication.payload.id}/delivery`, {
    method: 'PATCH',
    token: professorToken,
    body: { expectedRevision: currentMonitorRevision, action: 'close' },
  });
  assert.equal(closedMonitoring.status, 200, JSON.stringify(closedMonitoring.payload));
  const closedPreparation = await request(preparationPath, { token: professorToken });
  assert.equal(closedPreparation.payload.existingAssignment.id, monitorApplication.payload.id);
  assert.equal(closedPreparation.payload.existingAssignment.status, 'closed');
  assert.equal(closedPreparation.payload.existingAssignment.participantCount, studentPublicIds.length);

  const evidencePlan = await request(recoveryPlanDetailPath(), { token: professorToken });
  assert.equal(evidencePlan.status, 200, JSON.stringify(evidencePlan.payload));
  assert.equal(evidencePlan.payload.plan.execution.monitoring.state, 'evidence_ready');
  assert.equal(evidencePlan.payload.plan.execution.monitoring.comparison.usesTri, false);
  assert.equal(evidencePlan.payload.plan.execution.monitoring.comparison.skills[0].monitoringRate, 100);
  const pairedComparison = evidencePlan.payload.plan.execution.monitoring.comparison;
  assert.equal(pairedComparison.methodology, 'matched-students-v2');
  assert.equal(pairedComparison.skills[0].cohort.studentCount, 1);
  // The earlier stale-evidence test submits the third participant before this plan.
  assert.equal(pairedComparison.skills[0].cohort.diagnosticStudentCount, 3);
  assert.equal(pairedComparison.skills[0].cohort.monitoringStudentCount, 1);
  const baselineSnapshot = db.prepare(`SELECT success_rate_snapshot, opportunity_count
    FROM learning_recovery_plan_skills WHERE plan_id = (SELECT id FROM learning_recovery_plans WHERE public_id = ?)
    ORDER BY priority,id LIMIT 1`).get(createdPlanPublicId);
  assert.deepEqual(pairedComparison.skills[0].diagnosticSnapshot, {
    rate: baselineSnapshot.success_rate_snapshot, opportunities: baselineSnapshot.opportunity_count,
  });
  const { validateRecoveryComparison } = await import('../../client/src/services/recoveryComparisonView.mjs');
  validateRecoveryComparison(pairedComparison);
  const cycleAfterVerification = await request(cyclePath(), { token: professorToken });
  assert.equal(cycleAfterVerification.payload.class.institution.status, 'verified');
  assert.equal(cycleAfterVerification.payload.plans[0].monitoring.state, 'evidence_ready');
  assert.equal(cycleAfterVerification.payload.plans[0].monitoring.comparison.skills[0].monitoringRate, 100);
  assert.notEqual(cycleAfterVerification.payload.evidenceHash, cycleBeforeApplication.payload.evidenceHash);
  assert.doesNotMatch(JSON.stringify(cycleAfterVerification.payload), /Alice Estudante|Bruno Estudante|studentsNeedingFollowUp/);
  const decision = await saveCycle(feedbackBody(cycleAfterVerification.payload, {
    verification: 'Após a nova atividade, avançar gradualmente e observar a participação dos ausentes.'
  }), 'cycle-final-decision-key-0001');
  assert.equal(decision.status, 201, JSON.stringify(decision.payload));
  assert.equal(decision.payload.feedback.evidence.verifications[0].state, 'evidence_ready');
  assert.equal(decision.payload.feedback.evidence.verifications[0].comparison.usesTri, false);
  assert.deepEqual(decision.payload.feedback.evidence.verifications[0].comparison.skills, pairedComparison.skills);
  const preservedEvidence = db.prepare('SELECT evidence_json, evidence_hash FROM pedagogical_feedback_versions ORDER BY id').all();
  await request(cyclePath(), { token: professorToken });
  assert.deepEqual(db.prepare('SELECT evidence_json, evidence_hash FROM pedagogical_feedback_versions ORDER BY id').all(), preservedEvidence);

  const currentMonitoringLesson = evidencePlan.payload.plan.execution.lessons
    .find(({ phase }) => phase === 'monitoring');
  const updatedMonitoring = await request(`${recoveryExecutionPath()}/lessons/${currentMonitoringLesson.id}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      expectedRevision: currentMonitoringLesson.revision,
      plannedDate: currentMonitoringLesson.plannedDate,
      durationMinutes: 50,
      teacherNotes: 'Verificação aplicada com questões inéditas e resultados analisados.',
      status: 'taught',
    },
  });
  assert.equal(updatedMonitoring.status, 200, JSON.stringify(updatedMonitoring.payload));
  assert.equal(updatedMonitoring.payload.execution.progress.percentage, 100);

  db.exec(`
    CREATE TRIGGER test_recovery_execution_completion_audit_failure
    BEFORE INSERT ON activity_log
    WHEN NEW.action = 'complete_learning_recovery_execution'
    BEGIN
      SELECT RAISE(ABORT, 'forced_recovery_execution_completion_audit_failure');
    END;
  `);
  try {
    const failedCompletion = await request(`${recoveryExecutionPath()}/complete`, {
      method: 'POST',
      token: professorToken,
      body: { expectedExecutionRevision: updatedMonitoring.payload.execution.revision },
    });
    assert.equal(failedCompletion.status, 500);
    assert.match(failedCompletion.payload.error, /forced_recovery_execution_completion_audit_failure/);
  } finally {
    db.exec('DROP TRIGGER IF EXISTS test_recovery_execution_completion_audit_failure');
  }
  assert.equal(db.prepare('SELECT status FROM teaching_plans').pluck().get(), 'active');
  assert.equal(db.prepare('SELECT status FROM learning_recovery_plans').pluck().get(), 'active');

  const completed = await request(`${recoveryExecutionPath()}/complete`, {
    method: 'POST',
    token: professorToken,
    body: { expectedExecutionRevision: updatedMonitoring.payload.execution.revision },
  });
  assert.equal(completed.status, 200, JSON.stringify(completed.payload));
  assert.equal(completed.payload.completed, true);
  assert.equal(completed.payload.plan.status, 'completed');
  assert.equal(completed.payload.plan.execution.status, 'completed');
  assert.equal(completed.payload.plan.execution.progress.percentage, 100);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'complete_learning_recovery_execution'")
      .pluck().get(),
    1
  );
});

test('não permite confirmar plano da aplicação de outro professor', async () => {
  const response = await request(recoveryPlanPath(), {
    method: 'POST',
    token: otherProfessorToken,
    headers: { 'Idempotency-Key': 'recovery-other-teacher-key-0001' },
    body: validConfirmation(),
  });
  assert.equal(response.status, 404);
  assert.equal(response.payload.code, 'assessment_not_found');
});

test('separa descoberta por ano de recomendação com vínculo BNCC validado', async () => {
  db.prepare('DELETE FROM material_bncc_skills WHERE skill_id = ?').run(targetSkillId);
  const preview = await request(previewPath(), { token: professorToken });
  assert.equal(preview.status, 200, JSON.stringify(preview.payload));
  const priority = preview.payload.priorities[0];
  assert.equal(priority.materials.length, 0);
  assert.equal(priority.materialDiscoveryCandidates.length, 1);
  assert.equal(priority.materialDiscoveryCandidates[0].matchBasis, 'same_grade_discovery');
  assert.equal(priority.materialDiscoveryCandidates[0].requiresTeacherReview, true);
  assert.match(preview.payload.warnings.join(' '), /vínculo BNCC validado/);
});

test('histórico paginado não duplica revisões e respeita bloqueio da recomposição', async () => {
  for (let index = 0; index < 9; index++) {
    const detail = await request(cyclePath(), { token: professorToken });
    assert.equal((await saveCycle(feedbackBody(detail.payload, { objective: `Objetivo de aprendizagem refinado na revisão de teste ${index}.` }), `cycle-pagination-key-000${index}`)).status, 201);
  }
  const first = await request(`${cyclePath()}/feedback`, { token: professorToken });
  assert.equal(first.payload.data.length, 10);
  assert.equal(first.payload.nextBefore, first.payload.data[9].revision);
  const second = await request(`${cyclePath()}/feedback?before=${first.payload.nextBefore}`, { token: professorToken });
  const revisions = [...first.payload.data, ...second.payload.data].map(item => item.revision);
  assert.equal(new Set(revisions).size, revisions.length);
  assert.equal(revisions.length, db.prepare('SELECT COUNT(*) FROM pedagogical_feedback_versions').pluck().get());
  assert.equal(second.payload.nextBefore, null);
  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='classes.learning_recovery'").run();
  try {
    const hidden = await request(cyclePath(), { token: professorToken });
    assert.equal(hidden.payload.capabilities.recovery, false);
    assert.deepEqual(hidden.payload.plans, []);
    assert.equal(hidden.payload.feedback.evidence.verifications, undefined);
    const history = await request(`${cyclePath()}/feedback`, { token: professorToken });
    assert.equal(history.payload.data.every(row => !row.evidence.verifications), true);
  } finally { db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='classes.learning_recovery'").run(); }
});

async function exportPedagogicalReport(body, token = professorToken, urlPath = `${cyclePath()}/report/export`) {
  const response = await fetch(`${baseUrl}${urlPath}`, { method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body) });
  return { status: response.status, headers: response.headers, text: await response.text() };
}
const reportAuditCount = () => db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='pedagogical_report_exported'").pluck().get();
function printPedagogicalReport(body, token = professorToken) {
  return request(`${cyclePath()}/report/print`, { method: 'POST', token, body });
}
const printAuditCount = () => db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='pedagogical_report_print_prepared'").pluck().get();

test('relatório reúne os dados reais do ciclo sem escrever nem expor estudantes ou respostas', async () => {
  const before = db.prepare('SELECT total_changes()').pluck().get();
  const response = await request(`${cyclePath()}/report`, { token: professorToken });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), before);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const detail = (await request(cyclePath(), { token: professorToken })).payload;
  const report = response.payload;
  const { parsePedagogicalReport } = await import('../../client/src/services/pedagogicalReportView.mjs');
  parsePedagogicalReport(report, classPublicId, assessmentPublicId);
  assert.deepEqual(report.overview, detail.evidence.overview);
  assert.equal(report.feedback.revision, detail.feedback.revision);
  assert.equal(report.plans.length, detail.plans.length);
  assert.deepEqual(report.plans[0].monitoring.comparison.skills[0].cohort, detail.plans[0].monitoring.comparison.skills[0].cohort);
  assert.equal(report.plans[0].monitoring.comparison.methodology, 'matched-students-v2');
  assert.doesNotMatch(JSON.stringify(report), /Alice|Bruno|displayName|studentsNeedingFollowUp|attemptId|optionId|correctOption|questionSetId|request_key|evidenceHash/);
  const repeated = await request(`${cyclePath()}/report`, { token: professorToken });
  assert.equal(repeated.payload.revision, report.revision);
});

test('relatório e CSV exigem autenticação, titularidade e flags em toda requisição', async () => {
  const path = `${cyclePath()}/report`;
  const report = (await request(path, { token: professorToken })).payload;
  const body = { expectedRevision: report.revision, privacyConfirmed: true };
  for (const [token, status] of [[undefined, 401], [tokenFor(admin), 403], [otherProfessorToken, 404]]) {
    assert.equal((await request(path, { token })).status, status);
    assert.equal((await exportPedagogicalReport(body, token || null)).status, status);
    assert.equal((await printPedagogicalReport(body, token || null)).status, status);
  }
  assert.equal((await request(`${path.replace(assessmentPublicId, 'missing-assessment')}`, { token: professorToken })).status, 404);
  assert.equal((await exportPedagogicalReport(body, professorToken, `${path.replace(classPublicId, 'missing-class')}/export`)).status, 404);
  for (const flag of ['pedagogy.operational_cycle', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results']) {
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run(flag);
    try {
      assert.equal((await request(path, { token: professorToken })).status, 404);
      assert.equal((await exportPedagogicalReport(body)).status, 404);
      assert.equal((await printPedagogicalReport(body)).status, 404);
    } finally { db.prepare('UPDATE feature_flags SET master_enabled=1 WHERE flag_key=?').run(flag); }
  }
});

test('CSV confere revisão e confirmação, usa o formato seguro e audita sem texto pedagógico', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const before = reportAuditCount();
  for (const body of [{}, { expectedRevision: report.revision, privacyConfirmed: false },
    { expectedRevision: report.revision, privacyConfirmed: true, report: {} },
    { expectedRevision: 'bad', privacyConfirmed: true }]) {
    assert.equal((await exportPedagogicalReport(body)).status, 400);
  }
  assert.equal(reportAuditCount(), before);
  const exported = await exportPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true });
  assert.equal(exported.status, 200, exported.text);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.headers.get('content-disposition'), /attachment; filename="relatorio-da-turma.csv"/);
  assert.equal(exported.headers.get('x-report-revision'), report.revision);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  assert.match(exported.headers.get('cache-control'), /no-store/);
  assert.match(exported.text, /"Seção","Referência","Informação","Valor"/);
  assert.match(exported.text, /Média apenas das correções concluídas/);
  assert.match(exported.text, /Estudantes comparados nas duas etapas/);
  assert.ok(exported.text.includes(report.feedback.objective));
  assert.doesNotMatch(exported.text, /Alice|displayName|correctOption|studentsNeedingFollowUp/);
  assert.equal(reportAuditCount(), before + 1);
  const audit = db.prepare("SELECT metadata FROM activity_log WHERE action='pedagogical_report_exported' ORDER BY id DESC LIMIT 1").pluck().get();
  assert.deepEqual(JSON.parse(audit), { classId: classPublicId, assessmentId: assessmentPublicId, reportRevision: report.revision, format: 'csv' });
});

test('impressão usa a mesma revisão conferida e só entrega a cópia após auditoria', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const before = printAuditCount();
  for (const body of [{}, { expectedRevision: report.revision, privacyConfirmed: false },
    { expectedRevision: report.revision, privacyConfirmed: true, html: '<h1>Não aceito</h1>' },
    { expectedRevision: 'b'.repeat(64), privacyConfirmed: true }]) {
    const invalid = await printPedagogicalReport(body);
    assert.ok([400, 409].includes(invalid.status), JSON.stringify(invalid.payload));
    assert.equal(printAuditCount(), before);
  }
  const printed = await printPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true });
  assert.equal(printed.status, 200, JSON.stringify(printed.payload));
  assert.match(printed.headers.get('cache-control'), /no-store/);
  assert.match(printed.headers.get('content-type'), /application\/json/);
  assert.equal(printed.headers.get('x-report-revision'), report.revision);
  assert.equal(printAuditCount(), before + 1);
  const { generatedAt: _oldTime, ...oldContent } = report;
  const { generatedAt: _newTime, ...newContent } = printed.payload;
  assert.deepEqual(newContent, oldContent);
  const { getPedagogicalReportPrintDocument } = await import('../../client/src/services/pedagogicalReportPrint.mjs');
  const html = getPedagogicalReportPrintDocument(printed.payload, classPublicId, assessmentPublicId);
  assert.ok(html.includes(report.revision));
  assert.match(html, /comparados? nas duas etapas/);
  assert.doesNotMatch(html, /Alice|displayName|correctOption|studentsNeedingFollowUp/);
  const audit = db.prepare("SELECT metadata FROM activity_log WHERE action='pedagogical_report_print_prepared' ORDER BY id DESC LIMIT 1").pluck().get();
  assert.deepEqual(JSON.parse(audit), { classId: classPublicId, assessmentId: assessmentPublicId, reportRevision: report.revision, format: 'print' });
});

test('impressão falha fechada quando auditoria falha ou turma/aplicação não corresponde', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const body = { expectedRevision: report.revision, privacyConfirmed: true };
  const before = printAuditCount();
  assert.equal((await request(`${cyclePath().replace(classPublicId, 'another-class')}/report/print`, { method: 'POST', token: professorToken, body })).status, 404);
  assert.equal((await request(`${cyclePath().replace(assessmentPublicId, 'another-assessment')}/report/print`, { method: 'POST', token: professorToken, body })).status, 404);
  db.exec(`CREATE TRIGGER test_report_print_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='pedagogical_report_print_prepared'
    BEGIN SELECT RAISE(ABORT,'forced_print_audit_failure'); END;`);
  try {
    const response = await printPedagogicalReport(body);
    assert.equal(response.status, 500);
    assert.equal(response.payload.class, undefined);
    assert.equal(printAuditCount(), before);
  } finally { db.exec('DROP TRIGGER test_report_print_audit_failure'); }
});

test('CSV informa recorte de planos e mantém avisos, ausências e células potencialmente perigosas', async () => {
  const { formatReportCsv } = require('../src/services/pedagogicalReport');
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  report.morePlans = true; report.feedbackStale = true;
  let csv = formatReportCsv(report);
  assert.match(csv, /Somente os 20 planos mais recentes/);
  assert.match(csv, /A referência mudou desde este registro/);
  assert.ok(csv.startsWith('\uFEFF')); assert.ok(csv.includes('\r\n'));
  report.feedback = null; report.overview = null; report.skills = []; report.plans = [];
  csv = formatReportCsv(report);
  assert.match(csv, /Resultados indisponíveis nesta etapa/);
  assert.match(csv, /Nenhum registro salvo/);
  assert.match(csv, /Nenhum plano associado/);
  for (const value of ['=1+1', '+formula', '-formula', '@formula', '\t=1+1', '\r\n=1+1']) {
    report.class.name = value;
    assert.ok(formatReportCsv(report).includes(`"'${value}"`));
  }
  report.class.name = 'Turma "A", teste\ncontinua';
  assert.ok(formatReportCsv(report).includes('"Turma ""A"", teste\ncontinua"'));
});

test('revogação de papel e bloqueio emergencial impedem leitura e CSV do relatório', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const body = { expectedRevision: report.revision, privacyConfirmed: true };
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(professor.id);
  try {
    assert.equal((await request(`${cyclePath()}/report`, { token: professorToken })).status, 401);
    assert.equal((await exportPedagogicalReport(body)).status, 401);
    assert.equal((await printPedagogicalReport(body)).status, 401);
    const refreshedToken = require('../src/services/authSessions').issueUserToken(professor.id);
    assert.equal((await request(`${cyclePath()}/report`, { token: refreshedToken })).status, 403);
    assert.equal((await exportPedagogicalReport(body, refreshedToken)).status, 403);
    assert.equal((await printPedagogicalReport(body, refreshedToken)).status, 403);
  } finally {
    db.prepare("UPDATE users SET role='professor' WHERE id=?").run(professor.id);
    professorToken = require('../src/services/authSessions').issueUserToken(professor.id);
  }
  db.prepare(`UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Teste do relatório',
    kill_switch_activated_by=?,kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='pedagogy.operational_cycle'`).run(admin.id);
  try {
    assert.equal((await request(`${cyclePath()}/report`, { token: professorToken })).status, 404);
    assert.equal((await exportPedagogicalReport(body)).status, 404);
    assert.equal((await printPedagogicalReport(body)).status, 404);
  } finally {
    db.prepare("UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key='pedagogy.operational_cycle'").run();
  }
});

test('alteração de contexto bloqueia o CSV antigo, sem auditoria de sucesso', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const before = reportAuditCount();
  db.prepare('UPDATE school_classes SET name=? WHERE id=?').run('Turma renomeada para conferir o relatório', classId);
  try {
    const conflict = await exportPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true });
    assert.equal(conflict.status, 409); assert.match(conflict.text, /report_changed/);
    assert.equal((await printPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true })).status, 409);
    assert.equal(reportAuditCount(), before);
    const refreshed = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
    assert.notEqual(refreshed.revision, report.revision);
  } finally { db.prepare('UPDATE school_classes SET name=? WHERE id=?').run(report.class.name, classId); }
});

test('nova revisão docente invalida exportação anterior e fórmulas não são executáveis no CSV', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const detail = (await request(cyclePath(), { token: professorToken })).payload;
  const objective = '=HYPERLINK("https://invalid.example","Texto de teste")';
  assert.equal((await saveCycle(feedbackBody(detail, { objective }), 'report-formula-test-key-0001')).status, 201);
  const obsolete = await exportPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true });
  assert.equal(obsolete.status, 409);
  assert.equal((await printPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true })).status, 409);
  const refreshed = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  assert.equal(refreshed.feedback.objective, objective);
  const csv = await exportPedagogicalReport({ expectedRevision: refreshed.revision, privacyConfirmed: true });
  assert.equal(csv.status, 200);
  assert.ok(csv.text.includes('"\'=HYPERLINK(""https://invalid.example"",""Texto de teste"")"'));
});

test('falha de auditoria impede entregar o CSV', async () => {
  const report = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  const before = reportAuditCount();
  db.exec(`CREATE TRIGGER test_report_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='pedagogical_report_exported'
    BEGIN SELECT RAISE(ABORT,'forced_report_audit_failure'); END;`);
  try {
    const response = await exportPedagogicalReport({ expectedRevision: report.revision, privacyConfirmed: true });
    assert.equal(response.status, 500);
    assert.doesNotMatch(response.headers.get('content-type'), /text\/csv/);
    assert.equal(reportAuditCount(), before);
  } finally { db.exec('DROP TRIGGER test_report_audit_failure'); }
});

test('desabilitar instituição e recomposição remove contexto e comparação e invalida exportação antiga', async () => {
  const full = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
  for (const flag of ['institutions.read_model', 'classes.learning_recovery']) {
    db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE flag_key=?').run(flag);
  }
  try {
    const reduced = (await request(`${cyclePath()}/report`, { token: professorToken })).payload;
    assert.deepEqual(reduced.plans, []);
    assert.equal(reduced.class.institution.status, 'unavailable');
    assert.equal(reduced.class.institution.school, undefined);
    assert.notEqual(reduced.revision, full.revision);
    assert.equal((await exportPedagogicalReport({ expectedRevision: full.revision, privacyConfirmed: true })).status, 409);
    assert.equal((await printPedagogicalReport({ expectedRevision: full.revision, privacyConfirmed: true })).status, 409);
    const printable = await printPedagogicalReport({ expectedRevision: reduced.revision, privacyConfirmed: true });
    assert.equal(printable.status, 200);
    assert.deepEqual(printable.payload.plans, []);
    assert.equal(printable.payload.class.institution.school, undefined);
    const csv = await exportPedagogicalReport({ expectedRevision: reduced.revision, privacyConfirmed: true });
    assert.equal(csv.status, 200);
    assert.match(csv.text, /Recomposição não habilitada/);
    assert.doesNotMatch(csv.text, /Estudantes comparados nas duas etapas|Escola municipal de teste/);
    const { parsePedagogicalReport } = await import('../../client/src/services/pedagogicalReportView.mjs');
    parsePedagogicalReport(reduced, classPublicId, assessmentPublicId);
  } finally {
    for (const flag of ['institutions.read_model', 'classes.learning_recovery'])
      db.prepare('UPDATE feature_flags SET master_enabled=1 WHERE flag_key=?').run(flag);
  }
});

test('interface do ciclo com API real e banco sintético (QA opt-in)', { skip: process.env.CYCLE_BROWSER_QA !== '1', timeout: 180000 }, async () => {
  enableFlagForUser('question_bank.diagnostic_generator', professor);
  const report = await require('../scripts/ci/pedagogicalCycleBrowser.cjs').runPedagogicalCycleBrowser({
    app, db, baseUrl, teacher: professor, token: professorToken, classPublicId, assessmentPublicId,
  });
  assert.equal(report.status, 'passed');
  console.log(JSON.stringify(report));
});

test('fixture visual restaura credenciais e versão de autenticação mesmo após falha', () => {
  const { verifyUserToken } = require('../src/services/authSessions');
  const before = fixtureAuthState();
  const teacherBefore = before.find(user => user.id === professor.id);
  const failure = new Error('Falha sintética da inspeção');
  assert.equal(verifyUserToken(professorToken).user.id, professor.id);
  assert.throws(() => {
    try {
      db.prepare("UPDATE users SET password='hash-da-inspecao', role='admin' WHERE id=?").run(professor.id);
      assert.equal(db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(professor.id), teacherBefore.auth_version + 1);
      // The JWT itself is unexpired; changing credentials revoked its session.
      assert.doesNotThrow(() => jwt.verify(professorToken, process.env.JWT_SECRET));
      assert.throws(() => verifyUserToken(professorToken), /revoked_session/);
      throw failure;
    } finally {
      restoreFixtureAuthState(before);
    }
  }, error => error === failure);
  assert.deepEqual(fixtureAuthState(), before);
  assert.equal(verifyUserToken(professorToken).user.id, professor.id);
});

test('inventário visual de todas as rotas com base sintética (auditoria opt-in)', { skip: process.env.SCREEN_LAYOUT_AUDIT !== '1', timeout: process.env.PLATFORM_JOURNEY_AUDIT === '1' ? 10860000 : 600000 }, async () => {
  // The browser bootstrap enables synthetic accounts and homologation access.
  // Always put those controls back, including when setup or Chromium fails, so
  // later API tests still exercise master switches and unavailable contexts.
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const config = require('../src/config');
  const configBefore = {
    appEnvironment: config.appEnvironment, smtp: { ...config.smtp },
    classEntryCodeSecret: config.classEntryCodeSecret,
    studentAssessmentAccessSecret: config.studentAssessmentAccessSecret,
  };
  const flagTables = ['feature_flags', 'feature_flag_user_rules', 'feature_flag_role_rules', 'feature_flag_group_rules'];
  const flagsBefore = Object.fromEntries(flagTables.map(table => [table, db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()]));
  const authBefore = fixtureAuthState();
  try {
    const report = await require('../scripts/ci/screenLayoutAudit.cjs').runScreenLayoutAudit({
      app, db, baseUrl, teacher: professor, admin, classPublicId, assessmentPublicId,
    });
    assert.equal(report.status, 'captured');
    console.log(JSON.stringify({ status: report.status, scenarios: report.inventory.length, captures: report.cases.length + report.internal.length, pageErrors: report.pageErrors }));
  } finally {
    try {
      db.transaction(() => {
        for (const table of flagTables) {
          const rows = flagsBefore[table];
          if (table === 'feature_flags') {
            for (const row of rows) {
              const columns = Object.keys(row).filter(column => column !== 'id');
              db.prepare(`UPDATE feature_flags SET ${columns.map(column => `${column}=?`).join(',')} WHERE id=?`)
                .run(...columns.map(column => row[column]), row.id);
            }
          } else {
            db.prepare(`DELETE FROM ${table}`).run();
            if (rows.length) {
              const columns = Object.keys(rows[0]);
              const insert = db.prepare(`INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`);
              for (const row of rows) insert.run(...columns.map(column => row[column]));
            }
          }
          assert.deepEqual(db.prepare(`SELECT * FROM ${table} ORDER BY id`).all(), rows, `${table} must be restored after browser QA`);
        }
      })();
    } finally {
      try { restoreFixtureAuthState(authBefore); }
      finally { Object.assign(config, configBefore); }
    }
  }
});

test('consulta por período respeita dono, datas de Brasília e não agrega alunos', async () => {
  const url = `/api/pedagogical-cycle/classes/${classPublicId}/period-report`;
  const previous = db.prepare('SELECT opened_at FROM class_assessment_assignments WHERE id = ?').get(assignmentId);
  try {
    db.prepare('UPDATE class_assessment_assignments SET opened_at = ? WHERE id = ?').run('2026-01-02 02:59:59', assignmentId);
    const query = '?start=2026-01-01&end=2026-01-01';
    assert.equal((await request(url + query)).status, 401);
    assert.equal((await request(url + query, { token: otherProfessorToken })).status, 404);
    assert.equal((await request(url, { token: professorToken })).status, 400);
    const result = await request(url + query, { token: professorToken });
    assert.equal(result.status, 200);
    const item = result.payload.assessments.find(a => a.id === assessmentPublicId);
    assert.ok(item);
    assert.equal(item.openedAt, '2026-01-02T02:59:59.000Z');
    assert.equal(result.payload.totalStudents, undefined);
    assert.equal(item.participants, undefined);
    assert.equal(item.overview.submittedCount >= 0, true);
    const detailed = (await request(`${cyclePath()}/report`, { token: professorToken })).payload.overview;
    for (const key of ['participantCount', 'submittedCount', 'pendingCount', 'meanPercentage']) assert.equal(item.overview[key], detailed[key]);
    const { loadAssessmentOverview } = require('../src/services/classAssessmentAnalysis');
    const statements = [];
    loadAssessmentOverview({ prepare(sql) { statements.push(sql); return db.prepare(sql); } }, assignmentId);
    assert.equal(statements.length, 1);
    assert.doesNotMatch(statements[0], /class_assessment_responses|class_assessment_items/);
    db.prepare('UPDATE class_assessment_assignments SET opened_at = ? WHERE id = ?').run('2026-01-02 03:00:00', assignmentId);
    const outside = await request(url + query, { token: professorToken });
    assert.equal(outside.payload.assessments.some(a => a.id === assessmentPublicId), false);
  } finally {
    db.prepare('UPDATE class_assessment_assignments SET opened_at = ? WHERE id = ?').run(previous.opened_at, assignmentId);
  }
});

test('atividade curta reutiliza criação privada, revisão e preparação com 1 e 5 questões', async () => {
  const items = Array.from({ length: 5 }, (_, i) => insertQuestion({ skillId: targetSkillId, code: `QA-QUICK-${i + 1}`, difficulty: 'facil' }));
  const before = db.prepare('SELECT COUNT(*) FROM class_assessment_assignments').pluck().get();
  for (const size of [1, 5]) {
    const created = await request('/api/question-bank/question-sets', { method: 'POST', token: professorToken,
      body: { title: `Atividade rápida — ${size} questões`, is_public: false, question_ids: items.slice(0, size).map(q => q.id) } });
    assert.equal(created.status, 201, JSON.stringify(created.payload));
    assert.equal(created.payload.question_count, size);
    assert.equal(created.payload.is_public, 0);
    const setId = created.payload.id;
    const detail = await request(`/api/question-bank/question-sets/${setId}`, { token: professorToken });
    assert.equal(detail.status, 200);
    assert.equal(detail.payload.questions.length, size);
    assert.equal((await request(`/api/question-bank/question-sets/${setId}`, { token: otherProfessorToken })).status, 403);
    const prep = await request(`/api/classes/${classPublicId}/assessments/sources/${setId}/preparation`, { token: professorToken });
    assert.equal(prep.status, 200, JSON.stringify(prep.payload));
    assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_assignments').pluck().get(), before);
    assert.ok(db.prepare("SELECT 1 FROM activity_log WHERE action = 'create_question_set' AND entity_id = ?").get(setId));
  }
});

const periodDates = { start: '2026-01-01', end: '2026-12-31' };
const periodPath = () => `/api/pedagogical-cycle/classes/${classPublicId}/period-report`;
const readPeriod = (dates = periodDates, token = professorToken) => request(`${periodPath()}/copy?${new URLSearchParams(dates)}`, { token });
const periodBody = copy => ({ start: copy.period.start, end: copy.period.end, expectedRevision: copy.revision, privacyConfirmed: true });
const exportPeriod = (body, token = professorToken) => exportPedagogicalReport(body, token, `${periodPath()}/export`);
const periodAuditCount = () => db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='pedagogical_period_exported'").pluck().get();

test('cópia do período confere todas as páginas e a análise atual, sem dados individuais nem escrita', async () => {
  const changes = db.prepare('SELECT total_changes()').pluck().get();
  const response = await readPeriod();
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), changes);
  assert.match(response.headers.get('cache-control'), /no-store/);
  const copy = response.payload;
  const { parsePedagogicalPeriodCopy } = await import('../../client/src/services/pedagogicalPeriodView.mjs');
  parsePedagogicalPeriodCopy(copy, classPublicId, periodDates);
  assert.equal((await readPeriod()).payload.revision, copy.revision);
  assert.doesNotMatch(JSON.stringify(copy), /Alice|Bruno|displayName|attemptId|correctOption|responses|feedback|plans|totalStudents/);
  const list = [];
  for (let page = 1; page <= Math.ceil(copy.total / 10); page++) {
    const result = await request(`${periodPath()}?${new URLSearchParams({ ...periodDates, page })}`, { token: professorToken });
    list.push(...result.payload.assessments);
  }
  assert.deepEqual(list, copy.assessments);
  assert.deepEqual(copy.assessments.find(a => a.id === assessmentPublicId).overview,
    (await request(`${cyclePath()}/report`, { token: professorToken })).payload.overview);
});

test('cópia e exportação do período revalidam dono, papel atual, flags e bloqueio emergencial', async () => {
  const body = periodBody((await readPeriod()).payload);
  for (const [token, status] of [[null, 401], [tokenFor(admin), 403], [otherProfessorToken, 404]]) {
    assert.equal((await readPeriod(periodDates, token)).status, status);
    assert.equal((await exportPeriod(body, token)).status, status);
  }
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(professor.id);
  try {
    assert.equal((await readPeriod()).status, 401); assert.equal((await exportPeriod(body)).status, 401);
    const refreshed = require('../src/services/authSessions').issueUserToken(professor.id);
    assert.equal((await readPeriod(periodDates, refreshed)).status, 403); assert.equal((await exportPeriod(body, refreshed)).status, 403);
  } finally {
    db.prepare("UPDATE users SET role='professor' WHERE id=?").run(professor.id);
    professorToken = require('../src/services/authSessions').issueUserToken(professor.id);
  }
  for (const flag of ['pedagogy.operational_cycle', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results']) {
    const original = db.prepare('SELECT master_enabled, kill_switch_active FROM feature_flags WHERE flag_key=?').get(flag);
    for (const [master, kill] of [[0, 0], [1, 1]]) {
      db.prepare(`UPDATE feature_flags SET master_enabled=?, kill_switch_active=?, kill_switch_reason='Teste do período',
        kill_switch_activated_by=?, kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key=?`).run(master, kill, admin.id, flag);
      try { assert.equal((await readPeriod()).status, 404); assert.equal((await exportPeriod(body)).status, 404); }
      finally { db.prepare('UPDATE feature_flags SET master_enabled=?, kill_switch_active=? WHERE flag_key=?').run(original.master_enabled, original.kill_switch_active, flag); }
    }
  }
});

test('planilha do período exige consentimento, gera CSV seguro e registra somente metadados', async () => {
  const copy = (await readPeriod()).payload, body = periodBody(copy), before = periodAuditCount();
  for (const invalid of [{}, { ...body, privacyConfirmed: false }, { ...body, expectedRevision: 'bad' },
    { ...body, page: 1 }, { ...body, start: '2026-02-30' }, { ...body, end: '2027-12-31' }])
    assert.equal((await exportPeriod(invalid)).status, 400);
  assert.equal(periodAuditCount(), before);
  const exported = await exportPeriod(body);
  assert.equal(exported.status, 200, exported.text);
  assert.equal(exported.headers.get('x-report-revision'), copy.revision);
  assert.match(exported.headers.get('content-type'), /text\/csv/);
  assert.match(exported.headers.get('content-disposition'), /avaliacoes-do-periodo.csv/);
  assert.equal(exported.headers.get('x-content-type-options'), 'nosniff');
  assert.match(exported.headers.get('cache-control'), /no-store/);
  assert.equal(exported.text.split('\r\n').length, copy.total + 1);
  assert.doesNotMatch(exported.text, /Alice|Bruno|correctOption|attemptId|HYPERLINK/);
  assert.equal(periodAuditCount(), before + 1);
  const metadata = JSON.parse(db.prepare("SELECT metadata FROM activity_log WHERE action='pedagogical_period_exported' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(metadata, { classId: classPublicId, ...periodDates, assessmentCount: copy.total, reportRevision: copy.revision, format: 'csv' });
});

test('revisão de correção invalida cópia mesmo sem alterar a média arredondada', async () => {
  const copy = (await readPeriod()).payload;
  const attempt = db.prepare("SELECT * FROM class_assessment_attempts WHERE assignment_id=? AND status='submitted' LIMIT 1").get(assignmentId);
  assert.ok(attempt);
  db.prepare('UPDATE class_assessment_attempts SET revision=revision+1 WHERE id=?').run(attempt.id);
  try {
    assert.equal((await exportPeriod(periodBody(copy))).status, 409);
    const newer = (await readPeriod()).payload;
    assert.deepEqual(newer.assessments, copy.assessments);
    assert.notEqual(newer.revision, copy.revision);
  } finally { db.prepare('UPDATE class_assessment_attempts SET revision=? WHERE id=?').run(attempt.revision, attempt.id); }
});

test('alterar contexto institucional invalida cópia sem revelar instituição desabilitada', async () => {
  const copy = (await readPeriod()).payload;
  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='institutions.read_model'").run();
  try {
    const newer = (await readPeriod()).payload;
    assert.equal(newer.class.institution.status, 'unavailable');
    assert.equal(newer.class.institution.school, undefined);
    assert.equal((await exportPeriod(periodBody(copy))).status, 409);
    assert.equal((await exportPeriod(periodBody(newer))).status, 200);
  } finally { db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='institutions.read_model'").run(); }
});

test('falha de auditoria impede entregar planilha do período', async () => {
  const body = periodBody((await readPeriod()).payload), before = periodAuditCount();
  db.exec(`CREATE TRIGGER test_period_audit_failure BEFORE INSERT ON activity_log WHEN NEW.action='pedagogical_period_exported'
    BEGIN SELECT RAISE(ABORT,'forced_period_audit_failure'); END;`);
  try {
    const result = await exportPeriod(body);
    assert.equal(result.status, 500); assert.doesNotMatch(result.headers.get('content-type'), /text\/csv/);
    assert.equal(periodAuditCount(), before);
  } finally { db.exec('DROP TRIGGER test_period_audit_failure'); }
});

test('cópia completa inclui 200 avaliações, recusa 201 e não trunca silenciosamente', async () => {
  const dates = { start: '2025-05-01', end: '2025-05-01' };
  assert.equal((await readPeriod(dates)).status, 409);
  const ids = [];
  const insert = (status = 'closed', teacherId = professor.id, schoolClassId = classId) => {
    const id = require('node:crypto').randomUUID();
    db.prepare(`INSERT INTO class_assessment_assignments
      (public_id, class_id, owner_teacher_id, title_snapshot, snapshot_hash, question_count, status, opened_at, closed_at, cancelled_at, opens_at)
      VALUES (?, ?, ?, ?, ?, 1, ?, '2025-05-02 02:59:59', '2025-05-02 03:00:00', '2025-05-02 03:00:00', '2025-05-01 03:00:00')`)
      .run(id, schoolClassId, teacherId, `Avaliação ${ids.length}`, 'a'.repeat(64), status);
    ids.push(id); return id;
  };
  try {
    for (const status of ['draft', 'scheduled', 'cancelled']) insert(status);
    assert.equal((await readPeriod(dates)).status, 409);
    for (let i = 0; i < 200; i++) insert(i % 2 ? 'closed' : 'open');
    const copy = (await readPeriod(dates)).payload;
    assert.equal(copy.total, 200); assert.equal(copy.assessments.length, 200);
    assert.equal(copy.assessments[0].id, ids.at(-1));
    const { parsePedagogicalPeriodCopy } = await import('../../client/src/services/pedagogicalPeriodView.mjs');
    assert.doesNotThrow(() => parsePedagogicalPeriodCopy(copy, classPublicId, dates));
    assert.equal(copy.assessments[0].overview.meanPercentage, null);
    assert.equal((await exportPeriod(periodBody(copy))).text.split('\r\n').length, 201);
    insert();
    assert.equal((await readPeriod(dates)).status, 422);
    assert.equal((await exportPeriod(periodBody(copy))).status, 422);
    const list = await request(`${periodPath()}?${new URLSearchParams(dates)}`, { token: professorToken });
    assert.equal(list.status, 200); assert.equal(list.payload.pagination.total, 201); assert.equal(list.payload.assessments.length, 10);
  } finally { for (const id of ids) db.prepare('DELETE FROM class_assessment_assignments WHERE public_id=?').run(id); }
});

test('relatório integrado: servidor temporário para conferência manual opt-in', { skip: process.env.REPORT_INTERACTIVE_QA !== '1', timeout: 660000 }, async () => {
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  const build = path.resolve(__dirname, '../../tmp', process.env.REPORT_QA_BUILD || 'pedagogical-review-quick-build');
  assert.equal(path.dirname(build), path.resolve(__dirname, '../../tmp'));
  assert.ok(fs.existsSync(path.join(build, 'index.html')));
  const config = require('../src/config');
  config.appEnvironment = 'homologation';
  config.smtp.user = ''; config.smtp.pass = '';
  config.uploadDir = path.join(tempDir, 'uploads');
  fs.mkdirSync(config.uploadDir, { recursive: true });
  // Known credentials only in this throwaway database, never an operational account.
  db.prepare('UPDATE users SET password = ?, role = ? WHERE id = ?')
    .run(await require('bcryptjs').hash('Visual-QA-Only-2026!', 10), 'professor', professor.id);
  for (const { flag_key } of db.prepare('SELECT flag_key FROM feature_flags').all()) {
    if (!flag_key.includes('ai')) enableFlagForUser(flag_key, professor);
  }
  for (const route of ['auth', 'governance', 'classes', 'notifications', 'announcements', 'categories']) {
    app.use(`/api/${route}`, require(`../src/routes/${route}`));
  }
  app.use('/api', (_req, res) => res.sendStatus(404));
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  app.get('/__qa', (_req, res) => res.send('<h1>Conferência sintética isolada</h1><form method="post" action="/__qa/period-change"><button>Simular nova revisão dos resultados</button></form><form method="post" action="/__qa/finish"><button>Encerrar conferência local</button></form>'));
  app.post('/__qa/period-change', (_req, res) => {
    db.prepare('UPDATE class_assessment_assignments SET revision=revision+1 WHERE id=?').run(assignmentId);
    res.send('<p>Revisão alterada somente na base sintética.</p><a href="/__qa">Voltar aos controles locais</a>');
  });
  app.post('/__qa/finish', (_req, res) => { res.send('Conferência encerrada.'); setTimeout(finish, 100); });
  app.use(express.static(build));
  app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
  console.log('REPORT_QA_READY', JSON.stringify({ baseUrl, email: professor.email, classPublicId, assessmentPublicId }));
  const timer = setTimeout(finish, 600000);
  try { await done; } finally { clearTimeout(timer); }
});
