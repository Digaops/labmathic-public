import { parseBankPage, parseBankOptions } from './questionBankView.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const id = value => integer(value) && value > 0;
const text = value => typeof value === 'string';
export function readAuthorQuery(params) {
  const page = Number(params.get('author_page'));
  return { search: (params.get('author_search') || '').trim(), page: id(page) ? page : 1 };
}
export function authorSearchParams(previous, query) {
  const params = new URLSearchParams(previous);
  for (const key of ['author_search', 'author_page']) params.delete(key);
  if (query.search) params.set('author_search', query.search);
  if (query.page > 1) params.set('author_page', String(query.page));
  return params;
}
export function authorRequestPath(query) {
  const params = new URLSearchParams({ page: String(query.page), limit: '10' });
  if (query.search) params.set('search', query.search);
  return '/question-bank/author-questions?' + params;
}
export function parseAuthorPage(value) {
  parseBankPage(value);
  if (value.data.some(q => q.source !== 'teacher' || !id(q.created_by))) throw new Error('Autoria não confirmada.');
  return value;
}
export function emptyAuthorQuestion() {
  return { id: null, grade_id: '', unit_id: '', skill_id: '', statement: '', support_text: '', difficulty: 'media',
    official_explanation: '', development_space: 'none', image_path: null, remove_image: false,
    options: ['A','B','C','D'].map((label, i) => ({ option_label: label, option_text: '', is_correct: Number(i === 0) })) };
}
export function authorFormError(form) {
  if (!id(Number(form.skill_id))) return 'Selecione uma habilidade BNCC.';
  if (!form.statement.trim()) return 'Escreva o enunciado da questão.';
  if (form.statement.trim().length > 10000) return 'O enunciado pode ter até 10.000 caracteres.';
  if (form.options.length !== 4 || new Set(form.options.map(o => o.option_label)).size !== 4
    || form.options.some(o => !['A','B','C','D'].includes(o.option_label))) return 'A questão precisa das alternativas A, B, C e D.';
  const empty = form.options.find(o => !o.option_text.trim());
  if (empty) return `Preencha a alternativa ${empty.option_label}.`;
  if (form.options.filter(o => Number(o.is_correct) === 1).length !== 1) return 'Marque uma única resposta correta.';
  return '';
}
function difficulties(value) {
  return value && ['easy','medium','difficult'].every(key => integer(value[key]));
}
export function parseDiagnosticBootstrap(value) {
  parseBankOptions(value?.grades); parseBankOptions(value?.units);
  const limits = value?.limits;
  if (!limits || !id(limits.maxSkills) || limits.maxSkills > 100 || !id(limits.minQuestionsPerSkill)
    || !id(limits.maxQuestionsPerSkill) || limits.maxQuestionsPerSkill > 10 || limits.minQuestionsPerSkill > limits.maxQuestionsPerSkill
    || !id(limits.maxQuestions) || !Array.isArray(value?.skills)
    || value.skills.some(s => !s || !id(s.id) || !id(s.unitId) || !text(s.code) || !text(s.description) || !text(s.unitName)
      || !integer(s.candidateCount) || !difficulties(s.difficulties))) throw new Error('Disponibilidade de questões não confirmada.');
  return value;
}
export function parseDiagnosticResult(value) {
  if (!value || !id(value.id) || !text(value.title) || !id(value.grade?.id) || !text(value.grade?.name)
    || !id(value.questionCount) || value.isPrivate !== true || value.requiresTeacherReview !== true
    || !Array.isArray(value.composition) || !value.composition.length
    || value.composition.some(s => !s || !id(s.id) || !text(s.code) || !text(s.description) || !id(s.selectedCount) || !difficulties(s.difficulties)
      || (s.editorialPilotCount !== undefined && (!integer(s.editorialPilotCount) || s.editorialPilotCount > s.selectedCount)))
    || value.composition.reduce((sum, s) => sum + s.selectedCount, 0) !== value.questionCount) throw new Error('Diagnóstico não confirmado.');
  return value;
}
export function diagnosticSelection(skills, selectedIds, count) {
  const selected = skills.filter(s => selectedIds.includes(s.id));
  return { selected, insufficient: selected.filter(s => s.candidateCount < count), total: selectedIds.length * count,
    missing: selected.length !== selectedIds.length };
}
export function uncertainWrite(error) { return !error.response || error.response.status >= 500; }
