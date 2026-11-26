export const MAX_NUMERIC_QUESTIONS = 100;

export function parseNumericSourcePage(value) {
  const p = value?.pagination;
  if (!p || !Number.isSafeInteger(p.page) || p.page < 1 || p.page > 100000 || p.pageSize !== 20
    || !Number.isSafeInteger(p.total) || p.total < 0 || p.totalPages !== Math.ceil(p.total / 20)) {
    throw new Error('Não foi possível conferir a página de questões.');
  }
  parseNumericSources(value.data);
  if (value.data.length !== Math.min(20, Math.max(0, p.total - (p.page - 1) * 20))) {
    throw new Error('A página de questões está incompleta. Tente novamente.');
  }
  return value;
}

export function mergeNumericSourceSelection(selected, page) {
  // Keep only the selected items plus the visible page, not every result ever visited.
  return [...new Map([...selected, ...page].map(source => [source.id, source])).values()];
}

export function parseNumericSources(value) {
  if (!Array.isArray(value) || value.length > 200 || value.some(source => !source
    || typeof source.id !== 'string' || !source.id
    || !Number.isSafeInteger(source.version) || source.version < 1
    || ['title', 'skillCode', 'gradeName', 'unit', 'supportText'].some(key => typeof source[key] !== 'string')
    || !source.title.trim()
    // Optional for compatibility with an earlier server during deployment.
    || (source.questionCode !== undefined && (typeof source.questionCode !== 'string' || !source.questionCode.trim())))
    || new Set(value.map(source => source.id)).size !== value.length) {
    throw new Error('Não foi possível conferir as questões numéricas. Atualize a lista.');
  }
  return value;
}

function sameQuestion(sources, selectedId, target) {
  return Boolean(target.questionCode && sources.find(source => source.id === selectedId)?.questionCode === target.questionCode);
}

export function canSelectNumericVersion(sources, selectedIds, targetId) {
  const target = sources.find(source => source.id === targetId);
  return Boolean(target && (selectedIds.includes(targetId) || selectedIds.length < MAX_NUMERIC_QUESTIONS
    || selectedIds.some(id => sameQuestion(sources, id, target))));
}

export function toggleNumericVersion(sources, selectedIds, targetId) {
  if (!canSelectNumericVersion(sources, selectedIds, targetId)) return selectedIds;
  if (selectedIds.includes(targetId)) return selectedIds.filter(id => id !== targetId);
  const target = sources.find(source => source.id === targetId);
  const previousIndex = selectedIds.findIndex(id => sameQuestion(sources, id, target));
  const next = selectedIds.filter(id => !sameQuestion(sources, id, target));
  // Replacing a version does not reorder the other questions in the activity.
  next.splice(previousIndex < 0 ? next.length : previousIndex, 0, targetId);
  return next;
}
