const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const migration023 = require('../src/migrations/023_institutional_management_pilot');
const migration024 = require('../src/migrations/024_institutional_official_directories');

test('migração 024 preserva a hierarquia e cria catálogo público versionado com recibo imutável', () => {
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
    migration023.up(db);
    const adminId = Number(db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Admin Diretórios', 'admin-directory@teste.local', 'hash', 'admin')
    `).run().lastInsertRowid);
    const municipalityId = Number(db.prepare(`
      INSERT INTO municipalities (public_id, name, ibge_code, created_by, updated_by)
      VALUES ('municipality-before-024', 'Município preservado', '3550308', ?, ?)
    `).run(adminId, adminId).lastInsertRowid);
    db.prepare(`
      INSERT INTO schools (public_id, municipality_id, name, census_code, created_by, updated_by)
      VALUES ('school-before-migration-024', ?, 'Escola preservada', '35000001', ?, ?)
    `).run(municipalityId, adminId, adminId);

    migration024.up(db);

    assert.equal(db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM schools').pluck().get(), 1);
    const importId = Number(db.prepare(`
      INSERT INTO institutional_directory_imports (
        public_id, directory_type, source_name, source_year, source_url,
        source_sha256, row_count
      ) VALUES (
        'directory-import-public-024', 'inep_school_catalog', 'Inep · Censo Escolar',
        2025, 'https://download.inep.gov.br/dados_abertos/', ?, 1
      )
    `).run('a'.repeat(64)).lastInsertRowid);
    db.prepare(`
      INSERT INTO institutional_school_directory (
        import_id, census_year, census_code, ibge_code, school_name, search_name,
        municipality_name, uf, administrative_dependency, operating_status
      ) VALUES (?, 2025, '35000002', '3550308', 'Escola oficial', 'escola oficial',
        'São Paulo', 'SP', 'municipal', 'active')
    `).run(importId);

    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_school_directory').pluck().get(), 1);
    assert.throws(
      () => db.prepare('UPDATE institutional_directory_imports SET row_count = 2 WHERE id = ?').run(importId),
      /institutional_directory_import_is_immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM institutional_directory_imports WHERE id = ?').run(importId),
      /institutional_directory_import_is_immutable/,
    );
    assert.equal(db.pragma('foreign_key_check').length, 0);
  } finally {
    db.close();
  }
});
