const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');
const compile = file => transformSync(fs.readFileSync(require.resolve(file), 'utf8'), {
  loader: 'jsx', jsx: 'automatic', format: 'cjs', sourcefile: file,
}).code;
const component = compile('../src/pages/QuestionBank.jsx');
const actionHook = compile('../src/hooks/useMaterialAction.js');
const models = Promise.all(['questionSetDraft', 'questionBankView', 'quickActivityView', 'bankExperiences']
  .map(async name => ['../services/' + name + '.mjs', await import('../src/services/' + name + '.mjs')])).then(Object.fromEntries);
const settle = () => new Promise(resolve => setImmediate(resolve));
const seed = title => ({ selectedIds: [1], selected: { 1: { id: 1, question_code: 'Q1', statement: 'Quanto é 1 + 1?',
  source: 'official', show_image: false } }, form: { title, description: '', is_public: false }, pending: null });
function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(node => find(node, predicate)).find(Boolean);
  if (!tree || typeof tree !== 'object') return undefined;
  return predicate(tree) ? tree : find(tree.props?.children, predicate);
}
function memoryStorage() {
  const data = new Map();
  return { getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, v), removeItem: k => data.delete(k) };
}
async function mount(storage, post, query = '') {
  const values = [], effects = [], cleanups = [], navigation = [];
  let cursor = 0, params = new URLSearchParams(query);
  const same = (a, b) => a?.length === b?.length && b?.every((item, i) => Object.is(item, a[i]));
  const react = {
    useState(initial) {
      const i = cursor++;
      if (!(i in values)) values[i] = typeof initial === 'function' ? initial() : initial;
      return [values[i], next => { values[i] = typeof next === 'function' ? next(values[i]) : next; }];
    },
    useRef(initial) { const i = cursor++; return values[i] ??= { current: initial }; },
    useMemo(callback, deps) {
      const i = cursor++;
      if (!same(values[i]?.deps, deps)) values[i] = { deps, value: callback() };
      return values[i].value;
    },
    useCallback(callback, deps) { return react.useMemo(() => callback, deps); },
    useEffect(callback, deps) {
      const i = cursor++;
      if (same(values[i], deps)) return;
      values[i] = deps;
      effects.push(() => { cleanups[i]?.(); cleanups[i] = callback(); });
    },
  };
  const services = await models;
  const draftService = services['../services/questionSetDraft.mjs'];
  const jsx = (type, props) => ({ type, props });
  const imports = {
    ...services, react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { useSearchParams: () => [params, next => { params = next; }], useNavigate: () => url => navigation.push(url) },
    'lucide-react': new Proxy({}, { get: (_, key) => key }),
    '../contexts/AuthContext': { useAuth: () => ({ user: { id: 1, role: 'professor' } }) },
    '../contexts/FeatureFlagsContext': { useFeatureFlags: () => ({ isEnabled: () => true, loading: false, unavailable: false }) },
    '../contexts/ToastContext': { useToast: () => ({ error() {}, success() {} }) },
    '../hooks/useHomeResource': () => ({ status: 'loading', data: null, retry() {} }),
    '../services/authStorage.mjs': { authStorage: { token: () => 'synthetic-token' } },
    '../services/api': { post },
    '../services/questionSetDraft.mjs': { ...draftService, questionSetDraftStore: id => draftService.questionSetDraftStore(id, () => storage) },
    '../utils/pluralize': { formatCount: (n, singular) => `${n} ${singular}` },
  };
  const environment = { AbortController, URLSearchParams, requestAnimationFrame: fn => fn(),
    window: { addEventListener() {}, removeEventListener() {}, confirm: () => true } };
  function evaluate(code) {
    const module = { exports: {} };
    vm.runInNewContext(code, { ...environment, module, require: name => imports[name] || name });
    return module.exports.default;
  }
  imports['../hooks/useMaterialAction'] = evaluate(actionHook);
  const page = evaluate(component);
  function render() {
    cursor = 0;
    const root = page();
    const tree = root.type(root.props);
    effects.splice(0).forEach(run => run());
    return tree;
  }
  function save({ quick = false } = {}) {
    const reviewLabel = quick ? 'Conferir atividade' : 'Conferir e gerar simulado';
    const saveLabel = quick ? 'Salvar e revisar atividade' : 'Salvar simulado';
    find(render(), node => node.type === 'button' && node.props.children?.includes?.(reviewLabel)).props.onClick();
    const button = find(render(), node => node.type === 'button' && node.props.children?.includes?.(saveLabel));
    assert.ok(button);
    button.props.onClick();
  }
  return { render, save, navigation, unmount: () => cleanups.forEach(fn => fn?.()) };
}

test('simulado comum pode compartilhar; atividade rápida, piloto e item autoral são privados desde o envio', async () => {
  const { questionSetDraftStore } = (await models)['../services/questionSetDraft.mjs'];
  for (const kind of ['common', 'quick', 'pilot', 'author']) {
    const storage = memoryStorage();
    const draft = seed('Simulado de teste');
    draft.form.is_public = true; // The visibility may have been chosen before changing the selection.
    const quick = kind === 'quick';
    Object.assign(draft.selected[1], {
      grade_id: 5, skill_id: 17, question_type: 'multiple_choice', quick_compatible: true,
      editorial_pilot: kind === 'pilot', source: kind === 'author' ? 'teacher' : 'official',
    });
    questionSetDraftStore(1, () => storage).write(draft);
    const received = [];
    const page = await mount(storage, async (url, body) => {
      received.push(body.is_public);
      return { data: { id: 8, user_id: 1, title: body.title, description: null,
        is_public: Number(body.is_public), question_count: 1, author_question_count: Number(kind === 'author') } };
    }, quick ? 'turma=turma-sintetica-001&atividade=rapida' : '');
    page.save({ quick });
    await settle();
    assert.deepEqual(received, [kind === 'common'], kind);
    assert.deepEqual(page.navigation, [quick ? '/simulados/8?turma=turma-sintetica-001&atividade=rapida' : '/simulados/8'], kind);
    page.unmount();
  }
});

test('resposta tardia de tela desmontada não sobrescreve o novo rascunho da conta', async () => {
  const { questionSetDraftStore } = (await models)['../services/questionSetDraft.mjs'];
  for (const result of ['success', 'error']) {
    const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
    store.write(seed('Primeiro trabalho'));
    let finish;
    const page = await mount(storage, () => new Promise((resolve, reject) => {
      finish = result === 'success' ? () => resolve({ data: { id: 8, user_id: 1, title: 'Primeiro trabalho', description: null,
        is_public: 0, question_count: 1, author_question_count: 0 } }) : () => reject(new Error('Resposta antiga perdida'));
    }));
    page.save();
    assert.ok(store.read().pending, 'identificação persistida antes do envio');
    page.unmount();
    // Another mounted workspace reconciled the old operation and started new work.
    store.write(seed('Trabalho mais recente'));
    finish();
    await settle();
    assert.equal(store.read().form.title, 'Trabalho mais recente');
    assert.equal(store.read().pending, null);
    assert.deepEqual(page.navigation, []);
  }
});

test('resposta parcial 2xx preserva confirmação pendente e não navega', async () => {
  const { questionSetDraftStore } = (await models)['../services/questionSetDraft.mjs'];
  const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
  store.write(seed('Não perder este envio'));
  const page = await mount(storage, async () => ({ data: { id: 8 } }));
  page.save();
  const before = store.read().pending;
  await settle();
  page.render();
  assert.deepEqual(store.read().pending, before);
  assert.deepEqual(page.navigation, []);
  page.unmount();
});

test('montagem não remove JSON ilegível e descarte explícito libera novo rascunho', async () => {
  const { QUESTION_SET_DRAFT_PREFIX, questionSetDraftStore } = (await models)['../services/questionSetDraft.mjs'];
  const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
  storage.setItem(QUESTION_SET_DRAFT_PREFIX + 1, '{');
  const page = await mount(storage, () => { throw Error('Não deve enviar'); });
  const tree = page.render();
  assert.equal(storage.getItem(QUESTION_SET_DRAFT_PREFIX + 1), '{');
  find(tree, node => node.type === 'button' && node.props.children === 'Descartar rascunho anterior').props.onClick();
  page.render();
  assert.equal(store.inspect().status, 'missing');
  page.unmount();
});
