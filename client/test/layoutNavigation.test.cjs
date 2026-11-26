const assert = require('node:assert/strict');
const fs = require('node:fs');
const test = require('node:test');
const vm = require('node:vm');
const { transformSync } = require('esbuild');

test('o layout leva foco e rolagem ao início da nova página em PUSH e REPLACE', () => {
  const filename = require.resolve('../src/components/Layout.jsx');
  const { code } = transformSync(fs.readFileSync(filename, 'utf8'), {
    loader: 'jsx', jsx: 'automatic', format: 'cjs', sourcefile: filename,
  });
  const calls = [], refs = [];
  let cursor, effect, location, navigation;
  const jsx = (type, props) => ({ type, props });
  const imports = {
    react: {
      Suspense: 'Suspense',
      useRef(initial) {
        const index = cursor++;
        refs[index] ??= { current: initial };
        return refs[index];
      },
      useLayoutEffect(callback) { effect = callback; },
    },
    'react/jsx-runtime': { jsx, jsxs: jsx },
    'react-router-dom': { Outlet: 'Outlet', useLocation: () => location, useNavigationType: () => navigation },
    '../contexts/FeatureFlagsContext': { useFeatureFlags: () => ({ unavailable: false }) },
  };
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, require: name => imports[name] || name,
    window: { scrollTo: ({ top, left, behavior }) => calls.push(['scroll', top, left, behavior]) },
  }, { filename });
  const content = { focus: ({ preventScroll }) => calls.push(['focus', preventScroll]) };
  function visit(pathname, action, { search = '', hash = '' } = {}) {
    cursor = 0;
    location = { pathname, search, hash };
    navigation = action;
    const tree = module.exports.default();
    tree.props.children.find(child => child.type === 'main').props.ref.current = content;
    effect();
    return calls.splice(0);
  }

  const focusAndScroll = [['focus', true], ['scroll', 0, 0, 'instant']];
  assert.deepEqual(visit('/instituicoes', 'POP'), []);
  assert.deepEqual(visit('/admin', 'PUSH'), focusAndScroll);
  assert.deepEqual(visit('/admin', 'PUSH', { search: '?aba=usuarios' }), []);
  assert.deepEqual(visit('/turmas', 'REPLACE'), focusAndScroll);
  assert.deepEqual(visit('/turmas', 'PUSH', { hash: '#avaliacoes' }), []);
  assert.deepEqual(visit('/simulados', 'PUSH', { hash: '#recentes' }), []);
  assert.deepEqual(visit('/simulados', 'REPLACE', { search: '?set_page=2' }), []);
  assert.deepEqual(visit('/admin', 'POP'), []);
  assert.deepEqual(visit('/admin', 'PUSH', { search: '?aba=relatorios' }), []);
});
