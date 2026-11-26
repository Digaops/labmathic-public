const test = require('node:test'), assert = require('node:assert/strict');
const navigation = import('../../client/src/services/schoolCoordinationNavigation.mjs');

test('consulta escolar: busca de turma é enviada ao servidor com ano e página, sem misturar busca de escola', async () => {
  const { coordinationQuery: query } = await navigation;
  const result = query(new URLSearchParams({ escola: 'escola/qa', turma: 'Manhã & A', ano: '2028', pagina: '2', busca: 'Horizonte' }));
  assert.equal(result.url, '/school-coordination/schools/escola%2Fqa/classes?page=2&year=2028&search=Manh%C3%A3%20%26%20A');
  assert.equal(result.classSearch, 'Manhã & A');
  assert.equal(query(new URLSearchParams({ busca: 'Horizonte', turma: 'ignorar', ano: '2028' })).url,
    '/school-coordination/schools?page=1&search=Horizonte');
});

test('consulta escolar: parâmetros inválidos e conteúdo reservado não viram filtros adicionais', async () => {
  const { coordinationQuery: query } = await navigation;
  for (const pagina of ['0', '-1', '1.2', '10000', '1&student=1']) {
    const result = query(new URLSearchParams({ escola: 'qa', pagina, ano: '1999', turma: 'A&student=1', student: '1' }));
    assert.equal(result.page, 1); assert.equal(result.year, '');
    assert.equal(new URL(result.url, 'https://local.invalid').searchParams.has('student'), false);
  }
  const result = query(new URLSearchParams({ escola: 'qa', ano: '2100', pagina: '9999', turma: 'x'.repeat(101) }));
  assert.equal(result.classSearch.length, 100); assert.equal(result.year, '2100'); assert.equal(result.page, 9999);
});

test('consulta escolar: alterar filtros volta ao início e limpar ou trocar escola não mantém busca de outra turma', async () => {
  const { coordinationQuery: query, coordinationParams: change } = await navigation;
  const original = new URLSearchParams({ escola: 'qa', pagina: '2', ano: '2028', turma: '5º A', busca: 'Horizonte' });
  const filtered = change(original, { turma: '5º B', ano: '2026', pagina: null });
  assert.equal(query(filtered).page, 1); assert.equal(query(filtered).classSearch, '5º B');
  assert.equal(original.get('pagina'), '2'); assert.equal(original.get('turma'), '5º A');
  const cleared = query(change(original, { turma: null, ano: null, pagina: null }));
  assert.equal(cleared.url, '/school-coordination/schools/qa/classes?page=1');
  const schoolList = query(change(original, { escola: null, turma: null, ano: null, pagina: null }));
  assert.equal(schoolList.classSearch, ''); assert.equal(schoolList.url, '/school-coordination/schools?page=1&search=Horizonte');
});

test('consulta escolar: texto Unicode no limite não interrompe a tela ao montar a busca', async () => {
  const { coordinationQuery: query } = await navigation;
  const text = 'x'.repeat(99) + '📚';
  const classes = query(new URLSearchParams({ escola: 'qa', turma: text }));
  assert.equal(classes.classSearch, 'x'.repeat(99)); assert.ok(classes.url);
  const schools = query(new URLSearchParams({ busca: text }));
  assert.equal(schools.search, 'x'.repeat(99)); assert.ok(schools.url);
});
