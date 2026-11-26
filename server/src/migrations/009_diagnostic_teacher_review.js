module.exports = {
  version: 9,
  name: 'diagnostic_teacher_review',
  description: 'Registra a confirmacao explicita e auditavel da revisao pedagogica dos diagnosticos.',
  up(db) {
    db.exec(`
      CREATE TABLE diagnostic_question_set_reviews (
        question_set_id INTEGER PRIMARY KEY,
        owner_teacher_id INTEGER NOT NULL,
        reviewed_by INTEGER NOT NULL,
        confirmation_version TEXT NOT NULL DEFAULT 'teacher-review-v1'
          CHECK(confirmation_version = 'teacher-review-v1'),
        reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(reviewed_by = owner_teacher_id),
        FOREIGN KEY (question_set_id)
          REFERENCES diagnostic_question_sets(question_set_id) ON DELETE CASCADE,
        FOREIGN KEY (owner_teacher_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (reviewed_by) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE INDEX idx_diagnostic_reviews_owner_reviewed
        ON diagnostic_question_set_reviews(owner_teacher_id, reviewed_at);

      CREATE TRIGGER diagnostic_reviews_validate_insert
      BEFORE INSERT ON diagnostic_question_set_reviews
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT role FROM users WHERE id = NEW.reviewed_by), '') <> 'professor'
          THEN RAISE(ABORT, 'diagnostic_review_requires_professor')
        END;
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM diagnostic_question_sets diagnostic
            WHERE diagnostic.question_set_id = NEW.question_set_id
              AND diagnostic.owner_teacher_id = NEW.owner_teacher_id
              AND diagnostic.owner_teacher_id = NEW.reviewed_by
          )
          THEN RAISE(ABORT, 'diagnostic_review_requires_owner')
        END;
      END;

      CREATE TRIGGER diagnostic_reviews_are_immutable
      BEFORE UPDATE ON diagnostic_question_set_reviews
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_review_is_immutable');
      END;
    `);
  },
};
