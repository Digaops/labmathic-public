const test = require('node:test'), assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-insights-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite'); process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-insights-38';
const express = require('express'), db = require('../src/database'), { issueUserToken } = require('../src/services/authSessions');
const { logActivityStrict } = require('../src/helpers/activity'), { csvCell } = require('../src/services/reportCsv');
const app = express(); app.use(express.json()); app.use('/api/reports', require('../src/routes/reports')); app.use('/api/activity', require('../src/routes/activity')); app.use(require('../src/middleware/apiErrors'));
let server, base, admin, teacher, token, teacherToken, material;
test.before(async () => {
  const insert = (name, role) => Number(db.prepare('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)').run(name, role + '@example.invalid', 'hash', role).lastInsertRowid);
  admin = insert('Admin QA38', 'admin'); teacher = insert(' =HYPERLINK("unsafe")', 'professor'); token = issueUserToken(admin); teacherToken = issueUserToken(teacher);
  material = Number(db.prepare('INSERT INTO materials(title) VALUES (?)').run('=1+1,"texto"\r\nlinha').lastInsertRowid);
  db.prepare('INSERT INTO access_history(user_id,material_id) VALUES (?,?)').run(teacher, material);
  logActivityStrict({ user: teacher, action: 'login', module: 'auth', description: 'Entrada 100%_literal' });
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}/api`; resolve(); }); });
});
test.after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-insights-/); fs.rmSync(temp, { recursive: true, force: true }); });
async function request(route, auth = token) { const r = await fetch(base + route, { headers: auth ? { Authorization: 'Bearer ' + auth } : {} }); const text = await r.text(); return { status: r.status, body: r.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text, cache: r.headers.get('cache-control'), type: r.headers.get('content-type') }; }

test('relatórios e histórico administrativo exigem administrador; histórico pessoal continua privado', async () => {
  for (const route of ['/reports/overview', '/reports/top-materials', '/reports/top-content', '/reports/top-users', '/reports/access-timeline', '/reports/question-bank-usage', '/reports/export/users', '/activity/timeline', '/activity/summary']) {
    assert.equal((await request(route, null)).status, 401); assert.equal((await request(route, teacherToken)).status, 403); const r = await request(route); assert.equal(r.status, 200); assert.match(r.cache, /no-store/);
  }
  const personal = await request('/activity/me', teacherToken); assert.equal(personal.status, 200); assert.ok(personal.body.every(row => row.user_id === teacher));
});
test('consultas mantêm dados e contratos sem nenhuma escrita', async () => {
  const counts = () => Object.fromEntries(['users', 'materials', 'activity_log', 'access_history', 'questions', 'question_sets'].map(table => [table, db.prepare('SELECT COUNT(*) FROM ' + table).pluck().get()]));
  const before = counts(); const overview = (await request('/reports/overview')).body; assert.equal(overview.totalMaterials, 1); assert.equal(overview.totalMaterialAccesses, 1); assert.equal(overview.totalSystemAccesses, 1);
  assert.equal((await request('/reports/top-materials')).body[0].title, '=1+1,"texto"\r\nlinha');
  for (const type of ['materials', 'users', 'accesses']) { const r = await request('/reports/export/' + type); assert.equal(r.status, 200); assert.match(r.type, /text\/csv/); }
  assert.deepEqual(counts(), before);
});
test('CSV conserva colunas, aspas e linhas; texto semelhante a fórmula recebe proteção', async () => {
  for (const value of ['=1+1', '+SUM(1)', '-1+1', '@SUM(1)', '  =x', '\t=x', '\r=x', '\n=x', '\u0000=x']) assert.ok(csvCell(value).startsWith('"\''), JSON.stringify(value));
  assert.equal(csvCell('nome,"escola"\r\nlinha'), '"nome,""escola""\r\nlinha"'); assert.equal(csvCell(null), '""');
  const users = (await request('/reports/export/users')).body; assert.ok(users.includes('"\' =HYPERLINK(""unsafe"")"')); assert.equal(users.includes('hash'), false);
  const materials = (await request('/reports/export/materials')).body; assert.ok(materials.includes('"\'=1+1,""texto""\r\nlinha"')); assert.equal((await request('/reports/export/unknown')).status, 400);
});
test('limites, datas e filtros malformados são recusados sem falha interna', async () => {
  for (const suffix of ['limit=-1', 'limit=2.2', 'limit[]=2', 'limit=Infinity', 'limit=9007199254740992']) for (const endpoint of ['/reports/top-materials?', '/reports/top-users?', '/reports/top-content?', '/activity/timeline?', '/activity/me?']) assert.equal((await request(endpoint + suffix)).status, 400);
  for (const query of ['page=-1', 'page=abc', 'user_id=NaN', 'module[]=auth', 'search[]=text', 'critical_only=maybe', 'snapshot_id=-1', 'date_from=2026-02-30', 'date_from=2026-09-20&date_to=2026-09-10', 'date_from=2026-09-10&date_before=2026-09-10', 'search=' + 'a'.repeat(201)]) assert.equal((await request('/activity/timeline?' + query)).status, 400);
  assert.equal((await request('/activity/timeline?limit=1000')).body.pagination.limit, 100);
});
test('busca trata porcentagem e sublinhado como texto, datas inclusiva/exclusiva e filtros combinados', async () => {
  logActivityStrict({ user: admin, action: 'delete_material', module: 'materials', description: 'Exclusão sintética para filtro', isCritical: true });
  db.prepare("UPDATE activity_log SET created_at='2026-09-11 02:59:59' WHERE action='login'").run();
  db.prepare("UPDATE activity_log SET created_at='2026-09-11 03:00:00' WHERE action='delete_material'").run();
  assert.equal((await request('/activity/timeline?search=' + encodeURIComponent('100%_literal'))).body.data.length, 1);
  const filtered = await request('/activity/timeline?module=materials&action=delete_material&user_role=admin&user_id=' + admin + '&critical_only=1&date_from=2026-09-11T03:00:00Z&date_before=2026-09-12T03:00:00Z'); assert.equal(filtered.body.data.length, 1);
  assert.equal((await request('/activity/timeline?date_to=2026-09-11T02:59:59Z')).body.data.length, 1);
  assert.equal((await request('/activity/timeline?date_before=2026-09-11T03:00:00Z')).body.data.length, 1);
});
test('paginação com snapshot não repete registros quando novos eventos chegam', async () => {
  for (let n = 0; n < 43; n++) logActivityStrict({ user: admin, action: 'qa38_page', module: 'admin', description: 'Registro ' + n });
  const first = (await request('/activity/timeline?action=qa38_page&limit=20')).body; assert.equal(first.data.length, 20);
  logActivityStrict({ user: admin, action: 'qa38_page', module: 'admin', description: 'Novo registro durante consulta' });
  const second = (await request('/activity/timeline?action=qa38_page&limit=20&page=2&snapshot_id=' + first.snapshot_id)).body;
  assert.equal(second.pagination.total, first.pagination.total); assert.equal(second.snapshot_id, first.snapshot_id); assert.ok(second.data.every(row => !first.data.some(old => old.id === row.id))); assert.equal(second.data.length, 20);
  assert.equal((await request('/activity/timeline?action=qa38_page&limit=20')).body.pagination.total, first.pagination.total + 1);
  assert.equal((await request('/activity/timeline?snapshot_id=0')).body.data.length, 0);
});
