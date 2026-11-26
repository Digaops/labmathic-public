export const aiReviewChecks = {
  math: 'Conferi os cálculos, as alternativas e a resposta correta.',
  clarity: 'A pergunta está clara e adequada aos estudantes.',
  curriculum: 'A questão trabalha a habilidade e o ano escolar escolhidos.',
};
export function aiInput(form, mode = form.statement?.trim() ? 'complement' : 'new_question', academicYear = new Date().getFullYear()) {
  return { mode, gradeId: Number(form.grade_id) || '', unitId: Number(form.unit_id) || '',
    skillIds: form.skill_id ? [Number(form.skill_id)] : [], academicYear,
    teacherText: form.statement || '', privacyConfirmed: false };
}
export function aiToEditor(original, result) {
  parseAiRequest(result);
  const q = result?.suggestion, b = result?.brief;
  if (result?.reviewed !== true || result.status !== 'succeeded' || !q || !b || q.skillIds?.length !== 1
    || q.skillIds[0] !== b.skills?.[0]?.id || q.gradeId !== b.grade.id || q.unitId !== b.unit.id
    || !Array.isArray(q.options) || q.options.length !== 4 || q.options.filter(o => o.correct === true).length !== 1) throw new Error('Revisão não confirmada.');
  return { ...original, grade_id: String(q.gradeId), unit_id: String(q.unitId), skill_id: String(q.skillIds[0]),
    statement: q.statement, official_explanation: q.explanation, ai_request_id: result.id,
    options: q.options.map((o, i) => ({ option_label: 'ABCD'[i], option_text: o.text, is_correct: Number(o.correct) })) };
}

const positive = n => Number.isSafeInteger(n) && n > 0;
const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const text = (value, max = 6000) => typeof value === 'string' && value.trim().length > 0 && value.length <= max;
const validYear = n => Number.isInteger(n) && n >= 2000 && n <= 2100;
const invalid = () => { throw new Error('Resposta da ajuda de IA não confirmada.'); };
export function parseAiRequest(value, expected = {}) {
  const b = value?.brief, q = value?.suggestion;
  if (!uuid(value?.id) || !uuid(value?.requestKey) || typeof value.reviewed !== 'boolean' || !positive(value.createdAt)
    || !text(value.model, 100) || !['processing','succeeded','failed','cancelled','expired'].includes(value.status)
    || (expected.id && expected.id !== value.id) || (expected.key && expected.key !== value.requestKey)
    || !b || b.version !== 1 || b.requiresTeacherReview !== true || b.status !== 'prepared_not_generated'
    || !['new_question','complement'].includes(b.mode) || !positive(b.grade?.id) || !text(b.grade?.name,200)
    || !positive(b.unit?.id) || !text(b.unit?.name,200) || !validYear(b.academicYear)
    || typeof b.teacherText !== 'string' || b.teacherText.length > 4000 || !Array.isArray(b.skills) || b.skills.length !== 1
    || !positive(b.skills[0]?.id) || !/^EF\d{2}MA\d{2}$/.test(b.skills[0]?.code || '') || !text(b.skills[0]?.description,12000)) invalid();
  if (value.status !== 'succeeded') {
    if (q !== null || value.reviewed) invalid();
    return value;
  }
  if (!q || q.status !== 'awaiting_teacher_review' || q.reviewed !== false || q.publishable !== false
    || !text(q.statement) || !text(q.explanation) || q.gradeId !== b.grade.id || q.unitId !== b.unit.id
    || q.academicYear !== b.academicYear || !Array.isArray(q.skillIds) || q.skillIds.length !== 1 || q.skillIds[0] !== b.skills[0].id
    || !Array.isArray(q.options) || q.options.length !== 4 || q.options.some(o => !text(o?.text) || typeof o.correct !== 'boolean')
    || q.options.filter(o => o.correct).length !== 1 || new Set(q.options.map(o => o.text.trim().toLocaleLowerCase('pt-BR'))).size !== 4) invalid();
  return value;
}
export function parseAiBootstrap(value) {
  const c = value?.curriculum;
  if (typeof value?.available !== 'boolean' || value.maxSkills !== 1 || value.dailyLimit !== 5 || !c
    || !['grades','units','skills'].every(key => Array.isArray(c[key]) && c[key].length <= 10000
      && new Set(c[key].map(row => row.id)).size === c[key].length)
    || [...c.grades, ...c.units].some(row => !positive(row.id) || !text(row.name,200))
    || c.skills.some(s => !positive(s.id) || !/^EF\d{2}MA\d{2}$/.test(s.code || '') || !text(s.description,12000)
      || !c.grades.some(g => g.id === s.grade_id) || !c.units.some(u => u.id === s.unit_id))) invalid();
  if (value.latest !== null) parseAiRequest(value.latest);
  return value;
}
export function editAiInput(input, patch) {
  // Consent refers to the exact educational request being sent, not to later edits.
  return { ...input, ...patch, privacyConfirmed: Object.keys(patch).length === 1 && Object.hasOwn(patch, 'privacyConfirmed')
    ? patch.privacyConfirmed === true : false };
}
export function aiBriefError(input, catalog) {
  if (!validYear(input.academicYear)) return 'Informe um ano letivo entre 2000 e 2100.';
  if (!['new_question','complement'].includes(input.mode) || input.skillIds.length !== 1
    || !catalog?.curriculum.skills.some(s => s.id === input.skillIds[0] && s.grade_id === input.gradeId && s.unit_id === input.unitId)) return 'Escolha o ano escolar, a unidade e a habilidade.';
  if (input.teacherText.length > 4000 || (input.mode === 'complement' && !input.teacherText.trim())) return 'Revise o texto do pedido. Para melhorar um texto, ele precisa estar preenchido e ter até 4.000 caracteres.';
  if (input.privacyConfirmed !== true) return 'Confira o pedido e confirme que ele não contém dados pessoais.';
  return '';
}
export function aiStatusText(result) {
  return { processing: 'A sugestão ainda está sendo preparada. Consulte o pedido para acompanhar.',
    cancelled: 'Pedido interrompido. Seu texto original não foi alterado.',
    expired: 'O pedido não foi concluído a tempo. Nenhuma nova geração foi feita automaticamente.',
    failed: result?.failureCode === 'suggestion_refused' ? 'A IA não pôde atender a esse pedido. Revise o tema e as orientações.'
      : 'Não recebemos uma sugestão válida. Seu texto foi preservado; não repetimos a geração automaticamente.' }[result?.status] || '';
}
