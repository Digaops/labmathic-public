const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-catalog-preview-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDirectory, 'database.sqlite');
process.env.JWT_SECRET = 'catalog-preview-route-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const router = require('../src/routes/questionBankCatalogPreview');

const app = express();
app.use(express.json());
app.use('/api/question-bank/catalog-preview', router);
app.use((_req, res) => res.status(404).json({ error: 'Rota de teste não prevista.' }));

let server;
let baseUrl;
let admin;
let professor;

function addUser(name, email, role) {
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-sintetico', ?)
  `).run(name, email, role).lastInsertRowid);
  return { id, name, email, role };
}

function tokenFor(user, overrides = {}) {
  return jwt.sign({ ...user, ...overrides }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function enableFor(...users) {
  const flagId = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'question_bank.catalog_preview'
  `).pluck().get();
  db.prepare(`UPDATE feature_flags SET master_enabled = 1 WHERE id = ?`).run(flagId);
  const addRule = db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Catálogo sintético somente leitura', ?, ?)
  `);
  for (const user of users) addRule.run(flagId, user.id, admin.id, admin.id);
}

async function request(pathname, { token, method = 'GET' } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${baseUrl}/api/question-bank/catalog-preview${pathname}`, {
    method,
    headers,
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'),
    payload: await response.json(),
  };
}

test.before(async () => {
  admin = addUser('Admin do Catálogo', 'admin-catalogo@teste.local', 'admin');
  professor = addUser('Professora do Catálogo', 'professora-catalogo@teste.local', 'professor');
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  await new Promise((resolve) => server.close(resolve));
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('exige autenticação e falha fechada antes de revelar o catálogo', async () => {
  const unauthenticated = await request('/catalog');
  assert.equal(unauthenticated.status, 401);
  assert.match(unauthenticated.cacheControl, /no-store/);

  const disabled = await request('/catalog', { token: tokenFor(professor) });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.payload.code, 'feature_disabled');
  enableFor(admin, professor);
});

test('admin e professor recebem o mesmo catálogo sintético sem escrita', async () => {
  const beforeChanges = db.prepare('SELECT total_changes()').pluck().get();
  for (const user of [admin, professor]) {
    const response = await request('/catalog', {
      token: tokenFor(user, { role: user === admin ? 'professor' : 'admin' }),
    });
    assert.equal(response.status, 200);
    assert.match(response.cacheControl, /no-store/);
    assert.match(response.vary, /Authorization/);
    assert.equal(response.payload.synthetic, true);
    assert.equal(response.payload.readOnly, true);
    assert.equal(response.payload.items.length, 6);
    assert.doesNotMatch(JSON.stringify(response.payload), /"(?:answerKey|student|response)"\s*:/);
  }
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), beforeChanges);
});

test('rota combina filtros allowlisted e entrega dossiê explicável', async () => {
  const token = tokenFor(professor);
  const filtered = await request('/catalog?grade=5%C2%BA%20ano&unit=N%C3%BAmeros&source=official&printReady=true', { token });
  assert.equal(filtered.status, 200);
  assert.equal(filtered.payload.total, 1);
  assert.equal(filtered.payload.items[0].id, 'fraction-equivalence-review');

  const detail = await request('/items/fraction-ordering-review', { token });
  assert.equal(detail.status, 200);
  assert.equal(detail.payload.item.criteria.length, 7);
  assert.equal(detail.payload.item.criteria.some((criterion) => criterion.state === 'attention'), true);
  assert.equal(Object.hasOwn(detail.payload.item, 'qualityScore'), false);
});

test('parâmetros inválidos, usuário inexistente e escrita não alteram o banco', async () => {
  const beforeChanges = db.prepare('SELECT total_changes()').pluck().get();
  const invalid = await request('/catalog?reviewStatus=invented', { token: tokenFor(professor) });
  assert.equal(invalid.status, 400);
  assert.equal(invalid.payload.code, 'invalid_filter');

  const unknown = await request('/catalog?page=1', { token: tokenFor(professor) });
  assert.equal(unknown.status, 400);
  assert.equal(unknown.payload.code, 'unknown_filter');

  const missing = await request('/items/missing', { token: tokenFor(professor) });
  assert.equal(missing.status, 404);
  assert.equal(missing.payload.code, 'catalog_preview_item_not_found');

  const missingUser = await request('/catalog', {
    token: tokenFor({ id: 999999, name: 'Inexistente', email: 'none@teste.local', role: 'admin' }),
  });
  assert.equal(missingUser.status, 401);

  const post = await request('/catalog', { token: tokenFor(professor), method: 'POST' });
  assert.equal(post.status, 404);
  assert.equal(db.prepare('SELECT total_changes()').pluck().get(), beforeChanges);
});
