module.exports = {
  version: 12,
  name: 'learning_recovery_execution',
  description: 'Garante uma execucao unica, acompanhavel e concluida para cada plano de recomposicao.',
  up(db) {
    db.exec(`
      CREATE UNIQUE INDEX idx_teaching_plans_single_recovery_execution
        ON teaching_plans(source_recovery_plan_id)
        WHERE source_recovery_plan_id IS NOT NULL;

      CREATE INDEX idx_teaching_plan_lessons_status_date
        ON teaching_plan_lessons(plan_id, status, planned_date, sequence_order);

      CREATE TRIGGER teaching_plan_recovery_source_must_be_active
      BEFORE INSERT ON teaching_plans
      WHEN NEW.source_recovery_plan_id IS NOT NULL
        AND NOT EXISTS (
          SELECT 1
          FROM learning_recovery_plans recovery
          WHERE recovery.id = NEW.source_recovery_plan_id
            AND recovery.owner_teacher_id = NEW.owner_teacher_id
            AND recovery.class_id = NEW.class_id
            AND recovery.status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'recovery_execution_requires_active_plan');
      END;

      CREATE TRIGGER learning_recovery_completion_requires_execution
      BEFORE UPDATE OF status ON learning_recovery_plans
      WHEN OLD.status = 'active'
        AND NEW.status = 'completed'
        AND NOT EXISTS (
          SELECT 1
          FROM teaching_plans execution
          WHERE execution.source_recovery_plan_id = OLD.id
            AND execution.owner_teacher_id = OLD.owner_teacher_id
            AND execution.class_id = OLD.class_id
            AND execution.status = 'completed'
        )
      BEGIN
        SELECT RAISE(ABORT, 'learning_recovery_requires_completed_execution');
      END;
    `);
  },
};
