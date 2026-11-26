// Preparation only: no importer, database writes or network calls are activated here.
const source = 'https://www.gov.br/inep/pt-br/acesso-a-informacao/dados-abertos/indicadores-educacionais';
const catalog = Object.freeze({
  ideb: { label: 'Ideb', unit: 'index_0_10', min: 0, max: 10, source: 'https://www.gov.br/inep/pt-br/areas-de-atuacao/pesquisas-estatisticas-e-indicadores/ideb/resultados' },
  approval: { label: 'Aprovação', unit: 'percent', min: 0, max: 100, source },
  failure: { label: 'Reprovação', unit: 'percent', min: 0, max: 100, source },
  dropout: { label: 'Abandono escolar', unit: 'percent', min: 0, max: 100, source },
  age_grade_distortion: { label: 'Distorção idade-série', unit: 'percent', min: 0, max: 100, source },
});
function normalizeMunicipalIndicator(row) {
  const definition = row && Object.hasOwn(catalog, row.indicator) && catalog[row.indicator];
  if (!definition || !/^\d{7}$/.test(row.ibgeCode || '') || row.network !== 'municipal'
    || !['elementary_initial', 'elementary_final'].includes(row.stage)
    || !Number.isInteger(row.referenceYear) || row.referenceYear < 2005 || row.referenceYear > 2100
    || !['published', 'not_published', 'suppressed', 'unavailable'].includes(row.status)
    || typeof row.methodologyVersion !== 'string' || !row.methodologyVersion.trim()
    || typeof row.territoryVersion !== 'string' || !row.territoryVersion.trim()
    || !/^[a-f0-9]{64}$/.test(row.artifactSha256 || '') || row.sourceUrl !== definition.source
    || !/^\d{4}-\d{2}-\d{2}T/.test(row.retrievedAt || '') || !Number.isFinite(Date.parse(row.retrievedAt))) {
    throw new Error('Indicador sem recorte ou procedência confirmados.');
  }
  if (row.status === 'published' ? (typeof row.value !== 'number' || !Number.isFinite(row.value)
      || row.value < definition.min || row.value > definition.max) : row.value !== null) {
    throw new Error('Dado ausente não pode ser tratado como zero.');
  }
  return { indicator: row.indicator, ibgeCode: row.ibgeCode, network: row.network, stage: row.stage,
    referenceYear: row.referenceYear, status: row.status, value: row.value, unit: definition.unit,
    methodologyVersion: row.methodologyVersion.trim(), territoryVersion: row.territoryVersion.trim(),
    sourceUrl: definition.source, retrievedAt: row.retrievedAt, artifactSha256: row.artifactSha256 };
}
function compareMunicipalIndicators(before, after) {
  const a = normalizeMunicipalIndicator(before), b = normalizeMunicipalIndicator(after);
  if (a.status !== 'published' || b.status !== 'published'
    || ['indicator', 'ibgeCode', 'network', 'stage', 'methodologyVersion', 'territoryVersion'].some(key => a[key] !== b[key])
    || a.referenceYear >= b.referenceYear) return { comparable: false, change: null };
  return { comparable: true, change: Number((b.value - a.value).toFixed(2)),
    unit: a.unit === 'percent' ? 'percentage_points' : a.unit };
}
module.exports = { catalog, normalizeMunicipalIndicator, compareMunicipalIndicators };
