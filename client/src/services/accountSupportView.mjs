const text = v => typeof v === 'string' && v.trim().length > 0;
const id = v => Number.isSafeInteger(v) && v > 0;
const count = v => Number.isSafeInteger(v) && v >= 0;
const fail = () => { throw Error('Não foi possível conferir a resposta do servidor.'); };
export const supportSubjects = ['Sugestão', 'Dúvida sobre o sistema', 'Solicitação de conteúdo', 'Problema técnico', 'Outro assunto'];
export const sameIds = (a, b) => a.length === b.length && [...a].sort((x, y) => x - y).every((v, i) => v === [...b].sort((x, y) => x - y)[i]);
export function parsePreferences(v) {
  if (!Array.isArray(v?.grades) || !Array.isArray(v.selectedGradeIds) || !count(v.revision)
    || !['all', 'selected'].includes(v.selectionMode) || new Set(v.grades.map(g => g?.id)).size !== v.grades.length
    || v.grades.some(g => !id(g?.id) || !text(g.name)) || new Set(v.selectedGradeIds).size !== v.selectedGradeIds.length
    || v.selectedGradeIds.some(i => !id(i) || !v.grades.some(g => g.id === i))
    || (v.selectedGradeIds.length === 0) !== (v.selectionMode === 'all')) fail();
  return v;
}
export function parseAccount(v, expected) {
  if (v?.id !== expected.id || v.role !== expected.role || !text(v.name) || !text(v.email)) fail();
  return v;
}
export function parsePasswordChange(v) { if (!text(v?.token)) fail(); return v.token; }
export function requestError(e, fallback) { return typeof e?.response?.data?.error === 'string' ? e.response.data.error : fallback; }
export const uncertainWrite = e => !e?.response?.status || e.response.status >= 500;
function threadSummary(t, admin = false) {
  if (!id(t?.id) || !id(t.professor_id) || !text(t.subject) || !['open', 'closed'].includes(t.status)) fail();
  if (admin && (!text(t.professor_name) || !text(t.professor_email))) fail();
  return t;
}
export function parseSupportList(v, user) {
  if (!Array.isArray(v?.threads) || new Set(v.threads.map(t => t?.id)).size !== v.threads.length) fail();
  v.threads.forEach(t => { threadSummary(t, user.role === 'admin'); if (user.role !== 'admin' && t.professor_id !== user.id) fail(); if (!count(t.unread_count) || !count(t.message_count) || (t.last_message != null && typeof t.last_message !== 'string')) fail(); });
  if (user.role === 'admin') {
    const t = v.totals;
    if (!t || !count(t.total_threads) || !count(t.unread_messages) || !(t.open_threads == null || count(t.open_threads)) || !Array.isArray(t.by_subject)
      || t.by_subject.some(s => !text(s.subject) || !count(s.total_threads) || !count(s.open_threads) || !count(s.unread_messages))) fail();
  }
  return v;
}
export function parseSupportDetail(v, user, expectedId, subject) {
  const t = threadSummary(v?.thread, true);
  if ((expectedId && t.id !== expectedId) || (subject && t.subject !== subject) || (user.role !== 'admin' && t.professor_id !== user.id)
    || !Array.isArray(v.messages) || new Set(v.messages.map(m => m?.id)).size !== v.messages.length) fail();
  if (v.messages.some(m => !id(m?.id) || m.thread_id !== t.id || !id(m.sender_id) || !text(m.body) || !text(m.sender_name)
    || !['admin', 'professor'].includes(m.sender_role) || (m.sender_role === 'professor' && m.sender_id !== t.professor_id)
    || !text(m.created_at) || (m.read_at != null && !text(m.read_at)))) fail();
  return v;
}
export function confirmSupportSend(v, user, expectedId, subject, body, previousIds) {
  const next = parseSupportDetail(v, user, expectedId, subject);
  if (!next.messages.some(m => m.sender_id === user.id && m.body === body && !previousIds.includes(m.id))) fail();
  return next;
}
export function supportDraftKey(user, threadId, subject) { return user.role === 'admin' ? `thread:${threadId || ''}` : `subject:${subject || ''}`; }
export function supportDate(value) {
  if (!value) return '';
  const date = new Date(/^[\d-]+ [\d:]+$/.test(value) ? value.replace(' ', 'T') + 'Z' : value);
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
