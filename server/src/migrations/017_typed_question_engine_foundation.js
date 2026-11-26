module.exports = {
  version: 17,
  name: 'typed_question_engine_foundation',
  description: 'Cria motor tipado, versionado e auditavel de questoes em paralelo ao banco legado.',
  up(db) {
    db.exec(`
      CREATE TABLE typed_question_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        question_id INTEGER NOT NULL UNIQUE,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'active', 'retired')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        retired_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(
          (status IN ('draft', 'active') AND retired_at IS NULL)
          OR (status = 'retired' AND julianday(retired_at) IS NOT NULL)
        ),
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE TABLE typed_question_item_versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        item_id INTEGER NOT NULL,
        version INTEGER NOT NULL CHECK(version > 0),
        engine_version INTEGER NOT NULL DEFAULT 1 CHECK(engine_version = 1),
        format_version INTEGER NOT NULL DEFAULT 1 CHECK(format_version = 1),
        interaction_type TEXT NOT NULL CHECK(interaction_type IN (
          'single_choice',
          'true_false',
          'multiple_response',
          'numeric',
          'fill_blank',
          'ordering',
          'matching'
        )),
        correction_mode TEXT NOT NULL DEFAULT 'automatic'
          CHECK(correction_mode = 'automatic'),
        scoring_strategy TEXT NOT NULL CHECK(scoring_strategy IN (
          'exact',
          'partial_with_penalty',
          'numeric_exact',
          'numeric_absolute_tolerance',
          'numeric_relative_tolerance',
          'numeric_range',
          'per_blank',
          'per_position',
          'per_pair'
        )),
        partial_credit INTEGER NOT NULL DEFAULT 0 CHECK(partial_credit IN (0, 1)),
        accessibility_ready INTEGER NOT NULL DEFAULT 1
          CHECK(accessibility_ready = 1),
        print_supported INTEGER NOT NULL DEFAULT 1 CHECK(print_supported = 1),
        definition_json TEXT NOT NULL COLLATE BINARY,
        definition_hash TEXT NOT NULL COLLATE BINARY,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'published', 'retired')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER NOT NULL,
        updated_by INTEGER NOT NULL,
        published_by INTEGER,
        retired_by INTEGER,
        published_at DATETIME,
        retired_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(json_valid(definition_json)),
        CHECK(length(definition_json) BETWEEN 2 AND 100000),
        CHECK(
          length(definition_hash) = 64
          AND definition_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(
          (interaction_type IN ('single_choice', 'true_false') AND scoring_strategy = 'exact')
          OR (interaction_type = 'multiple_response' AND scoring_strategy IN ('exact', 'partial_with_penalty'))
          OR (interaction_type = 'numeric' AND scoring_strategy IN (
            'numeric_exact',
            'numeric_absolute_tolerance',
            'numeric_relative_tolerance',
            'numeric_range'
          ))
          OR (interaction_type = 'fill_blank' AND scoring_strategy IN ('exact', 'per_blank'))
          OR (interaction_type = 'ordering' AND scoring_strategy IN ('exact', 'per_position'))
          OR (interaction_type = 'matching' AND scoring_strategy IN ('exact', 'per_pair'))
        ),
        CHECK(
          (partial_credit = 1 AND scoring_strategy IN (
            'partial_with_penalty', 'per_blank', 'per_position', 'per_pair'
          ))
          OR (partial_credit = 0 AND scoring_strategy NOT IN (
            'partial_with_penalty', 'per_blank', 'per_position', 'per_pair'
          ))
        ),
        CHECK(
          (status = 'draft'
            AND published_by IS NULL
            AND retired_by IS NULL
            AND published_at IS NULL
            AND retired_at IS NULL)
          OR (status = 'published'
            AND published_by IS NOT NULL
            AND retired_by IS NULL
            AND julianday(published_at) IS NOT NULL
            AND retired_at IS NULL)
          OR (status = 'retired'
            AND published_by IS NOT NULL
            AND retired_by IS NOT NULL
            AND julianday(published_at) IS NOT NULL
            AND julianday(retired_at) IS NOT NULL)
        ),
        UNIQUE(item_id, version),
        UNIQUE(id, item_id),
        FOREIGN KEY (item_id) REFERENCES typed_question_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (published_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (retired_by) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE TABLE typed_question_current_versions (
        item_id INTEGER PRIMARY KEY,
        version_id INTEGER NOT NULL UNIQUE,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        activated_by INTEGER NOT NULL,
        activated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(julianday(activated_at) IS NOT NULL),
        FOREIGN KEY (item_id) REFERENCES typed_question_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (version_id, item_id)
          REFERENCES typed_question_item_versions(id, item_id) ON DELETE RESTRICT,
        FOREIGN KEY (activated_by) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE TABLE class_assessment_typed_item_snapshots (
        assessment_item_id INTEGER PRIMARY KEY,
        typed_item_id INTEGER NOT NULL,
        typed_version_id INTEGER NOT NULL,
        engine_version INTEGER NOT NULL CHECK(engine_version = 1),
        format_version INTEGER NOT NULL CHECK(format_version = 1),
        interaction_type TEXT NOT NULL CHECK(interaction_type IN (
          'single_choice',
          'true_false',
          'multiple_response',
          'numeric',
          'fill_blank',
          'ordering',
          'matching'
        )),
        correction_mode TEXT NOT NULL CHECK(correction_mode = 'automatic'),
        scoring_strategy TEXT NOT NULL,
        partial_credit INTEGER NOT NULL CHECK(partial_credit IN (0, 1)),
        definition_json TEXT NOT NULL COLLATE BINARY,
        definition_hash TEXT NOT NULL COLLATE BINARY,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(json_valid(definition_json)),
        CHECK(length(definition_json) BETWEEN 2 AND 100000),
        CHECK(
          length(definition_hash) = 64
          AND definition_hash NOT GLOB '*[^0-9a-f]*'
        ),
        UNIQUE(assessment_item_id, typed_item_id, typed_version_id),
        FOREIGN KEY (assessment_item_id)
          REFERENCES class_assessment_items(id) ON DELETE CASCADE,
        FOREIGN KEY (typed_item_id)
          REFERENCES typed_question_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (typed_version_id, typed_item_id)
          REFERENCES typed_question_item_versions(id, item_id) ON DELETE RESTRICT
      );

      CREATE TABLE typed_question_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        action TEXT NOT NULL CHECK(action IN (
          'item_created',
          'item_status_changed',
          'version_created',
          'version_published',
          'version_retired',
          'current_version_activated'
        )),
        item_id INTEGER NOT NULL,
        version_id INTEGER,
        actor_id INTEGER,
        previous_value TEXT,
        current_value TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(previous_value IS NULL OR length(previous_value) <= 64),
        CHECK(current_value IS NULL OR length(current_value) <= 64),
        FOREIGN KEY (item_id) REFERENCES typed_question_items(id) ON DELETE RESTRICT,
        FOREIGN KEY (version_id, item_id)
          REFERENCES typed_question_item_versions(id, item_id) ON DELETE RESTRICT,
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_typed_question_items_status
        ON typed_question_items(status, updated_at);
      CREATE INDEX idx_typed_question_versions_item
        ON typed_question_item_versions(item_id, status, version);
      CREATE INDEX idx_typed_question_versions_type
        ON typed_question_item_versions(interaction_type, status);
      CREATE INDEX idx_typed_question_snapshots_version
        ON class_assessment_typed_item_snapshots(typed_version_id);
      CREATE INDEX idx_typed_question_audit_item
        ON typed_question_audit_log(item_id, created_at);
      CREATE INDEX idx_typed_question_audit_actor
        ON typed_question_audit_log(actor_id, created_at);

      CREATE TRIGGER typed_question_items_identity_is_immutable
      BEFORE UPDATE OF public_id, question_id, created_by, created_at
      ON typed_question_items
      WHEN NEW.public_id IS NOT OLD.public_id
        OR NEW.question_id IS NOT OLD.question_id
        OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_item_identity_is_immutable');
      END;

      CREATE TRIGGER typed_question_items_must_start_as_draft
      BEFORE INSERT ON typed_question_items
      WHEN NEW.status <> 'draft' OR NEW.revision <> 1
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_item_must_start_as_draft');
      END;

      CREATE TRIGGER typed_question_items_revision_must_increment
      BEFORE UPDATE ON typed_question_items
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_item_revision_must_increment');
      END;

      CREATE TRIGGER typed_question_items_status_transition
      BEFORE UPDATE OF status ON typed_question_items
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status IN ('active', 'retired'))
          OR (OLD.status = 'active' AND NEW.status = 'retired')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_item_status_transition');
      END;

      CREATE TRIGGER typed_question_items_activation_requires_current_version
      BEFORE UPDATE OF status ON typed_question_items
      WHEN NEW.status = 'active' AND OLD.status <> 'active'
        AND NOT EXISTS (
          SELECT 1
          FROM typed_question_current_versions current_version
          JOIN typed_question_item_versions version
            ON version.id = current_version.version_id
           AND version.item_id = current_version.item_id
          WHERE current_version.item_id = NEW.id
            AND version.status = 'published'
        )
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_item_requires_published_current_version');
      END;

      CREATE TRIGGER typed_question_items_retired_are_immutable
      BEFORE UPDATE ON typed_question_items
      WHEN OLD.status = 'retired'
      BEGIN
        SELECT RAISE(ABORT, 'retired_typed_question_item_is_immutable');
      END;

      CREATE TRIGGER typed_question_items_prevent_delete
      BEFORE DELETE ON typed_question_items
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_item_cannot_be_deleted');
      END;

      CREATE TRIGGER typed_question_versions_require_sequential_number
      BEFORE INSERT ON typed_question_item_versions
      WHEN NEW.version <> COALESCE((
        SELECT MAX(version) + 1
        FROM typed_question_item_versions
        WHERE item_id = NEW.item_id
      ), 1)
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_must_be_sequential');
      END;

      CREATE TRIGGER typed_question_versions_must_start_as_draft
      BEFORE INSERT ON typed_question_item_versions
      WHEN NEW.status <> 'draft'
        OR NEW.revision <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM typed_question_items
          WHERE id = NEW.item_id
            AND status IN ('draft', 'active')
        )
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_must_start_as_draft');
      END;

      CREATE TRIGGER typed_question_versions_identity_is_immutable
      BEFORE UPDATE OF public_id, item_id, version, engine_version, format_version,
        created_by, created_at
      ON typed_question_item_versions
      WHEN NEW.public_id IS NOT OLD.public_id
        OR NEW.item_id IS NOT OLD.item_id
        OR NEW.version IS NOT OLD.version
        OR NEW.engine_version IS NOT OLD.engine_version
        OR NEW.format_version IS NOT OLD.format_version
        OR NEW.created_by IS NOT OLD.created_by
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_identity_is_immutable');
      END;

      CREATE TRIGGER typed_question_versions_revision_must_increment
      BEFORE UPDATE ON typed_question_item_versions
      WHEN NEW.revision <> OLD.revision + 1
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_revision_must_increment');
      END;

      CREATE TRIGGER typed_question_versions_status_transition
      BEFORE UPDATE OF status ON typed_question_item_versions
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status = 'published')
          OR (OLD.status = 'published' AND NEW.status = 'retired')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_version_status_transition');
      END;

      CREATE TRIGGER typed_question_versions_published_content_is_immutable
      BEFORE UPDATE OF interaction_type, correction_mode, scoring_strategy,
        partial_credit, accessibility_ready, print_supported, definition_json,
        definition_hash
      ON typed_question_item_versions
      WHEN OLD.status <> 'draft'
        AND (
          NEW.interaction_type IS NOT OLD.interaction_type
          OR NEW.correction_mode IS NOT OLD.correction_mode
          OR NEW.scoring_strategy IS NOT OLD.scoring_strategy
          OR NEW.partial_credit IS NOT OLD.partial_credit
          OR NEW.accessibility_ready IS NOT OLD.accessibility_ready
          OR NEW.print_supported IS NOT OLD.print_supported
          OR NEW.definition_json IS NOT OLD.definition_json
          OR NEW.definition_hash IS NOT OLD.definition_hash
        )
      BEGIN
        SELECT RAISE(ABORT, 'published_typed_question_version_is_immutable');
      END;

      CREATE TRIGGER typed_question_versions_lifecycle_metadata_is_immutable
      BEFORE UPDATE OF published_by, published_at, retired_by, retired_at
      ON typed_question_item_versions
      WHEN (
          OLD.published_by IS NOT NULL
          AND (
            NEW.published_by IS NOT OLD.published_by
            OR NEW.published_at IS NOT OLD.published_at
          )
        )
        OR (
          OLD.retired_by IS NOT NULL
          AND (
            NEW.retired_by IS NOT OLD.retired_by
            OR NEW.retired_at IS NOT OLD.retired_at
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_lifecycle_metadata_is_immutable');
      END;

      CREATE TRIGGER typed_question_versions_current_cannot_retire
      BEFORE UPDATE OF status ON typed_question_item_versions
      WHEN NEW.status = 'retired'
        AND EXISTS (
          SELECT 1
          FROM typed_question_current_versions
          WHERE version_id = OLD.id
        )
      BEGIN
        SELECT RAISE(ABORT, 'current_typed_question_version_cannot_be_retired');
      END;

      CREATE TRIGGER typed_question_versions_prevent_delete
      BEFORE DELETE ON typed_question_item_versions
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_version_cannot_be_deleted');
      END;

      CREATE TRIGGER typed_question_current_versions_validate_insert
      BEFORE INSERT ON typed_question_current_versions
      WHEN NEW.revision <> 1
        OR NOT EXISTS (
        SELECT 1
        FROM typed_question_item_versions version
        JOIN typed_question_items item ON item.id = version.item_id
        WHERE version.id = NEW.version_id
          AND version.item_id = NEW.item_id
          AND version.status = 'published'
          AND item.status <> 'retired'
      )
      BEGIN
        SELECT RAISE(ABORT, 'current_typed_question_version_must_be_published');
      END;

      CREATE TRIGGER typed_question_current_versions_validate_update
      BEFORE UPDATE ON typed_question_current_versions
      WHEN NEW.item_id IS NOT OLD.item_id
        OR NEW.version_id IS OLD.version_id
        OR NEW.revision <> OLD.revision + 1
        OR NOT EXISTS (
          SELECT 1
          FROM typed_question_item_versions version
          JOIN typed_question_items item ON item.id = version.item_id
          WHERE version.id = NEW.version_id
            AND version.item_id = NEW.item_id
            AND version.status = 'published'
            AND item.status <> 'retired'
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_current_typed_question_version_update');
      END;

      CREATE TRIGGER typed_question_current_versions_prevent_delete
      BEFORE DELETE ON typed_question_current_versions
      BEGIN
        SELECT RAISE(ABORT, 'current_typed_question_version_cannot_be_deleted');
      END;

      CREATE TRIGGER typed_question_snapshot_validate_insert
      BEFORE INSERT ON class_assessment_typed_item_snapshots
      WHEN NOT EXISTS (
        SELECT 1
        FROM class_assessment_items assessment_item
        JOIN class_assessment_assignments assignment
          ON assignment.id = assessment_item.assignment_id
        JOIN typed_question_items typed_item
          ON typed_item.id = NEW.typed_item_id
         AND typed_item.question_id = assessment_item.source_question_id
        JOIN typed_question_current_versions current_version
          ON current_version.item_id = typed_item.id
         AND current_version.version_id = NEW.typed_version_id
        JOIN typed_question_item_versions version
          ON version.id = current_version.version_id
         AND version.item_id = current_version.item_id
        WHERE assessment_item.id = NEW.assessment_item_id
          AND assignment.status = 'draft'
          AND typed_item.status = 'active'
          AND version.status = 'published'
          AND version.engine_version = NEW.engine_version
          AND version.format_version = NEW.format_version
          AND version.interaction_type = NEW.interaction_type
          AND version.correction_mode = NEW.correction_mode
          AND version.scoring_strategy = NEW.scoring_strategy
          AND version.partial_credit = NEW.partial_credit
          AND version.definition_json = NEW.definition_json
          AND version.definition_hash = NEW.definition_hash
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_typed_question_assessment_snapshot');
      END;

      CREATE TRIGGER typed_question_snapshot_prevent_update
      BEFORE UPDATE ON class_assessment_typed_item_snapshots
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_assessment_snapshot_is_immutable');
      END;

      CREATE TRIGGER typed_question_snapshot_prevent_delete
      BEFORE DELETE ON class_assessment_typed_item_snapshots
      WHEN (
        SELECT assignment.status
        FROM class_assessment_items assessment_item
        JOIN class_assessment_assignments assignment
          ON assignment.id = assessment_item.assignment_id
        WHERE assessment_item.id = OLD.assessment_item_id
      ) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_typed_question_snapshot_is_immutable');
      END;

      CREATE TRIGGER typed_question_audit_log_prevent_update
      BEFORE UPDATE ON typed_question_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_audit_log_is_immutable');
      END;

      CREATE TRIGGER typed_question_audit_log_prevent_delete
      BEFORE DELETE ON typed_question_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'typed_question_audit_log_is_immutable');
      END;

      CREATE TRIGGER typed_question_items_audit_insert
      AFTER INSERT ON typed_question_items
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, actor_id, current_value
        ) VALUES (
          'item_created', NEW.id, NEW.created_by, NEW.status
        );
      END;

      CREATE TRIGGER typed_question_items_audit_status
      AFTER UPDATE OF status ON typed_question_items
      WHEN NEW.status <> OLD.status
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, actor_id, previous_value, current_value
        ) VALUES (
          'item_status_changed', NEW.id, NEW.updated_by, OLD.status, NEW.status
        );
      END;

      CREATE TRIGGER typed_question_versions_audit_insert
      AFTER INSERT ON typed_question_item_versions
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, version_id, actor_id, current_value
        ) VALUES (
          'version_created', NEW.item_id, NEW.id, NEW.created_by, CAST(NEW.version AS TEXT)
        );
      END;

      CREATE TRIGGER typed_question_versions_audit_status
      AFTER UPDATE OF status ON typed_question_item_versions
      WHEN NEW.status <> OLD.status
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, version_id, actor_id, previous_value, current_value
        ) VALUES (
          CASE NEW.status
            WHEN 'published' THEN 'version_published'
            ELSE 'version_retired'
          END,
          NEW.item_id,
          NEW.id,
          CASE NEW.status
            WHEN 'published' THEN NEW.published_by
            ELSE NEW.retired_by
          END,
          OLD.status,
          NEW.status
        );
      END;

      CREATE TRIGGER typed_question_current_versions_audit_insert
      AFTER INSERT ON typed_question_current_versions
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, version_id, actor_id, current_value
        ) VALUES (
          'current_version_activated', NEW.item_id, NEW.version_id,
          NEW.activated_by, CAST(NEW.version_id AS TEXT)
        );
      END;

      CREATE TRIGGER typed_question_current_versions_audit_update
      AFTER UPDATE OF version_id ON typed_question_current_versions
      WHEN NEW.version_id <> OLD.version_id
      BEGIN
        INSERT INTO typed_question_audit_log (
          action, item_id, version_id, actor_id, previous_value, current_value
        ) VALUES (
          'current_version_activated', NEW.item_id, NEW.version_id,
          NEW.activated_by, CAST(OLD.version_id AS TEXT), CAST(NEW.version_id AS TEXT)
        );
      END;

      INSERT INTO product_releases (
        version,
        title,
        description,
        status
      ) VALUES (
        '2.2.0',
        'Motor tipado de questoes',
        'Fundacao versionada, acessivel, imprimivel e auditavel para novos formatos de questao.',
        'draft'
      );

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
        'question_bank.typed_engine',
        'Motor tipado de questoes',
        'Habilita gradualmente a nova fundacao de questoes tipadas e versionadas.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.2.0';
    `);
  },
};
