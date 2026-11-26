const test = require('node:test'), assert = require('node:assert/strict');
const { getTypedQuestionPreviewCatalog: formats } = require('../src/services/typedQuestionPreview');
const { getFeedbackPreviewCatalog: feedback, getFeedbackPreviewExample: detail } = require('../src/services/typedQuestionFeedbackPreview');
const { getQuestionBankCatalogPreview: review, getQuestionBankCatalogPreviewItem: item } = require('../src/services/questionBankCatalogPreview');
let v; test.before(async () => { v = await import('../../client/src/services/demoView.mjs'); });
test('os sete formatos atuais são legíveis sem transportar gabarito', () => {
  const parsed = v.parseFormatCatalog(formats()); assert.equal(parsed.examples.length, 7);
  assert.equal(JSON.stringify(parsed).includes('answerKey'), false);
});
test('formatos incompletos, lacunas inválidas e gabarito indevido não são exibidos', () => {
  for (const mutate of [p => { p.examples[0].definition.content.choices = null; }, p => { p.examples[0].definition.answerKey = {}; }, p => { p.examples[4].definition.content.prompt = '{{ausente}}'; }, p => { p.readOnly = false; }]) {
    const p = structuredClone(formats()); mutate(p); assert.throws(() => v.parseFormatCatalog(p));
  }
  assert.equal(v.parseFormatCatalog({ ...formats(), examples: [] }).examples.length, 0);
});
test('todos os exemplos de devolutiva respeitam as quatro visões existentes', () => {
  for (const e of v.parseFeedbackCatalog(feedback()).examples) for (const { value } of v.demoViews) assert.equal(v.parseFeedbackDetail(detail(e.id, value), e.id, value).view, value);
});
test('devolutiva de outra seleção ou visão, incompleta ou liberada cedo demais é recusada', () => {
  const e = feedback().examples[0], p = detail(e.id, 'teacher');
  assert.throws(() => v.parseFeedbackDetail(p, 'outro', 'teacher'));
  assert.throws(() => v.parseFeedbackDetail(p, e.id, 'before_submission'));
  assert.throws(() => v.parseFeedbackDetail({ ...p, feedback: { available: true } }, e.id, 'teacher'));
  const blocked = detail(e.id, 'before_submission'); blocked.feedback.guide = p.feedback.guide;
  assert.throws(() => v.parseFeedbackDetail(blocked, e.id, 'before_submission'));
});
test('catálogo e fichas de revisão reais são validados, sem confundir vazio e erro', () => {
  const c = v.parseReviewCatalog(review()); assert.ok(c.total);
  for (const e of c.items) assert.equal(v.parseReviewDetail(item(e.id), e.id).item.id, e.id);
  assert.equal(v.parseReviewCatalog(review({ search: 'nada equivalente' })).total, 0);
  for (const invalid of [{}, { ...c, total: 99 }, { ...c, items: null }]) assert.throws(() => v.parseReviewCatalog(invalid));
});
test('ficha errada ou critérios incompletos não ficam disponíveis para impressão', () => {
  const e = review().items[0], d = item(e.id);
  assert.throws(() => v.parseReviewDetail(d, 'outro'));
  d.item.criteria = [{}]; assert.throws(() => v.parseReviewDetail(d, e.id));
});
test('consulta preserva somente os nove filtros e limita busca sem enviar seleção de ficha', () => {
  const p = new URLSearchParams('item=exemplo&turma=real&search= fração &printReady=false');
  assert.equal(v.demoQuery(v.demoFilters(p)), 'search=fra%C3%A7%C3%A3o&printReady=false');
  p.set('search', 'a'.repeat(100)); assert.equal(v.demoFilters(p).search.length, 80);
  assert.equal(Object.keys(v.demoFilters(p)).length, 9);
});
