const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const filename = require.resolve('../src/pages/LearningRecoveryPlans.jsx');
const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
  loader: 'jsx', jsx: 'automatic', format: 'cjs', sourcefile: filename,
});
const listPath = '/classes/recovery-plans?limit=100';
const recoveryFlags = Object.fromEntries(['classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'classes.learning_recovery']
  .map(flag => [flag, true]));
const plan = id => ({
  id, title: 'Apoio ' + id, status: 'draft', revision: 1, groupCount: 0,
  priorityCount: 1, plannedQuestionCount: 0, studentCount: 0,
  class: { id: 'turma-1', name: 'Turma' }, sourceAssessment: { id: 'prova-1', title: 'Diagnóstico' },
});
const list = (...data) => ({ status: 'ready', data: {
  data, counts: { total: data.length, draft: data.length, active: 0, completed: 0, archived: 0 },
} });

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(node => find(node, predicate)).find(Boolean);
  if (!tree || typeof tree !== 'object') return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate);
}
const getPlanDialog = tree => find(tree, node => node.type?.name === 'PlanDialog');

async function mount(initialQuery) {
  let params = new URLSearchParams(initialQuery);
  const navigate = query => { params = new URLSearchParams(query); };
  let auth = { user: { id: 1, role: 'professor' }, announcementAccessId: 'test' };
  let flags = { features: recoveryFlags }, refreshes = 0, workspaceKey;
  let cursor = 0, tree;
  const values = [], effects = [], focused = [], reads = [];
  const resources = new Map();
  const jsx = (type, props, key) => ({ type, props, key });
  const imports = {
    react: {
      useRef(initial) {
        const index = cursor++;
        values[index] ??= { current: initial };
        return values[index];
      },
      useState(initial) {
        const index = cursor++;
        if (!(index in values)) values[index] = initial;
        return [values[index], next => { values[index] = typeof next === 'function' ? next(values[index]) : next; }];
      },
      useEffect(callback, deps) {
        const index = cursor++;
        if (values[index]?.every((value, position) => Object.is(value, deps[position]))) return;
        values[index] = deps;
        effects.push(callback);
      },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { Link: 'Link', useSearchParams: () => [params, navigate] },
    'lucide-react': { ArrowRight: 'ArrowRight', RefreshCw: 'RefreshCw', Search: 'Search' },
    '../contexts/AuthContext': { useAuth: () => auth },
    '../contexts/FeatureFlagsContext': { useFeatureFlags: () => ({
      ...flags, isEnabled: key => flags.features?.[key] === true, refresh: () => { refreshes++; },
    }) },
    '../hooks/useHomeResource': (path, identity, parse) => {
      if (!path) return { status: 'idle' };
      reads.push([path, identity]);
      const resourceKey = identity === '1:professor:test' ? path : `${identity}:${path}`;
      const resource = resources.get(resourceKey) || { status: 'loading' };
      if (resource.status === 'ready') parse(resource.data);
      return { ...resource, retry: () => resources.set(resourceKey, { status: 'loading' }) };
    },
    '../services/recoveryPlansView.mjs': await import('../src/services/recoveryPlansView.mjs'),
    '../services/eventDates.mjs': { eventDay: () => '' },
    '../services/recoveryLanguage.mjs': { recoverySummary: () => '' },
  };
  const module = { exports: {} };
  const document = {
    getElementById: id => find(tree, node => node.props.id === id) && { focus: () => focused.push(id) },
  };
  vm.runInNewContext(code, { module, document, URLSearchParams, require: name => imports[name] || name }, { filename });
  function render() {
    cursor = 0;
    const root = module.exports.default();
    if (workspaceKey !== root.key) { values.length = 0; workspaceKey = root.key; }
    if (typeof root.type !== 'function') return root;
    tree = root.type(root.props);
    find(tree, node => node.type === 'h1').props.ref.current = { focus: () => focused.push('heading') };
    effects.splice(0).forEach(run => run());
    return tree;
  }
  return { render, navigate, focused, reads, resources, query: () => params.toString(),
    changeAuth: current => { auth = current; }, changeFlags: current => { flags = current; }, refreshes: () => refreshes };
}

test('abre o plano exato da lista confirmada e retorna ao seu botão mesmo em outra página', async () => {
  const page = await mount('plano=escolhido&origem=inicio');
  assert.equal(getPlanDialog(page.render()), undefined);
  const selected = plan('escolhido');
  const snapshot = list(...Array.from({ length: 22 }, (_, index) => plan('plano-' + index)), selected);
  page.resources.set(listPath, snapshot);
  page.render();
  const dialog = getPlanDialog(page.render());
  assert.equal(dialog.props.plan, selected);
  dialog.props.onClose();
  assert.equal(page.query(), 'origem=inicio');
  assert.equal(getPlanDialog(page.render()), undefined);
  page.resources.set(listPath, snapshot);
  page.render();
  page.render();
  assert.deepEqual(page.focused, ['recovery-open-escolhido']);
});

test('busca o plano fora do filtro sem substituir a busca e os filtros ao fechar', async () => {
  const page = await mount('busca=fra%C3%A7%C3%B5es&situacao=draft&plano=escolhido');
  const filteredPath = '/classes/recovery-plans?limit=100&search=fra%C3%A7%C3%B5es&status=draft';
  const filtered = list(plan('outro'));
  page.resources.set(filteredPath, filtered);
  page.resources.set(listPath, list(plan('escolhido')));
  page.render();
  const dialog = getPlanDialog(page.render());
  assert.equal(dialog.props.plan.id, 'escolhido');
  dialog.props.onClose();
  assert.equal(page.query(), 'busca=fra%C3%A7%C3%B5es&situacao=draft');
  page.render();
  page.resources.set(filteredPath, filtered);
  page.render();
  assert.deepEqual(page.focused, ['heading']);
});

test('identificador que não coincide com a lista não abre outro plano nem vira endereço de API', async () => {
  for (const query of ['plano=desconhecido', 'plano=../fora', 'plano=outro&plano=segundo']) {
    const page = await mount(query);
    page.resources.set(listPath, list(plan('outro')));
    const tree = page.render();
    assert.equal(getPlanDialog(tree), undefined);
    assert.ok(find(tree, node => node.type === 'button' && node.props.children === 'Continuar na lista'));
    assert.deepEqual(page.reads, [[listPath, '1:professor:test']]);
  }
});

test('troca de link na mesma rota leva ao novo plano e fechar consome somente esse link', async () => {
  const first = plan('primeiro'), second = plan('segundo');
  const page = await mount('plano=primeiro');
  page.resources.set(listPath, list(first, second));
  page.render();
  assert.equal(getPlanDialog(page.render()).props.plan, first);
  page.navigate('plano=segundo&origem=retorno');
  page.render();
  page.render();
  const dialog = getPlanDialog(page.render());
  assert.equal(dialog.props.plan, second);
  dialog.props.onClose();
  assert.equal(page.query(), 'origem=retorno');
  assert.equal(getPlanDialog(page.render()), undefined);
});

test('voltar à lista fecha o plano limpo e devolve o foco à escolha anterior', async () => {
  const page = await mount('plano=primeiro');
  page.resources.set(listPath, list(plan('primeiro')));
  page.render();
  assert.ok(getPlanDialog(page.render()));
  page.navigate('origem=retorno');
  page.render();
  assert.equal(getPlanDialog(page.render()), undefined);
  assert.equal(page.query(), 'origem=retorno');
  assert.deepEqual(page.focused, ['recovery-open-primeiro']);
});

test('voltar ao plano anterior enquanto outro link carrega retoma a escolha do histórico', async () => {
  const first = plan('primeiro');
  const page = await mount('plano=primeiro');
  page.resources.set(listPath, list(first));
  page.render();
  assert.equal(getPlanDialog(page.render()).props.plan, first);
  page.navigate('plano=segundo&busca=novo');
  page.render();
  assert.equal(getPlanDialog(page.render()), undefined);
  page.navigate('plano=primeiro');
  page.render();
  assert.equal(getPlanDialog(page.render()).props.plan, first);
});

test('a revisão pode recusar a troca de link e permanecer montada com o endereço correto', async () => {
  const first = plan('primeiro');
  const page = await mount('plano=primeiro&situacao=draft');
  page.resources.set(`${listPath}&status=draft`, list(first, plan('segundo')));
  page.render();
  const { closeGuardRef } = getPlanDialog(page.render()).props;
  let guardCalls = 0;
  closeGuardRef.current = () => { guardCalls++; return false; };
  page.navigate('plano=segundo&situacao=draft&origem=retorno');
  page.render();
  assert.equal(getPlanDialog(page.render()).props.plan, first);
  assert.equal(new URLSearchParams(page.query()).get('plano'), 'primeiro');
  assert.equal(new URLSearchParams(page.query()).get('situacao'), 'draft');
  assert.equal(new URLSearchParams(page.query()).get('origem'), 'retorno');
  assert.equal(guardCalls, 1);
});

test('escolha manual substitui um link que ainda está sendo localizado', async () => {
  const page = await mount('situacao=draft&plano=antigo');
  const picked = plan('escolhido');
  page.resources.set(`${listPath}&status=draft`, list(picked));
  const tree = page.render();
  find(tree, node => node.props.id === 'recovery-open-escolhido').props.onClick();
  page.resources.set(listPath, list(plan('antigo')));
  page.render();
  assert.equal(getPlanDialog(page.render()).props.plan, picked);
  assert.equal(page.query(), 'situacao=draft&plano=escolhido');
});

test('nenhuma versão parcial das permissões abre a lista ou dispara uma consulta', async () => {
  for (const flag of Object.keys(recoveryFlags)) {
    const page = await mount('plano=primeiro');
    page.changeFlags({ features: { ...recoveryFlags, [flag]: false } });
    assert.equal(page.render().props['data-recovery-access'], 'not_released');
    assert.deepEqual(page.reads, []);
  }
  const page = await mount('plano=primeiro');
  page.changeFlags({ loading: true, features: recoveryFlags });
  assert.equal(page.render().props['data-recovery-access'], 'loading');
  page.changeFlags({ unavailable: true });
  const unavailable = page.render();
  assert.equal(unavailable.props['data-recovery-access'], 'unavailable');
  find(unavailable, node => node.type === 'button').props.onClick();
  assert.equal(page.refreshes(), 1);
  page.changeFlags({ features: recoveryFlags });
  page.changeAuth({ user: { id: 2, role: 'admin' }, announcementAccessId: 'test' });
  assert.equal(page.render().props['data-recovery-access'], 'role_restricted');
  assert.deepEqual(page.reads, []);
});

test('falha transitória mantém a revisão, mas revogação ou mudança de identidade encerra a instância anterior', async () => {
  const page = await mount('plano=primeiro');
  const first = plan('primeiro');
  page.resources.set(listPath, list(first));
  page.render();
  const dialog = getPlanDialog(page.render());
  page.changeFlags({ unavailable: true, features: recoveryFlags });
  assert.equal(getPlanDialog(page.render()).props.closeGuardRef, dialog.props.closeGuardRef);
  page.changeFlags({ features: { ...recoveryFlags, 'classes.assessment_results': false } });
  assert.equal(page.render().props['data-recovery-access'], 'not_released');
  const count = page.reads.length;
  page.changeFlags({ features: recoveryFlags });
  page.changeAuth({ user: { id: 2, role: 'professor' }, announcementAccessId: 'new' });
  assert.equal(getPlanDialog(page.render()), undefined);
  assert.deepEqual(page.reads.slice(count), [[listPath, '2:professor:new']]);
});
