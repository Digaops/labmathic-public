const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { assertProductionStartup } = require('../src/productionStartup');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-production-startup-'));
  t.after(() => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  });
  const dbPath = path.join(root, 'database.sqlite');
  const db = new Database(dbPath);
  try {
    db.pragma('user_version = 0');
  } finally {
    db.close();
  }
  const uploadDir = fs.mkdirSync(path.join(root, 'uploads'), { recursive: true });
  const clientDist = path.join(root, 'dist');
  const assets = path.join(clientDist, 'assets');
  fs.mkdirSync(assets, { recursive: true });
  const entry = path.join(assets, 'index-test.js');
  fs.writeFileSync(entry, 'export {};');
  fs.writeFileSync(path.join(assets, 'style-test.css'), 'body {}');
  fs.writeFileSync(path.join(clientDist, 'index.html'), `
    <script type="module" crossorigin src="/assets/index-test.js"></script>
    <link rel="stylesheet" href="/assets/style-test.css">
  `);
  return { root, dbPath, uploadDir, clientDist, entry };
}

test('startup recusa banco ausente ou sem cabeçalho SQLite sem criar um substituto', t => {
  const f = fixture(t);
  const missing = path.join(f.root, 'wrong', 'db.sqlite');
  assert.throws(() => assertProductionStartup({ ...f, dbPath: missing }, f.clientDist), /DB_PATH/);
  assert.equal(fs.existsSync(path.dirname(missing)), false);
  const corrupt = path.join(f.root, 'corrupt.sqlite');
  fs.writeFileSync(corrupt, Buffer.alloc(1024));
  assert.throws(() => assertProductionStartup({ ...f, dbPath: corrupt }, f.clientDist), /DB_PATH/);
});

test('startup recusa uploads inexistentes e build parcial antes de abrir a aplicação', t => {
  const f = fixture(t);
  assert.doesNotThrow(() => assertProductionStartup(f, f.clientDist));
  const missingUploads = path.join(f.root, 'wrong-uploads');
  assert.throws(() => assertProductionStartup({ ...f, uploadDir: missingUploads }, f.clientDist), /UPLOAD_DIR/);
  assert.equal(fs.existsSync(missingUploads), false);
  fs.unlinkSync(f.entry);
  assert.throws(() => assertProductionStartup(f, f.clientDist), /Build do frontend/);
});
