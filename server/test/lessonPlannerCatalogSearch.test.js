const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-planner-catalog-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(directory, 'test.sqlite');
process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.JWT_SECRET = 'isolated-lesson-catalog-tests-long-secret';
const db = require('../src/database');
const express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const app = express();
app.use('/api/lesson-plans', require('../src/routes/lessonPlanner'));
app.use(require('../src/middleware/apiErrors'));
let server, origin, teacher, other, admin, token, adminToken, gradeId, otherGradeId, disciplineId, otherDisciplineId, skillId, otherSkillId;
const categories = ['materials', 'questions', 'questionSets'];
const corpus = { materials: [], questions: [], questionSets: [] };
const ids = {};

function material(title, overrides = {}) {
  const values = { gradeId, disciplineId, description: '', updatedAt: '2026-10-12 00:00:00', ...overrides };
  return Number(db.prepare(`INSERT INTO materials(title,description,grade_id,discipline_id,created_by,updated_at)
    VALUES(?,?,?,?,?,?)`).run(title, values.description, values.gradeId, values.disciplineId, admin.id, values.updatedAt).lastInsertRowid);
}

function question(title, overrides = {}) {
  const values = { code: `CAT-${randomUUID()}`, skillId, source: 'official', owner: null, status: 'active', options: 4, correct: 1, ...overrides };
  const id = Number(db.prepare(`INSERT INTO questions(question_code,skill_id,statement,difficulty,status,source,created_by)
    VALUES(?,?,?,'media',?,?,?)`).run(values.code, values.skillId, title, values.status, values.source, values.owner).lastInsertRowid);
  for (let index = 0; index < values.options; index++) db.prepare(`INSERT INTO question_options
    (question_id,option_label,option_text,is_correct,sort_order) VALUES(?,?,?,?,?)`)
    .run(id, ['A', 'B', 'C', 'D'][index], `Alternativa ${index}`, Number(index < values.correct), index);
  return id;
}

function questionSet(title, questions, overrides = {}) {
  const values = { owner: teacher.id, isPublic: 0, updatedAt: '2026-10-12 00:00:00', ...overrides };
  const id = Number(db.prepare(`INSERT INTO question_sets(user_id,title,is_public,updated_at) VALUES(?,?,?,?)`)
    .run(values.owner, title, values.isPublic, values.updatedAt).lastInsertRowid);
  questions.forEach((questionId, order) => db.prepare(`INSERT INTO question_set_items(question_set_id,question_id,sort_order)
    VALUES(?,?,?)`).run(id, questionId, order));
  return id;
}

async function request(query, options = {}) {
  const suffix = typeof query === 'string' ? query : new URLSearchParams({ skillIds: String(skillId), ...query }).toString();
  const currentToken = options.token === undefined ? token : options.token;
  const response = await fetch(`${origin}/api/lesson-plans/catalog/resources?${suffix}`, {
    headers: currentToken ? { Authorization: `Bearer ${currentToken}` } : {},
  });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
}

async function search(category, overrides = {}) {
  const response = await request({ category, ...overrides });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  assert.match(response.cache, /no-store/);
  return response.body;
}

test.before(async () => {
  const user = role => ({ id: Number(db.prepare(`INSERT INTO users(name,email,password,role)
    VALUES('Conta sintética',?,'synthetic',?)`).run(`${randomUUID()}@catalog.invalid`, role).lastInsertRowid), role });
  teacher = user('professor'); other = user('professor'); admin = user('admin');
  token = issueUserToken(teacher.id); adminToken = issueUserToken(admin.id);
  db.prepare(`UPDATE feature_flags SET master_enabled=1,default_enabled=1 WHERE flag_key='planning.lesson_planner'`).run();
  for (const actor of [teacher, other]) db.prepare(`INSERT INTO feature_flag_user_rules
    (feature_flag_id,user_id,enabled,reason,created_by,updated_by)
    SELECT id,?,1,'Teste sintético do catálogo',?,? FROM feature_flags WHERE flag_key='planning.lesson_planner'`)
    .run(actor.id, admin.id, admin.id);
  gradeId = Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('6º catálogo',6)").run().lastInsertRowid);
  otherGradeId = Number(db.prepare("INSERT INTO grades(name,sort_order) VALUES('7º catálogo',7)").run().lastInsertRowid);
  disciplineId = Number(db.prepare("INSERT INTO disciplines(name) VALUES('Matemática catálogo')").run().lastInsertRowid);
  otherDisciplineId = Number(db.prepare("INSERT INTO disciplines(name) VALUES('Ciências catálogo')").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units(name) VALUES('Números catálogo')").run().lastInsertRowid);
  const addSkill = (code, grade) => Number(db.prepare(`INSERT INTO bncc_skills(code,description,grade_id,unit_id)
    VALUES(?,'Habilidade sintética',?,?)`).run(code, grade, unitId).lastInsertRowid);
  skillId = addSkill('EF06MA01-CAT', gradeId); otherSkillId = addSkill('EF07MA01-CAT', otherGradeId);
  db.transaction(() => {
    for (let index = 0; index < 45; index++) {
      const number = String(index).padStart(3, '0');
      const materialTitle = `Lote catálogo ${number}${index === 0 ? ' Sentinela ação' : ''}`;
      const questionTitle = `Lote catálogo ${number}${index === 44 ? ' Sentinela ação' : ''}`;
      const updatedAt = index === 0 ? '2020-01-01 00:00:00' : '2026-10-12 00:00:00';
      corpus.materials.push(material(materialTitle, { updatedAt }));
      corpus.questions.push(question(questionTitle, { code: `Q-CATALOG-${number}` }));
      corpus.questionSets.push(questionSet(materialTitle, [corpus.questions[index]], { updatedAt }));
    }
    ids.literalMaterial = material('Literal 100%_\\ final');
    ids.literalQuestion = question('Literal 100%_\\ final');
    ids.literalSet = questionSet('Literal 100%_\\ final', [ids.literalQuestion]);
    ids.ownQuestion = question('Autoria própria', { source: 'teacher', owner: teacher.id });
    ids.foreignQuestion = question('Autoria privada alheia', { source: 'teacher', owner: other.id });
    ids.inactiveQuestion = question('Questão arquivada', { status: 'inactive' });
    ids.incompleteQuestion = question('Questão incompleta', { options: 3 });
    ids.ambiguousQuestion = question('Questão ambígua', { correct: 2 });
    ids.otherSkillQuestion = question('Outra habilidade', { skillId: otherSkillId });
    ids.foreignSet = questionSet('Conjunto privado alheio', [corpus.questions[0]], { owner: other.id });
    ids.publicSet = questionSet('Conjunto público alheio', [corpus.questions[0]], { owner: other.id, isPublic: 1 });
    ids.otherSkillSet = questionSet('Conjunto de outra habilidade', [ids.otherSkillQuestion]);
    ids.emptySet = questionSet('Conjunto vazio', []);
    ids.unmapped = material('Ano diferente sem vínculo', { gradeId: otherGradeId });
    ids.linked = material('Ano diferente vinculado', { gradeId: otherGradeId });
    ids.pending = material('Ano diferente pendente', { gradeId: otherGradeId });
    ids.wrongDiscipline = material('Outro componente', { disciplineId: otherDisciplineId });
    ids.noDiscipline = material('Componente não informado', { disciplineId: null });
    ids.sameGradePending = material('Mesmo ano pendente');
    for (const id of [ids.linked, ids.pending, ids.sameGradePending]) {
      db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES(?,?,?)').run(id, skillId, admin.id);
    }
    for (const id of [ids.pending, ids.sameGradePending]) db.prepare(`INSERT INTO material_bncc_review_state
      (material_id,skill_id,needs_review) VALUES(?,?,1)`).run(id, skillId);
    db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES(?,?,?)').run(ids.linked, otherSkillId, admin.id);
    const retired = material('Material retirado');
    db.prepare('DELETE FROM materials WHERE id=?').run(retired);
  })();
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => {
    origin = `http://127.0.0.1:${server.address().port}`; resolve();
  }); });
});

test.after(async () => {
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  db.close();
  assert.equal(path.dirname(directory), path.resolve(os.tmpdir()));
  assert.match(path.basename(directory), /^labmathic-planner-catalog-/);
  fs.rmSync(directory, { recursive: true, force: true });
});

for (const category of categories) test(`${category}: percorre todo o lote, sem repetição, e encontra recurso fora dos 30 legados`, async () => {
  const before = db.prepare('SELECT total_changes()').pluck().get();
  const pages = [];
  for (const page of [1, 2, 3]) pages.push(await search(category, { search: 'lote catalogo', page: String(page) }));
  assert.deepEqual(pages.map(value => value.items.length), [20, 20, 5]);
  assert.ok(pages.every(value => value.total === 45 && value.totalPages === 3 && value.pageSize === 20 && value.category === category));
  const found = pages.flatMap(value => value.items.map(item => item.id));
  assert.equal(new Set(found).size, 45);
  assert.deepEqual([...found].sort((a, b) => a - b), corpus[category]);
  assert.deepEqual((await search(category, { search: 'lote catalogo' })).items, pages[0].items);
  assert.equal((await search(category, { search: 'lote catalogo', page: '4' })).items.length, 0);
  const target = category === 'questions' ? corpus.questions.at(-1) : corpus[category][0];
  const legacy = await request({ search: 'Lote catálogo' });
  assert.equal(legacy.status, 200);
  assert.equal(legacy.body[category].length, 30);
  assert.ok(!legacy.body[category].some(item => item.id === target));
  const result = await search(category, { search: 'SENTINELA ACAO' });
  assert.equal(result.total, 1);
  assert.equal(result.items[0].id, target);
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), before);
});

test('busca por código e por descrição mantém termos literais, incluindo %, _ e barra', async () => {
  assert.equal((await search('questions', { search: 'q-catalog-044' })).items[0].id, corpus.questions[44]);
  const description = material('Título sem o termo', { description: 'Uma sequência de frações equivalentes.' });
  assert.equal((await search('materials', { search: 'FRACOES EQUIVALENTES' })).items[0].id, description);
  for (const category of categories) for (const term of ['%', '_', '\\', '100%_\\']) {
    const result = await search(category, { search: term });
    assert.equal(result.total, 1, `${category} ${term}`);
    assert.match(result.items[0].title, /Literal/);
  }
  for (const category of categories) assert.equal((await search(category, { search: "' OR 1=1 --" })).total, 0);
});

test('preserva autoria, disponibilidade das questões e alinhamento dos conjuntos', async () => {
  const questions = (await search('questions', { search: 'Autoria' })).items;
  assert.deepEqual(questions.map(item => item.id), [ids.ownQuestion]);
  for (const term of ['arquivada', 'incompleta', 'ambígua', 'Outra habilidade']) {
    assert.equal((await search('questions', { search: term })).total, 0, term);
  }
  assert.equal((await search('questionSets', { search: 'privado alheio' })).total, 0);
  assert.equal((await search('questionSets', { search: 'público alheio' })).items[0].id, ids.publicSet);
  assert.equal((await search('questionSets', { search: 'outra habilidade' })).total, 0);
  assert.equal((await search('questionSets', { search: 'vazio' })).total, 0);
  const otherToken = issueUserToken(other.id);
  assert.equal((await request({ category: 'questionSets', search: 'privado alheio' }, { token: otherToken })).body.items[0].id, ids.foreignSet);
  assert.equal((await request({ category: 'questions', search: 'Autoria própria' }, { token: otherToken })).body.total, 0);
});

test('materiais preservam ano, componente, vínculo elegível e deduplicação de habilidades', async () => {
  const filters = { gradeId: String(gradeId), disciplineId: String(disciplineId) };
  const crossGrade = await search('materials', { ...filters, search: 'Ano diferente' });
  assert.deepEqual(crossGrade.items.map(item => [item.id, item.skillMatch]), [[ids.linked, 1]]);
  assert.equal((await search('materials', { ...filters, search: 'Outro componente' })).total, 0);
  assert.equal((await search('materials', { ...filters, search: 'Componente não informado' })).items[0].id, ids.noDiscipline);
  assert.equal((await search('materials', { ...filters, search: 'Mesmo ano pendente' })).items[0].skillMatch, 0);
  const multiple = await search('materials', { ...filters, search: 'Ano diferente vinculado', skillIds: `${skillId},${otherSkillId}` });
  assert.equal(multiple.total, 1); assert.equal(multiple.items.length, 1);
  assert.equal((await search('materials', { search: 'Material retirado' })).total, 0);
});

test('legado mantém formato, limite e busca existentes quando category e page estão ausentes', async () => {
  const legacy = await request({ search: 'Lote catálogo' });
  assert.equal(legacy.status, 200);
  assert.deepEqual(Object.keys(legacy.body).sort(), [...categories].sort());
  assert.ok(categories.every(category => legacy.body[category].length === 30));
  assert.equal((await request({ search: 'Q-CATALOG-044' })).body.questions[0].id, corpus.questions[44]);
  assert.equal((await request({ skillIds: '' })).status, 400);
});

test('valida tipos, categoria, página, tamanho da busca e IDs sem coerções silenciosas', async () => {
  const invalidQueries = [
    { category: 'unknown' }, { category: '' }, { category: undefined, page: '1' },
    { page: '0' }, { page: '-1' }, { page: '1.5' }, { page: '1e2' }, { page: '1000001' }, { page: 'NaN' },
    { search: 'x'.repeat(101) }, { skillIds: '' }, { skillIds: '1,,2' }, { skillIds: '-1' },
    { skillIds: '1.5' }, { skillIds: '99999999' }, { skillIds: '9007199254740993' },
    { skillIds: Array(11).fill(skillId).join(',') }, { gradeId: '0' }, { gradeId: '99999999' },
    { disciplineId: '-1' }, { disciplineId: '99999999' },
  ];
  for (const query of invalidQueries) {
    const values = { category: 'materials', ...query };
    if (values.category === undefined) delete values.category;
    const result = await request(values);
    assert.equal(result.status, 400, JSON.stringify(query));
    assert.equal(result.body.code, 'invalid_catalog_query');
  }
  for (const extra of ['category=materials&category=questions', 'category[]=materials',
    'category=materials&page[]=1', 'category=materials&search[x]=a', 'category=materials&skillIds[]=1',
    'category=materials&gradeId[]=1', 'category=materials&disciplineId[x]=1']) {
    const result = await request(`skillIds=${skillId}&${extra}`);
    assert.equal(result.status, 400, extra);
  }
  assert.equal((await search('materials', { search: 'x'.repeat(100) })).total, 0);
  assert.equal((await search('materials', { skillIds: `${skillId},${skillId}` })).category, 'materials');
});

test('sessão, flag e papel atual continuam obrigatórios para cada categoria', async () => {
  for (const category of categories) {
    assert.equal((await request({ category }, { token: null })).status, 401);
    assert.equal((await request({ category }, { token: adminToken })).status, 403);
  }
  db.prepare("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético do catálogo' WHERE flag_key='planning.lesson_planner'").run();
  try { for (const category of categories) assert.equal((await request({ category })).status, 404); }
  finally { db.prepare("UPDATE feature_flags SET kill_switch_active=0 WHERE flag_key='planning.lesson_planner'").run(); }
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher.id);
  try {
    const changedRoleToken = issueUserToken(teacher.id);
    for (const category of categories) {
      assert.equal((await request({ category })).status, 401);
      assert.equal((await request({ category }, { token: changedRoleToken })).status, 403);
    }
  }
  finally { db.prepare("UPDATE users SET role='professor' WHERE id=?").run(teacher.id); }
});
