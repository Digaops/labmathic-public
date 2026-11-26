const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { loadQuestionCandidates, splitQuestionPurpose } = require('../src/services/learningRecoveryPreview');

function fixture(t) {
  const db = new Database(':memory:'); t.after(() => db.close());
  db.exec(`
    CREATE TABLE questions (id INTEGER PRIMARY KEY, skill_id INTEGER, question_code TEXT,
      statement TEXT, difficulty TEXT, source TEXT, reviewed INTEGER, image_path TEXT,
      status TEXT, question_type TEXT, created_by INTEGER);
    CREATE TABLE question_options (id INTEGER PRIMARY KEY, question_id INTEGER, is_correct INTEGER);
    CREATE TABLE class_assessment_items (id INTEGER PRIMARY KEY, assignment_id INTEGER,
      source_question_id INTEGER, question_code_snapshot TEXT);
    CREATE TABLE question_editorial_curation (question_id INTEGER PRIMARY KEY, state TEXT,
      stage TEXT, family TEXT);
  `);
  function question(id, changes = {}) {
    const q = { skillId: 7, code: `Q-${String(id).padStart(3, '0')}`, source: 'official', owner: 10,
      reviewed: 1, status: 'active', type: 'multiple_choice', options: 4, correct: 1, difficulty: 'facil', ...changes };
    db.prepare('INSERT INTO questions VALUES (?,?,?, ?,?,?,?,NULL,?,?,?)').run(id, q.skillId, q.code,
      'Enunciado válido para a verificação.', q.difficulty, q.source, q.reviewed, q.status, q.type, q.owner);
    for (let i = 0; i < q.options; i++) db.prepare('INSERT INTO question_options(question_id,is_correct) VALUES (?,?)').run(id, Number(i < q.correct));
  }
  function used(id, code) { db.prepare('INSERT INTO class_assessment_items(assignment_id,source_question_id,question_code_snapshot) VALUES (1,?,?)').run(id, code); }
  const candidates = (options = {}) => loadQuestionCandidates(db, { id: 1 }, 10, 7, options);
  return { db, question, used, candidates };
}

test('uma questão autoral inédita continua disponível, sem exigir uma segunda para reservar', t => {
  const f = fixture(t); f.question(1, { source: 'teacher', reviewed: 0 });
  const questions = f.candidates({ excludedQuestionIds: [], limit: 2 });
  assert.deepEqual(questions.map(q => q.id), [1]);
  assert.equal(questions[0].requiresTeacherReview, true);
  assert.equal(splitQuestionPurpose(questions).monitoring.length, 0, 'a prévia inicial continua apenas uma sugestão, sem reescrever sua regra');
});

test('opções editoriais separam prática e verificação, priorizam o piloto e descartam famílias usadas', t => {
  const f = fixture(t);
  for (let id = 1; id <= 9; id++) f.question(id, { reviewed: id === 9 ? 0 : 1 });
  const insert = f.db.prepare('INSERT INTO question_editorial_curation VALUES (?, ?, ?, ?)');
  insert.run(2, 'held', null, null);
  insert.run(3, 'pilot', 'practice', 'apoio-inedito');
  insert.run(4, 'pilot', 'application', 'fonte');
  insert.run(5, 'pilot', 'verification', 'fonte');
  insert.run(6, 'pilot', 'verification', 'apoio-inedito');
  insert.run(7, 'pilot', 'verification', 'caso-transferencia');
  insert.run(8, 'pilot', 'verification', 'caso-transferencia');
  insert.run(9, 'pilot', 'verification', 'rascunho');
  f.used(4, 'Q-004');

  assert.deepEqual(f.candidates({ purpose: 'verification', limit: 2 }).map(question => question.id), [1]);
  assert.deepEqual(f.candidates({ pilotEnabled: true, purpose: 'practice', limit: 2 }).map(question => question.id), [3, 1]);
  assert.deepEqual(f.candidates({ pilotEnabled: true, purpose: 'verification', excludedQuestionIds: [3], limit: 2 })
    .map(question => question.id), [7, 1]);
  assert.deepEqual(f.candidates({ pilotEnabled: true, purpose: 'practice', pilotOnly: true }).map(question => question.id), [3]);
});

test('exclui reforço antes do limite e encontra candidata fora da seleção inicial', t => {
  const f = fixture(t); for (let id = 1; id <= 8; id++) f.question(id);
  assert.deepEqual(f.candidates().map(q => q.id), [1, 2, 3, 4, 5]);
  assert.deepEqual(f.candidates({ excludedQuestionIds: [1, 2, 3, 4, 5], limit: 2 }).map(q => q.id), [6, 7]);
});

test('nenhuma elegível é diferente de uma única alternativa após excluir o apoio', t => {
  const f = fixture(t); f.question(1); f.question(2);
  assert.equal(f.candidates({ excludedQuestionIds: [1, 2], limit: 2 }).length, 0);
  assert.deepEqual(f.candidates({ excludedQuestionIds: [1], limit: 2 }).map(q => q.id), [2]);
});

test('diagnóstico permanece excluído tanto por ID como por código preservado', t => {
  const f = fixture(t); f.question(1); f.question(2); f.question(3);
  f.used(1, 'CODIGO-ANTIGO'); f.used(null, 'Q-002');
  assert.deepEqual(f.candidates({ limit: 2 }).map(q => q.id), [3]);
});

for (const [name, changes] of [
  ['autoria alheia', { source: 'teacher', owner: 20 }], ['inativa', { status: 'inactive' }],
  ['outra habilidade', { skillId: 8 }], ['outro formato', { type: 'open' }],
  ['três alternativas', { options: 3 }], ['cinco alternativas', { options: 5 }],
  ['sem gabarito', { correct: 0 }], ['dois gabaritos', { correct: 2 }],
]) test(`não oferece questão com ${name}`, t => {
  const f = fixture(t); f.question(1, changes); f.question(2);
  assert.deepEqual(f.candidates({ limit: 2 }).map(q => q.id), [2]);
});

test('mantém seleção determinística, limite e opções iniciais de reforço sem gravação', t => {
  const f = fixture(t); for (let id = 1; id <= 9; id++) f.question(id, { difficulty: ['facil', 'media', 'dificil'][id % 3] });
  const changes = f.db.prepare('SELECT total_changes()').pluck().get();
  const first = f.candidates({ excludedQuestionIds: [1, 2], limit: 2 });
  assert.equal(first.length, 2);
  assert.deepEqual(f.candidates({ excludedQuestionIds: [1, 2], limit: 2 }), first);
  assert.equal(f.candidates().length, 5);
  assert.equal(f.db.prepare('SELECT total_changes()').pluck().get(), changes);
});
