const test = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const model = import('../../client/src/services/authoringView.mjs');
const skill = { id: 1, code: 'EF01MA01', description: 'Contar objetos.', unitId: 2, unitName: 'Números', candidateCount: 2, difficulties: { easy: 1, medium: 1, difficult: 0 } };
const bootstrap = { grades: [{ id: 1, name: '1º Ano' }], units: [{ id: 2, name: 'Números' }], skills: [skill], limits: { maxSkills: 10, minQuestionsPerSkill: 2, maxQuestionsPerSkill: 5, maxQuestions: 50 } };
test('URL autoral não apaga filtros do banco, turma ou aba', async () => {
  const m = await model, params = new URLSearchParams('tab=author&turma=abc&search=banco&page=3&author_search=frações&author_page=2');
  const q = m.readAuthorQuery(params), next = m.authorSearchParams(params, q);
  assert.deepEqual(q, { search: 'frações', page: 2 }); assert.deepEqual(m.readAuthorQuery(next), q);
  for (const key of ['tab','turma','search','page']) assert.equal(next.get(key), params.get(key));
  const request = new URL(m.authorRequestPath(q), 'http://localhost'); assert.equal(request.searchParams.get('limit'), '10'); assert.equal(request.searchParams.get('search'), 'frações'); assert.equal(request.searchParams.get('turma'), null);
  assert.equal(m.readAuthorQuery(new URLSearchParams('author_page=-1')).page, 1);
});
test('formulário autoral exige enunciado, habilidade, quatro opções e um gabarito', async () => {
  const m = await model, form = m.emptyAuthorQuestion(); assert.match(m.authorFormError(form), /habilidade/);
  form.skill_id = '1'; assert.match(m.authorFormError(form), /enunciado/); form.statement = 'Quanto é 1 + 1?'; assert.match(m.authorFormError(form), /alternativa A/);
  form.options.forEach(o => { o.option_text = 'Resposta ' + o.option_label; }); assert.equal(m.authorFormError(form), '');
  form.options[1].is_correct = 1; assert.match(m.authorFormError(form), /única resposta/);
  form.options.pop(); assert.match(m.authorFormError(form), /A, B, C e D/);
});
test('disponibilidade incompleta não vira lista vazia no diagnóstico', async () => {
  const m = await model; assert.equal(m.parseDiagnosticBootstrap(bootstrap), bootstrap);
  for (const bad of [{}, { ...bootstrap, skills: [null] }, { ...bootstrap, skills: [{ ...skill, candidateCount: -1 }] }, { ...bootstrap, limits: { ...bootstrap.limits, maxSkills: 9999 } }, { ...bootstrap, limits: { ...bootstrap.limits, minQuestionsPerSkill: 6 } }]) assert.throws(() => m.parseDiagnosticBootstrap(bad));
});
test('aumento de quantidade identifica seleção insuficiente e remoção resolve', async () => {
  const m = await model; assert.equal(m.diagnosticSelection([skill], [1], 2).insufficient.length, 0);
  assert.equal(m.diagnosticSelection([skill], [1], 3).insufficient.length, 1);
  assert.equal(m.diagnosticSelection([skill], [], 3).total, 0);
  assert.equal(m.diagnosticSelection([], [1], 3).missing, true);
});
test('resultado só é confirmado com composição consistente, privado e sujeito à revisão', async () => {
  const m = await model, result = { id: 1, title: 'Diagnóstico', grade: { id: 1, name: '1º Ano' }, questionCount: 2, isPrivate: true, requiresTeacherReview: true, composition: [{ ...skill, selectedCount: 2 }] };
  assert.equal(m.parseDiagnosticResult(result), result);
  for (const patch of [{}, { isPrivate: false }, { requiresTeacherReview: false }, { questionCount: 3 }, { composition: [] }].slice(1)) assert.throws(() => m.parseDiagnosticResult({ ...result, ...patch }));
  assert.throws(() => m.parseDiagnosticResult({}));
});
test('escrita incerta distingue erro de validação de ausência de confirmação', async () => {
  const m = await model; assert.equal(m.uncertainWrite(new Error('timeout')), true); assert.equal(m.uncertainWrite({ response: { status: 503 } }), true); assert.equal(m.uncertainWrite({ response: { status: 409 } }), false);
});

test('entradas autorais encaminham a seleção para revisão no Banco', () => {
  const manager = readFileSync(require.resolve('../../client/src/components/TeacherQuestionManager.jsx'), 'utf8');
  const bank = readFileSync(require.resolve('../../client/src/pages/QuestionBank.jsx'), 'utf8');
  const sets = readFileSync(require.resolve('../../client/src/pages/QuestionSets.jsx'), 'utf8');
  assert.match(manager, /!isAdmin && onPrepareSet/);
  assert.match(manager, /onPrepareSet\(selected\)/);
  assert.doesNotMatch(manager, /\/question-bank\/question-sets/);
  assert.match(bank, /onPrepareSet=\{prepareAuthorSet\}/);
  assert.match(sets, /onPrepareSet=\{prepareAuthorSet\}/);
  assert.match(sets, /existing\?\.pending/);
  assert.match(sets, /navigate\('\/banco-questoes\?revisar=1'\)/);
});
