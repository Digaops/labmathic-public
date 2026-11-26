module.exports = {
  version: 14,
  name: 'learning_recovery_cross_grade_skills',
  description: 'Permite retomar habilidades BNCC de outros anos sem enfraquecer a integridade dos snapshots.',
  up(db) {
    db.exec(`
      DROP TRIGGER teaching_plan_lesson_skills_validate_insert;

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
          AND skill.code = NEW.skill_code_snapshot
          AND skill.description = NEW.skill_description_snapshot
      )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_teaching_lesson_skill');
      END;
    `);
  },
};
