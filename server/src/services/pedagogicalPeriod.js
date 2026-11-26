const formatter = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Sao_Paulo', year: 'numeric', month: '2-digit', day: '2-digit',
});
function localDay(timestamp) {
  const parts = Object.fromEntries(formatter.formatToParts(timestamp).map(p => [p.type, p.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}
function calendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Informe as duas datas.');
  const time = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(time) || new Date(time).toISOString().slice(0, 10) !== value || Number(value.slice(0, 4)) < 1900 || Number(value.slice(0, 4)) > 9998)
    throw new Error('Informe datas válidas.');
  return time;
}
// First instant of the calendar day, including historical daylight-saving changes.
function dayBoundary(day, time) {
  let low = time - 36 * 3600000; let high = time + 36 * 3600000;
  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (localDay(mid) < day) low = mid + 1; else high = mid;
  }
  return new Date(low).toISOString();
}
function periodBounds(start, end) {
  const first = calendarDate(start); const last = calendarDate(end);
  if (first > last) throw new Error('A data final deve ser igual ou posterior à inicial.');
  if ((last - first) / 86400000 >= 366) throw new Error('Escolha um período de até 366 dias.');
  const next = last + 86400000;
  return { start, end, timeZone: 'America/Sao_Paulo',
    from: dayBoundary(start, first), until: dayBoundary(new Date(next).toISOString().slice(0, 10), next) };
}
module.exports = { periodBounds };
