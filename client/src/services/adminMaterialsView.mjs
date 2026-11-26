import { parseLibraryMaterials } from './libraryQuery.mjs';
export const materialFilterKeys = ['discipline_id', 'grade_id', 'material_type_id'];
const id = n => Number.isSafeInteger(n) && n > 0;
export function adminMaterialsQuery(params) {
  return { search: (params.get('search') || '').trim().slice(0, 200), page: /^[1-9]\d*$/.test(params.get('page') || '') && id(Number(params.get('page'))) ? Number(params.get('page')) : 1,
    filters: Object.fromEntries(materialFilterKeys.map(key => [key, /^[1-9]\d*$/.test(params.get(key) || '') && id(Number(params.get(key))) ? params.get(key) : ''])) };
}
export function adminMaterialsParams(query) {
  const params = new URLSearchParams(); if (query.search) params.set('search', query.search);
  for (const key of materialFilterKeys) if (query.filters[key]) params.set(key, query.filters[key]);
  if (query.page > 1) params.set('page', String(query.page)); return params;
}
export function adminMaterialsPath(query) {
  const params = adminMaterialsParams(query); params.set('page', String(query.page)); params.set('limit', '20'); params.set('sort', 'recent'); return '/materials?' + params;
}
export function adminMaterialsPage(payload) {
  const result = parseLibraryMaterials(payload), seen = new Set();
  if (result.pagination.limit !== 20) throw Error('Limite de página inválido.');
  for (const m of result.data) {
    if (!id(m.id) || seen.has(m.id) || !m.title.trim()
      || ['discipline_name', 'grade_name', 'material_type_name'].some(key => m[key] != null && typeof m[key] !== 'string')) throw Error('Página administrativa inválida.');
    seen.add(m.id);
  }
  return result;
}
export function deletionSelection(payload, requested) {
  if (!Array.isArray(payload?.materials) || !Array.isArray(payload.missingIds) || !Array.isArray(requested) || !requested.length || requested.length > 50 || new Set(requested).size !== requested.length || requested.some(n => !id(n))) throw Error('Conferência inválida.');
  const found = payload.materials.map(m => {
    if (!m || !id(m.id) || typeof m.title !== 'string' || !m.title.trim() || !/^[a-f0-9]{64}$/.test(m.version)) throw Error('Material não confirmado.');
    return m;
  });
  const returned = [...found.map(m => m.id), ...payload.missingIds];
  if (returned.length !== requested.length || new Set(returned).size !== requested.length || returned.some(n => !id(n) || !requested.includes(n))) throw Error('Seleção não corresponde à consulta.');
  return { materials: requested.flatMap(n => found.filter(m => m.id === n)), missingIds: payload.missingIds };
}
