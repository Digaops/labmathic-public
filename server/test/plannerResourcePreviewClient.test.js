const test = require('node:test');
const assert = require('node:assert/strict');
const model = import('../../client/src/services/plannerResourcePreview.mjs');

const question = () => ({ id: 7, code: 'EF01-QA-7', statement: 'Quanto é 2 + 2?', supportText: null,
  imagePath: null, skillCode: 'EF01MA01', skillDescription: 'Contar objetos.',
  options: [...'ABCD'].map((label, index) => ({ label, text: String(index + 1) })) });

test('prévia do planejador só cria caminhos para tipos e identificadores válidos', async () => {
  const { plannerResourcePath } = await model;
  for (const type of ['material', 'question', 'question_set']) assert.equal(plannerResourcePath({ type, id: 7 }), `/lesson-plans/catalog/resources/${type}/7/preview`);
  for (const resource of [null, {}, { type: 'activity', id: 7 }, { type: '../material', id: 7 }, ...[null, '7', 0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1].map(id => ({ type: 'material', id }))]) assert.equal(plannerResourcePath(resource), null);
});

test('prévia rejeita identidade errada e materiais malformados', async () => {
  const { parsePlannerResourcePreview: parse } = await model;
  const expected = { type: 'material', id: 9 }, data = { ...expected, title: 'Leitura', material: { id: 9, title: 'Leitura', file_path: 'aula.pdf' } };
  assert.equal(parse(data, expected).material.file_path, 'aula.pdf');
  for (const patch of [{ id: 10 }, { type: 'question' }, { title: '' }, { material: null }, { material: { id: 10, title: 'Leitura' } }, { material: { id: 9, title: 'Outro título' } }, { material: { id: 9, title: 'Leitura', file_path: {} } }]) assert.throws(() => parse({ ...data, ...patch }, expected));
});

test('questões apresentam somente conteúdo, com quatro alternativas ordenadas e sem gabarito', async () => {
  const { parsePlannerResourcePreview: parse } = await model;
  const expected = { type: 'question', id: 7 }, source = question();
  source.official_explanation = 'Segredo não deve aparecer'; source.options[0].is_correct = 1;
  const parsed = parse({ ...expected, title: 'Questão 7', questions: [source], answer_key: 'A' }, expected);
  assert.equal(parsed.questions[0].options[0].text, '1');
  assert.equal(JSON.stringify(parsed).includes('is_correct'), false);
  assert.equal(JSON.stringify(parsed).includes('Segredo'), false);
  assert.equal(JSON.stringify(parsed).includes('answer_key'), false);
  for (const questions of [[], [question(), question()], [{ ...question(), id: 8 }], [{ ...question(), options: [] }], [{ ...question(), options: question().options.toReversed() }], [{ ...question(), imagePath: {} }]]) assert.throws(() => parse({ ...expected, title: 'Questão 7', questions }, expected));
});

test('simulados rejeitam vazio, duplicação de questões e truncamento por excesso', async () => {
  const { parsePlannerResourcePreview: parse } = await model;
  const expected = { type: 'question_set', id: 3 }, data = { ...expected, title: 'Simulado', questions: [question(), { ...question(), id: 8 }] };
  assert.equal(parse(data, expected).questions.length, 2);
  for (const questions of [[], [question(), question()], Array.from({ length: 101 }, (_, index) => ({ ...question(), id: index + 1 }))]) assert.throws(() => parse({ ...data, questions }, expected));
});

test('erros não expõem mensagens internas e distinguem indisponibilidade de revisão', async () => {
  const { plannerResourceError } = await model;
  const message = status => plannerResourceError({ response: { status, data: { error: 'SQL privado' } } });
  assert.match(message(404), /não está disponível para sua conta/);
  assert.match(message(403), /não tem acesso/);
  assert.match(message(409), /precisa de revisão/);
  assert.match(plannerResourceError({ response: { status: 409, data: { code: 'preview_limit_exceeded' } } }), /até 100 questões/);
  for (const status of [400, 500, 503, undefined]) { assert.match(message(status), /conexão/); assert.doesNotMatch(message(status), /SQL/); }
});
