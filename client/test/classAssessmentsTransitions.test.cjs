const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

const sourceFile = require.resolve('../src/components/ClassAssessments.jsx');
const component = transformSync(fs.readFileSync(sourceFile, 'utf8'), {
  loader: 'jsx', jsx: 'automatic', format: 'cjs', sourcefile: sourceFile,
}).code;
const servicePaths = [
  '../services/assessmentView.mjs', '../services/assessmentPreparation.mjs',
  '../services/assessmentRoster.mjs', '../services/bankExperiences.mjs', '../services/classesView.mjs',
  '../services/numericAssessmentSubmission.mjs', '../utils/classAssessments', '../utils/pluralize',
];
const services = Promise.all(servicePaths.map(async path => [
  path, await import(path.replace('../', '../src/') + (path.startsWith('../utils/') ? '.js' : '')),
])).then(Object.fromEntries);
const settle = () => new Promise(resolve => setImmediate(resolve));
const bootstrap = { participants: [], sources: [] };
const schoolClass = { id: 'class-1', name: 'Turma teste', status: 'active' };

function assignment(id, status, extra) {
  return { id, status, title: id, revision: 1, questionCount: 1, participantCount: 0,
    opensAt: null, closesAt: null, ...extra };
}

// Render this component's own JSX and exercise its handlers with controlled
// state, effects, timers and reads. The dialogs are shallow placeholders.
async function mount(read, { role = 'professor', disabledFlag } = {}) {
  const slots = [], effects = [], timers = [];
  let cursor = 0;
  const jsx = (type, props) => ({ type, props });
  const react = {
    useState(initial) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial;
      return [slots[index], next => { slots[index] = typeof next === 'function' ? next(slots[index]) : next; }];
    },
    useRef(initial) {
      const index = cursor++;
      slots[index] ??= { current: initial };
      return slots[index];
    },
    useEffect(effect, deps) {
      const index = cursor++;
      if (unchanged(slots[index]?.deps, deps)) return;
      effects.push(() => {
        slots[index]?.cleanup?.();
        slots[index] = { deps, cleanup: effect() };
      });
    },
    useCallback(callback, deps) {
      const index = cursor++;
      if (!unchanged(slots[index]?.deps, deps)) slots[index] = { deps, callback };
      return slots[index].callback;
    },
    useMemo: calculate => calculate(),
  };
  const imports = {
    ...await services,
    react, 'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { Link: 'Link' },
    'lucide-react': new Proxy({}, { get: (_, name) => name }),
    '../hooks/useAccountLeave': () => {},
    '../hooks/useMaterialAction': () => ({ busy: false }),
    '../contexts/AuthContext': { useAuth: () => ({ user: { role } }) },
    '../contexts/FeatureFlagsContext': { useFeatureFlags: () => ({ isEnabled: flag => flag !== disabledFlag }) },
    '../services/api': { get: async path => ({ data: path.endsWith('/bootstrap') ? bootstrap : await read(path) }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(component, {
    module, AbortController, Date, Intl, require: name => imports[name] || name,
    window: {
      setTimeout: callback => { timers.push(callback); },
      clearTimeout: () => {}, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    },
  }, { filename: sourceFile });
  function render() {
    cursor = 0;
    const tree = module.exports.default({ schoolClass, deliveryEnabled: true, resultsEnabled: true, studentPortalEnabled: true });
    effects.splice(0).forEach(run => run());
    return tree;
  }
  render();
  await settle();
  return { render, timers };
}

test('mostra Devolutivas da turma somente para quem pode abrir o ciclo operacional', async () => {
  const open = assignment('open-assessment', 'open');
  const feedback = tree => find(tree, node => node.type === 'Link' && node.props.to.startsWith('/banco-questoes/devolutivas?'));
  const allowed = await mount(() => [open]);
  assert.ok(feedback(allowed.render()));
  for (const restrictions of [{ role: 'admin' }, { disabledFlag: 'pedagogy.operational_cycle' }, { disabledFlag: 'classes.assessment_results' }]) {
    const restricted = await mount(() => [open], restrictions);
    assert.equal(feedback(restricted.render()), undefined);
  }
});

function unchanged(previous, next) {
  return previous?.length === next.length && next.every((value, index) => Object.is(previous[index], value));
}

function find(tree, predicate) {
  if (Array.isArray(tree)) return tree.map(child => find(child, predicate)).find(Boolean);
  if (!tree || typeof tree !== 'object') return undefined;
  return predicate(tree) ? tree : find(tree.props.children, predicate);
}

test('abre a edição do rascunho numérico com o título salvo e a etapa de estudantes', async () => {
  const draft = assignment('numeric-draft', 'draft', {
    title: 'Atividade numérica', responseFormat: 'numeric', sourceQuestionSetId: null,
  });
  const { render } = await mount(path => {
    if (path.endsWith('/assessments')) return [draft];
    assert.ok(path.endsWith('/assessments/numeric-draft'));
    return { ...draft, items: [{ questionType: 'numeric' }], participants: [] };
  });

  const edit = find(render(), node => node.props['aria-label'] === 'Editar Atividade numérica');
  await edit.props.onClick();
  const tree = render();
  assert.ok(find(tree, node => node.props.title === 'Editar rascunho: Atividade numérica'));
  const context = find(tree, node => Object.hasOwn(node.props, 'data-assessment-context'));
  assert.ok(find(context, node => node.type === 'p' && node.props.children.includes('Atividade numérica')));
  assert.ok(find(tree, node => node.props['aria-current'] === 'step' && node.props.children[1] === 2));
});

for (const [label, dialog] of [
  ['Corrigir e analisar resultados', './ClassAssessmentResults'],
  ['Acessos dos estudantes', './StudentAssessmentAccessModal'],
]) {
  test(`mantém o diálogo de ${label} durante uma transição agendada`, async () => {
    const open = assignment('open-assessment', 'open');
    const scheduled = assignment('scheduled-assessment', 'scheduled', { opensAt: new Date(Date.now() + 60000).toISOString() });
    let currentRead = [open, scheduled];
    const { render, timers } = await mount(() => currentRead);
    const openCard = find(render(), node => node.props['data-assessment-id'] === open.id);
    find(openCard, node => node.type === 'button' && node.props.children.includes(' ' + label)).props.onClick();
    const getDialog = tree => find(tree, node => node.type === dialog);
    assert.equal(getDialog(render())?.props.assignment, open);

    let finishRefresh;
    currentRead = new Promise(resolve => { finishRefresh = resolve; });
    assert.equal(timers.length, 1);
    timers[0]();
    assert.equal(getDialog(render())?.props.assignment, open);
    finishRefresh([open, { ...scheduled, status: 'open' }]);
    await settle();

    const tree = render();
    assert.equal(getDialog(tree)?.props.assignment, open);
    const transitioned = find(tree, node => node.props['data-assessment-id'] === scheduled.id);
    assert.ok(find(transitioned, node => node.type === 'span' && node.props.children.includes('Disponível')));
  });
}
