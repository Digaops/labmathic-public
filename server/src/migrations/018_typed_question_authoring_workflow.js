module.exports = {
  version: 18,
  name: 'typed_question_authoring_workflow',
  description: 'Adiciona revisao editorial independente, idempotencia e auditoria transacional ao motor tipado.',
  up(db) {
    db.exec(`
      CREATE TABLE typed_question_review_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        item_id INTEGER NOT NULL,
        version_id INTEGER NOT NULL,
        review_round INTEGER NOT NULL CHECK(review_round > 0),
        version_revision INTEGER NOT NULL CHECK(version_revision > 0),
        definition_hash TEXT NOT NULL COLLATE BINARY,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending', 'approved', 'rejected', 'cancelled')),
        submitted_by INTEGER NOT NULL,
        submitted_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        decided_by INTEGER,
        decided_at DATETIME,
        decision_reason TEXT,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(
          length(definition_hash) = 64
          AND definition_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(julianday(submitted_at) IS NOT NULL),
        CHECK(
          (status = 'pending'
            AND decided_by IS NULL
            AND decided_at IS NULL
            AND decision_reason IS NULL)
          OR (status <> 'pending'
            AND decided_by IS NOT NULL
            AND julianday(decided_at) IS NOT NULL
            AND length(trim(decision_reason)) BETWEEN 10 AND 1000)
        ),
        UNIQUE(version_id, review_round),
        UNIQUE(id, version_id, item_id),
        FOREIGN KEY (version_id, item_id)
          REFERENCES typed_question_item_versions(id, item_id) ON DELETE RESTRICT,
        FOREIGN KEY (submitted_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE UNIQUE INDEX idx_typed_question_review_one_pending
        ON typed_question_review_cycles(version_id)
        WHERE status = 'pending';
      CREATE INDEX idx_typed_question_review_item_status
        ON typed_question_review_cycles(item_id, status, submitted_at);
      CREATE INDEX idx_typed_question_review_reviewer
        ON typed_question_review_cycles(decided_by, decided_at);

      CREATE TABLE typed_question_write_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        operation_type TEXT NOT NULL CHECK(operation_type IN (
          'adopt_question',
          'update_draft',
          'create_version',
          'submit_review',
          'approve_review',
          'reject_review',
          'cancel_review',
          'activate_version'
        )),
        actor_id INTEGER NOT NULL,
        item_id INTEGER NOT NULL,
        version_id INTEGER NOT NULL,
        review_id INTEGER,
        idempotency_key_hash TEXT NOT NULL COLLATE BINARY,
        request_fingerprint TEXT NOT NULL COLLATE BINARY,
        result_json TEXT NOT NULL COLLATE BINARY,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(
          length(idempotency_key_hash) = 64
          AND idempotency_key_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(
          length(request_fingerprint) = 64
          AND request_fingerprint NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(json_valid(result_json)),
        CHECK(length(result_json) BETWEEN 2 AND 5000),
        CHECK(
          (operation_type IN (
            'submit_review', 'approve_review', 'reject_review', 'cancel_review'
          ) AND review_id IS NOT NULL)
          OR (operation_type NOT IN (
            'submit_review', 'approve_review', 'reject_review', 'cancel_review'
          ) AND review_id IS NULL)
        ),
        UNIQUE(actor_id, idempotency_key_hash),
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (item_id) REFERENCES typed_question_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (version_id, item_id)
          REFERENCES typed_question_item_versions(id, item_id) ON DELETE RESTRICT,
        FOREIGN KEY (review_id, version_id, item_id)
          REFERENCES typed_question_review_cycles(id, version_id, item_id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_typed_question_operations_item
        ON typed_question_write_operations(item_id, created_at);
      CREATE INDEX idx_typed_question_operations_actor
        ON typed_question_write_operations(actor_id, created_at);

      CREATE TRIGGER typed_question_reviews_must_start_pending
      BEFORE INSERT ON typed_question_review_cycles
      WHEN NEW.status <> 'pending'
        OR NEW.revision <> 1
        OR NEW.review_round <> COALESCE((
          SELECT MAX(review_round) + 1
          FROM typed_question_review_cycles
          WHERE version_id = NEW.version_id
        ), 1)
        OR NOT EXISTS (
          SELECT 1
          FROM typed_question_item_versions version
          JOIN typed_question_items item ON item.id = version.item_id
          JOIN questions question ON question.id = item.question_id
          JOIN users submitter ON submitter.id = NEW.submitted_by
          WHERE version.id = NEW.version_id
            AND version.item_id = NEW.item_id
            AND version.status = 'draft'
            AND version.revision = NEW.version_revision
            AND version.definition_hash = NEW.definition_hash
            AND version.created_by = NEW.submitted_by
            AND item.status IN ('draft', 'active')
            AND item.created_by = NEW.submitted_by
            AND question.created_by = NEW.submitted_by
            AND question.source = 'teacher'
            AND submitter.role = 'professor'
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_review_submission');
      END;

      CREATE TRIGGER typed_question_reviews_identity_is_immutable
      BEFORE UPDATE OF public_id, item_id, version_id, review_round,
        version_revision, definition_hash, submitted_by, submitted_at, created_at
      ON typed_question_review_cycles
      WHEN NEW.public_id IS NOT OLD.public_id
        OR NEW.item_id IS NOT OLD.item_id
        OR NEW.version_id IS NOT OLD.version_id
        OR NEW.review_round IS NOT OLD.review_round
        OR NEW.version_revision IS NOT OLD.version_revision
        OR NEW.definition_hash IS NOT OLD.definition_hash
        OR NEW.submitted_by IS NOT OLD.submitted_by
        OR NEW.submitted_at IS NOT OLD.submitted_at
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_review_identity_is_immutable');
      END;

      CREATE TRIGGER typed_question_reviews_revision_must_increment
      BEFORE UPDATE ON typed_question_review_cycles
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_review_revision_must_increment');
      END;

      CREATE TRIGGER typed_question_reviews_decision_transition
      BEFORE UPDATE OF status ON typed_question_review_cycles
      WHEN OLD.status <> 'pending'
        OR NEW.status NOT IN ('approved', 'rejected', 'cancelled')
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_review_transition');
      END;

      CREATE TRIGGER typed_question_reviews_decision_actor
      BEFORE UPDATE OF status ON typed_question_review_cycles
      WHEN (
          NEW.status IN ('approved', 'rejected')
          AND NOT EXISTS (
            SELECT 1
            FROM users reviewer
            JOIN typed_question_item_versions version ON version.id = OLD.version_id
            WHERE reviewer.id = NEW.decided_by
              AND reviewer.role = 'admin'
              AND reviewer.id <> version.created_by
          )
        )
        OR (
          NEW.status = 'cancelled'
          AND NEW.decided_by <> OLD.submitted_by
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_review_decision_actor');
      END;

      CREATE TRIGGER typed_question_reviews_only_decision_updates
      BEFORE UPDATE ON typed_question_review_cycles
      WHEN NEW.status = OLD.status
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_review_only_accepts_final_decision');
      END;

      CREATE TRIGGER typed_question_reviews_decision_is_final
      BEFORE UPDATE ON typed_question_review_cycles
      WHEN OLD.status <> 'pending'
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_review_decision_is_final');
      END;

      CREATE TRIGGER typed_question_reviews_prevent_delete
      BEFORE DELETE ON typed_question_review_cycles
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_review_cannot_be_deleted');
      END;

      CREATE TRIGGER typed_question_versions_freeze_while_review_pending
      BEFORE UPDATE OF interaction_type, correction_mode, scoring_strategy,
        partial_credit, accessibility_ready, print_supported, definition_json,
        definition_hash
      ON typed_question_item_versions
      WHEN EXISTS (
        SELECT 1
        FROM typed_question_review_cycles review
        WHERE review.version_id = OLD.id
          AND review.status = 'pending'
      )
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_is_under_review');
      END;

      CREATE TRIGGER typed_question_versions_publish_requires_approved_review
      BEFORE UPDATE OF status ON typed_question_item_versions
      WHEN OLD.status = 'draft'
        AND NEW.status = 'published'
        AND NOT EXISTS (
          SELECT 1
          FROM typed_question_review_cycles review
          JOIN users reviewer ON reviewer.id = review.decided_by
          WHERE review.version_id = OLD.id
            AND review.item_id = OLD.item_id
            AND review.status = 'approved'
            AND review.version_revision = OLD.revision
            AND review.definition_hash = OLD.definition_hash
            AND reviewer.role = 'admin'
            AND reviewer.id <> OLD.created_by
        )
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_requires_approved_review');
      END;

      CREATE TRIGGER typed_question_operations_prevent_update
      BEFORE UPDATE ON typed_question_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_write_operation_is_immutable');
      END;

      CREATE TRIGGER typed_question_operations_prevent_delete
      BEFORE DELETE ON typed_question_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_write_operation_is_immutable');
      END;
    `);
  },
};
