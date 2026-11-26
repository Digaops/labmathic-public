const test = require('node:test'), assert = require('node:assert/strict');
test('Retrato distingue zero, ausência e diferença em pontos, sem classificar a qualidade do professor', async () => {
  const { indicatorValue, comparisonText, absenceText, portraitError } = await import('../../client/src/services/networkPortraitView.mjs');
  assert.equal(indicatorValue({ status: 'published', value: 0 }), '0,0');
  assert.equal(indicatorValue({ status: 'unavailable', value: null }), 'Não disponível');
  assert.equal(indicatorValue({ status: 'suppressed', value: 0 }), 'Não disponível');
  assert.equal(comparisonText({ comparison: { comparable: true, change: 0.3, beforeYear: 2023 } }), '0,3 pontos acima de 2023.');
  assert.equal(comparisonText({ comparison: { comparable: true, change: -1, beforeYear: 2023 } }), '1,0 ponto abaixo de 2023.');
  assert.match(comparisonText({ comparison: { comparable: true, change: 0, beforeYear: 2023 } }), /Mesmo índice/);
  assert.match(comparisonText({ comparison: { comparable: false, beforeYear: 2023 } }), /Sem comparação/);
  assert.match(absenceText({ status: 'unavailable' }), /não significa nota zero/);
  assert.match(portraitError(403), /Entre novamente/);
});
test('interface separa recortes e fontes, consulta cancelável e não inclui dados internos', () => {
  const source = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../client/src/pages/NetworkPortrait.jsx'), 'utf8');
  for (const phrase of ['Ano dos dados', 'Etapa escolar', 'Fonte e cuidados', 'Não disponível', 'avaliações do LabMathic']) {
    if (phrase !== 'Não disponível') assert.ok(source.includes(phrase), phrase);
  }
  assert.match(source, /new AbortController/); assert.match(source, /snapshot\?\.key === key/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|api\.post|api\.put|api\.delete/);
});

const source = require('../src/services/ideb2025Source');
const expected = { ibgeCode: '2306405', stage: 'elementary_initial', year: '2025' };
function publication() {
  return { revision: 1, batchId: 'a'.repeat(64), available: true, dataKind: 'official_public_aggregate',
    manifest: { version: 1, edition: source.edition, indicator: 'ideb', network: 'municipal', methodologyVersion: 'ideb-nxp-2025',
      sourcePage: source.sourcePage, years: source.years, sources: structuredClone(source.sources),
      retrievedAt: '2026-09-14T04:25:00.000Z', rowsSha256: 'b'.repeat(64), placesSha256: 'c'.repeat(64), territoryVersion: source.ibge.sha256 } };
}
function result() {
  const series = [{ year: 2023, value: 6.4, status: 'published', sourceMarker: null }, { year: 2025, value: 6.7, status: 'published', sourceMarker: null }];
  return { ...publication(), municipality: { ibgeCode: '2306405', name: 'Município sintético', uf: 'CE' },
    stage: 'elementary_initial', year: 2025, current: { ...series[1] }, series,
    comparison: { comparable: true, change: 0.3, unit: 'index_0_10', beforeYear: 2023 } };
}
test('resultado recebido deve corresponder exatamente ao município, etapa e ano selecionados', async () => {
  const { parsePortraitResult } = await import('../../client/src/services/networkPortraitView.mjs');
  const valid = result(); assert.equal(parsePortraitResult(valid, expected), valid);
  for (const mutate of [r => { r.municipality.ibgeCode = '3550308'; }, r => { r.stage = 'elementary_final'; }, r => { r.year = 2023; },
    r => { r.current = null; }, r => { r.current.value = 5.5; }, r => { r.current.year = 2023; },
    r => { r.series = null; }, r => { r.series.reverse(); }, r => { r.series[0].value = '6.4'; },
    r => { r.series[0].value = -1; }, r => { r.series[0].value = 11; }, r => { r.municipality.name = '<script>'; }]) {
    const bad = result(); mutate(bad); assert.throws(() => parsePortraitResult(bad, expected));
  }
  const older = result(); older.year = 2023; older.current = { ...older.series[0] }; older.comparison = null;
  assert.equal(parsePortraitResult(older, { ...expected, year: 2023 }).year, 2023);
});
test('comparação não pode inventar diferença, porcentagem, ano anterior ou disponibilidade', async () => {
  const { parsePortraitResult } = await import('../../client/src/services/networkPortraitView.mjs');
  for (const mutate of [r => { r.comparison.change = 30; }, r => { r.comparison.unit = 'percent'; },
    r => { r.comparison.beforeYear = 2021; }, r => { r.comparison.comparable = 'true'; }, r => { r.comparison = null; },
    r => { r.series[0].status = 'unavailable'; }, r => { r.series[0].sourceMarker = 'ND'; }]) {
    const bad = result(); mutate(bad); assert.throws(() => parsePortraitResult(bad, expected));
  }
  const absent = result(); absent.series[0] = { year: 2023, value: null, status: 'unavailable', sourceMarker: '-' };
  absent.comparison = { comparable: false, change: null, beforeYear: 2023 };
  assert.equal(parsePortraitResult(absent, expected).comparison.comparable, false);
  const suppressed = result(); suppressed.current = suppressed.series[1] = { year: 2025, value: null, status: 'suppressed', sourceMarker: 'ND*' };
  suppressed.comparison = { comparable: false, change: null, beforeYear: 2023 };
  assert.equal(parsePortraitResult(suppressed, expected).current.status, 'suppressed');
});
test('fonte deve permanecer oficial e resultado ausente não carrega série antiga', async () => {
  const { parsePortraitPublication, parsePortraitResult } = await import('../../client/src/services/networkPortraitView.mjs');
  for (const mutate of [r => { r.available = 'true'; }, r => { r.revision = -1; }, r => { r.batchId = 'abc'; },
    r => { r.dataKind = 'internal'; }, r => { r.manifest.network = 'state'; }, r => { r.manifest.retrievedAt = 'ontem'; },
    r => { r.manifest.sourcePage = 'javascript:alert(1)'; }, r => { r.manifest.sourcePage += '?redirect=https://evil.invalid'; },
    r => { r.manifest.sources[0].url = 'https://evil.invalid/source'; }, r => { r.manifest.sources[0].url = 'https://download.inep.gov.br.evil.invalid/test.zip'; },
    r => { r.manifest.sources = [r.manifest.sources[0], r.manifest.sources[0]]; }, r => { r.manifest.years = [2021, 2025]; }]) {
    const bad = publication(); mutate(bad); assert.throws(() => parsePortraitPublication(bad));
  }
  const none = { available: false, revision: 0, batchId: null, manifest: null, dataKind: 'official_public_aggregate',
    municipality: null, current: null, series: [], comparison: null };
  assert.equal(parsePortraitResult(none, expected), none);
  assert.throws(() => parsePortraitResult({ ...none, series: result().series }, expected));
  assert.throws(() => parsePortraitPublication({ ...none, manifest: publication().manifest }));
});
test('busca valida formato, duplicação e volume antes de apresentar opções', async () => {
  const { parsePortraitSearch, portraitError } = await import('../../client/src/services/networkPortraitView.mjs');
  const valid = { ...publication(), municipalities: [result().municipality] };
  assert.equal(parsePortraitSearch(valid), valid);
  for (const municipalities of [null, [{ ibgeCode: 2306405, name: 'Teste', uf: 'CE' }], [null],
    [result().municipality, result().municipality], Array.from({ length: 21 }, (_, i) => ({ ibgeCode: String(1000000 + i), name: 'Teste', uf: 'CE' }))]) {
    assert.throws(() => parsePortraitSearch({ ...valid, municipalities }));
  }
  assert.match(portraitError(404, 'municipality_not_found'), /Use “Trocar”/);
  assert.match(portraitError(404, 'feature_disabled'), /liberação da sua conta/);
  assert.match(portraitError(undefined, 'portrait_response_invalid'), /Nenhum resultado foi usado/);
});
