const count = value => Number.isSafeInteger(value) && value >= 0;

function rows(payload, limit, kind, envelope) {
  const items = envelope ? payload?.data : payload;
  if (!Array.isArray(items) || items.length > limit) throw new Error('Lista incompleta.');
  const seen = new Set();
  return items.map(item => {
    if (!item || !count(item.id) || item.id === 0 || seen.has(item.id)
      || typeof item.title !== 'string' || !item.title.trim()
      || (item.discipline_name != null && typeof item.discipline_name !== 'string')
      || (kind === 'set' && !count(item.question_count))) throw new Error('Conteúdo inválido.');
    seen.add(item.id);
    return { id: item.id, title: item.title, discipline: item.discipline_name,
      questionCount: kind === 'set' ? item.question_count : null,
      path: `${kind === 'set' ? '/simulados/' : '/material/'}${item.id}` };
  });
}
export const adminHistory = payload => rows(payload, 4, 'material', false);
export const adminFavorites = payload => rows(payload, 3, 'material', true);
export const adminRecentMaterials = payload => rows(payload, 6, 'material', true);
export const adminRecentSets = payload => rows(payload, 3, 'set', true);

export function adminHomeStats(payload) {
  const keys = ['totalMaterials', 'totalQuestions', 'totalQuestionSets', 'totalCoveredSkills'];
  if (payload?.scope !== 'global' || keys.some(key => !count(payload[key]))
    || payload.totalCoveredSkills > payload.totalQuestions) throw new Error('Totais incompletos.');
  return Object.fromEntries(keys.map(key => [key, payload[key]]));
}
export function adminNetworkSummary(payload) {
  const keys = ['activeMunicipalities', 'activeSchools', 'verifiedClasses', 'pendingClasses'];
  if (payload?.mode !== 'admin' || payload.readOnly !== true || !payload.summary
    || keys.some(key => !count(payload.summary[key]))) throw new Error('Resumo da rede incompleto.');
  return Object.fromEntries(keys.map(key => [key, payload.summary[key]]));
}
