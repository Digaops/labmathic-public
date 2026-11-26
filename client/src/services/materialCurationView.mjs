const id = n => Number.isSafeInteger(n) && n > 0;
const version = n => typeof n === 'string' && /^[a-f0-9]{64}$/.test(n);
const text = n => typeof n === 'string' && Boolean(n.trim());
const status = n => ['legacy', 'confirmed', 'needs_review'].includes(n);
const skill = s => s && id(s.id) && text(s.code) && text(s.description) && text(s.gradeName);
const unique = rows => new Set(rows.map(s => s.id)).size === rows.length;
export const associationLabel = { legacy: 'Cadastro anterior', confirmed: 'Associação revisada', needs_review: 'Precisa de nova conferência' };
export { eventTime as curationDate } from './eventDates.mjs';
export function publicAssociations(value) {
  if (!value || !Array.isArray(value.associations) || !unique(value.associations) || value.associations.some(s => !skill(s) || !status(s.status)
    || (s.reason !== null && !text(s.reason)) || (s.location !== null && !text(s.location))
    || (s.status === 'confirmed' && (!text(s.reason) || !text(s.location))))) throw Error('Associações não confirmadas.');
  return value;
}
export function curationSnapshot(value, expectedId) {
  publicAssociations(value);
  if (!value.material || value.material.id !== Number(expectedId) || !text(value.material.title) || !version(value.version)
    || value.associations.some(s => !version(s.version))) throw Error('Revisão não confirmada.');
  return value;
}
export function curationReceipt(value, key, targetId) {
  if (!value || value.operationKey !== key || value.materialId !== Number(targetId) || !id(value.skillId) || !id(value.reviewId)
    || !['confirm', 'remove'].includes(value.decision) || !version(value.version)) throw Error('Pedido não confirmado.');
  return value;
}
export function curationSearch(value) {
  if (!value || !Array.isArray(value.skills) || value.skills.length > 20 || !unique(value.skills) || !id(value.page)
    || !Number.isSafeInteger(value.total) || value.total < 0 || value.totalPages !== Math.ceil(value.total / 20)
    || value.skills.length !== Math.min(20, Math.max(0, value.total - (value.page - 1) * 20))
    || value.skills.some(s => !skill(s) || !version(s.version) || ![s.coverage, s.pending].every(n => Number.isSafeInteger(n) && n >= 0))) throw Error('Busca não confirmada.');
  return value;
}
export function curationHistory(value) {
  if (!value || !Array.isArray(value.events) || value.events.length > 20 || !unique(value.events)
    || (value.nextBefore !== null && (!id(value.nextBefore) || value.events.at(-1)?.id !== value.nextBefore))
    || value.events.some(e => !id(e.id) || !['confirm', 'remove'].includes(e.decision) || !text(e.reason) || !text(e.reviewer) || !skill(e.skill))) throw Error('Histórico não confirmado.');
  return value;
}
