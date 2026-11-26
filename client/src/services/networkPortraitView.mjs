export const portraitStages = { elementary_initial: 'Anos iniciais · 1º ao 5º', elementary_final: 'Anos finais · 6º ao 9º' };
const years = [2023, 2025], hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const sourcePage = 'https://www.gov.br/inep/pt-br/areas-de-atuacao/pesquisas-estatisticas-e-indicadores/ideb/resultados/2005-2025';
const sourceUrls = {
  elementary_initial: 'https://download.inep.gov.br/ideb/resultados/divulgacao_anos_iniciais_municipios_2025.zip',
  elementary_final: 'https://download.inep.gov.br/ideb/resultados/divulgacao_anos_finais_municipios_2025.zip',
};
const invalid = () => { throw Object.assign(new Error('Não foi possível confirmar o recorte e a fonte desta consulta.'), { code: 'portrait_response_invalid' }); };
function placeValid(p) {
  return p && typeof p.ibgeCode === 'string' && /^\d{7}$/.test(p.ibgeCode) && typeof p.name === 'string'
    && p.name.trim().length >= 2 && p.name.length <= 160 && !/[<>\x00-\x1f]/.test(p.name)
    && typeof p.uf === 'string' && /^[A-Z]{2}$/.test(p.uf);
}
function rowValid(row) {
  return row && years.includes(row.year) && (row.status === 'published'
    ? typeof row.value === 'number' && Number.isFinite(row.value) && row.value >= 0 && row.value <= 10 && row.sourceMarker === null
    : row.value === null && (row.status === 'unavailable' && [null, '-'].includes(row.sourceMarker)
      || row.status === 'suppressed' && ['ND', 'ND*', 'ND***'].includes(row.sourceMarker)));
}
export function parsePortraitPublication(value) {
  if (!value || typeof value.available !== 'boolean' || !integer(value.revision) || value.dataKind !== 'official_public_aggregate') invalid();
  if (!value.available) {
    if (value.batchId !== null || value.manifest !== null) invalid();
    return value;
  }
  const m = value.manifest;
  if (!hash(value.batchId) || !m || m.version !== 1 || m.indicator !== 'ideb' || m.network !== 'municipal'
    || m.edition !== 'inep-ideb-2025-reviewed-2026-09-14' || m.methodologyVersion !== 'ideb-nxp-2025'
    || m.sourcePage !== sourcePage || !Array.isArray(m.years) || m.years.length !== 2 || m.years.some((y, i) => y !== years[i])
    || typeof m.retrievedAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(m.retrievedAt) || !Number.isFinite(Date.parse(m.retrievedAt))
    || !hash(m.rowsSha256) || !hash(m.placesSha256) || !hash(m.territoryVersion)
    || !Array.isArray(m.sources) || m.sources.length !== 2 || new Set(m.sources.map(s => s?.stage)).size !== 2
    || m.sources.some(s => !s || !Object.hasOwn(sourceUrls, s.stage) || s.url !== sourceUrls[s.stage] || !hash(s.sha256))) invalid();
  return value;
}
export function parsePortraitSearch(value) {
  parsePortraitPublication(value);
  if (!Array.isArray(value.municipalities) || value.municipalities.length > 20 || value.municipalities.some(p => !placeValid(p))
    || new Set(value.municipalities.map(p => p.ibgeCode)).size !== value.municipalities.length
    || (!value.available && value.municipalities.length)) invalid();
  return value;
}
export function parsePortraitResult(value, expected) {
  parsePortraitPublication(value);
  if (!value.available) {
    if (value.municipality !== null || value.current !== null || value.comparison !== null || !Array.isArray(value.series) || value.series.length) invalid();
    return value;
  }
  if (!placeValid(value.municipality) || !Object.hasOwn(portraitStages, value.stage) || !years.includes(value.year)
    || value.municipality.ibgeCode !== expected.ibgeCode || value.stage !== expected.stage || value.year !== Number(expected.year)
    || !rowValid(value.current) || value.current.year !== value.year || !Array.isArray(value.series) || value.series.length !== 2
    || value.series.some((row, i) => !rowValid(row) || row.year !== years[i])) invalid();
  const selected = value.series.find(row => row.year === value.year);
  if (['value', 'status', 'sourceMarker'].some(key => selected[key] !== value.current[key])) invalid();
  if (value.year === 2023) { if (value.comparison !== null) invalid(); }
  else {
    const c = value.comparison, comparable = value.series.every(row => row.status === 'published');
    if (!c || c.beforeYear !== 2023 || c.comparable !== comparable) invalid();
    if (comparable ? c.change !== Number((value.series[1].value - value.series[0].value).toFixed(2)) || c.unit !== 'index_0_10' : c.change !== null) invalid();
  }
  return value;
}
export function indicatorValue(row) {
  return row?.status === 'published' && Number.isFinite(row.value)
    ? row.value.toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 }) : 'Não disponível';
}
export function comparisonText(result) {
  if (!result?.comparison) return 'A série desta entrega começa em 2023.';
  const c = result.comparison;
  if (!c.comparable) return `Sem comparação com ${c.beforeYear}: falta um resultado divulgado.`;
  if (c.change === 0) return `Mesmo índice de ${c.beforeYear}.`;
  const delta = Math.abs(c.change).toLocaleString('pt-BR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  return `${delta} ${Math.abs(c.change) === 1 ? 'ponto' : 'pontos'} ${c.change > 0 ? 'acima' : 'abaixo'} de ${c.beforeYear}.`;
}
export function absenceText(row) {
  if (row?.status === 'suppressed') return 'Resultado não divulgado pela fonte. Consulte as notas do Inep para conhecer as regras de divulgação.';
  return 'Não há valor disponível neste recorte. Isso não significa nota zero; não atribuímos uma causa quando ela não consta do registro.';
}
export function portraitError(status, code) {
  if (status === 401 || status === 403) return 'Seu acesso não pôde ser confirmado. Entre novamente para consultar.';
  if (code === 'portrait_response_invalid') return 'Os dados recebidos não conferem com esta consulta. Nenhum resultado foi usado. Tente novamente.';
  if (status === 404 && code === 'municipality_not_found') return 'Este município não foi encontrado na base publicada. Use “Trocar” para fazer uma nova busca.';
  if (status === 404) return 'Esta consulta não está disponível no momento. Confira a liberação da sua conta.';
  return 'Não foi possível consultar os dados. Confira sua conexão e tente novamente.';
}
