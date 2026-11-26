const test = require('node:test'), assert = require('node:assert/strict');
let handleApiSessionFailure, authStorage;
const account = { id: 1, name: 'Conta sintética de teste unitário', email: 'return-test@example.invalid', role: 'professor' };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
test.before(async () => {
  // No browser, login, HTTP request or real storage: invoke the real interceptor with a synthetic response.
  ({ handleApiSessionFailure } = await import('../../client/src/services/apiSessionFailure.mjs'));
  ({ authStorage } = await import('../../client/src/services/authStorage.mjs'));
});
test.beforeEach(() => {
  global.window = { localStorage: storage(), sessionStorage: storage(),
    location: { pathname: '/retrato-da-rede', search: '?municipio=2306405&etapa=elementary_final&ano=2025&token=do-not-copy', href: 'unchanged' } };
  authStorage.save('synthetic-current', account);
});
test.after(() => { delete global.window; });
const fail = (status = 401, url = '/municipal-indicators', token = 'synthetic-current') => ({ response: { status }, config: { url, headers: { Authorization: 'Bearer ' + token } } });
const reject = failure => assert.rejects(handleApiSessionFailure(failure), error => error === failure);

test('o transporte real registra o mesmo handler testado sem exigir dependências do frontend', () => {
  const apiSource = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../client/src/services/api.js'), 'utf8');
  assert.match(apiSource, /import \{ handleApiSessionFailure \} from '\.\/apiSessionFailure\.mjs'/);
  assert.match(apiSource, /api\.interceptors\.response\.use\(\s*\(response\) => response,\s*handleApiSessionFailure\s*\)/);
});

test('401 encerra a sessão e conserva somente os filtros públicos para novo login', async () => {
  await reject(fail());
  assert.equal(authStorage.token(), null);
  assert.equal(window.location.href, '/login?etapa=elementary_final&ano=2025&retrato=2306405');
  assert.doesNotMatch(window.location.href, /synthetic|token|do-not-copy/);
});
test('401 de outra área continua indo ao login normal, sem retorno arbitrário', async () => {
  window.location.pathname = '/admin'; window.location.search = '?redirect=https://evil.invalid';
  await reject(fail());
  assert.equal(window.location.href, '/login'); assert.equal(authStorage.token(), null);
});
test('resposta atrasada de sessão anterior não limpa nem redireciona a conta atual', async () => {
  await reject(fail(401, '/municipal-indicators', 'synthetic-previous'));
  assert.equal(authStorage.token(), 'synthetic-current'); assert.equal(window.location.href, 'unchanged');
});
test('negação da flag, falha de login e acesso de estudante não alteram esse retorno', async () => {
  for (const failure of [fail(404), fail(403), fail(401, '/auth/login'), fail(401, '/student-assessments/access')]) {
    await reject(failure); assert.equal(authStorage.token(), 'synthetic-current'); assert.equal(window.location.href, 'unchanged');
  }
});
