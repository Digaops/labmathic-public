const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const {
  inspectMigrations,
  runMigrations,
} = require('../src/migrations');

const silentLogger = { info() {} };

function createTestDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-migrations-'));
  const databasePath = path.join(tempDir, 'database.sqlite');
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return db;
}

test('aplica uma migracao uma unica vez e registra seu checksum', (t) => {
  const db = createTestDatabase(t);
  const migrations = [{
    version: 1,
    name: 'create_example',
    description: 'Cria tabela usada pelo teste.',
    up(database) {
      database.exec(`
        CREATE TABLE example (
          id INTEGER PRIMARY KEY,
          value TEXT NOT NULL
        )
      `);
    },
  }];

  const firstRun = runMigrations(db, { migrations, logger: silentLogger });
  const secondRun = runMigrations(db, { migrations, logger: silentLogger });

  assert.equal(firstRun.appliedNow.length, 1);
  assert.equal(secondRun.appliedNow.length, 0);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    1
  );
  assert.match(
    db.prepare('SELECT checksum FROM schema_migrations WHERE version = 1').get().checksum,
    /^[a-f0-9]{64}$/
  );
});

test('reverte integralmente uma migracao que falha', (t) => {
  const db = createTestDatabase(t);
  const migrations = [
    {
      version: 1,
      name: 'create_stable_table',
      up(database) {
        database.exec('CREATE TABLE stable_table (id INTEGER PRIMARY KEY)');
      },
    },
    {
      version: 2,
      name: 'failing_migration',
      up(database) {
        database.exec('CREATE TABLE must_be_rolled_back (id INTEGER PRIMARY KEY)');
        throw new Error('falha simulada');
      },
    },
  ];

  assert.throws(
    () => runMigrations(db, { migrations, logger: silentLogger }),
    /falha simulada/
  );

  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM schema_migrations').get().count,
    1
  );
  assert.equal(
    db.prepare(`
      SELECT COUNT(*) AS count
      FROM sqlite_master
      WHERE type = 'table' AND name = 'must_be_rolled_back'
    `).get().count,
    0
  );
});

test('bloqueia a inicializacao quando uma migracao aplicada foi alterada', (t) => {
  const db = createTestDatabase(t);
  const original = [{
    version: 1,
    name: 'immutable_migration',
    up(database) {
      database.exec('CREATE TABLE immutable_table (id INTEGER PRIMARY KEY)');
    },
  }];

  runMigrations(db, { migrations: original, logger: silentLogger });

  const changed = [{
    version: 1,
    name: 'immutable_migration',
    up(database) {
      database.exec('CREATE TABLE modified_table (id INTEGER PRIMARY KEY)');
    },
  }];

  assert.throws(
    () => runMigrations(db, { migrations: changed, logger: silentLogger }),
    /Migracoes ja aplicadas foram alteradas/
  );

  const status = inspectMigrations(db, changed);
  assert.equal(status.changed.length, 1);
});
