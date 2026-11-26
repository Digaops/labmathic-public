// Companion storage: no rewrite of existing questions, responses or grades.
module.exports = {
  version: 39,
  name: 'numeric_class_assessments',
  description: 'Aplicação de versões numéricas aprovadas, respostas isoladas e resultados integrados.',
  up(db) {
    const trigger = name => db.prepare("SELECT sql FROM sqlite_master WHERE type='trigger' AND name=?").pluck().get(name);
    const snapshot = trigger('typed_question_snapshot_validate_insert');
    const publication = trigger('class_assessment_assignment_validate_publication');
    const submission = trigger('class_assessment_attempt_validate_submission');
    const recovery = trigger('learning_recovery_plans_validate_insert');
    db.exec(`
      INSERT INTO feature_flags(flag_key,name,description,master_enabled,default_enabled,rollout_percentage)
        VALUES('classes.numeric_assessments','Atividades com resposta numérica',
          'Aplicação controlada de versões aprovadas do próprio professor; correção exata e resultados por habilidade.',0,0,0);
      CREATE TABLE class_assessment_numeric_origins (
        assignment_id INTEGER PRIMARY KEY REFERENCES class_assessment_assignments(id) ON DELETE RESTRICT,
        owner_teacher_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
        request_key TEXT NOT NULL CHECK(length(request_key) BETWEEN 16 AND 100),
        request_hash TEXT NOT NULL CHECK(length(request_hash)=64),
        teacher_reviewed_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(owner_teacher_id,request_key)
      );
      CREATE TABLE class_assessment_numeric_responses (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        attempt_id INTEGER NOT NULL,
        assessment_item_id INTEGER NOT NULL REFERENCES class_assessment_typed_item_snapshots(assessment_item_id) ON DELETE RESTRICT,
        assignment_id INTEGER NOT NULL, class_id INTEGER NOT NULL, owner_teacher_id INTEGER NOT NULL,
        numeric_value TEXT,
        is_correct INTEGER NOT NULL CHECK(is_correct IN (0,1)),
        answered_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK((numeric_value IS NULL AND answered_at IS NULL AND is_correct=0) OR
          (numeric_value IS NOT NULL AND answered_at IS NOT NULL AND length(numeric_value)<=20
            AND json_valid(numeric_value) AND json_type(numeric_value) IN ('integer','real'))),
        UNIQUE(attempt_id,assessment_item_id),
        FOREIGN KEY(attempt_id,assignment_id,class_id,owner_teacher_id)
          REFERENCES class_assessment_attempts(id,assignment_id,class_id,owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY(assessment_item_id,assignment_id,class_id,owner_teacher_id)
          REFERENCES class_assessment_items(id,assignment_id,class_id,owner_teacher_id) ON DELETE RESTRICT
      );
      CREATE INDEX idx_numeric_responses_item ON class_assessment_numeric_responses(assessment_item_id,attempt_id,is_correct);
      CREATE VIEW class_assessment_scored_responses AS
        SELECT id,attempt_id,assessment_item_id,selected_option_id,assignment_id,class_id,owner_teacher_id,
          is_correct,answered_at,created_at,updated_at,NULL AS numeric_value FROM class_assessment_responses
        UNION ALL
        SELECT id,attempt_id,assessment_item_id,NULL,assignment_id,class_id,owner_teacher_id,
          is_correct,answered_at,created_at,updated_at,numeric_value FROM class_assessment_numeric_responses;
      CREATE TRIGGER numeric_responses_delete_guard BEFORE DELETE ON class_assessment_numeric_responses
        WHEN (SELECT status FROM class_assessment_attempts WHERE id=OLD.attempt_id)<>'draft'
      BEGIN SELECT RAISE(ABORT,'submitted_assessment_responses_are_immutable'); END;
      CREATE TRIGGER numeric_responses_identity_guard BEFORE UPDATE ON class_assessment_numeric_responses
        WHEN NEW.id<>OLD.id OR NEW.attempt_id<>OLD.attempt_id OR NEW.assessment_item_id<>OLD.assessment_item_id
          OR NEW.assignment_id<>OLD.assignment_id OR NEW.class_id<>OLD.class_id OR NEW.owner_teacher_id<>OLD.owner_teacher_id
      BEGIN SELECT RAISE(ABORT,'numeric_response_identity_is_immutable'); END;
      DROP TRIGGER typed_question_snapshot_validate_insert;
      DROP TRIGGER class_assessment_assignment_validate_publication;
      DROP TRIGGER class_assessment_attempt_validate_submission;
      DROP TRIGGER learning_recovery_plans_validate_insert;
      CREATE TRIGGER numeric_origin_no_update BEFORE UPDATE ON class_assessment_numeric_origins
      BEGIN SELECT RAISE(ABORT,'numeric_origin_is_immutable'); END;
      CREATE TRIGGER numeric_origin_no_delete BEFORE DELETE ON class_assessment_numeric_origins
      BEGIN SELECT RAISE(ABORT,'numeric_origin_is_immutable'); END;
      CREATE TRIGGER numeric_origin_validate_insert BEFORE INSERT ON class_assessment_numeric_origins
      WHEN NOT EXISTS(SELECT 1 FROM class_assessment_assignments a WHERE a.id=NEW.assignment_id
        AND a.owner_teacher_id=NEW.owner_teacher_id AND a.status='draft'
        AND a.question_count=(SELECT count(*) FROM class_assessment_items i
          JOIN class_assessment_typed_item_snapshots s ON s.assessment_item_id=i.id
          JOIN questions q ON q.id=i.source_question_id AND q.question_type='numeric_draft'
          WHERE i.assignment_id=a.id AND s.interaction_type='numeric' AND s.scoring_strategy='numeric_exact'))
      BEGIN SELECT RAISE(ABORT,'invalid_numeric_origin'); END;
    `);
    for (const action of ['INSERT','UPDATE']) {
      db.exec(`CREATE TRIGGER numeric_responses_${action.toLowerCase()}_guard BEFORE ${action} ON class_assessment_numeric_responses
        WHEN NOT EXISTS(SELECT 1 FROM class_assessment_attempts a
          JOIN class_assessment_typed_item_snapshots s ON s.assessment_item_id=NEW.assessment_item_id
          WHERE a.id=NEW.attempt_id AND a.status='draft' AND s.interaction_type='numeric' AND s.scoring_strategy='numeric_exact'
            AND NEW.is_correct=CASE WHEN NEW.numeric_value IS NOT NULL
              AND CAST(NEW.numeric_value AS REAL)=json_extract(s.definition_json,'$.answerKey.value') THEN 1 ELSE 0 END)
        OR EXISTS(SELECT 1 FROM class_assessment_responses WHERE attempt_id=NEW.attempt_id AND assessment_item_id=NEW.assessment_item_id)
        BEGIN SELECT RAISE(ABORT,'invalid_numeric_assessment_response'); END;
        CREATE TRIGGER numeric_no_choice_response_${action.toLowerCase()} BEFORE ${action} ON class_assessment_responses
        WHEN EXISTS(SELECT 1 FROM class_assessment_numeric_origins WHERE assignment_id=NEW.assignment_id)
        BEGIN SELECT RAISE(ABORT,'numeric_assessment_requires_numeric_response'); END;`);
    }
    // The original active-version branch is retained for the pre-existing typed engine.
    db.exec(snapshot.replace('WHEN NOT EXISTS (', `WHEN NOT EXISTS (
      SELECT 1 FROM class_assessment_items a JOIN class_assessment_assignments assignment ON assignment.id=a.assignment_id
      JOIN typed_question_items i ON i.id=NEW.typed_item_id AND i.question_id=a.source_question_id
      JOIN questions q ON q.id=i.question_id AND q.question_type='numeric_draft' AND q.created_by=a.owner_teacher_id
      JOIN typed_question_item_versions v ON v.item_id=i.id AND v.id=NEW.typed_version_id
      JOIN typed_question_review_cycles r ON r.version_id=v.id AND r.status='approved' AND r.definition_hash=v.definition_hash
      JOIN numeric_question_review_snapshots rs ON rs.review_id=r.id
      WHERE a.id=NEW.assessment_item_id AND assignment.status='draft' AND i.created_by=a.owner_teacher_id
        AND v.status='published' AND v.revision=r.version_revision+1
        AND NEW.interaction_type='numeric' AND NEW.scoring_strategy='numeric_exact' AND NEW.partial_credit=0
        AND NEW.engine_version=v.engine_version AND NEW.format_version=v.format_version
        AND NEW.correction_mode=v.correction_mode AND NEW.definition_json=v.definition_json AND NEW.definition_hash=v.definition_hash
        AND a.statement_snapshot=json_extract(v.definition_json,'$.content.stem')
        AND a.skill_code_snapshot=json_extract(rs.payload_json,'$.curriculum.skillCode')
        AND NOT EXISTS(SELECT 1 FROM class_assessment_item_options WHERE assessment_item_id=a.id)
    ) AND NOT EXISTS (`));
    db.exec(publication.replace('GROUP BY item.id', `AND NOT EXISTS(SELECT 1 FROM class_assessment_typed_item_snapshots s
              JOIN class_assessment_numeric_origins origin ON origin.assignment_id=item.assignment_id
              WHERE s.assessment_item_id=item.id AND s.interaction_type='numeric' AND s.scoring_strategy='numeric_exact')
            GROUP BY item.id`));
    db.exec(submission.replaceAll('class_assessment_responses','class_assessment_scored_responses')
      .replaceAll('selected_option_id IS NOT NULL','answered_at IS NOT NULL'));
    db.exec(recovery.replace('WHEN NOT EXISTS (', `WHEN NOT EXISTS (
      SELECT 1 FROM class_assessment_assignments a JOIN class_assessment_numeric_origins o ON o.assignment_id=a.id
      WHERE a.id=NEW.source_assignment_id AND a.class_id=NEW.class_id AND a.owner_teacher_id=NEW.owner_teacher_id
        AND o.owner_teacher_id=a.owner_teacher_id AND a.status='closed'
        AND EXISTS(SELECT 1 FROM class_assessment_attempts WHERE assignment_id=a.id AND status='submitted')
    ) AND NOT EXISTS (`));
    db.exec(`CREATE TRIGGER numeric_assessment_no_options BEFORE INSERT ON class_assessment_item_options
      WHEN EXISTS(SELECT 1 FROM class_assessment_items a JOIN questions q ON q.id=a.source_question_id
        WHERE a.id=NEW.assessment_item_id AND q.question_type='numeric_draft')
      BEGIN SELECT RAISE(ABORT,'numeric_assessment_has_no_options'); END;`);
  },
};
