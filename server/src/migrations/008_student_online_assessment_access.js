module.exports = {
  version: 8,
  name: 'student_online_assessment_access',
  description: 'Cria acessos individuais protegidos para estudantes responderem simulados on-line.',
  up(db) {
    db.exec(`
      ALTER TABLE class_assessment_assignments
        ADD COLUMN student_access_enabled INTEGER NOT NULL DEFAULT 0
        CHECK(student_access_enabled IN (0, 1));

      ALTER TABLE class_assessment_assignments
        ADD COLUMN student_result_mode TEXT NOT NULL DEFAULT 'score_after_close'
        CHECK(student_result_mode IN ('hidden', 'score_after_submit', 'score_after_close'));

      CREATE TABLE class_assessment_access_credentials (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        participant_id INTEGER NOT NULL,
        assignment_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        code_digest TEXT NOT NULL COLLATE BINARY UNIQUE,
        code_hint TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'used', 'revoked')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        access_count INTEGER NOT NULL DEFAULT 0 CHECK(access_count >= 0),
        issued_at DATETIME NOT NULL,
        expires_at DATETIME NOT NULL,
        first_accessed_at DATETIME,
        last_accessed_at DATETIME,
        used_at DATETIME,
        revoked_at DATETIME,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(code_digest) = 64 AND code_digest NOT GLOB '*[^0-9a-f]*'),
        CHECK(length(code_hint) = 4 AND code_hint NOT GLOB '*[^A-Z0-9]*'),
        CHECK(julianday(issued_at) IS NOT NULL),
        CHECK(julianday(expires_at) IS NOT NULL),
        CHECK(julianday(expires_at) > julianday(issued_at)),
        CHECK(first_accessed_at IS NULL OR julianday(first_accessed_at) IS NOT NULL),
        CHECK(last_accessed_at IS NULL OR julianday(last_accessed_at) IS NOT NULL),
        CHECK(used_at IS NULL OR julianday(used_at) IS NOT NULL),
        CHECK(revoked_at IS NULL OR julianday(revoked_at) IS NOT NULL),
        CHECK(status <> 'used' OR used_at IS NOT NULL),
        CHECK(status <> 'revoked' OR revoked_at IS NOT NULL),
        UNIQUE(id, assignment_id, class_id, student_id, owner_teacher_id),
        FOREIGN KEY (
          participant_id, assignment_id, class_id, student_id, owner_teacher_id
        ) REFERENCES class_assessment_participants(
          id, assignment_id, class_id, student_id, owner_teacher_id
        ) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX idx_assessment_access_active_participant
        ON class_assessment_access_credentials(participant_id)
        WHERE status = 'active';
      CREATE INDEX idx_assessment_access_assignment_status
        ON class_assessment_access_credentials(assignment_id, status, student_id);
      CREATE INDEX idx_assessment_access_expiration
        ON class_assessment_access_credentials(status, expires_at);

      CREATE TRIGGER class_assessment_result_mode_lock
      BEFORE UPDATE OF student_result_mode ON class_assessment_assignments
      WHEN OLD.status IN ('open', 'closed', 'cancelled')
        AND NEW.student_result_mode <> OLD.student_result_mode
      BEGIN
        SELECT RAISE(ABORT, 'student_result_mode_is_locked');
      END;

      CREATE TRIGGER assessment_access_validate_insert
      BEFORE INSERT ON class_assessment_access_credentials
      BEGIN
        SELECT CASE
          WHEN NOT EXISTS (
            SELECT 1
            FROM class_assessment_assignments assignment
            WHERE assignment.id = NEW.assignment_id
              AND assignment.class_id = NEW.class_id
              AND assignment.owner_teacher_id = NEW.owner_teacher_id
              AND assignment.status IN ('scheduled', 'open')
          )
          THEN RAISE(ABORT, 'assessment_access_assignment_unavailable')
        END;

        SELECT CASE
          WHEN EXISTS (
            SELECT 1
            FROM class_assessment_attempts attempt
            WHERE attempt.participant_id = NEW.participant_id
              AND attempt.status = 'submitted'
          )
          THEN RAISE(ABORT, 'assessment_access_participant_already_submitted')
        END;
      END;

      CREATE TRIGGER assessment_access_identity_is_immutable
      BEFORE UPDATE OF
        public_id,
        participant_id,
        assignment_id,
        class_id,
        student_id,
        owner_teacher_id,
        code_digest,
        code_hint,
        issued_at,
        expires_at
      ON class_assessment_access_credentials
      BEGIN
        SELECT RAISE(ABORT, 'assessment_access_identity_is_immutable');
      END;

      CREATE TRIGGER assessment_access_status_transition
      BEFORE UPDATE OF status ON class_assessment_access_credentials
      WHEN NEW.status <> OLD.status
        AND NOT (
          OLD.status = 'active' AND NEW.status IN ('used', 'revoked')
          OR OLD.status = 'used' AND NEW.status = 'revoked'
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_assessment_access_status_transition');
      END;

      CREATE TRIGGER assessment_access_counters_never_decrease
      BEFORE UPDATE OF access_count ON class_assessment_access_credentials
      WHEN NEW.access_count < OLD.access_count
      BEGIN
        SELECT RAISE(ABORT, 'assessment_access_count_cannot_decrease');
      END;

      CREATE TRIGGER assessment_access_prevent_delete
      BEFORE DELETE ON class_assessment_access_credentials
      BEGIN
        SELECT RAISE(ABORT, 'assessment_access_history_is_immutable');
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
        'classes.student_assessment_portal',
        'Resposta on-line do estudante',
        'Gera acessos individuais e corrige automaticamente respostas enviadas pelos estudantes.',
        product_releases.id,
        0,
        0,
        0
      FROM product_releases
      WHERE product_releases.version = '2.0.0';
    `);
  },
};
