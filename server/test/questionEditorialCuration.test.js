const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-editorial-batch-'));
process.env.DB_PATH = path.join(temporary, 'database.sqlite');
process.env.APP_ENV = 'development';
process.env.JWT_SECRET = 'editorial-batch-local-test-secret-not-used-elsewhere';

const db = require('../src/database');
const { runMigrations } = require('../src/migrations');
const { EDITORIAL_PILOT_FLAG, isEditorialPilotEnabled, editorialEligibleSql } = require('../src/services/questionEditorialCuration');
const { questionContentDigest } = require('../src/services/installQuestionEditorialPilot');
const holds = require('../src/data/question-quality-pilot/holds.json');
const challenges = [
  ...require('../src/data/question-quality-challenge/grades1-3.json'),
  ...require('../src/data/question-quality-challenge/grades4-6.json'),
  ...require('../src/data/question-quality-challenge/grades7-9.json'),
];
const through42 = fs.readdirSync(path.join(__dirname, '../src/migrations'))
  .filter(name => /^\d{3}_/.test(name) && Number(name.slice(0, 3)) <= 42)
  .sort()
  .map(name => require(`../src/migrations/${name}`));

test.after(() => {
  db.close();
  fs.rmSync(temporary, { recursive: true, force: true });
});

test('upgrade protects exact audited items, keeps historic references, and installs drafts by BNCC', () => {
  // The test begins on a fresh disposable database with no official skills.
  assert.equal(db.prepare('SELECT COUNT(*) FROM question_editorial_curation').pluck().get(), 0);
  db.exec(`
    DROP TABLE question_editorial_curation;
    DELETE FROM feature_flags WHERE flag_key = 'question_bank.editorial_pilot';
    DELETE FROM schema_migrations WHERE version >= 42;
  `);
  const grade = db.prepare('INSERT INTO grades(name, sort_order) VALUES (?, ?)');
  const gradeIds = new Map(Array.from({ length: 9 }, (_, index) => index + 1)
    .map(year => [year, grade.run(`Turma sintética de ${year}º ano`, year).lastInsertRowid]));
  const unit = db.prepare("INSERT INTO bncc_units(name) VALUES ('Unidade sintética')").run().lastInsertRowid;
  const insertSkill = db.prepare('INSERT INTO bncc_skills(code, description, grade_id, unit_id) VALUES (?, ?, ?, ?)');
  const skills = new Map(['EF05MA06', 'EF05MA09', 'EF05MA12', 'EF05MA22', 'EF07MA17',
    'EF09MA05', 'EF09MA07', 'EF09MA08', 'EF09MA21'].map(code => [
    code, insertSkill.run(code, code, gradeIds.get(Number(code.slice(2, 4))), unit).lastInsertRowid,
  ]));
  const addLegacy = db.prepare('INSERT INTO questions(question_code,skill_id,statement,difficulty) VALUES (?, ?, ?, ?)');
  const held = addLegacy.run('EF07MA17-Q001', skills.get('EF07MA17'), 'Qual é o resultado de 5 + 3?', 'facil').lastInsertRowid;
  const updated = addLegacy.run('EF07MA17-Q002', skills.get('EF07MA17'), 'Questão corrigida após a auditoria.', 'media').lastInsertRowid;
  const addOption = db.prepare('INSERT INTO question_options(question_id,option_label,option_text,is_correct,sort_order) VALUES (?, ?, ?, ?, ?)');
  ['8', '2', '15', '53'].forEach((text, index) => addOption.run(held, 'ABCD'[index], text, Number(index === 0), index + 1));
  const teacher = Number(db.prepare("INSERT INTO users(name,email,password,role) VALUES ('Pessoa fictícia','editorial@example.invalid','hash','professor')").run().lastInsertRowid);
  const set = db.prepare("INSERT INTO question_sets(title,user_id) VALUES ('Simulado anterior', ?)").run(teacher).lastInsertRowid;
  db.prepare('INSERT INTO question_set_items(question_set_id,question_id,sort_order) VALUES (?, ?, 1)').run(set, held);
  const historic = db.prepare(`
    SELECT q.id, q.question_code, q.statement, q.skill_id, q.status, i.sort_order
    FROM question_set_items i JOIN questions q ON q.id = i.question_id WHERE i.question_set_id = ?
  `);
  const before = historic.all(set);

  assert.deepEqual(runMigrations(db, { migrations: through42 }).appliedNow.map(row => row.version), [42]);
  assert.deepEqual(historic.all(set), before);
  assert.deepEqual(runMigrations(db, { migrations: through42 }).appliedNow, []);
  assert.equal(db.prepare("SELECT COUNT(*) FROM question_editorial_curation WHERE state='held'").pluck().get(), 1);
  assert.equal(db.prepare('SELECT state FROM question_editorial_curation WHERE question_id=?').pluck().get(updated), undefined);
  assert.equal(holds.length, new Set(holds.map(item => item.code)).size);
  const drafts = db.prepare(`
    SELECT e.*, q.reviewed, q.status, s.code AS skill_code, q.statement, q.support_text, q.image_path
    FROM question_editorial_curation e JOIN questions q ON q.id = e.question_id
    JOIN bncc_skills s ON s.id = q.skill_id WHERE e.state = 'pilot'
  `).all();
  assert.equal(drafts.length, 48);
  const readOptions = db.prepare('SELECT option_label, option_text, is_correct FROM question_options WHERE question_id=? ORDER BY option_label');
  for (const draft of drafts) {
    assert.equal(draft.status, 'inactive');
    assert.equal(draft.reviewed, 0);
    const options = readOptions.all(draft.question_id);
    assert.equal(options.length, 4);
    assert.equal(options.filter(option => option.is_correct).length, 1);
    assert.equal(questionContentDigest(draft, options), draft.content_sha256);
    assert.deepEqual(Object.keys(JSON.parse(draft.rationales_json)), ['A', 'B', 'C', 'D']);
  }
  const user = { id: teacher, role: 'professor' };
  assert.equal(isEditorialPilotEnabled(db, user), false);
  db.prepare('UPDATE feature_flags SET master_enabled=1, default_enabled=1 WHERE flag_key=?').run(EDITORIAL_PILOT_FLAG);
  assert.equal(isEditorialPilotEnabled(db, user), true);
  const eligible = (id, pilotEnabled, purpose) => Boolean(db.prepare(`
    SELECT 1 FROM questions q WHERE q.id=? AND q.status='active' AND ${editorialEligibleSql('q', { pilotEnabled, purpose })}
  `).get(id));
  const approved = drafts.find(draft => draft.stage === 'verification').question_id;
  const guidance = drafts.find(draft => draft.stage === 'practice').question_id;
  const ready = db.prepare("UPDATE questions SET status='active', reviewed=1 WHERE id=?");
  ready.run(approved);
  ready.run(guidance);
  assert.equal(eligible(held, true, 'diagnosis'), false);
  assert.equal(eligible(updated, false, 'catalog'), true);
  assert.equal(eligible(approved, false, 'catalog'), false);
  assert.equal(eligible(approved, true, 'verification'), true);
  assert.equal(eligible(approved, true, 'diagnosis'), false);
  assert.equal(eligible(guidance, true, 'practice'), true);
  assert.equal(eligible(guidance, true, 'verification'), false);
  for (const { skillCode } of challenges) {
    if (skills.has(skillCode)) continue;
    const year = Number(skillCode.slice(2, 4));
    insertSkill.run(skillCode, skillCode, gradeIds.get(year), unit);
  }
  const stateBefore = db.prepare('SELECT * FROM question_editorial_curation ORDER BY question_id').all();
  const flagsBefore = db.prepare('SELECT * FROM feature_flags ORDER BY id').all();
  assert.deepEqual(runMigrations(db).appliedNow.map(row => row.version), [43]);
  assert.deepEqual(runMigrations(db).appliedNow, []);
  assert.deepEqual(historic.all(set), before);
  assert.deepEqual(db.prepare("SELECT * FROM question_editorial_curation WHERE batch_key='math-ef-2026-11' ORDER BY question_id").all(), stateBefore);
  assert.deepEqual(db.prepare('SELECT * FROM feature_flags ORDER BY id').all(), flagsBefore);

  const added = db.prepare(`
    SELECT e.*, q.question_code, q.statement, q.support_text, q.image_path, q.official_explanation,
      q.status, q.reviewed, q.difficulty, s.code AS skill_code, g.sort_order AS school_year
    FROM question_editorial_curation e JOIN questions q ON q.id = e.question_id
    JOIN bncc_skills s ON s.id = q.skill_id JOIN grades g ON g.id = s.grade_id
    WHERE e.batch_key = 'math-ef-challenges-2026-11'
  `).all();
  assert.equal(added.length, 27);
  assert.equal(new Set(added.map(row => row.school_year)).size, 9);
  for (const row of added) {
    const original = challenges.find(item => item.skillCode === row.skill_code);
    assert.ok(original, row.question_code);
    assert.equal(row.school_year, Number(original.skillCode.slice(2, 4)));
    assert.equal(row.statement, original.statement);
    assert.equal(row.support_text, original.supportText ?? null);
    assert.equal(row.official_explanation, original.explanation);
    assert.deepEqual([row.state, row.stage, row.difficulty, row.status, row.reviewed],
      ['pilot', 'reasoning', 'dificil', 'inactive', 0]);
    const options = readOptions.all(row.question_id);
    const answers = options.filter(option => option.is_correct === 1);
    assert.deepEqual(answers.map(option => option.option_text), [original.options[original.correctIndex].text]);
    const rationales = JSON.parse(row.rationales_json);
    assert.deepEqual(options.map(option => [option.option_text, rationales[option.option_label]]).sort(),
      original.options.map(option => [option.text, option.reason]).sort());
    assert.equal(questionContentDigest(row, options), row.content_sha256);
    assert.equal(eligible(row.question_id, true, 'diagnosis'), false);
  }
  const challenge = added[0].question_id;
  ready.run(challenge);
  assert.equal(eligible(challenge, true, 'diagnosis'), true);
  assert.equal(eligible(challenge, false, 'diagnosis'), false);
  assert.equal(eligible(challenge, true, 'practice'), false);
  assert.equal(eligible(challenge, true, 'verification'), false);
  assert.deepEqual(db.pragma('foreign_key_check'), []);
});
