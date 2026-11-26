module.exports = {
  version: 23,
  name: 'institutional_management_pilot',
  description: 'Adiciona flag, origem guiada e idempotencia para o piloto operacional institucional em homologacao.',
  up(db) {
    db.exec(`
      ALTER TABLE school_class_institution_contexts
        ADD COLUMN origin TEXT NOT NULL DEFAULT 'legacy'
          CHECK(origin IN ('legacy', 'guided_pilot'));

      CREATE TABLE institutional_write_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        operation_type TEXT NOT NULL CHECK(operation_type IN (
          'create_municipality',
          'update_municipality',
          'create_school',
          'update_school',
          'create_membership',
          'create_professional',
          'create_guided_class',
          'confirm_guided_class'
        )),
        actor_user_id INTEGER NOT NULL,
        entity_type TEXT NOT NULL CHECK(entity_type IN (
          'municipality',
          'school',
          'membership',
          'school_class_context'
        )),
        entity_key TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL COLLATE BINARY,
        request_fingerprint TEXT NOT NULL COLLATE BINARY,
        result_json TEXT NOT NULL COLLATE BINARY,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(entity_key)) BETWEEN 1 AND 128),
        CHECK(
          length(idempotency_key_hash) = 64
          AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(
          length(request_fingerprint) = 64
          AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(json_valid(result_json)),
        CHECK(length(result_json) BETWEEN 2 AND 8000),
        UNIQUE(actor_user_id, idempotency_key_hash),
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_institutional_write_operations_actor_created
        ON institutional_write_operations(actor_user_id, created_at);
      CREATE INDEX idx_institutional_write_operations_entity_created
        ON institutional_write_operations(entity_type, entity_key, created_at);

      CREATE TRIGGER institutional_write_operations_prevent_update
      BEFORE UPDATE ON institutional_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'institutional_write_operation_is_immutable');
      END;

      CREATE TRIGGER institutional_write_operations_prevent_delete
      BEFORE DELETE ON institutional_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'institutional_write_operation_is_immutable');
      END;

      INSERT INTO feature_flags (
        flag_key,
        name,
        description,
        release_id,
        master_enabled,
        default_enabled,
        rollout_percentage
      )
      SELECT
        'institutions.management_pilot',
        'Piloto operacional institucional',
        'Permite cadastrar e vincular a rede em homologacao com confirmacao humana, auditoria e idempotencia.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.1.0';
    `);
  },
};
