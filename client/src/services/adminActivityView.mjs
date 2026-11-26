import { dateOnly } from './adminReportsView.mjs';
export const periods = { '30d': 'Últimos 30 dias', '7d': 'Últimos 7 dias', today: 'Hoje', month: 'Este mês', custom: 'Escolher datas', all: 'Todo o histórico' };
export const activityModules = { auth: 'Entradas e senhas', materials: 'Materiais', question_bank: 'Banco de questões', question_sets: 'Simulados', users: 'Usuários', collections: 'Laboratórios', favorites: 'Favoritos', comments: 'Comentários', ratings: 'Avaliações', admin: 'Administração', support: 'Fale Conosco', classes: 'Turmas', preferences: 'Preferências', planning: 'Planejamento', institutions: 'Instituições', governance: 'Controle de publicação' };
export const activityActions = {
  create_category: 'Categoria criada', update_category: 'Categoria atualizada', delete_category: 'Categoria excluída',
  "login": "Entrada no sistema",
  "login_failed": "Tentativa de entrada sem sucesso",
  "password_reset_requested": "Solicitação de recuperação",
  "password_reset_completed": "Senha redefinida",
  "create_material": "Material criado",
  "update_material": "Material atualizado",
  "delete_material": "Material excluído",
  "bulk_delete_materials": "Exclusão em massa",
  "create_question": "Questão criada",
  "create_teacher_question": "Questão autoral criada",
  "update_teacher_question": "Questão autoral atualizada",
  "delete_teacher_question": "Questão autoral excluída",
  "update_question": "Questão atualizada",
  "update_question_status": "Status da questão",
  "update_question_review": "Revisão da questão",
  "delete_question": "Questão desativada",
  "create_question_set": "Simulado criado",
  "update_question_set": "Simulado atualizado",
  "delete_question_set": "Simulado excluído",
  "create_user": "Usuário criado",
  "update_user": "Usuário atualizado",
  "reset_user_password": "Senha de usuário redefinida",
  "delete_user": "Usuário excluído",
  "create_collection": "Laboratório criado",
  "update_collection": "Laboratório atualizado",
  "delete_collection": "Laboratório excluído",
  "send_support_message": "Mensagem enviada à administração",
  "reply_support_message": "Resposta enviada ao professor"
};
export const emptyActivityFilters = () => ({ period: '30d', module: '', action: '', user_id: '', user_role: '', critical_only: false, search: '', date_from: '', date_to: '' });
export function activityFilterIssue(form) {
  if (!Object.hasOwn(periods, form.period)) return ['period', 'Escolha um período.'];
  if (form.search.length > 200) return ['search', 'Use até 200 caracteres na busca.'];
  if (form.period === 'custom') {
    if (!dateOnly(form.date_from)) return ['date_from', 'Informe a data inicial.'];
    if (!dateOnly(form.date_to)) return ['date_to', 'Informe a data final.'];
    if (form.date_to < form.date_from) return ['date_to', 'A data final deve ser igual ou posterior à inicial.'];
  }
  return null;
}
export function activityParams(form, now = new Date()) {
  if (activityFilterIssue(form)) throw Error('Filtros inválidos');
  const params = new URLSearchParams();
  for (const key of ['module', 'action', 'user_id', 'user_role', 'search']) if (form[key].trim()) params.set(key, form[key].trim());
  if (form.critical_only) params.set('critical_only', '1');
  if (form.period !== 'all') {
    const start = form.period === 'custom' ? new Date(form.date_from + 'T00:00:00') : new Date(now);
    const end = form.period === 'custom' ? new Date(form.date_to + 'T00:00:00') : new Date(now);
    start.setHours(0, 0, 0, 0); end.setHours(0, 0, 0, 0); end.setDate(end.getDate() + 1);
    if (form.period === '7d') start.setDate(start.getDate() - 6);
    if (form.period === '30d') start.setDate(start.getDate() - 29);
    if (form.period === 'month') start.setDate(1);
    params.set('date_from', start.toISOString()); params.set('date_before', end.toISOString());
  }
  params.set('limit', '20'); return params.toString();
}
export function activityList(data, page, snapshot) {
  const p = data?.pagination;
  if (!Array.isArray(data?.data) || !p || p.page !== page || p.limit !== 20 || !Number.isSafeInteger(p.total) || p.total < 0 || !Number.isSafeInteger(p.totalPages) || p.totalPages !== Math.max(1, Math.ceil(p.total / 20)) || !Number.isSafeInteger(data.snapshot_id) || data.snapshot_id < 0 || (snapshot !== null && data.snapshot_id !== snapshot) || data.data.length > 20) throw Error('Histórico inválido');
  if (new Set(data.data.map(i => i.id)).size !== data.data.length) throw Error('Registros repetidos');
  for (const item of data.data) {
    if (!Number.isSafeInteger(item.id) || item.id < 1 || item.id > data.snapshot_id || typeof item.action !== 'string' || !(item.created_at == null || typeof item.created_at === 'string') || !(item.metadata == null || typeof item.metadata === 'object') || ![0, 1, null, undefined].includes(item.is_critical)) throw Error('Registro inválido');
    for (const field of ['description', 'entity_title', 'user_name', 'user_email', 'user_role', 'module']) if (!(item[field] == null || typeof item[field] === 'string')) throw Error('Texto inválido');
  }
  return data;
}
export { eventTime as activityTime } from './eventDates.mjs';
