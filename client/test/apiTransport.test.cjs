const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
// Minimal browser globals activate the bundle's FormData header handling. This
// is a transport regression test with Node's fetch, not a real-browser/XHR test.
global.window = { location: { href: 'http://127.0.0.1/' } };
global.document = { cookie: '' };
const axios = require('axios/dist/browser/axios.cjs');

test('Axios do navegador preserva JSON, FormData, Blob, erro HTTP e cancelamento com fetch', { timeout: 10000 }, async t => {
  let acknowledgeSlow;
  const slowStarted = new Promise(resolve => { acknowledgeSlow = resolve; });
  // Only loopback and synthetic content; no server dependency, config or account.
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/slow') { acknowledgeSlow(); return; }
    if (req.url === '/blocked') {
      res.writeHead(403);
      res.end(JSON.stringify({ error: 'Acesso sintético recusado.' }));
      return;
    }
    if (req.url === '/blob') {
      res.setHeader('Content-Type', 'application/pdf');
      res.end('%PDF-1.7\nsynthetic');
      return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    if (req.url === '/upload') {
      res.end(JSON.stringify({ contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') }));
      return;
    }
    res.end(JSON.stringify({ received: JSON.parse(Buffer.concat(chunks)), marker: req.headers['x-test-marker'] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const client = axios.create({ baseURL: `http://127.0.0.1:${server.address().port}`, adapter: 'fetch', timeout: 5000 });
  client.interceptors.request.use(config => { config.headers['X-Test-Marker'] = 'synthetic'; return config; });
  const body = { title: 'Questão de frações', value: 0.25 };
  assert.deepEqual((await client.post('/', body)).data, { received: body, marker: 'synthetic' });
  const form = new FormData();
  form.append('title', 'Material sintético');
  form.append('file', new Blob(['conteúdo sintético'], { type: 'text/plain' }), 'teste.txt');
  const upload = (await client.post('/upload', form)).data;
  assert.match(upload.contentType, /^multipart\/form-data; boundary=.+/);
  assert.match(upload.body, /name="title"\r\n\r\nMaterial sintético/);
  assert.match(upload.body, /name="file"; filename="teste.txt"/);
  assert.match(upload.body, /conteúdo sintético/);
  const download = (await client.get('/blob', { responseType: 'blob' })).data;
  assert.ok(download instanceof Blob);
  assert.equal(download.type, 'application/pdf');
  assert.equal(await download.text(), '%PDF-1.7\nsynthetic');
  await assert.rejects(client.get('/blocked'), error => error.response?.status === 403
    && error.response.data.error === 'Acesso sintético recusado.');
  const controller = new AbortController();
  const rejected = assert.rejects(client.get('/slow', { signal: controller.signal }), error => axios.isCancel(error));
  await slowStarted;
  controller.abort();
  await rejected;
});
