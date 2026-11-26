import { materialSnapshot, materialOptions } from './materialFormView.mjs';
const id = n => Number.isSafeInteger(n) && n > 0;
const version = n => typeof n === 'string' && /^[a-f0-9]{64}$/.test(n);
export function draftSnapshot(value, expectedId) {
  materialSnapshot(value, expectedId);
  materialOptions(value.plannedCollections);
  if (value.publishedMaterialId !== null && !id(value.publishedMaterialId)) throw Error('Publicação não confirmada.');
  if (!Array.isArray(value.material.addCollectionIds) || value.material.addCollectionIds.some(n => !id(n))) throw Error('Laboratórios não confirmados.');
  return value;
}
export function draftReceipt(value, key, targetId, publishing = false) {
  if (!value || value.operationKey !== key || value.operation !== (publishing ? 'publish' : targetId ? 'update' : 'create')
    || !id(value.draftId) || (targetId && value.draftId !== Number(targetId)) || !version(value.version)
    || typeof value.title !== 'string' || !value.title.trim() || (publishing ? !id(value.materialId) : value.materialId !== null)) throw Error('Rascunho não confirmado.');
  return value;
}
export function draftList(value) {
  if (!value || !Array.isArray(value.drafts) || value.drafts.length > 20 || !id(value.page)
    || !Number.isSafeInteger(value.total) || value.total < 0 || value.totalPages !== Math.ceil(value.total / 20)
    || value.drafts.length !== Math.min(20, Math.max(0, value.total - (value.page - 1) * 20))
    || value.drafts.some(v => !id(v.id) || typeof v.title !== 'string' || !v.title.trim())
    || new Set(value.drafts.map(v => v.id)).size !== value.drafts.length) throw Error('Lista de rascunhos não confirmada.');
  return value;
}
