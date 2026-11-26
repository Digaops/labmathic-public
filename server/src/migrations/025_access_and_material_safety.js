module.exports = {
  version: 25,
  name: 'access_and_material_safety',
  description: 'Adiciona revogação de sessões e registro recuperável de arquivos retirados do acervo, preservando dados e caminhos existentes.',
  up(db) {
    db.exec(`
      ALTER TABLE users ADD COLUMN auth_version INTEGER NOT NULL DEFAULT 0 CHECK(auth_version >= 0);
      CREATE TRIGGER users_invalidate_auth_after_security_change
      AFTER UPDATE OF password, role ON users
      WHEN NEW.password <> OLD.password OR NEW.role <> OLD.role
      BEGIN
        UPDATE users SET auth_version = OLD.auth_version + 1 WHERE id = NEW.id;
      END;

      CREATE TABLE revoked_auth_tokens (
        token_digest TEXT PRIMARY KEY CHECK(length(token_digest) = 64),
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL,
        revoked_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_revoked_auth_tokens_expiration ON revoked_auth_tokens(expires_at);

      CREATE TABLE material_file_retirements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        material_id INTEGER NOT NULL,
        reason TEXT NOT NULL CHECK(reason IN ('replaced', 'deleted')),
        recovery_json TEXT NOT NULL CHECK(json_valid(recovery_json)),
        retired_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
        retired_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX idx_material_file_retirements_path ON material_file_retirements(file_path);

      CREATE INDEX idx_materials_file_path ON materials(file_path);
      CREATE INDEX idx_materials_thumbnail_path ON materials(thumbnail_path);
      CREATE INDEX idx_collections_image_path ON collections(image_path);
      CREATE INDEX idx_questions_image_access ON questions(image_path, source, created_by);
      CREATE INDEX idx_assessment_items_image_access ON class_assessment_items(image_path_snapshot, owner_teacher_id);
    `);
  },
};
