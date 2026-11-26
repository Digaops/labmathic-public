// Only supported filters reach the API. Class search and school search are independent.
const searchText = value => (value || '').slice(0, 100).replace(/[\uD800-\uDBFF]$/, '');
export function coordinationQuery(params) {
  const selected = params.get('escola');
  const page = /^[1-9]\d{0,3}$/.test(params.get('pagina')) ? Number(params.get('pagina')) : 1;
  const year = /^(20\d\d|2100)$/.test(params.get('ano')) ? params.get('ano') : '';
  const search = searchText(params.get('busca'));
  const classSearch = searchText(params.get('turma'));
  const url = selected ? `/school-coordination/schools/${encodeURIComponent(selected)}/classes?page=${page}${year ? `&year=${year}` : ''}${classSearch ? `&search=${encodeURIComponent(classSearch)}` : ''}`
    : `/school-coordination/schools?page=${page}&search=${encodeURIComponent(search)}`;
  return { selected, page, year, search, classSearch, url };
}

export function coordinationParams(params, changes) {
  const next = new URLSearchParams(params);
  Object.entries(changes).forEach(([key, value]) => value ? next.set(key, String(value)) : next.delete(key));
  return next;
}
