import { parseLibraryMaterials } from './libraryQuery.mjs';
import { parseMaterial } from './materialView.mjs';

export const favoritesPageSize = 20;
const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function favoritesPage(params) {
  const value = params.get('page');
  // Avoid an offset beyond JavaScript's safe integer range.
  return positive(value) && Number(value) <= Math.floor(Number.MAX_SAFE_INTEGER / favoritesPageSize) ? Number(value) : 1;
}

export function favoritesParams(page) {
  const params = new URLSearchParams();
  if (page > 1) params.set('page', String(page));
  return params;
}

export function favoritesRequest(page) {
  return `/favorites?page=${page}&limit=${favoritesPageSize}`;
}

export function parseFavorites(payload) {
  parseLibraryMaterials(payload);
  payload.data.forEach(parseMaterial);
  if (new Set(payload.data.map(item => Number(item.id))).size !== payload.data.length) throw new Error('Favoritos duplicados na resposta.');
  return payload;
}

// Constant-size pagination: never allocate an array for every available page.
export function favoritesPages(page, totalPages) {
  return [...new Set([1, page - 1, page, page + 1, totalPages])]
    .filter(value => value >= 1 && value <= totalPages)
    .sort((a, b) => a - b);
}
