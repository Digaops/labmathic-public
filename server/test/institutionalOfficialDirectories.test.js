const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');

const { runMigrations } = require('../src/migrations');
const {
  IBGE_MUNICIPALITIES_URL,
  resetMunicipalityCacheForTests,
  searchIbgeMunicipalities,
  searchSchoolDirectory,
} = require('../src/services/institutionalDirectories');
const { importInepSchoolDirectory } = require('../src/services/inepSchoolDirectoryImport');

function fakeIbgePayload() {
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    id: 1_000_000 + index,
    nome: `Município sintético ${index}`,
    microrregiao: { mesorregiao: { UF: { sigla: index % 2 ? 'MG' : 'SP' } } },
  }));
  rows[137] = {
    id: 3_550_308,
    nome: 'São Paulo',
    microrregiao: { mesorregiao: { UF: { sigla: 'SP' } } },
  };
  return rows;
}

function csvSha256(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function createDatabase() {
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
  return database;
}

test('consulta IBGE normaliza acentos, preenche UF/código e usa cache validado', async () => {
  resetMunicipalityCacheForTests();
  let requests = 0;
  const fetchImpl = async (url) => {
    requests += 1;
    assert.equal(url, IBGE_MUNICIPALITIES_URL);
    return new Response(JSON.stringify(fakeIbgePayload()), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  const first = await searchIbgeMunicipalities('sao pa', { fetchImpl });
  const second = await searchIbgeMunicipalities('35503', { fetchImpl });
  assert.deepEqual(first.results[0], { ibgeCode: '3550308', name: 'São Paulo', uf: 'SP' });
  assert.equal(second.results[0].ibgeCode, '3550308');
  assert.equal(first.source.name, 'IBGE Localidades');
  assert.equal(requests, 1);
});

test('importa CSV oficial de forma atômica e pesquisa escolas sem alterar cadastros existentes', async () => {
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-inep-directory-'));
  const database = createDatabase();
  try {
    const adminId = Number(database.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Admin catálogo', 'admin-catalogo@teste.local', 'hash', 'admin')
    `).run().lastInsertRowid);
    const municipalityId = Number(database.prepare(`
      INSERT INTO municipalities (public_id, name, ibge_code, created_by, updated_by)
      VALUES ('municipality-directory-test', 'São Paulo', '3550308', ?, ?)
    `).run(adminId, adminId).lastInsertRowid);
    database.prepare(`
      INSERT INTO schools (public_id, municipality_id, name, census_code, created_by, updated_by)
      VALUES ('existing-school-directory', ?, 'Escola existente', '35000001', ?, ?)
    `).run(municipalityId, adminId, adminId);

    const content = [
      'NU_ANO_CENSO;CO_ENTIDADE;NO_ENTIDADE;CO_MUNICIPIO;NO_MUNICIPIO;SG_UF;TP_DEPENDENCIA;TP_SITUACAO_FUNCIONAMENTO',
      '2025;35000001;Escola Existente;3550308;São Paulo;SP;3;1',
      '2025;35000002;EMEF João de Barro;3550308;São Paulo;SP;3;1',
      '2025;35000003;Escola Municipal Paralisada;3550308;São Paulo;SP;3;2',
    ].join('\n');
    const sourcePath = path.join(tempDirectory, 'censo-2025.csv');
    fs.writeFileSync(sourcePath, content, 'utf8');
    const report = await importInepSchoolDirectory(database, {
      sourcePath,
      censusYear: 2025,
      sourceUrl: 'https://download.inep.gov.br/dados_abertos/microdados_censo_escolar_2025.zip',
      expectedSha256: csvSha256(content),
    });
    assert.equal(report.rowCount, 3);
    assert.equal(database.prepare('SELECT COUNT(*) FROM schools').pluck().get(), 1);
    const result = searchSchoolDirectory(database, {
      municipalityPublicId: 'municipality-directory-test',
      query: 'joao',
    });
    assert.equal(result.available, true);
    assert.equal(result.source.censusYear, 2025);
    assert.equal(result.source.administrativeDependency, 'municipal');
    assert.equal(result.results[0].name, 'EMEF João de Barro');
    assert.equal(result.results[0].censusCode, '35000002');

    const existing = searchSchoolDirectory(database, {
      municipalityPublicId: 'municipality-directory-test',
      query: 'existente',
    });
    assert.equal(existing.results[0].alreadyRegistered, true);

    await assert.rejects(
      importInepSchoolDirectory(database, {
        sourcePath,
        censusYear: 2025,
        sourceUrl: 'https://download.inep.gov.br/dados_abertos/microdados_censo_escolar_2025.zip',
        expectedSha256: 'f'.repeat(64),
      }),
      /SHA-256/,
    );
    await assert.rejects(
      importInepSchoolDirectory(database, {
        sourcePath,
        censusYear: 2025,
        sourceUrl: 'https://download.inep.gov.br/dados_abertos/microdados_censo_escolar_2025.zip',
        expectedSha256: csvSha256(content),
        expectedRowCount: 4,
      }),
      /volume do catálogo diverge/i,
    );
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_school_directory').pluck().get(), 3);
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_directory_imports').pluck().get(), 1);
    assert.equal(database.pragma('foreign_key_check').length, 0);

    const stateContent = [
      'NU_ANO_CENSO;CO_ENTIDADE;NO_ENTIDADE;CO_MUNICIPIO;NO_MUNICIPIO;SG_UF;TP_DEPENDENCIA;TP_SITUACAO_FUNCIONAMENTO',
      '2025;35000004;Escola Estadual Fora do Escopo;3550308;São Paulo;SP;2;1',
    ].join('\n');
    const stateSourcePath = path.join(tempDirectory, 'censo-estadual-2025.csv');
    fs.writeFileSync(stateSourcePath, stateContent, 'utf8');
    await assert.rejects(
      importInepSchoolDirectory(database, {
        sourcePath: stateSourcePath,
        censusYear: 2025,
        sourceUrl: 'https://download.inep.gov.br/dados_abertos/microdados_censo_escolar_2025.zip',
        expectedSha256: csvSha256(stateContent),
      }),
      /não pertence à rede municipal/,
    );
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_school_directory').pluck().get(), 3);
    assert.equal(database.prepare('SELECT COUNT(*) FROM institutional_directory_imports').pluck().get(), 1);
  } finally {
    database.close();
    fs.rmSync(tempDirectory, { recursive: true, force: true });
  }
});

test('catálogo escolar informa fallback quando município não tem IBGE ou importação', () => {
  const database = createDatabase();
  try {
    const adminId = Number(database.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Admin fallback', 'admin-fallback@teste.local', 'hash', 'admin')
    `).run().lastInsertRowid);
    database.prepare(`
      INSERT INTO municipalities (public_id, name, created_by, updated_by)
      VALUES ('municipality-manual-test', 'Município manual', ?, ?)
    `).run(adminId, adminId);
    const result = searchSchoolDirectory(database, {
      municipalityPublicId: 'municipality-manual-test',
      query: 'escola',
    });
    assert.equal(result.available, false);
    assert.equal(result.reason, 'municipality_without_ibge_code');
    assert.deepEqual(result.results, []);
  } finally {
    database.close();
  }
});
