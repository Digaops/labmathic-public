const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-planner-preview-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.JWT_SECRET = 'isolated-planner-resource-preview-tests';
const db = require('../src/database');
const express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const app = express();
app.use('/api/lesson-plans', require('../src/routes/lessonPlanner'));
app.use('/api/question-bank', require('../src/routes/questionBank'));
app.use(require('../src/middleware/apiErrors'));
let server, origin, teacher, other, admin, token, adminToken, skillId;
const ids = {};

function question(overrides = {}) {
  const values = { title: 'Enunciado sintético', source: 'official', owner: null, status: 'active',
    type: 'multiple_choice', options: 4, correct: 1, ...overrides };
  const id = Number(db.prepare(`INSERT INTO questions(question_code,skill_id,statement,support_text,image_path,
    difficulty,status,source,created_by,question_type,official_explanation)
    VALUES(?,?,?,'Apoio sintético','preview.png','media',?,?,?,?, 'EXPLANATION_SECRET')`)
    .run(`PREVIEW-${randomUUID()}`, skillId, values.title, values.status, values.source, values.owner, values.type).lastInsertRowid);
  for (let index = 0; index < values.options; index++) db.prepare(`INSERT INTO question_options
    (question_id,option_label,option_text,is_correct,sort_order) VALUES(?,?,?,?,?)`)
    .run(id, 'ABCD'[index], `Texto ${'ABCD'[index]}`, Number(index < values.correct), index + 1);
  return id;
}

function questionSet(questions, overrides = {}) {
  const values = { owner: teacher.id, isPublic: 0, authorContent: 0, order: 'DCBA', ...overrides };
  const id = Number(db.prepare(`INSERT INTO question_sets(user_id,title,is_public,contains_author_questions)
    VALUES(?,'Simulado sintético',?,?)`).run(values.owner, values.isPublic, values.authorContent).lastInsertRowid);
  questions.forEach((questionId, index) => db.prepare(`INSERT INTO question_set_items
    (question_set_id,question_id,sort_order,show_image,option_order) VALUES(?,?,?,?,?)`)
    .run(id, questionId, index + 1, index === 0 ? 0 : 1, values.order));
  return id;
}

async function request(type, id, auth = token, query = '') {
  const response = await fetch(`${origin}/api/lesson-plans/catalog/resources/${type}/${id}/preview${query}`, {
    headers: auth ? { Authorization: `Bearer ${auth}` } : {},
  });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

function assertNoAnswers(body) {
  assert.doesNotMatch(JSON.stringify(body), /is_correct|isCorrect|official_explanation|EXPLANATION_SECRET|answer_key|correct|created_by|creator|user_name/);
  for (const question of body.questions) {
    assert.deepEqual(Object.keys(question).sort(), ['id', 'code', 'statement', 'supportText', 'imagePath', 'skillCode', 'skillDescription', 'options'].sort());
    assert.deepEqual(question.options.map(option => Object.keys(option).sort()), Array(4).fill(['label', 'text']));
  }
}

test.before(async () => {
  const user = role => ({ id: Number(db.prepare(`INSERT INTO users(name,email,password,role)
    VALUES('Conta de teste',?,'synthetic',?)`).run(`${randomUUID()}@preview.invalid`, role).lastInsertRowid), role });
  teacher = user('professor'); other = user('professor'); admin = user('admin');
  token = issueUserToken(teacher.id); adminToken = issueUserToken(admin.id);
  db.prepare("UPDATE feature_flags SET master_enabled=1,default_enabled=1 WHERE flag_key='planning.lesson_planner'").run();
  db.prepare(`INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason,created_by,updated_by)
    SELECT id,?,1,'Teste sintético da prévia',?,? FROM feature_flags WHERE flag_key='planning.lesson_planner'`)
    .run(teacher.id, admin.id, admin.id);
  const gradeId = Number(db.prepare("INSERT INTO grades(name) VALUES('Ano sintético')").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units(name) VALUES('Unidade sintética')").run().lastInsertRowid);
  skillId = Number(db.prepare(`INSERT INTO bncc_skills(code,description,grade_id,unit_id)
    VALUES('EF06MA-PREVIEW','Habilidade sintética',?,?)`).run(gradeId, unitId).lastInsertRowid);
  db.transaction(() => {
    ids.material = Number(db.prepare(`INSERT INTO materials(title,description,file_path,file_format,external_url,created_by)
      VALUES('Material sintético','Descrição sintética','preview.pdf','pdf','https://example.invalid/material',?)`)
      .run(admin.id).lastInsertRowid);
    db.prepare("INSERT INTO material_drafts(id,owner_id,payload_json) VALUES(900001,?,'{}')").run(admin.id);
    ids.official = question(); ids.own = question({ source: 'teacher', owner: teacher.id });
    ids.foreign = question({ title: 'FOREIGN_SECRET', source: 'teacher', owner: other.id });
    ids.inactive = question({ title: 'INACTIVE_SECRET', status: 'inactive' });
    ids.incomplete = question({ options: 3 }); ids.ambiguous = question({ correct: 2 });
    ids.numeric = question({ status: 'inactive', source: 'teacher', owner: teacher.id, type: 'numeric_draft', options: 0 });
    ids.stored = questionSet([ids.official, ids.own]);
    ids.fallback = questionSet([ids.official, ids.own], { order: null });
    ids.mixedFallback = questionSet([ids.official, ids.own]);
    db.prepare('UPDATE question_set_items SET option_order=NULL WHERE question_set_id=? AND question_id=?').run(ids.mixedFallback, ids.own);
    ids.public = questionSet([ids.official], { owner: other.id, isPublic: 1 });
    ids.private = questionSet([ids.official], { owner: other.id });
    ids.publicAuthor = questionSet([ids.official], { owner: other.id, isPublic: 1, authorContent: 1 });
    ids.foreignItem = questionSet([ids.official, ids.foreign]);
    ids.inactiveItem = questionSet([ids.official, ids.inactive]);
    ids.invalidItem = questionSet([ids.official, ids.incomplete]);
    ids.empty = questionSet([]);
    ids.large = questionSet(Array.from({ length: 101 }, () => question()));
  })();
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`; resolve();
  }); });
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^labmathic-planner-preview-/);
  fs.rmSync(directory, { recursive: true, force: true });
});

test('material publicado usa projeção mínima; rascunho e recurso removido não são expostos', async () => {
  const before = db.prepare('SELECT total_changes()').pluck().get();
  const result = await request('material', ids.material);
  assert.equal(result.status, 200); assert.match(result.cache, /no-store/);
  assert.equal(result.body.type, 'material'); assert.equal(result.body.id, ids.material);
  assert.equal(result.body.material.file_path, 'preview.pdf');
  assert.equal(result.body.material.external_url, 'https://example.invalid/material');
  assert.deepEqual(Object.keys(result.body.material).sort(), ['id', 'title', 'description', 'file_path', 'file_format', 'external_url', 'duration', 'page_count', 'material_type_name', 'grade_name', 'discipline_name'].sort());
  assert.equal((await request('material', 900001)).status, 404);
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), before, 'a prévia não registra acesso nem altera o material');
  const removed = Number(db.prepare("INSERT INTO materials(title) VALUES('Removido')").run().lastInsertRowid);
  db.prepare('DELETE FROM materials WHERE id=?').run(removed);
  assert.equal((await request('material', removed)).status, 404);
});

test('questões oficiais e próprias são legíveis sem respostas, explicação ou autoria', async () => {
  for (const id of [ids.official, ids.own]) {
    const result = await request('question', id, token, '?answers=1');
    assert.equal(result.status, 200); assert.match(result.cache, /no-store/);
    assert.equal(result.body.id, id); assert.equal(result.body.questions[0].id, id);
    assert.deepEqual(result.body.questions[0].options.map(option => option.text), ['Texto A', 'Texto B', 'Texto C', 'Texto D']);
    assert.equal(result.body.questions[0].imagePath, 'preview.png');
    assertNoAnswers(result.body);
  }
});

test('ausente, privada, inativa, numérica e simulado inacessível usam a mesma resposta genérica', async () => {
  const absent = await request('question', 999999);
  assert.equal(absent.status, 404);
  for (const [type, id] of [['question', ids.foreign], ['question', ids.inactive], ['question', ids.numeric],
    ['question_set', ids.private], ['question_set', ids.publicAuthor], ['question_set', ids.foreignItem], ['question_set', ids.inactiveItem]]) {
    const result = await request(type, id);
    assert.equal(result.status, 404); assert.deepEqual(result.body, absent.body); assert.match(result.cache, /no-store/);
  }
  assert.equal((await request('question_set', ids.public)).status, 200);
});

test('ordem e imagem dos simulados correspondem à leitura canônica, inclusive fallback legado', async () => {
  for (const id of [ids.stored, ids.fallback, ids.mixedFallback]) {
    const canonical = await fetch(`${origin}/api/question-bank/question-sets/${id}`, { headers: { Authorization: `Bearer ${token}` } });
    assert.equal(canonical.status, 200); const source = await canonical.json();
    const before = db.prepare('SELECT total_changes()').pluck().get();
    const result = await request('question_set', id);
    assert.equal(result.status, 200); assertNoAnswers(result.body);
    assert.deepEqual(result.body.questions.map(question => question.options), source.questions.map(question => question.options.map(option => ({ label: option.option_label, text: option.option_text }))));
    assert.deepEqual(result.body.questions.map(question => question.imagePath), [null, 'preview.png']);
    assert.equal(db.prepare('SELECT total_changes()').pluck().get(), before, 'não grava histórico ou ordem de alternativas');
    assert.deepEqual((await request('question_set', id)).body, result.body, 'apresentação determinística');
  }
});

test('questão inválida não vira gabarito aparente nem simulado parcialmente visualizado', async () => {
  for (const [type, id] of [['question', ids.incomplete], ['question', ids.ambiguous], ['question_set', ids.invalidItem], ['question_set', ids.empty]]) {
    const result = await request(type, id);
    assert.equal(result.status, 409); assert.equal(result.body.code, 'preview_requires_review');
    assert.equal(result.body.questions, undefined); assert.doesNotMatch(JSON.stringify(result.body), /Enunciado sintético|EXPLANATION_SECRET|Texto A/);
  }
});

test('simulado excessivo tem erro explícito, nunca uma prévia truncada', async () => {
  const result = await request('question_set', ids.large);
  assert.equal(result.status, 409); assert.equal(result.body.code, 'preview_limit_exceeded');
  assert.equal(result.body.questions, undefined); assert.match(result.body.error, /100 questões/);
  const last = db.prepare('SELECT question_id FROM question_set_items WHERE question_set_id=? ORDER BY sort_order DESC LIMIT 1').pluck().get(ids.large);
  db.prepare('DELETE FROM question_set_items WHERE question_set_id=? AND question_id=?').run(ids.large, last);
  assert.equal((await request('question_set', ids.large)).body.questions.length, 100);
});

test('tipo e IDs são estritos e não aceitam coerção ou SQL como parte do caminho', async () => {
  for (const id of ['0', '-1', '1.5', '1e2', '01', 'NaN', '9007199254740993', encodeURIComponent("1 OR 1=1")]) {
    assert.equal((await request('question', id)).status, 400, id);
  }
  for (const type of ['activity', 'questions', 'unknown']) assert.equal((await request(type, ids.official)).status, 400);
});

test('sessão, papel atual e master/kill switch do planejador continuam obrigatórios', async () => {
  assert.equal((await request('question', ids.official, null)).status, 401);
  assert.equal((await request('question', ids.official, adminToken)).status, 403);
  db.prepare("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='planning.lesson_planner'").run();
  try { assert.equal((await request('question', ids.official)).status, 404); }
  finally { db.prepare("UPDATE feature_flags SET master_enabled=1 WHERE flag_key='planning.lesson_planner'").run(); }
  db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético da prévia' WHERE flag_key='planning.lesson_planner'").run();
  try { assert.equal((await request('question', ids.official)).status, 404); }
  finally { db.prepare("UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key='planning.lesson_planner'").run(); }
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher.id);
  try {
    assert.equal((await request('question', ids.official)).status, 401);
    assert.equal((await request('question', ids.official, issueUserToken(teacher.id))).status, 403);
  } finally { db.prepare("UPDATE users SET role='professor' WHERE id=?").run(teacher.id); }
});
