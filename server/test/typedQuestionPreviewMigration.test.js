const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration020 = require('../src/migrations/020_typed_question_preview');

test('migração 020 adiciona somente a flag de prévia desligada por padrão', () => {
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
    `);
    migration002.up(db);
    db.prepare(`
      INSERT INTO product_releases (version, title, description, status)
      VALUES ('2.2.0', 'Motor tipado', 'Fundação paralela de questões tipadas.', 'draft')
    `).run();
    const tablesBefore = db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name
    `).all().map((row) => row.name);

    migration020.up(db);

    const flag = db.prepare(`
      SELECT ff.*, release.version AS release_version, release.status AS release_status
      FROM feature_flags ff
      JOIN product_releases release ON release.id = ff.release_id
      WHERE ff.flag_key = 'question_bank.typed_preview'
    `).get();
    assert.ok(flag);
    assert.equal(flag.release_version, '2.2.0');
    assert.equal(flag.release_status, 'draft');
    assert.equal(flag.master_enabled, 0);
    assert.equal(flag.default_enabled, 0);
    assert.equal(flag.rollout_percentage, 0);
    assert.deepEqual(
      db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all().map((row) => row.name),
      tablesBefore,
      'a migração de prévia não deve criar tabelas funcionais',
    );
  } finally {
    db.close();
  }
});
