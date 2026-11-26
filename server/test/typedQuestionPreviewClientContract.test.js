const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'client', 'src');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('frontend publica laboratório acessível, imprimível e sem mutações', () => {
  const app = source('App.jsx');
  const header = source('components/Header.jsx');
  const flags = source('contexts/FeatureFlagsContext.jsx');
  const dashboard = source('components/AdministrativeHome.jsx');
  const page = source('pages/TypedQuestionLab.jsx');
  const styles = source('index.css');

  assert.match(flags, /'question_bank\.typed_preview'/);
  assert.match(app, /path="banco-questoes\/formatos"/);
  assert.match(app, /flag="question_bank\.typed_preview"/);
  assert.match(header, /Exemplos de formatos/);
  assert.match(app, /path="exemplos\/formatos"/);
  assert.match(dashboard, /Conhecer os exemplos/);
  assert.match(dashboard, /flags.isEnabled\(flag\)/);
  assert.match(dashboard, /Não são diagnósticos ou intervenções de uma turma real/);
  assert.match(page, /useDemoResource\('\/question-bank\/typed-preview\/catalog'/);
  assert.match(page, /<fieldset/);
  assert.match(page, /<legend/);
  assert.match(page, /inputMode="decimal"/);
  assert.match(page, /Mover \$\{item\.text\} para cima/);
  assert.match(page, /typed-lab-print-root/);
  assert.match(styles, /@media print/);
  assert.match(styles, /break-inside: avoid/);
  assert.doesNotMatch(page, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(page, /question_bank\.typed_engine/);
});
