// API event timestamps without an offset are legacy SQLite UTC, never local time.
// Calendar-only dates are intentionally kept separate (e.g. a planned lesson day).
export function isCalendarDay(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(value + 'T00:00:00.000Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
export function parseEventInstant(value) {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2}):(\d{2})(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/.exec(value.trim());
  if (!match || !isCalendarDay(match[1]) || Number(match[2]) > 23 || Number(match[3]) > 59 || Number(match[4]) > 59) return null;
  const offset = match[6] || 'Z';
  if (offset !== 'Z' && (Number(offset.slice(1, 3)) > 23 || Number(offset.slice(4)) > 59)) return null;
  const date = new Date(`${match[1]}T${match[2]}:${match[3]}:${match[4]}${match[5] || ''}${offset}`);
  return Number.isFinite(date.getTime()) ? date : null;
}
export function eventDay(value, timeZone) {
  // Preserve date-only values from older clients without shifting the calendar day.
  if (isCalendarDay(value)) return value.slice(8) + '/' + value.slice(5, 7) + '/' + value.slice(0, 4);
  const date = parseEventInstant(value);
  return date ? date.toLocaleDateString('pt-BR', timeZone ? { timeZone } : undefined) : '';
}
export function eventTime(value, timeZone) {
  const date = parseEventInstant(value);
  return date ? date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short', ...(timeZone ? { timeZone } : {}) }) : 'Horário não informado';
}
