const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const postcss = require('postcss');
const tailwindcss = require('tailwindcss');

const motion = import('../src/services/motionPreference.mjs');
const clientRoot = path.resolve(__dirname, '..');

test('rolagem usa alternativa sem animação durante SSR', async () => {
  const { preferredScrollBehavior } = await motion;
  assert.equal(globalThis.window, undefined);
  assert.equal(preferredScrollBehavior(), 'instant');
});

test('rolagem usa alternativa sem animação quando matchMedia não está disponível', async () => {
  const { preferredScrollBehavior } = await motion;
  for (const target of [null, {}, { matchMedia: null }, { matchMedia: true }]) {
    assert.equal(preferredScrollBehavior(target), 'instant');
  }
});

test('preferência por movimento reduzido impede rolagem suave explícita', async () => {
  const { preferredScrollBehavior } = await motion;
  const target = {
    matchMedia(query) {
      assert.equal(this, target);
      assert.equal(query, '(prefers-reduced-motion: no-preference)');
      return { matches: false };
    },
  };
  assert.equal(preferredScrollBehavior(target), 'instant');
});

test('rolagem suave permanece disponível quando o dispositivo permite movimento', async () => {
  const { preferredScrollBehavior } = await motion;
  assert.equal(preferredScrollBehavior({ matchMedia: () => ({ matches: true }) }), 'smooth');
});

test('mudança de preferência vale na ação seguinte sem recarregar ou reimportar', async () => {
  const { preferredScrollBehavior } = await motion;
  let permitsMotion = true;
  let queries = 0;
  const target = { matchMedia: () => { queries++; return { matches: permitsMotion }; } };
  assert.equal(preferredScrollBehavior(target), 'smooth');
  permitsMotion = false;
  assert.equal(preferredScrollBehavior(target), 'instant');
  permitsMotion = true;
  assert.equal(preferredScrollBehavior(target), 'smooth');
  assert.equal(queries, 3, 'não reutiliza um resultado antigo de matchMedia');
});

let stylesheet;
function compiledStylesheet() {
  // Compile the real stylesheet/config and component sources, in memory only.
  // Checking the emitted CSS also covers @apply expansion into .skeleton.
  stylesheet ??= (async () => {
    const { default: config } = await import('../tailwind.config.js');
    const source = path.join(clientRoot, 'src/index.css');
    const content = ['MaterialCard.jsx', 'Skeleton.jsx'].map(name => ({
      raw: fs.readFileSync(path.join(clientRoot, 'src/components', name), 'utf8'), extension: 'jsx',
    }));
    content.push({ raw: 'btn-secondary animate-fade-in animate-slide-up animate-slide-down animate-scale-in animate-spin motion-reduce:animate-none animate-shimmer', extension: 'html' });
    return (await postcss([tailwindcss({ ...config, content })]).process(fs.readFileSync(source, 'utf8'), { from: source })).root;
  })();
  return stylesheet;
}

function declarations(root, selector, property) {
  const result = [];
  root.walkRules(rule => {
    if (rule.selectors.includes(selector)) rule.walkDecls(property, declaration => result.push(declaration));
  });
  return result;
}

function mediaAncestor(node, params) {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === 'atrule' && parent.name === 'media' && parent.params === params) return parent;
  }
  return null;
}

function reducedDeclarations(root, selector, property) {
  return declarations(root, selector, property).filter(node => mediaAncestor(node, '(prefers-reduced-motion: reduce)'));
}

function rgb(value) {
  const channels = /^rgb\(\s*(\d+)\s+(\d+)\s+(\d+)(?:\s*\/.+)?\)$/.exec(value);
  assert.ok(channels, `esperado RGB emitido pelo Tailwind: ${value}`);
  return channels.slice(1).map(Number);
}

function luminance(channels) {
  return channels.map(channel => {
    const srgb = channel / 255;
    return srgb <= 0.04045 ? srgb / 12.92 : ((srgb + 0.055) / 1.055) ** 2.4;
  }).reduce((total, linear, index) => total + linear * [0.2126, 0.7152, 0.0722][index], 0);
}

test('botão secundário mantém contraste AA para texto branco no estado normal, hover e ativo', async () => {
  const root = await compiledStylesheet();
  const text = rgb(declarations(root, '.btn-secondary', 'color').at(-1).value);
  assert.deepEqual(text, [255, 255, 255]);
  assert.equal(declarations(root, '.btn-secondary', '--tw-text-opacity').at(-1)?.value, '1');
  for (const state of ['', ':hover', ':active']) {
    const selector = '.btn-secondary' + state;
    assert.equal(declarations(root, selector, '--tw-bg-opacity').at(-1)?.value, '1');
    const background = rgb(declarations(root, selector, 'background-color').at(-1).value);
    const contrast = (luminance(text) + 0.05) / (luminance(background) + 0.05);
    assert.ok(contrast >= 4.5, `${selector}: contraste ${contrast.toFixed(2)}:1 abaixo de 4.5:1`);
  }
});

test('movimento reduzido remove transições espaciais sem apagar transformações de posicionamento', async () => {
  const root = await compiledStylesheet();
  const allowed = new Set(['color', 'background-color', 'border-color', 'text-decoration-color', 'fill', 'stroke', 'opacity']);
  for (const selector of ['*', '::before', '::after']) {
    const scroll = reducedDeclarations(root, selector, 'scroll-behavior').at(-1);
    assert.equal(scroll?.value, 'auto');
    assert.equal(scroll?.important, true);
    const transition = reducedDeclarations(root, selector, 'transition-property').at(-1);
    assert.equal(transition?.important, true);
    const properties = transition.value.split(',').map(value => value.trim());
    assert.ok(properties.length && properties.every(property => allowed.has(property)));
    assert.ok(properties.includes('color') && properties.includes('opacity'), 'feedback visual não espacial continua disponível');
  }
  root.walkDecls(/^(transform|translate|rotate|scale)$/, declaration => {
    assert.equal(Boolean(mediaAncestor(declaration, '(prefers-reduced-motion: reduce)')), false,
      'não zerar transformações usadas no posicionamento e estado dos componentes');
  });
});

test('movimento reduzido mantém feedback de opacidade e desliga shimmer inclusive nos skeletons', async () => {
  const root = await compiledStylesheet();
  const opacityAnimations = new Set();
  root.walkAtRules('keyframes', keyframes => {
    const properties = [];
    keyframes.walkDecls(declaration => properties.push(declaration.prop));
    if (properties.length && properties.every(property => property === 'opacity')) opacityAnimations.add(keyframes.params);
  });
  for (const selector of ['.animate-fade-in', '.animate-slide-up', '.animate-slide-down', '.animate-scale-in', '.animate-spin:not(.motion-reduce\\:animate-none)']) {
    const animation = reducedDeclarations(root, selector, 'animation').at(-1);
    assert.ok(animation, `${selector}: deve ter alternativa de movimento reduzido`);
    assert.ok(opacityAnimations.has(animation.value.split(/\s+/)[0]), `${selector}: não deve deslocar nem girar`);
  }
  for (const selector of ['.animate-shimmer', '.skeleton', '.motion-reduce\\:animate-none']) {
    assert.equal(reducedDeclarations(root, selector, 'animation').at(-1)?.value, 'none', selector);
  }
});

test('seta do material só se desloca quando não há preferência de movimento reduzido', async () => {
  const root = await compiledStylesheet();
  const translations = [];
  root.walkDecls('--tw-translate-x', declaration => {
    if (declaration.parent.selector?.includes('group-hover') && declaration.value !== '0') translations.push(declaration);
  });
  assert.ok(translations.length, 'compilação deve incluir a interação real do MaterialCard');
  for (const declaration of translations) {
    assert.ok(mediaAncestor(declaration, '(prefers-reduced-motion: no-preference)'), 'deslocamento não pode escapar da condição motion-safe');
  }
});
