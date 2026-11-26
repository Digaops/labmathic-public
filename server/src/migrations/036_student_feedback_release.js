module.exports = {
  version: 36,
  name: 'student_feedback_release',
  description: 'Libera uma devolutiva textual, explícita e auditável do professor após a entrega do estudante.',
  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX idx_class_assessment_participant_feedback_identity
        ON class_assessment_participants(id, assignment_id, class_id, student_id, owner_teacher_id);
      CREATE TABLE student_assessment_feedback (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        assignment_id INTEGER NOT NULL,
        participant_id INTEGER NOT NULL,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        owner_teacher_id INTEGER NOT NULL,
        message TEXT NOT NULL CHECK(length(trim(message)) BETWEEN 10 AND 2000),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision = 1),
        released_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_by INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(assignment_id, participant_id),
        UNIQUE(id, assignment_id, participant_id, class_id, student_id, owner_teacher_id),
        FOREIGN KEY (participant_id, assignment_id, class_id, student_id, owner_teacher_id)
          REFERENCES class_assessment_participants(
            id, assignment_id, class_id, student_id, owner_teacher_id
          ) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE RESTRICT,
        CHECK(julianday(released_at) IS NOT NULL)
      );
      CREATE INDEX idx_student_assessment_feedback_student
        ON student_assessment_feedback(student_id, released_at DESC);
      CREATE INDEX idx_student_assessment_feedback_owner
        ON student_assessment_feedback(owner_teacher_id, released_at DESC);

      CREATE TABLE student_assessment_feedback_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feedback_id INTEGER NOT NULL,
        actor_id INTEGER NOT NULL,
        action TEXT NOT NULL CHECK(action = 'released'),
        revision INTEGER NOT NULL CHECK(revision = 1),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feedback_id, revision),
        FOREIGN KEY (feedback_id) REFERENCES student_assessment_feedback(id) ON DELETE RESTRICT,
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE RESTRICT
      );
      CREATE TRIGGER student_assessment_feedback_immutable_update
        BEFORE UPDATE ON student_assessment_feedback
      BEGIN
        SELECT RAISE(ABORT, 'student_assessment_feedback_is_immutable');
      END;
      CREATE TRIGGER student_assessment_feedback_immutable_delete
        BEFORE DELETE ON student_assessment_feedback
      BEGIN
        SELECT RAISE(ABORT, 'student_assessment_feedback_is_immutable');
      END;
      CREATE TRIGGER student_assessment_feedback_events_immutable_update
        BEFORE UPDATE ON student_assessment_feedback_events
      BEGIN
        SELECT RAISE(ABORT, 'student_assessment_feedback_history_is_immutable');
      END;
      CREATE TRIGGER student_assessment_feedback_events_immutable_delete
        BEFORE DELETE ON student_assessment_feedback_events
      BEGIN
        SELECT RAISE(ABORT, 'student_assessment_feedback_history_is_immutable');
      END;

      CREATE TABLE student_assessment_feedback_operations (
        actor_id INTEGER NOT NULL,
        key_hash TEXT NOT NULL CHECK(length(key_hash) = 64),
        request_hash TEXT NOT NULL CHECK(length(request_hash) = 64),
        feedback_id INTEGER NOT NULL,
        receipt_json TEXT NOT NULL CHECK(json_valid(receipt_json)),
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY(actor_id, key_hash),
        FOREIGN KEY (feedback_id) REFERENCES student_assessment_feedback(id) ON DELETE RESTRICT
      );

      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('classes.student_feedback_release','Devolutiva ao estudante',
          'Permite ao professor liberar uma orientação textual após a entrega, sem expor o gabarito.',0,0,0);
    `);
  },
};
