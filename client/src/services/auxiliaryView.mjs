export const normalizedClassCode = value => String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const formatClassCode = value => normalizedClassCode(value).match(/.{1,4}/g)?.join('-') || '';
export function joinProblem(form) {
  if (normalizedClassCode(form.code).length !== 16) return 'Confira o código: ele tem 16 letras e números.';
  if (!form.displayName.trim() || form.displayName.trim().length > 120) return 'Informe seu nome usado na chamada, com até 120 caracteres.';
  return '';
}
export function parseClassJoin(data) {
  if (data?.joined !== true || typeof data.alreadyJoined !== 'boolean' || ['className', 'teacherName', 'message'].some(k => typeof data[k] !== 'string' || !data[k].trim())) throw new Error('Entrada não confirmada.');
  return data;
}
const positiveId = value => typeof value !== 'boolean' && /^[1-9]\d*$/.test(String(value)) && Number.isSafeInteger(Number(value));
export function notificationPath(notification) {
  let data = notification.data;
  if (typeof data === 'string') { try { data = JSON.parse(data); } catch { data = {}; } }
  data ||= {};
  if (notification.type === 'new_material' && positiveId(data.material_id)) return `/material/${data.material_id}`;
  if (['new_public_question_set', 'teacher_question_set_created'].includes(notification.type) && positiveId(data.question_set_id)) return `/simulados/${data.question_set_id}`;
  if (notification.type === 'teacher_question_created') return '/banco-questoes?tab=author';
  if (['support_message', 'support_reply'].includes(notification.type)) return positiveId(data.support_thread_id) ? `/fale-conosco?thread=${data.support_thread_id}` : '/fale-conosco';
  return null;
}
export function parseNotifications(data, userId) {
  if (!Array.isArray(data?.notifications) || !Number.isInteger(data.unreadCount) || data.unreadCount < 0 || !Number.isInteger(data.supportUnreadCount) || data.supportUnreadCount < 0 || data.supportUnreadCount > data.unreadCount) throw new Error('Avisos não confirmados.');
  const seen = new Set();
  for (const n of data.notifications) {
    if (!positiveId(n?.id) || seen.has(n.id) || n.user_id !== userId || ![0, 1].includes(n.read) || typeof n.title !== 'string' || typeof n.type !== 'string' || typeof n.created_at !== 'string' || (n.message != null && typeof n.message !== 'string')) throw new Error('Aviso inválido.');
    seen.add(n.id);
  }
  return data;
}
export function announcementPath(value) {
  return ['/banco-questoes?tab=author', '/banco-questoes?tab=author&create=1', '/fale-conosco', '/biblioteca', '/simulados', '/turmas', '/planejamento', '/recomposicao', '/instituicoes', '/banco-questoes', '/banco-questoes/formatos', '/banco-questoes/devolutivas', '/banco-questoes/revisao'].includes(value) ? value : null;
}
export function parseAnnouncement(data) {
  if (!data || !positiveId(data.id) || typeof data.title !== 'string' || typeof data.payload?.intro !== 'string' || !Array.isArray(data.payload.features) || !Number.isInteger(data.maxImpressions) || data.maxImpressions < 1) throw new Error('Novidade não confirmada.');
  const keys = new Set();
  for (const f of data.payload.features) {
    if (!f || keys.has(f.key) || ['key', 'title', 'description', 'actionLabel', 'actionPath'].some(k => typeof f[k] !== 'string') || !announcementPath(f.actionPath)) throw new Error('Ação de novidade inválida.');
    keys.add(f.key);
  }
  return data;
}
export function parseImpression(data, expectedId) {
  const a = parseAnnouncement(data?.announcement);
  if (Number(a.id) !== Number(expectedId) || !Number.isInteger(data.impressions) || data.impressions < 1 || !Number.isInteger(data.remaining) || data.remaining !== Math.max(0, a.maxImpressions - data.impressions)) throw new Error('Exibição não confirmada.');
  return a;
}
