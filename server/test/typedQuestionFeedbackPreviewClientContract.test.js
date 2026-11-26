const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..', '..', 'client', 'src');
const source = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

test('frontend publica devolutiva acessível, imprimível e sem mutações', () => {
  const app = source('App.jsx');
  const header = source('components/Header.jsx');
  const flags = source('contexts/FeatureFlagsContext.jsx');
  const dashboard = source('components/AdministrativeHome.jsx');
  const page = source('pages/TypedQuestionFeedbackLab.jsx');
  const styles = source('index.css');

  assert.match(flags, /'question_bank\.feedback_preview'/);
  assert.match(app, /path="banco-questoes\/devolutivas"/);
  assert.match(app, /flag="question_bank\.feedback_preview"/);
  assert.match(header, /Devolutivas da turma/);
  assert.match(app, /path="exemplos\/devolutivas"/);
  assert.match(dashboard, /Exemplos de devolutivas/);
  assert.match(page, /feedback-preview\/catalog/);
  assert.match(page, /feedback-preview\/examples/);
  assert.match(page, /role="status"/);
  assert.match(page, /aria-live="polite"/);
  assert.match(page, /feedback-lab-print-root/);
  assert.match(page, /Devolutiva ainda não liberada/);
  assert.match(styles, /body:has\(\.feedback-lab-page\)/);
  assert.doesNotMatch(page, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(page, /question_bank\.typed_engine/);
});
