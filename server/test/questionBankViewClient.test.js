const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/questionBankView.mjs');
const question = { id: 1, skill_id: 2, question_code: 'Q1', statement: 'Quanto é 1 + 1?', difficulty: 'facil', status: 'active', options: [{ option_label: 'A', option_text: '2', is_correct: 1 }] };
test('banco preserva filtros, busca, página e contexto nas URLs', async () => {
  const { readBankQuery, bankSearchParams, bankRequestPath } = await model;
  const previous = new URLSearchParams('turma=classe&tab=author&create=1&grade_id=3&unit_id=4&skill_id=2&difficulty=facil&search=frações&page=2&status=inactive');
  const query = readBankQuery(previous, true), next = bankSearchParams(previous, query);
  assert.deepEqual(readBankQuery(next, true), query);
  for (const key of ['turma','tab','create']) assert.equal(next.get(key), previous.get(key));
  const request = new URL(bankRequestPath(query), 'http://localhost');
  assert.equal(request.searchParams.get('limit'), '10'); assert.equal(request.searchParams.get('turma'), null);
  assert.equal(request.searchParams.get('status'), 'inactive');
});
test('banco normaliza IDs e não envia filtro administrativo para docente', async () => {
  const { readBankQuery, bankRequestPath } = await model;
  const query = readBankQuery(new URLSearchParams('page=-1&grade_id=99999999999999999999&unit_id=3x&skill_id=002&difficulty=sql&status=inactive'));
  assert.equal(query.page, 1); assert.equal(query.grade_id, ''); assert.equal(query.unit_id, ''); assert.equal(query.skill_id, '2'); assert.equal(query.status, ''); assert.equal(query.difficulty, '');
  assert.equal(new URL(bankRequestPath(query), 'http://localhost').searchParams.get('status'), null);
});
test('meus anos e texto com caracteres reservados seguem o contrato existente', async () => {
  const { readBankQuery, bankRequestPath } = await model;
  for (const alias of ['grade_id=mine','my_grades=1']) {
    const query = readBankQuery(new URLSearchParams(alias)); query.search = 'a&status=inactive + %';
    const params = new URL(bankRequestPath(query), 'http://localhost').searchParams;
    assert.equal(params.get('my_grades'), '1'); assert.equal(params.get('grade_id'), null); assert.equal(params.get('status'), null); assert.equal(params.get('search'), query.search);
  }
});
test('consulta vazia ou além da última página não se confunde com resposta incompleta', async () => {
  const { parseBankPage } = await model;
  const empty = { data: [], pagination: { page: 1, limit: 10, total: 0, totalPages: 0 } };
  assert.equal(parseBankPage(empty), empty);
  assert.doesNotThrow(() => parseBankPage({ data: [], pagination: { page: 9, limit: 10, total: 12, totalPages: 2 } }));
  assert.doesNotThrow(() => parseBankPage({ data: [question], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } }));
  for (const value of [{}, { data: [] }, { ...empty, data: [question] }, { data: [], pagination: { page: 1, limit: 10, total: 1, totalPages: 1 } }, { ...empty, pagination: { ...empty.pagination, totalPages: 1 } }]) assert.throws(() => parseBankPage(value));
});
test('questão e opções incompletas falham de modo explícito', async () => {
  const { parseBankQuestion, parseBankOptions, parseBankSkills } = await model;
  assert.equal(parseBankQuestion(question), question); assert.deepEqual(parseBankOptions([]), []); assert.deepEqual(parseBankSkills([]), []);
  for (const patch of [{ id: null }, { options: [] }, { options: [{}] }, { statement: null }, { skill_id: 0 }, { status: 'unknown' }]) assert.throws(() => parseBankQuestion({ ...question, ...patch }));
  for (const bad of [{}, [null], [{ id: 1 }]]) { assert.throws(() => parseBankOptions(bad)); assert.throws(() => parseBankSkills(bad)); }
});
test('banco mantém leituras isoladas, escrita serializada e confirmação de resultado incerto', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/QuestionBank.jsx'), 'utf8');
  assert.match(source, /QuestionBankWorkspace key=\{user\?\.id\}/); assert.match(source, /useMaterialAction\(\)/); assert.match(source, /enabled \? bankRequestPath\(query\)/);
  assert.match(source, /setUncertain/); assert.match(source, /createQuestionSetSubmission/); assert.match(source, /'Idempotency-Key': request.key/); assert.match(source, /editorDirty\.current && !window\.confirm/);
  assert.match(source, /editorSkillResource/); assert.match(source, /selectedIds\.length >= 100/); assert.doesNotMatch(source, /<ModalLayer/);
});
