module.exports = {
  version: 13,
  name: 'learning_recovery_monitoring_cycle',
  description: 'Vincula recursos e uma avaliacao de monitoramento ao ciclo auditavel de recomposicao.',
  up(db) {
    db.exec(`
      ALTER TABLE teaching_plan_lessons
        ADD COLUMN lesson_phase TEXT NOT NULL DEFAULT 'intervention'
        CHECK(lesson_phase IN ('intervention', 'monitoring'));

      UPDATE teaching_plan_lessons
      SET lesson_phase = 'monitoring'
      WHERE plan_id IN (
        SELECT id FROM teaching_plans WHERE source_recovery_plan_id IS NOT NULL
      )
        AND sequence_order = (
          SELECT MAX(last_lesson.sequence_order)
          FROM teaching_plan_lessons last_lesson
          WHERE last_lesson.plan_id = teaching_plan_lessons.plan_id
        );

      CREATE INDEX idx_teaching_plan_lessons_phase
        ON teaching_plan_lessons(plan_id, lesson_phase, status, sequence_order);

      CREATE TRIGGER teaching_plan_lesson_phase_is_immutable
      BEFORE UPDATE OF lesson_phase ON teaching_plan_lessons
      WHEN NEW.lesson_phase IS NOT OLD.lesson_phase
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_phase_is_immutable');
      END;

      CREATE TABLE learning_recovery_monitoring_cycles (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        recovery_plan_id INTEGER NOT NULL,
        execution_plan_id INTEGER NOT NULL,
        monitoring_lesson_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        question_set_id INTEGER NOT NULL,
        assignment_id INTEGER,
        methodology_version TEXT NOT NULL DEFAULT 'descriptive-v1'
          CHECK(methodology_version = 'descriptive-v1'),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        UNIQUE(recovery_plan_id),
        UNIQUE(question_set_id),
        UNIQUE(assignment_id),
        UNIQUE(id, recovery_plan_id, owner_teacher_id, class_id),
        FOREIGN KEY (recovery_plan_id, owner_teacher_id, class_id)
          REFERENCES learning_recovery_plans(id, owner_teacher_id, class_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (execution_plan_id, owner_teacher_id)
          REFERENCES teaching_plans(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (monitoring_lesson_id, execution_plan_id, owner_teacher_id)
          REFERENCES teaching_plan_lessons(id, plan_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE RESTRICT,
        FOREIGN KEY (assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_recovery_monitoring_assignment
        ON learning_recovery_monitoring_cycles(assignment_id, recovery_plan_id);

      CREATE TRIGGER recovery_monitoring_cycle_validate_insert
      BEFORE INSERT ON learning_recovery_monitoring_cycles
      WHEN NOT EXISTS (
        SELECT 1
        FROM learning_recovery_plans recovery
        JOIN teaching_plans execution
          ON execution.id = NEW.execution_plan_id
          AND execution.source_recovery_plan_id = recovery.id
          AND execution.owner_teacher_id = recovery.owner_teacher_id
          AND execution.class_id = recovery.class_id
        JOIN teaching_plan_lessons lesson
          ON lesson.id = NEW.monitoring_lesson_id
          AND lesson.plan_id = execution.id
          AND lesson.owner_teacher_id = execution.owner_teacher_id
        JOIN question_sets question_set ON question_set.id = NEW.question_set_id
        WHERE recovery.id = NEW.recovery_plan_id
          AND recovery.owner_teacher_id = NEW.owner_teacher_id
          AND recovery.class_id = NEW.class_id
          AND recovery.status = 'active'
          AND execution.status = 'active'
          AND lesson.status = 'planned'
          AND lesson.lesson_phase = 'monitoring'
          AND question_set.user_id = NEW.owner_teacher_id
          AND question_set.is_public = 0
          AND NEW.assignment_id IS NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_recovery_monitoring_cycle');
      END;

      CREATE TRIGGER recovery_monitoring_cycle_identity_is_immutable
      BEFORE UPDATE OF public_id, recovery_plan_id, execution_plan_id,
        monitoring_lesson_id, owner_teacher_id, class_id, question_set_id,
        methodology_version, created_by, created_at
      ON learning_recovery_monitoring_cycles
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_identity_is_immutable');
      END;

      CREATE TRIGGER recovery_monitoring_assignment_is_write_once
      BEFORE UPDATE OF assignment_id ON learning_recovery_monitoring_cycles
      WHEN NOT (
        OLD.assignment_id IS NULL
        AND NEW.assignment_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM class_assessment_assignments assignment
          WHERE assignment.id = NEW.assignment_id
            AND assignment.class_id = OLD.class_id
            AND assignment.owner_teacher_id = OLD.owner_teacher_id
            AND assignment.source_question_set_id = OLD.question_set_id
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_assignment_is_immutable');
      END;

      CREATE TRIGGER recovery_monitoring_cycle_prevent_delete
      BEFORE DELETE ON learning_recovery_monitoring_cycles
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_history_is_immutable');
      END;

      CREATE TRIGGER recovery_monitoring_assignment_single_use
      BEFORE INSERT ON class_assessment_assignments
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = NEW.source_question_set_id
          AND monitoring.assignment_id IS NOT NULL
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_assignment_already_created');
      END;

      CREATE TRIGGER recovery_monitoring_assignment_link
      AFTER INSERT ON class_assessment_assignments
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = NEW.source_question_set_id
          AND monitoring.owner_teacher_id = NEW.owner_teacher_id
          AND monitoring.class_id = NEW.class_id
          AND monitoring.assignment_id IS NULL
      )
      BEGIN
        UPDATE learning_recovery_monitoring_cycles
        SET assignment_id = NEW.id,
            revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE question_set_id = NEW.source_question_set_id
          AND owner_teacher_id = NEW.owner_teacher_id
          AND class_id = NEW.class_id
          AND assignment_id IS NULL;
      END;

      CREATE TRIGGER recovery_monitoring_assignment_link_revision
      AFTER UPDATE OF assignment_id ON learning_recovery_monitoring_cycles
      WHEN NEW.assignment_id IS NOT NULL AND OLD.assignment_id IS NULL
      BEGIN
        UPDATE teaching_plans
        SET revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.execution_plan_id AND status = 'active';

        UPDATE learning_recovery_plans
        SET revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.recovery_plan_id AND status = 'active';
      END;

      CREATE TRIGGER recovery_monitoring_assignment_status_revision
      AFTER UPDATE OF status ON class_assessment_assignments
      WHEN NEW.status IS NOT OLD.status
        AND EXISTS (
          SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
          WHERE monitoring.assignment_id = NEW.id
        )
      BEGIN
        UPDATE learning_recovery_monitoring_cycles
        SET revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE assignment_id = NEW.id;

        UPDATE teaching_plans
        SET revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT execution_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.id
        ) AND status = 'active';

        UPDATE learning_recovery_plans
        SET revision = revision + 1,
            updated_by = NEW.owner_teacher_id,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT recovery_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.id
        ) AND status = 'active';
      END;

      CREATE TRIGGER recovery_monitoring_attempt_insert_revision
      AFTER INSERT ON class_assessment_attempts
      WHEN NEW.status = 'submitted'
        AND EXISTS (
          SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
          WHERE monitoring.assignment_id = NEW.assignment_id
        )
      BEGIN
        UPDATE learning_recovery_monitoring_cycles
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE assignment_id = NEW.assignment_id;
        UPDATE teaching_plans
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT execution_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.assignment_id
        ) AND status = 'active';
        UPDATE learning_recovery_plans
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT recovery_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.assignment_id
        ) AND status = 'active';
      END;

      CREATE TRIGGER recovery_monitoring_attempt_update_revision
      AFTER UPDATE OF status ON class_assessment_attempts
      WHEN NEW.status = 'submitted' AND OLD.status IS NOT NEW.status
        AND EXISTS (
          SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
          WHERE monitoring.assignment_id = NEW.assignment_id
        )
      BEGIN
        UPDATE learning_recovery_monitoring_cycles
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE assignment_id = NEW.assignment_id;
        UPDATE teaching_plans
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT execution_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.assignment_id
        ) AND status = 'active';
        UPDATE learning_recovery_plans
        SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
        WHERE id = (
          SELECT recovery_plan_id FROM learning_recovery_monitoring_cycles
          WHERE assignment_id = NEW.assignment_id
        ) AND status = 'active';
      END;

      CREATE TRIGGER recovery_monitoring_question_set_is_frozen
      BEFORE UPDATE OF user_id, title, description, is_public ON question_sets
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = OLD.id
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_question_set_is_frozen');
      END;

      CREATE TRIGGER recovery_monitoring_question_set_item_insert_is_frozen
      BEFORE INSERT ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = NEW.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_question_set_is_frozen');
      END;

      CREATE TRIGGER recovery_monitoring_question_set_item_update_is_frozen
      BEFORE UPDATE ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = OLD.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_question_set_is_frozen');
      END;

      CREATE TRIGGER recovery_monitoring_question_set_item_delete_is_frozen
      BEFORE DELETE ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM learning_recovery_monitoring_cycles monitoring
        WHERE monitoring.question_set_id = OLD.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_monitoring_question_set_is_frozen');
      END;

      CREATE TRIGGER recovery_execution_completion_requires_monitoring_evidence
      BEFORE UPDATE OF status ON teaching_plans
      WHEN OLD.status = 'active'
        AND NEW.status = 'completed'
        AND OLD.source_recovery_plan_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM teaching_plan_lessons monitoring_lesson
          WHERE monitoring_lesson.plan_id = OLD.id
            AND monitoring_lesson.owner_teacher_id = OLD.owner_teacher_id
            AND monitoring_lesson.lesson_phase = 'monitoring'
            AND (
              (
                monitoring_lesson.status = 'skipped'
                AND length(trim(COALESCE(monitoring_lesson.teacher_notes, ''))) >= 10
              )
              OR (
                monitoring_lesson.status = 'taught'
                AND EXISTS (
                  SELECT 1
                  FROM learning_recovery_monitoring_cycles monitoring
                  JOIN class_assessment_assignments assignment
                    ON assignment.id = monitoring.assignment_id
                    AND assignment.class_id = monitoring.class_id
                    AND assignment.owner_teacher_id = monitoring.owner_teacher_id
                  WHERE monitoring.recovery_plan_id = OLD.source_recovery_plan_id
                    AND monitoring.execution_plan_id = OLD.id
                    AND monitoring.monitoring_lesson_id = monitoring_lesson.id
                    AND assignment.status = 'closed'
                    AND EXISTS (
                      SELECT 1 FROM class_assessment_attempts attempt
                      WHERE attempt.assignment_id = assignment.id
                        AND attempt.status = 'submitted'
                    )
                )
              )
            )
        )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_execution_requires_monitoring_evidence');
      END;
    `);
  },
};
