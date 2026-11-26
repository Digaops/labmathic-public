export const categoryAreas = {
  disciplines: { label: 'Disciplinas', singular: 'disciplina', example: 'Ex.: Matemática' },
  grades: { label: 'Anos escolares', singular: 'ano escolar', example: 'Ex.: 6º Ano - EF' },
  topics: { label: 'Assuntos', singular: 'assunto', example: 'Ex.: Frações equivalentes' },
  'material-types': { label: 'Tipos de material', singular: 'tipo de material', example: 'Ex.: Caderno de atividades' },
};
export const categoryIcons = { file: 'Arquivo', pdf: 'PDF', video: 'Vídeo', image: 'Imagem', document: 'Documento', presentation: 'Apresentação' };
export const categoryArea = value => Object.hasOwn(categoryAreas, value) ? value : 'disciplines';
const positive = n => Number.isSafeInteger(n) && n > 0;
export function categoryItem(item, kind) {
  if (!item || !positive(item.id) || typeof item.name !== 'string' || !item.name.trim() || !/^[a-f0-9]{64}$/.test(item.version || '')) throw Error('Categoria incompleta.');
  for (const key of ['material_count', 'other_usage_count']) if (!Number.isSafeInteger(item[key]) || item[key] < 0) throw Error('Vínculos incompletos.');
  if (kind === 'grades' && item.sort_order != null && !Number.isSafeInteger(item.sort_order)) throw Error('Ordem inválida.');
  if (kind === 'material-types' && item.icon != null && typeof item.icon !== 'string') throw Error('Ícone inválido.');
  return item;
}
export function categoryList(data, kind) {
  if (data?.kind !== kind || !Array.isArray(data.items) || new Set(data.items.map(i => i?.id)).size !== data.items.length) throw Error('Lista não confirmada.');
  return data.items.map(item => categoryItem(item, kind));
}
export function categoryDetail(data, kind, id) {
  if (data?.kind !== kind || data.item?.id !== id) throw Error('Categoria não confirmada.');
  return categoryItem(data.item, kind);
}
export const categorySearch = (items, search) => {
  const normalize = text => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  const q = normalize(search.trim());
  return items.filter(item => normalize(item.name).includes(q));
};
export function categoryDraft(item) { return { name: item?.name || '', sort_order: String(item?.sort_order ?? 0), icon: item?.icon || 'file' }; }
export function categoryIssue(form, kind) {
  if (!form.name.trim() || form.name.trim().length > 200) return ['category-name', 'Informe um nome com até 200 caracteres.'];
  if (kind === 'grades' && (!/^\d+$/.test(form.sort_order) || Number(form.sort_order) > 9999)) return ['category-order', 'Use uma ordem inteira de 0 a 9999.'];
  return null;
}
export function categoryPayload(form, kind, item) {
  return { name: form.name.trim(), ...(kind === 'grades' ? { sort_order: Number(form.sort_order) } : {}), ...(kind === 'material-types' ? { icon: form.icon } : {}), ...(item ? { expectedVersion: item.version } : {}) };
}
