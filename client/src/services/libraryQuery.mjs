export const libraryFilterKeys = ['discipline_id', 'grade_id', 'material_type_id', 'topic_id', 'file_format'];
export const libraryFormats = ['PDF', 'DOCX', 'PPTX', 'MP4', 'JPG', 'PNG', 'WEBM'];
export const librarySorts = [['recent', 'Mais recentes'], ['oldest', 'Mais antigos'], ['title_asc', 'Título A–Z'],
  ['title_desc', 'Título Z–A'], ['most_viewed', 'Mais acessados'], ['best_rated', 'Melhor avaliados']];
const positive = value => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function readLibraryQuery(params) {
  const filters = Object.fromEntries(libraryFilterKeys.map(key => {
    const value = params.get(key) || (key === 'grade_id' && params.get('my_grades') === '1' ? 'mine' : '');
    return [key, key === 'file_format' ? (libraryFormats.includes(value) ? value : '')
      : key === 'grade_id' && value === 'mine' ? value : positive(value) ? String(Number(value)) : ''];
  }));
  return { search: (params.get('search') || '').trim(), filters,
    sort: librarySorts.some(([value]) => value === params.get('sort')) ? params.get('sort') : 'recent',
    page: positive(params.get('page')) ? Number(params.get('page')) : 1 };
}

export function librarySearchParams(query) {
  const params = new URLSearchParams();
  if (query.search) params.set('search', query.search.trim());
  for (const key of libraryFilterKeys) if (query.filters[key]) params.set(key, query.filters[key]);
  if (query.sort !== 'recent') params.set('sort', query.sort);
  if (query.page > 1) params.set('page', String(query.page));
  return params;
}

export function libraryRequestPath(query) {
  const params = librarySearchParams(query);
  params.set('page', String(query.page)); params.set('limit', '12'); params.set('sort', query.sort);
  if (params.get('grade_id') === 'mine') { params.delete('grade_id'); params.set('my_grades', '1'); }
  return `/materials?${params}`;
}

export function parseLibraryMaterials(payload) {
  const p = payload?.pagination;
  if (!Array.isArray(payload?.data) || payload.data.some(item => !item || !positive(item.id) || typeof item.title !== 'string'
    || (item.topics != null && (!Array.isArray(item.topics) || item.topics.some(topic => !topic || typeof topic.name !== 'string'))))
    || !p || !positive(p.page) || !positive(p.limit) || !Number.isSafeInteger(p.total) || p.total < 0
    || !Number.isSafeInteger(p.totalPages) || p.totalPages < 0 || p.totalPages !== Math.ceil(p.total / Number(p.limit))) {
    throw new Error('Resposta de materiais incompleta.');
  }
  if (payload.data.length !== Math.min(Number(p.limit), Math.max(0, p.total - (Number(p.page) - 1) * Number(p.limit)))) {
    throw new Error('Página de materiais incompleta.');
  }
  return payload;
}

export function parseLibraryCategories(payload) {
  if (!Array.isArray(payload) || payload.some(item => !item || !positive(item.id) || typeof item.name !== 'string')) {
    throw new Error('Lista de filtros incompleta.');
  }
  return payload;
}

export function libraryFilterName(key, value, categories) {
  if (key === 'file_format') return value;
  if (key === 'grade_id' && value === 'mine') return 'Meus anos de ensino';
  return categories?.find(item => String(item.id) === value)?.name || `Opção selecionada (${value})`;
}
