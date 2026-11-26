const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-network-portrait-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(directory, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(directory, 'uploads');
process.env.JWT_SECRET = 'synthetic-network-portrait-only'; process.env.SMTP_USER = ''; process.env.SMTP_PASS = '';
const db = require('../src/database'), express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const { parseIdebRows, sha256 } = require('../src/services/idebImport');
const source = require('../src/services/ideb2025Source');
const { validatePrepared, stageIndicators, activateIndicators, publication, portrait } = require('../src/services/municipalIndicators');
const places = [{ ibgeCode: '2306405', name: 'Município de teste', uf: 'CE' }, { ibgeCode: '3550308', name: 'São Teste', uf: 'SP' }];
const header = ['SG_UF', 'CO_MUNICIPIO', 'REDE', 'VL_OBSERVADO_2023', 'VL_OBSERVADO_2025'];
const map = new Map(places.map(p => [p.ibgeCode, p]));
function batch(version = 1) {
  const rows = parseIdebRows([header, ['CE', 2306405, 'Municipal', 0, version === 1 ? 5.6 : 5.7]], 'elementary_initial', map);
  const manifest = { version: 1, edition: source.edition, indicator: 'ideb', network: 'municipal', years: source.years,
    sourcePage: source.sourcePage, sources: source.sources, ibge: source.ibge, territoryVersion: source.ibge.sha256,
    methodologyVersion: 'ideb-nxp-2025', retrievedAt: '2026-09-14T04:25:00.000Z', rowCount: rows.length,
    municipalityCount: 1, placeCount: places.length, placesSha256: sha256(JSON.stringify(places)), rowsSha256: sha256(JSON.stringify(rows)) };
  return { manifest, rows, places, id: sha256(JSON.stringify(manifest)) };
}
const app = express(); app.use(express.json());
for (const [url, module] of [['auth','auth'], ['governance','governance'], ['notifications','notifications'],
  ['announcements','announcements'], ['support','support'], ['institutions/read-model','institutionalReadModel'], ['municipal-indicators','municipalIndicators']]) app.use('/api/' + url, require('../src/routes/' + module));
app.use('/api', (_req, res) => res.status(404).json({ error: 'Fora do escopo desta fixture.' }));
const build = path.resolve(__dirname, '../../tmp/network-portrait-build');
app.use(express.static(build)); app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
app.use(require('../src/middleware/apiErrors'));
let server, base, teacher, admin, token, adminToken;
const flag = enabled => db.prepare("UPDATE feature_flags SET master_enabled=?,default_enabled=? WHERE flag_key='institutions.network_portrait'").run(enabled, enabled);
const request = async (url = '', auth = token, method = 'GET') => {
  const response = await fetch(base + '/api/municipal-indicators' + url, { method, headers: auth ? { Authorization: 'Bearer ' + auth } : {} });
  return { status: response.status, body: await response.json(), cache: response.headers.get('cache-control') };
};
test.before(async () => {
  const password = require('bcryptjs').hashSync('Retrato-Sintetico-2026!', 8);
  const account = role => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run('QA Retrato ' + role, `portrait-${role}@example.invalid`, password, role).lastInsertRowid);
  teacher = account('professor'); admin = account('admin'); token = issueUserToken(teacher); adminToken = issueUserToken(admin);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close();
  assert.equal(path.dirname(fs.realpathSync(directory)), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(directory), /^labmathic-network-portrait-/); fs.rmSync(directory, { recursive: true, force: true });
});

test('importador seleciona somente rede municipal, mantém zero e não inventa valor para ausência', () => {
  const rows = parseIdebRows([header, ['CE', 2306405, 'Estadual', 9, 9], ['CE', 2306405, 'Pública', 8, 8], ['CE', 2306405, 'Municipal', 0, '-']], 'elementary_final', map);
  assert.equal(rows.length, 2); assert.equal(rows[0].value, 0); assert.equal(rows[0].status, 'published');
  assert.equal(rows[1].value, null); assert.equal(rows[1].status, 'unavailable');
  assert.equal(parseIdebRows([header, ['CE', 2306405, 'Municipal', 'ND', 'ND*']], 'elementary_initial', map)[0].status, 'suppressed');
});
test('importador recusa formato mudado, duplicação, recorte errado e município sem confirmação IBGE', () => {
  for (const rows of [[['CO_MUNICIPIO']], [header, ['SP', 2306405, 'Municipal', 5, 6]],
    [header, ['CE', 9999999, 'Municipal', 5, 6]], [header, ['CE', 2306405, 'Municipal', '5,6', 6]],
    [header, ['CE', 2306405, 'Municipal', 5, 11]], [header, ['CE', 2306405, 'Municipal', '?', 6]],
    [header, ['CE', 2306405, 'Municipal', 5, 6], ['CE', 2306405, 'Municipal', 5, 6]]]) assert.throws(() => parseIdebRows(rows, 'elementary_initial', map));
  assert.throws(() => parseIdebRows([header], 'secondary', map));
});
test('flag nasce desligada, acesso anônimo é negado e preparação não publica os dados', async () => {
  assert.equal((await request('', null)).status, 401);
  assert.equal((await request()).status, 404); assert.equal((await request('', adminToken)).status, 404);
  const b = batch(); assert.equal(stageIndicators(db, b).reused, false); assert.equal(stageIndicators(db, b).reused, true);
  assert.equal(publication(db).available, false);
  flag(1); const response = await request(); assert.equal(response.status, 200); assert.equal(response.body.available, false);
  assert.match(response.cache, /no-store/);
});
test('ativação exige revisão e confirmação; consulta pública agregada é igual entre perfis autorizados', async () => {
  const b = batch(); assert.throws(() => activateIndicators(db, { batchId: b.id, expectedRevision: 0 }));
  activateIndicators(db, { batchId: b.id, expectedRevision: 0, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' });
  assert.throws(() => activateIndicators(db, { batchId: b.id, expectedRevision: 0, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' }));
  const url = '/municipalities/2306405?stage=elementary_initial&year=2025';
  const a = await request(url), bResult = await request(url, adminToken);
  assert.deepEqual(a.body, bResult.body); assert.equal(a.body.current.value, 5.6); assert.equal(a.body.comparison.change, 5.6);
  assert.equal(a.body.dataKind, 'official_public_aggregate'); assert.doesNotMatch(JSON.stringify(a.body), /teacherId|studentId|studentName|enrollment|email/);
  const absent = await request('/municipalities/3550308?stage=elementary_final&year=2025');
  assert.equal(absent.body.current.status, 'unavailable'); assert.equal(absent.body.current.value, null); assert.equal(absent.body.comparison.comparable, false);
});
test('busca tolera acentos e código, limita resultados e rejeita parâmetros inesperados', async () => {
  assert.equal((await request('/municipalities?q=sao')).body.municipalities[0].ibgeCode, '3550308');
  assert.equal((await request('/municipalities?q=2306')).body.municipalities[0].ibgeCode, '2306405');
  assert.deepEqual((await request('/municipalities?q=zzzzzz')).body.municipalities, []);
  for (const url of ['?url=http://localhost', '/municipalities?q=a', '/municipalities?q[]=abc', '/municipalities?q=abc&network=state',
    '/municipalities/2306405?stage=secondary&year=2025', '/municipalities/2306405?stage=elementary_initial&year=2026', '/municipalities/1?stage=elementary_initial&year=2025']) assert.equal((await request(url)).status, 400);
  assert.equal((await request('/municipalities/9999999?stage=elementary_initial&year=2025')).status, 404);
  assert.equal((await request('', token, 'POST')).status, 404);
});
test('falha de auditoria não deixa lote parcial nem troca a publicação; histórico permanece imutável', () => {
  const b = batch(2), before = publication(db), fail = () => { throw new Error('audit unavailable'); };
  assert.throws(() => stageIndicators(db, b, fail), /audit/);
  assert.equal(db.prepare('SELECT 1 FROM municipal_indicator_batches WHERE id=?').get(b.id), undefined);
  stageIndicators(db, b);
  assert.throws(() => activateIndicators(db, { batchId: b.id, expectedRevision: 1, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' }, fail), /audit/);
  assert.deepEqual(publication(db), before);
  activateIndicators(db, { batchId: b.id, expectedRevision: 1, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' });
  assert.equal(db.prepare('SELECT COUNT(*) FROM municipal_indicator_batches').pluck().get(), 2);
  assert.throws(() => db.exec('UPDATE municipal_indicator_values SET value=1'), /immutable/);
  assert.throws(() => db.exec('DELETE FROM municipal_indicator_events'), /immutable/);
  assert.throws(() => db.prepare('INSERT INTO municipal_indicator_places VALUES(?,?,?,?,?)').run(b.id, '1111111', 'Outro', 'CE', 'outro'), /sealed/);
  assert.deepEqual(db.pragma('foreign_key_check'), []); assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
});
test('lote adulterado é recusado e revogação da sessão/flag continua valendo em toda leitura', async () => {
  const altered = batch(); altered.rows[0].value = 7; assert.throws(() => validatePrepared(altered));
  const alteredSource = batch(); alteredSource.manifest.network = 'state'; alteredSource.id = sha256(JSON.stringify(alteredSource.manifest)); assert.throws(() => validatePrepared(alteredSource));
  const privateField = batch(); privateField.manifest.teacherEmail = 'fixture@example.invalid'; privateField.id = sha256(JSON.stringify(privateField.manifest)); assert.throws(() => validatePrepared(privateField));
  flag(0); assert.equal((await request('/municipalities?q=teste')).status, 404); flag(1);
  db.prepare('UPDATE users SET auth_version=auth_version+1 WHERE id=?').run(admin);
  assert.equal((await request('', adminToken)).status, 401);
});

test('API e validadores da interface concordam em todos os recortes, inclusive ausência e busca', async () => {
  const { parsePortraitPublication, parsePortraitSearch, parsePortraitResult } = await import('../../client/src/services/networkPortraitView.mjs');
  assert.equal(parsePortraitPublication((await request()).body).available, true);
  assert.equal(parsePortraitSearch((await request('/municipalities?q=sao')).body).municipalities[0].ibgeCode, '3550308');
  for (const ibgeCode of ['2306405', '3550308']) for (const stage of ['elementary_initial', 'elementary_final']) for (const year of [2023, 2025]) {
    const r = await request(`/municipalities/${ibgeCode}?stage=${stage}&year=${year}`);
    assert.equal(r.status, 200); assert.equal(parsePortraitResult(r.body, { ibgeCode, stage, year }).year, year);
  }
  flag(0); assert.equal((await request('/municipalities/2306405?stage=elementary_initial&year=2025')).status, 404);
  flag(1);
});

test('navegação interativa opt-in com lote oficial em banco descartável', { skip: process.env.NETWORK_PORTRAIT_AUDIT !== '1' }, async () => {
  const root = path.resolve(__dirname, '../..'), output = path.join(root, 'tmp/network-portrait-audit');
  fs.mkdirSync(output, { recursive: true });
  const batchFile = path.join(root, 'tmp/retrato-prepared-20260914/batch.json');
  const realBatch = JSON.parse(fs.readFileSync(batchFile, 'utf8'));
  stageIndicators(db, realBatch); activateIndicators(db, { batchId: realBatch.id, expectedRevision: publication(db).revision, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' });
  assert.equal(portrait(db, { ibgeCode: '2306405', stage: 'elementary_initial', year: 2025 }).current.value, 6.7);
  const connection = path.join(output, 'connection.json'), stop = path.join(output, 'stop');
  assert.ok(!fs.existsSync(connection) && !fs.existsSync(stop));
  fs.writeFileSync(connection, JSON.stringify({ baseUrl: base, databasePath: db.name, email: 'portrait-professor@example.invalid', password: 'Retrato-Sintetico-2026!', batchId: realBatch.id }));
  console.log('Network portrait fixture:', base);
  try { const start = Date.now(); while (!fs.existsSync(stop) && Date.now() - start < 3600000) await new Promise(r => setTimeout(r, 250)); }
  finally { fs.unlinkSync(connection); if (fs.existsSync(stop)) fs.unlinkSync(stop); }
});
