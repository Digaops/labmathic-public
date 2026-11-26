const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../../client/src/services/questionSetsView.mjs');
const print = import('../../client/src/services/questionSetPrint.mjs');
const question = { id: 7, question_code: 'QA23', skill_id: 1, statement: 'Quanto é 2 + 2?', support_text: 'Leia os dados.', difficulty: 'media', status: 'active', show_image: 1, image_path: 'qa23.png', development_space: 'medium', official_explanation: 'COMENTARIO_RESERVADO', options: ['4','2','3','5'].map((text, i) => ({ option_label: 'ABCD'[i], option_text: text, is_correct: Number(i === 0) })) };
const detail = { id: 1, user_id: 2, title: 'Simulado', is_public: 0, is_diagnostic: 0, diagnostic_reviewed: 0, questions: [question] };
const page = { data: [{ ...detail, question_count: 1, author_question_count: 0 }], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } };

test('simulados mantêm consulta e retorno sem apagar aba, autoria ou turma', async () => {
  const m = await model, params = new URLSearchParams('tab=questions&author_page=2&turma=abc&set_search=números&set_page=3');
  assert.deepEqual(m.readSetQuery(params), { search: 'números', page: 3 });
  const next = m.setSearchParams(params, { search: 'frações', page: 1 });
  assert.equal(next.get('set_page'), null); assert.equal(next.get('author_page'), '2'); assert.equal(next.get('tab'), 'questions'); assert.equal(next.get('turma'), 'abc');
  const destination = new URL(m.setNavigationUrl('/simulados/1', params), 'http://localhost');
  assert.equal(destination.searchParams.get('set_page'), '3'); assert.equal(destination.searchParams.get('turma'), 'abc'); assert.equal(destination.searchParams.get('tab'), null);
  assert.equal(m.readSetQuery(new URLSearchParams('set_page=-1')).page, 1);
  assert.match(m.setRequestPath({ search: 'abc', page: 2 }), /^\/question-bank\/question-sets\?page=2&limit=10&search=abc$/);
});
test('resposta incompleta de lista não vira vazio verdadeiro', async () => {
  const m = await model; assert.equal(m.parseSetPage(page), page);
  for (const value of [{}, { ...page, data: [] }, { ...page, data: [{ ...page.data[0], is_public: '0' }] }, { ...page, pagination: { ...page.pagination, totalPages: 0 } }]) assert.throws(() => m.parseSetPage(value));
  assert.equal(m.parseSetPage({ data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } }).data.length, 0);
});
test('detalhe exige imagem definida e quatro alternativas com um gabarito', async () => {
  const m = await model; assert.equal(m.parseSetDetail(detail), detail);
  for (const patch of [{ questions: [question, question] }, { questions: [{ ...question, show_image: null }] }, { questions: [{ ...question, options: question.options.map(o => ({ ...o, is_correct: 0 })) }] }, { questions: [{ ...question, options: [...question.options.slice(0,3), question.options[0]] }] }]) assert.throws(() => m.parseSetDetail({ ...detail, ...patch }));
});
test('consulta administrativa não confirma revisão em nome do autor', async () => {
  const m = await model, diagnostic = { ...detail, is_diagnostic: 1 };
  assert.deepEqual(m.setPermissions(diagnostic, { id: 2, role: 'professor' }), { canEdit: true, canReview: true });
  assert.deepEqual(m.setPermissions(diagnostic, { id: 3, role: 'admin' }), { canEdit: true, canReview: false });
  assert.deepEqual(m.setPermissions(diagnostic, { id: 3, role: 'professor' }), { canEdit: false, canReview: false });
  assert.equal(m.setPermissions({ ...diagnostic, diagnostic_reviewed: 1 }, { id: 2, role: 'professor' }).canReview, false);
});
test('aplicação direta depende das duas flags, da conta docente e dos dados confirmados', async () => {
  const { setApplication } = await model;
  const professor = { id: 2, role: 'professor' };
  const options = { classesEnabled: true, assignmentsEnabled: true, locked: false };
  assert.deepEqual(setApplication(detail, professor, options), { visible: true, ready: true, reason: '' });
  // Does not require pedagogy.operational_cycle: ordinary preparation has its own gates.
  for (const patch of [{ classesEnabled: false }, { assignmentsEnabled: false }, { classesEnabled: undefined }, { assignmentsEnabled: 'true' }]) {
    assert.equal(setApplication(detail, professor, { ...options, ...patch }).visible, false);
  }
  for (const user of [null, { id: 2, role: 'admin' }, { id: 2, role: 'aluno' }]) {
    assert.equal(setApplication(detail, user, options).visible, false);
  }
  for (const [set, overrides] of [[detail, { locked: true }], [null, {}], [{ ...detail, questions: [] }, {}],
    [{ ...detail, questions: Array(101).fill(question) }, {}], [{ ...detail, is_diagnostic: 1, diagnostic_reviewed: 0 }, {}]]) {
    const result = setApplication(set, professor, { ...options, ...overrides });
    assert.equal(result.visible, true); assert.equal(result.ready, false); assert.ok(result.reason);
  }
  assert.equal(setApplication({ ...detail, questions: Array(100).fill(question) }, professor, options).ready, true);
  assert.equal(setApplication({ ...detail, is_diagnostic: 1, diagnostic_reviewed: 1 }, professor, options).ready, true);
});
test('aplicação não sugere simulado de outro professor privado ou com questões autorais', async () => {
  const { setApplication } = await model;
  const professor = { id: 3, role: 'professor' };
  const options = { classesEnabled: true, assignmentsEnabled: true, locked: false };
  assert.equal(setApplication({ ...detail, is_public: 1, contains_author_questions: 0 }, professor, options).ready, true);
  for (const patch of [{ is_public: 0, contains_author_questions: 0 }, { is_public: 1, contains_author_questions: 1 },
    { is_public: 1 }, { is_public: 1, contains_author_questions: null }]) {
    assert.equal(setApplication({ ...detail, ...patch }, professor, options).ready, false);
  }
  assert.equal(setApplication({ ...detail, contains_author_questions: 1 }, { ...professor, id: 2 }, options).ready, true);
  assert.match(setApplication({ ...detail, is_public: 1, contains_author_questions: 0, is_diagnostic: 1 }, professor, options).reason, /professor responsável/);
});
test('destino de preparação usa caminho interno fixo e ignora turma inválida', async () => {
  const { setApplicationUrl } = await model;
  assert.equal(setApplicationUrl(42), '/turmas?secao=avaliacoes&simulado=42');
  assert.equal(setApplicationUrl(42, 'class-1'), '/turmas?secao=avaliacoes&simulado=42&turma=class-1');
  for (const source of [0, -1, NaN, Infinity, '1', 'https://fora.test', Number.MAX_SAFE_INTEGER + 1]) assert.equal(setApplicationUrl(source, 'class-1'), null);
  for (const turma of ['https://fora.test', 'class-1&simulado=99', '../outra', 'a'.repeat(81), null]) {
    assert.equal(setApplicationUrl(42, turma), '/turmas?secao=avaliacoes&simulado=42');
  }
});
test('dificuldade mais frequente usa questões completas, sem média inventada', async () => {
  const m = await model; assert.equal(m.predominantDifficulty([]), null);
  assert.equal(m.predominantDifficulty([{ difficulty: 'media' }, { difficulty: 'dificil' }, { difficulty: 'dificil' }]), 'dificil');
  assert.equal(m.predominantDifficulty([{ difficulty: 'media' }, { difficulty: 'facil' }]), 'facil');
});
test('escrita só é confirmada para os identificadores e resultado esperados', async () => {
  const m = await model;
  assert.doesNotThrow(() => m.confirmedImage({ question_set_id: 1, question_id: 7, show_image: 0 }, 1, 7, 0));
  assert.throws(() => m.confirmedImage({ question_set_id: 2, question_id: 7, show_image: 0 }, 1, 7, 0));
  assert.throws(() => m.confirmedImage({}, 1, 7, 0));
  const review = { questionSetId: 1, reviewed: true, reviewedBy: 2, reviewedAt: '2026-09-09', confirmationVersion: 'teacher-review-v1' };
  assert.equal(m.confirmedReview(review, 1, 2), review); assert.throws(() => m.confirmedReview(review, 1, 3)); assert.throws(() => m.confirmedReview({}, 1, 2));
});
test('impressão do aluno omite respostas e bloqueia diagnóstico ainda não revisado', async () => {
  const m = await print, student = m.getPrintableDocument(detail, false, 'http://localhost'), teacher = m.getPrintableDocument(detail, true, 'http://localhost');
  assert.doesNotMatch(student, /COMENTARIO_RESERVADO|<section class="answer-key">|<span class="answer-mark">/);
  assert.match(student, /student-fields/); assert.match(student, /development-space space-medium/);
  assert.match(student, /name="viewport" content="width=device-width, initial-scale=1.0"/);
  assert.match(teacher, /COMENTARIO_RESERVADO/); assert.match(teacher, /<section class="answer-key">/);
  assert.throws(() => m.getPrintableDocument({ ...detail, is_diagnostic: 1 }, false, 'http://localhost'));
  assert.match(m.getPrintableDocument({ ...detail, is_diagnostic: 1 }, true, 'http://localhost'), /Rascunho/);
});
test('texto impresso é escapado e imagem não permite escapar do diretório de uploads', async () => {
  const m = await print, html = m.getPrintableDocument({ ...detail, title: '<script>alert(1)</script>', questions: [{ ...question, show_image: 0, statement: '<img onerror="x"> & teste' }] }, true, 'https://lab.test');
  assert.doesNotMatch(html, /<script>|<img onerror/); assert.match(html, /&lt;img onerror=&quot;x&quot;&gt; &amp; teste/); assert.doesNotMatch(html, /src="https:\/\/lab.test\/uploads/);
  assert.equal(m.printImageUrl('pasta/imagem teste.png', 'https://lab.test'), 'https://lab.test/uploads/pasta/imagem%20teste.png');
  for (const value of ['../segredo', '/a.png', 'https://externo.test/a.png', 'a\\b.png', '']) assert.throws(() => m.printImageUrl(value, 'https://lab.test'));
});
