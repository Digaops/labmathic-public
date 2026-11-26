const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../../client/src');
const read = file => fs.readFileSync(path.join(root, file), 'utf8');
test('somente o layout define a região principal das telas autenticadas', () => {
  const layout = read('components/Layout.jsx');
  assert.equal((layout.match(/<main\b/g) || []).length, 1); assert.match(layout, /id="conteudo-principal"[^>]+tabIndex=\{-1\}/);
  const independentPages = new Set(['JoinClass.jsx', 'Login.jsx', 'NotFound.jsx', 'PrivacyPolicy.jsx', 'SharedMaterial.jsx', 'StudentAssessment.jsx', 'TermsOfUse.jsx']);
  function scan(dir) { for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
    if (entry.isDirectory()) scan(dir + '/' + entry.name);
    else if (entry.name.endsWith('.jsx') && !independentPages.has(entry.name)) assert.doesNotMatch(read(dir + '/' + entry.name), /<main\b|role=['"]main['"]/, entry.name + ' não deve aninhar outra região principal.');
  } }
  scan('pages');
});
test('atalho antecede a navegação, move foco sem alterar rota e aparece somente quando necessário', () => {
  const layout = read('components/Layout.jsx'), css = read('index.css');
  assert.ok(layout.indexOf('href="#conteudo-principal"') < layout.indexOf('<Header'));
  assert.match(layout, /Ir para o conteúdo/); assert.match(layout, /event\.preventDefault\(\)/);
  assert.match(layout, /content\.current\?\.focus\(\{ preventScroll: true \}\)/); assert.match(layout, /scrollIntoView/);
  assert.match(css, /\.skip-to-content:focus\s*\{[^}]*transform: none/);
});
