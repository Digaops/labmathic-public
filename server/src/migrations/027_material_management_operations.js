module.exports = {
  version: 27,
  name: 'material_management_operations',
  description: 'Recibos administrativos para impedir repetição de gravações de materiais, sem alterar o acervo existente.',
  up(db) {
    db.exec(`
      CREATE TABLE material_management_operations (
        actor_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        key_hash TEXT NOT NULL CHECK(length(key_hash) = 64),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        operation TEXT NOT NULL CHECK(operation IN ('create', 'update')),
        material_id INTEGER NOT NULL,
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(actor_user_id, key_hash)
      );
    `);
  },
};
