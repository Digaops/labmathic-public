const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-typed-routes-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDirectory, 'database.sqlite');
process.env.JWT_SECRET = 'typed-question-routes-test-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const typedAuthoringRouter = require('../src/routes/typedQuestionAuthoring');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use('/api/question-bank/typed-authoring', typedAuthoringRouter);

let server;
let baseUrl;
let author;
let otherTeacher;
let reviewer;
let authorToken;
let otherTeacherToken;
let reviewerToken;
let questionSequence = 0;
let firstState;
let skillId;

function addUser(name, email, role) {
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-sintetico', ?)
  `).run(name, email, role).lastInsertRowid);
  return { id, name, email, role };
}

function tokenFor(user, overrides = {}) {
  return jwt.sign({ ...user, ...overrides }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function createAuthorQuestion(owner = author) {
  questionSequence += 1;
  return Number(db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, difficulty, question_type,
      status, reviewed, source, created_by
    ) VALUES (?, ?, ?, 'media', 'multiple_choice', 'active', 0, 'teacher', ?)
  `).run(
    `AUT-TYPED-ROUTE-${String(questionSequence).padStart(3, '0')}`,
    skillId,
    `Questão autoral sintética ${questionSequence}.`,
    owner.id,
  ).lastInsertRowid);
}

function choiceDefinition(stem = 'Há três grupos com quatro livros. Qual é o total?') {
  return {
    interactionType: 'single_choice',
    content: {
      stem,
      supportText: null,
      choices: [
        { id: 'answer_ten', text: '10' },
        { id: 'answer_twelve', text: '12' },
        { id: 'answer_fourteen', text: '14' },
      ],
    },
    scoring: { strategy: 'exact', partialCredit: false },
    answerKey: { choiceId: 'answer_twelve' },
    accessibility: {
      responseLabel: 'Alternativa da questão',
      instructions: 'Escolha uma alternativa.',
    },
    print: {
      supported: true,
      layout: 'choice_list',
      instructions: 'Marque uma alternativa.',
      answerSpaceLines: 0,
    },
    feedback: {
      releasePolicy: 'after_assessment_close',
      general: 'Represente a multiplicação.',
      correct: 'A estratégia está correta.',
      incorrect: 'Confira os grupos iguais.',
      choiceFeedback: {},
    },
  };
}

function operationKey(label) {
  return `typed-route-${label}-2026-safe-key`;
}

function enableFor(...users) {
  const flag = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'question_bank.typed_engine'
  `).get();
  db.prepare(`
    UPDATE feature_flags
    SET master_enabled = 1, kill_switch_active = 0,
        kill_switch_reason = NULL, kill_switch_activated_at = NULL
    WHERE id = ?
  `).run(flag.id);
  const addRule = db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Acesso sintético isolado para teste HTTP', ?, ?)
  `);
  for (const user of users) addRule.run(flag.id, user.id, reviewer.id, reviewer.id);
}

async function request(pathname, options = {}) {
  const headers = { Accept: 'application/json', ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    payload: await response.json(),
  };
}

async function adopt(questionId, label, token = authorToken, definition = choiceDefinition()) {
  return request('/api/question-bank/typed-authoring/items', {
    method: 'POST',
    token,
    headers: { 'Idempotency-Key': operationKey(label) },
    body: { questionId, definition },
  });
}

test.before(async () => {
  reviewer = addUser('Revisora HTTP', 'revisora-http@teste.local', 'admin');
  author = addUser('Professora HTTP', 'autora-http@teste.local', 'professor');
  otherTeacher = addUser('Professor Externo HTTP', 'externo-http@teste.local', 'professor');
  reviewerToken = tokenFor(reviewer);
  authorToken = tokenFor(author);
  otherTeacherToken = tokenFor(otherTeacher);
  const gradeId = Number(db.prepare(`
    INSERT INTO grades (name, sort_order) VALUES ('6º Ano - Rota Tipada', 6)
  `).run().lastInsertRowid);
  const unitId = Number(db.prepare(`
    INSERT INTO bncc_units (name, sort_order) VALUES ('Números - Rota Tipada', 1)
  `).run().lastInsertRowid);
  skillId = Number(db.prepare(`
    INSERT INTO bncc_skills (code, description, grade_id, unit_id)
    VALUES ('EF06MA01-TYPED-HTTP', 'Resolver problemas multiplicativos sintéticos.', ?, ?)
  `).run(gradeId, unitId).lastInsertRowid);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => server.close((error) => (
      error ? reject(error) : resolve()
    )));
  }
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('falha fechada antes de validar o corpo e não escreve com a flag desligada', async () => {
  const unauthenticated = await request(
    '/api/question-bank/typed-authoring/versions/version-that-does-not-exist-001',
  );
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.cacheControl, 'no-store');

  const questionId = createAuthorQuestion();
  const disabled = await request('/api/question-bank/typed-authoring/items', {
    method: 'POST', token: authorToken, body: ['corpo', 'inválido'],
  });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.cacheControl, 'no-store');
  assert.equal(disabled.payload.code, 'feature_disabled');
  assert.equal(db.prepare('SELECT COUNT(*) FROM typed_question_items').pluck().get(), 0);

  enableFor(author, otherTeacher, reviewer);

  const stillMissingKey = await request('/api/question-bank/typed-authoring/items', {
    method: 'POST', token: authorToken,
    body: { questionId, definition: choiceDefinition() },
  });
  assert.equal(stillMissingKey.status, 400);
  assert.equal(stillMissingKey.payload.code, 'idempotency_key_required');
});

test('adota uma questão com corpo estrito e repetição HTTP idempotente', async () => {
  const questionId = createAuthorQuestion();
  const unexpected = await request('/api/question-bank/typed-authoring/items', {
    method: 'POST', token: authorToken,
    headers: { 'Idempotency-Key': operationKey('unexpected') },
    body: { questionId, definition: choiceDefinition(), publish: true },
  });
  assert.equal(unexpected.status, 400);
  assert.equal(unexpected.payload.code, 'invalid_request_shape');
  assert.deepEqual(unexpected.payload.details.unexpected, ['publish']);

  const created = await adopt(questionId, 'adopt-first');
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.replayed, false);
  assert.equal(created.payload.version.status, 'draft');
  firstState = created.payload;

  const replay = await adopt(questionId, 'adopt-first');
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.version.publicId, firstState.version.publicId);

  const conflict = await adopt(
    questionId,
    'adopt-first',
    authorToken,
    choiceDefinition('Conteúdo diferente usando a mesma chave HTTP.'),
  );
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, 'idempotency_conflict');

  const adminQuestion = createAuthorQuestion();
  const forbidden = await adopt(adminQuestion, 'admin-adopt', reviewerToken);
  assert.equal(forbidden.status, 403);
  assert.equal(forbidden.payload.code, 'professor_required');
});

test('isola o gabarito entre professores e usa o papel atual do banco', async () => {
  const hidden = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}`,
    { token: otherTeacherToken },
  );
  assert.equal(hidden.status, 404);
  assert.equal(hidden.payload.code, 'typed_question_not_found');

  const own = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}`,
    { token: authorToken },
  );
  assert.equal(own.status, 200);
  assert.equal(own.payload.version.definition.answerKey.choiceId, 'answer_twelve');

  const staleAdminToken = tokenFor(otherTeacher, { role: 'admin' });
  const stillHidden = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}`,
    { token: staleAdminToken },
  );
  assert.equal(stillHidden.status, 404);
});

test('conclui revisão independente sem ativação automática e sem gabarito na fila', async () => {
  const updated = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}/draft`,
    {
      method: 'PATCH', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('update-first') },
      body: {
        expectedRevision: 1,
        definition: choiceDefinition('Três caixas têm quatro livros cada. Quantos livros há?'),
      },
    },
  );
  assert.equal(updated.status, 200, JSON.stringify(updated.payload));
  assert.equal(updated.payload.version.revision, 2);

  const submitted = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}/reviews`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('submit-first') },
      body: { expectedRevision: 2 },
    },
  );
  assert.equal(submitted.status, 201);
  assert.equal(submitted.payload.latestReview.status, 'pending');

  const frozen = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}/draft`,
    {
      method: 'PATCH', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('edit-pending') },
      body: { expectedRevision: 2, definition: choiceDefinition() },
    },
  );
  assert.equal(frozen.status, 409);
  assert.equal(frozen.payload.code, 'typed_version_under_review');

  const professorQueue = await request('/api/question-bank/typed-authoring/reviews', {
    token: authorToken,
  });
  assert.equal(professorQueue.status, 403);
  assert.equal(professorQueue.payload.code, 'reviewer_required');

  const queue = await request('/api/question-bank/typed-authoring/reviews?limit=20', {
    token: reviewerToken,
  });
  assert.equal(queue.status, 200);
  assert.equal(queue.payload.reviews.length, 1);
  assert.equal(queue.payload.reviews[0].publicId, submitted.payload.latestReview.publicId);
  assert.doesNotMatch(JSON.stringify(queue.payload), /answer_twelve|Três caixas/);

  const approved = await request(
    `/api/question-bank/typed-authoring/reviews/${submitted.payload.latestReview.publicId}/decision`,
    {
      method: 'POST', token: reviewerToken,
      headers: { 'Idempotency-Key': operationKey('approve-first') },
      body: {
        expectedRevision: 1,
        decision: 'approved',
        reason: 'Enunciado, gabarito, acessibilidade e impressão foram conferidos.',
      },
    },
  );
  assert.equal(approved.status, 200, JSON.stringify(approved.payload));
  assert.equal(approved.payload.version.status, 'published');
  assert.equal(approved.payload.item.status, 'draft');
  assert.equal(approved.payload.item.currentVersion, null);

  const activated = await request(
    `/api/question-bank/typed-authoring/versions/${firstState.version.publicId}/activate`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('activate-first') },
      body: { expectedItemRevision: 1, expectedCurrentRevision: null },
    },
  );
  assert.equal(activated.status, 200);
  assert.equal(activated.payload.item.status, 'active');
  assert.equal(activated.payload.item.currentVersion.publicId, firstState.version.publicId);
  firstState = activated.payload;
});

test('expõe criação de nova versão, concorrência otimista e cancelamento', async () => {
  const second = await request(
    `/api/question-bank/typed-authoring/items/${firstState.item.publicId}/versions`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('create-second') },
      body: { expectedCurrentRevision: 1 },
    },
  );
  assert.equal(second.status, 201, JSON.stringify(second.payload));
  assert.equal(second.payload.version.number, 2);

  const stale = await request(
    `/api/question-bank/typed-authoring/items/${firstState.item.publicId}/versions`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('create-stale') },
      body: { expectedCurrentRevision: 2 },
    },
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.payload.code, 'stale_current_version');

  const submitted = await request(
    `/api/question-bank/typed-authoring/versions/${second.payload.version.publicId}/reviews`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('submit-second') },
      body: { expectedRevision: 1 },
    },
  );
  const cancelled = await request(
    `/api/question-bank/typed-authoring/reviews/${submitted.payload.latestReview.publicId}/cancel`,
    {
      method: 'POST', token: authorToken,
      headers: { 'Idempotency-Key': operationKey('cancel-second') },
      body: {
        expectedRevision: 1,
        reason: 'A autora identificou uma ambiguidade antes da decisão editorial.',
      },
    },
  );
  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.payload.latestReview.status, 'cancelled');
});

test('a aplicação principal registra o adaptador em caminho próprio', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(
    source,
    /app\.use\('\/api\/question-bank\/typed-authoring', require\('\.\/routes\/typedQuestionAuthoring'\)\)/,
  );
});
