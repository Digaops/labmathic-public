const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const { runMigrations } = require('../../src/migrations');

const CONFIRMATION = 'CREATE_ISOLATED_HOMOLOGATION_COPY';
const SANITIZER_VERSION = '27';
const HOMOLOGATION_PATH_PATTERN = /(homolog|staging)/i;
const silentLogger = { info() {} };

const EXPECTED_TABLES = new Set([
  'class_assessment_numeric_origins', 'class_assessment_numeric_responses',
  'numeric_question_review_snapshots',
  'content_issues', 'content_issue_events', 'content_issue_operations',
  'student_assessment_feedback', 'student_assessment_feedback_events', 'student_assessment_feedback_operations',
  'ai_usage_events', 'ai_budget_months',
  'ai_authoring_requests', 'ai_authoring_events', 'ai_authoring_question_links',
  'municipal_indicator_batches', 'municipal_indicator_places', 'municipal_indicator_values',
  'municipal_indicator_publication', 'municipal_indicator_events',
  'material_bncc_reviews', 'material_bncc_review_state', 'material_bncc_operations',
  'material_management_operations',
  'material_drafts',
  'material_draft_files',
  'material_draft_operations',
  'pedagogical_feedback_versions',
  'access_history',
  'activity_log',
  'announcement_impressions',
  'announcements',
  'bncc_skills',
  'bncc_units',
  'class_assessment_assignments',
  'class_assessment_access_credentials',
  'class_assessment_attempts',
  'class_assessment_item_options',
  'class_assessment_items',
  'class_assessment_participants',
  'class_assessment_responses',
  'class_assessment_typed_item_snapshots',
  'collection_items',
  'collections',
  'comments',
  'diagnostic_question_set_skills',
  'diagnostic_question_sets',
  'diagnostic_question_set_reviews',
  'disciplines',
  'favorites',
  'feature_flag_group_rules',
  'feature_flag_role_rules',
  'feature_flag_user_rules',
  'feature_flags',
  'governance_audit_log',
  'grades',
  'institutional_audit_log',
  'institutional_directory_imports',
  'institutional_school_directory',
  'institutional_write_operations',
  'institutional_memberships',
  'material_topics',
  'material_bncc_skills',
  'material_types',
  'materials',
  'municipalities',
  'notifications',
  'password_reset_tokens',
  'pilot_group_members',
  'pilot_groups',
  'product_releases',
  'question_options',
  'question_set_access_history',
  'question_set_creation_receipts',
  'question_editorial_curation',
  'question_set_items',
  'question_sets',
  'questions',
  'ratings',
  'schema_migrations',
  'school_class_disciplines',
  'school_class_enrollments',
  'school_class_entry_code_redemptions',
  'school_class_entry_codes',
  'school_class_institution_contexts',
  'school_classes',
  'schools',
  'share_links',
  'students',
  'support_messages',
  'support_threads',
  'learning_recovery_plan_skills',
  'learning_recovery_plans',
  'learning_recovery_monitoring_cycles',
  'learning_recovery_student_group_members',
  'learning_recovery_student_groups',
  'teaching_plan_lesson_resources',
  'teaching_plan_lesson_skills',
  'teaching_plan_lessons',
  'teaching_plans',
  'teaching_plan_write_operations',
  'teacher_grade_preference_profiles',
  'teacher_grade_preferences',
  'topics',
  'typed_question_audit_log',
  'typed_question_current_versions',
  'typed_question_item_versions',
  'typed_question_items',
  'typed_question_review_cycles',
  'typed_question_write_operations',
  'users',
  'revoked_auth_tokens',
  'material_file_retirements',
]);

const EMPTY_SENSITIVE_TABLES = [
  'question_set_creation_receipts',
  'class_assessment_numeric_origins', 'class_assessment_numeric_responses',
  'numeric_question_review_snapshots',
  'content_issue_operations', 'content_issue_events', 'content_issues',
  'student_assessment_feedback_operations', 'student_assessment_feedback_events', 'student_assessment_feedback',
  'ai_usage_events', 'ai_budget_months',
  'ai_authoring_question_links', 'ai_authoring_events', 'ai_authoring_requests',
  'material_bncc_operations', 'material_bncc_reviews',
  'material_draft_operations',
  'material_draft_files',
  'material_drafts',
  'material_management_operations',
  'pedagogical_feedback_versions',
  'revoked_auth_tokens',
  'material_file_retirements',
  'institutional_write_operations',
  'typed_question_write_operations',
  'typed_question_review_cycles',
  'institutional_audit_log',
  'school_class_institution_contexts',
  'institutional_memberships',
  'learning_recovery_monitoring_cycles',
  'teaching_plan_write_operations',
  'teaching_plan_lesson_resources',
  'teaching_plan_lesson_skills',
  'teaching_plan_lessons',
  'teaching_plans',
  'learning_recovery_student_group_members',
  'learning_recovery_student_groups',
  'learning_recovery_plan_skills',
  'learning_recovery_plans',
  'teacher_grade_preferences',
  'teacher_grade_preference_profiles',
  'class_assessment_access_credentials',
  'class_assessment_responses',
  'class_assessment_attempts',
  'class_assessment_item_options',
  'class_assessment_participants',
  'class_assessment_typed_item_snapshots',
  'class_assessment_items',
  'class_assessment_assignments',
  'school_class_entry_code_redemptions',
  'school_class_entry_codes',
  'school_class_enrollments',
  'school_class_disciplines',
  'students',
  'school_classes',
  'schools',
  'municipalities',
  'password_reset_tokens',
  'share_links',
  'support_messages',
  'support_threads',
  'notifications',
  'comments',
  'ratings',
  'favorites',
  'access_history',
  'question_set_access_history',
  'announcement_impressions',
  'activity_log',
  'governance_audit_log',
];

const EMAIL_PATTERN = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const UUID_PUBLIC_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REDACTION_PATTERNS = [
  {
    pattern: /\b\d{3}\.?\d{3}\.?\d{3}-?\d{2}\b/g,
    replacement: '[CPF_REMOVIDO]',
  },
  {
    pattern: /(?:\+?55\s*)?\(?\d{2}\)?\s*9?\d{4}[-\s]\d{4}\b/g,
    replacement: '[TELEFONE_REMOVIDO]',
  },
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function quoteIdentifier(identifier) {
  return `"${String(identifier).replace(/"/g, '""')}"`;
}

function sha256(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function listUserTables(db) {
  return db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table'
      AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all().map(({ name }) => name);
}

function assertKnownSchema(db) {
  const actualTables = listUserTables(db);
  const unknown = actualTables.filter((table) => !EXPECTED_TABLES.has(table));
  const missing = [...EXPECTED_TABLES].filter((table) => !actualTables.includes(table));

  assert(
    unknown.length === 0,
    `Sanitização bloqueada: tabelas sem política definida: ${unknown.join(', ')}.`
  );
  assert(
    missing.length === 0,
    `Sanitização bloqueada: tabelas obrigatórias ausentes: ${missing.join(', ')}.`
  );
}

function redactText(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  const emailSafeValue = value.replace(EMAIL_PATTERN, (email) => (
    email.toLowerCase().endsWith('@homologacao.invalid') ? email : '[EMAIL_REMOVIDO]'
  ));
  return REDACTION_PATTERNS.reduce(
    (redacted, { pattern, replacement }) => redacted.replace(pattern, replacement),
    emailSafeValue
  );
}

function isGeneratedIdentifier(tableName, columnName, value) {
  if (typeof value !== 'string') return false;
  if (columnName === 'public_id') return UUID_PUBLIC_ID_PATTERN.test(value);
  return tableName === 'questions' && columnName === 'question_code'
    && value.startsWith('NUM-') && UUID_PUBLIC_ID_PATTERN.test(value.slice(4));
}

function redactAllTextColumns(db) {
  for (const tableName of listUserTables(db)) {
    const textColumns = db.pragma(`table_info(${quoteIdentifier(tableName)})`)
      .filter(({ type }) => /TEXT|CHAR|CLOB/i.test(type || ''))
      .map(({ name }) => name);

    if (textColumns.length === 0) continue;

    const selectedColumns = textColumns.map(quoteIdentifier).join(', ');
    const rows = db.prepare(`
      SELECT rowid AS __rowid, ${selectedColumns}
      FROM ${quoteIdentifier(tableName)}
    `).all();

    for (const row of rows) {
      for (const columnName of textColumns) {
        // A generated UUID can contain a digit/hyphen sequence resembling a phone.
        // Preserve only complete UUIDs in public_id or the generated NUM- code; content,
        // JSON and malformed identifiers still follow the normal redaction policy.
        if (isGeneratedIdentifier(tableName, columnName, row[columnName])) continue;
        const redacted = redactText(row[columnName]);
        if (redacted === row[columnName]) continue;
        db.prepare(`
          UPDATE ${quoteIdentifier(tableName)}
          SET ${quoteIdentifier(columnName)} = ?
          WHERE rowid = ?
        `).run(redacted, row.__rowid);
      }
    }
  }
}

function redactNestedText(value) {
  if (typeof value === 'string') return redactText(value);
  if (Array.isArray(value)) return value.map(redactNestedText);
  if (value && typeof value === 'object') {
    return Object.keys(value).reduce((result, key) => {
      result[key] = redactNestedText(value[key]);
      return result;
    }, {});
  }
  return value;
}

function redactTypedQuestionDefinitions(db) {
  const rows = db.prepare(`
    SELECT id, definition_json
    FROM typed_question_item_versions
    ORDER BY id
  `).all();
  const update = db.prepare(`
    UPDATE typed_question_item_versions
    SET definition_json = ?, definition_hash = ?,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `);

  for (const row of rows) {
    const redactedJson = JSON.stringify(redactNestedText(JSON.parse(row.definition_json)));
    if (redactedJson === row.definition_json) continue;
    const redactedHash = crypto.createHash('sha256').update(redactedJson).digest('hex');
    update.run(redactedJson, redactedHash, row.id);
  }
}

function recreateGovernanceAuditProtection(db) {
  db.exec(`
    CREATE TRIGGER governance_audit_log_prevent_update
    BEFORE UPDATE ON governance_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'governance_audit_log is immutable');
    END;

    CREATE TRIGGER governance_audit_log_prevent_delete
    BEFORE DELETE ON governance_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'governance_audit_log is immutable');
    END;
  `);
}

function recreateEntryCodeRedemptionProtection(db) {
  db.exec(`
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
  `);
}

function recreateAssessmentDeleteProtection(db) {
  db.exec(`
    CREATE TRIGGER diagnostic_reviews_prevent_delete
    BEFORE DELETE ON diagnostic_question_set_reviews
    BEGIN
      SELECT RAISE(ABORT, 'diagnostic_review_is_immutable');
    END;

    CREATE TRIGGER assessment_access_prevent_delete
    BEFORE DELETE ON class_assessment_access_credentials
    BEGIN
      SELECT RAISE(ABORT, 'assessment_access_history_is_immutable');
    END;

    CREATE TRIGGER class_assessment_items_prevent_delete
    BEFORE DELETE ON class_assessment_items
    WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id) <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'published_assessment_items_are_immutable');
    END;

    CREATE TRIGGER class_assessment_options_prevent_delete
    BEFORE DELETE ON class_assessment_item_options
    WHEN (
      SELECT caa.status
      FROM class_assessment_assignments caa
      WHERE caa.id = OLD.assignment_id
    ) <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'published_assessment_options_are_immutable');
    END;

    CREATE TRIGGER class_assessment_participants_prevent_delete
    BEFORE DELETE ON class_assessment_participants
    WHEN (SELECT status FROM class_assessment_assignments WHERE id = OLD.assignment_id)
      IN ('open', 'closed', 'cancelled')
    BEGIN
      SELECT RAISE(ABORT, 'assessment_roster_is_frozen');
    END;

    CREATE TRIGGER class_assessment_responses_validate_delete
    BEFORE DELETE ON class_assessment_responses
    WHEN (SELECT status FROM class_assessment_attempts WHERE id = OLD.attempt_id) <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'assessment_responses_are_immutable');
    END;

    CREATE TRIGGER typed_question_snapshot_prevent_delete
    BEFORE DELETE ON class_assessment_typed_item_snapshots
    WHEN (
      SELECT assignment.status
      FROM class_assessment_items assessment_item
      JOIN class_assessment_assignments assignment
        ON assignment.id = assessment_item.assignment_id
      WHERE assessment_item.id = OLD.assessment_item_id
    ) <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'published_typed_question_snapshot_is_immutable');
    END;
  `);
}

function recreateTypedQuestionProtection(db) {
  db.exec(`
    CREATE TRIGGER typed_question_versions_published_content_is_immutable
    BEFORE UPDATE OF interaction_type, correction_mode, scoring_strategy,
      partial_credit, accessibility_ready, print_supported, definition_json,
      definition_hash
    ON typed_question_item_versions
    WHEN OLD.status <> 'draft'
      AND (
        NEW.interaction_type IS NOT OLD.interaction_type
        OR NEW.correction_mode IS NOT OLD.correction_mode
        OR NEW.scoring_strategy IS NOT OLD.scoring_strategy
        OR NEW.partial_credit IS NOT OLD.partial_credit
        OR NEW.accessibility_ready IS NOT OLD.accessibility_ready
        OR NEW.print_supported IS NOT OLD.print_supported
        OR NEW.definition_json IS NOT OLD.definition_json
        OR NEW.definition_hash IS NOT OLD.definition_hash
      )
    BEGIN
      SELECT RAISE(ABORT, 'published_typed_question_version_is_immutable');
    END;

    CREATE TRIGGER typed_question_reviews_prevent_delete
    BEFORE DELETE ON typed_question_review_cycles
    BEGIN
      SELECT RAISE(ABORT, 'typed_question_review_cannot_be_deleted');
    END;

    CREATE TRIGGER typed_question_operations_prevent_update
    BEFORE UPDATE ON typed_question_write_operations
    BEGIN
      SELECT RAISE(ABORT, 'typed_question_write_operation_is_immutable');
    END;

    CREATE TRIGGER typed_question_operations_prevent_delete
    BEFORE DELETE ON typed_question_write_operations
    BEGIN
      SELECT RAISE(ABORT, 'typed_question_write_operation_is_immutable');
    END;
  `);
}

function recreateInstitutionalProtection(db) {
  db.exec(`
    CREATE TRIGGER institutional_write_operations_prevent_update
    BEFORE UPDATE ON institutional_write_operations
    BEGIN
      SELECT RAISE(ABORT, 'institutional_write_operation_is_immutable');
    END;

    CREATE TRIGGER institutional_write_operations_prevent_delete
    BEFORE DELETE ON institutional_write_operations
    BEGIN
      SELECT RAISE(ABORT, 'institutional_write_operation_is_immutable');
    END;

    CREATE TRIGGER institutional_audit_log_prevent_update
    BEFORE UPDATE ON institutional_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'institutional_audit_log_is_immutable');
    END;

    CREATE TRIGGER institutional_audit_log_prevent_delete
    BEFORE DELETE ON institutional_audit_log
    BEGIN
      SELECT RAISE(ABORT, 'institutional_audit_log_is_immutable');
    END;

    CREATE TRIGGER school_class_contexts_prevent_delete
    BEFORE DELETE ON school_class_institution_contexts
    BEGIN
      SELECT RAISE(ABORT, 'school_class_context_history_is_immutable');
    END;
  `);
}

function recreatePedagogicalPlanningDeleteProtection(db) {
  db.exec(`
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

    CREATE TRIGGER recovery_monitoring_cycle_prevent_delete
    BEFORE DELETE ON learning_recovery_monitoring_cycles
    BEGIN
      SELECT RAISE(ABORT, 'recovery_monitoring_history_is_immutable');
    END;

    CREATE TRIGGER learning_recovery_plans_prevent_delete
    BEFORE DELETE ON learning_recovery_plans
    WHEN OLD.status <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'learning_recovery_history_is_immutable');
    END;

    CREATE TRIGGER teaching_plans_prevent_delete
    BEFORE DELETE ON teaching_plans
    WHEN OLD.status <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'teaching_plan_history_is_immutable');
    END;

    CREATE TRIGGER learning_recovery_content_requires_draft_skill_delete
    BEFORE DELETE ON learning_recovery_plan_skills
    WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
    END;

    CREATE TRIGGER learning_recovery_group_requires_draft_delete
    BEFORE DELETE ON learning_recovery_student_groups
    WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
    END;

    CREATE TRIGGER learning_recovery_group_member_requires_draft_delete
    BEFORE DELETE ON learning_recovery_student_group_members
    WHEN COALESCE((SELECT status FROM learning_recovery_plans WHERE id = OLD.plan_id), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'learning_recovery_content_is_frozen');
    END;

    CREATE TRIGGER teaching_plan_lessons_prevent_delete
    BEFORE DELETE ON teaching_plan_lessons
    WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '') <> 'draft'
    BEGIN
      SELECT RAISE(ABORT, 'teaching_plan_history_is_immutable');
    END;

    CREATE TRIGGER teaching_plan_lesson_skills_validate_delete
    BEFORE DELETE ON teaching_plan_lesson_skills
    WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '')
      NOT IN ('draft', 'active')
    BEGIN
      SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
    END;

    CREATE TRIGGER teaching_plan_resources_validate_delete
    BEFORE DELETE ON teaching_plan_lesson_resources
    WHEN COALESCE((SELECT status FROM teaching_plans WHERE id = OLD.plan_id), '')
      NOT IN ('draft', 'active')
    BEGIN
      SELECT RAISE(ABORT, 'teaching_plan_content_is_frozen');
    END;
  `);
}

function sanitizeCopy(db, options) {
  const sourceCounts = {
    users: db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
    supportMessages: db.prepare('SELECT COUNT(*) FROM support_messages').pluck().get(),
    activityEvents: db.prepare('SELECT COUNT(*) FROM activity_log').pluck().get(),
    classes: db.prepare('SELECT COUNT(*) FROM school_classes').pluck().get(),
    students: db.prepare('SELECT COUNT(*) FROM students').pluck().get(),
    enrollments: db.prepare('SELECT COUNT(*) FROM school_class_enrollments').pluck().get(),
    assessmentAssignments: db.prepare('SELECT COUNT(*) FROM class_assessment_assignments').pluck().get(),
    municipalities: db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(),
    schools: db.prepare('SELECT COUNT(*) FROM schools').pluck().get(),
    institutionalMemberships: db.prepare('SELECT COUNT(*) FROM institutional_memberships').pluck().get(),
    institutionalWriteOperations: db.prepare('SELECT COUNT(*) FROM institutional_write_operations').pluck().get(),
    typedQuestionItems: db.prepare('SELECT COUNT(*) FROM typed_question_items').pluck().get(),
    typedQuestionVersions: db.prepare('SELECT COUNT(*) FROM typed_question_item_versions').pluck().get(),
    typedQuestionReviews: db.prepare('SELECT COUNT(*) FROM typed_question_review_cycles').pluck().get(),
    typedQuestionOperations: db.prepare('SELECT COUNT(*) FROM typed_question_write_operations').pluck().get(),
  };
  const sourceSchemaVersion = db.prepare(
    'SELECT COALESCE(MAX(version), 0) FROM schema_migrations'
  ).pluck().get();
  const disabledPasswordHash = bcrypt.hashSync(crypto.randomBytes(48).toString('hex'), 12);
  const smokeAdminHash = bcrypt.hashSync(options.adminPassword, 12);
  const smokeProfessorHash = bcrypt.hashSync(options.professorPassword, 12);

  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS governance_audit_log_prevent_update;
      DROP TRIGGER IF EXISTS material_bncc_reviews_no_delete;
      DROP TRIGGER IF EXISTS content_issue_events_no_delete;
      DROP TRIGGER IF EXISTS student_assessment_feedback_immutable_update;
      DROP TRIGGER IF EXISTS student_assessment_feedback_immutable_delete;
      DROP TRIGGER IF EXISTS student_assessment_feedback_events_immutable_update;
      DROP TRIGGER IF EXISTS student_assessment_feedback_events_immutable_delete;
      UPDATE material_bncc_review_state SET needs_review=1;
      DROP TRIGGER IF EXISTS pedagogical_feedback_prevent_delete;
      DROP TRIGGER IF EXISTS governance_audit_log_prevent_delete;
      DROP TRIGGER IF EXISTS institutional_audit_log_prevent_update;
      DROP TRIGGER IF EXISTS institutional_audit_log_prevent_delete;
      DROP TRIGGER IF EXISTS institutional_write_operations_prevent_update;
      DROP TRIGGER IF EXISTS institutional_write_operations_prevent_delete;
      DROP TRIGGER IF EXISTS school_class_contexts_prevent_delete;
      DROP TRIGGER IF EXISTS school_class_entry_code_redemptions_prevent_update;
      DROP TRIGGER IF EXISTS school_class_entry_code_redemptions_prevent_delete;
      DROP TRIGGER IF EXISTS class_assessment_items_prevent_delete;
      DROP TRIGGER IF EXISTS class_assessment_options_prevent_delete;
      DROP TRIGGER IF EXISTS class_assessment_participants_prevent_delete;
      DROP TRIGGER IF EXISTS assessment_access_prevent_delete;
      DROP TRIGGER IF EXISTS class_assessment_responses_validate_delete;
      DROP TRIGGER IF EXISTS numeric_responses_delete_guard;
      DROP TRIGGER IF EXISTS numeric_origin_no_delete;
      DROP TRIGGER IF EXISTS typed_question_snapshot_prevent_delete;
      DROP TRIGGER IF EXISTS typed_question_versions_published_content_is_immutable;
      DROP TRIGGER IF EXISTS typed_question_reviews_prevent_delete;
      DROP TRIGGER IF EXISTS numeric_review_snapshot_no_delete;
      DROP TRIGGER IF EXISTS typed_question_operations_prevent_update;
      DROP TRIGGER IF EXISTS typed_question_operations_prevent_delete;
      DROP TRIGGER IF EXISTS diagnostic_reviews_prevent_delete;
      DROP TRIGGER IF EXISTS learning_recovery_plans_prevent_delete;
      DROP TRIGGER IF EXISTS teaching_plans_prevent_delete;
      DROP TRIGGER IF EXISTS learning_recovery_content_requires_draft_skill_delete;
      DROP TRIGGER IF EXISTS learning_recovery_group_requires_draft_delete;
      DROP TRIGGER IF EXISTS learning_recovery_group_member_requires_draft_delete;
      DROP TRIGGER IF EXISTS teaching_plan_lessons_prevent_delete;
      DROP TRIGGER IF EXISTS teaching_plan_lesson_skills_validate_delete;
      DROP TRIGGER IF EXISTS teaching_plan_resources_validate_delete;
      DROP TRIGGER IF EXISTS recovery_monitoring_cycle_prevent_delete;
      DROP TRIGGER IF EXISTS teaching_plan_operations_prevent_update;
      DROP TRIGGER IF EXISTS teaching_plan_operations_prevent_delete;
    `);

    db.prepare(`
      UPDATE users
      SET name = CASE
          WHEN role = 'admin' THEN 'Administrador sanitizado ' || id
          ELSE 'Professor sanitizado ' || id
        END,
        email = 'usuario-' || id || '@homologacao.invalid',
        password = ?,
        updated_at = CURRENT_TIMESTAMP
    `).run(disabledPasswordHash);

    for (const tableName of EMPTY_SENSITIVE_TABLES) {
      db.prepare(`DELETE FROM ${quoteIdentifier(tableName)}`).run();
    }
    db.exec(`CREATE TRIGGER numeric_origin_no_delete BEFORE DELETE ON class_assessment_numeric_origins
      BEGIN SELECT RAISE(ABORT,'numeric_origin_is_immutable'); END;`);
    db.exec(`CREATE TRIGGER numeric_responses_delete_guard BEFORE DELETE ON class_assessment_numeric_responses
      WHEN (SELECT status FROM class_assessment_attempts WHERE id=OLD.attempt_id)<>'draft'
      BEGIN SELECT RAISE(ABORT,'submitted_assessment_responses_are_immutable'); END;`);
    db.exec(`CREATE TRIGGER numeric_review_snapshot_no_delete BEFORE DELETE ON numeric_question_review_snapshots
      BEGIN SELECT RAISE(ABORT,'numeric_review_snapshot_is_immutable'); END;`);
    db.exec(`CREATE TRIGGER material_bncc_reviews_no_delete BEFORE DELETE ON material_bncc_reviews
      BEGIN SELECT RAISE(ABORT,'Material reviews are immutable'); END;`);
    db.exec(`CREATE TRIGGER content_issue_events_no_delete BEFORE DELETE ON content_issue_events
      BEGIN SELECT RAISE(ABORT,'Content issue history is immutable'); END;`);
    db.exec(`
      CREATE TRIGGER student_assessment_feedback_immutable_update
        BEFORE UPDATE ON student_assessment_feedback
      BEGIN SELECT RAISE(ABORT,'Student feedback is immutable'); END;
      CREATE TRIGGER student_assessment_feedback_immutable_delete
        BEFORE DELETE ON student_assessment_feedback
      BEGIN SELECT RAISE(ABORT,'Student feedback is immutable'); END;
      CREATE TRIGGER student_assessment_feedback_events_immutable_update
        BEFORE UPDATE ON student_assessment_feedback_events
      BEGIN SELECT RAISE(ABORT,'Student feedback history is immutable'); END;
      CREATE TRIGGER student_assessment_feedback_events_immutable_delete
        BEFORE DELETE ON student_assessment_feedback_events
      BEGIN SELECT RAISE(ABORT,'Student feedback history is immutable'); END;
    `);

    db.exec(`
      UPDATE collections
      SET name = 'Coleção sanitizada #' || id,
          description = NULL,
          is_public = 0,
          updated_at = CURRENT_TIMESTAMP;

      UPDATE question_sets
      SET title = 'Simulado sanitizado #' || id,
          description = NULL,
          is_public = 0,
          updated_at = CURRENT_TIMESTAMP;

      UPDATE pilot_groups
      SET name = 'Grupo piloto sanitizado #' || id,
          description = NULL,
          active = 0,
          revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP;

      UPDATE feature_flags
      SET master_enabled = 0,
          default_enabled = 0,
          rollout_percentage = 0,
          kill_switch_active = 1,
          kill_switch_reason = 'Desativada automaticamente na cópia sanitizada.',
          kill_switch_activated_by = NULL,
          kill_switch_activated_at = CURRENT_TIMESTAMP,
          revision = revision + 1,
          updated_at = CURRENT_TIMESTAMP;

      UPDATE feature_flag_group_rules
      SET reason = 'Regra preservada na cópia sanitizada.',
          updated_at = CURRENT_TIMESTAMP;

      UPDATE feature_flag_user_rules
      SET reason = 'Regra preservada na cópia sanitizada.',
          updated_at = CURRENT_TIMESTAMP;

      UPDATE feature_flag_role_rules
      SET reason = 'Regra preservada na cópia sanitizada.',
          updated_at = CURRENT_TIMESTAMP;
    `);

    redactTypedQuestionDefinitions(db);
    redactAllTextColumns(db);

    db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Administrador Smoke Test', ?, ?, 'admin')
    `).run(options.adminEmail, smokeAdminHash);

    db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Professor Smoke Test', ?, ?, 'professor')
    `).run(options.professorEmail, smokeProfessorHash);

    db.exec(`
      CREATE TABLE homologation_snapshot_metadata (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        sanitized INTEGER NOT NULL CHECK(sanitized = 1),
        sanitizer_version TEXT NOT NULL,
        source_schema_version INTEGER NOT NULL,
        sanitized_at DATETIME NOT NULL
      );
    `);

    db.prepare(`
      INSERT INTO homologation_snapshot_metadata (
        id,
        sanitized,
        sanitizer_version,
        source_schema_version,
        sanitized_at
      ) VALUES (1, 1, ?, ?, ?)
    `).run(SANITIZER_VERSION, sourceSchemaVersion, new Date().toISOString());

    recreateGovernanceAuditProtection(db);
    recreateInstitutionalProtection(db);
    recreateEntryCodeRedemptionProtection(db);
    recreateAssessmentDeleteProtection(db);
    recreateTypedQuestionProtection(db);
    recreatePedagogicalPlanningDeleteProtection(db);
    db.exec(`CREATE TRIGGER pedagogical_feedback_prevent_delete
      BEFORE DELETE ON pedagogical_feedback_versions
      BEGIN SELECT RAISE(ABORT, 'Feedback revisions are immutable'); END;`);
  })();

  return { sourceCounts, sourceSchemaVersion };
}

function scanForEmailAddresses(db) {
  const findings = [];
  const emailPattern = /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i;

  for (const tableName of listUserTables(db)) {
    const textColumns = db.pragma(`table_info(${quoteIdentifier(tableName)})`)
      .filter(({ type }) => /TEXT|CHAR|CLOB/i.test(type || ''))
      .map(({ name }) => name);

    if (textColumns.length === 0) continue;
    const rows = db.prepare(`
      SELECT rowid AS __rowid, ${textColumns.map(quoteIdentifier).join(', ')}
      FROM ${quoteIdentifier(tableName)}
    `).all();

    for (const row of rows) {
      for (const columnName of textColumns) {
        const value = row[columnName];
        if (typeof value !== 'string' || !emailPattern.test(value)) continue;
        emailPattern.lastIndex = 0;
        if (value.includes('@homologacao.invalid')) continue;
        findings.push(`${tableName}.${columnName}#${row.__rowid}`);
      }
    }
  }

  return findings;
}

function verifySanitizedDatabase(db, options) {
  const integrityCheck = db.pragma('integrity_check', { simple: true });
  const foreignKeyViolations = db.pragma('foreign_key_check').length;
  assert(integrityCheck === 'ok', 'A cópia sanitizada falhou no integrity_check.');
  assert(foreignKeyViolations === 0, 'A cópia sanitizada possui violações de chave estrangeira.');

  const metadata = db.prepare(`
    SELECT sanitized, sanitizer_version, source_schema_version
    FROM homologation_snapshot_metadata
    WHERE id = 1
  `).get();
  assert(metadata?.sanitized === 1, 'A marca obrigatória de sanitização não foi criada.');

  for (const tableName of EMPTY_SENSITIVE_TABLES) {
    const count = db.prepare(`SELECT COUNT(*) FROM ${quoteIdentifier(tableName)}`).pluck().get();
    assert(count === 0, `A tabela sensível ${tableName} não foi esvaziada.`);
  }

  const nonHomologationUsers = db.prepare(`
    SELECT COUNT(*)
    FROM users
    WHERE email NOT LIKE '%@homologacao.invalid'
  `).pluck().get();
  assert(nonHomologationUsers === 0, 'Ainda existem e-mails de usuários fora do domínio inválido.');

  const admin = db.prepare('SELECT password, role FROM users WHERE email = ?').get(options.adminEmail);
  const professor = db.prepare('SELECT password, role FROM users WHERE email = ?').get(options.professorEmail);
  assert(admin?.role === 'admin', 'A conta administrativa de smoke test não foi criada.');
  assert(professor?.role === 'professor', 'A conta de professor de smoke test não foi criada.');
  assert(bcrypt.compareSync(options.adminPassword, admin.password), 'Senha administrativa inválida.');
  assert(bcrypt.compareSync(options.professorPassword, professor.password), 'Senha do professor inválida.');

  const unsafeFlags = db.prepare(`
    SELECT COUNT(*)
    FROM feature_flags
    WHERE master_enabled != 0
       OR default_enabled != 0
       OR rollout_percentage != 0
       OR kill_switch_active != 1
  `).pluck().get();
  assert(unsafeFlags === 0, 'Uma ou mais feature flags ficaram liberadas na homologação.');
  assert(
    db.prepare('SELECT COUNT(*) FROM pilot_groups WHERE active != 0').pluck().get() === 0,
    'Um ou mais grupos-piloto permaneceram ativos.'
  );

  const emailFindings = scanForEmailAddresses(db);
  assert(
    emailFindings.length === 0,
    `Foram encontrados possíveis e-mails fora da política: ${emailFindings.join(', ')}.`
  );

  return {
    integrityCheck,
    foreignKeyViolations,
    users: db.prepare('SELECT COUNT(*) FROM users').pluck().get(),
    schemaVersion: db.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations').pluck().get(),
    sanitizerVersion: metadata.sanitizer_version,
  };
}

function normalizeOptions(options) {
  const sourcePath = path.resolve(options.sourcePath || '');
  const outputPath = path.resolve(options.outputPath || '');
  const adminEmail = String(options.adminEmail || 'smoke.admin@homologacao.invalid').trim().toLowerCase();
  const professorEmail = String(options.professorEmail || 'smoke.professor@homologacao.invalid').trim().toLowerCase();

  assert(options.confirmation === CONFIRMATION, 'Confirmação explícita de sanitização ausente.');
  assert(fs.existsSync(sourcePath) && fs.statSync(sourcePath).isFile(), 'Banco de origem não encontrado.');
  assert(sourcePath !== outputPath, 'Origem e destino da sanitização devem ser diferentes.');
  assert(HOMOLOGATION_PATH_PATTERN.test(outputPath), 'O destino deve conter homolog ou staging no caminho.');
  assert(options.adminPassword?.length >= 16, 'A senha administrativa de homologação deve ter 16 caracteres ou mais.');
  assert(options.professorPassword?.length >= 16, 'A senha do professor de homologação deve ter 16 caracteres ou mais.');
  assert(adminEmail.endsWith('@homologacao.invalid'), 'O e-mail administrativo deve usar @homologacao.invalid.');
  assert(professorEmail.endsWith('@homologacao.invalid'), 'O e-mail do professor deve usar @homologacao.invalid.');
  assert(adminEmail !== professorEmail, 'As contas de smoke test devem possuir e-mails diferentes.');

  if (fs.existsSync(outputPath)) {
    assert(!fs.lstatSync(outputPath).isSymbolicLink(), 'O destino não pode ser um link simbólico.');
    assert(fs.realpathSync(sourcePath) !== fs.realpathSync(outputPath),
      'Origem e destino apontam para o mesmo arquivo real.');
    assert(options.replaceOutput === true, 'O destino já existe; use --replace-output de forma explícita.');
    assert(!fs.existsSync(`${outputPath}-wal`) && !fs.existsSync(`${outputPath}-shm`),
      'O destino possui WAL/SHM. Pare a homologação e faça checkpoint antes de substituir.');
    assert(!fs.existsSync(`${outputPath}.previous`),
      'Já existe um rollback .previous; arquive-o antes de nova substituição.');
  }

  return {
    ...options,
    sourcePath,
    outputPath,
    adminEmail,
    professorEmail,
  };
}

async function createSanitizedDatabase(inputOptions) {
  const options = normalizeOptions(inputOptions);
  const outputDirectory = path.dirname(options.outputPath);
  fs.mkdirSync(outputDirectory, { recursive: true });
  assert(
    HOMOLOGATION_PATH_PATTERN.test(fs.realpathSync(outputDirectory)),
    'O diretório real de destino deve permanecer no espaço de homologação.'
  );

  const tempPath = path.join(
    outputDirectory,
    `.homologation-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}.sqlite`
  );
  const manifestPath = options.manifestPath
    ? path.resolve(options.manifestPath)
    : `${options.outputPath}.manifest.json`;
  assert(HOMOLOGATION_PATH_PATTERN.test(manifestPath), 'O manifesto deve permanecer no espaço de homologação.');
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  assert(
    HOMOLOGATION_PATH_PATTERN.test(fs.realpathSync(path.dirname(manifestPath))),
    'O diretório real do manifesto deve permanecer no espaço de homologação.'
  );

  let sourceDb;
  let sanitizedDb;
  let replacementBackup = null;

  try {
    sourceDb = new Database(options.sourcePath, { readonly: true, fileMustExist: true });
    await sourceDb.backup(tempPath);
    sourceDb.close();
    sourceDb = null;

    sanitizedDb = new Database(tempPath);
    sanitizedDb.pragma('foreign_keys = ON');
    // The private copy's professional receipts are cleared during sanitization.
    runMigrations(sanitizedDb, { logger: silentLogger, institutionalFingerprintSecret: crypto.randomBytes(32).toString('hex') });
    assertKnownSchema(sanitizedDb);

    const sanitization = sanitizeCopy(sanitizedDb, options);
    const verification = verifySanitizedDatabase(sanitizedDb, options);
    sanitizedDb.pragma('journal_mode = DELETE');
    sanitizedDb.exec('VACUUM');
    sanitizedDb.close();
    sanitizedDb = null;

    if (fs.existsSync(options.outputPath)) {
      replacementBackup = `${options.outputPath}.previous`;
      fs.renameSync(options.outputPath, replacementBackup);
    }

    try {
      fs.renameSync(tempPath, options.outputPath);
    } catch (error) {
      if (replacementBackup && !fs.existsSync(options.outputPath)) {
        fs.renameSync(replacementBackup, options.outputPath);
      }
      throw error;
    }

    fs.chmodSync(options.outputPath, 0o600);
    const report = {
      status: 'sanitized',
      sanitizerVersion: SANITIZER_VERSION,
      createdAt: new Date().toISOString(),
      source: {
        schemaVersion: sanitization.sourceSchemaVersion,
        tableCount: EXPECTED_TABLES.size,
        counts: sanitization.sourceCounts,
      },
      output: {
        sha256: sha256(options.outputPath),
        bytes: fs.statSync(options.outputPath).size,
        previousSnapshotPreserved: Boolean(replacementBackup),
      },
      verification,
      safety: {
        sourceOpenedReadOnly: true,
        destinationExplicitlyNamedForHomologation: true,
        sensitiveOperationalTablesCleared: true,
        featureFlagsDisabled: true,
        realEmailDeliveryDisabledByEnvironmentPolicy: true,
      },
    };

    fs.writeFileSync(manifestPath, `${JSON.stringify(report, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    return report;
  } finally {
    if (sourceDb?.open) sourceDb.close();
    if (sanitizedDb?.open) sanitizedDb.close();
    if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true });
  }
}

function parseCliArguments(argv) {
  const args = new Map();
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--replace-output') {
      args.set('replaceOutput', true);
      continue;
    }
    if (!argument.startsWith('--')) throw new Error(`Argumento inválido: ${argument}`);
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new Error(`Valor ausente para ${argument}.`);
    args.set(argument.slice(2), value);
    index += 1;
  }

  return {
    sourcePath: args.get('source'),
    outputPath: args.get('output'),
    manifestPath: args.get('manifest'),
    replaceOutput: args.get('replaceOutput') === true,
    confirmation: process.env.HOMOLOGATION_SANITIZE_CONFIRM,
    adminEmail: process.env.HOMOLOGATION_ADMIN_EMAIL,
    adminPassword: process.env.HOMOLOGATION_ADMIN_PASSWORD,
    professorEmail: process.env.HOMOLOGATION_PROFESSOR_EMAIL,
    professorPassword: process.env.HOMOLOGATION_PROFESSOR_PASSWORD,
  };
}

if (require.main === module) {
  createSanitizedDatabase(parseCliArguments(process.argv.slice(2)))
    .then((report) => {
      console.log(JSON.stringify(report, null, 2));
    })
    .catch((error) => {
      console.error(JSON.stringify({ status: 'failed', error: error.message }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  CONFIRMATION,
  EXPECTED_TABLES,
  createSanitizedDatabase,
  verifySanitizedDatabase,
};
