module.exports = {
  version: 41,
  name: 'question_set_creation_receipts',
  description: 'Registra criações idempotentes de simulados, preservando a confirmação após exclusão.',
  up(db) {
    db.exec(`
      CREATE TABLE question_set_creation_receipts (
        owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        idempotency_key_hash TEXT NOT NULL CHECK(length(idempotency_key_hash) = 64),
        request_fingerprint TEXT NOT NULL CHECK(length(request_fingerprint) = 64),
        question_set_id INTEGER UNIQUE REFERENCES question_sets(id) ON DELETE SET NULL,
        PRIMARY KEY (owner_user_id, idempotency_key_hash)
      );
    `);
  },
};
