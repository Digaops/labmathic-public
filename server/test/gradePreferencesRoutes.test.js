const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-grade-preferences-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'grade-preferences-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const authRouter = require('../src/routes/auth');

const app = express();
app.use(express.json());
app.use('/api/auth', authRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let professor;
let otherProfessor;
let admin;
let professorToken;
let otherProfessorToken;
let adminToken;
let gradeIds;

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

async function request(urlPath, options = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return { status: response.status, payload: await response.json() };
}

test.before(async () => {
  professor = insertUser('Professora Ana', 'ana-preferencias@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-preferencias@teste.local', 'professor');
  admin = insertUser('Admin', 'admin-preferencias@teste.local', 'admin');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);
  adminToken = tokenFor(admin);
  gradeIds = [
    Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('6º Ano - EF', 6)").run().lastInsertRowid),
    Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)").run().lastInsertRowid),
  ];

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

test('lista todos os anos e mantém seleção vazia como todos', async () => {
  const response = await request('/api/auth/grade-preferences', { token: professorToken });
  assert.equal(response.status, 200);
  assert.equal(response.payload.revision, 0);
  assert.equal(response.payload.selectionMode, 'all');
  assert.deepEqual(response.payload.selectedGradeIds, []);
  assert.deepEqual(response.payload.grades.map(({ id }) => id), gradeIds);
});

test('recusa acesso administrativo e token ausente', async () => {
  assert.equal((await request('/api/auth/grade-preferences')).status, 401);
  assert.equal((await request('/api/auth/grade-preferences', { token: adminToken })).status, 403);
});

test('substitui preferências atomicamente, audita e isola professores', async () => {
  const saved = await request('/api/auth/grade-preferences', {
    method: 'PUT',
    token: professorToken,
    body: { gradeIds: [gradeIds[1]], revision: 0 },
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.payload.revision, 1);
  assert.equal(saved.payload.selectionMode, 'selected');
  assert.deepEqual(saved.payload.selectedGradeIds, [gradeIds[1]]);

  const other = await request('/api/auth/grade-preferences', { token: otherProfessorToken });
  assert.deepEqual(other.payload.selectedGradeIds, []);
  assert.equal(other.payload.revision, 0);

  const audit = db.prepare(`
    SELECT action, module, metadata_json
    FROM activity_log
    WHERE user_id = ? AND action = 'update_grade_preferences'
    ORDER BY id DESC LIMIT 1
  `).get(professor.id);
  assert.equal(audit.module, 'preferences');
  assert.deepEqual(JSON.parse(audit.metadata_json), {
    selectedGradeIds: [gradeIds[1]],
    selectedCount: 1,
    selectionMode: 'selected',
  });
});

test('valida IDs, duplicidade e revisão otimista sem escrita parcial', async () => {
  const invalidGrade = await request('/api/auth/grade-preferences', {
    method: 'PUT', token: professorToken, body: { gradeIds: [999999], revision: 1 },
  });
  assert.equal(invalidGrade.status, 400);

  const duplicated = await request('/api/auth/grade-preferences', {
    method: 'PUT', token: professorToken, body: { gradeIds: [gradeIds[0], gradeIds[0]], revision: 1 },
  });
  assert.equal(duplicated.status, 400);

  const conflict = await request('/api/auth/grade-preferences', {
    method: 'PUT', token: professorToken, body: { gradeIds: [gradeIds[0]], revision: 0 },
  });
  assert.equal(conflict.status, 409);
  assert.equal(conflict.payload.code, 'PREFERENCE_REVISION_CONFLICT');

  const current = await request('/api/auth/grade-preferences', { token: professorToken });
  assert.deepEqual(current.payload.selectedGradeIds, [gradeIds[1]]);
  assert.equal(current.payload.revision, 1);
});

test('confirma o papel atual no banco mesmo com token antigo', async () => {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(otherProfessor.id);
  const response = await request('/api/auth/grade-preferences', { token: otherProfessorToken });
  assert.equal(response.status, 401); // Mudança de perfil exige uma nova sessão.
});
