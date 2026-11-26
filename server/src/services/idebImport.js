const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const assert = require('node:assert/strict');
const { unzipSync } = require('fflate');
const readExcel = require('read-excel-file/node');
const source = require('./ideb2025Source');
const { validateIbgePayload } = require('./institutionalDirectories');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function officialFile(directory, definition, maxBytes) {
  const file = path.join(directory, definition.file);
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= maxBytes, 'Arquivo oficial fora dos limites.');
  const bytes = fs.readFileSync(file);
  assert.equal(sha256(bytes), definition.sha256, `Arquivo diferente da edição conferida: ${definition.file}.`);
  return bytes;
}

function parseIdebRows(rows, stage, municipalities) {
  assert.ok(source.sources.some(s => s.stage === stage), 'Etapa não permitida.');
  assert.ok(Array.isArray(rows) && rows.length <= 20000, 'Volume inesperado na planilha.');
  const headerIndex = rows.findIndex(row => Array.isArray(row) && row.includes('CO_MUNICIPIO'));
  assert.ok(headerIndex >= 0 && headerIndex <= 15, 'Cabeçalho oficial não encontrado.');
  const header = rows[headerIndex];
  const column = name => {
    assert.equal(header.filter(value => value === name).length, 1, `Coluna ausente ou repetida: ${name}.`);
    return header.indexOf(name);
  };
  const codeColumn = column('CO_MUNICIPIO'), ufColumn = column('SG_UF'), networkColumn = column('REDE');
  const valueColumns = source.years.map(year => [year, column(`VL_OBSERVADO_${year}`)]);
  const result = [], seen = new Set();
  for (const row of rows.slice(headerIndex + 1)) {
    if (!Array.isArray(row) || row[networkColumn] !== 'Municipal') continue;
    const code = String(row[codeColumn]);
    const municipality = municipalities.get(code);
    assert.ok(municipality && municipality.uf === row[ufColumn], `Município não confirmado no IBGE: ${code}.`);
    assert.ok(!seen.has(code), `Município repetido na mesma etapa: ${code}.`);
    seen.add(code);
    for (const [year, index] of valueColumns) {
      const value = row[index];
      // A dash does not establish why a result is absent. Never infer participation or zero.
      const absent = value === '-' || value === null;
      const suppressed = ['ND', 'ND*', 'ND***'].includes(value);
      assert.ok(absent || suppressed || (typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 10), 'Valor ou marcador do Ideb não reconhecido.');
      result.push({ ibgeCode: code, name: municipality.name, uf: municipality.uf, stage, year,
        value: absent || suppressed ? null : value,
        status: suppressed ? 'suppressed' : absent ? 'unavailable' : 'published',
        sourceMarker: absent || suppressed ? value : null });
    }
  }
  assert.ok(result.length > 0, 'Nenhuma linha municipal encontrada.');
  return result;
}

async function prepareIdeb(directory, { retrievedAt } = {}) {
  assert.ok(typeof retrievedAt === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(retrievedAt)
    && Number.isFinite(Date.parse(retrievedAt)) && Date.parse(retrievedAt) <= Date.now(), 'Informe a data real de obtenção dos arquivos.');
  const municipalities = new Map(validateIbgePayload(JSON.parse(officialFile(directory, source.ibge, 10e6)))
    .map(row => [row.ibgeCode, row]));
  const rows = [];
  for (const definition of source.sources) {
    // Hash is checked BEFORE decompression; no arbitrary zip/upload is parsed by the web server.
    const zip = officialFile(directory, definition, 40e6);
    const entries = unzipSync(zip, { filter: entry => entry.name.endsWith('.xlsx') });
    assert.equal(Object.keys(entries).length, 1, 'A fonte deve conter uma única planilha XLSX.');
    const workbook = await readExcel(Buffer.from(Object.values(entries)[0]), { sheets: [definition.sheet] });
    assert.equal(workbook.length, 1, 'Planilha não encontrada.');
    rows.push(...parseIdebRows(workbook[0].data, definition.stage, municipalities));
  }
  rows.sort((a, b) => a.ibgeCode.localeCompare(b.ibgeCode) || a.stage.localeCompare(b.stage) || a.year - b.year);
  assert.ok(rows.length >= 15000 && rows.length <= 24000, 'Cobertura municipal fora do esperado.');
  const places = [...municipalities.values()].map(({ ibgeCode, name, uf }) => ({ ibgeCode, name, uf })).sort((a, b) => a.ibgeCode.localeCompare(b.ibgeCode));
  const manifest = { version: 1, edition: source.edition, indicator: 'ideb', network: 'municipal',
    years: source.years, sourcePage: source.sourcePage,
    methodologyVersion: 'ideb-nxp-2025', territoryVersion: source.ibge.sha256,
    ibge: source.ibge, sources: source.sources, retrievedAt,
    rowCount: rows.length, municipalityCount: new Set(rows.map(r => r.ibgeCode)).size,
    placeCount: places.length, placesSha256: sha256(JSON.stringify(places)), rowsSha256: sha256(JSON.stringify(rows)) };
  return { manifest, rows, places, id: sha256(JSON.stringify(manifest)) };
}

module.exports = { prepareIdeb, parseIdebRows, sha256 };
