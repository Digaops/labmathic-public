const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration010 = require('../src/migrations/010_learning_recovery_and_lesson_planning_foundation');
const migration012 = require('../src/migrations/012_learning_recovery_execution');
const migration013 = require('../src/migrations/013_learning_recovery_monitoring_cycle');
const migration014 = require('../src/migrations/014_learning_recovery_cross_grade_skills');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professor', 'admin'))
    );
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE disciplines (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE materials (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL
    );
    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY,
      code TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      grade_id INTEGER NOT NULL,
      FOREIGN KEY (grade_id) REFERENCES grades(id)
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      question_code TEXT NOT NULL UNIQUE,
      source TEXT NOT NULL CHECK(source IN ('official', 'teacher')),
      created_by INTEGER,
      FOREIGN KEY (created_by) REFERENCES users(id)
    );
    CREATE TABLE question_sets (
      id INTEGER PRIMARY KEY,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      is_public INTEGER NOT NULL DEFAULT 0 CHECK(is_public IN (0, 1)),
      contains_author_questions INTEGER NOT NULL DEFAULT 0 CHECK(contains_author_questions IN (0, 1)),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE TABLE question_set_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_set_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL,
      show_image INTEGER NOT NULL DEFAULT 1,
      option_order TEXT,
      FOREIGN KEY (question_set_id) REFERENCES question_sets(id),
      FOREIGN KEY (question_id) REFERENCES questions(id)
    );
    CREATE TABLE school_classes (
      id INTEGER PRIMARY KEY,
      owner_teacher_id INTEGER NOT NULL,
      grade_id INTEGER NOT NULL,
      academic_year INTEGER NOT NULL,
      UNIQUE(id, owner_teacher_id),
      FOREIGN KEY (owner_teacher_id) REFERENCES users(id),
      FOREIGN KEY (grade_id) REFERENCES grades(id)
    );
    CREATE TABLE students (
      id INTEGER PRIMARY KEY,
      owner_teacher_id INTEGER NOT NULL,
      display_name TEXT NOT NULL,
      UNIQUE(id, owner_teacher_id),
      FOREIGN KEY (owner_teacher_id) REFERENCES users(id)
    );
    CREATE TABLE class_assessment_assignments (
      id INTEGER PRIMARY KEY,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      source_question_set_id INTEGER,
      status TEXT NOT NULL,
      UNIQUE(id, class_id, owner_teacher_id),
      FOREIGN KEY (class_id, owner_teacher_id)
        REFERENCES school_classes(id, owner_teacher_id),
      FOREIGN KEY (source_question_set_id) REFERENCES question_sets(id)
    );
    CREATE TABLE class_assessment_items (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      source_skill_id INTEGER,
      skill_code_snapshot TEXT,
      skill_description_snapshot TEXT,
      FOREIGN KEY (assignment_id) REFERENCES class_assessment_assignments(id),
      FOREIGN KEY (source_skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
    );
    CREATE TABLE class_assessment_participants (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      class_id INTEGER NOT NULL,
      owner_teacher_id INTEGER NOT NULL,
      student_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (assignment_id, class_id, owner_teacher_id)
        REFERENCES class_assessment_assignments(id, class_id, owner_teacher_id),
      FOREIGN KEY (student_id, owner_teacher_id)
        REFERENCES students(id, owner_teacher_id)
    );
    CREATE TABLE class_assessment_attempts (
      id INTEGER PRIMARY KEY,
      assignment_id INTEGER NOT NULL,
      status TEXT NOT NULL,
      FOREIGN KEY (assignment_id) REFERENCES class_assessment_assignments(id)
    );
    CREATE TABLE diagnostic_question_sets (
      question_set_id INTEGER PRIMARY KEY,
      owner_teacher_id INTEGER NOT NULL,
      grade_id INTEGER NOT NULL,
      FOREIGN KEY (question_set_id) REFERENCES question_sets(id),
      FOREIGN KEY (owner_teacher_id) REFERENCES users(id),
      FOREIGN KEY (grade_id) REFERENCES grades(id)
    );
    CREATE TABLE diagnostic_question_set_reviews (
      question_set_id INTEGER PRIMARY KEY,
      owner_teacher_id INTEGER NOT NULL,
      reviewed_by INTEGER NOT NULL,
      FOREIGN KEY (question_set_id) REFERENCES diagnostic_question_sets(question_set_id),
      FOREIGN KEY (owner_teacher_id) REFERENCES users(id),
      FOREIGN KEY (reviewed_by) REFERENCES users(id)
    );
    CREATE TABLE product_releases (
      id INTEGER PRIMARY KEY,
      version TEXT NOT NULL UNIQUE
    );
    CREATE TABLE feature_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      flag_key TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      release_id INTEGER,
      master_enabled INTEGER NOT NULL DEFAULT 0,
      default_enabled INTEGER NOT NULL DEFAULT 0,
      rollout_percentage INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (release_id) REFERENCES product_releases(id)
    );

    INSERT INTO users VALUES
      (1, 'Professora Um', 'professor'),
      (2, 'Professor Dois', 'professor'),
      (3, 'Administrador', 'admin');
    INSERT INTO grades VALUES (7, '7º Ano'), (8, '8º Ano');
    INSERT INTO disciplines VALUES (1, 'Matemática');
    INSERT INTO materials VALUES (1, 'Frações em situações reais');
    INSERT INTO bncc_skills VALUES
      (70, 'EF07MA01', 'Resolver problemas com números inteiros.', 7),
      (80, 'EF08MA01', 'Resolver problemas do oitavo ano.', 8);
    INSERT INTO questions VALUES
      (700, 'EF07MA01-Q001', 'official', NULL),
      (701, 'EF07MA01-Q002', 'teacher', 1),
      (702, 'EF07MA01-Q003', 'teacher', 2);
    INSERT INTO question_sets (id, user_id, title, is_public) VALUES
      (100, 1, 'Diagnóstico revisado', 0),
      (101, 1, 'Simulado público', 1),
      (102, 2, 'Simulado privado de outro professor', 0);
    INSERT INTO school_classes VALUES
      (200, 1, 7, 2026),
      (201, 2, 7, 2026),
      (202, 1, 8, 2026);
    INSERT INTO students VALUES
      (500, 1, 'Estudante Um'),
      (501, 2, 'Estudante Dois');
    INSERT INTO class_assessment_assignments VALUES
      (300, 200, 1, 100, 'open'),
      (301, 200, 1, 101, 'closed');
    INSERT INTO class_assessment_items VALUES
      (350, 300, 70, 'EF07MA01', 'Resolver problemas com números inteiros.');
    INSERT INTO class_assessment_participants VALUES
      (360, 300, 200, 1, 500, 'submitted');
    INSERT INTO diagnostic_question_sets VALUES (100, 1, 7);
    INSERT INTO diagnostic_question_set_reviews VALUES (100, 1, 1);
    INSERT INTO product_releases VALUES (2, '2.0.0');
  `);
  migration010.up(db);
  return db;
}

function insertRecoveryPlan(db, overrides = {}) {
  return Number(db.prepare(`
    INSERT INTO learning_recovery_plans (
      public_id, owner_teacher_id, class_id, source_assignment_id,
      title, idempotency_key_hash, request_fingerprint,
      source_assessment_revision, source_results_revision_hash,
      diagnostic_algorithm_version_snapshot,
      diagnostic_confirmation_version_snapshot, created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    overrides.publicId || 'recovery-plan-public-0001',
    overrides.ownerTeacherId || 1,
    overrides.classId || 200,
    overrides.assignmentId || 300,
    overrides.title || 'Recomposição do diagnóstico inicial',
    overrides.idempotencyKeyHash || 'a'.repeat(64),
    overrides.requestFingerprint || 'b'.repeat(64),
    overrides.sourceAssessmentRevision || 1,
    overrides.sourceResultsRevisionHash || 'c'.repeat(64),
    'balanced-v1',
    'teacher-review-v1',
    overrides.createdBy || overrides.ownerTeacherId || 1,
    overrides.ownerTeacherId || 1
  ).lastInsertRowid);
}

function insertTeachingPlan(db, overrides = {}) {
  return Number(db.prepare(`
    INSERT INTO teaching_plans (
      public_id, owner_teacher_id, class_id, grade_id, discipline_id,
      source_recovery_plan_id, title, period_type, academic_year,
      starts_on, ends_on, created_by, updated_by
    ) VALUES (?, ?, ?, ?, 1, ?, ?, 'week', 2026, '2026-08-17', '2026-08-21', ?, ?)
  `).run(
    overrides.publicId || 'teaching-plan-public-0001',
    overrides.ownerTeacherId || 1,
    overrides.classId === undefined ? 200 : overrides.classId,
    overrides.gradeId || 7,
    overrides.sourceRecoveryPlanId || null,
    overrides.title || 'Semana de recomposição',
    overrides.ownerTeacherId || 1,
    overrides.ownerTeacherId || 1
  ).lastInsertRowid);
}

test('migração 010 é aditiva e mantém as novas capacidades desligadas', () => {
  const db = createDatabase();
  const tables = new Set(db.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table'
  `).all().map(({ name }) => name));

  for (const table of [
    'material_bncc_skills',
    'learning_recovery_plans',
    'learning_recovery_plan_skills',
    'learning_recovery_student_groups',
    'learning_recovery_student_group_members',
    'teaching_plans',
    'teaching_plan_lessons',
    'teaching_plan_lesson_skills',
    'teaching_plan_lesson_resources',
  ]) assert.equal(tables.has(table), true, `tabela ausente: ${table}`);

  assert.deepEqual(
    db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage
      FROM feature_flags
      ORDER BY flag_key
    `).all(),
    [
      {
        flag_key: 'classes.learning_recovery',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
      },
      {
        flag_key: 'planning.lesson_planner',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
      },
    ]
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM users').pluck().get(), 3);
  assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_assignments').pluck().get(), 2);
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('migração 012 preserva uma única execução e exige o ciclo concluído', () => {
  const db = createDatabase();
  migration012.up(db);
  db.prepare("UPDATE class_assessment_assignments SET status = 'closed' WHERE id = 300").run();
  db.prepare("INSERT INTO class_assessment_attempts VALUES (400, 300, 'submitted')").run();
  const recoveryPlanId = insertRecoveryPlan(db);
  db.prepare(`
    INSERT INTO learning_recovery_plan_skills (
      plan_id, owner_teacher_id, class_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot,
      success_rate_snapshot, opportunity_count, diagnostic_level, priority
    ) VALUES (?, 1, 200, 70, 'EF07MA01',
      'Resolver problemas com números inteiros.', 40, 5, 'below_expected', 1)
  `).run(recoveryPlanId);

  assert.throws(
    () => insertTeachingPlan(db, { sourceRecoveryPlanId: recoveryPlanId }),
    /recovery_execution_requires_active_plan/
  );
  db.prepare(`
    UPDATE learning_recovery_plans
    SET status = 'active', activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(recoveryPlanId);
  const executionId = insertTeachingPlan(db, { sourceRecoveryPlanId: recoveryPlanId });
  assert.throws(
    () => insertTeachingPlan(db, {
      publicId: 'teaching-plan-public-duplicate',
      sourceRecoveryPlanId: recoveryPlanId,
    }),
    /UNIQUE constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE learning_recovery_plans
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(recoveryPlanId),
    /learning_recovery_requires_completed_execution/
  );
  assert.equal(
    db.prepare('SELECT source_recovery_plan_id FROM teaching_plans WHERE id = ?')
      .pluck().get(executionId),
    recoveryPlanId
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('migração 013 preserva o monitoramento, vincula uma única aplicação e exige evidência', () => {
  const db = createDatabase();
  migration012.up(db);
  db.prepare("UPDATE class_assessment_assignments SET status = 'closed' WHERE id = 300").run();
  db.prepare("INSERT INTO class_assessment_attempts VALUES (400, 300, 'submitted')").run();
  const recoveryPlanId = insertRecoveryPlan(db);
  db.prepare(`
    INSERT INTO learning_recovery_plan_skills (
      plan_id, owner_teacher_id, class_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot,
      success_rate_snapshot, opportunity_count, diagnostic_level, priority
    ) VALUES (?, 1, 200, 70, 'EF07MA01',
      'Resolver problemas com números inteiros.', 40, 5, 'below_expected', 1)
  `).run(recoveryPlanId);
  db.prepare(`
    UPDATE learning_recovery_plans
    SET status = 'active', activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(recoveryPlanId);
  const executionId = insertTeachingPlan(db, { sourceRecoveryPlanId: recoveryPlanId });
  const interventionLessonId = Number(db.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective,
      sequence_order, planned_date
    ) VALUES ('recovery-lesson-public-001', ?, 1, 'Intervenção',
      'Retomar a habilidade.', 1, '2026-08-18')
  `).run(executionId).lastInsertRowid);
  const monitoringLessonId = Number(db.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective,
      sequence_order, planned_date
    ) VALUES ('recovery-lesson-public-002', ?, 1, 'Monitoramento',
      'Verificar a evolução.', 2, '2026-08-20')
  `).run(executionId).lastInsertRowid);
  for (const lessonId of [interventionLessonId, monitoringLessonId]) {
    db.prepare(`
      INSERT INTO teaching_plan_lesson_skills (
        lesson_id, plan_id, owner_teacher_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot
      ) VALUES (?, ?, 1, 70, 'EF07MA01', 'Resolver problemas com números inteiros.')
    `).run(lessonId, executionId);
  }
  db.prepare(`
    UPDATE teaching_plans
    SET status = 'active', activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(executionId);

  migration013.up(db);
  assert.deepEqual(
    db.prepare(`
      SELECT sequence_order, lesson_phase FROM teaching_plan_lessons
      WHERE plan_id = ? ORDER BY sequence_order
    `).all(executionId),
    [
      { sequence_order: 1, lesson_phase: 'intervention' },
      { sequence_order: 2, lesson_phase: 'monitoring' },
    ]
  );
  assert.throws(
    () => db.prepare("UPDATE teaching_plan_lessons SET lesson_phase = 'monitoring' WHERE id = ?")
      .run(interventionLessonId),
    /teaching_lesson_phase_is_immutable/
  );

  db.prepare(`
    INSERT INTO question_sets (id, user_id, title, description, is_public)
    VALUES (103, 1, 'Verificação da recomposição', 'Questões inéditas.', 0)
  `).run();
  db.prepare(`
    INSERT INTO question_set_items (question_set_id, question_id, sort_order)
    VALUES (103, 700, 1)
  `).run();
  const cycleId = Number(db.prepare(`
    INSERT INTO learning_recovery_monitoring_cycles (
      public_id, recovery_plan_id, execution_plan_id, monitoring_lesson_id,
      owner_teacher_id, class_id, question_set_id, created_by, updated_by
    ) VALUES ('monitoring-cycle-public-0001', ?, ?, ?, 1, 200, 103, 1, 1)
  `).run(recoveryPlanId, executionId, monitoringLessonId).lastInsertRowid);
  assert.throws(
    () => db.prepare("UPDATE question_sets SET title = 'Alterado' WHERE id = 103").run(),
    /recovery_monitoring_question_set_is_frozen/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO question_set_items (question_set_id, question_id, sort_order)
      VALUES (103, 701, 2)
    `).run(),
    /recovery_monitoring_question_set_is_frozen/
  );

  db.prepare(`
    INSERT INTO class_assessment_assignments
      (id, class_id, owner_teacher_id, source_question_set_id, status)
    VALUES (302, 200, 1, 103, 'draft')
  `).run();
  assert.equal(
    db.prepare('SELECT assignment_id FROM learning_recovery_monitoring_cycles WHERE id = ?')
      .pluck().get(cycleId),
    302
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO class_assessment_assignments
        (id, class_id, owner_teacher_id, source_question_set_id, status)
      VALUES (303, 200, 1, 103, 'draft')
    `).run(),
    /recovery_monitoring_assignment_already_created/
  );

  db.prepare("UPDATE teaching_plan_lessons SET status = 'taught' WHERE id = ?")
    .run(interventionLessonId);
  db.prepare("UPDATE teaching_plan_lessons SET status = 'taught' WHERE id = ?")
    .run(monitoringLessonId);
  assert.throws(
    () => db.prepare(`
      UPDATE teaching_plans SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(executionId),
    /recovery_execution_requires_monitoring_evidence/
  );
  db.prepare("UPDATE class_assessment_assignments SET status = 'closed' WHERE id = 302").run();
  db.prepare("INSERT INTO class_assessment_attempts VALUES (401, 302, 'submitted')").run();
  db.prepare(`
    UPDATE teaching_plans SET status = 'completed', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(executionId);
  assert.equal(db.prepare('SELECT status FROM teaching_plans WHERE id = ?').pluck().get(executionId), 'completed');
  assert.throws(
    () => db.prepare('DELETE FROM learning_recovery_monitoring_cycles WHERE id = ?').run(cycleId),
    /recovery_monitoring_history_is_immutable/
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('migração 014 permite recompor habilidades de outro ano e preserva o snapshot BNCC', () => {
  const db = createDatabase();
  const teachingPlanId = insertTeachingPlan(db, {
    publicId: 'cross-grade-teaching-plan-0001',
    classId: 202,
    gradeId: 8,
    title: 'Recomposição de habilidades anteriores',
  });
  const lessonId = Number(db.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective,
      sequence_order, planned_date
    ) VALUES ('cross-grade-lesson-public-0001', ?, 1, 'Retomada do 7º ano',
      'Retomar uma habilidade necessária à aprendizagem atual.', 1, '2026-08-18')
  `).run(teachingPlanId).lastInsertRowid);

  const insertCrossGradeSkill = () => db.prepare(`
    INSERT INTO teaching_plan_lesson_skills (
      lesson_id, plan_id, owner_teacher_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot
    ) VALUES (?, ?, 1, 70, 'EF07MA01', 'Resolver problemas com números inteiros.')
  `).run(lessonId, teachingPlanId);

  assert.throws(insertCrossGradeSkill, /invalid_teaching_lesson_skill/);
  migration014.up(db);
  insertCrossGradeSkill();
  assert.equal(
    db.prepare('SELECT COUNT(*) FROM teaching_plan_lesson_skills WHERE plan_id = ?')
      .pluck().get(teachingPlanId),
    1
  );
  const invalidLessonId = Number(db.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective,
      sequence_order, planned_date
    ) VALUES ('cross-grade-lesson-public-0002', ?, 1, 'Snapshot inválido',
      'Este registro deve ser recusado.', 2, '2026-08-19')
  `).run(teachingPlanId).lastInsertRowid);
  assert.throws(
    () => db.prepare(`
      INSERT INTO teaching_plan_lesson_skills (
        lesson_id, plan_id, owner_teacher_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot
      ) VALUES (?, ?, 1, 70, 'EF07MA99', 'Descrição adulterada.')
    `).run(invalidLessonId, teachingPlanId),
    /invalid_teaching_lesson_skill/
  );
  assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('recomposição exige diagnóstico revisado, encerrado e com resultado', () => {
  const db = createDatabase();

  assert.throws(() => insertRecoveryPlan(db), /learning_recovery_requires_closed_reviewed_diagnostic/);
  db.prepare("UPDATE class_assessment_assignments SET status = 'closed' WHERE id = 300").run();
  assert.throws(() => insertRecoveryPlan(db), /learning_recovery_requires_closed_reviewed_diagnostic/);
  db.prepare("INSERT INTO class_assessment_attempts VALUES (400, 300, 'submitted')").run();

  const planId = insertRecoveryPlan(db);
  assert.deepEqual(
    db.prepare(`
      SELECT source_assessment_revision,
        source_results_revision_hash,
        diagnostic_algorithm_version_snapshot,
        diagnostic_confirmation_version_snapshot
      FROM learning_recovery_plans WHERE id = ?
    `).get(planId),
    {
      source_assessment_revision: 1,
      source_results_revision_hash: 'c'.repeat(64),
      diagnostic_algorithm_version_snapshot: 'balanced-v1',
      diagnostic_confirmation_version_snapshot: 'teacher-review-v1',
    }
  );
  assert.throws(
    () => db.prepare(`
      UPDATE learning_recovery_plans SET request_fingerprint = ? WHERE id = ?
    `).run('c'.repeat(64), planId),
    /learning_recovery_identity_is_immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM diagnostic_question_set_reviews WHERE question_set_id = 100').run(),
    /diagnostic_review_is_immutable/
  );
  assert.throws(
    () => db.prepare(`
      UPDATE learning_recovery_plans
      SET status = 'active', activated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(planId),
    /learning_recovery_requires_priority_skill/
  );
  assert.throws(
    () => insertRecoveryPlan(db, {
      publicId: 'recovery-plan-public-0002',
      ownerTeacherId: 2,
      classId: 201,
    }),
    /learning_recovery_requires_closed_reviewed_diagnostic|FOREIGN KEY constraint failed/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO learning_recovery_plan_skills (
        plan_id, owner_teacher_id, class_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot,
        success_rate_snapshot, opportunity_count, diagnostic_level, priority
      ) VALUES (?, 1, 200, 80, 'EF08MA01', 'Resolver problemas do oitavo ano.', 40, 5, 'below_expected', 1)
    `).run(planId),
    /invalid_learning_recovery_skill_snapshot/
  );
  db.prepare(`
    INSERT INTO learning_recovery_plan_skills (
      plan_id, owner_teacher_id, class_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot,
      success_rate_snapshot, opportunity_count, diagnostic_level, priority
    ) VALUES (?, 1, 200, 70, 'EF07MA01', 'Resolver problemas com números inteiros.', 40, 5, 'below_expected', 1)
  `).run(planId);
  assert.throws(
    () => db.prepare(`
      UPDATE learning_recovery_plan_skills
      SET success_rate_snapshot = 80
      WHERE plan_id = ?
    `).run(planId),
    /learning_recovery_skill_snapshot_is_immutable/
  );
  const groupId = Number(db.prepare(`
    INSERT INTO learning_recovery_student_groups (
      public_id, plan_id, owner_teacher_id, class_id, focus_skill_id,
      focus_skill_code_snapshot, title, objective, sort_order
    ) VALUES ('recovery-group-public-0001', ?, 1, 200, 70, 'EF07MA01',
      'Retomada prioritária', 'Retomar a habilidade com apoio guiado.', 1)
  `).run(planId).lastInsertRowid);
  db.prepare(`
    INSERT INTO learning_recovery_student_group_members (
      group_id, plan_id, student_id, owner_teacher_id, class_id,
      success_rate_snapshot, opportunity_count
    ) VALUES (?, ?, 500, 1, 200, 40, 5)
  `).run(groupId, planId);
  assert.throws(
    () => db.prepare(`
      UPDATE learning_recovery_student_group_members
      SET success_rate_snapshot = 90
      WHERE group_id = ? AND student_id = 500
    `).run(groupId),
    /learning_recovery_group_member_is_immutable/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO learning_recovery_student_group_members (
        group_id, plan_id, student_id, owner_teacher_id, class_id
      ) VALUES (?, ?, 501, 1, 200)
    `).run(groupId, planId),
    /learning_recovery_content_is_frozen|FOREIGN KEY constraint failed/
  );

  db.prepare(`
    UPDATE learning_recovery_plans
    SET status = 'active', activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(planId);
  assert.throws(
    () => db.prepare('DELETE FROM learning_recovery_plans WHERE id = ?').run(planId),
    /learning_recovery_history_is_immutable/
  );
  assert.throws(
    () => db.prepare("UPDATE learning_recovery_plans SET status = 'draft' WHERE id = ?").run(planId),
    /invalid_learning_recovery_status_transition|CHECK constraint failed/
  );
  db.prepare('DELETE FROM bncc_skills WHERE id = 70').run();
  assert.deepEqual(
    db.prepare(`
      SELECT source_skill_id, skill_code_snapshot, skill_description_snapshot
      FROM learning_recovery_plan_skills
      WHERE plan_id = ?
    `).get(planId),
    {
      source_skill_id: null,
      skill_code_snapshot: 'EF07MA01',
      skill_description_snapshot: 'Resolver problemas com números inteiros.',
    }
  );
  assert.deepEqual(
    db.prepare(`
      SELECT focus_skill_id, focus_skill_code_snapshot
      FROM learning_recovery_student_groups
      WHERE id = ?
    `).get(groupId),
    { focus_skill_id: null, focus_skill_code_snapshot: 'EF07MA01' }
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});

test('vínculo material-habilidade exige curadoria administrativa', () => {
  const db = createDatabase();
  assert.throws(
    () => db.prepare(`
      INSERT INTO material_bncc_skills (material_id, skill_id, linked_by)
      VALUES (1, 70, 1)
    `).run(),
    /material_skill_mapping_requires_admin/
  );
  db.prepare(`
    INSERT INTO material_bncc_skills (material_id, skill_id, linked_by)
    VALUES (1, 70, 3)
  `).run();
  assert.deepEqual(
    db.prepare('SELECT material_id, skill_id, link_source FROM material_bncc_skills').get(),
    { material_id: 1, skill_id: 70, link_source: 'manual' }
  );
  db.prepare('DELETE FROM users WHERE id = 3').run();
  assert.deepEqual(
    db.prepare('SELECT material_id, skill_id, linked_by FROM material_bncc_skills').get(),
    { material_id: 1, skill_id: 70, linked_by: null }
  );
  db.close();
});

test('planejador preserva contexto da turma, autoria e recursos por referência', () => {
  const db = createDatabase();
  db.prepare("UPDATE class_assessment_assignments SET status = 'closed' WHERE id = 300").run();
  db.prepare("INSERT INTO class_assessment_attempts VALUES (400, 300, 'submitted')").run();
  const recoveryPlanId = insertRecoveryPlan(db);

  assert.throws(
    () => insertTeachingPlan(db, { publicId: 'teaching-plan-public-0002', gradeId: 8 }),
    /teaching_plan_class_context_mismatch/
  );
  const teachingPlanId = insertTeachingPlan(db, { sourceRecoveryPlanId: recoveryPlanId });
  assert.throws(
    () => db.prepare(`
      UPDATE teaching_plans
      SET status = 'active', activated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(teachingPlanId),
    /teaching_plan_requires_lessons_with_skills/
  );
  const lessonId = Number(db.prepare(`
    INSERT INTO teaching_plan_lessons (
      public_id, plan_id, owner_teacher_id, title, objective,
      sequence_order, planned_date
    ) VALUES ('teaching-lesson-public-001', ?, 1, 'Aula 1',
      'Retomar números inteiros em situações-problema.', 1, '2026-08-18')
  `).run(teachingPlanId).lastInsertRowid);
  assert.throws(
    () => db.prepare(`
      UPDATE teaching_plan_lessons
      SET public_id = 'teaching-lesson-public-changed'
      WHERE id = ?
    `).run(lessonId),
    /teaching_lesson_identity_is_immutable/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO teaching_plan_lessons (
        public_id, plan_id, owner_teacher_id, title, objective,
        sequence_order, planned_date
      ) VALUES ('teaching-lesson-public-002', ?, 1, 'Fora do período',
        'Não deve ser aceita.', 2, '2026-09-01')
    `).run(teachingPlanId),
    /teaching_lesson_outside_editable_plan/
  );
  db.prepare(`
    INSERT INTO teaching_plan_lesson_skills (
      lesson_id, plan_id, owner_teacher_id, source_skill_id,
      skill_code_snapshot, skill_description_snapshot
    ) VALUES (?, ?, 1, 70, 'EF07MA01', 'Resolver problemas com números inteiros.')
  `).run(lessonId, teachingPlanId);
  assert.throws(
    () => db.prepare('UPDATE teaching_plans SET grade_id = 8 WHERE id = ?').run(teachingPlanId),
    /teaching_plan_class_context_mismatch/
  );
  assert.throws(
    () => db.prepare("UPDATE teaching_plans SET ends_on = '2026-08-17' WHERE id = ?").run(teachingPlanId),
    /teaching_plan_period_conflicts_with_lessons/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO teaching_plan_lesson_skills (
        lesson_id, plan_id, owner_teacher_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot
      ) VALUES (?, ?, 1, 80, 'EF08MA01', 'Resolver problemas do oitavo ano.')
    `).run(lessonId, teachingPlanId),
    /invalid_teaching_lesson_skill/
  );

  db.prepare(`
    INSERT INTO teaching_plan_lesson_resources (
      lesson_id, plan_id, owner_teacher_id, resource_type,
      material_id, title_snapshot, sort_order
    ) VALUES (?, ?, 1, 'material', 1, 'Frações em situações reais', 1)
  `).run(lessonId, teachingPlanId);
  const questionResourceId = Number(db.prepare(`
    INSERT INTO teaching_plan_lesson_resources (
      lesson_id, plan_id, owner_teacher_id, resource_type,
      question_id, title_snapshot, sort_order
    ) VALUES (?, ?, 1, 'question', 700, 'EF07MA01-Q001', 2)
  `).run(lessonId, teachingPlanId).lastInsertRowid);
  assert.throws(
    () => db.prepare(`
      UPDATE teaching_plan_lesson_resources
      SET question_id = 702
      WHERE id = ?
    `).run(questionResourceId),
    /teaching_lesson_resource_identity_is_immutable/
  );
  assert.throws(
    () => db.prepare(`
      INSERT INTO teaching_plan_lesson_resources (
        lesson_id, plan_id, owner_teacher_id, resource_type,
        question_id, title_snapshot, sort_order
      ) VALUES (?, ?, 1, 'question', 702, 'Questão privada de outro professor', 3)
    `).run(lessonId, teachingPlanId),
    /invalid_teaching_lesson_resource/
  );
  db.prepare(`
    INSERT INTO teaching_plan_lesson_resources (
      lesson_id, plan_id, owner_teacher_id, resource_type,
      title_snapshot, teacher_notes, sort_order
    ) VALUES (?, ?, 1, 'activity', 'Discussão em duplas', 'Registrar estratégias.', 3)
  `).run(lessonId, teachingPlanId);

  db.prepare('DELETE FROM materials WHERE id = 1').run();
  assert.deepEqual(
    db.prepare(`
      SELECT material_id, title_snapshot
      FROM teaching_plan_lesson_resources
      WHERE resource_type = 'material'
    `).get(),
    { material_id: null, title_snapshot: 'Frações em situações reais' }
  );
  db.prepare(`
    UPDATE teaching_plans
    SET status = 'active', activated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(teachingPlanId);
  assert.throws(
    () => db.prepare(`
      UPDATE teaching_plans
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(teachingPlanId),
    /teaching_plan_has_pending_lessons/
  );
  db.prepare("UPDATE teaching_plan_lessons SET status = 'taught' WHERE id = ?").run(lessonId);
  db.prepare(`
    UPDATE teaching_plans
    SET status = 'completed', completed_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(teachingPlanId);
  assert.throws(
    () => db.prepare(`
      DELETE FROM teaching_plan_lesson_resources WHERE id = ?
    `).run(questionResourceId),
    /teaching_plan_content_is_frozen/
  );
  assert.throws(
    () => db.prepare("UPDATE teaching_plans SET title = 'Título alterado' WHERE id = ?").run(teachingPlanId),
    /teaching_plan_content_is_frozen/
  );
  db.prepare('DELETE FROM bncc_skills WHERE id = 70').run();
  assert.deepEqual(
    db.prepare(`
      SELECT source_skill_id, skill_code_snapshot, skill_description_snapshot
      FROM teaching_plan_lesson_skills
      WHERE lesson_id = ?
    `).get(lessonId),
    {
      source_skill_id: null,
      skill_code_snapshot: 'EF07MA01',
      skill_description_snapshot: 'Resolver problemas com números inteiros.',
    }
  );
  assert.deepEqual(db.pragma('foreign_key_check'), []);
  db.close();
});
