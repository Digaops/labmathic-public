const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
export const bankFilterKeys = ['grade_id', 'unit_id', 'skill_id', 'difficulty', 'status'];
export function readBankQuery(params, isAdmin = false) {
  const query = Object.fromEntries(bankFilterKeys.map(key => [key, '']));
  for (const key of ['grade_id','unit_id','skill_id']) if (positive(params.get(key))) query[key] = String(Number(params.get(key)));
  if (!isAdmin && (params.get('grade_id') === 'mine' || params.get('my_grades') === '1')) query.grade_id = 'mine';
  if (['facil','media','dificil'].includes(params.get('difficulty'))) query.difficulty = params.get('difficulty');
  if (isAdmin && ['active','inactive'].includes(params.get('status'))) query.status = params.get('status');
  return { ...query, search: (params.get('search') || '').trim(), page: positive(params.get('page')) ? Number(params.get('page')) : 1 };
}
export function bankSearchParams(previous, query) {
  const params = new URLSearchParams(previous);
  for (const key of [...bankFilterKeys, 'search', 'page', 'my_grades']) params.delete(key);
  for (const key of [...bankFilterKeys, 'search']) if (query[key]) params.set(key, query[key]);
  if (query.page > 1) params.set('page', String(query.page));
  return params;
}
export function bankRequestPath(query) {
  const params = bankSearchParams('', query);
  if (params.get('grade_id') === 'mine') { params.delete('grade_id'); params.set('my_grades','1'); }
  params.set('page', String(query.page)); params.set('limit','10');
  return '/question-bank/questions?' + params;
}
export function parseBankOptions(value) {
  if (!Array.isArray(value) || value.some(v => !v || !positive(v.id) || typeof v.name !== 'string')) throw new Error('Opções não confirmadas.');
  return value;
}
export function parseBankSkills(value) {
  if (!Array.isArray(value) || value.some(v => !v || !positive(v.id) || typeof v.code !== 'string' || typeof v.description !== 'string')) throw new Error('Habilidades não confirmadas.');
  return value;
}
export function parseBankQuestion(q) {
  if (!q || !positive(q.id) || typeof q.question_code !== 'string' || typeof q.statement !== 'string'
    || !positive(q.skill_id) || !['active','inactive'].includes(q.status) || !['facil','media','dificil'].includes(q.difficulty)
    || (q.support_text != null && typeof q.support_text !== 'string') || (q.image_path != null && typeof q.image_path !== 'string')
    || !Array.isArray(q.options) || !q.options.length || q.options.some(o => !o || typeof o.option_label !== 'string' || typeof o.option_text !== 'string')) throw new Error('Questão não confirmada.');
  return q;
}
export function parseBankPage(value) {
  const p = value?.pagination;
  if (!Array.isArray(value?.data) || !p || !positive(p.page) || !positive(p.limit) || !count(p.total) || !count(p.totalPages)
    || p.totalPages !== Math.ceil(p.total / p.limit) || value.data.length !== Math.min(p.limit, Math.max(0, p.total - (p.page - 1) * p.limit))) throw new Error('Consulta de questões incompleta.');
  value.data.forEach(parseBankQuestion); return value;
}
