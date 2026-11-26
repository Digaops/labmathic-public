const test = require('node:test'), assert = require('node:assert/strict');
let query;
test.before(async () => { query = await import('../../client/src/services/networkPortraitQuery.mjs'); });
const filters = { ibgeCode: '2306405', stage: 'elementary_final', year: '2025' };
const params = value => new URLSearchParams(value);

test('consulta compartilhada conserva município, etapa e ano sem depender de estado do navegador', () => {
  const path = query.portraitSharePath(filters);
  assert.equal(path, '/retrato-da-rede?municipio=2306405&etapa=elementary_final&ano=2025');
  assert.deepEqual(query.readPortraitQuery(params(path.split('?')[1])), { ...filters, valid: true });
  assert.deepEqual(query.readPortraitQuery(params('')), { ibgeCode: '', stage: 'elementary_initial', year: '2025', valid: true });
  assert.deepEqual(query.readPortraitQuery(params('municipio=2306405')), { ibgeCode: '2306405', stage: 'elementary_initial', year: '2025', valid: true });
});
test('cada recorte pode ser reconstituído no retorno do histórico, sem misturar anos ou municípios', () => {
  const history = [filters, { ...filters, year: '2023' }, { ...filters, year: '2023', stage: 'elementary_initial' },
    { ...filters, ibgeCode: '3550308' }].map(f => query.portraitSearchParams(f).toString());
  for (let i = history.length - 1; i >= 0; i--) {
    const read = query.readPortraitQuery(params(history[i]));
    assert.equal(query.portraitSearchParams(read).toString(), history[i]);
  }
  const cleared = query.readPortraitQuery(query.portraitSearchParams({ ...filters, ibgeCode: '' }));
  assert.equal(cleared.ibgeCode, ''); assert.equal(cleared.stage, filters.stage); assert.equal(cleared.year, filters.year);
});
test('filtros inválidos ou ambíguos nunca viram outra consulta silenciosamente', () => {
  for (const value of ['municipio=', 'municipio=abc', 'municipio=230640', 'municipio=23064050', 'municipio=2306405/../../',
    'municipio=2306405&municipio=3550308', 'etapa=secondary', 'etapa=__proto__', 'etapa=',
    'etapa=elementary_initial&etapa=elementary_final', 'ano=2026', 'ano=2025.0', 'ano=', 'ano=2023&ano=2025']) {
    assert.equal(query.readPortraitQuery(params(value)).valid, false, value);
  }
  for (const patch of [{ ibgeCode: '../other' }, { stage: 'secondary' }, { year: '2026' }, { ibgeCode: 2306405 }]) {
    assert.throws(() => query.portraitSearchParams({ ...filters, ...patch }));
  }
  assert.throws(() => query.portraitSharePath({ ...filters, ibgeCode: '' }));
});
test('link contém apenas filtros públicos e usa a origem da plataforma, sem tokens ou texto livre', () => {
  const read = query.readPortraitQuery(params('municipio=2306405&etapa=elementary_final&ano=2025&token=segredo&nome=Pessoa&redirect=https://evil.invalid'));
  const link = query.portraitShareUrl('https://homologacao.example.invalid/qualquer?token=segredo#senha', read);
  assert.equal(link, 'https://homologacao.example.invalid' + query.portraitSharePath(filters));
  assert.doesNotMatch(link, /segredo|senha|Pessoa|token|redirect|evil|qualquer/);
  const credentialOrigin = new URL('https://example.invalid');
  credentialOrigin.username = 'synthetic-user'; credentialOrigin.password = 'synthetic-password';
  for (const origin of ['javascript:alert(1)', 'file:///tmp/example', credentialOrigin.href]) {
    assert.throws(() => query.portraitShareUrl(origin, filters));
  }
});
test('login e sessão expirada retomam somente a rota pública de filtros permitida', () => {
  const location = new URL('https://local.example.invalid' + query.portraitSharePath(filters));
  const login = query.portraitLoginPath(location);
  assert.equal(query.portraitReturnPath(login.split('?')[1]), query.portraitSharePath(filters));
  assert.equal(query.portraitLoginPath({ pathname: '/administracao', search: '?municipio=2306405' }), '/login');
  assert.equal(query.portraitLoginPath({ pathname: '/retrato-da-rede', search: '?municipio=wrong' }), '/login');
  assert.equal(query.portraitLoginPath({ pathname: '/retrato-da-rede', search: '' }), '/login');
  assert.equal(query.portraitReturnPath(''), '/');
});
test('retorno do login recusa redirecionamento externo, campos duplicados e recortes inválidos', () => {
  for (const value of ['redirect=https://evil.invalid', 'retrato=//evil.invalid', 'retrato=%2F%2Fevil.invalid',
    'retrato=2306405&retrato=3550308', 'retrato=2306405&municipio=3550308', 'retrato=2306405&ano=2026',
    'retrato=2306405&etapa=secondary', 'retrato=2306405&ano=2023&ano=2025']) {
    assert.equal(query.portraitReturnPath(value), '/', value);
  }
  assert.equal(query.portraitReturnPath('retrato=2306405&etapa=elementary_final&ano=2025&redirect=https://evil.invalid'), query.portraitSharePath(filters));
});
test('fluxo compartilha só o endereço e mantém acesso protegido por sessão e flag', () => {
  const fs = require('node:fs'), path = require('node:path');
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../client/src', file), 'utf8');
  const app = read('App.jsx'), login = read('pages/Login.jsx'), sessionFailure = read('services/apiSessionFailure.mjs'), page = read('pages/NetworkPortrait.jsx');
  assert.match(app, /path="retrato-da-rede" element={<FeatureRoute flag="institutions.network_portrait">/);
  assert.match(app, /portraitLoginPath\(location\)/); assert.match(app, /portraitReturnPath\(location.search\)/);
  assert.match(login, /navigate\(returnPath, \{ replace: true \}\)/);
  assert.match(sessionFailure, /window.location.href = portraitLoginPath\(window.location\)/);
  assert.match(page, /navigator.clipboard.writeText\(link\)/);
  assert.match(page, /A cópia automática não foi permitida/);
  assert.doesNotMatch(page, /api\.(post|put|delete)|localStorage|sessionStorage/);
});
