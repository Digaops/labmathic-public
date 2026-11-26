module.exports = {
  version: 4,
  name: 'class_assessment_assignments_foundation',
  description: 'Fortalece entradas idempotentes e cria a fundacao versionada para aplicar simulados as turmas.',
  up(db) {
    db.exec(`
      ALTER TABLE school_class_entry_code_redemptions
        ADD COLUMN request_digest TEXT
        CHECK(
          request_digest IS NULL
          OR (
            length(request_digest) = 64
            AND request_digest NOT GLOB '*[^0-9a-f]*'
          )
        );

      CREATE UNIQUE INDEX idx_school_class_entry_redemptions_request
        ON school_class_entry_code_redemptions(entry_code_id, request_digest)
        WHERE request_digest IS NOT NULL;

      ALTER TABLE school_class_enrollments
        ADD COLUMN revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0);

      CREATE TABLE class_assessment_assignments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        source_question_set_id INTEGER,
        title_snapshot TEXT NOT NULL,
        description_snapshot TEXT,
        instructions TEXT,
        snapshot_version INTEGER NOT NULL DEFAULT 1 CHECK(snapshot_version = 1),
        snapshot_hash TEXT NOT NULL COLLATE BINARY,
        question_count INTEGER NOT NULL CHECK(question_count BETWEEN 1 AND 100),
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'scheduled', 'open', 'closed', 'cancelled')),
        opens_at DATETIME,
        closes_at DATETIME,
        time_limit_minutes INTEGER
          CHECK(time_limit_minutes IS NULL OR time_limit_minutes BETWEEN 5 AND 300),
        randomize_questions INTEGER NOT NULL DEFAULT 0
          CHECK(randomize_questions IN (0, 1)),
        randomize_options INTEGER NOT NULL DEFAULT 0
          CHECK(randomize_options IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        opened_at DATETIME,
        closed_at DATETIME,
        cancelled_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(title_snapshot)) BETWEEN 1 AND 200),
        CHECK(description_snapshot IS NULL OR length(description_snapshot) <= 5000),
        CHECK(instructions IS NULL OR length(instructions) <= 2000),
        CHECK(
          length(snapshot_hash) = 64
          AND snapshot_hash NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(opens_at IS NULL OR julianday(opens_at) IS NOT NULL),
        CHECK(closes_at IS NULL OR julianday(closes_at) IS NOT NULL),
        CHECK(
          opens_at IS NULL OR closes_at IS NULL
          OR julianday(closes_at) > julianday(opens_at)
        ),
        CHECK(opened_at IS NULL OR julianday(opened_at) IS NOT NULL),
        CHECK(closed_at IS NULL OR julianday(closed_at) IS NOT NULL),
        CHECK(cancelled_at IS NULL OR julianday(cancelled_at) IS NOT NULL),
        CHECK(status <> 'scheduled' OR opens_at IS NOT NULL),
        CHECK(status <> 'open' OR opened_at IS NOT NULL),
        CHECK(status <> 'closed' OR closed_at IS NOT NULL),
        CHECK(status <> 'cancelled' OR cancelled_at IS NOT NULL),
        UNIQUE(id, class_id, owner_teacher_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (source_question_set_id)
          REFERENCES question_sets(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE class_assessment_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        source_question_id INTEGER,
        source_skill_id INTEGER,
        question_code_snapshot TEXT NOT NULL,
        skill_code_snapshot TEXT,
        skill_description_snapshot TEXT,
        statement_snapshot TEXT NOT NULL,
        support_text_snapshot TEXT,
        image_path_snapshot TEXT,
        development_space_snapshot TEXT NOT NULL DEFAULT 'none'
          CHECK(development_space_snapshot IN ('none', 'small', 'medium', 'large')),
        difficulty_snapshot TEXT NOT NULL
          CHECK(difficulty_snapshot IN ('facil', 'media', 'dificil')),
        question_type_snapshot TEXT NOT NULL DEFAULT 'multiple_choice'
          CHECK(question_type_snapshot = 'multiple_choice'),
        explanation_snapshot TEXT,
        sort_order INTEGER NOT NULL CHECK(sort_order >= 0),
        show_image INTEGER NOT NULL DEFAULT 1 CHECK(show_image IN (0, 1)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(question_code_snapshot)) BETWEEN 1 AND 100),
        CHECK(length(trim(statement_snapshot)) BETWEEN 1 AND 20000),
        UNIQUE(assignment_id, sort_order),
        UNIQUE(assignment_id, source_question_id),
        UNIQUE(id, assignment_id, class_id, owner_teacher_id),
        FOREIGN KEY (assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id)
          ON DELETE CASCADE,
        FOREIGN KEY (source_question_id) REFERENCES questions(id) ON DELETE SET NULL,
        FOREIGN KEY (source_skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
      );

      CREATE TABLE class_assessment_item_options (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assessment_item_id INTEGER NOT NULL,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        option_label TEXT NOT NULL CHECK(option_label IN ('A', 'B', 'C', 'D')),
        option_text_snapshot TEXT NOT NULL,
        is_correct INTEGER NOT NULL DEFAULT 0 CHECK(is_correct IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0 CHECK(sort_order BETWEEN 0 AND 3),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(option_text_snapshot)) BETWEEN 1 AND 10000),
        UNIQUE(assessment_item_id, option_label),
        UNIQUE(assessment_item_id, sort_order),
        FOREIGN KEY (assessment_item_id, assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_items(id, assignment_id, class_id, owner_teacher_id)
          ON DELETE CASCADE
      );

      CREATE TABLE class_assessment_participants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        enrollment_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'assigned'
          CHECK(status IN ('assigned', 'in_progress', 'submitted', 'exempted')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        started_at DATETIME,
        submitted_at DATETIME,
        exempted_at DATETIME,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(julianday(assigned_at) IS NOT NULL),
        CHECK(started_at IS NULL OR julianday(started_at) IS NOT NULL),
        CHECK(submitted_at IS NULL OR julianday(submitted_at) IS NOT NULL),
        CHECK(exempted_at IS NULL OR julianday(exempted_at) IS NOT NULL),
        CHECK(status <> 'in_progress' OR started_at IS NOT NULL),
        CHECK(status <> 'submitted' OR submitted_at IS NOT NULL),
        CHECK(status <> 'exempted' OR exempted_at IS NOT NULL),
        UNIQUE(assignment_id, student_id),
        UNIQUE(id, assignment_id, student_id, owner_teacher_id),
        FOREIGN KEY (assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (student_id, owner_teacher_id)
          REFERENCES students(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (enrollment_id, class_id, student_id, owner_teacher_id)
          REFERENCES school_class_enrollments(id, class_id, student_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_class_assessment_assignments_class
        ON class_assessment_assignments(class_id, status, opens_at);
      CREATE INDEX idx_class_assessment_assignments_owner
        ON class_assessment_assignments(owner_teacher_id, status, updated_at);
      CREATE INDEX idx_class_assessment_assignments_source
        ON class_assessment_assignments(source_question_set_id);
      CREATE INDEX idx_class_assessment_items_assignment
        ON class_assessment_items(assignment_id, sort_order);
      CREATE INDEX idx_class_assessment_items_skill
        ON class_assessment_items(source_skill_id);
      CREATE INDEX idx_class_assessment_participants_assignment
        ON class_assessment_participants(assignment_id, status, student_id);
      CREATE INDEX idx_class_assessment_participants_student
        ON class_assessment_participants(student_id, status, assignment_id);

      CREATE TRIGGER class_assessment_assignment_status_transition
      BEFORE UPDATE OF status ON class_assessment_assignments
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status IN ('scheduled', 'open', 'cancelled'))
          OR (OLD.status = 'scheduled' AND NEW.status IN ('draft', 'open', 'cancelled'))
          OR (OLD.status = 'open' AND NEW.status IN ('closed', 'cancelled'))
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_assessment_status_transition');
      END;

      CREATE TRIGGER class_assessment_assignment_validate_publication
      BEFORE UPDATE OF status ON class_assessment_assignments
      WHEN NEW.status IN ('scheduled', 'open') AND NEW.status <> OLD.status
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM school_classes
            WHERE id = NEW.class_id
              AND owner_teacher_id = NEW.owner_teacher_id
              AND status = 'active'
          )
          THEN RAISE(ABORT, 'assessment_class_is_not_active')
        END;

        SELECT CASE
          WHEN (
            SELECT COUNT(*)
            FROM class_assessment_items
            WHERE assignment_id = NEW.id
          ) <> NEW.question_count
          THEN RAISE(ABORT, 'assessment_question_count_mismatch')
        END;

        SELECT CASE
          WHEN EXISTS (
            SELECT 1
            FROM class_assessment_items item
            LEFT JOIN class_assessment_item_options option
              ON option.assessment_item_id = item.id
            WHERE item.assignment_id = NEW.id
            GROUP BY item.id
            HAVING COUNT(option.id) <> 4
              OR SUM(CASE WHEN option.is_correct = 1 THEN 1 ELSE 0 END) <> 1
          )
          THEN RAISE(ABORT, 'assessment_options_are_incomplete')
        END;

        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM class_assessment_participants
            WHERE assignment_id = NEW.id
          )
          THEN RAISE(ABORT, 'assessment_has_no_participants')
        END;
      END;

      CREATE TRIGGER class_assessment_snapshot_prevent_update
      BEFORE UPDATE OF
        title_snapshot,
        description_snapshot,
        snapshot_version,
        snapshot_hash,
        question_count
      ON class_assessment_assignments
      WHEN OLD.status <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_snapshot_is_immutable');
      END;

      CREATE TRIGGER class_assessment_source_reference_prevent_repoint
      BEFORE UPDATE OF source_question_set_id ON class_assessment_assignments
      WHEN OLD.status <> 'draft'
        AND NEW.source_question_set_id IS NOT NULL
        AND NEW.source_question_set_id IS NOT OLD.source_question_set_id
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_source_cannot_be_repointed');
      END;

      CREATE TRIGGER class_assessment_items_prevent_insert
      BEFORE INSERT ON class_assessment_items
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = NEW.assignment_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_items_are_immutable');
      END;

      CREATE TRIGGER class_assessment_items_prevent_update
      BEFORE UPDATE OF
        assignment_id,
        class_id,
        owner_teacher_id,
        question_code_snapshot,
        skill_code_snapshot,
        skill_description_snapshot,
        statement_snapshot,
        support_text_snapshot,
        image_path_snapshot,
        development_space_snapshot,
        difficulty_snapshot,
        question_type_snapshot,
        explanation_snapshot,
        sort_order,
        show_image
      ON class_assessment_items
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_items_are_immutable');
      END;

      CREATE TRIGGER class_assessment_item_source_reference_prevent_repoint
      BEFORE UPDATE OF source_question_id, source_skill_id ON class_assessment_items
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id) <> 'draft'
        AND (
          (
            NEW.source_question_id IS NOT NULL
            AND NEW.source_question_id IS NOT OLD.source_question_id
          )
          OR (
            NEW.source_skill_id IS NOT NULL
            AND NEW.source_skill_id IS NOT OLD.source_skill_id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_source_cannot_be_repointed');
      END;

      CREATE TRIGGER class_assessment_items_prevent_delete
      BEFORE DELETE ON class_assessment_items
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_items_are_immutable');
      END;

      CREATE TRIGGER class_assessment_options_prevent_insert
      BEFORE INSERT ON class_assessment_item_options
      WHEN (
        SELECT caa.status
        FROM class_assessment_assignments caa
        WHERE caa.id = NEW.assignment_id
      ) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_options_are_immutable');
      END;

      CREATE TRIGGER class_assessment_options_prevent_update
      BEFORE UPDATE ON class_assessment_item_options
      WHEN (
        SELECT caa.status
        FROM class_assessment_assignments caa
        WHERE caa.id = OLD.assignment_id
      ) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_options_are_immutable');
      END;

      CREATE TRIGGER class_assessment_options_prevent_delete
      BEFORE DELETE ON class_assessment_item_options
      WHEN (
        SELECT caa.status
        FROM class_assessment_assignments caa
        WHERE caa.id = OLD.assignment_id
      ) <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'published_assessment_options_are_immutable');
      END;

      CREATE TRIGGER class_assessment_participants_prevent_insert
      BEFORE INSERT ON class_assessment_participants
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = NEW.assignment_id)
        IN ('open', 'closed', 'cancelled')
      BEGIN
        SELECT RAISE(ABORT, 'assessment_roster_is_frozen');
      END;

      CREATE TRIGGER class_assessment_participants_validate_enrollment
      BEFORE INSERT ON class_assessment_participants
      WHEN NOT EXISTS (
        SELECT 1
        FROM school_class_enrollments enrollment
        JOIN students student ON student.id = enrollment.student_id
        WHERE enrollment.id = NEW.enrollment_id
          AND enrollment.class_id = NEW.class_id
          AND enrollment.student_id = NEW.student_id
          AND enrollment.owner_teacher_id = NEW.owner_teacher_id
          AND enrollment.status = 'active'
          AND student.status = 'active'
      )
      BEGIN
        SELECT RAISE(ABORT, 'assessment_participant_is_not_active');
      END;

      CREATE TRIGGER class_assessment_participant_identity_is_immutable
      BEFORE UPDATE OF
        assignment_id,
        class_id,
        student_id,
        enrollment_id,
        owner_teacher_id
      ON class_assessment_participants
      BEGIN
        SELECT RAISE(ABORT, 'assessment_participant_identity_is_immutable');
      END;

      CREATE TRIGGER class_assessment_participant_status_transition
      BEFORE UPDATE OF status ON class_assessment_participants
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'assigned' AND NEW.status IN ('in_progress', 'submitted', 'exempted'))
          OR (OLD.status = 'in_progress' AND NEW.status IN ('submitted', 'exempted'))
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_assessment_participant_status_transition');
      END;

      CREATE TRIGGER class_assessment_participants_prevent_delete
      BEFORE DELETE ON class_assessment_participants
      WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id)
        IN ('open', 'closed', 'cancelled')
      BEGIN
        SELECT RAISE(ABORT, 'assessment_roster_is_frozen');
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
        initial_flags.flag_key,
        initial_flags.name,
        initial_flags.description,
        product_releases.id,
        0,
        0,
        0
      FROM product_releases
      CROSS JOIN (
        SELECT
          'classes.assessment_assignments' AS flag_key,
          'Aplicacao de simulados em turmas' AS name,
          'Cria copias versionadas de simulados e seleciona participantes da turma.' AS description
        UNION ALL
        SELECT
          'classes.assessment_delivery',
          'Realizacao de simulados por estudantes',
          'Entrega controlada dos simulados e registro de tentativas.'
        UNION ALL
        SELECT
          'classes.assessment_results',
          'Resultados por estudante e habilidade',
          'Apuracao individual e por habilidade, sem calculo TRI automatico inicial.'
      ) AS initial_flags
      WHERE product_releases.version = '2.0.0';
    `);
  },
};
