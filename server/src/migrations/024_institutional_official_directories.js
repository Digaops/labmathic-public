module.exports = {
  version: 24,
  name: 'institutional_official_directories',
  description: 'Adiciona catálogo escolar oficial versionado e trilha imutável de importações, sem alterar cadastros institucionais existentes.',
  up(db) {
    db.exec(`
      CREATE TABLE institutional_directory_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        directory_type TEXT NOT NULL
          CHECK(directory_type = 'inep_school_catalog'),
        source_name TEXT NOT NULL,
        source_year INTEGER NOT NULL CHECK(source_year BETWEEN 2000 AND 2100),
        source_url TEXT NOT NULL,
        source_sha256 TEXT NOT NULL COLLATE BINARY UNIQUE,
        row_count INTEGER NOT NULL CHECK(row_count > 0),
        imported_by TEXT NOT NULL DEFAULT 'homologation_cli'
          CHECK(imported_by = 'homologation_cli'),
        imported_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(source_name)) BETWEEN 3 AND 120),
        CHECK(length(trim(source_url)) BETWEEN 12 AND 500),
        CHECK(
          length(source_sha256) = 64
          AND source_sha256 NOT GLOB '*[^0-9a-f]*'
        )
      );

      CREATE INDEX idx_institutional_directory_imports_latest
        ON institutional_directory_imports(directory_type, source_year DESC, id DESC);

      CREATE TABLE institutional_school_directory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        import_id INTEGER NOT NULL,
        census_year INTEGER NOT NULL CHECK(census_year BETWEEN 2000 AND 2100),
        census_code TEXT NOT NULL COLLATE NOCASE,
        ibge_code TEXT NOT NULL COLLATE NOCASE,
        school_name TEXT NOT NULL COLLATE NOCASE,
        search_name TEXT NOT NULL COLLATE BINARY,
        municipality_name TEXT NOT NULL COLLATE NOCASE,
        uf TEXT NOT NULL COLLATE NOCASE,
        administrative_dependency TEXT NOT NULL
          CHECK(administrative_dependency IN ('federal', 'state', 'municipal', 'private', 'unknown')),
        operating_status TEXT NOT NULL
          CHECK(operating_status IN ('active', 'paused', 'closed', 'unknown')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(
          length(census_code) = 8
          AND census_code NOT GLOB '*[^0-9]*'
        ),
        CHECK(
          length(ibge_code) = 7
          AND ibge_code NOT GLOB '*[^0-9]*'
        ),
        CHECK(length(trim(school_name)) BETWEEN 2 AND 180),
        CHECK(length(trim(search_name)) BETWEEN 2 AND 180),
        CHECK(length(trim(municipality_name)) BETWEEN 2 AND 160),
        CHECK(
          length(uf) = 2
          AND uf = upper(uf)
          AND uf NOT GLOB '*[^A-Z]*'
        ),
        UNIQUE(census_year, census_code),
        FOREIGN KEY (import_id) REFERENCES institutional_directory_imports(id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_institutional_school_directory_municipality_name
        ON institutional_school_directory(import_id, ibge_code, search_name, census_code);
      CREATE INDEX idx_institutional_school_directory_municipality_status
        ON institutional_school_directory(import_id, ibge_code, operating_status, administrative_dependency);

      CREATE TRIGGER institutional_directory_imports_prevent_update
      BEFORE UPDATE ON institutional_directory_imports
      BEGIN
        SELECT RAISE(ABORT, 'institutional_directory_import_is_immutable');
      END;

      CREATE TRIGGER institutional_directory_imports_prevent_delete
      BEFORE DELETE ON institutional_directory_imports
      BEGIN
        SELECT RAISE(ABORT, 'institutional_directory_import_is_immutable');
      END;
    `);
  },
};
