const test = require('node:test');
const assert = require('node:assert/strict');
let createAuthStorage, AUTH_RECORD, AUTH_LOCK, AUTH_EVENT;
test.before(async () => ({ createAuthStorage, AUTH_RECORD, AUTH_LOCK, AUTH_EVENT } = await import('../../client/src/services/authStorage.mjs')));
const account = { id: 1, name: 'Professor sintético', email: 'teacher@example.invalid', role: 'professor' };
function storage() {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, String(value)), removeItem: key => values.delete(key) };
}
function environment(local = storage(), session = storage()) {
  return { local, session, auth: createAuthStorage({ local: () => local, session: () => session }) };
}

test('padrão não persistente guarda apenas na sessão da aba; nova aba não herda acesso', () => {
  const env = environment();
  env.auth.save('temporary', account);
  assert.equal(env.auth.read().persistent, false);
  assert.equal(env.local.getItem(AUTH_RECORD), null);
  assert.equal(environment(env.local, env.session).auth.token(), 'temporary', 'recarregar a aba preserva');
  assert.equal(environment(env.local).auth.token(), null, 'nova aba sem opener não herda');
});

test('opção persistente sobrevive à nova aba; mudança para temporária remove cópias anteriores', () => {
  const env = environment();
  env.auth.save('remembered', account, true);
  assert.equal(environment(env.local).auth.token(), 'remembered');
  assert.equal(env.session.getItem(AUTH_RECORD), null);
  env.local.setItem('token', 'legacy-stale'); env.local.setItem('user', JSON.stringify(account));
  env.auth.save('temporary', account, false);
  assert.equal(env.local.getItem('token'), null);
  assert.equal(env.local.getItem('user'), null);
  assert.equal(env.local.getItem(AUTH_RECORD), null);
  assert.equal(env.auth.token(), 'temporary');
});

test('sessões legadas são reconhecidas e perfil atualizado sem mudar a duração escolhida', () => {
  for (const persistent of [false, true]) {
    const env = environment();
    const target = persistent ? env.local : env.session;
    target.setItem('token', 'legacy'); target.setItem('user', JSON.stringify(account));
    assert.equal(env.auth.read().persistent, persistent);
    assert.equal(env.auth.updateUser({ ...account, name: 'Nome atualizado' }, 'legacy'), true);
    assert.equal(target.getItem('token'), null);
    assert.equal(env.auth.read().user.name, 'Nome atualizado');
    assert.equal(env.auth.read().persistent, persistent);
  }
});

test('renovar token na troca de senha mantém a escolha e recusa resposta atrasada', () => {
  for (const persistent of [false, true]) {
    const env = environment(); env.auth.save('old', account, persistent);
    assert.equal(env.auth.replaceToken('new', 'old'), true);
    assert.equal(env.auth.read().persistent, persistent);
    assert.equal(env.auth.replaceToken('stale', 'old'), false);
    assert.equal(env.auth.clear('old'), false);
    assert.equal(env.auth.token(), 'new');
  }
});

test('saída limpa só credenciais, preserva preferências e não reativa legado', () => {
  const env = environment(); env.local.setItem('theme', 'dark'); env.session.setItem('student-assessment-session', 'independent');
  env.auth.save('active', account, true);
  assert.equal(env.auth.clear('active'), true);
  assert.equal(env.auth.token(), null);
  assert.equal(env.local.getItem(AUTH_RECORD), null);
  assert.equal(env.local.getItem('theme'), 'dark');
  assert.equal(env.session.getItem('student-assessment-session'), 'independent');
  assert.equal(env.session.getItem(AUTH_LOCK), '1');
  env.auth.save('next', account, false);
  assert.equal(env.auth.token(), 'next');
});

test('mudança de token em outra aba não troca a identidade desta tela silenciosamente', () => {
  const env = environment(); env.auth.save('account-a', account, true);
  const other = environment(env.local);
  other.auth.save('account-b', { ...account, id: 2 }, true);
  assert.equal(env.auth.token(), null);
  assert.equal(env.auth.updateUser(account, 'account-a'), false);
  assert.equal(env.auth.clear('account-a'), false);
  env.auth.lock();
  assert.equal(environment(env.local, env.session).auth.token(), null);
  assert.equal(other.auth.token(), 'account-b');
});

test('perfil temporário atualizado não apaga sessão que outra aba acaba de criar', () => {
  const env = environment(); env.auth.save('tab-a', account);
  const other = environment(env.local);
  other.auth.save('tab-b', { ...account, id: 2 }, true);
  env.auth.updateUser({ ...account, name: 'Perfil atualizado' }, 'tab-a');
  assert.equal(other.auth.token(), 'tab-b');
});

test('registro corrompido não faz fallback silencioso para outra identidade persistente', () => {
  const env = environment();
  env.local.setItem('token', 'legacy'); env.session.setItem(AUTH_RECORD, '{corrompido');
  assert.equal(env.auth.token(), null);
  assert.equal(env.auth.updateUser(account, 'legacy'), false);
});

test('restrição de armazenamento não promove sessão temporária para permanente', () => {
  const local = storage(); const session = storage();
  session.setItem = () => { throw new Error('Storage blocked'); };
  const { auth } = environment(local, session);
  assert.throws(() => auth.save('secret', account), /não permitiu guardar/);
  assert.equal(auth.token(), null);
  assert.equal(local.getItem(AUTH_RECORD), null);
  const blocked = createAuthStorage({ local: () => { throw new Error('blocked'); }, session: () => { throw new Error('blocked'); } });
  assert.equal(blocked.token(), null);
});

test('eventos entre abas não levam token nem dados pessoais', () => {
  const env = environment(); env.auth.save('secret-token', account, true); env.auth.announce('login');
  const raw = env.local.getItem(AUTH_EVENT);
  assert.equal(JSON.parse(raw).kind, 'login');
  assert.doesNotMatch(raw, /secret-token|teacher@|Professor/);
});

test('cache de perfil inválido não é tratado como usuário; /auth/me verificado pode recompô-lo', () => {
  const env = environment();
  env.local.setItem(AUTH_RECORD, JSON.stringify({ token: 'valid', user: 'not-a-user' }));
  assert.equal(env.auth.read().user, null);
  assert.equal(env.auth.updateUser(account, 'valid', { verified: true }), true);
  assert.equal(env.auth.read().user.id, account.id);
  assert.equal(env.auth.replaceToken('', 'valid'), false);
});

test('perfil confirmado pelo servidor prevalece sobre cache incompatível, sem aceitar token atrasado', () => {
  const env = environment();
  env.local.setItem(AUTH_RECORD, JSON.stringify({ token: 'valid', user: { ...account, id: 999 } }));
  assert.equal(env.auth.updateUser(account, 'valid'), false);
  assert.equal(env.auth.updateUser(account, 'valid', { verified: true }), true);
  assert.equal(env.auth.updateUser({ ...account, id: 2 }, 'stale', { verified: true }), false);
});
