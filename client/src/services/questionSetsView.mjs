import { parseBankQuestion } from './questionBankView.mjs';

const count = value => Number.isSafeInteger(value) && value >= 0;
const id = value => count(value) && value > 0;
const flag = value => value === 0 || value === 1 || typeof value === 'boolean';
const positiveParam = value => /^\d+$/.test(value || '') && id(Number(value));

export function readSetQuery(params) {
  return { search: (params.get('set_search') || '').trim(), page: positiveParam(params.get('set_page')) ? Number(params.get('set_page')) : 1 };
}
export function setSearchParams(previous, query) {
  const params = new URLSearchParams(previous);
  params.delete('set_search'); params.delete('set_page');
  if (query.search) params.set('set_search', query.search);
  if (query.page > 1) params.set('set_page', String(query.page));
  return params;
}
export function setRequestPath(query) {
  const params = new URLSearchParams({ page: String(query.page), limit: '10' });
  if (query.search) params.set('search', query.search);
  return '/question-bank/question-sets?' + params;
}
export function setNavigationUrl(path, source) {
  const params = new URLSearchParams();
  for (const key of ['set_search', 'set_page', 'turma']) if (source.get(key)) params.set(key, source.get(key));
  return path + (params.size ? '?' + params : '');
}
function parseSet(value) {
  if (!value || !id(value.id) || !id(value.user_id) || typeof value.title !== 'string'
    || !flag(value.is_public) || !flag(value.is_diagnostic) || !flag(value.diagnostic_reviewed)
    || (value.description != null && typeof value.description !== 'string')) throw new Error('Simulado não confirmado.');
  return value;
}
export function parseSetPage(value) {
  const p = value?.pagination;
  if (!Array.isArray(value?.data) || !p || !id(p.page) || !id(p.limit) || !count(p.total) || !count(p.totalPages)
    || p.totalPages !== Math.ceil(p.total / p.limit) || value.data.length !== Math.min(p.limit, Math.max(0, p.total - (p.page - 1) * p.limit))) throw new Error('Lista de simulados incompleta.');
  value.data.forEach(s => {
    parseSet(s);
    if (!count(s.question_count) || !count(s.author_question_count)) throw new Error('Quantidade de questões não confirmada.');
  });
  return value;
}
export function parseSetDetail(value) {
  parseSet(value);
  if (!Array.isArray(value.questions) || new Set(value.questions.map(q => q?.id)).size !== value.questions.length) throw new Error('Questões não confirmadas.');
  value.questions.forEach(q => {
    parseBankQuestion(q);
    if (!flag(q.show_image) || q.options.length !== 4 || new Set(q.options.map(o => o.option_label)).size !== 4
      || q.options.some(o => !['A', 'B', 'C', 'D'].includes(o.option_label) || !flag(o.is_correct))
      || q.options.filter(o => Number(o.is_correct) === 1).length !== 1) throw new Error('Gabarito não confirmado.');
  });
  return value;
}
export function setPermissions(set, user) {
  const owner = Number(set.user_id) === Number(user?.id);
  return { canEdit: owner || user?.role === 'admin', canReview: owner && user?.role === 'professor' && Boolean(set.is_diagnostic) && !set.diagnostic_reviewed };
}
// This only guides navigation; preparation and creation revalidate access on the server.
export function setApplication(set, user, { classesEnabled = false, assignmentsEnabled = false, locked = true } = {}) {
  const visible = user?.role === 'professor' && classesEnabled === true && assignmentsEnabled === true;
  if (!visible) return { visible: false, ready: false, reason: '' };
  let reason = '';
  if (locked || !id(set?.id) || !Array.isArray(set?.questions)) reason = 'Aguarde a confirmação dos dados do simulado.';
  else if (Number(set.user_id) !== Number(user.id) && !(Number(set.is_public) === 1 && (set.contains_author_questions === 0 || set.contains_author_questions === false))) reason = 'Este simulado não está disponível para aplicação pela sua conta.';
  else if (!set.questions.length) reason = 'Monte um simulado com questões para preparar a aplicação.';
  else if (set.questions.length > 100) reason = 'A aplicação aceita até 100 questões. Monte um simulado menor para continuar.';
  else if (set.is_diagnostic && !set.diagnostic_reviewed) reason = Number(set.user_id) === Number(user.id)
    ? 'Confira as questões e confirme a revisão ao final desta página para liberar a aplicação.'
    : 'Este diagnóstico aguarda a revisão do professor responsável.';
  return { visible, ready: !reason, reason };
}
export function setApplicationUrl(setId, classId) {
  if (!id(setId)) return null;
  const params = new URLSearchParams({ secao: 'avaliacoes', simulado: String(setId) });
  if (typeof classId === 'string' && /^[\w-]{1,80}$/.test(classId)) params.set('turma', classId);
  return '/turmas?' + params;
}
export function predominantDifficulty(questions) {
  const levels = ['facil', 'media', 'dificil'].map(key => ({ key, count: questions.filter(q => q.difficulty === key).length }));
  levels.sort((a, b) => b.count - a.count);
  return levels[0]?.count ? levels[0].key : null;
}
export function confirmedImage(value, setId, questionId, desired) {
  if (value?.question_set_id !== setId || value?.question_id !== questionId || Number(value?.show_image) !== desired || !flag(value.show_image)) throw new Error('Imagem não confirmada.');
  return value;
}
export function confirmedReview(value, setId, userId) {
  if (value?.questionSetId !== setId || value?.reviewed !== true || value?.reviewedBy !== userId
    || typeof value.reviewedAt !== 'string' || !value.reviewedAt || value.confirmationVersion !== 'teacher-review-v1') throw new Error('Revisão não confirmada.');
  return value;
}
