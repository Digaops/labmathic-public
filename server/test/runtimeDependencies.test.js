const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const { once } = require('node:events');
const express = require('express');
const compression = require('compression');

// These servers expose synthetic responses on loopback only. No config, database,
// SMTP, user credentials or external provider is loaded by this suite.
async function serve(t, app) {
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  return `http://127.0.0.1:${server.address().port}`;
}

test('compressão preserva JSON e negociação de gzip', async t => {
  const app = express();
  const body = { title: 'Avaliação sintética', description: 'Conteúdo pedagógico. '.repeat(150) };
  app.use(compression());
  app.get('/', (_req, res) => res.json(body));
  const base = await serve(t, app);
  const response = await new Promise((resolve, reject) => {
    http.get(base, { headers: { 'Accept-Encoding': 'gzip' } }, res => {
      const chunks = [];
      res.on('error', reject);
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => resolve({ headers: res.headers, body: Buffer.concat(chunks) }));
    }).on('error', reject);
  });
  assert.equal(response.headers['content-encoding'], 'gzip');
  assert.match(response.headers.vary, /Accept-Encoding/i);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(response.body)), body);
});

test('resposta interrompida destrói seu compressor, sem manter memória nativa pendente', { timeout: 10000 }, async t => {
  const descriptor = Object.getOwnPropertyDescriptor(zlib, 'createGzip');
  const streams = [];
  Object.defineProperty(zlib, 'createGzip', { ...descriptor, value(...args) {
    const stream = descriptor.value(...args);
    streams.push(stream);
    return stream;
  } });
  t.after(() => {
    Object.defineProperty(zlib, 'createGzip', descriptor);
    for (const stream of streams) stream.destroy();
  });
  const app = express();
  app.use(compression({ threshold: 0 }));
  app.get('/', (_req, res) => {
    res.type('text/plain');
    res.write('Resposta sintética ainda em transmissão.');
    res.flush();
    // Intentionally do not end: the client closes before transmission finishes.
  });
  const base = await serve(t, app);
  const request = http.get(base, { headers: { 'Accept-Encoding': 'gzip' } });
  request.on('error', () => {}); // Intentional client abort, not an unhandled error.
  t.after(() => request.destroy());
  const [response] = await once(request, 'response');
  response.on('error', () => {});
  const compressor = streams[0];
  assert.ok(compressor);
  const closed = once(compressor, 'close', { signal: AbortSignal.timeout(5000) });
  response.destroy();
  request.destroy();
  await closed;
  assert.equal(compressor.destroyed, true);
});

test('proxy de um salto mantém IP adjacente e não aceita origem anterior arbitrária', async t => {
  const app = express();
  app.set('trust proxy', 1); // Same policy as application startup behind its proxy.
  app.get('/', (req, res) => res.json({ ip: req.ip, ips: req.ips }));
  const base = await serve(t, app);
  const forwarded = await fetch(base, { headers: { 'X-Forwarded-For': '198.51.100.99, 192.0.2.7' } });
  assert.deepEqual(await forwarded.json(), { ip: '192.0.2.7', ips: ['192.0.2.7'] });
  const direct = await fetch(base);
  assert.deepEqual(await direct.json(), { ip: '127.0.0.1', ips: [] });
  // This does not prove external proxy topology. Production must still restrict
  // direct access to the application and sanitize forwarding headers at the edge.
});
