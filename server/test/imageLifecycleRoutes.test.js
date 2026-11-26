const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-image-lifecycle-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'synthetic-image-lifecycle-secret-only-for-isolated-tests';
const express = require('express');
const db = require('../src/database');
const { issueUserToken } = require('../src/services/authSessions');
const { discardNewUpload, preservePreviousImage } = require('../src/services/imageLifecycle');
const app = express();
app.use(express.json());
app.use('/api/collections', require('../src/routes/collections'));
app.use('/api/question-bank', require('../src/routes/questionBank'));
app.use('/api/activity', require('../src/routes/activity'));
app.use('/uploads', require('../src/middleware/protectedUploads'));
app.use(require('../src/middleware/apiErrors'));
let server;
let base;
let admin;
let teacher;
let stranger;
let skillId;
let gradeId;

function account(role) {
  const id = Number(db.prepare("INSERT INTO users (name, email, password, role) VALUES ('Sintético', ?, 'hash', ?)")
    .run(`${randomUUID()}@example.invalid`, role).lastInsertRowid);
  return { id, token: issueUserToken(id) };
}
function imageFile() {
  const filename = `${randomUUID()}.png`;
  fs.writeFileSync(path.join(process.env.UPLOAD_DIR, filename), 'synthetic old image');
  return filename;
}
function files() { return fs.readdirSync(process.env.UPLOAD_DIR).sort(); }
function collection(filename = imageFile()) {
  const id = Number(db.prepare("INSERT INTO collections (user_id, name, image_path) VALUES (?, 'Laboratório sintético', ?)")
    .run(admin.id, filename).lastInsertRowid);
  return db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
}
function question(source = 'teacher', filename = imageFile()) {
  const id = Number(db.prepare(`INSERT INTO questions
    (question_code, skill_id, statement, image_path, difficulty, question_type, status, created_by, source)
    VALUES (?, ?, 'Enunciado anterior', ?, 'media', 'multiple_choice', 'active', ?, ?)`)
    .run(`SYN-${randomUUID()}`, skillId, filename, teacher.id, source).lastInsertRowid);
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries()) {
    db.prepare('INSERT INTO question_options (question_id, option_label, option_text, is_correct, sort_order) VALUES (?, ?, ?, ?, ?)')
      .run(id, label, `Anterior ${label}`, i === 0 ? 1 : 0, i + 1);
  }
  return db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
}
function options(id) { return db.prepare('SELECT * FROM question_options WHERE question_id = ? ORDER BY id').all(id); }
function payload(q, overrides = {}) {
  return { question_code: q.question_code, skill_id: skillId, statement: 'Enunciado atualizado',
    difficulty: 'media', development_space: 'none',
    options: ['A', 'B', 'C', 'D'].map((label, index) => ({ option_label: label, option_text: `Nova ${label}`, is_correct: index === 1 ? 1 : 0 })),
    ...overrides };
}
function form(fields, withImage = true) {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) data.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  if (withImage) data.set('image', new Blob([Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64')], { type: 'image/png' }), 'new.png');
  return data;
}
async function request(url, { method = 'GET', token = admin.token, body } = {}) {
  const response = await fetch(base + url, {
    method, headers: token ? { Authorization: `Bearer ${token}` } : {}, body,
  });
  const text = await response.text();
  return { status: response.status, text, data: response.headers.get('content-type')?.includes('application/json') ? JSON.parse(text) : null };
}
function recovery(type, id) {
  const row = db.prepare('SELECT metadata_json FROM activity_log WHERE action = ? AND entity_id = ? ORDER BY id DESC LIMIT 1')
    .get(`preserve_${type}_image`, id);
  return row ? JSON.parse(row.metadata_json) : null;
}
function failAudit(t, action) {
  db.exec(`CREATE TRIGGER synthetic_image_audit_failure BEFORE INSERT ON activity_log
    WHEN NEW.action = '${action}' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  t.after(() => db.exec('DROP TRIGGER IF EXISTS synthetic_image_audit_failure'));
}
function snapshot(q) {
  const classId = Number(db.prepare(`INSERT INTO school_classes
    (public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by)
    VALUES (?, ?, ?, ?, 2026, ?, ?)`)
    .run(randomUUID(), teacher.id, `Turma ${randomUUID()}`, gradeId, teacher.id, teacher.id).lastInsertRowid);
  const assignmentId = Number(db.prepare(`INSERT INTO class_assessment_assignments
    (public_id, class_id, owner_teacher_id, title_snapshot, snapshot_hash, question_count)
    VALUES (?, ?, ?, 'Avaliação sintética', ?, 1)`)
    .run(randomUUID(), classId, teacher.id, 'a'.repeat(64)).lastInsertRowid);
  const id = Number(db.prepare(`INSERT INTO class_assessment_items
    (assignment_id, class_id, owner_teacher_id, source_question_id, question_code_snapshot,
     statement_snapshot, image_path_snapshot, difficulty_snapshot, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'media', 1)`)
    .run(assignmentId, classId, teacher.id, q.id, q.question_code, q.statement, q.image_path).lastInsertRowid);
  return db.prepare('SELECT * FROM class_assessment_items WHERE id = ?').get(id);
}

test.before(async () => {
  admin = account('admin'); teacher = account('professor'); stranger = account('professor');
  gradeId = Number(db.prepare("INSERT INTO grades (name) VALUES ('Ano sintético')").run().lastInsertRowid);
  const unitId = Number(db.prepare("INSERT INTO bncc_units (name) VALUES ('Unidade sintética')").run().lastInsertRowid);
  skillId = Number(db.prepare("INSERT INTO bncc_skills (code, description, grade_id, unit_id) VALUES ('SYN01', 'Habilidade sintética', ?, ?)")
    .run(gradeId, unitId).lastInsertRowid);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => {
  await new Promise(resolve => server.close(resolve));
  db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('laboratório troca imagem com histórico técnico e não publica a imagem retirada', async () => {
  const before = collection();
  const response = await request(`/api/collections/${before.id}`, { method: 'PUT', body: form({ name: 'Atualizado' }) });
  assert.equal(response.status, 200);
  assert.notEqual(response.data.image_path, before.image_path);
  assert.equal(fs.readFileSync(path.join(process.env.UPLOAD_DIR, before.image_path), 'utf8'), 'synthetic old image');
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, response.data.image_path)), true);
  const record = recovery('collection', before.id);
  assert.deepEqual(record.recovery.previous, before);
  assert.equal(record.replacement_path, response.data.image_path);
  assert.equal(record.reason, 'replaced');
  assert.equal((await request(`/uploads/${before.image_path}`)).status, 404);
  assert.equal((await request(`/uploads/${response.data.image_path}`)).status, 200);
  assert.equal((await request(`/uploads/${response.data.image_path}`, { token: stranger.token })).status, 404);
});

for (const action of ['update_collection', 'preserve_collection_image']) {
  test(`falha de ${action} desfaz troca, preserva original e limpa somente upload novo`, async t => {
    const before = collection();
    const diskBefore = files();
    failAudit(t, action);
    const response = await request(`/api/collections/${before.id}`, { method: 'PUT', body: form({ name: 'Não persistir' }) });
    assert.equal(response.status, 500);
    assert.deepEqual(db.prepare('SELECT * FROM collections WHERE id = ?').get(before.id), before);
    assert.deepEqual(files(), diskBefore);
    assert.equal(recovery('collection', before.id), null);
  });
}

test('falha SQL no laboratório não apaga a imagem anterior', async t => {
  const before = collection();
  const diskBefore = files();
  db.exec("CREATE TRIGGER synthetic_collection_failure BEFORE UPDATE ON collections BEGIN SELECT RAISE(ABORT, 'synthetic SQL failure'); END;");
  t.after(() => db.exec('DROP TRIGGER synthetic_collection_failure'));
  assert.equal((await request(`/api/collections/${before.id}`, { method: 'PUT', body: form({ name: 'Falha' }) })).status, 500);
  assert.deepEqual(db.prepare('SELECT * FROM collections WHERE id = ?').get(before.id), before);
  assert.deepEqual(files(), diskBefore);
  assert.equal(recovery('collection', before.id), null);
});

test('criação de laboratório exige auditoria e não deixa upload órfão se falhar', async t => {
  const diskBefore = files();
  const countBefore = db.prepare('SELECT COUNT(*) FROM collections').pluck().get();
  failAudit(t, 'create_collection');
  assert.equal((await request('/api/collections', { method: 'POST', body: form({ name: 'Novo' }) })).status, 500);
  assert.equal(db.prepare('SELECT COUNT(*) FROM collections').pluck().get(), countBefore);
  assert.deepEqual(files(), diskBefore);
});

test('exclusão de laboratório guarda vínculos e imagem compartilhada sem alterar outro laboratório', async () => {
  const before = collection();
  const shared = collection(before.image_path);
  const materialId = Number(db.prepare("INSERT INTO materials (title, created_by) VALUES ('Material sintético', ?)").run(admin.id).lastInsertRowid);
  db.prepare('INSERT INTO collection_items (collection_id, material_id) VALUES (?, ?)').run(before.id, materialId);
  const links = db.prepare('SELECT * FROM collection_items WHERE collection_id = ?').all(before.id);
  assert.equal((await request(`/api/collections/${before.id}`, { method: 'DELETE' })).status, 200);
  assert.equal(db.prepare('SELECT * FROM collections WHERE id = ?').get(before.id), undefined);
  assert.deepEqual(db.prepare('SELECT * FROM collections WHERE id = ?').get(shared.id), shared);
  assert.deepEqual(recovery('collection', before.id).recovery.relatedRows.collection_items, links);
  assert.equal((await request(`/uploads/${before.image_path}`)).status, 200);
});

test('exclusão de laboratório é revertida com vínculos quando auditoria falha', async t => {
  const before = collection();
  const materialId = Number(db.prepare("INSERT INTO materials (title, created_by) VALUES ('Vínculo sintético', ?)").run(admin.id).lastInsertRowid);
  db.prepare('INSERT INTO collection_items (collection_id, material_id) VALUES (?, ?)').run(before.id, materialId);
  const links = db.prepare('SELECT * FROM collection_items WHERE collection_id = ?').all(before.id);
  failAudit(t, 'delete_collection');
  assert.equal((await request(`/api/collections/${before.id}`, { method: 'DELETE' })).status, 500);
  assert.deepEqual(db.prepare('SELECT * FROM collections WHERE id = ?').get(before.id), before);
  assert.deepEqual(db.prepare('SELECT * FROM collection_items WHERE collection_id = ?').all(before.id), links);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, before.image_path)), true);
  assert.equal(recovery('collection', before.id), null);
});

for (const source of ['teacher', 'official']) {
  const route = source === 'teacher' ? 'author-questions' : 'questions';
  const action = source === 'teacher' ? 'update_teacher_question' : 'update_question';
  for (const remove of [false, true]) {
    test(`${route}: ${remove ? 'remoção' : 'troca'} de imagem preserva avaliação congelada e alternativas anteriores`, async () => {
      const before = question(source);
      const oldOptions = options(before.id);
      const item = snapshot(before);
      const response = await request(`/api/question-bank/${route}/${before.id}`, {
        method: 'PUT', token: source === 'teacher' ? teacher.token : admin.token,
        body: form(payload(before, { remove_image: remove }), !remove),
      });
      assert.equal(response.status, 200, response.text);
      assert.notEqual(response.data.image_path, before.image_path);
      if (remove) assert.equal(response.data.image_path, null);
      const record = recovery('question', before.id);
      assert.equal(record.file_path, before.image_path);
      assert.equal(record.reason, remove ? 'removed' : 'replaced');
      assert.deepEqual(record.recovery.relatedRows.question_options, oldOptions);
      assert.deepEqual(db.prepare('SELECT * FROM class_assessment_items WHERE id = ?').get(item.id), item);
      assert.equal((await request(`/uploads/${before.image_path}`, { token: teacher.token })).status, 200);
      assert.equal((await request(`/uploads/${before.image_path}`, { token: stranger.token })).status, 404);
      assert.equal((await request(`/uploads/${before.image_path}`, { token: null })).status, 404);
    });
  }
  for (const failure of [action, 'preserve_question_image']) {
    test(`${route}: falha de ${failure} reverte imagem, enunciado e alternativas`, async t => {
      const before = question(source);
      const oldOptions = options(before.id);
      const diskBefore = files();
      failAudit(t, failure);
      const response = await request(`/api/question-bank/${route}/${before.id}`, { method: 'PUT', body: form(payload(before)) });
      assert.equal(response.status, 500, response.text);
      assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id = ?').get(before.id), before);
      assert.deepEqual(options(before.id), oldOptions);
      assert.deepEqual(files(), diskBefore);
      assert.equal(recovery('question', before.id), null);
    });
  }
}

test('questão autoral excluída mantém imagem do snapshot e histórico técnico', async () => {
  const before = question();
  const oldOptions = options(before.id);
  const item = snapshot(before);
  const response = await request(`/api/question-bank/author-questions/${before.id}`, { method: 'DELETE', token: teacher.token });
  assert.equal(response.status, 200, response.text);
  assert.equal(db.prepare('SELECT * FROM questions WHERE id = ?').get(before.id), undefined);
  assert.deepEqual(recovery('question', before.id).recovery.relatedRows.question_options, oldOptions);
  assert.deepEqual(db.prepare('SELECT * FROM class_assessment_items WHERE id = ?').get(item.id), { ...item, source_question_id: null });
  assert.equal((await request(`/uploads/${before.image_path}`, { token: teacher.token })).status, 200);
});

test('exclusão de questão autoral falha atomicamente sem auditoria', async t => {
  const before = question();
  const oldOptions = options(before.id);
  failAudit(t, 'delete_teacher_question');
  assert.equal((await request(`/api/question-bank/author-questions/${before.id}`, { method: 'DELETE', token: teacher.token })).status, 500);
  assert.deepEqual(db.prepare('SELECT * FROM questions WHERE id = ?').get(before.id), before);
  assert.deepEqual(options(before.id), oldOptions);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, before.image_path)), true);
  assert.equal(recovery('question', before.id), null);
});

test('falhas de autorização e validação não alteram originais nem deixam novos uploads', async () => {
  const q = question();
  const c = collection();
  const diskBefore = files();
  assert.equal((await request(`/api/question-bank/author-questions/${q.id}`, {
    method: 'PUT', token: stranger.token, body: form(payload(q)),
  })).status, 403);
  assert.equal((await request(`/api/collections/${c.id}`, { method: 'PUT', token: teacher.token, body: form({ name: 'Negado' }) })).status, 403);
  assert.equal((await request(`/api/collections/${c.id}`, { method: 'PUT', body: form({ name: '' }) })).status, 400);
  assert.equal((await request(`/api/question-bank/author-questions/${q.id}`, { method: 'PUT', body: form(payload(q, { statement: '' })) })).status, 400);
  assert.deepEqual(files(), diskBefore);
});

test('edição sem trocar imagem mantém caminhos legados e não cria histórico de retirada', async () => {
  const filename = imageFile();
  const c = collection(`/uploads/${filename}`);
  const q = question('teacher', `/uploads/${filename}`);
  const diskBefore = files();
  assert.equal((await request(`/api/collections/${c.id}`, { method: 'PUT', body: form({ name: 'Somente texto' }, false) })).status, 200);
  const response = await request(`/api/question-bank/author-questions/${q.id}`, { method: 'PUT', body: form(payload(q), false) });
  assert.equal(response.status, 200);
  assert.equal(response.data.image_path, q.image_path);
  assert.equal(recovery('collection', c.id), null);
  assert.equal(recovery('question', q.id), null);
  assert.deepEqual(files(), diskBefore);
  assert.equal((await request(`/uploads/${filename}`, { token: teacher.token })).status, 200);
  discardNewUpload(filename);
  assert.deepEqual(files(), diskBefore);
});

test('histórico técnico de recuperação fica no relatório administrativo, não na atividade pessoal', async () => {
  const q = question();
  assert.equal((await request(`/api/question-bank/author-questions/${q.id}`, {
    method: 'PUT', token: teacher.token, body: form(payload(q)),
  })).status, 200);
  const mine = await request('/api/activity/me', { token: teacher.token });
  assert.equal(mine.status, 200);
  assert.equal(mine.data.some(row => row.action === 'preserve_question_image'), false);
  assert.equal(mine.data.some(row => row.action === 'update_teacher_question'), true);
  assert.equal((await request('/api/activity/timeline', { token: teacher.token })).status, 403);
  const timeline = await request(`/api/activity/timeline?action=preserve_question_image&entity_id=${q.id}`);
  assert.equal(timeline.status, 200);
  assert.equal(timeline.data.data.length, 1);
  assert.equal(timeline.data.data[0].action, 'preserve_question_image');
  assert.equal(JSON.stringify(timeline.data).includes(q.image_path), true);
});

test('limpeza defensiva não remove imagem já confirmada nem aceita caminho arbitrário', () => {
  const c = collection();
  discardNewUpload(c.image_path);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, c.image_path)), true);
  const outside = path.join(temp, 'outside.png');
  fs.writeFileSync(outside, 'preserve');
  discardNewUpload('../outside.png');
  assert.equal(fs.readFileSync(outside, 'utf8'), 'preserve');
  const uncommitted = imageFile();
  discardNewUpload(uncommitted);
  discardNewUpload(uncommitted);
  assert.equal(fs.existsSync(path.join(process.env.UPLOAD_DIR, uncommitted)), false);
  assert.throws(() => preservePreviousImage({ user: admin }, 'collection', c, null, 'deleted'), /transaction/);
});

test('banco temporário mantém integridade referencial após todos os cenários', () => {
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
