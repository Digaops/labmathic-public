const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-diagnostics-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'diagnostics-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const diagnosticsRouter = require('../src/routes/diagnostics');
const questionBankRouter = require('../src/routes/questionBank');
const reportsRouter = require('../src/routes/reports');
const { EDITORIAL_PILOT_FLAG } = require('../src/services/questionEditorialCuration');

const app = express();
app.use(express.json());
app.use('/api/question-bank', diagnosticsRouter);
app.use('/api/question-bank', questionBankRouter);
app.use('/api/reports', reportsRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let admin;
let professor;
let professorToken;
let adminToken;
let gradeId;
let skillIds;
let diagnosticQuestionSetId;

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
    ) VALUES (?, ?, 1, 'Teste automatizado do gerador diagnostico', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

function insertQuestion({ skillId, code, difficulty, source = 'official', reviewed = 0, correctCount = 1 }) {
  const questionId = Number(db.prepare(`
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
    source === 'teacher' ? professor.id : admin.id
  ).lastInsertRowid);
  ['A', 'B', 'C', 'D'].forEach((label, index) => {
    db.prepare(`
      INSERT INTO question_options (
        question_id, option_label, option_text, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `).run(questionId, label, `Alternativa ${label}`, index < correctCount ? 1 : 0, index);
  });
  return questionId;
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

test.before(async () => {
  admin = insertUser('Admin', 'admin-diagnostico@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-diagnostico@teste.local', 'professor');
  professorToken = tokenFor(professor);
  adminToken = tokenFor(admin);
  gradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)")
    .run().lastInsertRowid);
  const otherGradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('8º Ano - EF', 8)")
    .run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units (name, sort_order) VALUES ('Números', 1)")
    .run().lastInsertRowid);
  skillIds = [
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA01', 'Resolver problemas com números inteiros.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
    Number(db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA02', 'Comparar números racionais.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid),
  ];
  db.prepare(`
    INSERT INTO bncc_skills (code, description, grade_id, unit_id)
    VALUES ('EF08MA01', 'Habilidade de outro ano.', ?, ?)
  `).run(otherGradeId, unitId);

  insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-Q001', difficulty: 'facil', reviewed: 1 });
  insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-Q002', difficulty: 'media' });
  insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-Q003', difficulty: 'dificil', source: 'teacher' });
  insertQuestion({ skillId: skillIds[0], code: 'EF07MA01-INVALIDA', difficulty: 'media', correctCount: 2 });
  insertQuestion({ skillId: skillIds[1], code: 'EF07MA02-Q001', difficulty: 'facil' });
  insertQuestion({ skillId: skillIds[1], code: 'EF07MA02-Q002', difficulty: 'media' });
  insertQuestion({ skillId: skillIds[1], code: 'EF07MA02-Q003', difficulty: 'dificil' });

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

test('gerador falha fechado e recusa perfil administrativo', async () => {
  const disabled = await request('/api/question-bank/diagnostics/bootstrap', { token: professorToken });
  assert.equal(disabled.status, 404);
  const adminResponse = await request('/api/question-bank/diagnostics/bootstrap', { token: adminToken });
  assert.equal(adminResponse.status, 403);

  const regularQuestionBank = await request('/api/question-bank/questions?page=1&limit=1', {
    token: adminToken,
  });
  assert.equal(
    regularQuestionBank.status,
    200,
    'o middleware do gerador não pode interceptar as demais rotas do banco de questões'
  );
  enableFlagForUser('question_bank.diagnostic_generator', professor);
});

test('bootstrap mostra somente questões objetivas com gabarito estruturalmente válido', async () => {
  const response = await request(`/api/question-bank/diagnostics/bootstrap?grade_id=${gradeId}`, {
    token: professorToken,
  });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.grades[0].candidateCount, 6);
  assert.equal(response.payload.skills.length, 2);
  assert.deepEqual(response.payload.units, [{
    id: response.payload.skills[0].unitId,
    name: 'Números',
    skillCount: 2,
    candidateCount: 6,
  }]);
  assert.deepEqual(
    response.payload.skills.map(({ candidateCount }) => candidateCount),
    [3, 3]
  );
  assert.equal(response.payload.skills[0].reviewedCount, 1);
  assert.equal(response.payload.methodology, 'balanced_by_skill_and_available_difficulty');
});

test('insuficiência ou habilidade de outro ano não deixa escrita parcial', async () => {
  const before = db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get();
  const shortage = await request('/api/question-bank/diagnostics/generate', {
    method: 'POST', token: professorToken, body: {
      gradeId,
      skillIds,
      questionsPerSkill: 4,
    },
  });
  assert.equal(shortage.status, 409);
  assert.equal(shortage.payload.details.shortages.length, 2);
  const otherSkill = db.prepare("SELECT id FROM bncc_skills WHERE code = 'EF08MA01'").pluck().get();
  const wrongGrade = await request('/api/question-bank/diagnostics/generate', {
    method: 'POST', token: professorToken, body: {
      gradeId,
      skillIds: [otherSkill],
      questionsPerSkill: 2,
    },
  });
  assert.equal(wrongGrade.status, 400);
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_sets').pluck().get(), before);
});

test('gera simulado privado, equilibrado e pendente de revisão explícita', async () => {
  const response = await request('/api/question-bank/diagnostics/generate', {
    method: 'POST', token: professorToken, body: {
      gradeId,
      skillIds,
      questionsPerSkill: 3,
      title: 'Diagnóstico inicial de números',
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.questionCount, 6);
  assert.equal(response.payload.isPrivate, true);
  assert.equal(response.payload.requiresTeacherReview, true);
  assert.equal(response.payload.containsAuthorQuestions, true);
  diagnosticQuestionSetId = response.payload.id;
  response.payload.composition.forEach((skill) => {
    assert.deepEqual(skill.difficulties, { easy: 1, medium: 1, difficult: 1 });
  });

  const stored = db.prepare(`
    SELECT question_set.user_id, question_set.is_public,
      question_set.contains_author_questions, diagnostic.algorithm_version,
      diagnostic.total_questions
    FROM question_sets question_set
    JOIN diagnostic_question_sets diagnostic ON diagnostic.question_set_id = question_set.id
    WHERE question_set.id = ?
  `).get(response.payload.id);
  assert.deepEqual(stored, {
    user_id: professor.id,
    is_public: 0,
    contains_author_questions: 1,
    algorithm_version: 'balanced-v1',
    total_questions: 6,
  });
  const description = db.prepare('SELECT description FROM question_sets WHERE id = ?')
    .pluck().get(response.payload.id);
  assert.equal(description, 'Diagnóstico de 7º Ano - EF com 2 habilidades BNCC.');
  assert.ok(description.length < 80);
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM diagnostic_question_set_reviews WHERE question_set_id = ?')
      .pluck().get(response.payload.id),
    0
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM diagnostic_question_set_skills WHERE question_set_id = ?')
      .pluck().get(response.payload.id),
    2
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM question_set_items
      WHERE question_set_id = ? AND option_order IS NOT NULL
    `).pluck().get(response.payload.id),
    6
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM notifications WHERE user_id = ? AND type = 'diagnostic_question_set_created'")
      .pluck().get(admin.id),
    1
  );
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE user_id = ? AND action = 'create_diagnostic_question_set'")
      .pluck().get(professor.id),
    1
  );

  const edit = await request(`/api/question-bank/question-sets/${response.payload.id}`, {
    method: 'PUT', token: professorToken, body: {
      title: 'Tentativa de editar',
      question_ids: [1],
    },
  });
  assert.equal(edit.status, 409);

  const report = await request('/api/reports/question-bank-usage', { token: adminToken });
  assert.equal(report.status, 200, JSON.stringify(report.payload));
  assert.equal(report.payload.totals.diagnostic_question_sets, 1);
  assert.equal(report.payload.totals.diagnostic_creators, 1);
  assert.equal(report.payload.totals.diagnostic_assignments, 0);
});

test('revisão exige confirmação do proprietário, é idempotente e fica na auditoria', async () => {
  assert.ok(diagnosticQuestionSetId);
  const detailBefore = await request(`/api/question-bank/question-sets/${diagnosticQuestionSetId}`, {
    token: professorToken,
  });
  assert.equal(detailBefore.status, 200);
  assert.equal(detailBefore.payload.diagnostic_reviewed, 0);
  assert.equal(detailBefore.payload.answer_key.balanced, true);
  assert.ok(detailBefore.payload.answer_key.maxCount < 3);

  const missingConfirmation = await request(
    `/api/question-bank/question-sets/${diagnosticQuestionSetId}/diagnostic-review`,
    { method: 'POST', token: professorToken, body: {} }
  );
  assert.equal(missingConfirmation.status, 400);
  const adminAttempt = await request(
    `/api/question-bank/question-sets/${diagnosticQuestionSetId}/diagnostic-review`,
    { method: 'POST', token: adminToken, body: { confirmed: true } }
  );
  assert.equal(adminAttempt.status, 403);

  const confirmed = await request(
    `/api/question-bank/question-sets/${diagnosticQuestionSetId}/diagnostic-review`,
    { method: 'POST', token: professorToken, body: { confirmed: true } }
  );
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.payload));
  assert.equal(confirmed.payload.reviewed, true);
  assert.equal(confirmed.payload.alreadyReviewed, false);
  const repeated = await request(
    `/api/question-bank/question-sets/${diagnosticQuestionSetId}/diagnostic-review`,
    { method: 'POST', token: professorToken, body: { confirmed: true } }
  );
  assert.equal(repeated.status, 200);
  assert.equal(repeated.payload.alreadyReviewed, true);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM activity_log WHERE action = 'review_diagnostic_question_set'")
      .pluck().get(),
    1
  );

  const detailAfter = await request(`/api/question-bank/question-sets/${diagnosticQuestionSetId}`, {
    token: professorToken,
  });
  assert.equal(detailAfter.status, 200);
  assert.equal(detailAfter.payload.diagnostic_reviewed, 1);
  assert.ok(detailAfter.payload.diagnostic_reviewed_at);
});

test('simulado comum persiste e reapresenta um gabarito equilibrado', async () => {
  const questionIds = db.prepare(`
    SELECT question.id
    FROM questions question
    WHERE question.status = 'active'
      AND (
        question.source = 'official'
        OR (question.source = 'teacher' AND question.created_by = ?)
      )
      AND (
        SELECT COUNT(*) FROM question_options option
        WHERE option.question_id = question.id AND option.is_correct = 1
      ) = 1
    ORDER BY question.id
    LIMIT 6
  `).all(professor.id).map(({ id }) => id);
  const created = await request('/api/question-bank/question-sets', {
    method: 'POST', token: professorToken, body: {
      title: 'Simulado com distribuição segura',
      question_ids: questionIds,
      is_public: false,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));

  const detail = await request(`/api/question-bank/question-sets/${created.payload.id}`, {
    token: professorToken,
  });
  assert.equal(detail.status, 200, JSON.stringify(detail.payload));
  assert.equal(detail.payload.answer_key.balanced, true);
  assert.ok(detail.payload.answer_key.maxCount < 3);

  db.prepare(`
    UPDATE question_set_items
    SET option_order = NULL
    WHERE question_set_id = ?
      AND id = (
        SELECT id FROM question_set_items
        WHERE question_set_id = ?
        ORDER BY sort_order
        LIMIT 1
      )
  `).run(created.payload.id, created.payload.id);
  const legacyDetail = await request(`/api/question-bank/question-sets/${created.payload.id}`, {
    token: professorToken,
  });
  assert.equal(legacyDetail.status, 200, JSON.stringify(legacyDetail.payload));
  assert.equal(legacyDetail.payload.answer_key.balanced, true);
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM question_set_items
      WHERE question_set_id = ? AND option_order IS NULL
    `).pluck().get(created.payload.id),
    1
  );

  const updated = await request(`/api/question-bank/question-sets/${created.payload.id}`, {
    method: 'PUT', token: professorToken, body: {
      title: 'Simulado com distribuição segura revisado',
      question_ids: [...questionIds].reverse(),
      is_public: false,
    },
  });
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) FROM question_set_items
      WHERE question_set_id = ? AND option_order IS NOT NULL
    `).pluck().get(created.payload.id),
    questionIds.length
  );
});

test('criação manual reapresenta o simulado por conta e conserva a exclusão', async () => {
  const route = '/api/question-bank/question-sets';
  const key = 'criacao-idempotente-simulado-001';
  const ids = ['IDEMPOTENCIA-Q001', 'IDEMPOTENCIA-Q002'].map(code =>
    insertQuestion({ skillId: skillIds[0], code, difficulty: 'facil' }));
  const body = { title: ' Simulado sintético ', description: ' ', is_public: true,
    question_ids: ids, question_items: [{ question_id: ids[1], show_image: false }] };
  const submit = (payload = body, token = professorToken, idempotencyKey = key) => request(route, {
    method: 'POST', token, body: payload, headers: { 'Idempotency-Key': idempotencyKey },
  });
  const invalid = await submit(body, professorToken, 'curta');
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.code, 'invalid_idempotency_key');

  const [replay, created] = (await Promise.all([submit(), submit()])).sort((a, b) => a.status - b.status);
  assert.equal(created.status, 201);
  assert.equal(replay.status, 200);
  assert.equal(replay.headers.get('idempotency-replayed'), 'true');
  assert.equal(replay.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(replay.payload, created.payload);
  const id = created.payload.id;
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_set_creation_receipts WHERE question_set_id = ?').pluck().get(id), 1);
  assert.equal(db.prepare("SELECT COUNT(*) FROM activity_log WHERE action='create_question_set' AND entity_id=?").pluck().get(id), 1);
  const notices = db.prepare("SELECT type FROM notifications WHERE json_extract(data,'$.question_set_id')=? ORDER BY type").pluck().all(id);
  assert.deepEqual(notices, ['new_public_question_set', 'teacher_question_set_created']);

  const equivalent = { title: 'Simulado sintético', is_public: 'true', question_items: [
    { question_id: String(ids[0]), show_image: 1 }, { question_id: String(ids[1]), show_image: '0' },
  ] };
  assert.deepEqual((await submit(equivalent)).payload, created.payload);
  for (const altered of [
    { ...body, description: 'Descrição alterada' },
    { ...body, question_ids: [...ids].reverse() },
    { ...body, question_items: [] },
    { ...body, is_public: false },
  ]) {
    const conflict = await submit(altered);
    assert.equal(conflict.status, 409);
    assert.equal(conflict.payload.code, 'question_set_idempotency_conflict');
    assert.equal(conflict.payload.id, undefined);
  }

  const anotherTeacher = insertUser('Outro professor', 'outro-simulado@example.invalid', 'professor');
  const another = await submit(body, tokenFor(anotherTeacher));
  assert.equal(another.status, 201);
  assert.equal(another.payload.user_id, anotherTeacher.id);
  assert.notEqual(another.payload.id, id);

  db.prepare("UPDATE questions SET status='inactive' WHERE id=?").run(ids[0]);
  const afterCatalogChange = await submit();
  assert.equal(afterCatalogChange.status, 200);
  assert.equal(afterCatalogChange.payload.id, id);

  assert.equal((await request(`${route}/${id}`, { method: 'DELETE', token: professorToken })).status, 200);
  const deleted = await submit();
  assert.equal(deleted.status, 410);
  assert.equal(deleted.payload.code, 'question_set_deleted');
  assert.equal(deleted.payload.id, undefined);
  assert.equal(db.prepare('SELECT question_set_id FROM question_set_creation_receipts WHERE owner_user_id=?').pluck().get(professor.id), null);
  assert.equal((await submit(body, tokenFor(anotherTeacher))).payload.id, another.payload.id);
  assert.equal(db.prepare('SELECT 1 FROM question_sets WHERE id=?').get(id), undefined);
});

test('criação manual aplica limites aos dois formatos de seleção antes da normalização', async () => {
  const route = '/api/question-bank/question-sets';
  const questionId = insertQuestion({ skillId: skillIds[0], code: 'SELECAO-LIMITADA', difficulty: 'facil' });
  const submit = body => request(route, { method: 'POST', token: professorToken,
    body: { title: 'Simulado: validação de entrada', ...body },
  });
  const invalidIds = await submit({ question_ids: [true, { toString: 'ID inválido' }] });
  assert.equal(invalidIds.status, 400);
  assert.match(invalidIds.payload.error, /Nenhuma questão válida/);

  for (const payload of [
    { question_ids: Array(101).fill(questionId) },
    { question_ids: [questionId], question_items: Array(101).fill({ question_id: questionId, show_image: false }) },
  ]) {
    const rejected = await submit(payload);
    assert.equal(rejected.status, 400);
    assert.match(rejected.payload.error, /máximo 100/);
  }
  const accepted = await submit({ question_items: [{ question_id: String(questionId), show_image: false }] });
  assert.equal(accepted.status, 201);
  assert.equal(accepted.payload.question_count, 1);
  assert.equal(db.prepare('SELECT show_image FROM question_set_items WHERE question_set_id=?').pluck().get(accepted.payload.id), 0);
});

test('falha na auditoria desfaz simulado, recibo, itens e notificações', async () => {
  const questionId = insertQuestion({ skillId: skillIds[0], code: 'IDEMPOTENCIA-ROLLBACK', difficulty: 'facil' });
  const submit = () => request('/api/question-bank/question-sets', {
    method: 'POST', token: professorToken,
    headers: { 'Idempotency-Key': 'criacao-idempotente-simulado-002' },
    body: { title: 'Simulado transacional', question_ids: [questionId], is_public: true },
  });
  const counts = () => db.prepare(`SELECT (SELECT COUNT(*) FROM question_sets) AS sets,
    (SELECT COUNT(*) FROM question_set_items) AS items,
    (SELECT COUNT(*) FROM question_set_creation_receipts) AS receipts,
    (SELECT COUNT(*) FROM notifications) AS notifications`).get();
  const before = counts();
  db.exec(`CREATE TRIGGER abort_test_question_set_audit BEFORE INSERT ON activity_log
    WHEN NEW.action = 'create_question_set' BEGIN SELECT RAISE(ABORT, 'audit_failed'); END;`);
  try {
    assert.equal((await submit()).status, 500);
    assert.deepEqual(counts(), before);
  } finally {
    db.exec('DROP TRIGGER abort_test_question_set_audit');
  }
  const created = await submit();
  assert.equal(created.status, 201);
  assert.equal((await submit()).payload.id, created.payload.id);
});

test('curadoria impede novo uso de questão divergente e só prioriza itens do piloto aprovados para diagnóstico', async () => {
  const skillId = Number(db.prepare(`INSERT INTO bncc_skills(code, description, grade_id, unit_id)
    VALUES ('EF07MA99', 'Habilidade fictícia para testar curadoria.', ?, 1)`).run(gradeId).lastInsertRowid);
  const make = (code, reviewed = 0) => insertQuestion({ skillId, code, difficulty: 'media', reviewed });
  const legacy = make('Q-CURADORIA-LEGADO');
  const held = make('Q-CURADORIA-BLOQUEADA');
  const diagnostic = make('Q-CURADORIA-DIAGNOSTICO');
  const alternate = make('Q-CURADORIA-APLICACAO', 1);
  const practice = make('Q-CURADORIA-PRATICA', 1);
  const verification = make('Q-CURADORIA-VERIFICACAO', 1);
  db.prepare("UPDATE questions SET status='inactive' WHERE id=?").run(diagnostic);
  const mark = db.prepare(`INSERT INTO question_editorial_curation
    (question_id, batch_key, state, stage, family, reason, content_sha256, rationales_json)
    VALUES (?, 'fixture', ?, ?, ?, 'Revisão editorial de teste', ?, ?)`);
  const original = await request('/api/question-bank/question-sets', {
    token: professorToken, method: 'POST', headers: { 'Idempotency-Key': 'simulado-antes-curadoria-01' },
    body: { title: 'Simulado guardado antes da curadoria', question_ids: [held] },
  });
  assert.equal(original.status, 201, JSON.stringify(original.payload));
  mark.run(held, 'held', null, null, 'f'.repeat(64), null);
  for (const [id, stage] of [[diagnostic, 'reasoning'], [alternate, 'application'], [practice, 'practice'], [verification, 'verification']]) {
    mark.run(id, 'pilot', stage, `grupo-${id}`, 'f'.repeat(64), JSON.stringify(['A', 'B', 'C', 'D']));
  }
  const edit = (id, action, body) => request(`/api/question-bank/questions/${id}${action && '/' + action}`, {
    token: adminToken, method: action ? 'PATCH' : 'PUT', body,
  });
  const getQuestion = (id, token = professorToken) => request(`/api/question-bank/questions/${id}`, { token });
  const getList = (token = professorToken) => request(`/api/question-bank/questions?skill_id=${skillId}`, { token });
  const submit = (questionIds, extras = {}) => request('/api/question-bank/question-sets', {
    token: professorToken, method: 'POST', body: { title: 'Simulado de teste editorial', question_ids: questionIds, ...extras },
  });
  assert.equal((await getQuestion(held)).status, 404);
  assert.equal((await getQuestion(held, adminToken)).payload.editorial.state, 'held');
  assert.equal((await edit(held, '', {})).status, 409);
  assert.equal((await edit(held, 'reviewed', { reviewed: true })).status, 409);
  assert.equal((await edit(held, 'status', { status: 'active' })).status, 409);
  assert.equal((await edit(diagnostic, 'status', { status: 'active' })).status, 409);
  assert.equal((await submit([held])).status, 400);
  assert.equal((await submit([alternate])).status, 400);
  assert.deepEqual((await getList()).payload.data.map(({ id }) => id), [legacy]);
  assert.equal((await getList(adminToken)).payload.data.find(({ id }) => id === diagnostic).editorial.stage, 'reasoning');
  const historical = await request(`/api/question-bank/question-sets/${original.payload.id}`, { token: professorToken });
  assert.equal(historical.status, 200);
  assert.equal(historical.payload.questions[0].id, held);
  const replay = await request('/api/question-bank/question-sets', {
    token: professorToken, method: 'POST', headers: { 'Idempotency-Key': 'simulado-antes-curadoria-01' },
    body: { title: 'Simulado guardado antes da curadoria', question_ids: [held] },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.id, original.payload.id);

  enableFlagForUser(EDITORIAL_PILOT_FLAG, professor);
  assert.equal((await getQuestion(diagnostic)).status, 404);
  const ownReview = await request(`/api/question-bank/questions/${diagnostic}/reviewed`, {
    token: professorToken, method: 'PATCH', body: { reviewed: true },
  });
  assert.equal(ownReview.status, 403);
  db.exec(`CREATE TRIGGER fail_pilot_review_or_activation BEFORE INSERT ON activity_log
    WHEN NEW.action IN ('update_question_review', 'update_question_status')
    BEGIN SELECT RAISE(ABORT, 'qa_editorial_log_failed'); END;`);
  try {
    assert.equal((await edit(diagnostic, 'reviewed', { reviewed: true })).status, 500);
    assert.equal(db.prepare('SELECT reviewed FROM questions WHERE id=?').pluck().get(diagnostic), 0);
    assert.equal((await edit(diagnostic, 'status', { status: 'active' })).status, 409);
    db.prepare('UPDATE questions SET reviewed=1 WHERE id=?').run(diagnostic);
    assert.equal((await edit(diagnostic, 'status', { status: 'active' })).status, 500);
    assert.equal(db.prepare('SELECT status FROM questions WHERE id=?').pluck().get(diagnostic), 'inactive');
    db.prepare('UPDATE questions SET reviewed=0 WHERE id=?').run(diagnostic);
  } finally {
    db.exec('DROP TRIGGER fail_pilot_review_or_activation');
  }
  assert.equal((await edit(diagnostic, 'reviewed', { reviewed: true })).status, 200);
  assert.equal((await edit(diagnostic, 'status', { status: 'active' })).status, 200);
  const logged = db.prepare(`SELECT user_id, action FROM activity_log WHERE entity_type='question' AND entity_id=?
    AND action IN ('update_question_review','update_question_status') ORDER BY id`).all(diagnostic);
  assert.deepEqual(logged, [{ user_id: admin.id, action: 'update_question_review' }, { user_id: admin.id, action: 'update_question_status' }]);
  assert.deepEqual((await getQuestion(diagnostic)).payload.editorial, { state: 'pilot', stage: 'reasoning' });
  const manual = await submit([diagnostic], { is_public: true });
  assert.equal(manual.status, 201);
  assert.equal(manual.payload.is_public, 0);
  const bootstrap = await request(`/api/question-bank/diagnostics/bootstrap?grade_id=${gradeId}`, { token: professorToken });
  assert.equal(bootstrap.payload.skills.find(({ id }) => id === skillId).candidateCount, 3);
  const generated = await request('/api/question-bank/diagnostics/generate', {
    token: professorToken, method: 'POST', body: { gradeId, skillIds: [skillId], questionsPerSkill: 2 },
  });
  assert.equal(generated.status, 201, JSON.stringify(generated.payload));
  assert.equal(generated.payload.composition[0].editorialPilotCount, 2);
  assert.deepEqual(db.prepare('SELECT question_id FROM question_set_items WHERE question_set_id=? ORDER BY question_id')
    .pluck().all(generated.payload.id), [diagnostic, alternate]);
});

test('papel atual no banco prevalece sobre token antigo', async () => {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(professor.id);
  const response = await request('/api/question-bank/diagnostics/bootstrap', { token: professorToken });
  assert.equal(response.status, 401); // Mudança de perfil agora revoga a sessão antiga.
});
