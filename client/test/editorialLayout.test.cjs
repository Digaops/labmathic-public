const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');

const clientRoot = path.resolve(__dirname, '..');
const read = file => fs.readFileSync(path.join(clientRoot, 'src', file), 'utf8');
const surfaces = ['pages/LessonPlans.jsx', 'pages/LessonPlanEditor.jsx', 'pages/QuestionSets.jsx', 'pages/QuestionSetView.jsx'];
let stylesheet;

function compiledStylesheet() {
  // Expand the production @apply rules and utilities without writing build output.
  stylesheet ??= (async () => {
    const { default: config } = await import('../tailwind.config.js');
    const content = [...surfaces, 'pages/admin/NumericReviews.jsx', 'components/Layout.jsx']
      .map(file => ({ raw: read(file), extension: 'jsx' }));
    const source = path.join(clientRoot, 'src/index.css');
    return (await postcss([tailwindcss({ ...config, content })])
      .process(fs.readFileSync(source, 'utf8'), { from: source })).root;
  })();
  return stylesheet;
}

function declaration(root, selector, property) {
  let result;
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) {
      rule.walkDecls(property, value => { result = value.value; });
    }
  });
  assert.notEqual(result, undefined, `${selector}: declaração ${property} ausente`);
  return result;
}

function opaqueColor(root, selector, property) {
  const value = declaration(root, selector, property);
  const match = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/\s*(.+))?\)$/.exec(value);
  assert.ok(match, `${selector}: esperado RGB emitido pelo Tailwind, recebido ${value}`);
  const opacity = property === 'color' ? '--tw-text-opacity' : '--tw-bg-opacity';
  if (match[4]) {
    if (match[4].startsWith('var(')) {
      assert.ok(match[4].includes(opacity), `${selector}: canal de opacidade inesperado`);
      assert.equal(declaration(root, selector, opacity), '1');
    } else assert.equal(Number(match[4]), 1, `${selector}: cor deve ser opaca`);
  }
  return match.slice(1, 4).map(Number);
}

function contrast(text, background) {
  const luminance = channels => channels.map(channel => {
    const value = channel / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i], 0);
  const a = luminance(text), b = luminance(background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

test('espaço do conteúdo acompanha a presença do breadcrumb, sem depender da rota', async () => {
  const root = await compiledStylesheet();
  assert.equal(declaration(root, '.app-main', 'padding-top'), '5rem');
  assert.equal(declaration(root, '.app-shell:has(> [data-breadcrumbs]) > .app-main', 'padding-top'), '6.75rem');
  const layout = read('components/Layout.jsx');
  const main = /<main\b[^>]*className="([^"]*)"/.exec(layout);
  assert.ok(main, 'main deve usar classes estáveis para reservar o espaço da navegação');
  assert.ok(main[1].split(/\s+/).includes('app-main'));
  assert.doesNotMatch(main[1], /(?:^|\s)(?:pt|py|p)-/, 'uma utilidade não deve sobrescrever o espaço calculado pelo shell');
  assert.doesNotMatch(main[0], /pathname|isHome/, 'a URL não deve determinar o espaço do conteúdo');
});

test('superfícies editoriais e revisão numérica mantêm contraste AA no tema claro', async () => {
  const root = await compiledStylesheet();
  for (const [label, textSelector, backgroundSelector] of [
    ['superfície editorial', '.editorial-workspace', '.editorial-workspace'],
    ['revisão numérica', '.text-slate-900', '.bg-slate-50'],
  ]) {
    const ratio = contrast(opaqueColor(root, textSelector, 'color'), opaqueColor(root, backgroundSelector, 'background-color'));
    assert.ok(ratio >= 4.5, `${label}: contraste ${ratio.toFixed(2)}:1 abaixo de 4.5:1`);
  }
  const numericRoot = /return\s+<div\b[^>]*className="([^"]*)"/.exec(read('pages/admin/NumericReviews.jsx'));
  assert.ok(numericRoot);
  for (const token of ['bg-slate-50', 'text-slate-900']) assert.ok(numericRoot[1].split(/\s+/).includes(token));
});

test('tema escuro conserva texto legível sobre a cor base do shell sem impor painel claro', async () => {
  const root = await compiledStylesheet();
  const selector = '.editorial-workspace:is(.dark *)';
  assert.equal(declaration(root, selector, 'background-color'), 'transparent');
  const ratio = contrast(opaqueColor(root, selector, 'color'), opaqueColor(root, '.dark body', 'background-color'));
  // This checks emitted base colors, not a browser's composited gradient or every descendant.
  assert.ok(ratio >= 4.5, `cores base escuras: contraste ${ratio.toFixed(2)}:1 abaixo de 4.5:1`);
});

test('a cor de títulos e parágrafos não é mais inferida da estrutura do shell', async () => {
  const root = await compiledStylesheet();
  root.walkRules(rule => {
    const structuralHeading = rule.selectors.some(selector => selector.includes('.app-shell')
      && /(?:max-w|first-child|\.animate-fade-in)/.test(selector)
      && /\b(?:h1|h2|p)\s*$/.test(selector));
    if (structuralHeading) {
      rule.walkDecls(/^(?:color|text-shadow)$/, () => assert.fail(`não reintroduzir a sobreposição global: ${rule.selector}`));
    }
  });
});

test('planejamentos e simulados adotam a superfície explícita também em carregamento e erro', () => {
  for (const file of surfaces) {
    const roots = [...read(file).matchAll(/\breturn\s+<div\b[^>]*className="([^"]*)"[^>]*>/g)]
      .filter(match => !file.endsWith('QuestionSetView.jsx') || match[0].includes('data-question-set-detail'));
    assert.equal(roots.length, file.endsWith('LessonPlanEditor.jsx') ? 3 : file.endsWith('QuestionSetView.jsx') ? 2 : 1,
      `${file}: conferir os retornos de página, incluindo carregamento e erro do editor`);
    for (const [, classes] of roots) {
      assert.ok(classes.split(/\s+/).includes('editorial-workspace'), `${file}: retorno sem superfície editorial`);
    }
  }
});
