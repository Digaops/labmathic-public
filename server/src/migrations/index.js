const crypto = require('crypto');

const defaultMigrations = [
  require('./001_baseline_current_schema'),
  require('./002_release_governance_and_feature_flags'),
  require('./003_classes_and_students_foundation'),
  require('./004_class_assessment_assignments_foundation'),
  require('./005_teacher_grade_preferences'),
  require('./006_class_assessment_objective_results'),
  require('./007_diagnostic_question_sets'),
  require('./008_student_online_assessment_access'),
  require('./009_diagnostic_teacher_review'),
  require('./010_learning_recovery_and_lesson_planning_foundation'),
  require('./011_balanced_assessment_answer_keys'),
  require('./012_learning_recovery_execution'),
  require('./013_learning_recovery_monitoring_cycle'),
  require('./014_learning_recovery_cross_grade_skills'),
  require('./015_lesson_planner_application'),
  require('./016_institutional_foundation'),
  require('./017_typed_question_engine_foundation'),
  require('./018_typed_question_authoring_workflow'),
  require('./019_institutional_read_model'),
  require('./020_typed_question_preview'),
  require('./021_typed_question_feedback_preview'),
  require('./022_question_bank_catalog_preview'),
  require('./023_institutional_management_pilot'),
  require('./024_institutional_official_directories'),
  require('./025_access_and_material_safety'),
  require('./026_operational_pedagogical_cycle'),
  require('./027_material_management_operations'),
  require('./028_material_drafts'),
  require('./029_material_bncc_curation'),
  require('./030_assessment_exemptions'),
  require('./031_municipal_indicators'),
  require('./032_ai_authoring_pilot'),
  require('./033_ai_usage_foundation'),
  require('./034_content_issue_review'),
  require('./035_school_coordination'),
  require('./036_student_feedback_release'),
  require('./037_numeric_authoring_drafts'),
  require('./038_numeric_editorial_workflow'),
  require('./039_numeric_class_assessments'),
  require('./040_protect_institutional_professional_receipts'),
  require('./041_question_set_creation_receipts'),
  require('./042_question_editorial_curation'),
  require('./043_question_editorial_challenges'),
];

const CREATE_MIGRATIONS_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    description TEXT,
    execution_ms INTEGER NOT NULL DEFAULT 0,
    applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`;

function calculateChecksum(migration) {
  return crypto
    .createHash('sha256')
    .update([
      String(migration.version),
      migration.name,
      migration.description || '',
      migration.up.toString(),
    ].join('\n'))
    .digest('hex');
}

function validateMigrations(migrations) {
  const versions = new Set();
  const names = new Set();
  let previousVersion = 0;

  for (const migration of migrations) {
    if (!Number.isInteger(migration.version) || migration.version < 1) {
      throw new Error('Toda migracao deve possuir uma versao inteira positiva.');
    }

    if (!migration.name || typeof migration.name !== 'string') {
      throw new Error(`A migracao ${migration.version} deve possuir um nome.`);
    }

    if (typeof migration.up !== 'function') {
      throw new Error(`A migracao ${migration.version} deve implementar up(db).`);
    }

    if (versions.has(migration.version)) {
      throw new Error(`Versao de migracao duplicada: ${migration.version}.`);
    }

    if (names.has(migration.name)) {
      throw new Error(`Nome de migracao duplicado: ${migration.name}.`);
    }

    if (migration.version <= previousVersion) {
      throw new Error('As migracoes devem estar em ordem crescente de versao.');
    }

    versions.add(migration.version);
    names.add(migration.name);
    previousVersion = migration.version;
  }
}

function hasMigrationsTable(db) {
  return Boolean(db.prepare(`
    SELECT 1
    FROM sqlite_master
    WHERE type = 'table' AND name = 'schema_migrations'
  `).get());
}

function listAppliedMigrations(db) {
  if (!hasMigrationsTable(db)) return [];

  return db.prepare(`
    SELECT version, name, checksum, description, execution_ms, applied_at
    FROM schema_migrations
    ORDER BY version ASC
  `).all();
}

function inspectMigrations(db, migrations = defaultMigrations) {
  validateMigrations(migrations);

  const applied = listAppliedMigrations(db);
  const declaredByVersion = new Map(
    migrations.map((migration) => [migration.version, migration])
  );
  const appliedByVersion = new Map(
    applied.map((migration) => [migration.version, migration])
  );

  const unknown = applied.filter(
    (migration) => !declaredByVersion.has(migration.version)
  );
  const changed = applied
    .filter((migration) => declaredByVersion.has(migration.version))
    .filter((migration) => {
      const declared = declaredByVersion.get(migration.version);
      return migration.name !== declared.name
        || migration.checksum !== calculateChecksum(declared);
    });
  const pending = migrations
    .filter((migration) => !appliedByVersion.has(migration.version))
    .map((migration) => ({
      version: migration.version,
      name: migration.name,
      description: migration.description || null,
      checksum: calculateChecksum(migration),
    }));

  return {
    initialized: hasMigrationsTable(db),
    applied,
    pending,
    changed,
    unknown,
  };
}

function assertMigrationHistory(status) {
  if (status.unknown.length > 0) {
    const versions = status.unknown.map((migration) => migration.version).join(', ');
    throw new Error(
      `O banco possui migracoes desconhecidas por esta versao do codigo: ${versions}.`
    );
  }

  if (status.changed.length > 0) {
    const versions = status.changed.map((migration) => migration.version).join(', ');
    throw new Error(
      `Migracoes ja aplicadas foram alteradas: ${versions}. Crie uma nova migracao em vez de editar o historico.`
    );
  }
}

function runMigrations(db, options = {}) {
  const migrations = options.migrations || defaultMigrations;
  const logger = options.logger || console;

  validateMigrations(migrations);
  db.exec(CREATE_MIGRATIONS_TABLE_SQL);

  let status = inspectMigrations(db, migrations);
  assertMigrationHistory(status);

  const appliedNow = [];

  for (const pending of status.pending) {
    const migration = migrations.find((item) => item.version === pending.version);
    const startedAt = Date.now();

    const applyMigration = db.transaction(() => {
      migration.up(db, options);

      const executionMs = Date.now() - startedAt;
      db.prepare(`
        INSERT INTO schema_migrations (
          version,
          name,
          checksum,
          description,
          execution_ms
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        migration.version,
        migration.name,
        pending.checksum,
        migration.description || null,
        executionMs
      );

      return executionMs;
    });

    const executionMs = applyMigration();
    appliedNow.push({
      version: migration.version,
      name: migration.name,
      executionMs,
    });

    if (typeof logger.info === 'function') {
      logger.info(
        `[database] Migracao ${migration.version} (${migration.name}) aplicada em ${executionMs}ms.`
      );
    }
  }

  status = inspectMigrations(db, migrations);
  assertMigrationHistory(status);

  return {
    ...status,
    appliedNow,
  };
}

module.exports = {
  calculateChecksum,
  inspectMigrations,
  runMigrations,
};
