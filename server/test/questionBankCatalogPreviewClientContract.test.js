const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'client', 'src');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('frontend publica catálogo sintético acessível, imprimível e sem mutações', () => {
  const app = source('App.jsx');
  const header = source('components/Header.jsx');
  const flags = source('contexts/FeatureFlagsContext.jsx');
  const dashboard = source('components/AdministrativeHome.jsx');
  const page = source('pages/QuestionBankCatalogLab.jsx');
  const styles = source('index.css');

  assert.match(flags, /'question_bank\.catalog_preview'/);
  assert.match(app, /path="banco-questoes\/revisao"/);
  assert.match(app, /flag="question_bank\.catalog_preview"/);
  assert.match(header, /BANK_EXAMPLES/);
  assert.match(source('services/bankExperiences.mjs'), /Exemplos do Banco 2\.0/);
  assert.match(app, /path="exemplos\/banco-questoes"/);
  assert.match(dashboard, /Exemplos do Banco 2\.0/);
  assert.match(page, /catalog-preview\/catalog/);
  assert.match(page, /catalog-preview\/items/);
  assert.match(page, /role="status"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /catalog-preview-print-root/);
  assert.match(page, /Sem nota automática/);
  assert.match(styles, /body:has\(\.catalog-preview-page\)/);
  assert.doesNotMatch(page, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(page, /question_bank\.typed_engine/);
});
