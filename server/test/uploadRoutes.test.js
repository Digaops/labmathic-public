const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-upload-routes-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'synthetic-upload-routes-secret-not-used-outside-tests';
const express = require('express');
const db = require('../src/database');
const { issueUserToken } = require('../src/services/authSessions');
const app = express();
app.use(express.json());
app.use('/api/collections', require('../src/routes/collections'));
app.use('/api/materials', require('../src/routes/materials'));
app.use('/uploads', require('../src/middleware/protectedUploads'));
app.use(require('../src/middleware/apiErrors'));
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><rect width="2" height="2"/></svg>';
let admin;
let token;
let server;
let base;
function files() { return fs.readdirSync(process.env.UPLOAD_DIR).sort(); }
function form(field, name, content, type = 'application/octet-stream') {
  const data = new FormData();
  data.set('name', 'Laboratório sintético'); data.set('title', 'Material sintético');
  data.set(field, new Blob([content], { type }), name);
  return data;
}
async function request(url, { method = 'POST', body, auth = token } = {}) {
  const response = await fetch(base + url, { method, headers: auth ? { Authorization: `Bearer ${auth}` } : {}, body });
  return { status: response.status, data: await response.json() };
}
async function until(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timeout waiting for isolated upload state.');
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
function slowUpload() {
  const boundary = 'synthetic-upload-boundary';
  const req = http.request(`${base}/api/collections`, { method: 'POST', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}`,
  } });
  const result = new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', res => {
      let body = ''; res.on('data', chunk => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode, data: JSON.parse(body) }));
    });
  });
  // Install rejection handling before an intentional abort.
  result.catch(() => {});
  req.write(`--${boundary}\r\nContent-Disposition: form-data; name="name"\r\n\r\nLaboratório sintético\r\n--${boundary}\r\nContent-Disposition: form-data; name="image"; filename="image.png"\r\nContent-Type: image/png\r\n\r\n`);
  req.write(PNG.subarray(0, 24));
  return { req, result, finish() { req.end(Buffer.concat([PNG.subarray(24), Buffer.from(`\r\n--${boundary}--\r\n`)])); } };
}

test.before(async () => {
  admin = Number(db.prepare("INSERT INTO users (name, email, password, role) VALUES ('Sintético', 'upload@example.invalid', 'hash', 'admin')").run().lastInsertRowid);
  token = issueUserToken(admin);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = `http://127.0.0.1:${server.address().port}`; resolve(); }); });
});
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve)); db.close();
  fs.rmSync(temp, { recursive: true, force: true });
});

test('imagem legítima com MIME genérico é aceita pela assinatura real', async () => {
  const result = await request('/api/collections', { body: form('image', 'legitima.PNG', PNG) });
  assert.equal(result.status, 201);
  assert.ok(result.data.image_path.endsWith('.png'));
});
test('SVG estático com CSS interno é aceito, CSS externo e scripts não', async () => {
  const safe = SVG.replace('<rect', '<style><![CDATA[.shape { fill: #123456; }]]></style><rect');
  assert.equal((await request('/api/collections', { body: form('image', 'grafico.svg', safe) })).status, 201);
  for (const unsafe of [SVG.replace('<rect', '<script>alert(1)</script><rect'),
    SVG.replace('<rect', '<style>@import "https://example.invalid/a.css";</style><rect')]) {
    const before = files();
    const result = await request('/api/collections', { body: form('image', 'privado.svg', unsafe) });
    assert.equal(result.status, 400); assert.equal(result.data.code, 'UPLOAD_UNSAFE_SVG');
    assert.deepEqual(files(), before);
  }
});
test('arquivo renomeado não substitui original e gera auditoria sem nome nem conteúdo do arquivo', async () => {
  const original = 'original.png'; fs.writeFileSync(path.join(process.env.UPLOAD_DIR, original), PNG);
  const id = Number(db.prepare("INSERT INTO collections (user_id, name, image_path) VALUES (?, 'Anterior', ?)").run(admin, original).lastInsertRowid);
  const before = db.prepare('SELECT * FROM collections WHERE id = ?').get(id);
  const diskBefore = files();
  const result = await request(`/api/collections/${id}`, { method: 'PUT', body: form('image', 'nome-privado.png', '<html>segredo</html>', 'image/png') });
  assert.equal(result.status, 400); assert.equal(result.data.code, 'UPLOAD_CONTENT_MISMATCH');
  assert.deepEqual(db.prepare('SELECT * FROM collections WHERE id = ?').get(id), before);
  assert.deepEqual(files(), diskBefore);
  const audit = db.prepare("SELECT metadata_json FROM activity_log WHERE action = 'upload_rejected' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(JSON.parse(audit.metadata_json), { purpose: 'image', code: 'UPLOAD_CONTENT_MISMATCH' });
});
test('SVG respeita 2 MB exatos, recusa excedente durante transmissão e limpa parcial', async () => {
  const size = 2 * 1024 * 1024;
  const exact = SVG + ' '.repeat(size - Buffer.byteLength(SVG));
  assert.equal((await request('/api/collections', { body: form('image', 'limite.svg', exact) })).status, 201);
  const before = files();
  const result = await request('/api/collections', { body: form('image', 'excesso.svg', exact + ' ') });
  assert.equal(result.status, 413); assert.deepEqual(files(), before);
});
test('limites de imagem, texto, quantidade e campos extras são respeitados sem órfãos', async () => {
  const before = files();
  const image = await request('/api/collections', { body: form('image', 'grande.png', Buffer.alloc(10 * 1024 * 1024 + 1)) });
  assert.equal(image.status, 413);
  const text = await request('/api/materials', { body: form('file', 'grande.txt', Buffer.alloc(5 * 1024 * 1024 + 1, 65)) });
  assert.equal(text.status, 413);
  const two = form('image', 'a.png', PNG); two.append('image', new Blob([PNG]), 'b.png');
  assert.equal((await request('/api/collections', { body: two })).status, 400);
  assert.equal((await request('/api/collections', { body: form('wrong', 'a.png', PNG) })).status, 400);
  assert.deepEqual(files(), before);
});
test('arquivo vazio e formato incorreto para o campo são recusados', async () => {
  const before = files();
  assert.equal((await request('/api/materials', { body: form('file', 'vazio.pdf', '') })).data.code, 'UPLOAD_EMPTY');
  assert.equal((await request('/api/collections', { body: form('image', 'aula.pdf', '%PDF-1.7\n%%EOF') })).data.code, 'UPLOAD_EXTENSION');
  assert.deepEqual(files(), before);
});
test('envio sem autenticação não grava arquivo', async () => {
  const before = files();
  assert.equal((await request('/api/materials', { auth: null, body: form('file', 'aula.txt', 'texto') })).status, 401);
  assert.deepEqual(files(), before);
});
test('troca de senha durante upload impede a gravação com sessão antiga', async () => {
  const before = files();
  const count = db.prepare('SELECT COUNT(*) FROM collections').pluck().get();
  const upload = slowUpload();
  try {
    await until(() => files().length > before.length);
    db.prepare("UPDATE users SET password = 'hash-alterado' WHERE id = ?").run(admin);
    upload.finish();
    const result = await upload.result;
    assert.equal(result.status, 401); assert.equal(result.data.code, 'UPLOAD_SESSION_EXPIRED');
    assert.equal(db.prepare('SELECT COUNT(*) FROM collections').pluck().get(), count);
    assert.deepEqual(files(), before);
  } finally { upload.req.destroy(); token = issueUserToken(admin); }
});
test('upload interrompido remove somente seu arquivo parcial', async () => {
  const before = files();
  const upload = slowUpload();
  try {
    await until(() => files().length > before.length);
    upload.req.destroy();
    await until(() => files().length === before.length);
    assert.deepEqual(files(), before);
  } finally { upload.req.destroy(); }
});

test('frontend e API usam a mesma política de tamanho e extensão', async () => {
  const { uploadSelectionError, imageUploadHint, materialAccept } = await import('../../client/src/services/uploadSelection.mjs');
  assert.match(imageUploadHint, /10 MB/); assert.match(imageUploadHint, /2 MB/);
  const policy = require('../../shared/uploadPolicy.json');
  for (const group of policy.groups) for (const ext of group.extensions) {
    assert.ok(materialAccept.split(',').includes(ext));
    assert.equal(uploadSelectionError({ name: `a${ext}`, size: group.maxMiB * 1024 * 1024 }), null);
    assert.match(uploadSelectionError({ name: `a${ext}`, size: group.maxMiB * 1024 * 1024 + 1 }), /máximo/);
  }
});
