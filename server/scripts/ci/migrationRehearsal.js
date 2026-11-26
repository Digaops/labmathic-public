const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const baselineMigration = require('../../src/migrations/001_baseline_current_schema');
const { inspectMigrations, runMigrations } = require('../../src/migrations');
const { compileTypedQuestionDefinition } = require('../../src/services/typedQuestionEngine');

const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

const GOVERNANCE_TABLES = [
  'product_releases',
  'feature_flags',
  'pilot_groups',
  'pilot_group_members',
  'feature_flag_group_rules',
  'feature_flag_user_rules',
  'feature_flag_role_rules',
  'governance_audit_log',
];

const FOUNDATION_TABLES = [
  'school_classes',
  'school_class_disciplines',
  'students',
  'school_class_enrollments',
  'school_class_entry_codes',
  'school_class_entry_code_redemptions',
];

const ASSESSMENT_TABLES = [
  'class_assessment_assignments',
  'class_assessment_items',
  'class_assessment_item_options',
  'class_assessment_participants',
];

const TEACHER_PREFERENCE_TABLES = [
  'teacher_grade_preference_profiles',
  'teacher_grade_preferences',
];

const ASSESSMENT_RESULT_TABLES = [
  'class_assessment_attempts',
  'class_assessment_responses',
];

const STUDENT_ASSESSMENT_ACCESS_TABLES = [
  'class_assessment_access_credentials',
];

const DIAGNOSTIC_TABLES = [
  'diagnostic_question_sets',
  'diagnostic_question_set_skills',
];

const PEDAGOGICAL_PLANNING_TABLES = [
  'material_bncc_skills',
  'learning_recovery_plans',
  'learning_recovery_plan_skills',
  'learning_recovery_student_groups',
  'learning_recovery_student_group_members',
  'teaching_plans',
  'teaching_plan_lessons',
  'teaching_plan_lesson_skills',
  'teaching_plan_lesson_resources',
  'learning_recovery_monitoring_cycles',
  'teaching_plan_write_operations',
];

const INSTITUTIONAL_TABLES = [
  'municipalities',
  'schools',
  'institutional_directory_imports',
  'institutional_school_directory',
  'institutional_memberships',
  'school_class_institution_contexts',
  'institutional_audit_log',
  'institutional_write_operations',
];

const TYPED_QUESTION_TABLES = [
  'typed_question_items',
  'typed_question_item_versions',
  'typed_question_current_versions',
  'class_assessment_typed_item_snapshots',
  'typed_question_audit_log',
  'typed_question_review_cycles',
  'typed_question_write_operations',
];

const MIGRATION_TABLES = [
  'material_bncc_reviews', 'material_bncc_review_state', 'material_bncc_operations',
  'material_drafts',
  'material_draft_files',
  'material_draft_operations',
  'material_management_operations',
  'pedagogical_feedback_versions',
  'revoked_auth_tokens',
  'material_file_retirements',
  ...GOVERNANCE_TABLES,
  ...FOUNDATION_TABLES,
  ...ASSESSMENT_TABLES,
  ...TEACHER_PREFERENCE_TABLES,
  ...ASSESSMENT_RESULT_TABLES,
  ...STUDENT_ASSESSMENT_ACCESS_TABLES,
  ...DIAGNOSTIC_TABLES,
  ...PEDAGOGICAL_PLANNING_TABLES,
  ...INSTITUTIONAL_TABLES,
  ...TYPED_QUESTION_TABLES,
];

const silentLogger = { info() {} };

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function tableExists(db, tableName) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(tableName));
}

function inspectIntegrity(db) {
  return {
    integrityCheck: db.pragma('integrity_check', { simple: true }),
    foreignKeyViolations: db.pragma('foreign_key_check').length,
  };
}

function assertHealthy(integrity, stage) {
  assert(integrity.integrityCheck === 'ok', `${stage}: integrity_check falhou.`);
  assert(integrity.foreignKeyViolations === 0, `${stage}: existem violações de chave estrangeira.`);
}

function createBaselineDatabase(databasePath) {
  const db = new Database(databasePath);
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'professor'
    );

    CREATE TABLE materials (id INTEGER PRIMARY KEY AUTOINCREMENT, file_path TEXT, thumbnail_path TEXT);
    CREATE TABLE collections (id INTEGER PRIMARY KEY AUTOINCREMENT, image_path TEXT);
    CREATE TABLE disciplines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE grades (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE
    );

    CREATE TABLE question_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      is_public INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL,
      description TEXT NOT NULL,
      grade_id INTEGER NOT NULL,
      FOREIGN KEY (grade_id) REFERENCES grades(id) ON DELETE CASCADE
    );

    CREATE TABLE questions (
      image_path TEXT,
      question_type TEXT DEFAULT 'multiple_choice',
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER,
      statement TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      source TEXT NOT NULL DEFAULT 'official',
      created_by INTEGER,
      FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );

    CREATE TABLE question_options (id INTEGER PRIMARY KEY, question_id INTEGER);
    CREATE TABLE question_set_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_set_id INTEGER NOT NULL,
      question_id INTEGER NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      show_image INTEGER NOT NULL DEFAULT 1,
      FOREIGN KEY (question_set_id) REFERENCES question_sets(id) ON DELETE CASCADE,
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );

    CREATE TABLE ci_rollback_sentinel (
      id INTEGER PRIMARY KEY,
      payload TEXT NOT NULL
    );

    INSERT INTO users (name, email, password, role)
    VALUES ('Professor CI', 'professor-ci@labmathic.invalid', 'hash-sintetico', 'professor');

    INSERT INTO users (name, email, password, role)
    VALUES ('Revisor CI', 'revisor-ci@labmathic.invalid', 'hash-sintetico', 'admin');

    INSERT INTO disciplines (name) VALUES ('Matematica');
    INSERT INTO grades (name) VALUES ('7o Ano');

    INSERT INTO ci_rollback_sentinel (id, payload)
    VALUES (1, 'dados-preservados-antes-da-migracao');
  `);

  const baselineResult = runMigrations(db, {
    migrations: [baselineMigration],
    logger: silentLogger,
  });
  assert(
    baselineResult.appliedNow.length === 1 && baselineResult.appliedNow[0].version === 1,
    'A baseline 001 não foi preparada corretamente.'
  );
  return db;
}

function resolveReportPath(reportPath) {
  if (!reportPath) return null;

  const resolved = path.resolve(REPOSITORY_ROOT, reportPath);
  const isInsideWorkspace = resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`);
  assert(isInsideWorkspace, 'O relatório de CI deve permanecer dentro do workspace.');
  return resolved;
}

async function runMigrationRehearsal(options = {}) {
  assert(process.env.NODE_ENV !== 'production', 'O ensaio de CI é proibido com NODE_ENV=production.');

  const startedAt = new Date();
  const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-ci-migrations-'));
  const baselinePath = path.join(tempDirectory, 'baseline.sqlite');
  const backupPath = path.join(tempDirectory, 'rollback-snapshot.sqlite');
  const migratedPath = path.join(tempDirectory, 'homologation.sqlite');
  const restoredPath = path.join(tempDirectory, 'restored.sqlite');
  let database;

  try {
    database = createBaselineDatabase(baselinePath);
    const baselineIntegrity = inspectIntegrity(database);
    assertHealthy(baselineIntegrity, 'baseline');
    await database.backup(backupPath);
    database.close();
    database = null;

    const backupHash = sha256(backupPath);
    fs.copyFileSync(backupPath, migratedPath);

    database = new Database(migratedPath);
    database.pragma('foreign_keys = ON');
    const migrationResult = runMigrations(database, { logger: silentLogger });
    const migrationStatus = inspectMigrations(database);
    const migratedIntegrity = inspectIntegrity(database);

    assertHealthy(migratedIntegrity, 'homologação');
    assert(migrationStatus.pending.length === 0, 'A homologação terminou com migrações pendentes.');
    assert(migrationStatus.changed.length === 0, 'A homologação detectou migrações alteradas.');
    assert(migrationStatus.unknown.length === 0, 'A homologação detectou migrações desconhecidas.');
    assert(migrationResult.appliedNow.length > 0, 'Nenhuma migração pendente foi aplicada no ensaio.');
    MIGRATION_TABLES.forEach((tableName) => {
      assert(tableExists(database, tableName), `Tabela esperada não encontrada: ${tableName}.`);
    });
    assert(
      database.prepare('SELECT payload FROM ci_rollback_sentinel WHERE id = 1').pluck().get()
        === 'dados-preservados-antes-da-migracao',
      'O dado sentinela foi alterado durante a migração.'
    );
    assert(
      database.prepare("SELECT COUNT(*) FROM product_releases WHERE version = '1.4.1'").pluck().get() === 1,
      'A release baseline esperada não foi criada.'
    );
    assert(
      database.prepare("SELECT COUNT(*) FROM product_releases WHERE version = '2.0.0' AND status = 'draft'")
        .pluck().get() === 1,
      'A release de turmas nao foi criada como rascunho.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*)
        FROM feature_flags
        WHERE flag_key IN (
          'classes.core',
          'classes.student_import',
          'classes.entry_codes',
          'classes.assessment_assignments',
          'classes.assessment_delivery',
          'classes.assessment_results',
          'classes.student_assessment_portal'
        )
          AND master_enabled = 0
          AND default_enabled = 0
          AND rollout_percentage = 0
      `).pluck().get() === 7,
      'As flags de turmas e aplicacao de simulados nao nasceram completamente desligadas.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'question_bank.diagnostic_generator'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'A flag do gerador diagnostico nao nasceu completamente desligada.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'institutions.core'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'A fundacao institucional nao nasceu completamente desligada.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'question_bank.typed_engine'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'O motor tipado de questoes nao nasceu completamente desligado.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'question_bank.typed_preview'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'O laboratorio tipado nao nasceu completamente desligado.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'question_bank.feedback_preview'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'O laboratorio de devolutivas nao nasceu completamente desligado.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'question_bank.catalog_preview'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'O laboratorio do banco de questoes nao nasceu completamente desligado.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM feature_flags
        WHERE flag_key = 'institutions.management_pilot'
          AND master_enabled = 0 AND default_enabled = 0 AND rollout_percentage = 0
      `).pluck().get() === 1,
      'O piloto operacional institucional nao nasceu completamente desligado.'
    );

    const teacherId = database.prepare("SELECT id FROM users WHERE role = 'professor' LIMIT 1")
      .pluck().get();
    const reviewerId = database.prepare("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
      .pluck().get();
    const gradeId = database.prepare('SELECT id FROM grades LIMIT 1').pluck().get();
    const disciplineId = database.prepare('SELECT id FROM disciplines LIMIT 1').pluck().get();
    const classId = database.prepare(`
      INSERT INTO school_classes (
        public_id, owner_teacher_id, name, grade_id, academic_year, created_by
      ) VALUES ('ci-class-public-id-0001', ?, 'Turma CI', ?, 2026, ?)
    `).run(teacherId, gradeId, teacherId).lastInsertRowid;
    assert(
      database.prepare(`
        SELECT COUNT(*)
        FROM school_class_institution_contexts
        WHERE class_id = ? AND owner_teacher_id = ? AND migration_status = 'pending'
          AND municipality_id IS NULL AND school_id IS NULL AND origin = 'legacy'
      `).pluck().get(classId, teacherId) === 1,
      'A turma legada nao recebeu contexto institucional pendente e isolado.'
    );
    database.prepare(`
      INSERT INTO school_class_disciplines (
        class_id, owner_teacher_id, discipline_id, added_by
      ) VALUES (?, ?, ?, ?)
    `).run(classId, teacherId, disciplineId, teacherId);
    const studentId = database.prepare(`
      INSERT INTO students (
        public_id, owner_teacher_id, display_name, external_reference, created_by
      ) VALUES ('ci-student-public-id-01', ?, 'Estudante CI', 'CI-001', ?)
    `).run(teacherId, teacherId).lastInsertRowid;
    const enrollmentId = database.prepare(`
      INSERT INTO school_class_enrollments (
        class_id, student_id, owner_teacher_id, created_by
      ) VALUES (?, ?, ?, ?)
    `).run(classId, studentId, teacherId, teacherId).lastInsertRowid;
    const entryCodeId = database.prepare(`
      INSERT INTO school_class_entry_codes (
        public_id, class_id, owner_teacher_id, code_digest,
        max_uses, expires_at, created_by
      ) VALUES ('ci-entry-code-public-01', ?, ?, ?, 1, '2099-01-01T00:00:00.000Z', ?)
    `).run(classId, teacherId, 'd'.repeat(64), teacherId).lastInsertRowid;
    database.prepare(`
      INSERT INTO school_class_entry_code_redemptions (
        entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id,
        request_digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(entryCodeId, classId, studentId, enrollmentId, teacherId, 'e'.repeat(64));
    assert(
      database.prepare('SELECT use_count FROM school_class_entry_codes WHERE id = ?')
        .pluck().get(entryCodeId) === 1,
      'O resgate sintetico nao atualizou o limite de uso do codigo.'
    );

    const questionSetId = database.prepare(`
      INSERT INTO question_sets (user_id, title) VALUES (?, 'Simulado CI')
    `).run(teacherId).lastInsertRowid;
    const skillId = database.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id)
      VALUES ('EF07MA01', 'Habilidade sintetica do ensaio', ?)
    `).run(gradeId).lastInsertRowid;
    const questionId = database.prepare(`
      INSERT INTO questions (
        question_code, skill_id, statement, source, created_by
      ) VALUES ('EF07MA01-CI001', ?, 'Quanto e dois mais dois?', 'teacher', ?)
    `).run(skillId, teacherId).lastInsertRowid;
    const assignmentId = database.prepare(`
      INSERT INTO class_assessment_assignments (
        public_id, class_id, owner_teacher_id, source_question_set_id,
        title_snapshot, snapshot_hash, question_count, created_by, updated_by
      ) VALUES ('ci-assessment-public-id-01', ?, ?, ?, 'Simulado CI', ?, 1, ?, ?)
    `).run(
      classId,
      teacherId,
      questionSetId,
      'f'.repeat(64),
      teacherId,
      teacherId
    ).lastInsertRowid;
    const assessmentItemId = database.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id, source_question_id,
        source_skill_id, question_code_snapshot, skill_code_snapshot,
        statement_snapshot, difficulty_snapshot, sort_order
      ) VALUES (?, ?, ?, ?, ?, 'EF07MA01-CI001', 'EF07MA01', ?, 'media', 0)
    `).run(
      assignmentId,
      classId,
      teacherId,
      questionId,
      skillId,
      'Quanto e dois mais dois?'
    ).lastInsertRowid;
    const typedDefinition = compileTypedQuestionDefinition({
      interactionType: 'single_choice',
      content: {
        stem: 'Quanto e dois mais dois?',
        supportText: null,
        choices: [
          { id: 'four', text: '4' },
          { id: 'three', text: '3' },
          { id: 'five', text: '5' },
          { id: 'six', text: '6' },
        ],
      },
      scoring: { strategy: 'exact', partialCredit: false },
      answerKey: { choiceId: 'four' },
      accessibility: {
        responseLabel: 'Alternativa da questao',
        instructions: 'Escolha uma alternativa.',
      },
      print: {
        supported: true,
        layout: 'choice_list',
        instructions: 'Marque uma alternativa.',
        answerSpaceLines: 0,
      },
      feedback: {
        releasePolicy: 'teacher_only',
        general: null,
        correct: null,
        incorrect: null,
        choiceFeedback: {},
      },
    });
    const typedItemId = database.prepare(`
      INSERT INTO typed_question_items (
        public_id, question_id, created_by, updated_by
      ) VALUES ('ci-typed-item-public-001', ?, ?, ?)
    `).run(questionId, teacherId, teacherId).lastInsertRowid;
    const typedVersionId = database.prepare(`
      INSERT INTO typed_question_item_versions (
        public_id, item_id, version, engine_version, format_version,
        interaction_type, correction_mode, scoring_strategy, partial_credit,
        accessibility_ready, print_supported, definition_json, definition_hash,
        created_by, updated_by
      ) VALUES (
        'ci-typed-version-public-1', ?, 1, 1, 1,
        'single_choice', 'automatic', 'exact', 0,
        1, 1, ?, ?, ?, ?
      )
    `).run(
      typedItemId,
      typedDefinition.definitionJson,
      typedDefinition.definitionHash,
      teacherId,
      teacherId,
    ).lastInsertRowid;
    const typedReviewId = database.prepare(`
      INSERT INTO typed_question_review_cycles (
        public_id, item_id, version_id, review_round,
        version_revision, definition_hash, submitted_by
      ) VALUES ('ci-typed-review-public-01', ?, ?, 1, 1, ?, ?)
    `).run(
      typedItemId,
      typedVersionId,
      typedDefinition.definitionHash,
      teacherId,
    ).lastInsertRowid;
    database.prepare(`
      UPDATE typed_question_review_cycles
      SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          decision_reason = 'Revisao sintetica independente concluida no ensaio.',
          revision = 2, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reviewerId, typedReviewId);
    database.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'published', revision = 2,
          updated_by = ?, published_by = ?, published_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(reviewerId, reviewerId, typedVersionId);
    database.prepare(`
      INSERT INTO typed_question_current_versions (
        item_id, version_id, activated_by
      ) VALUES (?, ?, ?)
    `).run(typedItemId, typedVersionId, teacherId);
    database.prepare(`
      UPDATE typed_question_items
      SET status = 'active', revision = 2, updated_by = ?
      WHERE id = ?
    `).run(teacherId, typedItemId);
    database.prepare(`
      INSERT INTO class_assessment_typed_item_snapshots (
        assessment_item_id, typed_item_id, typed_version_id,
        engine_version, format_version, interaction_type, correction_mode,
        scoring_strategy, partial_credit, definition_json, definition_hash
      ) VALUES (
        ?, ?, ?, 1, 1, 'single_choice', 'automatic', 'exact', 0, ?, ?
      )
    `).run(
      assessmentItemId,
      typedItemId,
      typedVersionId,
      typedDefinition.definitionJson,
      typedDefinition.definitionHash,
    );
    const insertOption = database.prepare(`
      INSERT INTO class_assessment_item_options (
        assessment_item_id, assignment_id, class_id, owner_teacher_id,
        option_label, option_text_snapshot, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    [
      ['A', '4', 1, 0],
      ['B', '3', 0, 1],
      ['C', '5', 0, 2],
      ['D', '6', 0, 3],
    ].forEach(([label, text, correct, order]) => {
      insertOption.run(
        assessmentItemId,
        assignmentId,
        classId,
        teacherId,
        label,
        text,
        correct,
        order
      );
    });
    database.prepare(`
      INSERT INTO class_assessment_participants (
        assignment_id, class_id, student_id, enrollment_id,
        owner_teacher_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(assignmentId, classId, studentId, enrollmentId, teacherId, teacherId);
    database.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'open', opened_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(assignmentId);
    assert(
      database.prepare('SELECT status FROM class_assessment_assignments WHERE id = ?')
        .pluck().get(assignmentId) === 'open',
      'A aplicacao sintetica nao passou pela validacao de publicacao.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*)
        FROM class_assessment_typed_item_snapshots
        WHERE assessment_item_id = ? AND typed_version_id = ?
      `).pluck().get(assessmentItemId, typedVersionId) === 1,
      'O snapshot tipado nao permaneceu ligado a versao publicada.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*) FROM typed_question_audit_log WHERE item_id = ?
      `).pluck().get(typedItemId) === 5,
      'O ciclo tipado nao produziu a trilha estrutural esperada.'
    );
    assert(
      database.prepare(`
        SELECT COUNT(*)
        FROM typed_question_review_cycles
        WHERE item_id = ? AND status = 'approved'
      `).pluck().get(typedItemId) === 1,
      'O ciclo tipado nao preservou a revisao editorial independente.'
    );
    assertHealthy(inspectIntegrity(database), 'homologacao com dados sinteticos');
    database.close();
    database = null;

    fs.copyFileSync(backupPath, restoredPath);
    const restoredHash = sha256(restoredPath);
    assert(restoredHash === backupHash, 'A restauração não reproduziu exatamente o snapshot de rollback.');

    database = new Database(restoredPath, { readonly: true, fileMustExist: true });
    database.pragma('foreign_keys = ON');
    const rollbackIntegrity = inspectIntegrity(database);
    const rollbackStatus = inspectMigrations(database);

    assertHealthy(rollbackIntegrity, 'rollback');
    assert(rollbackStatus.applied.length === 1, 'O snapshot restaurado não voltou à baseline 001.');
    assert(rollbackStatus.applied[0].version === 1, 'O snapshot restaurado possui baseline inesperada.');
    assert(rollbackStatus.changed.length === 0, 'O snapshot restaurado contém migração alterada.');
    assert(rollbackStatus.unknown.length === 0, 'O snapshot restaurado contém migração desconhecida.');
    assert(
      database.prepare('SELECT payload FROM ci_rollback_sentinel WHERE id = 1').pluck().get()
        === 'dados-preservados-antes-da-migracao',
      'O dado sentinela não foi recuperado no rollback.'
    );
    MIGRATION_TABLES.forEach((tableName) => {
      assert(!tableExists(database, tableName), `O rollback preservou indevidamente a tabela ${tableName}.`);
    });
    database.close();
    database = null;

    const report = {
      status: 'passed',
      startedAt: startedAt.toISOString(),
      completedAt: new Date().toISOString(),
      baseline: {
        appliedVersions: [1],
        integrityCheck: baselineIntegrity.integrityCheck,
        foreignKeyViolations: baselineIntegrity.foreignKeyViolations,
        snapshotSha256: backupHash,
      },
      migration: {
        appliedNow: migrationResult.appliedNow.map(({ version, name }) => ({ version, name })),
        finalAppliedVersions: migrationStatus.applied.map(({ version }) => version),
        integrityCheck: migratedIntegrity.integrityCheck,
        foreignKeyViolations: migratedIntegrity.foreignKeyViolations,
      },
      rollback: {
        exactSnapshotRestored: true,
        restoredSha256: restoredHash,
        appliedVersions: rollbackStatus.applied.map(({ version }) => version),
        pendingVersions: rollbackStatus.pending.map(({ version }) => version),
        integrityCheck: rollbackIntegrity.integrityCheck,
        foreignKeyViolations: rollbackIntegrity.foreignKeyViolations,
        sentinelRecovered: true,
      },
      safety: {
        isolatedTemporaryDatabase: true,
        productionDatabaseTouched: false,
        secretsRequired: false,
      },
    };

    const reportPath = resolveReportPath(options.reportPath || process.env.CI_REPORT_PATH);
    if (reportPath) {
      fs.mkdirSync(path.dirname(reportPath), { recursive: true });
      fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    }

    return report;
  } finally {
    if (database?.open) database.close();
    const resolvedTemp = path.resolve(tempDirectory);
    const tempRoot = path.resolve(os.tmpdir());
    if (resolvedTemp.startsWith(`${tempRoot}${path.sep}`)) {
      fs.rmSync(resolvedTemp, { recursive: true, force: true });
    }
  }
}

if (require.main === module) {
  runMigrationRehearsal()
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({ status: 'failed', error: error.message }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = { runMigrationRehearsal, createBaselineDatabase };
