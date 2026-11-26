const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/migrations');
const {
  DEFAULT_MANIFEST_PATH,
  SANITIZER_SCHEMA_CEILINGS,
  assertLegacyDirectoryState,
  bootstrapBundledSchoolDirectory,
  inspectHomologationDatabase,
  validateManifest,
} = require('../src/services/bundledSchoolDirectory');
const {
  CONFIRMATION,
  parseArguments,
  validateCatalogStats,
} = require('../scripts/homologation/prepareInepSchoolDirectoryArtifact');

function createDatabase({ sanitizerVersion = '13', sourceSchemaVersion = 24 } = {}) {
  const database = new Database(':memory:');
  database.pragma('foreign_keys = ON');
  database.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'professor'
    );
    CREATE TABLE materials (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, thumbnail_path TEXT);
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT);
    CREATE TABLE disciplines (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE grades (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE);
    CREATE TABLE question_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL, title TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0, FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT, code TEXT NOT NULL, description TEXT NOT NULL,
      grade_id INTEGER NOT NULL, FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
    );
    CREATE TABLE questions (
      image_path TEXT,
      question_type TEXT DEFAULT 'multiple_choice',
      id INTEGER PRIMARY KEY AUTOINCREMENT, question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER, statement TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'official', created_by INTEGER,
      FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE question_options (id INTEGER PRIMARY KEY, question_id INTEGER);
    CREATE TABLE question_set_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT, question_set_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL, sort_order INTEGER NOT NULL DEFAULT 0,
      show_image INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
  `);
  runMigrations(database, { logger: { info() {} } });
  database.exec(`
    CREATE TABLE homologation_snapshot_metadata (
      id INTEGER PRIMARY KEY CHECK(id = 1),
      sanitized INTEGER NOT NULL,
      sanitizer_version TEXT NOT NULL,
      source_schema_version INTEGER NOT NULL
    );
  `);
  database.prepare(`
    INSERT INTO homologation_snapshot_metadata (
      id, sanitized, sanitizer_version, source_schema_version
    ) VALUES (1, 1, ?, ?)
  `).run(sanitizerVersion, sourceSchemaVersion);
  return database;
}

test('manifesto municipal versionado possui fonte, recorte e hashes válidos', () => {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8')));
  assert.equal(manifest.censusYear, 2025);
  assert.equal(manifest.scope.administrativeDependency, 'municipal');
  assert.equal(manifest.rowCount, 128145);
  assert.equal(manifest.activeCount, 107372);
  assert.equal(manifest.municipalityCount, 5569);
  assert.equal(manifest.ufCount, 26);
  assert.deepEqual(manifest.dependencies, { municipal: 128145 });
  assert.deepEqual(manifest.excludedDependencies, { state: 33561, private: 51758, federal: 728 });
  assert.deepEqual(manifest.predecessorCatalogs, [{
    catalogSha256: 'e188908c31aa0c70a740a48be75b608600b87a1c3c4a89eb04a67abf5ca325a2',
    rowCount: 214192,
  }]);
  assert.equal(manifest.repairedFromIbgeCount, 1);
  assert.equal(
    path.basename(DEFAULT_MANIFEST_PATH),
    'inep-schools-2025.manifest.json',
  );
});

test('bootstrap importa uma vez o catálogo real somente no snapshot sanitizado de homologação', async () => {
  const database = createDatabase({ sanitizerVersion: '11', sourceSchemaVersion: 22 });
  try {
    const imported = await bootstrapBundledSchoolDirectory(database, {
      appEnvironment: 'homologation',
      nodeEnvironment: 'production',
    });
    assert.equal(imported.status, 'imported');
    assert.equal(imported.rowCount, 128145);
    assert.equal(imported.productionTouched, false);
    assert.equal(imported.sanitizerVersion, 11);
    assert.equal(imported.sourceSchemaVersion, 22);
    assert.equal(imported.sanitizerCompatibility, 'v11_migrated_to_schema24');
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM institutional_school_directory').pluck().get(),
      128145,
    );
    assert.deepEqual(
      database.prepare(`
        SELECT municipality_name, uf
        FROM institutional_school_directory
        WHERE census_code = '43145833'
      `).get(),
      { municipality_name: 'Sapiranga', uf: 'RS' },
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*)
        FROM institutional_school_directory
        WHERE operating_status = 'active'
      `).pluck().get(),
      107372,
    );
    assert.equal(
      database.prepare(`
        SELECT COUNT(*)
        FROM institutional_school_directory
        WHERE administrative_dependency <> 'municipal'
      `).pluck().get(),
      0,
    );

    const repeated = await bootstrapBundledSchoolDirectory(database, {
      appEnvironment: 'homologation',
      nodeEnvironment: 'production',
    });
    assert.equal(repeated.status, 'already_imported');
    assert.equal(
      database.prepare('SELECT COUNT(*) FROM institutional_directory_imports').pluck().get(),
      1,
    );
    assert.equal(database.pragma('foreign_key_check').length, 0);
  } finally {
    database.close();
  }
});

test('bootstrap substitui o catálogo nacional predecessor e preserva a escola cadastrada', async () => {
  const database = createDatabase({ sanitizerVersion: '11', sourceSchemaVersion: 22 });
  try {
    const adminId = Number(database.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Admin preservado', 'admin-preservado@teste.local', 'hash', 'admin')
    `).run().lastInsertRowid);
    const municipalityId = Number(database.prepare(`
      INSERT INTO municipalities (public_id, name, ibge_code, created_by, updated_by)
      VALUES ('municipality-preserved-test', 'São Paulo', '3550308', ?, ?)
    `).run(adminId, adminId).lastInsertRowid);
    database.prepare(`
      INSERT INTO schools (public_id, municipality_id, name, census_code, created_by, updated_by)
      VALUES ('school-preserved-test', ?, 'Escola cadastrada preservada', '35000001', ?, ?)
    `).run(municipalityId, adminId, adminId);

    const predecessorImportId = Number(database.prepare(`
      INSERT INTO institutional_directory_imports (
        public_id, directory_type, source_name, source_year, source_url,
        source_sha256, row_count
      ) VALUES (
        'national-predecessor-import', 'inep_school_catalog', 'Inep · Censo Escolar',
        2025, 'https://download.inep.gov.br/dados_abertos/', ?, 214192
      )
    `).run('e188908c31aa0c70a740a48be75b608600b87a1c3c4a89eb04a67abf5ca325a2').lastInsertRowid);
    const insertPredecessor = database.prepare(`
      INSERT INTO institutional_school_directory (
        import_id, census_year, census_code, ibge_code, school_name, search_name,
        municipality_name, uf, administrative_dependency, operating_status
      ) VALUES (?, 2025, ?, '3550308', ?, ?, 'São Paulo', 'SP', 'state', 'active')
    `);
    database.transaction(() => {
      for (let index = 1; index <= 214192; index += 1) {
        const censusCode = String(index).padStart(8, '0');
        const name = `Escola predecessora ${index}`;
        insertPredecessor.run(predecessorImportId, censusCode, name, name.toLowerCase());
      }
    })();

    const imported = await bootstrapBundledSchoolDirectory(database, {
      appEnvironment: 'homologation',
      nodeEnvironment: 'production',
    });
    assert.equal(imported.status, 'imported');
    assert.equal(imported.rowCount, 128145);
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_school_directory').pluck().get(), 128145);
    assert.equal(database.prepare(`
      SELECT COUNT(*) FROM institutional_school_directory
      WHERE administrative_dependency <> 'municipal'
    `).pluck().get(), 0);
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_directory_imports').pluck().get(), 2);
    assert.deepEqual(
      database.prepare('SELECT name, census_code FROM schools WHERE public_id = ?').get('school-preserved-test'),
      { name: 'Escola cadastrada preservada', census_code: '35000001' },
    );
    assert.equal(database.pragma('foreign_key_check').length, 0);

    const repeated = await bootstrapBundledSchoolDirectory(database, {
      appEnvironment: 'homologation',
      nodeEnvironment: 'production',
    });
    assert.equal(repeated.status, 'already_imported');
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_directory_imports').pluck().get(), 2);
  } finally {
    database.close();
  }
});

test('ponte legada aceita somente tabelas vazias ou predecessor explicitamente aprovado', () => {
  const manifest = validateManifest(JSON.parse(fs.readFileSync(DEFAULT_MANIFEST_PATH, 'utf8')));
  const database = createDatabase({ sanitizerVersion: '11', sourceSchemaVersion: 22 });
  try {
    const databaseState = inspectHomologationDatabase(database);
    assert.doesNotThrow(() => assertLegacyDirectoryState(database, databaseState, manifest));

    const predecessorSha256 = 'b'.repeat(64);
    const predecessorManifest = {
      ...manifest,
      predecessorCatalogs: [{ catalogSha256: predecessorSha256, rowCount: 1 }],
    };
    const importId = Number(database.prepare(`
      INSERT INTO institutional_directory_imports (
        public_id, directory_type, source_name, source_year, source_url,
        source_sha256, row_count
      ) VALUES (?, 'inep_school_catalog', 'Inep · Censo Escolar', 2025, ?, ?, 1)
    `).run(
      'directory-approved-predecessor-test',
      'https://download.inep.gov.br/dados_abertos/',
      predecessorSha256,
    ).lastInsertRowid);
    database.prepare(`
      INSERT INTO institutional_school_directory (
        import_id, census_year, census_code, ibge_code, school_name, search_name,
        municipality_name, uf, administrative_dependency, operating_status
      ) VALUES (?, 2025, '35000001', '3550308', 'Escola predecessora',
        'escola predecessora', 'São Paulo', 'SP', 'state', 'active')
    `).run(importId);
    assert.doesNotThrow(() => assertLegacyDirectoryState(
      database,
      databaseState,
      predecessorManifest,
    ));

    database.prepare(`
      INSERT INTO institutional_directory_imports (
        public_id, directory_type, source_name, source_year, source_url,
        source_sha256, row_count
      ) VALUES (?, 'inep_school_catalog', 'Inep · Censo Escolar', 2025, ?, ?, 1)
    `).run('directory-unapproved-test', 'https://download.inep.gov.br/dados_abertos/', 'a'.repeat(64));
    assert.throws(
      () => assertLegacyDirectoryState(database, databaseState, predecessorManifest),
      /diretório escolar não aprovado/,
    );
  } finally {
    database.close();
  }
});

test('matriz aceita somente pares históricos conhecidos de sanitizador e schema de origem', () => {
  for (const [version, ceiling] of [[16, 27], [17, 30], [18, 32], [21, 36], [23, 39]]) {
    assert.equal(SANITIZER_SCHEMA_CEILINGS.get(version), ceiling);
  }
  for (const [sanitizerVersion, sourceSchemaVersion] of SANITIZER_SCHEMA_CEILINGS) {
    const database = createDatabase({ sanitizerVersion: String(sanitizerVersion), sourceSchemaVersion });
    try {
      const inspected = inspectHomologationDatabase(database);
      assert.equal(inspected.sanitizerVersion, sanitizerVersion);
      assert.equal(inspected.sourceSchemaVersion, sourceSchemaVersion);
    } finally {
      database.close();
    }
  }
});

test('versão desconhecida e schema de origem posterior à política continuam recusados', () => {
  const unknownVersion = createDatabase({ sanitizerVersion: '10', sourceSchemaVersion: 15 });
  try {
    assert.throws(
      () => inspectHomologationDatabase(unknownVersion),
      /não pertence à matriz de compatibilidade/,
    );
  } finally {
    unknownVersion.close();
  }

  const lateSchema = createDatabase({ sanitizerVersion: '11', sourceSchemaVersion: 23 });
  try {
    assert.throws(
      () => inspectHomologationDatabase(lateSchema),
      /schema de origem é posterior/,
    );
  } finally {
    lateSchema.close();
  }
});

test('sanitizador anterior não declara cobertura do schema de recibos e versão futura é recusada', () => {
  for (const [sanitizerVersion, sourceSchemaVersion, error] of [
    ['21', 37, /schema de origem é posterior/],
    ['23', 40, /schema de origem é posterior/],
    ['24', 41, /schema de origem é posterior/],
    ['25', 42, /schema de origem é posterior/],
    ['26', 43, /schema de origem é posterior/],
    ['27', 44, /schema de origem é posterior/],
    ['28', 43, /não pertence à matriz de compatibilidade/],
  ]) {
    const database = createDatabase({ sanitizerVersion, sourceSchemaVersion });
    try {
      assert.throws(() => inspectHomologationDatabase(database), error);
    } finally {
      database.close();
    }
  }
});

test('bootstrap não lê nem escreve catálogo fora do runtime exato de homologação', async () => {
  assert.deepEqual(
    await bootstrapBundledSchoolDirectory(null, {
      appEnvironment: 'production',
      nodeEnvironment: 'production',
    }),
    {
      status: 'skipped',
      reason: 'homologation_production_runtime_required',
      productionTouched: false,
    },
  );
});

test('servidor abre a porta em manutenção antes da carga e só libera depois do catálogo', () => {
  const serverSource = fs.readFileSync(path.resolve(__dirname, '../src/index.js'), 'utf8');
  const listenIndex = serverSource.indexOf('app.listen(config.port');
  const prepareIndex = serverSource.indexOf('prepareRuntime().catch');
  assert.ok(listenIndex >= 0 && prepareIndex > listenIndex, 'A porta deve abrir antes da preparação assíncrona.');
  assert.match(serverSource, /schoolDirectoryReadiness\.status !== 'ready'/);
  assert.match(serverSource, /res\.status\(503\)/);
  assert.match(serverSource, /schoolDirectoryReadiness\.status = 'ready'/);
  assert.match(serverSource, /schoolDirectoryReadiness\.status = 'failed'/);
});

test('preparador exige confirmação e rejeita volume municipal incompleto', () => {
  const parsed = parseArguments(['--confirmation', CONFIRMATION, '--year', '2025']);
  assert.equal(parsed.confirmation, CONFIRMATION);
  assert.throws(
    () => validateCatalogStats({
      rowCount: 100,
      activeCount: 90,
      municipalityCount: 10,
      ufCount: 2,
      dependencies: { municipal: 100 },
    }),
    /Volume municipal/,
  );
});
