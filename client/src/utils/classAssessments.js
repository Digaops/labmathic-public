export function isoToLocalInput(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

export function localInputToIso(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

export function sameIdSet(left = [], right = []) {
  if (left.length !== right.length) return false;
  const normalized = new Set(left.map(String));
  return right.every((value) => normalized.has(String(value)));
}

export function nextAssessmentTransition(assignments = [], now = Date.now()) {
  return assignments
    .flatMap((assignment) => {
      if (assignment.status === 'scheduled' && assignment.opensAt) {
        return [Date.parse(assignment.opensAt)];
      }
      if (assignment.status === 'open' && assignment.closesAt) {
        return [Date.parse(assignment.closesAt)];
      }
      return [];
    })
    .filter((timestamp) => Number.isFinite(timestamp) && timestamp > now)
    .sort((left, right) => left - right)[0] || null;
}

export function formatAssessmentWindow(opensAt, closesAt) {
  if (!opensAt && !closesAt) return 'Sem período definido';
  const format = (value) => new Intl.DateTimeFormat('pt-BR', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
  if (opensAt && closesAt) return `${format(opensAt)} até ${format(closesAt)}`;
  if (opensAt) return `A partir de ${format(opensAt)}`;
  return `Até ${format(closesAt)}`;
}
