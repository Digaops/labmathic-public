const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/libraryQuery.mjs');

test('biblioteca preserva busca, cinco filtros, ordenação e página na URL', async () => {
  const { readLibraryQuery, librarySearchParams } = await model;
  const params = new URLSearchParams('search=frações&discipline_id=1&grade_id=2&topic_id=3&material_type_id=4&file_format=PDF&sort=title_asc&page=2');
  const query = readLibraryQuery(params);
  assert.deepEqual(readLibraryQuery(librarySearchParams(query)), query);
  assert.equal(query.page, 2);
  assert.equal(query.search, 'frações');
});

test('biblioteca ignora parâmetros inválidos sem inventar ordenação ou ID', async () => {
  const { readLibraryQuery } = await model;
  const query = readLibraryQuery(new URLSearchParams('page=-9&sort=sql&grade_id=-1&topic_id=3x&file_format=exe&search=++'));
  assert.equal(query.page, 1); assert.equal(query.sort, 'recent'); assert.equal(query.search, '');
  assert.ok(Object.values(query.filters).every(value => value === ''));
});

test('meus anos mantém compatibilidade e é enviado no contrato existente da API', async () => {
  const { readLibraryQuery, libraryRequestPath } = await model;
  for (const params of ['grade_id=mine', 'my_grades=1']) {
    const query = readLibraryQuery(new URLSearchParams(params));
    assert.equal(query.filters.grade_id, 'mine');
    const request = new URL(libraryRequestPath(query), 'http://localhost');
    assert.equal(request.searchParams.get('my_grades'), '1');
    assert.equal(request.searchParams.get('grade_id'), null);
    assert.equal(request.searchParams.get('limit'), '12');
  }
});

test('busca com caracteres reservados não vira novo parâmetro', async () => {
  const { readLibraryQuery, libraryRequestPath } = await model;
  const query = readLibraryQuery(new URLSearchParams()); query.search = 'a&grade_id=9 + %';
  const url = new URL(libraryRequestPath(query), 'http://localhost');
  assert.equal(url.searchParams.get('search'), query.search); assert.equal(url.searchParams.get('grade_id'), null);
});

test('resposta vazia válida e página além do fim são diferentes de resposta inválida', async () => {
  const { parseLibraryMaterials } = await model;
  const empty = { data: [], pagination: { page: 1, limit: 12, total: 0, totalPages: 0 } };
  assert.deepEqual(parseLibraryMaterials(empty), empty);
  assert.doesNotThrow(() => parseLibraryMaterials({ ...empty, pagination: { page: 9, limit: 12, total: 14, totalPages: 2 } }));
  for (const invalid of [{}, { data: [] }, { ...empty, data: [{ id: 1 }] },
    { data: [], pagination: { page: 1, limit: 12, total: 14, totalPages: 2 } },
    { ...empty, pagination: { ...empty.pagination, totalPages: 1 } }]) assert.throws(() => parseLibraryMaterials(invalid));
});

test('categorias inválidas dão erro e seleção antiga mantém rótulo removível', async () => {
  const { parseLibraryCategories, libraryFilterName } = await model;
  assert.deepEqual(parseLibraryCategories([]), []);
  assert.throws(() => parseLibraryCategories({ data: [] }));
  assert.throws(() => parseLibraryCategories([null]));
  assert.equal(libraryFilterName('grade_id', 'mine'), 'Meus anos de ensino');
  assert.equal(libraryFilterName('discipline_id', '999'), 'Opção selecionada (999)');
  assert.equal(libraryFilterName('discipline_id', '1', [{ id: 1, name: 'Matemática' }]), 'Matemática');
});

test('biblioteca usa estado da URL e consultas somente de leitura isoladas por sessão', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/Library.jsx'), 'utf8');
  assert.match(source, /announcementAccessId/);
  assert.match(source, /useReadOnlyResource\(libraryRequestPath\(query\)/);
  assert.match(source, /open: showFilters && mobile/);
  assert.match(source, /function FilterPanel/);
  assert.doesNotMatch(source, /const FilterPanel =|Array.from\(\{ length:.*totalPages|api\.(post|put|patch|delete)/);
  assert.match(source, /compactOnMobile fromLabel="Biblioteca"/);
});

test('cartão compacto é opt-in e outras telas preservam apresentação e retorno anteriores', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/components/MaterialCard.jsx'), 'utf8');
  assert.match(source, /compactOnMobile = false, fromLabel = 'Laboratórios'/);
  assert.match(source, /from: `\$\{location.pathname\}\$\{location.search\}`/);
});
