const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-grade-filter-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'grade-filter-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const materialsRouter = require('../src/routes/materials');
const questionBankRouter = require('../src/routes/questionBank');

const app = express();
app.use(express.json());
app.use('/api/materials', materialsRouter);
app.use('/api/question-bank', questionBankRouter);
app.use((error, _req, res, _next) => res.status(500).json({ error: error.message }));

let server;
let baseUrl;
let professor;
let token;
let firstGradeId;
let secondGradeId;

function insertUser() {
  const user = {
    name: 'Professora Filtros',
    email: 'professora-filtros@teste.local',
    role: 'professor',
  };
  user.id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-de-teste', 'professor')
  `).run(user.name, user.email).lastInsertRowid);
  return user;
}

async function get(urlPath) {
  const response = await fetch(`${baseUrl}${urlPath}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  return { status: response.status, payload: await response.json() };
}

test.before(async () => {
  professor = insertUser();
  token = jwt.sign(professor, process.env.JWT_SECRET, { expiresIn: '10m' });
  firstGradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('4º Ano - EF', 4)")
    .run().lastInsertRowid);
  secondGradeId = Number(db.prepare("INSERT INTO grades (name, sort_order) VALUES ('8º Ano - EF', 8)")
    .run().lastInsertRowid);
  const disciplineId = Number(db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')")
    .run().lastInsertRowid);
  const materialTypeId = Number(db.prepare("INSERT INTO material_types (name) VALUES ('Caderno')")
    .run().lastInsertRowid);
  db.prepare(`
    INSERT INTO materials (title, discipline_id, grade_id, material_type_id, created_by)
    VALUES ('Material quarto ano', ?, ?, ?, ?), ('Material oitavo ano', ?, ?, ?, ?)
  `).run(
    disciplineId, firstGradeId, materialTypeId, professor.id,
    disciplineId, secondGradeId, materialTypeId, professor.id
  );

  const unitId = Number(db.prepare("INSERT INTO bncc_units (name) VALUES ('Números')")
    .run().lastInsertRowid);
  const firstSkillId = Number(db.prepare(`
    INSERT INTO bncc_skills (code, description, grade_id, unit_id)
    VALUES ('EF04MA01', 'Habilidade do quarto ano', ?, ?)
  `).run(firstGradeId, unitId).lastInsertRowid);
  const secondSkillId = Number(db.prepare(`
    INSERT INTO bncc_skills (code, description, grade_id, unit_id)
    VALUES ('EF08MA01', 'Habilidade do oitavo ano', ?, ?)
  `).run(secondGradeId, unitId).lastInsertRowid);
  db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, difficulty, status, reviewed, source, created_by
    ) VALUES
      ('EF04MA01-FILTRO', ?, 'Questão do quarto ano', 'facil', 'active', 1, 'official', ?),
      ('EF08MA01-FILTRO', ?, 'Questão do oitavo ano', 'facil', 'active', 1, 'official', ?)
  `).run(firstSkillId, professor.id, secondSkillId, professor.id);

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

test('Meus anos preserva todos os resultados quando a seleção está vazia', async () => {
  const materials = await get('/api/materials?my_grades=1');
  const questions = await get('/api/question-bank/questions?my_grades=1');

  assert.equal(materials.status, 200);
  assert.equal(materials.payload.pagination.total, 2);
  assert.equal(questions.status, 200);
  assert.equal(questions.payload.pagination.total, 2);
});

test('Meus anos filtra Biblioteca, questões e habilidades pela preferência atual', async () => {
  db.prepare('INSERT INTO teacher_grade_preference_profiles (teacher_id) VALUES (?)')
    .run(professor.id);
  db.prepare('INSERT INTO teacher_grade_preferences (teacher_id, grade_id) VALUES (?, ?)')
    .run(professor.id, firstGradeId);

  const materials = await get('/api/materials?my_grades=1');
  const questions = await get('/api/question-bank/questions?my_grades=1');
  const skills = await get('/api/question-bank/skills?my_grades=1');

  assert.deepEqual(materials.payload.data.map(({ title }) => title), ['Material quarto ano']);
  assert.deepEqual(questions.payload.data.map(({ question_code: code }) => code), ['EF04MA01-FILTRO']);
  assert.deepEqual(skills.payload.map(({ code }) => code), ['EF04MA01']);
});

test('um ano explícito prevalece sobre Meus anos sem virar controle de acesso', async () => {
  const materials = await get(`/api/materials?my_grades=1&grade_id=${secondGradeId}`);
  const questions = await get(`/api/question-bank/questions?my_grades=1&grade_id=${secondGradeId}`);

  assert.deepEqual(materials.payload.data.map(({ title }) => title), ['Material oitavo ano']);
  assert.deepEqual(questions.payload.data.map(({ question_code: code }) => code), ['EF08MA01-FILTRO']);
});
