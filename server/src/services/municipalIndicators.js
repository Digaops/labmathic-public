const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const source = require('./ideb2025Source');
const { normalizeSearch } = require('./institutionalDirectories');
const { normalizeMunicipalIndicator, compareMunicipalIndicators, catalog } = require('./municipalIndicatorsContract');
const FLAG = 'institutions.network_portrait';
const hashPattern = /^[a-f0-9]{64}$/;

function validatePrepared(batch) {
  const { manifest: m, rows, places, id } = batch || {};
  assert.ok(m && hashPattern.test(id) && id === sha256(JSON.stringify(m)), 'Identificação do lote inválida.');
  assert.ok(Object.keys(m).every(key => ['version','edition','indicator','network','years','sourcePage','methodologyVersion',
    'territoryVersion','ibge','sources','retrievedAt','rowCount','municipalityCount','placeCount','placesSha256','rowsSha256'].includes(key)), 'Metadados não previstos.');
  assert.equal(m.version, 1); assert.equal(m.edition, source.edition);
  assert.equal(m.indicator, 'ideb'); assert.equal(m.network, 'municipal');
  assert.equal(m.sourcePage, source.sourcePage); assert.equal(m.territoryVersion, source.ibge.sha256);
  assert.equal(m.methodologyVersion, 'ideb-nxp-2025');
  assert.deepEqual(m.sources, source.sources); assert.deepEqual(m.ibge, source.ibge); assert.deepEqual(m.years, source.years);
  assert.ok(Array.isArray(rows) && rows.length > 0 && rows.length <= 24000 && rows.length === m.rowCount);
  assert.ok(Array.isArray(places) && places.length > 0 && places.length <= 6000 && places.length === m.placeCount);
  assert.equal(sha256(JSON.stringify(rows)), m.rowsSha256); assert.equal(sha256(JSON.stringify(places)), m.placesSha256);
  const byCode = new Map();
  for (const place of places) {
    assert.ok(Object.keys(place).every(key => ['ibgeCode','name','uf'].includes(key)), 'Cadastro não público recusado.');
    assert.ok(/^\d{7}$/.test(place.ibgeCode) && /^[A-Z]{2}$/.test(place.uf) && typeof place.name === 'string'
      && place.name.length >= 2 && place.name.length <= 160 && !/[<>\x00-\x1f]/.test(place.name) && !byCode.has(place.ibgeCode));
    byCode.set(place.ibgeCode, place);
  }
  const keys = new Set();
  for (const row of rows) {
    assert.ok(Object.keys(row).every(key => ['ibgeCode','name','uf','stage','year','value','status','sourceMarker'].includes(key)), 'Dado fora do contrato público.');
    const place = byCode.get(row.ibgeCode), key = `${row.ibgeCode}:${row.stage}:${row.year}`;
    assert.ok(place && place.name === row.name && place.uf === row.uf && !keys.has(key), 'Linha municipal inconsistente ou repetida.');
    keys.add(key); assert.ok(source.years.includes(row.year));
    normalizeMunicipalIndicator({ ...row, indicator: 'ideb', network: 'municipal', referenceYear: row.year,
      methodologyVersion: m.methodologyVersion, territoryVersion: m.territoryVersion, artifactSha256: m.rowsSha256,
      sourceUrl: catalog.ideb.source, retrievedAt: m.retrievedAt });
    assert.ok((row.status === 'published' && row.sourceMarker === null)
      || (row.status === 'unavailable' && [null, '-'].includes(row.sourceMarker))
      || (row.status === 'suppressed' && ['ND', 'ND*', 'ND***'].includes(row.sourceMarker)), 'Marcador inconsistente.');
  }
  assert.equal(new Set(rows.map(r => r.ibgeCode)).size, m.municipalityCount);
  return batch;
}

function recordEvent(db, action, batchId, previousId = null) {
  db.prepare(`INSERT INTO municipal_indicator_events(action,batch_id,previous_batch_id,operator)
    VALUES(?,?,?,'reviewed_official_import')`).run(action, batchId, previousId);
}

// Offline operation only: no HTTP write endpoint and no implicit activation at startup.
function stageIndicators(db, batch, audit = recordEvent) {
  validatePrepared(batch);
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM municipal_indicator_batches WHERE id=?').get(batch.id)) return { id: batch.id, reused: true };
    db.prepare('INSERT INTO municipal_indicator_batches(id,manifest_json,row_count) VALUES(?,?,?)')
      .run(batch.id, JSON.stringify(batch.manifest), batch.rows.length);
    const place = db.prepare('INSERT INTO municipal_indicator_places(batch_id,ibge_code,name,uf,search_name) VALUES(?,?,?,?,?)');
    for (const p of batch.places) place.run(batch.id, p.ibgeCode, p.name, p.uf, normalizeSearch(`${p.name} ${p.uf}`));
    const insert = db.prepare(`INSERT INTO municipal_indicator_values(batch_id,ibge_code,name,uf,search_name,stage,year,value,status,source_marker)
      VALUES(?,?,?,?,?,?,?,?,?,?)`);
    for (const r of batch.rows) insert.run(batch.id, r.ibgeCode, r.name, r.uf, normalizeSearch(`${r.name} ${r.uf}`), r.stage, r.year, r.value, r.status, r.sourceMarker);
    audit(db, 'prepared', batch.id);
    return { id: batch.id, reused: false };
  }).immediate();
}

function activateIndicators(db, { batchId, expectedRevision, confirmation }, audit = recordEvent) {
  assert.ok(hashPattern.test(batchId) && Number.isSafeInteger(expectedRevision) && expectedRevision >= 0
    && confirmation === 'PUBLISH_REVIEWED_NETWORK_PORTRAIT', 'Confirmação da publicação ausente.');
  return db.transaction(() => {
    const current = db.prepare('SELECT * FROM municipal_indicator_publication WHERE id=1').get();
    assert.equal(current.revision, expectedRevision, 'A publicação mudou. Confira a versão atual.');
    const batch = db.prepare('SELECT * FROM municipal_indicator_batches WHERE id=?').get(batchId);
    assert.ok(batch && db.prepare("SELECT 1 FROM municipal_indicator_events WHERE batch_id=? AND action='prepared'").get(batchId), 'Lote não preparado.');
    assert.equal(db.prepare('SELECT COUNT(*) FROM municipal_indicator_values WHERE batch_id=?').pluck().get(batchId), batch.row_count, 'Lote incompleto.');
    if (current.batch_id === batchId) return { batchId, revision: current.revision, reused: true };
    db.prepare('UPDATE municipal_indicator_publication SET batch_id=?,revision=revision+1 WHERE id=1').run(batchId);
    audit(db, 'activated', batchId, current.batch_id);
    return { batchId, revision: current.revision + 1, reused: false };
  }).immediate();
}

function publication(db) {
  const row = db.prepare(`SELECT p.revision,b.id,b.manifest_json FROM municipal_indicator_publication p
    LEFT JOIN municipal_indicator_batches b ON b.id=p.batch_id WHERE p.id=1`).get();
  return { revision: row.revision, batchId: row.id || null, available: Boolean(row.id),
    dataKind: 'official_public_aggregate', manifest: row.id ? JSON.parse(row.manifest_json) : null };
}

function searchMunicipalities(db, query) {
  const q = normalizeSearch(query);
  const current = publication(db);
  if (!current.available || q.length < 2) return { ...current, municipalities: [] };
  return { ...current, municipalities: db.prepare(`SELECT ibge_code AS ibgeCode,name,uf FROM municipal_indicator_places
    WHERE batch_id=? AND (search_name LIKE ? OR ibge_code LIKE ?) ORDER BY search_name,ibge_code LIMIT 20`)
    .all(current.batchId, `%${q}%`, `${q}%`) };
}

function portrait(db, { ibgeCode, stage, year }) {
  const current = publication(db);
  if (!current.available) return { ...current, municipality: null, current: null, series: [], comparison: null };
  const municipality = db.prepare('SELECT ibge_code AS ibgeCode,name,uf FROM municipal_indicator_places WHERE batch_id=? AND ibge_code=?').get(current.batchId, ibgeCode);
  if (!municipality) return null;
  const rows = db.prepare(`SELECT year,value,status,source_marker AS sourceMarker FROM municipal_indicator_values
    WHERE batch_id=? AND ibge_code=? AND stage=? ORDER BY year`).all(current.batchId, ibgeCode, stage);
  const series = source.years.map(y => rows.find(r => r.year === y) || { year: y, value: null, status: 'unavailable', sourceMarker: null });
  const selected = series.find(r => r.year === year), before = series.find(r => r.year === year - 2);
  const normalized = row => ({ indicator: 'ideb', ibgeCode, network: 'municipal', stage, referenceYear: row.year,
    status: row.status, value: row.value, methodologyVersion: current.manifest.methodologyVersion,
    territoryVersion: current.manifest.territoryVersion, sourceUrl: catalog.ideb.source,
    retrievedAt: current.manifest.retrievedAt, artifactSha256: current.manifest.rowsSha256 });
  const comparison = before ? { ...compareMunicipalIndicators(normalized(before), normalized(selected)), beforeYear: before.year } : null;
  return { ...current, municipality, stage, year, current: selected, series, comparison };
}

module.exports = { FLAG, validatePrepared, stageIndicators, activateIndicators, publication, searchMunicipalities, portrait };
