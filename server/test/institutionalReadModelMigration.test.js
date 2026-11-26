const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const migration019 = require('../src/migrations/019_institutional_read_model');

test('migração 019 adiciona apenas a flag read-only desligada por padrão', () => {
  const db = new Database(':memory:');
  try {
    db.pragma('foreign_keys = ON');
    db.exec(`
      CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        role TEXT NOT NULL CHECK(role IN ('professor', 'admin'))
      );
      CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
      CREATE TABLE grades (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    `);
    migration002.up(db);
    migration003.up(db);
    migration016.up(db);
    const tablesBefore = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => row.name);

    migration019.up(db);

    const flag = db.prepare(`
      SELECT ff.*, release.version AS release_version, release.status AS release_status
      FROM feature_flags ff
      JOIN product_releases release ON release.id = ff.release_id
      WHERE ff.flag_key = 'institutions.read_model'
    `).get();
    assert.ok(flag);
    assert.equal(flag.release_version, '2.1.0');
    assert.equal(flag.release_status, 'draft');
    assert.equal(flag.master_enabled, 0);
    assert.equal(flag.default_enabled, 0);
    assert.equal(flag.rollout_percentage, 0);
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all().map((row) => row.name),
      tablesBefore,
      'a migração de visibilidade não deve criar estruturas de dados paralelas',
    );
  } finally {
    db.close();
  }
});
