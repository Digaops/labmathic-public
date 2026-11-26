const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRouter } = require('react-router-dom');
const model = import('../src/services/plannerNavigation.mjs');

test('React Router bloqueia navigate, voltar e avançar sem substituir o histórico', async t => {
  const { createPlannerNavigationRegistry } = await model;
  const state = { dirty: true, busy: false };
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  registry.register('editor', () => state);
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/planejamento', '/planejamento/plan-1'], initialIndex: 1,
  });
  t.after(() => router.dispose());
  router.getBlocker('planner', registry.shouldBlock);
  await router.navigate('/biblioteca');
  assert.equal(router.state.location.pathname, '/planejamento/plan-1');
  assert.equal(router.state.blockers.get('planner').location.pathname, '/biblioteca');
  router.state.blockers.get('planner').reset();
  assert.equal(router.state.location.pathname, '/planejamento/plan-1');
  await router.navigate(-1);
  assert.equal(router.state.blockers.get('planner').state, 'blocked');
  assert.equal(router.state.blockers.get('planner').location.pathname, '/planejamento');
  router.state.blockers.get('planner').proceed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.state.location.pathname, '/planejamento');
  await router.navigate(1);
  assert.equal(router.state.blockers.get('planner').state, 'blocked');
  assert.equal(router.state.blockers.get('planner').location.pathname, '/planejamento/plan-1');
  router.state.blockers.get('planner').reset();
  state.dirty = false;
  await router.navigate(1);
  assert.equal(router.state.location.pathname, '/planejamento/plan-1');
});

test('React Router mantém falha e incerteza protegidas e aceita replace após criação confirmada', async t => {
  const { createPlannerNavigationRegistry } = await model;
  const state = { dirty: true, busy: true };
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  registry.register('editor', () => state);
  const router = createMemoryRouter([{ path: '*', element: null }], { initialEntries: ['/planejamento/novo'] });
  t.after(() => router.dispose());
  router.getBlocker('planner', registry.shouldBlock);
  await router.navigate('/biblioteca');
  assert.equal(router.state.blockers.get('planner').state, 'blocked');
  assert.equal(registry.afterSave('editor', () => router.navigate('/planejamento/saved')), false);
  router.state.blockers.get('planner').reset();
  state.busy = false; // An unconfirmed response is still dirty/protected.
  await router.navigate('/biblioteca');
  assert.equal(router.state.blockers.get('planner').state, 'blocked');
  router.state.blockers.get('planner').reset();
  let navigation;
  registry.afterSave('editor', () => { navigation = router.navigate('/planejamento/saved', { replace: true }); });
  await navigation;
  assert.equal(router.state.location.pathname, '/planejamento/saved');
  assert.equal(router.state.historyAction, 'REPLACE');
  await router.navigate('/biblioteca');
  assert.equal(router.state.blockers.get('planner').state, 'blocked', 'o passe já acabou');
});

test('recomposição protege voltar e avançar entre páginas e deixa a troca de plano com a proteção local', async t => {
  const { createPlannerNavigationRegistry } = await model;
  const review = { dirty: false, busy: false };
  const execution = { dirty: false, busy: true };
  const registry = createPlannerNavigationRegistry(scope => scope === 'recovery' ? 'teacher:session-1' : null);
  registry.register('review', () => review, 'recovery');
  registry.register('execution', () => execution, 'recovery');
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/biblioteca', '/recomposicao?plano=primeiro', '/recomposicao?plano=segundo', '/turmas'],
    initialIndex: 1,
  });
  t.after(() => router.dispose());
  router.getBlocker('planner', registry.shouldBlock);
  await router.navigate(-1);
  assert.equal(router.state.blockers.get('planner').location.pathname, '/biblioteca');
  assert.equal(registry.inspect().busy, true);
  router.state.blockers.get('planner').reset();
  execution.busy = false;
  review.dirty = true;
  await router.navigate(1);
  assert.equal(router.state.location.search, '?plano=segundo', 'troca de plano chega à tela para a única confirmação local');
  assert.equal(router.state.blockers.get('planner').state, 'unblocked');
  await router.navigate(1);
  assert.equal(router.state.blockers.get('planner').location.pathname, '/turmas');
  assert.equal(router.state.location.pathname, '/recomposicao');
  router.state.blockers.get('planner').proceed();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(router.state.location.pathname, '/turmas');
});

test('revisão aberta nos resultados de turma protege a troca de turma na mesma rota', async t => {
  const { createPlannerNavigationRegistry } = await model;
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  registry.register('review', () => ({ dirty: true, busy: false }), 'recovery');
  const router = createMemoryRouter([{ path: '*', element: null }], {
    initialEntries: ['/turmas?turma=primeira&secao=avaliacoes'],
  });
  t.after(() => router.dispose());
  router.getBlocker('planner', registry.shouldBlock);
  await router.navigate('/turmas?turma=segunda&secao=avaliacoes');
  assert.equal(router.state.blockers.get('planner').state, 'blocked');
  assert.equal(router.state.location.search, '?turma=primeira&secao=avaliacoes');
});
