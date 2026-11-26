const text = v => typeof v === 'string' && v.length > 0;
const strings = v => Array.isArray(v) && v.every(text);
const optionalText = v => v == null || typeof v === 'string';
const id = v => typeof v === 'string' && /^[a-z0-9][a-z0-9_-]*$/i.test(v);
const fail = () => { throw Error('Não foi possível conferir os dados desta demonstração. Tente novamente.'); };
const unique = values => new Set(values).size === values.length;
export const demoTypes = ['single_choice', 'true_false', 'multiple_response', 'numeric', 'fill_blank', 'ordering', 'matching'];
export const demoViews = [
  { value: 'teacher', label: 'Visão do professor' },
  { value: 'before_submission', label: 'Estudante: antes de entregar' },
  { value: 'after_submission', label: 'Estudante: após entregar' },
  { value: 'assessment_closed', label: 'Estudante: avaliação encerrada' },
];
export const demoFilterKeys = ['search', 'interactionType', 'grade', 'unit', 'reviewStatus', 'source', 'hasCommentedSolution', 'printReady', 'diagnosticCompatible'];
export function demoFilters(params) {
  return Object.fromEntries(demoFilterKeys.map(k => [k, (params.get(k) || '').trim().slice(0, k === 'search' ? 80 : 120)]));
}
export function demoQuery(filters) { return new URLSearchParams(Object.entries(filters).filter(([, v]) => v !== '')).toString(); }
function envelope(v, mode) { if (v?.mode !== mode || v.readOnly !== true) fail(); }
function choices(v) { if (!Array.isArray(v) || !v.length || !unique(v.map(c => c.id)) || v.some(c => !id(c.id) || !text(c.text))) fail(); }
export function parseFormatCatalog(v) {
  envelope(v, 'preview');
  if (!Array.isArray(v.examples) || !unique(v.examples.map(e => e.id))) fail();
  for (const e of v.examples) {
    const d = e.definition;
    if (!id(e.id) || !text(e.typeLabel) || !text(e.pedagogicalPurpose) || !demoTypes.includes(e.type) || d?.interactionType !== e.type || !text(d.content?.stem) || !text(d.accessibility?.responseLabel) || !text(d.accessibility?.instructions) || d.print?.supported !== true || !text(d.print.instructions) || 'answerKey' in d) fail();
    if (![d.content.supportText, d.content.unit, d.accessibility.keyboardInstructions].every(optionalText)) fail();
    if (['single_choice', 'multiple_response'].includes(e.type)) choices(d.content.choices);
    if (e.type === 'ordering') choices(d.content.items);
    if (e.type === 'matching') { choices(d.content.leftItems); choices(d.content.rightItems); }
    if (e.type === 'fill_blank') {
      choices(d.content.blanks);
      if (!text(d.content.prompt)) fail();
      const tokens = [...d.content.prompt.matchAll(/\{\{([a-z][a-z0-9_-]*)\}\}/g)].map(m => m[1]);
      if (!tokens.length || tokens.some(t => !d.content.blanks.some(b => b.id === t))) fail();
    }
  }
  return v;
}
export function parseFeedbackCatalog(v) {
  envelope(v, 'feedback_preview');
  if (!Array.isArray(v.examples) || !unique(v.examples.map(e => e.id)) || v.examples.some(e => !id(e.id) || !text(e.title))) fail();
  return v;
}
export function parseFeedbackDetail(v, expectedId, view) {
  envelope(v, 'feedback_preview');
  const e = v.example, f = v.feedback;
  if (e?.id !== expectedId || v.view !== view || !text(e.title) || !text(e.question?.content?.stem) || typeof f?.available !== 'boolean') fail();
  if (![e.typeLabel, e.pedagogicalPurpose, e.releasePolicyLabel].every(text) || !['after_submission', 'after_assessment_close', 'teacher_only'].includes(e.releasePolicy) || ![e.question.content.supportText, e.question.content.unit].every(optionalText)) fail();
  if (e.question.content.choices) choices(e.question.content.choices);
  if (e.response !== null && !text(e.response?.display)) fail();
  if (view === 'before_submission' && (f.available || e.response !== null)) fail();
  if (!f.available) { if (!text(f.reason) || f.guide || f.evidence) fail(); }
  else {
    const g = f.guide;
    if (e.releasePolicy === 'teacher_only' && view !== 'teacher') fail();
    if (e.releasePolicy === 'after_assessment_close' && !['teacher', 'assessment_closed'].includes(view)) fail();
    if (!Number.isFinite(f.evidence?.score) || f.evidence.score < 0 || f.evidence.score > 1 || typeof f.evidence.isCorrect !== 'boolean') fail();
    if (!g || ![g.referenceAnswer, g.summary, g.misconception, g.nextStep].every(text) || !strings(g.resolutionSteps) || !g.resolutionSteps.length || !Array.isArray(g.choiceInsights) || g.choiceInsights.some(c => !text(c.choice) || !text(c.insight))) fail();
    if (view !== 'teacher' && g.choiceInsights.length) fail();
  }
  return v;
}
function itemSummary(item) {
  if (!id(item.id) || ![item.title, item.code, item.grade, item.unit, item.skillCode, item.interactionLabel, item.reviewStatusLabel].every(text) || !['ready', 'in_review', 'needs_attention'].includes(item.reviewStatus)) fail();
  if (![item.sourceLabel, item.correctionLabel].every(text) || ![item.hasCommentedSolution, item.printReady, item.diagnosticCompatible].every(v => typeof v === 'boolean')) fail();
}
export function parseReviewCatalog(v) {
  envelope(v, 'question_bank_catalog_preview');
  if (v.synthetic !== true || !Array.isArray(v.items) || !unique(v.items.map(i => i.id)) || v.total !== v.items.length) fail();
  v.items.forEach(itemSummary);
  for (const key of ['interactionTypes', 'reviewStatuses', 'sources']) if (!Array.isArray(v.filters?.[key]) || v.filters[key].some(o => !text(o.value) || !text(o.label))) fail();
  for (const key of ['grades', 'units']) if (!strings(v.filters?.[key])) fail();
  for (const key of ['ready', 'inReview', 'needsAttention']) if (!Number.isSafeInteger(v.summary?.[key]) || v.summary[key] < 0) fail();
  return v;
}
export function parseReviewDetail(v, expectedId) {
  envelope(v, 'question_bank_catalog_preview');
  if (v.synthetic !== true || v.item?.id !== expectedId) fail();
  const i = v.item; itemSummary(i);
  if (![i.statement, i.skillSummary, i.reviewerNote].every(text) || !optionalText(i.supportText) || !strings(i.choices) || !Array.isArray(i.criteria) || i.criteria.some(c => !id(c.id) || !text(c.label) || !text(c.evidence) || !['ready', 'attention'].includes(c.state))) fail();
  return v;
}
