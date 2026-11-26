const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { runMigrations } = require('../src/migrations');
const migration001 = require('../src/migrations/001_baseline_current_schema');
const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const {
  createHomologationPreMigrationSnapshot,
} = require('../src/homologationMigrationSnapshot');

const silentLogger = { info() {} };

function removeTemporaryDirectory(tempDirectory) {
  fs.rmSync(tempDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 50,
  });
}

function createSanitizedSchema3(databasePath) {
  const db = new Database(databasePath);
  try {
    db.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE users (id INTEGER PRIMARY KEY AUTOINCREMENT, password TEXT NOT NULL DEFAULT 'synthetic', role TEXT NOT NULL DEFAULT 'professor');
      CREATE TABLE grades (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE materials (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, thumbnail_path TEXT);
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT);
    CREATE TABLE disciplines (id INTEGER PRIMARY KEY AUTOINCREMENT);
      CREATE TABLE question_sets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        is_public INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE bncc_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        grade_id INTEGER NOT NULL
      );
      CREATE TABLE questions (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT, source TEXT, created_by INTEGER,
        question_type TEXT DEFAULT 'multiple_choice', status TEXT DEFAULT 'active', skill_id INTEGER, question_code TEXT);
      CREATE TABLE question_options (id INTEGER PRIMARY KEY, question_id INTEGER);
      CREATE TABLE question_set_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        question_set_id INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        sort_order INTEGER NOT NULL DEFAULT 0,
        show_image INTEGER NOT NULL DEFAULT 1
      );
    `);
    runMigrations(db, {
      migrations: [migration001, migration002, migration003],
      logger: silentLogger,
    });
    db.exec(`
      CREATE TABLE homologation_snapshot_metadata (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        sanitized INTEGER NOT NULL CHECK (sanitized = 1),
        created_at TEXT NOT NULL
      );
      INSERT INTO homologation_snapshot_metadata (id, sanitized, created_at)
      VALUES (1, 1, '2026-08-11T00:00:00.000Z');
      CREATE TABLE snapshot_sentinel (value TEXT NOT NULL);
      INSERT INTO snapshot_sentinel (value) VALUES ('preservado');
    `);
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
}

test('cria e reutiliza snapshot sanitizado antes das migrações pendentes', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-homologation-snapshot-'));
  const databasePath = path.join(tempDirectory, 'homologation.sqlite');
  const sourceSha = 'a'.repeat(40);

  try {
    createSanitizedSchema3(databasePath);
    const first = createHomologationPreMigrationSnapshot({
      appEnvironment: 'homologation', databasePath, sourceSha,
    });
    assert.equal(first.status, 'created');
    assert.equal(first.schemaVersion, 3);
    assert.equal(first.toSchemaVersion, 43);
    assert.equal(first.integrityCheck, 'ok');
    assert.equal(first.foreignKeyViolations, 0);
    assert.equal(first.sanitized, true);

    const reused = createHomologationPreMigrationSnapshot({
      appEnvironment: 'homologation', databasePath, sourceSha,
    });
    assert.equal(reused.status, 'reused');
    assert.equal(reused.sha256, first.sha256);

    const sourceDb = new Database(databasePath);
    try {
      runMigrations(sourceDb, { logger: silentLogger });
      assert.equal(sourceDb.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 43);
    } finally { sourceDb.close(); }

    const snapshotDb = new Database(first.snapshotPath, { readonly: true });
    assert.equal(snapshotDb.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 3);
    assert.equal(snapshotDb.prepare('SELECT value FROM snapshot_sentinel').pluck().get(), 'preservado');
    assert.equal(snapshotDb.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(snapshotDb.pragma('foreign_key_check'), []);
    snapshotDb.close();

    const afterMigration = createHomologationPreMigrationSnapshot({
      appEnvironment: 'homologation', databasePath, sourceSha,
    });
    assert.deepEqual(afterMigration, { status: 'not-required', schemaVersion: 43 });
  } finally {
    removeTemporaryDirectory(tempDirectory);
  }
});

test('recusa snapshot fora de caminho identificado como homologação', () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-snapshot-'));
  const databasePath = path.join(tempDirectory, 'database.sqlite');

  try {
    createSanitizedSchema3(databasePath);
    assert.throws(
      () => createHomologationPreMigrationSnapshot({
        appEnvironment: 'homologation',
        databasePath,
        sourceSha: 'b'.repeat(40),
      }),
      /somente na homologação/i
    );
  } finally {
    removeTemporaryDirectory(tempDirectory);
  }
});

test('recusa execução fora de APP_ENV=homologation', () => {
  assert.throws(
    () => createHomologationPreMigrationSnapshot({
      appEnvironment: 'production',
      databasePath: 'C:/homologation/database.sqlite',
      sourceSha: 'c'.repeat(40),
    }),
    /APP_ENV=homologation/i
  );
});
