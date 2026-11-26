const test = require('node:test');
const assert = require('node:assert/strict');

const {
  QuestionBankCatalogPreviewError,
  getQuestionBankCatalogPreview,
  getQuestionBankCatalogPreviewItem,
} = require('../src/services/questionBankCatalogPreview');

const FORBIDDEN = /"(?:answerKey|isCorrect|student|response|email|password|definitionJson)"\s*:/;

test('catálogo sintético reúne seis itens sem gabarito, estudante ou resposta', () => {
  const catalog = getQuestionBankCatalogPreview();
  assert.equal(catalog.mode, 'question_bank_catalog_preview');
  assert.equal(catalog.synthetic, true);
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.total, 6);
  assert.deepEqual(catalog.summary, { ready: 2, inReview: 2, needsAttention: 2 });
  assert.doesNotMatch(JSON.stringify(catalog), FORBIDDEN);
});

test('filtros combinados são determinísticos e aplicados no servidor', () => {
  const filtered = getQuestionBankCatalogPreview({
    grade: '5º ano',
    unit: 'Números',
    source: 'official',
    hasCommentedSolution: 'true',
    printReady: 'true',
    diagnosticCompatible: 'true',
  });
  assert.equal(filtered.total, 1);
  assert.equal(filtered.items[0].id, 'fraction-equivalence-review');

  const search = getQuestionBankCatalogPreview({ search: 'EF05MA20' });
  assert.equal(search.total, 1);
  assert.equal(search.items[0].id, 'square-perimeter-review');

  const attention = getQuestionBankCatalogPreview({ reviewStatus: 'needs_attention' });
  assert.equal(attention.total, 2);
  assert.equal(attention.items.every((item) => item.criteriaSummary.attention > 0), true);
});

test('dossiê explica critérios sem criar nota agregada ou diagnóstico automático', () => {
  const detail = getQuestionBankCatalogPreviewItem('fraction-ordering-review');
  assert.equal(detail.item.criteria.length, 7);
  assert.equal(detail.item.criteria.some((criterion) => criterion.state === 'attention'), true);
  assert.equal(detail.item.hasCommentedSolution, false);
  assert.equal(detail.item.diagnosticCompatible, false);
  assert.equal(Object.hasOwn(detail.item, 'qualityScore'), false);
  assert.doesNotMatch(JSON.stringify(detail), FORBIDDEN);
});

test('consulta estrita recusa filtros ambíguos, desconhecidos e itens ausentes', () => {
  assert.throws(
    () => getQuestionBankCatalogPreview({ reviewStatus: 'invented' }),
    (error) => error instanceof QuestionBankCatalogPreviewError
      && error.code === 'invalid_filter',
  );
  assert.throws(
    () => getQuestionBankCatalogPreview({ page: '1' }),
    (error) => error instanceof QuestionBankCatalogPreviewError
      && error.code === 'unknown_filter',
  );
  assert.throws(
    () => getQuestionBankCatalogPreview({ grade: ['4º ano', '5º ano'] }),
    (error) => error instanceof QuestionBankCatalogPreviewError
      && error.code === 'invalid_filter',
  );
  assert.throws(
    () => getQuestionBankCatalogPreviewItem('missing'),
    (error) => error instanceof QuestionBankCatalogPreviewError
      && error.code === 'catalog_preview_item_not_found'
      && error.status === 404,
  );
});
