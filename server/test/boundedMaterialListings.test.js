const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// Every database/upload path is isolated before any application module loads.
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-bounded-listings-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads');
process.env.JWT_SECRET = 'bounded-listings-synthetic-test-secret';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';

const express = require('express');
const db = require('../src/database');
const { issueUserToken } = require('../src/services/authSessions');
const app = express();
app.use('/api/materials', require('../src/routes/materials'));
app.use('/api/notifications', require('../src/routes/notifications'));
app.use(require('../src/middleware/apiErrors'));

let server, base, teacher, other, noHistory;
const materials = [];
const expectedTopics = new Map();
const materialRoutes = ['/api/materials/recent', '/api/materials/history', '/api/materials/suggestions'];
const allRoutes = [...materialRoutes, '/api/notifications'];
const insert = (sql, ...values) => Number(db.prepare(sql).run(...values).lastInsertRowid);
const rowsOf = body => Array.isArray(body) ? body : body.notifications || body.data;

async function request(url, token = teacher.token) {
  const response = await fetch(base + url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  return { status: response.status, body: await response.json() };
}

async function withTopicReads(run) {
  const prepare = db.prepare;
  const reads = [];
  db.prepare = function (sql) {
    const statement = prepare.call(this, sql);
    if (/\b(?:FROM|JOIN)\s+material_topics\b/i.test(sql)) {
      const all = statement.all;
      statement.all = function (...parameters) {
        reads.push({ sql, parameters });
        return all.apply(this, parameters);
      };
    }
    return statement;
  };
  try { await run(reads); }
  finally { db.prepare = prepare; }
}

test.before(async () => {
  const account = name => {
    const id = insert('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)',
      name, `${name}@example.invalid`, 'synthetic-hash', 'professor');
    return { id, token: issueUserToken(id) };
  };
  teacher = account('listing-teacher');
  other = account('listing-other');
  noHistory = account('listing-no-history');
  const discipline = insert('INSERT INTO disciplines(name) VALUES (?)', 'Disciplina sintética A');
  const secondDiscipline = insert('INSERT INTO disciplines(name) VALUES (?)', 'Disciplina sintética B');
  const topics = ['Tópico sintético A', 'Tópico sintético B'].map(name => ({
    id: insert('INSERT INTO topics(name) VALUES (?)', name), name,
  }));
  for (let index = 0; index < 65; index += 1) {
    const created = new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString();
    const id = insert('INSERT INTO materials(title,discipline_id,created_by,created_at) VALUES (?,?,?,?)',
      `Material sintético ${index}`, index < 40 ? discipline : secondDiscipline, teacher.id, created);
    materials.push(id);
    const assigned = index % 3 === 0 ? [] : index % 3 === 1 ? topics.slice(0, 1) : topics;
    expectedTopics.set(id, assigned);
    // Insert in reverse order to prove the batch still provides stable topic order.
    for (const topic of [...assigned].reverse()) {
      db.prepare('INSERT INTO material_topics(material_id,topic_id) VALUES (?,?)').run(id, topic.id);
    }
    if (index < 30) db.prepare('INSERT INTO access_history(user_id,material_id,accessed_at) VALUES (?,?,?)')
      .run(teacher.id, id, created);
    if (index >= 60) db.prepare('INSERT INTO access_history(user_id,material_id,accessed_at) VALUES (?,?,?)')
      .run(other.id, id, created);
  }
  // Multiple visits must not duplicate a material or change its topics.
  db.prepare('INSERT INTO access_history(user_id,material_id,accessed_at) VALUES (?,?,?)')
    .run(teacher.id, materials[0], '2026-02-01T00:00:00.000Z');
  for (let index = 0; index < 60; index += 1) {
    db.prepare('INSERT INTO notifications(user_id,type,title,message,read,created_at) VALUES (?,?,?,?,?,?)')
      .run(teacher.id, index % 2 ? 'new_material' : 'support_reply', `Aviso sintético ${index}`,
        'Mensagem sintética', index % 3 === 0 ? 1 : 0, new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString());
  }
  for (let index = 0; index < 9; index += 1) {
    db.prepare('INSERT INTO notifications(user_id,type,title,message) VALUES (?,?,?,?)')
      .run(other.id, 'support_reply', 'Aviso de outra conta', 'Mensagem sintética');
  }
  await new Promise(resolve => {
    server = app.listen(0, '127.0.0.1', () => {
      base = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  db.close();
  const resolved = fs.realpathSync(temp);
  assert.equal(path.dirname(resolved), fs.realpathSync(os.tmpdir()));
  assert.match(path.basename(resolved), /^labmathic-bounded-listings-/);
  assert.equal(fs.lstatSync(temp).isSymbolicLink(), false);
  fs.rmSync(resolved, { recursive: true, force: true });
});

test('listagens preservam padrões, limite mínimo e teto para inteiros positivos', async () => {
  for (const route of allRoutes) {
    const fallback = route === '/api/notifications' ? 20 : 6;
    const maximum = route === '/api/notifications' ? 50 : 20;
    for (const [query, expected] of [['', fallback], ['?limit=1', 1], ['?limit=0002', 2],
      [`?limit=${maximum}`, maximum], [`?limit=${maximum + 1}`, maximum],
      ['?limit=9007199254740991', maximum]]) {
      const response = await request(route + query);
      assert.equal(response.status, 200, route + query);
      assert.equal(rowsOf(response.body).length, expected, route + query);
    }
  }
});

test('limites negativos, fracionários, não numéricos, vazios e estruturados recebem 400 claro', async () => {
  const invalid = ['-1', '-20', '0', '1.5', '6.0', 'NaN', 'Infinity', 'abc', '1x', '1e2', '0x10',
    '', ' ', '+1', '9007199254740992'];
  for (const route of allRoutes) {
    for (const value of invalid) {
      const response = await request(`${route}?limit=${encodeURIComponent(value)}`);
      assert.equal(response.status, 400, `${route}: ${JSON.stringify(value)}`);
      assert.match(response.body.error, /limit.*inteiro positivo/);
    }
    for (const query of ['?limit=1&limit=2', '?limit[]=2', '?limit[value]=2']) {
      const response = await request(route + query);
      assert.equal(response.status, 400, route + query);
      assert.match(response.body.error, /limit.*inteiro positivo/);
    }
  }
});

test('autenticação permanece obrigatória antes da validação do limite', async () => {
  for (const route of allRoutes) {
    assert.equal((await request(route, null)).status, 401);
    assert.equal((await request(route + '?limit=-1', null)).status, 401);
  }
});

test('tópicos usam uma consulta por lote sem misturar materiais, incluindo a lista paginada', async () => {
  for (const route of [...materialRoutes, '/api/materials']) {
    await withTopicReads(async reads => {
      const response = await request(route + '?limit=20');
      assert.equal(response.status, 200, route);
      const rows = rowsOf(response.body);
      assert.equal(rows.length, 20, route);
      assert.equal(new Set(rows.map(row => row.id)).size, 20, route);
      assert.equal(reads.length, 1, route);
      assert.deepEqual(new Set(reads[0].parameters), new Set(rows.map(row => row.id)), route);
      for (const row of rows) assert.deepEqual(row.topics, expectedTopics.get(row.id), `${route}: ${row.id}`);
    });
  }
});

test('histórico mantém escopo por usuário e ordenação pelo acesso mais recente', async () => {
  const history = await request('/api/materials/history?limit=20');
  assert.equal(history.body[0].id, materials[0]);
  assert.ok(history.body.every(row => materials.slice(0, 30).includes(row.id)));
  const otherHistory = await request('/api/materials/history?limit=20', other.token);
  assert.deepEqual(otherHistory.body.map(row => row.id), materials.slice(60).reverse());
  await withTopicReads(async reads => {
    const empty = await request('/api/materials/history', noHistory.token);
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);
    assert.equal(reads.length, 0);
  });
});

test('sugestões preservam disciplina mais acessada e fallback recente sem histórico', async () => {
  const suggested = await request('/api/materials/suggestions?limit=20');
  assert.deepEqual(suggested.body.map(row => row.id), materials.slice(20, 40).reverse());
  await withTopicReads(async reads => {
    const fallback = await request('/api/materials/suggestions?limit=6', noHistory.token);
    assert.equal(fallback.status, 200);
    assert.deepEqual(fallback.body.map(row => row.id), materials.slice(-6).reverse());
    assert.equal(reads.length, 1);
    for (const row of fallback.body) assert.deepEqual(row.topics, expectedTopics.get(row.id));
  });
});

test('lista paginada mantém filtros, paginação, tópicos vazios e evita consulta para resultado vazio', async () => {
  const result = await request('/api/materials?limit=2&page=2&sort=oldest');
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.pagination, { page: 2, limit: 2, total: 65, totalPages: 33 });
  assert.deepEqual(result.body.data.map(row => row.id), materials.slice(2, 4));
  assert.deepEqual(result.body.data[1].topics, []);
  await withTopicReads(async reads => {
    const empty = await request('/api/materials?search=sem-correspondencia-sintetica');
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body.data, []);
    assert.equal(empty.body.pagination.total, 0);
    assert.equal(reads.length, 0);
  });
});

test('notificações mantêm escopo e contagens totais mesmo com retorno limitado', async () => {
  const response = await request('/api/notifications?limit=1');
  assert.equal(response.status, 200);
  assert.equal(response.body.notifications.length, 1);
  assert.equal(response.body.notifications[0].title, 'Aviso sintético 59');
  assert.equal(response.body.notifications[0].user_id, teacher.id);
  assert.equal(response.body.unreadCount, 40);
  assert.equal(response.body.supportUnreadCount, 20);
  const otherResponse = await request('/api/notifications?limit=50', other.token);
  assert.equal(otherResponse.body.notifications.length, 9);
  assert.ok(otherResponse.body.notifications.every(row => row.user_id === other.id));
  assert.equal(otherResponse.body.unreadCount, 9);
  assert.equal(otherResponse.body.supportUnreadCount, 9);
});
