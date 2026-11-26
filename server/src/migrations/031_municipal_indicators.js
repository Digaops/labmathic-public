module.exports = {
  version: 31,
  name: 'municipal_indicators',
  description: 'Retrato público municipal com lotes isolados, publicação explícita e histórico imutável; desligado por padrão.',
  up(db) {
    db.exec(`
      CREATE TABLE municipal_indicator_batches (
        id TEXT PRIMARY KEY CHECK(length(id)=64),
        manifest_json TEXT NOT NULL CHECK(json_valid(manifest_json)),
        row_count INTEGER NOT NULL CHECK(row_count>0),
        prepared_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE municipal_indicator_places (
        batch_id TEXT NOT NULL REFERENCES municipal_indicator_batches(id) ON DELETE RESTRICT,
        ibge_code TEXT NOT NULL, name TEXT NOT NULL, uf TEXT NOT NULL, search_name TEXT NOT NULL,
        PRIMARY KEY(batch_id,ibge_code)
      );
      CREATE INDEX municipal_indicator_place_search ON municipal_indicator_places(batch_id,search_name,ibge_code);
      CREATE TABLE municipal_indicator_values (
        batch_id TEXT NOT NULL REFERENCES municipal_indicator_batches(id) ON DELETE RESTRICT,
        ibge_code TEXT NOT NULL CHECK(length(ibge_code)=7 AND ibge_code NOT GLOB '*[^0-9]*'),
        name TEXT NOT NULL, uf TEXT NOT NULL, search_name TEXT NOT NULL,
        stage TEXT NOT NULL CHECK(stage IN ('elementary_initial','elementary_final')),
        year INTEGER NOT NULL CHECK(year IN (2023,2025)),
        value REAL, status TEXT NOT NULL CHECK(status IN ('published','unavailable','suppressed')),
        source_marker TEXT,
        CHECK((status='published' AND value IS NOT NULL AND value BETWEEN 0 AND 10) OR (status!='published' AND value IS NULL)),
        PRIMARY KEY(batch_id,ibge_code,stage,year),
        FOREIGN KEY(batch_id,ibge_code) REFERENCES municipal_indicator_places(batch_id,ibge_code) ON DELETE RESTRICT
      );
      CREATE INDEX municipal_indicator_search ON municipal_indicator_values(batch_id,search_name,ibge_code);
      CREATE TABLE municipal_indicator_publication (
        id INTEGER PRIMARY KEY CHECK(id=1),
        batch_id TEXT REFERENCES municipal_indicator_batches(id) ON DELETE RESTRICT,
        revision INTEGER NOT NULL DEFAULT 0 CHECK(revision>=0)
      );
      INSERT INTO municipal_indicator_publication(id) VALUES(1);
      CREATE TABLE municipal_indicator_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL CHECK(action IN ('prepared','activated')),
        batch_id TEXT NOT NULL REFERENCES municipal_indicator_batches(id) ON DELETE RESTRICT,
        previous_batch_id TEXT REFERENCES municipal_indicator_batches(id) ON DELETE RESTRICT,
        operator TEXT NOT NULL CHECK(operator='reviewed_official_import'),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER municipal_indicator_values_sealed BEFORE INSERT ON municipal_indicator_values
        WHEN EXISTS(SELECT 1 FROM municipal_indicator_events WHERE batch_id=NEW.batch_id AND action='prepared')
        BEGIN SELECT RAISE(ABORT,'Indicator batch is sealed'); END;
      CREATE TRIGGER municipal_indicator_places_sealed BEFORE INSERT ON municipal_indicator_places
        WHEN EXISTS(SELECT 1 FROM municipal_indicator_events WHERE batch_id=NEW.batch_id AND action='prepared')
        BEGIN SELECT RAISE(ABORT,'Indicator batch is sealed'); END;
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('institutions.network_portrait','Retrato da rede','Consulta de indicadores públicos oficiais, sem dados individuais.',0,0,0);
    `);
    for (const table of ['municipal_indicator_batches', 'municipal_indicator_places', 'municipal_indicator_values', 'municipal_indicator_events']) {
      for (const action of ['UPDATE', 'DELETE']) db.exec(`CREATE TRIGGER ${table}_no_${action.toLowerCase()}
        BEFORE ${action} ON ${table} BEGIN SELECT RAISE(ABORT,'Indicator history is immutable'); END;`);
    }
  },
};
