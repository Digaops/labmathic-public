import { parseMaterial } from './materialView.mjs';

export function parseCollectionSummary(value) {
  if (!value || !Number.isSafeInteger(Number(value.id)) || Number(value.id) < 1 || typeof value.name !== 'string'
    || ![0, 1, false, true].includes(value.is_public)
    || ['description', 'image_path'].some(key => value[key] != null && typeof value[key] !== 'string')) {
    throw new Error('Coleção não confirmada.');
  }
  return value;
}
export function parseCollectionList(value) {
  if (!Array.isArray(value)) throw new Error('Coleções não confirmadas.');
  return value.map(item => {
    parseCollectionSummary(item);
    if (!Number.isInteger(item.item_count) || item.item_count < 0) throw new Error('Contagem não confirmada.');
    return item;
  });
}
export function parseCollection(value) {
  parseCollectionSummary(value);
  if (!Array.isArray(value.materials)) throw new Error('Materiais não confirmados.');
  value.materials.forEach(parseMaterial);
  return value;
}
// Keep existing ano/tipo links, including materials without a classified year/type.
export const collectionGrade = item => item.grade_name || item.grade || item.gradeName || item.series_name || item.serie || 'Sem ano definido';
export const collectionType = item => item.material_type_name || item.type_name || item.type || 'Sem tipo definido';
export function collectionOptions(materials, pick, fallback) {
  return [...new Set(materials.map(pick))].sort((a, b) => a === b ? 0 : a === fallback ? 1 : b === fallback ? -1 : a.localeCompare(b, 'pt-BR', { numeric: true }));
}
export function filterCollection(materials, grade, type) {
  return materials.filter(item => (!grade || collectionGrade(item) === grade) && (!type || collectionType(item) === type));
}
