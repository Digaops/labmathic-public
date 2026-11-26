const stages = ['elementary_initial', 'elementary_final'];
const years = ['2023', '2025'];
const code = value => typeof value === 'string' && /^\d{7}$/.test(value);
const defaults = { ibgeCode: '', stage: 'elementary_initial', year: '2025' };

// Only public filters are carried in links. Names, credentials and free text are never copied.
export function readPortraitQuery(params) {
  const ibgeCode = params.get('municipio') ?? '', stage = params.get('etapa') ?? defaults.stage,
    year = params.get('ano') ?? defaults.year;
  const valid = ['municipio', 'etapa', 'ano'].every(key => params.getAll(key).length <= 1)
    && (!params.has('municipio') || code(ibgeCode)) && stages.includes(stage) && years.includes(year);
  return valid ? { ibgeCode, stage, year, valid: true } : { ...defaults, valid: false };
}
export function portraitSearchParams(filters) {
  if (!filters || typeof filters.ibgeCode !== 'string' || (filters.ibgeCode && !code(filters.ibgeCode)) || !stages.includes(filters.stage) || !years.includes(String(filters.year))) {
    throw new Error('Confira os filtros desta consulta.');
  }
  const params = new URLSearchParams();
  if (filters.ibgeCode) params.set('municipio', filters.ibgeCode);
  params.set('etapa', filters.stage); params.set('ano', String(filters.year));
  return params;
}
export function portraitSharePath(filters) {
  if (!code(filters?.ibgeCode)) throw new Error('Escolha um município antes de compartilhar.');
  return '/retrato-da-rede?' + portraitSearchParams(filters);
}
export function portraitShareUrl(origin, filters) {
  const base = new URL(origin);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password) throw new Error('Endereço da plataforma não confirmado.');
  return base.origin + portraitSharePath(filters);
}
export function portraitLoginPath(location) {
  if (location?.pathname !== '/retrato-da-rede') return '/login';
  const filters = readPortraitQuery(new URLSearchParams(location.search));
  if (!filters.valid || !filters.ibgeCode) return '/login';
  const params = portraitSearchParams(filters); params.delete('municipio'); params.set('retrato', filters.ibgeCode);
  return '/login?' + params;
}
export function portraitReturnPath(search) {
  const params = new URLSearchParams(search);
  if (params.getAll('retrato').length !== 1 || !code(params.get('retrato')) || params.has('municipio')) return '/';
  params.set('municipio', params.get('retrato')); params.delete('retrato');
  const filters = readPortraitQuery(params);
  return filters.valid ? portraitSharePath(filters) : '/';
}
