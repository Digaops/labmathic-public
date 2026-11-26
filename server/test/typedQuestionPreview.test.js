const test = require('node:test');
const assert = require('node:assert/strict');

const { getTypedQuestionPreviewCatalog } = require('../src/services/typedQuestionPreview');

const EXPECTED_TYPES = [
  'single_choice',
  'true_false',
  'multiple_response',
  'numeric',
  'fill_blank',
  'ordering',
  'matching',
];

test('catálogo tipado compila sete exemplos sintéticos sem expor gabaritos', () => {
  const catalog = getTypedQuestionPreviewCatalog();
  const serialized = JSON.stringify(catalog);

  assert.equal(catalog.mode, 'preview');
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.catalogVersion, 1);
  assert.deepEqual(catalog.examples.map((example) => example.type), EXPECTED_TYPES);
  assert.equal(new Set(catalog.examples.map((example) => example.id)).size, 7);
  assert.doesNotMatch(serialized, /answerKey|acceptedAnswers|orderedItemIds|choiceFeedback/);
  assert.doesNotMatch(serialized, /definitionHash|definitionJson/);
});

test('todo formato demonstra acessibilidade, correção determinística e impressão equivalente', () => {
  const { examples } = getTypedQuestionPreviewCatalog();
  for (const example of examples) {
    assert.equal(example.correctionMode, 'automatic');
    assert.equal(example.accessibilityReady, true);
    assert.equal(example.printSupported, true);
    assert.equal(example.definition.print.supported, true);
    assert.ok(example.definition.print.instructions.length >= 2);
    assert.ok(example.definition.accessibility.responseLabel.length >= 2);
    assert.ok(example.definition.accessibility.instructions.length >= 2);
    assert.ok(example.pedagogicalPurpose.length >= 20);
    assert.equal(example.definition.interactionType, example.type);
  }

  for (const type of ['ordering', 'matching']) {
    const example = examples.find((item) => item.type === type);
    assert.ok(example.definition.accessibility.keyboardInstructions);
    assert.ok(example.definition.print.answerSpaceLines >= 1);
  }
});
