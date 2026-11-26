function invalid(message = 'Confira os filtros informados.') { throw Object.assign(new Error(message), { status: 400 }); }
function integer(value, fallback, maximum, minimum = 1) {
  if (value === undefined) return fallback;
  if (typeof value !== 'string' || !/^\d+$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < minimum) invalid();
  return Math.min(Number(value), maximum);
}
function dateValue(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})?)?$/.test(value) || !Number.isFinite(Date.parse(value))) invalid('Informe datas válidas.');
  const day = value.slice(0, 10), parsed = new Date(day + 'T00:00:00Z');
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) invalid('Informe datas válidas.');
  return value;
}
function activityQuery(query) {
  const values = {};
  for (const key of ['user_role', 'action', 'module', 'entity_type', 'search']) {
    if (query[key] === undefined) continue;
    if (typeof query[key] !== 'string' || query[key].length > (key === 'search' ? 200 : 100)) invalid();
    values[key] = query[key].trim();
  }
  for (const key of ['user_id', 'entity_id']) if (query[key] !== undefined && query[key] !== '') values[key] = integer(query[key], undefined, Number.MAX_SAFE_INTEGER);
  for (const key of ['date_from', 'date_to', 'date_before']) values[key] = dateValue(query[key]);
  if (values.date_from && ((values.date_to && Date.parse(values.date_from) > Date.parse(values.date_to)) || (values.date_before && Date.parse(values.date_from) >= Date.parse(values.date_before)))) invalid('A data final deve ser igual ou posterior à inicial.');
  if (query.critical_only !== undefined && !['1', '0', 'true', 'false'].includes(query.critical_only)) invalid();
  values.critical_only = query.critical_only;
  values.page = integer(query.page, 1, 1000000); values.limit = integer(query.limit, 30, 100);
  values.snapshot_id = integer(query.snapshot_id, undefined, Number.MAX_SAFE_INTEGER, 0);
  return values;
}
module.exports = { integer, dateValue, activityQuery };
