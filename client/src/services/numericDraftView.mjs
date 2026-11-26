const id = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string';
const publicId = value => text(value) && /^[a-f0-9-]{36}$/i.test(value);
function invalid() { throw new Error('Não foi possível conferir os dados do rascunho.'); }
export function parseNumericDraft(value) {
  const c = value?.curriculum;
  if (!value || !publicId(value.publicId) || !id(value.revision) || !['draft','approved'].includes(value.status)
    || !text(value.code) || !text(value.statement) || !value.statement.trim() || value.statement.length > 10000
    || !['facil','media','dificil'].includes(value.difficulty) || !c
    || !['skillId','gradeId','unitId'].every(key => id(c[key]))
    || !['skillCode','skillDescription','gradeName','unitName'].every(key => text(c[key]))) invalid();
  if ('answer' in value && (value.strategy !== 'numeric_exact' || !validDecimal(value.answer)
    || !['supportText','unit','explanation'].every(key => text(value[key])))) invalid();
  if (value.review != null) parseNumericReviewState(value.review);
  if (value.version != null && !id(value.version)) invalid();
  if (value.versions != null && (!Array.isArray(value.versions) || value.versions.length > 50
    || value.versions.some(v => !publicId(v.publicId) || !id(v.version) || !['draft','approved'].includes(v.status)))) invalid();
  if (value.reviews != null) { if (!Array.isArray(value.reviews) || value.reviews.length > 50) invalid(); value.reviews.forEach(parseNumericReviewState); }
  return value;
}
export const numericStatusLabels = { draft:'Rascunho', pending:'Aguardando revisão', approved:'Aprovada', rejected:'Ajustes solicitados', cancelled:'Envio retirado' };
export const canEditNumeric = d => d?.status === 'draft' && d.review?.status !== 'pending';
export function parseNumericReviewState(r) {
  if (!r || !publicId(r.publicId) || !id(r.revision) || !['pending','approved','rejected','cancelled'].includes(r.status)
    || (r.reason != null && (!text(r.reason) || r.reason.length > 1000))) invalid();
  return r;
}
export function parseNumericReview(value) {
  parseNumericReviewState(value); parseNumericDetail(value.draft);
  if (!text(value.authorName) || !publicId(value.versionPublicId) || value.draft.publicId !== value.versionPublicId) invalid();
  return value;
}
export function parseNumericReviewPage(value) {
  const p=value?.pagination;
  if (!Array.isArray(value?.data)||value.data.length>10||!p||!id(p.page)||!Number.isSafeInteger(p.total)||p.total<0||p.totalPages!==Math.ceil(p.total/10)) invalid();
  value.data.forEach(r=>{parseNumericReviewState(r);if(!text(r.authorName)||!text(r.statement)||!text(r.skillCode))invalid();});
  return value;
}
export function parseNumericDetail(value) {
  parseNumericDraft(value);
  if (!Object.hasOwn(value, 'answer')) invalid();
  return value;
}
export function parseNumericPreview(value, expectedId, expectedRevision) {
  if (value?.kind !== 'numeric-draft-preview-v1' || typeof value.fingerprint !== 'string'
    || !/^[a-f0-9]{64}$/.test(value.fingerprint)) invalid();
  const draft = parseNumericDetail(value.draft);
  if (draft.publicId !== expectedId || draft.revision !== expectedRevision) invalid();
  return value;
}
export const numericReviewQuestions = [
  'A pergunta trabalha a habilidade e o ano escolar escolhidos?',
  'O enunciado traz todos os dados e deixa claro o que calcular?',
  'O gabarito e a unidade estão corretos? A resposta é exata, sem precisar arredondar?',
];
export function parseNumericPage(value) {
  const p = value?.pagination;
  if (!Array.isArray(value?.data) || value.data.length > 10 || !p || !id(p.page)
    || !Number.isSafeInteger(p.total) || p.total < 0 || p.totalPages !== Math.ceil(p.total / 10)) invalid();
  value.data.forEach(parseNumericDraft);
  if (new Set(value.data.map(row => row.publicId)).size !== value.data.length) invalid();
  return value;
}
export function validDecimal(value) { return text(value) && /^[+-]?(?:\d{1,9}(?:[.,]\d{1,6})?|[.,]\d{1,6})$/.test(value.trim()); }
export const decimalHint = 'Use vírgula ou ponto decimal, sem separador de milhar. Até 9 algarismos antes e 6 depois da vírgula.';
export function emptyNumericDraft() {
  return { gradeId: '', unitId: '', skillId: '', statement: '', supportText: '', unit: '', answer: '', explanation: '', difficulty: 'media' };
}
export function numericForm(saved) {
  parseNumericDetail(saved);
  return { ...emptyNumericDraft(), ...Object.fromEntries(['statement','supportText','unit','answer','explanation','difficulty'].map(key => [key, saved[key]])),
    ...Object.fromEntries(['gradeId','unitId','skillId'].map(key => [key, String(saved.curriculum[key])])) };
}
export function numericPayload(form, saved) {
  if (!form.statement.trim()) throw new Error('Escreva o enunciado.');
  if (!validDecimal(form.answer)) throw new Error('Confira a resposta esperada. ' + decimalHint);
  const payload = { ...form, ...Object.fromEntries(['gradeId','unitId','skillId'].map(key => [key, Number(form[key])])) };
  if (!['gradeId','unitId','skillId'].every(key => id(payload[key]))) throw new Error('Selecione o ano escolar, a unidade temática e a habilidade.');
  if (saved) payload.expectedRevision = saved.revision;
  return payload;
}
