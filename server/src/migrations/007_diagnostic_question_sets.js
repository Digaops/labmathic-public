module.exports = {
  version: 7,
  name: 'diagnostic_question_sets',
  description: 'Registra simulados diagnosticos gerados por ano e habilidades com composicao auditavel.',
  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX idx_question_sets_diagnostic_owner_identity
        ON question_sets(id, user_id);

      CREATE UNIQUE INDEX idx_bncc_skills_diagnostic_grade_identity
        ON bncc_skills(id, grade_id);

      CREATE TABLE diagnostic_question_sets (
        question_set_id INTEGER PRIMARY KEY,
        owner_teacher_id INTEGER NOT NULL,
        grade_id INTEGER NOT NULL,
        questions_per_skill INTEGER NOT NULL CHECK(questions_per_skill BETWEEN 2 AND 5),
        total_questions INTEGER NOT NULL CHECK(total_questions BETWEEN 2 AND 50),
        algorithm_version TEXT NOT NULL DEFAULT 'balanced-v1'
          CHECK(algorithm_version = 'balanced-v1'),
        cycle_stage TEXT NOT NULL DEFAULT 'diagnostic'
          CHECK(cycle_stage IN ('diagnostic', 'monitoring')),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(question_set_id, owner_teacher_id, grade_id),
        FOREIGN KEY (question_set_id, owner_teacher_id)
          REFERENCES question_sets(id, user_id) ON DELETE CASCADE,
        FOREIGN KEY (owner_teacher_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE RESTRICT
      );

      CREATE TABLE diagnostic_question_set_skills (
        question_set_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        grade_id INTEGER NOT NULL,
        skill_id INTEGER NOT NULL,
        requested_count INTEGER NOT NULL CHECK(requested_count BETWEEN 2 AND 5),
        selected_count INTEGER NOT NULL CHECK(selected_count = requested_count),
        easy_count INTEGER NOT NULL DEFAULT 0 CHECK(easy_count >= 0),
        medium_count INTEGER NOT NULL DEFAULT 0 CHECK(medium_count >= 0),
        difficult_count INTEGER NOT NULL DEFAULT 0 CHECK(difficult_count >= 0),
        candidate_count INTEGER NOT NULL CHECK(candidate_count >= selected_count),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (question_set_id, skill_id),
        CHECK(easy_count + medium_count + difficult_count = selected_count),
        FOREIGN KEY (question_set_id, owner_teacher_id, grade_id)
          REFERENCES diagnostic_question_sets(question_set_id, owner_teacher_id, grade_id)
          ON DELETE CASCADE,
        FOREIGN KEY (skill_id, grade_id)
          REFERENCES bncc_skills(id, grade_id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_diagnostic_question_sets_owner_created
        ON diagnostic_question_sets(owner_teacher_id, created_at);
      CREATE INDEX idx_diagnostic_question_sets_grade_created
        ON diagnostic_question_sets(grade_id, created_at);
      CREATE INDEX idx_diagnostic_question_set_skills_skill
        ON diagnostic_question_set_skills(skill_id, question_set_id);

      CREATE TRIGGER diagnostic_question_sets_validate_insert
      BEFORE INSERT ON diagnostic_question_sets
      BEGIN
        SELECT CASE
          WHEN COALESCE((SELECT role FROM users WHERE id = NEW.owner_teacher_id), '') <> 'professor'
          THEN RAISE(ABORT, 'diagnostic_requires_professor')
        END;
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM question_sets question_set
            WHERE question_set.id = NEW.question_set_id
              AND question_set.user_id = NEW.owner_teacher_id
              AND question_set.is_public = 0
          )
          THEN RAISE(ABORT, 'diagnostic_question_set_must_be_private_and_owned')
        END;
      END;

      CREATE TRIGGER diagnostic_question_sets_are_immutable
      BEFORE UPDATE ON diagnostic_question_sets
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_metadata_is_immutable');
      END;

      CREATE TRIGGER diagnostic_question_set_skills_are_immutable
      BEFORE UPDATE ON diagnostic_question_set_skills
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_skill_metadata_is_immutable');
      END;

      CREATE TRIGGER diagnostic_question_sets_keep_private
      BEFORE UPDATE OF is_public, user_id ON question_sets
      WHEN EXISTS (
        SELECT 1 FROM diagnostic_question_sets diagnostic
        WHERE diagnostic.question_set_id = OLD.id
      ) AND (NEW.is_public <> 0 OR NEW.user_id <> OLD.user_id)
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_question_set_is_private');
      END;

      CREATE TRIGGER diagnostic_question_set_items_prevent_insert
      BEFORE INSERT ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM diagnostic_question_sets diagnostic
        WHERE diagnostic.question_set_id = NEW.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_question_selection_is_immutable');
      END;

      CREATE TRIGGER diagnostic_question_set_items_prevent_repoint
      BEFORE UPDATE OF question_id, sort_order ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM diagnostic_question_sets diagnostic
        WHERE diagnostic.question_set_id = OLD.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_question_selection_is_immutable');
      END;

      CREATE TRIGGER diagnostic_question_set_items_prevent_delete
      BEFORE DELETE ON question_set_items
      WHEN EXISTS (
        SELECT 1 FROM diagnostic_question_sets diagnostic
        JOIN question_sets question_set ON question_set.id = diagnostic.question_set_id
        WHERE diagnostic.question_set_id = OLD.question_set_id
      )
      BEGIN
        SELECT RAISE(ABORT, 'diagnostic_question_selection_is_immutable');
      END;

      INSERT INTO feature_flags (
        flag_key, name, description, release_id,
        master_enabled, default_enabled, rollout_percentage
      )
      SELECT
        'question_bank.diagnostic_generator',
        'Gerador de avaliacao diagnostica',
        'Monta um simulado privado e equilibrado por ano e habilidades BNCC.',
        product_releases.id,
        0,
        0,
        0
      FROM product_releases
      WHERE product_releases.version = '2.0.0';
    `);
  },
};
