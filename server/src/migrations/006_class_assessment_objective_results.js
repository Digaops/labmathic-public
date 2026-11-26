module.exports = {
  version: 6,
  name: 'class_assessment_objective_results',
  description: 'Cria tentativas e respostas objetivas auditáveis para correção e diagnóstico por habilidade.',
  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX idx_class_assessment_participants_result_identity
        ON class_assessment_participants(
          id, assignment_id, class_id, student_id, owner_teacher_id
        );

      CREATE UNIQUE INDEX idx_class_assessment_options_result_identity
        ON class_assessment_item_options(
          id, assessment_item_id, assignment_id, class_id, owner_teacher_id
        );

      CREATE TABLE class_assessment_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        participant_id INTEGER NOT NULL,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        attempt_number INTEGER NOT NULL DEFAULT 1 CHECK(attempt_number > 0),
        supersedes_attempt_id INTEGER,
        submission_channel TEXT NOT NULL DEFAULT 'teacher_entry'
          CHECK(submission_channel IN ('teacher_entry', 'student_online', 'import')),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'submitted', 'voided')),
        question_count INTEGER NOT NULL CHECK(question_count BETWEEN 1 AND 100),
        answered_count INTEGER NOT NULL DEFAULT 0
          CHECK(answered_count BETWEEN 0 AND question_count),
        correct_count INTEGER
          CHECK(correct_count IS NULL OR correct_count BETWEEN 0 AND question_count),
        score_percentage REAL
          CHECK(score_percentage IS NULL OR score_percentage BETWEEN 0 AND 100),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME,
        voided_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(julianday(started_at) IS NOT NULL),
        CHECK(submitted_at IS NULL OR julianday(submitted_at) IS NOT NULL),
        CHECK(voided_at IS NULL OR julianday(voided_at) IS NOT NULL),
        CHECK(
          (status = 'draft'
            AND submitted_at IS NULL
            AND voided_at IS NULL
            AND correct_count IS NULL
            AND score_percentage IS NULL)
          OR (status = 'submitted'
            AND submitted_at IS NOT NULL
            AND voided_at IS NULL
            AND correct_count IS NOT NULL
            AND score_percentage IS NOT NULL)
          OR (status = 'voided' AND voided_at IS NOT NULL)
        ),
        UNIQUE(participant_id, attempt_number),
        UNIQUE(id, assignment_id, class_id, owner_teacher_id),
        FOREIGN KEY (
          participant_id, assignment_id, class_id, student_id, owner_teacher_id
        ) REFERENCES class_assessment_participants(
          id, assignment_id, class_id, student_id, owner_teacher_id
        ) ON DELETE RESTRICT,
        FOREIGN KEY (supersedes_attempt_id)
          REFERENCES class_assessment_attempts(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX idx_class_assessment_attempts_current_participant
        ON class_assessment_attempts(participant_id)
        WHERE status <> 'voided';
      CREATE INDEX idx_class_assessment_attempts_assignment_status
        ON class_assessment_attempts(assignment_id, status, student_id);
      CREATE INDEX idx_class_assessment_attempts_owner_status
        ON class_assessment_attempts(owner_teacher_id, status, updated_at);

      CREATE TABLE class_assessment_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL,
        assessment_item_id INTEGER NOT NULL,
        selected_option_id INTEGER,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        is_correct INTEGER NOT NULL DEFAULT 0 CHECK(is_correct IN (0, 1)),
        answered_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(answered_at IS NULL OR julianday(answered_at) IS NOT NULL),
        CHECK(
          (selected_option_id IS NULL AND answered_at IS NULL AND is_correct = 0)
          OR (selected_option_id IS NOT NULL AND answered_at IS NOT NULL)
        ),
        UNIQUE(attempt_id, assessment_item_id),
        FOREIGN KEY (attempt_id, assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_attempts(id, assignment_id, class_id, owner_teacher_id)
          ON DELETE CASCADE,
        FOREIGN KEY (assessment_item_id, assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_items(id, assignment_id, class_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (
          selected_option_id, assessment_item_id, assignment_id, class_id, owner_teacher_id
        ) REFERENCES class_assessment_item_options(
          id, assessment_item_id, assignment_id, class_id, owner_teacher_id
        ) ON DELETE RESTRICT
      );

      CREATE INDEX idx_class_assessment_responses_attempt
        ON class_assessment_responses(attempt_id, assessment_item_id);
      CREATE INDEX idx_class_assessment_responses_item_result
        ON class_assessment_responses(assessment_item_id, is_correct, attempt_id);

      CREATE TRIGGER class_assessment_attempts_validate_insert
      BEFORE INSERT ON class_assessment_attempts
      BEGIN
        SELECT CASE
          WHEN NEW.status <> 'draft'
          THEN RAISE(ABORT, 'assessment_attempt_must_start_as_draft')
        END;

        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM class_assessment_assignments assignment
            WHERE assignment.id = NEW.assignment_id
              AND assignment.class_id = NEW.class_id
              AND assignment.owner_teacher_id = NEW.owner_teacher_id
              AND assignment.status IN ('open', 'closed')
              AND assignment.question_count = NEW.question_count
          )
          THEN RAISE(ABORT, 'assessment_attempt_assignment_unavailable')
        END;

        SELECT CASE
          WHEN NEW.supersedes_attempt_id IS NOT NULL AND NOT EXISTS (
            SELECT 1
            FROM class_assessment_attempts previous
            WHERE previous.id = NEW.supersedes_attempt_id
              AND previous.participant_id = NEW.participant_id
              AND previous.status = 'voided'
              AND previous.attempt_number < NEW.attempt_number
          )
          THEN RAISE(ABORT, 'assessment_attempt_invalid_supersession')
        END;
      END;

      CREATE TRIGGER class_assessment_attempt_identity_is_immutable
      BEFORE UPDATE OF
        public_id,
        participant_id,
        assignment_id,
        class_id,
        student_id,
        owner_teacher_id,
        attempt_number,
        supersedes_attempt_id,
        submission_channel,
        question_count
      ON class_assessment_attempts
      BEGIN
        SELECT RAISE(ABORT, 'assessment_attempt_identity_is_immutable');
      END;

      CREATE TRIGGER class_assessment_attempt_status_transition
      BEFORE UPDATE OF status ON class_assessment_attempts
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status IN ('submitted', 'voided'))
          OR (OLD.status = 'submitted' AND NEW.status = 'voided')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_assessment_attempt_status_transition');
      END;

      CREATE TRIGGER class_assessment_attempt_validate_submission
      BEFORE UPDATE OF status ON class_assessment_attempts
      WHEN OLD.status = 'draft' AND NEW.status = 'submitted'
      BEGIN
        SELECT CASE
          WHEN (SELECT COUNT(*) FROM class_assessment_responses WHERE attempt_id = OLD.id)
            <> OLD.question_count
          THEN RAISE(ABORT, 'assessment_attempt_responses_incomplete')
        END;

        SELECT CASE
          WHEN NEW.answered_count <> (
            SELECT COUNT(*)
            FROM class_assessment_responses
            WHERE attempt_id = OLD.id AND selected_option_id IS NOT NULL
          )
          OR NEW.correct_count <> (
            SELECT COUNT(*)
            FROM class_assessment_responses
            WHERE attempt_id = OLD.id AND is_correct = 1
          )
          OR ABS(
            NEW.score_percentage
            - (NEW.correct_count * 100.0 / OLD.question_count)
          ) > 0.000001
          THEN RAISE(ABORT, 'assessment_attempt_score_mismatch')
        END;
      END;

      CREATE TRIGGER class_assessment_attempt_scores_are_immutable
      BEFORE UPDATE OF answered_count, correct_count, score_percentage, submitted_at
      ON class_assessment_attempts
      WHEN OLD.status <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'submitted_assessment_score_is_immutable');
      END;

      CREATE TRIGGER class_assessment_responses_validate_insert
      BEFORE INSERT ON class_assessment_responses
      WHEN (SELECT status FROM class_assessment_attempts WHERE id = NEW.attempt_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'assessment_responses_are_immutable');
      END;

      CREATE TRIGGER class_assessment_responses_validate_score_insert
      BEFORE INSERT ON class_assessment_responses
      WHEN NEW.selected_option_id IS NOT NULL
        AND COALESCE((
          SELECT option.is_correct
          FROM class_assessment_item_options option
          WHERE option.id = NEW.selected_option_id
            AND option.assessment_item_id = NEW.assessment_item_id
            AND option.assignment_id = NEW.assignment_id
            AND option.class_id = NEW.class_id
            AND option.owner_teacher_id = NEW.owner_teacher_id
        ), -1) <> NEW.is_correct
      BEGIN
        SELECT RAISE(ABORT, 'assessment_response_score_mismatch');
      END;

      CREATE TRIGGER class_assessment_responses_validate_update
      BEFORE UPDATE ON class_assessment_responses
      WHEN (SELECT status FROM class_assessment_attempts WHERE id = OLD.attempt_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'assessment_responses_are_immutable');
      END;

      CREATE TRIGGER class_assessment_responses_validate_score_update
      BEFORE UPDATE ON class_assessment_responses
      WHEN NEW.selected_option_id IS NOT NULL
        AND COALESCE((
          SELECT option.is_correct
          FROM class_assessment_item_options option
          WHERE option.id = NEW.selected_option_id
            AND option.assessment_item_id = NEW.assessment_item_id
            AND option.assignment_id = NEW.assignment_id
            AND option.class_id = NEW.class_id
            AND option.owner_teacher_id = NEW.owner_teacher_id
        ), -1) <> NEW.is_correct
      BEGIN
        SELECT RAISE(ABORT, 'assessment_response_score_mismatch');
      END;

      CREATE TRIGGER class_assessment_responses_validate_delete
      BEFORE DELETE ON class_assessment_responses
      WHEN (SELECT status FROM class_assessment_attempts WHERE id = OLD.attempt_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'assessment_responses_are_immutable');
      END;
    `);
  },
};
