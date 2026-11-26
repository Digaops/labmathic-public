const count = n => Number.isSafeInteger(n) && n >= 0;
export function adminAttention(data) {
  if (!count(data?.unreadSupportMessages)) throw new Error('Resumo do atendimento inválido.');
  return { unread: data.unreadSupportMessages };
}
export function adminMaterialStats(data) {
  if (!count(data?.total) || !count(data.thisMonth) || data.thisMonth > data.total || !Array.isArray(data.byType)) throw new Error('Resumo do acervo inválido.');
  const names = new Set(); let assigned = 0;
  for (const type of data.byType) {
    if (!type || typeof type.name !== 'string' || !type.name.trim() || names.has(type.name) || !count(type.count)) throw new Error('Distribuição inválida.');
    names.add(type.name); assigned += type.count;
  }
  if (assigned > data.total) throw new Error('Distribuição inconsistente.');
  return { total: data.total, thisMonth: data.thisMonth, byType: data.byType,
    usedTypes: data.byType.filter(t => t.count > 0).length, unassigned: data.total - assigned };
}
export function adminTopContent(data) {
  if (!Array.isArray(data) || data.length > 5) throw new Error('Lista de conteúdos inválida.');
  const seen = new Set();
  return data.map(item => {
    if (!item || !count(item.id) || item.id === 0 || !['material', 'question_set'].includes(item.content_type)
      || typeof item.title !== 'string' || !item.title.trim() || !count(item.access_count)
      || (item.category != null && typeof item.category !== 'string')) throw new Error('Conteúdo inválido.');
    const key = `${item.content_type}-${item.id}`;
    const path = `${item.content_type === 'material' ? '/material/' : '/simulados/'}${item.id}`;
    if (seen.has(key) || item.path !== path) throw new Error('Identidade de conteúdo inválida.');
    seen.add(key); return { ...item, key, path };
  }).filter(item => item.access_count > 0);
}
