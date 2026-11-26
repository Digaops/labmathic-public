import { parseMaterial, materialFileUrl } from './materialView.mjs';

export const validPublicToken = token => typeof token === 'string' && /^[a-f0-9]{64}$/.test(token);
export function confirmPublicMessage(data) {
  if (typeof data?.message !== 'string' || !data.message.trim()) throw new Error('Resposta sem confirmação.');
  return true;
}
export function publicWriteUncertain(error) {
  const status = error?.response?.status;
  return !status || status >= 500;
}
export function publicError(error, fallback) {
  return typeof error?.response?.data?.error === 'string' ? error.response.data.error : fallback;
}
export function passwordProblem(password, confirmation) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) return 'Use uma senha de 8 a 1.024 caracteres.';
  return password !== confirmation ? 'As senhas estão diferentes. Confira os dois campos.' : '';
}
export function sharedMaterialId(data) {
  if (!Number.isSafeInteger(data?.material_id) || data.material_id < 1) throw new Error('Compartilhamento não confirmado.');
  return data.material_id;
}
export function parseSharedMaterial(data, expectedId) {
  const material = parseMaterial(data);
  if (Number(material.id) !== expectedId || !material.title.trim()) throw new Error('Material não confirmado.');
  return material;
}
export function sharedFileUrl(file, token) {
  const local = materialFileUrl(file);
  return validPublicToken(token) && local?.startsWith('/uploads/') ? `${local}?share=${encodeURIComponent(token)}` : null;
}
export const sharedUnavailable = error => [400, 401, 403, 404, 410].includes(error?.response?.status);
