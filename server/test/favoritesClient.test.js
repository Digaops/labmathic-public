const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/favoritesView.mjs');
const read = name => fs.readFileSync(path.resolve(__dirname, '../../client/src', name), 'utf8');

test('favoritos normaliza página inválida e limita offsets ao intervalo seguro', async () => {
  const { favoritesPage } = await model;
  for (const page of ['', '-1', '0', '1.5', 'abc', 'Infinity', '9007199254740991']) assert.equal(favoritesPage(new URLSearchParams({ page })), 1);
  assert.equal(favoritesPage(new URLSearchParams('page=002')), 2);
  assert.equal(favoritesPage(new URLSearchParams('page=9999')), 9999);
});
test('favoritos preserva a página na URL e consulta vinte itens sem alterar a API', async () => {
  const { favoritesPage, favoritesParams, favoritesRequest } = await model;
  assert.equal(favoritesParams(1).toString(), '');
  assert.equal(favoritesPage(favoritesParams(8)), 8);
  assert.equal(favoritesRequest(8), '/favorites?page=8&limit=20');
});
test('favoritos aceita vazio confirmado e página além do fim sem inventar ausência da lista', async () => {
  const { parseFavorites } = await model;
  const empty = { data: [], pagination: { page: 1, limit: 20, total: 0, totalPages: 0 } };
  assert.deepEqual(parseFavorites(empty), empty);
  const beyond = { data: [], pagination: { page: 3, limit: 20, total: 40, totalPages: 2 } };
  assert.equal(parseFavorites(beyond).pagination.total, 40);
  assert.equal(parseFavorites({ data: [{ id: 1, title: 'A', topics: [] }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } }).data.length, 1);
});
test('favoritos rejeita dados inválidos, incompletos e IDs duplicados', async () => {
  const { parseFavorites } = await model;
  const page = { data: [{ id: 1, title: 'A' }], pagination: { page: 1, limit: 20, total: 1, totalPages: 1 } };
  for (const invalid of [{}, { ...page, data: [] }, { ...page, data: [null] },
    { ...page, data: [{ id: 1, title: 'A', description: {} }] }, { ...page, data: [{ id: 1, title: 'A', topics: [null] }] },
    { ...page, pagination: { ...page.pagination, totalPages: 0 } },
    { data: [{ id: 1, title: 'A' }, { id: '1', title: 'B' }], pagination: { page: 1, limit: 20, total: 2, totalPages: 1 } }]) assert.throws(() => parseFavorites(invalid));
});
test('paginação de favoritos mantém quantidade constante de botões mesmo com muitas páginas', async () => {
  const { favoritesPages } = await model;
  assert.deepEqual(favoritesPages(1, 1), [1]);
  assert.deepEqual(favoritesPages(2, 3), [1, 2, 3]);
  assert.deepEqual(favoritesPages(500000, 1000000), [1, 499999, 500000, 500001, 1000000]);
  assert.deepEqual(favoritesPages(1000000, 1000000), [1, 999999, 1000000]);
});
test('favoritos reutiliza leitura por sessão sem acrescentar mutações nem erro silencioso', () => {
  const source = read('pages/Favorites.jsx');
  assert.match(source, /announcementAccessId/);
  assert.match(source, /useReadOnlyResource\(favoritesRequest\(page\), identity, parseFavorites\)/);
  assert.match(source, /resource.status === 'error'/);
  assert.match(source, /Isso não significa que seus materiais foram removidos/);
  assert.doesNotMatch(source, /api\.(post|put|delete)|silently handled/);
  const hook = read('hooks/useHomeResource.js');
  assert.match(hook, /AbortController/); assert.match(hook, /controller.signal.aborted/);
});
test('favoritos mantém cards compactos opt-in, retorno correto, foco e CSS limitado à tela', () => {
  const source = read('pages/Favorites.jsx');
  assert.match(source, /compactOnMobile fromLabel="Favoritos"/);
  assert.match(source, /setParams\(favoritesParams\(nextPage\)\)/);
  assert.match(source, /resultHeading.current\?\.focus/);
  assert.match(source, /min-h-11 min-w-11/);
  assert.match(source, /aria-current=/);
  assert.match(source, /const surface = '[^']*\bbg-white\b[^']*\bdark:bg-/);
  assert.match(source, /<header className=\{`\$\{surface\}/);
  assert.match(source, /<h1 className="[^"]*\btext-slate-900\b[^"]*\bdark:text-white\b/);
  assert.doesNotMatch(read('index.css'), /html:not\(\.dark\)\s+\.app-shell\s+main\s*>\s*\.animate-fade-in/);
});
