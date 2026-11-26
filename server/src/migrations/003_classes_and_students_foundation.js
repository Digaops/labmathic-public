module.exports = {
  version: 3,
  name: 'classes_and_students_foundation',
  description: 'Cria a fundacao segura de turmas, estudantes, matriculas e codigos de entrada.',
  up(db) {
    db.exec(`
      CREATE TABLE school_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        owner_teacher_id INTEGER NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        grade_id INTEGER NOT NULL,
        academic_year INTEGER NOT NULL
          CHECK(academic_year BETWEEN 2000 AND 2200),
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(name)) BETWEEN 1 AND 120),
        CHECK(
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND julianday(archived_at) IS NOT NULL)
        ),
        UNIQUE(owner_teacher_id, name, academic_year),
        UNIQUE(id, owner_teacher_id),
        FOREIGN KEY (owner_teacher_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE school_class_disciplines (
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        discipline_id INTEGER NOT NULL,
        added_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (class_id, discipline_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE CASCADE,
        FOREIGN KEY (discipline_id) REFERENCES disciplines(id) ON DELETE RESTRICT,
        FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE students (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        owner_teacher_id INTEGER NOT NULL,
        display_name TEXT NOT NULL COLLATE NOCASE,
        external_reference TEXT COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(display_name)) BETWEEN 1 AND 120),
        CHECK(
          external_reference IS NULL
          OR length(trim(external_reference)) BETWEEN 1 AND 80
        ),
        CHECK(
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND julianday(archived_at) IS NOT NULL)
        ),
        UNIQUE(owner_teacher_id, external_reference),
        UNIQUE(id, owner_teacher_id),
        FOREIGN KEY (owner_teacher_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE school_class_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'withdrawn')),
        enrolled_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(julianday(enrolled_at) IS NOT NULL),
        CHECK(
          (status = 'active' AND ended_at IS NULL)
          OR (
            status = 'withdrawn'
            AND julianday(ended_at) IS NOT NULL
            AND julianday(ended_at) >= julianday(enrolled_at)
          )
        ),
        UNIQUE(class_id, student_id),
        UNIQUE(id, class_id, student_id, owner_teacher_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (student_id, owner_teacher_id)
          REFERENCES students(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE school_class_entry_codes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        class_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        code_digest TEXT NOT NULL COLLATE BINARY UNIQUE,
        digest_algorithm TEXT NOT NULL DEFAULT 'hmac-sha256-v1'
          CHECK(digest_algorithm = 'hmac-sha256-v1'),
        max_uses INTEGER NOT NULL CHECK(max_uses BETWEEN 1 AND 5000),
        use_count INTEGER NOT NULL DEFAULT 0
          CHECK(use_count BETWEEN 0 AND max_uses),
        expires_at DATETIME NOT NULL,
        revoked_at DATETIME,
        last_used_at DATETIME,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(
          length(code_digest) = 64
          AND code_digest NOT GLOB '*[^0-9a-f]*'
        ),
        CHECK(
          julianday(expires_at) IS NOT NULL
          AND julianday(expires_at) > julianday(created_at)
        ),
        CHECK(revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
        CHECK(last_used_at IS NULL OR julianday(last_used_at) IS NOT NULL),
        UNIQUE(id, class_id, owner_teacher_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE school_class_entry_code_redemptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        entry_code_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        enrollment_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        redeemed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(julianday(redeemed_at) IS NOT NULL),
        UNIQUE(entry_code_id, student_id),
        FOREIGN KEY (entry_code_id, class_id, owner_teacher_id)
          REFERENCES school_class_entry_codes(id, class_id, owner_teacher_id)
          ON DELETE RESTRICT,
        FOREIGN KEY (enrollment_id, class_id, student_id, owner_teacher_id)
          REFERENCES school_class_enrollments(id, class_id, student_id, owner_teacher_id)
          ON DELETE RESTRICT
      );

      CREATE INDEX idx_school_classes_owner_status
        ON school_classes(owner_teacher_id, status, academic_year);
      CREATE INDEX idx_school_classes_grade
        ON school_classes(grade_id, academic_year);
      CREATE INDEX idx_school_class_disciplines_owner
        ON school_class_disciplines(owner_teacher_id, class_id);
      CREATE INDEX idx_students_owner_status
        ON students(owner_teacher_id, status, display_name);
      CREATE INDEX idx_school_class_enrollments_class
        ON school_class_enrollments(class_id, status, student_id);
      CREATE INDEX idx_school_class_enrollments_student
        ON school_class_enrollments(student_id, status, class_id);
      CREATE INDEX idx_school_class_enrollments_owner
        ON school_class_enrollments(owner_teacher_id, status);
      CREATE INDEX idx_school_class_entry_codes_class
        ON school_class_entry_codes(class_id, revoked_at, expires_at);
      CREATE INDEX idx_school_class_entry_codes_owner
        ON school_class_entry_codes(owner_teacher_id, expires_at);
      CREATE INDEX idx_school_class_entry_code_redemptions_student
        ON school_class_entry_code_redemptions(student_id, redeemed_at);

      CREATE TRIGGER school_class_entry_code_redemptions_validate
      BEFORE INSERT ON school_class_entry_code_redemptions
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM school_class_entry_codes
            WHERE id = NEW.entry_code_id
              AND class_id = NEW.class_id
              AND owner_teacher_id = NEW.owner_teacher_id
              AND revoked_at IS NULL
              AND julianday(expires_at) > julianday(CURRENT_TIMESTAMP)
              AND use_count < max_uses
          )
          THEN RAISE(ABORT, 'entry_code_unavailable')
        END;
      END;

      CREATE TRIGGER school_class_entry_code_redemptions_count
      AFTER INSERT ON school_class_entry_code_redemptions
      BEGIN
        UPDATE school_class_entry_codes
        SET use_count = use_count + 1,
            last_used_at = NEW.redeemed_at,
            revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.entry_code_id;
      END;

      CREATE TRIGGER school_class_entry_code_redemptions_prevent_update
      BEFORE UPDATE ON school_class_entry_code_redemptions
      BEGIN
        SELECT RAISE(ABORT, 'entry_code_redemption_is_immutable');
      END;

      CREATE TRIGGER school_class_entry_code_redemptions_prevent_delete
      BEFORE DELETE ON school_class_entry_code_redemptions
      BEGIN
        SELECT RAISE(ABORT, 'entry_code_redemption_is_immutable');
      END;

      INSERT INTO product_releases (
        version,
        title,
        description,
        status
      ) VALUES (
        '2.0.0',
        'Turmas e acompanhamento diagnostico',
        'Fundacao segura para turmas, estudantes, matriculas e codigos de entrada.',
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
          'classes.core' AS flag_key,
          'Nucleo de turmas' AS name,
          'Cadastro e gestao de turmas e estudantes.' AS description
        UNION ALL
        SELECT
          'classes.student_import',
          'Importacao de estudantes',
          'Importacao controlada de estudantes por planilha.'
        UNION ALL
        SELECT
          'classes.entry_codes',
          'Codigos de entrada em turmas',
          'Entrada de estudantes por codigo temporario e revogavel.'
      ) AS initial_flags
      WHERE version = '2.0.0';
    `);
  },
};
