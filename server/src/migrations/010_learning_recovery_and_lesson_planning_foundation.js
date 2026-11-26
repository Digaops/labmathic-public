module.exports = {
  version: 10,
  name: 'learning_recovery_and_lesson_planning_foundation',
  description: 'Cria a fundacao segura para recomposicao da aprendizagem e planejamento de aulas.',
  up(db) {
    db.exec(`
      CREATE TABLE material_bncc_skills (
        material_id INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        link_source TEXT NOT NULL DEFAULT 'manual'
          CHECK(link_source IN ('manual', 'reviewed_import')),
        linked_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (material_id, skill_id),
        FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE CASCADE,
        FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE CASCADE,
        FOREIGN KEY (linked_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_material_bncc_skills_skill
        ON material_bncc_skills(skill_id, material_id);

      CREATE TABLE learning_recovery_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        source_assignment_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        source_assessment_revision INTEGER NOT NULL CHECK(source_assessment_revision > 0),
        source_results_revision_hash TEXT NOT NULL,
        diagnostic_algorithm_version_snapshot TEXT NOT NULL,
        diagnostic_confirmation_version_snapshot TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'active', 'completed', 'archived')),
        methodology_version TEXT NOT NULL DEFAULT 'descriptive-v1'
          CHECK(methodology_version = 'descriptive-v1'),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        activated_at DATETIME,
        completed_at DATETIME,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(title)) BETWEEN 1 AND 160),
        CHECK(length(idempotency_key_hash) = 64),
        CHECK(length(request_fingerprint) = 64),
        CHECK(length(source_results_revision_hash) = 64),
        CHECK(length(trim(diagnostic_algorithm_version_snapshot)) BETWEEN 1 AND 64),
        CHECK(length(trim(diagnostic_confirmation_version_snapshot)) BETWEEN 1 AND 64),
        CHECK(activated_at IS NULL OR julianday(activated_at) IS NOT NULL),
        CHECK(completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
        CHECK(archived_at IS NULL OR julianday(archived_at) IS NOT NULL),
        CHECK(status <> 'active' OR activated_at IS NOT NULL),
        CHECK(status <> 'completed' OR completed_at IS NOT NULL),
        CHECK(status <> 'archived' OR archived_at IS NOT NULL),
        UNIQUE(source_assignment_id),
        UNIQUE(owner_teacher_id, idempotency_key_hash),
        UNIQUE(id, owner_teacher_id, class_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (source_assignment_id, class_id, owner_teacher_id)
          REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_learning_recovery_plans_owner_status
        ON learning_recovery_plans(owner_teacher_id, status, updated_at);
      CREATE INDEX idx_learning_recovery_plans_class_status
        ON learning_recovery_plans(class_id, status, updated_at);

      CREATE TABLE learning_recovery_plan_skills (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        plan_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        source_skill_id INTEGER,
        skill_code_snapshot TEXT NOT NULL,
        skill_description_snapshot TEXT NOT NULL,
        success_rate_snapshot REAL NOT NULL
          CHECK(success_rate_snapshot BETWEEN 0 AND 100),
        opportunity_count INTEGER NOT NULL CHECK(opportunity_count > 0),
        diagnostic_level TEXT NOT NULL
          CHECK(diagnostic_level IN ('below_expected', 'developing', 'consolidated')),
        priority INTEGER NOT NULL CHECK(priority BETWEEN 1 AND 50),
        suggested_question_count INTEGER NOT NULL DEFAULT 3
          CHECK(suggested_question_count BETWEEN 1 AND 10),
        rationale TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(skill_code_snapshot)) BETWEEN 2 AND 32),
        CHECK(length(trim(skill_description_snapshot)) BETWEEN 1 AND 2000),
        CHECK(rationale IS NULL OR length(rationale) <= 1000),
        UNIQUE(plan_id, skill_code_snapshot),
        UNIQUE(plan_id, priority),
        UNIQUE(id, plan_id, owner_teacher_id),
        FOREIGN KEY (plan_id, owner_teacher_id, class_id)
          REFERENCES learning_recovery_plans(id, owner_teacher_id, class_id)
          ON DELETE CASCADE,
        FOREIGN KEY (source_skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_learning_recovery_skills_source
        ON learning_recovery_plan_skills(source_skill_id, diagnostic_level);

      CREATE TABLE learning_recovery_student_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        plan_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        focus_skill_id INTEGER,
        focus_skill_code_snapshot TEXT,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 1 AND 100),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(title)) BETWEEN 1 AND 120),
        CHECK(length(trim(objective)) BETWEEN 1 AND 1000),
        CHECK(
          (focus_skill_id IS NULL AND focus_skill_code_snapshot IS NULL)
          OR length(trim(COALESCE(focus_skill_code_snapshot, ''))) BETWEEN 2 AND 32
        ),
        UNIQUE(plan_id, sort_order),
        UNIQUE(id, plan_id, owner_teacher_id, class_id),
        FOREIGN KEY (plan_id, owner_teacher_id, class_id)
          REFERENCES learning_recovery_plans(id, owner_teacher_id, class_id)
          ON DELETE CASCADE,
        FOREIGN KEY (focus_skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
      );

      CREATE TABLE learning_recovery_student_group_members (
        group_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        success_rate_snapshot REAL
          CHECK(success_rate_snapshot IS NULL OR success_rate_snapshot BETWEEN 0 AND 100),
        opportunity_count INTEGER NOT NULL DEFAULT 0 CHECK(opportunity_count >= 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (group_id, student_id),
        FOREIGN KEY (group_id, plan_id, owner_teacher_id, class_id)
          REFERENCES learning_recovery_student_groups(
            id, plan_id, owner_teacher_id, class_id
          ) ON DELETE CASCADE,
        FOREIGN KEY (student_id, owner_teacher_id)
          REFERENCES students(id, owner_teacher_id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_learning_recovery_group_members_student
        ON learning_recovery_student_group_members(student_id, plan_id);

      CREATE TABLE teaching_plans (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        owner_teacher_id INTEGER NOT NULL,
        class_id INTEGER,
        grade_id INTEGER NOT NULL,
        discipline_id INTEGER,
        source_recovery_plan_id INTEGER,
        duplicated_from_plan_id INTEGER,
        title TEXT NOT NULL,
        period_type TEXT NOT NULL
          CHECK(period_type IN ('week', 'bimester', 'custom')),
        academic_year INTEGER NOT NULL CHECK(academic_year BETWEEN 2000 AND 2200),
        starts_on TEXT NOT NULL,
        ends_on TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'active', 'completed', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        activated_at DATETIME,
        completed_at DATETIME,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(title)) BETWEEN 1 AND 160),
        CHECK(date(starts_on) IS NOT NULL),
        CHECK(date(ends_on) IS NOT NULL),
        CHECK(julianday(ends_on) >= julianday(starts_on)),
        CHECK(source_recovery_plan_id IS NULL OR class_id IS NOT NULL),
        CHECK(duplicated_from_plan_id IS NULL OR duplicated_from_plan_id <> id),
        CHECK(activated_at IS NULL OR julianday(activated_at) IS NOT NULL),
        CHECK(completed_at IS NULL OR julianday(completed_at) IS NOT NULL),
        CHECK(archived_at IS NULL OR julianday(archived_at) IS NOT NULL),
        CHECK(status <> 'active' OR activated_at IS NOT NULL),
        CHECK(status <> 'completed' OR completed_at IS NOT NULL),
        CHECK(status <> 'archived' OR archived_at IS NOT NULL),
        UNIQUE(id, owner_teacher_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE RESTRICT,
        FOREIGN KEY (discipline_id) REFERENCES disciplines(id) ON DELETE SET NULL,
        FOREIGN KEY (source_recovery_plan_id, owner_teacher_id, class_id)
          REFERENCES learning_recovery_plans(id, owner_teacher_id, class_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (duplicated_from_plan_id, owner_teacher_id)
          REFERENCES teaching_plans(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_teaching_plans_owner_period
        ON teaching_plans(owner_teacher_id, academic_year, status, starts_on);
      CREATE INDEX idx_teaching_plans_class_period
        ON teaching_plans(class_id, starts_on, ends_on);

      CREATE TABLE teaching_plan_lessons (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        plan_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        objective TEXT NOT NULL,
        teacher_notes TEXT,
        sequence_order INTEGER NOT NULL CHECK(sequence_order BETWEEN 1 AND 500),
        planned_date TEXT,
        duration_minutes INTEGER
          CHECK(duration_minutes IS NULL OR duration_minutes BETWEEN 10 AND 600),
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK(status IN ('planned', 'taught', 'skipped')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(title)) BETWEEN 1 AND 160),
        CHECK(length(trim(objective)) BETWEEN 1 AND 2000),
        CHECK(teacher_notes IS NULL OR length(teacher_notes) <= 5000),
        CHECK(planned_date IS NULL OR date(planned_date) IS NOT NULL),
        UNIQUE(plan_id, sequence_order),
        UNIQUE(id, plan_id, owner_teacher_id),
        FOREIGN KEY (plan_id, owner_teacher_id)
          REFERENCES teaching_plans(id, owner_teacher_id) ON DELETE CASCADE
      );

      CREATE INDEX idx_teaching_plan_lessons_plan_date
        ON teaching_plan_lessons(plan_id, planned_date, sequence_order);

      CREATE TABLE teaching_plan_lesson_skills (
        lesson_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        source_skill_id INTEGER,
        skill_code_snapshot TEXT NOT NULL,
        skill_description_snapshot TEXT NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(skill_code_snapshot)) BETWEEN 2 AND 32),
        CHECK(length(trim(skill_description_snapshot)) BETWEEN 1 AND 2000),
        PRIMARY KEY (lesson_id, skill_code_snapshot),
        FOREIGN KEY (lesson_id, plan_id, owner_teacher_id)
          REFERENCES teaching_plan_lessons(id, plan_id, owner_teacher_id)
          ON DELETE CASCADE,
        FOREIGN KEY (source_skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_teaching_plan_lesson_skills_source
        ON teaching_plan_lesson_skills(source_skill_id, plan_id);

      CREATE TABLE teaching_plan_lesson_resources (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        lesson_id INTEGER NOT NULL,
        plan_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        resource_type TEXT NOT NULL
          CHECK(resource_type IN ('material', 'question', 'question_set', 'activity')),
        material_id INTEGER,
        question_id INTEGER,
        question_set_id INTEGER,
        title_snapshot TEXT NOT NULL,
        teacher_notes TEXT,
        sort_order INTEGER NOT NULL CHECK(sort_order BETWEEN 1 AND 500),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(title_snapshot)) BETWEEN 1 AND 240),
        CHECK(teacher_notes IS NULL OR length(teacher_notes) <= 2000),
        CHECK(material_id IS NULL OR resource_type = 'material'),
        CHECK(question_id IS NULL OR resource_type = 'question'),
        CHECK(question_set_id IS NULL OR resource_type = 'question_set'),
        CHECK(
          (material_id IS NOT NULL)
          + (question_id IS NOT NULL)
          + (question_set_id IS NOT NULL) <= 1
        ),
        CHECK(
          resource_type <> 'activity'
          OR (material_id IS NULL AND question_id IS NULL AND question_set_id IS NULL)
        ),
        UNIQUE(lesson_id, sort_order),
        FOREIGN KEY (lesson_id, plan_id, owner_teacher_id)
          REFERENCES teaching_plan_lessons(id, plan_id, owner_teacher_id)
          ON DELETE CASCADE,
        FOREIGN KEY (material_id) REFERENCES materials(id) ON DELETE SET NULL,
        FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE SET NULL,
        FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_teaching_plan_resources_material
        ON teaching_plan_lesson_resources(material_id, plan_id);
      CREATE INDEX idx_teaching_plan_resources_question
        ON teaching_plan_lesson_resources(question_id, plan_id);
      CREATE INDEX idx_teaching_plan_resources_question_set
        ON teaching_plan_lesson_resources(question_set_id, plan_id);

      CREATE TRIGGER material_bncc_skills_require_admin_curation
      BEFORE INSERT ON material_bncc_skills
      WHEN COALESCE((SELECT role FROM users WHERE id = NEW.linked_by), '') <> 'admin'
      BEGIN
        SELECT RAISE(ABORT, 'material_skill_mapping_requires_admin');
      END;

      CREATE TRIGGER material_bncc_skills_identity_is_immutable
      BEFORE UPDATE ON material_bncc_skills
      WHEN NOT (
        OLD.linked_by IS NOT NULL
        AND NEW.linked_by IS NULL
        AND NEW.material_id IS OLD.material_id
        AND NEW.skill_id IS OLD.skill_id
        AND NEW.link_source IS OLD.link_source
        AND NEW.created_at IS OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'material_skill_mapping_is_immutable');
      END;

      CREATE TRIGGER diagnostic_reviews_prevent_delete
      BEFORE DELETE ON diagnostic_question_set_reviews
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_review_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_plans_validate_insert
      BEFORE INSERT ON learning_recovery_plans
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT role FROM users WHERE id = NEW.owner_teacher_id), '') <> 'professor'
          THEN RAISE(ABORT, 'learning_recovery_requires_professor')
        END;

        SELECT CASE
          WHEN NEW.created_by IS NOT NULL AND NEW.created_by <> NEW.owner_teacher_id
          THEN RAISE(ABORT, 'learning_recovery_requires_owner')
        END;

        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM class_assessment_assignments assignment
            JOIN diagnostic_question_sets diagnostic
              ON diagnostic.question_set_id = assignment.source_question_set_id
              AND diagnostic.owner_teacher_id = assignment.owner_teacher_id
            JOIN diagnostic_question_set_reviews review
              ON review.question_set_id = diagnostic.question_set_id
              AND review.owner_teacher_id = diagnostic.owner_teacher_id
            WHERE assignment.id = NEW.source_assignment_id
              AND assignment.class_id = NEW.class_id
              AND assignment.owner_teacher_id = NEW.owner_teacher_id
              AND assignment.status = 'closed'
              AND EXISTS (
                SELECT 1 FROM class_assessment_attempts attempt
                WHERE attempt.assignment_id = assignment.id
                  AND attempt.status = 'submitted'
              )
          )
          THEN RAISE(ABORT, 'learning_recovery_requires_closed_reviewed_diagnostic')
        END;
      END;

      CREATE TRIGGER learning_recovery_plans_identity_is_immutable
      BEFORE UPDATE OF id, public_id, owner_teacher_id, class_id, source_assignment_id,
        idempotency_key_hash, request_fingerprint, source_assessment_revision,
        source_results_revision_hash,
        diagnostic_algorithm_version_snapshot, diagnostic_confirmation_version_snapshot,
        methodology_version, created_by, created_at
      ON learning_recovery_plans
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_identity_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_plans_status_transition
      BEFORE UPDATE OF status ON learning_recovery_plans
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status = 'active')
          OR (OLD.status = 'active' AND NEW.status IN ('completed', 'archived'))
          OR (OLD.status = 'completed' AND NEW.status = 'archived')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_learning_recovery_status_transition');
      END;

      CREATE TRIGGER learning_recovery_plans_validate_activation
      BEFORE UPDATE OF status ON learning_recovery_plans
      WHEN OLD.status = 'draft'
        AND NEW.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM learning_recovery_plan_skills skill
          WHERE skill.plan_id = OLD.id
            AND skill.owner_teacher_id = OLD.owner_teacher_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_requires_priority_skill');
      END;

      CREATE TRIGGER learning_recovery_plan_content_is_frozen
      BEFORE UPDATE OF title ON learning_recovery_plans
      WHEN OLD.status <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_plans_prevent_delete
      BEFORE DELETE ON learning_recovery_plans
      WHEN OLD.status <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_history_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_content_requires_draft_skill_insert
      BEFORE INSERT ON learning_recovery_plan_skills
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = NEW.plan_id), '') <> 'draft'
        OR NOT EXISTS (
          SELECT 1
          FROM learning_recovery_plans plan
          JOIN class_assessment_items item
            ON item.assignment_id = plan.source_assignment_id
            AND item.source_skill_id = NEW.source_skill_id
            AND item.skill_code_snapshot = NEW.skill_code_snapshot
            AND item.skill_description_snapshot = NEW.skill_description_snapshot
          WHERE plan.id = NEW.plan_id
            AND plan.owner_teacher_id = NEW.owner_teacher_id
            AND plan.class_id = NEW.class_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_learning_recovery_skill_snapshot');
      END;

      CREATE TRIGGER learning_recovery_content_requires_draft_skill_update
      BEFORE UPDATE OF priority, suggested_question_count, rationale
      ON learning_recovery_plan_skills
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_skill_snapshot_is_immutable
      BEFORE UPDATE OF id, plan_id, owner_teacher_id, class_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot,
        success_rate_snapshot, opportunity_count, diagnostic_level, created_at
      ON learning_recovery_plan_skills
      WHEN NOT (
        OLD.source_skill_id IS NOT NULL
        AND NEW.source_skill_id IS NULL
        AND NEW.id IS OLD.id
        AND NEW.plan_id IS OLD.plan_id
        AND NEW.owner_teacher_id IS OLD.owner_teacher_id
        AND NEW.class_id IS OLD.class_id
        AND NEW.skill_code_snapshot IS OLD.skill_code_snapshot
        AND NEW.skill_description_snapshot IS OLD.skill_description_snapshot
        AND NEW.success_rate_snapshot IS OLD.success_rate_snapshot
        AND NEW.opportunity_count IS OLD.opportunity_count
        AND NEW.diagnostic_level IS OLD.diagnostic_level
        AND NEW.created_at IS OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_skill_snapshot_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_content_requires_draft_skill_delete
      BEFORE DELETE ON learning_recovery_plan_skills
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_requires_draft_insert
      BEFORE INSERT ON learning_recovery_student_groups
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = NEW.plan_id), '') <> 'draft'
        OR (
          NEW.focus_skill_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM learning_recovery_plan_skills plan_skill
            WHERE plan_skill.plan_id = NEW.plan_id
              AND plan_skill.owner_teacher_id = NEW.owner_teacher_id
              AND plan_skill.source_skill_id = NEW.focus_skill_id
              AND plan_skill.skill_code_snapshot = NEW.focus_skill_code_snapshot
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_requires_draft_update
      BEFORE UPDATE OF title, objective, sort_order
      ON learning_recovery_student_groups
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_identity_is_immutable
      BEFORE UPDATE OF id, public_id, plan_id, owner_teacher_id, class_id,
        focus_skill_id, focus_skill_code_snapshot, created_at
      ON learning_recovery_student_groups
      WHEN NOT (
        OLD.focus_skill_id IS NOT NULL
        AND NEW.focus_skill_id IS NULL
        AND NEW.id IS OLD.id
        AND NEW.public_id IS OLD.public_id
        AND NEW.plan_id IS OLD.plan_id
        AND NEW.owner_teacher_id IS OLD.owner_teacher_id
        AND NEW.class_id IS OLD.class_id
        AND NEW.focus_skill_code_snapshot IS OLD.focus_skill_code_snapshot
        AND NEW.created_at IS OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_group_identity_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_group_requires_draft_delete
      BEFORE DELETE ON learning_recovery_student_groups
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_member_requires_draft_insert
      BEFORE INSERT ON learning_recovery_student_group_members
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = NEW.plan_id), '') <> 'draft'
        OR NOT EXISTS (
          SELECT 1
          FROM learning_recovery_plans plan
          JOIN class_assessment_participants participant
            ON participant.assignment_id = plan.source_assignment_id
            AND participant.class_id = plan.class_id
            AND participant.owner_teacher_id = plan.owner_teacher_id
            AND participant.student_id = NEW.student_id
            AND participant.status = 'submitted'
          WHERE plan.id = NEW.plan_id
            AND plan.owner_teacher_id = NEW.owner_teacher_id
            AND plan.class_id = NEW.class_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_member_requires_draft_update
      BEFORE UPDATE ON learning_recovery_student_group_members
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER learning_recovery_group_member_is_immutable
      BEFORE UPDATE ON learning_recovery_student_group_members
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_group_member_is_immutable');
      END;

      CREATE TRIGGER learning_recovery_group_member_requires_draft_delete
      BEFORE DELETE ON learning_recovery_student_group_members
      WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
      END;

      CREATE TRIGGER teaching_plans_validate_insert
      BEFORE INSERT ON teaching_plans
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT role FROM users WHERE id = NEW.owner_teacher_id), '') <> 'professor'
          THEN RAISE(ABORT, 'teaching_plan_requires_professor')
        END;

        SELECT CASE
          WHEN NEW.created_by IS NOT NULL AND NEW.created_by <> NEW.owner_teacher_id
          THEN RAISE(ABORT, 'teaching_plan_requires_owner')
        END;

        SELECT CASE
          WHEN NEW.class_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM school_classes school_class
            WHERE school_class.id = NEW.class_id
              AND school_class.owner_teacher_id = NEW.owner_teacher_id
              AND school_class.grade_id = NEW.grade_id
              AND school_class.academic_year = NEW.academic_year
          )
          THEN RAISE(ABORT, 'teaching_plan_class_context_mismatch')
        END;
      END;

      CREATE TRIGGER teaching_plans_validate_context_update
      BEFORE UPDATE OF class_id, grade_id, academic_year ON teaching_plans
      WHEN OLD.status <> 'draft'
        OR (
          NEW.class_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM school_classes school_class
            WHERE school_class.id = NEW.class_id
              AND school_class.owner_teacher_id = NEW.owner_teacher_id
              AND school_class.grade_id = NEW.grade_id
              AND school_class.academic_year = NEW.academic_year
          )
        )
        OR (
          NEW.grade_id IS NOT OLD.grade_id
          AND EXISTS (
            SELECT 1 FROM teaching_plan_lesson_skills lesson_skill
            WHERE lesson_skill.plan_id = OLD.id
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_class_context_mismatch');
      END;

      CREATE TRIGGER teaching_plans_validate_period_update
      BEFORE UPDATE OF starts_on, ends_on ON teaching_plans
      WHEN OLD.status NOT IN ('draft', 'active')
        OR EXISTS (
          SELECT 1 FROM teaching_plan_lessons lesson
          WHERE lesson.plan_id = OLD.id
            AND lesson.planned_date IS NOT NULL
            AND julianday(lesson.planned_date)
              NOT BETWEEN julianday(NEW.starts_on) AND julianday(NEW.ends_on)
        )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_period_conflicts_with_lessons');
      END;

      CREATE TRIGGER teaching_plan_metadata_is_frozen
      BEFORE UPDATE OF title, period_type, discipline_id ON teaching_plans
      WHEN OLD.status NOT IN ('draft', 'active')
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
      END;

      CREATE TRIGGER teaching_plans_identity_is_immutable
      BEFORE UPDATE OF id, public_id, owner_teacher_id, source_recovery_plan_id,
        duplicated_from_plan_id, created_by, created_at
      ON teaching_plans
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_identity_is_immutable');
      END;

      CREATE TRIGGER teaching_plans_status_transition
      BEFORE UPDATE OF status ON teaching_plans
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status = 'active')
          OR (OLD.status = 'active' AND NEW.status IN ('completed', 'archived'))
          OR (OLD.status = 'completed' AND NEW.status = 'archived')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_plan_status_transition');
      END;

      CREATE TRIGGER teaching_plans_validate_activation
      BEFORE UPDATE OF status ON teaching_plans
      WHEN OLD.status = 'draft'
        AND NEW.status = 'active'
        AND (
          NOT EXISTS (
            SELECT 1 FROM teaching_plan_lessons lesson
            WHERE lesson.plan_id = OLD.id
              AND lesson.owner_teacher_id = OLD.owner_teacher_id
          )
          OR EXISTS (
            SELECT 1 FROM teaching_plan_lessons lesson
            WHERE lesson.plan_id = OLD.id
              AND NOT EXISTS (
                SELECT 1 FROM teaching_plan_lesson_skills lesson_skill
                WHERE lesson_skill.lesson_id = lesson.id
                  AND lesson_skill.plan_id = lesson.plan_id
                  AND lesson_skill.owner_teacher_id = lesson.owner_teacher_id
              )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_requires_lessons_with_skills');
      END;

      CREATE TRIGGER teaching_plans_validate_completion
      BEFORE UPDATE OF status ON teaching_plans
      WHEN OLD.status = 'active'
        AND NEW.status = 'completed'
        AND EXISTS (
          SELECT 1 FROM teaching_plan_lessons lesson
          WHERE lesson.plan_id = OLD.id
            AND lesson.status = 'planned'
        )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_has_pending_lessons');
      END;

      CREATE TRIGGER teaching_plans_prevent_delete
      BEFORE DELETE ON teaching_plans
      WHEN OLD.status <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_history_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_lessons_validate_insert
      BEFORE INSERT ON teaching_plan_lessons
      WHEN NOT EXISTS (
        SELECT 1 FROM teaching_plans plan
        WHERE plan.id = NEW.plan_id
          AND plan.owner_teacher_id = NEW.owner_teacher_id
          AND plan.status IN ('draft', 'active')
          AND (
            NEW.planned_date IS NULL
            OR julianday(NEW.planned_date) BETWEEN julianday(plan.starts_on) AND julianday(plan.ends_on)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_outside_editable_plan');
      END;

      CREATE TRIGGER teaching_plan_lessons_prevent_delete
      BEFORE DELETE ON teaching_plan_lessons
      WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '') <> 'draft'
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_history_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_lessons_validate_update
      BEFORE UPDATE ON teaching_plan_lessons
      WHEN NOT EXISTS (
        SELECT 1 FROM teaching_plans plan
        WHERE plan.id = NEW.plan_id
          AND plan.owner_teacher_id = NEW.owner_teacher_id
          AND plan.status IN ('draft', 'active')
          AND (
            NEW.planned_date IS NULL
            OR julianday(NEW.planned_date) BETWEEN julianday(plan.starts_on) AND julianday(plan.ends_on)
          )
      )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_outside_editable_plan');
      END;

      CREATE TRIGGER teaching_plan_lesson_identity_is_immutable
      BEFORE UPDATE OF id, public_id, plan_id, owner_teacher_id, created_at
      ON teaching_plan_lessons
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_identity_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_lesson_status_transition
      BEFORE UPDATE OF status ON teaching_plan_lessons
      WHEN NEW.status <> OLD.status
        AND NOT (OLD.status = 'planned' AND NEW.status IN ('taught', 'skipped'))
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_lesson_status_transition');
      END;

      CREATE TRIGGER teaching_plan_lesson_skills_validate_insert
      BEFORE INSERT ON teaching_plan_lesson_skills
      WHEN NOT EXISTS (
        SELECT 1
        FROM teaching_plan_lessons lesson
        JOIN teaching_plans plan ON plan.id = lesson.plan_id
        JOIN bncc_skills skill ON skill.id = NEW.source_skill_id
        WHERE lesson.id = NEW.lesson_id
          AND lesson.plan_id = NEW.plan_id
          AND lesson.owner_teacher_id = NEW.owner_teacher_id
          AND plan.owner_teacher_id = NEW.owner_teacher_id
          AND plan.status IN ('draft', 'active')
          AND skill.grade_id = plan.grade_id
          AND skill.code = NEW.skill_code_snapshot
          AND skill.description = NEW.skill_description_snapshot
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_lesson_skill');
      END;

      CREATE TRIGGER teaching_plan_lesson_skills_are_immutable
      BEFORE UPDATE ON teaching_plan_lesson_skills
      WHEN NOT (
        OLD.source_skill_id IS NOT NULL
        AND NEW.source_skill_id IS NULL
        AND NEW.lesson_id IS OLD.lesson_id
        AND NEW.plan_id IS OLD.plan_id
        AND NEW.owner_teacher_id IS OLD.owner_teacher_id
        AND NEW.skill_code_snapshot IS OLD.skill_code_snapshot
        AND NEW.skill_description_snapshot IS OLD.skill_description_snapshot
        AND NEW.created_at IS OLD.created_at
      )
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_skill_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_lesson_skills_validate_delete
      BEFORE DELETE ON teaching_plan_lesson_skills
      WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '')
        NOT IN ('draft', 'active')
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
      END;

      CREATE TRIGGER teaching_plan_resources_validate_insert
      BEFORE INSERT ON teaching_plan_lesson_resources
      WHEN NOT (
        (NEW.resource_type = 'material' AND NEW.material_id IS NOT NULL
          AND NEW.question_id IS NULL AND NEW.question_set_id IS NULL)
        OR (NEW.resource_type = 'question' AND NEW.question_id IS NOT NULL
          AND NEW.material_id IS NULL AND NEW.question_set_id IS NULL)
        OR (NEW.resource_type = 'question_set' AND NEW.question_set_id IS NOT NULL
          AND NEW.material_id IS NULL AND NEW.question_id IS NULL)
        OR (NEW.resource_type = 'activity' AND NEW.material_id IS NULL
          AND NEW.question_id IS NULL AND NEW.question_set_id IS NULL)
      )
      OR NOT EXISTS (
        SELECT 1
        FROM teaching_plan_lessons lesson
        JOIN teaching_plans plan ON plan.id = lesson.plan_id
        WHERE lesson.id = NEW.lesson_id
          AND lesson.plan_id = NEW.plan_id
          AND lesson.owner_teacher_id = NEW.owner_teacher_id
          AND plan.owner_teacher_id = NEW.owner_teacher_id
          AND plan.status IN ('draft', 'active')
      )
      OR (
        NEW.resource_type = 'question'
        AND NOT EXISTS (
          SELECT 1 FROM questions question
          WHERE question.id = NEW.question_id
            AND (
              question.source = 'official'
              OR question.created_by = NEW.owner_teacher_id
            )
        )
      )
      OR (
        NEW.resource_type = 'question_set'
        AND NOT EXISTS (
          SELECT 1 FROM question_sets question_set
          WHERE question_set.id = NEW.question_set_id
            AND (
              question_set.is_public = 1
              OR question_set.user_id = NEW.owner_teacher_id
            )
        )
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_lesson_resource');
      END;

      CREATE TRIGGER teaching_plan_resource_identity_is_immutable
      BEFORE UPDATE OF id, lesson_id, plan_id, owner_teacher_id, resource_type,
        material_id, question_id, question_set_id, created_at
      ON teaching_plan_lesson_resources
      WHEN NEW.id IS NOT OLD.id
        OR NEW.lesson_id IS NOT OLD.lesson_id
        OR NEW.plan_id IS NOT OLD.plan_id
        OR NEW.owner_teacher_id IS NOT OLD.owner_teacher_id
        OR NEW.resource_type IS NOT OLD.resource_type
        OR (
          NEW.material_id IS NOT OLD.material_id
          AND NOT (OLD.material_id IS NOT NULL AND NEW.material_id IS NULL)
        )
        OR (
          NEW.question_id IS NOT OLD.question_id
          AND NOT (OLD.question_id IS NOT NULL AND NEW.question_id IS NULL)
        )
        OR (
          NEW.question_set_id IS NOT OLD.question_set_id
          AND NOT (OLD.question_set_id IS NOT NULL AND NEW.question_set_id IS NULL)
        )
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'teaching_lesson_resource_identity_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_resources_validate_update
      BEFORE UPDATE OF title_snapshot, teacher_notes, sort_order
      ON teaching_plan_lesson_resources
      WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = NEW.plan_id), '')
        NOT IN ('draft', 'active')
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
      END;

      CREATE TRIGGER teaching_plan_resources_validate_delete
      BEFORE DELETE ON teaching_plan_lesson_resources
      WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '')
        NOT IN ('draft', 'active')
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
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
          'classes.learning_recovery' AS flag_key,
          'Planos de recomposicao da aprendizagem' AS name,
          'Transforma resultados diagnosticos revisados em planos de intervencao acompanhaveis.' AS description
        UNION ALL
        SELECT
          'planning.lesson_planner',
          'Planejador de aulas e sequencias didaticas',
          'Organiza objetivos, habilidades e recursos por semana, bimestre ou periodo personalizado.'
      ) AS initial_flags
      WHERE product_releases.version = '2.0.0';
    `);
  },
};
