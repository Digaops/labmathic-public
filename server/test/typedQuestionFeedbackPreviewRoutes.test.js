const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-feedback-preview-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDirectory, 'database.sqlite');
process.env.JWT_SECRET = 'feedback-preview-route-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const router = require('../src/routes/typedQuestionFeedbackPreview');

const app = express();
app.use(express.json());
app.use('/api/question-bank/feedback-preview', router);
app.use((_req, res) => res.status(404).json({ error: 'Rota de teste não prevista.' }));

let server;
let baseUrl;
let admin;
let professor;

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

function enableFor(...users) {
  const flagId = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'question_bank.feedback_preview'
  `).pluck().get();
  db.prepare(`UPDATE feature_flags SET master_enabled = 1 WHERE id = ?`).run(flagId);
  const addRule = db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Prévia de devolutiva somente leitura', ?, ?)
  `);
  for (const user of users) addRule.run(flagId, user.id, admin.id, admin.id);
}

async function request(pathname, { token, method = 'GET' } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/api/question-bank/feedback-preview${pathname}`, {
    method,
    headers,
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'),
    payload: await response.json(),
  };
}

test.before(async () => {
  admin = addUser('Admin da Devolutiva', 'admin-feedback@teste.local', 'admin');
  professor = addUser('Professora da Devolutiva', 'professora-feedback@teste.local', 'professor');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('exige autenticação e falha fechada antes de revelar o catálogo', async () => {
  const unauthenticated = await request('/catalog');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.cacheControl, /no-store/);

  const disabled = await request('/catalog', { token: tokenFor(professor) });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.payload.code, 'feature_disabled');
  enableFor(admin, professor);
});

test('admin e professor recebem o mesmo catálogo sem escrita', async () => {
  const beforeChanges = db.prepare('SELECT total_changes()').pluck().get();
  for (const user of [admin, professor]) {
    const response = await request('/catalog', {
      token: tokenFor(user, { role: user === admin ? 'professor' : 'admin' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.cacheControl, /no-store/);
    assert.match(response.vary, /Authorization/);
    assert.equal(response.payload.readOnly, true);
    assert.equal(response.payload.examples.length, 3);
    assert.doesNotMatch(JSON.stringify(response.payload), /answerKey|referenceAnswer|resolutionSteps/);
  }
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), beforeChanges);
});

test('rota filtra a devolutiva no servidor para cada política', async () => {
  const token = tokenFor(professor);
  const protectedResponse = await request('/examples/even-numbers-feedback?view=after_submission', { token });
  assert.equal(protectedResponse.status, 200);
  assert.equal(protectedResponse.payload.feedback.available, false);
  assert.doesNotMatch(JSON.stringify(protectedResponse.payload), /referenceAnswer|resolutionSteps|misconception|"score"|isCorrect/);

  const released = await request('/examples/even-numbers-feedback?view=assessment_closed', { token });
  assert.equal(released.status, 200);
  assert.equal(released.payload.feedback.available, true);
  assert.equal(released.payload.feedback.evidence.score, 0.5);
  assert.deepEqual(released.payload.feedback.guide.choiceInsights, []);

  const teacher = await request('/examples/fraction-half-feedback?view=teacher', { token });
  assert.equal(teacher.payload.feedback.guide.choiceInsights.length, 4);
});

test('parâmetros inválidos, usuário inexistente e escrita não alteram o banco', async () => {
  const beforeChanges = db.prepare('SELECT total_changes()').pluck().get();
  const invalidView = await request('/examples/fraction-half-feedback?view=invalid', { token: tokenFor(professor) });
  assert.equal(invalidView.status, 400);
  assert.equal(invalidView.payload.code, 'invalid_preview_view');

  const missingExample = await request('/examples/missing?view=teacher', { token: tokenFor(professor) });
  assert.equal(missingExample.status, 404);
  assert.equal(missingExample.payload.code, 'preview_example_not_found');

  const missingUser = await request('/catalog', {
    token: tokenFor({ id: 999999, name: 'Inexistente', email: 'none@teste.local', role: 'admin' }),
  });
  assert.equal(missingUser.status, 401);

  const post = await request('/catalog', { token: tokenFor(professor), method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), beforeChanges);
});
