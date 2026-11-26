module.exports = {
  version: 15,
  name: 'lesson_planner_application',
  description: 'Adiciona idempotencia e arquivamento seguro ao planejador de aulas.',
  up(db) {
    db.exec(`
      CREATE TABLE teaching_plan_write_operations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        owner_teacher_id INTEGER NOT NULL,
        operation_type TEXT NOT NULL
          CHECK(operation_type IN ('create', 'duplicate')),
        idempotency_key_hash TEXT NOT NULL,
        request_fingerprint TEXT NOT NULL,
        result_plan_id INTEGER NOT NULL,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(idempotency_key_hash) = 64),
        CHECK(length(request_fingerprint) = 64),
        UNIQUE(owner_teacher_id, operation_type, idempotency_key_hash),
        FOREIGN KEY (owner_teacher_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (result_plan_id, owner_teacher_id)
          REFERENCES teaching_plans(id, owner_teacher_id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_teaching_plan_operations_result
        ON teaching_plan_write_operations(result_plan_id, owner_teacher_id);

      CREATE TRIGGER teaching_plan_operations_prevent_update
      BEFORE UPDATE ON teaching_plan_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_operation_is_immutable');
      END;

      CREATE TRIGGER teaching_plan_operations_prevent_delete
      BEFORE DELETE ON teaching_plan_write_operations
      BEGIN
        SELECT RAISE(ABORT, 'teaching_plan_operation_is_immutable');
      END;

      DROP TRIGGER teaching_plans_status_transition;

      CREATE TRIGGER teaching_plans_status_transition
      BEFORE UPDATE OF status ON teaching_plans
      WHEN NEW.status <> OLD.status
        AND NOT (
          (OLD.status = 'draft' AND NEW.status IN ('active', 'archived'))
          OR (OLD.status = 'active' AND NEW.status IN ('completed', 'archived'))
          OR (OLD.status = 'completed' AND NEW.status = 'archived')
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_plan_status_transition');
      END;
    `);
  },
};
