module.exports = {
  version: 38,
  name: 'numeric_editorial_workflow',
  description: 'Revisão independente e versões numéricas preservadas, sem ativar aplicação on-line.',
  up(db) {
    db.exec(`
      DROP TRIGGER numeric_draft_no_review;
      DROP TRIGGER numeric_draft_version_insert_guard;
      DROP TRIGGER numeric_draft_version_update_guard;
      CREATE TRIGGER numeric_draft_version_insert_guard BEFORE INSERT ON typed_question_item_versions
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id=i.question_id
          WHERE i.id=NEW.item_id AND q.question_type='numeric_draft')
        AND (NEW.status<>'draft' OR NEW.interaction_type<>'numeric' OR NEW.scoring_strategy<>'numeric_exact'
          OR EXISTS(SELECT 1 FROM typed_question_item_versions WHERE item_id=NEW.item_id AND status='draft'))
      BEGIN SELECT RAISE(ABORT,'numeric_version_requires_exact_draft'); END;
      CREATE TRIGGER numeric_draft_version_update_guard BEFORE UPDATE ON typed_question_item_versions
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id=i.question_id
          WHERE i.id=NEW.item_id AND q.question_type='numeric_draft')
        AND (NEW.status NOT IN ('draft','published') OR NEW.interaction_type<>'numeric' OR NEW.scoring_strategy<>'numeric_exact')
      BEGIN SELECT RAISE(ABORT,'numeric_version_requires_editorial_review'); END;
      CREATE TRIGGER numeric_item_not_online BEFORE UPDATE ON typed_question_items
        WHEN EXISTS(SELECT 1 FROM questions WHERE id=NEW.question_id AND question_type='numeric_draft')
        AND NEW.status<>'draft'
      BEGIN SELECT RAISE(ABORT,'numeric_online_application_not_enabled'); END;
      CREATE TRIGGER numeric_current_version_not_online BEFORE INSERT ON typed_question_current_versions
        WHEN EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id=i.question_id
          WHERE i.id=NEW.item_id AND q.question_type='numeric_draft')
      BEGIN SELECT RAISE(ABORT,'numeric_online_application_not_enabled'); END;
      CREATE TABLE numeric_question_review_snapshots (
        review_id INTEGER PRIMARY KEY REFERENCES typed_question_review_cycles(id) ON DELETE RESTRICT,
        payload_json TEXT NOT NULL CHECK(json_valid(payload_json) AND length(payload_json)<=100000),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TRIGGER numeric_review_snapshot_no_update BEFORE UPDATE ON numeric_question_review_snapshots
      BEGIN SELECT RAISE(ABORT,'numeric_review_snapshot_is_immutable'); END;
      CREATE TRIGGER numeric_review_snapshot_no_delete BEFORE DELETE ON numeric_question_review_snapshots
      BEGIN SELECT RAISE(ABORT,'numeric_review_snapshot_is_immutable'); END;
      CREATE TRIGGER numeric_publish_requires_snapshot BEFORE UPDATE OF status ON typed_question_item_versions
        WHEN NEW.status='published' AND EXISTS(SELECT 1 FROM typed_question_items i JOIN questions q ON q.id=i.question_id
          WHERE i.id=NEW.item_id AND q.question_type='numeric_draft')
        AND NOT EXISTS(SELECT 1 FROM typed_question_review_cycles r JOIN numeric_question_review_snapshots s ON s.review_id=r.id
          WHERE r.version_id=OLD.id AND r.version_revision=OLD.revision AND r.definition_hash=OLD.definition_hash AND r.status='approved')
      BEGIN SELECT RAISE(ABORT,'numeric_review_snapshot_required'); END;
    `);
  },
};
