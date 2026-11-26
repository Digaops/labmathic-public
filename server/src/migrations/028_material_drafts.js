module.exports = {
  version: 28,
  name: 'material_drafts',
  description: 'Rascunhos privados separados do acervo; publicação explícita e idempotente, desligada por padrão.',
  up(db) {
    db.exec(`
      CREATE TABLE material_drafts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json)),
        file_path TEXT,
        file_format TEXT,
        file_size INTEGER CHECK(file_size >= 0),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        published_material_id INTEGER UNIQUE,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX material_drafts_owner ON material_drafts(owner_id, published_material_id, id);
      CREATE TABLE material_draft_files (
        file_path TEXT PRIMARY KEY,
        draft_id INTEGER NOT NULL REFERENCES material_drafts(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE material_draft_operations (
        actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        key_hash TEXT NOT NULL CHECK(length(key_hash) = 64),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(actor_user_id, key_hash)
      );
      INSERT INTO feature_flags(flag_key, name, description, master_enabled, default_enabled, rollout_percentage)
        VALUES ('materials.draft_publication', 'Rascunhos e publicação de materiais',
          'Prepara materiais fora do acervo e publica após confirmação do administrador.', 0, 0, 0);
    `);
  },
};
