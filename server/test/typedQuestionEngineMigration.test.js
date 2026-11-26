const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration004 = require('../src/migrations/004_class_assessment_assignments_foundation');
const migration017 = require('../src/migrations/017_typed_question_engine_foundation');
const { compileTypedQuestionDefinition } = require('../src/services/typedQuestionEngine');

function createPreTypedDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professor', 'admin'))
    );
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
      description TEXT,
      is_public INTEGER DEFAULT 0,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );
    CREATE TABLE bncc_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL
    );
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER,
      statement TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'multiple_choice',
      official_explanation TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      reviewed INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (skill_id) REFERENCES bncc_skills(id) ON DELETE SET NULL
    );
    CREATE TABLE question_options (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_id INTEGER NOT NULL,
      option_label TEXT NOT NULL CHECK(option_label IN ('A', 'B', 'C', 'D')),
      option_text TEXT NOT NULL,
      is_correct INTEGER NOT NULL DEFAULT 0,
      sort_order INTEGER DEFAULT 0,
      UNIQUE(question_id, option_label),
      FOREIGN KEY (question_id) REFERENCES questions(id) ON DELETE CASCADE
    );
  `);
  migration002.up(db);
  migration003.up(db);
  migration004.up(db);
  return db;
}

function seedLegacy(db) {
  const teacherId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professora Aurora', 'aurora@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const reviewerId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Revisor Pedagogico', 'revisor@teste.local', 'hash', 'admin')
  `).run().lastInsertRowid;
  const gradeId = db.prepare("INSERT INTO grades (name) VALUES ('7o Ano')")
    .run().lastInsertRowid;
  const skillId = db.prepare(`
    INSERT INTO bncc_skills (code, description)
    VALUES ('EF07MA01', 'Resolver problemas com números inteiros')
  `).run().lastInsertRowid;
  const questionId = db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, official_explanation, reviewed
    ) VALUES (
      'EF07MA01-Q001', ?, 'Quanto é 12 dividido por 3?', 'Divida em grupos iguais.', 1
    )
  `).run(skillId).lastInsertRowid;
  for (const [index, text] of ['2', '3', '4', '6'].entries()) {
    db.prepare(`
      INSERT INTO question_options (
        question_id, option_label, option_text, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?)
    `).run(questionId, ['A', 'B', 'C', 'D'][index], text, index === 2 ? 1 : 0, index);
  }
  const questionSetId = db.prepare(`
    INSERT INTO question_sets (user_id, title) VALUES (?, 'Diagnóstico inicial')
  `).run(teacherId).lastInsertRowid;
  const classId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('typed-engine-class-0001', ?, 'Turma Aurora', ?, 2026, ?)
  `).run(teacherId, gradeId, teacherId).lastInsertRowid;

  return { teacherId, reviewerId, gradeId, skillId, questionId, questionSetId, classId };
}

function choiceDefinition(stem = 'Quanto é 12 dividido por 3?') {
  return compileTypedQuestionDefinition({
    interactionType: 'single_choice',
    content: {
      stem,
      supportText: null,
      choices: [
        { id: 'answer_two', text: '2' },
        { id: 'answer_three', text: '3' },
        { id: 'answer_four', text: '4' },
        { id: 'answer_six', text: '6' },
      ],
    },
    scoring: { strategy: 'exact', partialCredit: false },
    answerKey: { choiceId: 'answer_four' },
    accessibility: {
      responseLabel: 'Alternativa da questão',
      instructions: 'Escolha uma alternativa.',
    },
    print: {
      supported: true,
      layout: 'choice_list',
      instructions: 'Marque uma alternativa.',
      answerSpaceLines: 0,
    },
    feedback: {
      releasePolicy: 'after_assessment_close',
      general: 'Confira a divisão.',
      correct: 'Correto.',
      incorrect: 'Represente os grupos.',
      choiceFeedback: {},
    },
  });
}

function insertTypedItem(db, fixtures, suffix = '0001') {
  return db.prepare(`
    INSERT INTO typed_question_items (
      public_id, question_id, created_by, updated_by
    ) VALUES (?, ?, ?, ?)
  `).run(
    `typed-item-public-${suffix.padEnd(8, '0')}`,
    fixtures.questionId,
    fixtures.teacherId,
    fixtures.teacherId,
  ).lastInsertRowid;
}

function insertVersion(db, fixtures, itemId, compiled, version = 1) {
  const metadata = compiled.metadata;
  return db.prepare(`
    INSERT INTO typed_question_item_versions (
      public_id, item_id, version, engine_version, format_version,
      interaction_type, correction_mode, scoring_strategy, partial_credit,
      accessibility_ready, print_supported, definition_json, definition_hash,
      created_by, updated_by
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    `typed-version-${String(itemId).padStart(4, '0')}-${String(version).padStart(4, '0')}`,
    itemId,
    version,
    metadata.engineVersion,
    metadata.formatVersion,
    metadata.interactionType,
    metadata.correctionMode,
    metadata.scoringStrategy,
    metadata.partialCredit ? 1 : 0,
    metadata.accessibilityReady ? 1 : 0,
    metadata.printSupported ? 1 : 0,
    compiled.definitionJson,
    compiled.definitionHash,
    fixtures.teacherId,
    fixtures.teacherId,
  ).lastInsertRowid;
}

function publishVersion(db, fixtures, versionId) {
  db.prepare(`
    UPDATE typed_question_item_versions
    SET status = 'published',
        revision = revision + 1,
        updated_by = ?,
        published_by = ?,
        published_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fixtures.reviewerId, fixtures.reviewerId, versionId);
}

function activateItem(db, fixtures, itemId, versionId) {
  db.prepare(`
    INSERT INTO typed_question_current_versions (
      item_id, version_id, activated_by
    ) VALUES (?, ?, ?)
  `).run(itemId, versionId, fixtures.reviewerId);
  db.prepare(`
    UPDATE typed_question_items
    SET status = 'active', revision = revision + 1,
        updated_by = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(fixtures.reviewerId, itemId);
}

test('migração 017 é aditiva, preserva questões legadas e nasce desligada', () => {
  const db = createPreTypedDatabase();
  try {
    seedLegacy(db);
    const questionsBefore = db.prepare('SELECT * FROM questions ORDER BY id').all();
    const optionsBefore = db.prepare('SELECT * FROM question_options ORDER BY id').all();
    const questionColumnsBefore = db.pragma('table_info(questions)');

    migration017.up(db);

    assert.deepEqual(db.prepare('SELECT * FROM questions ORDER BY id').all(), questionsBefore);
    assert.deepEqual(db.prepare('SELECT * FROM question_options ORDER BY id').all(), optionsBefore);
    assert.deepEqual(db.pragma('table_info(questions)'), questionColumnsBefore);

    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(({ name }) => name));
    for (const tableName of [
      'typed_question_items',
      'typed_question_item_versions',
      'typed_question_current_versions',
      'class_assessment_typed_item_snapshots',
      'typed_question_audit_log',
    ]) {
      assert.equal(tables.has(tableName), true, `${tableName} deveria existir`);
      assert.equal(db.prepare(`SELECT COUNT(*) AS total FROM ${tableName}`).get().total, 0);
    }

    assert.deepEqual(db.prepare(`
      SELECT version, status FROM product_releases WHERE version = '2.2.0'
    `).get(), { version: '2.2.0', status: 'draft' });
    assert.deepEqual(db.prepare(`
      SELECT flag_key, master_enabled, default_enabled, rollout_percentage,
        kill_switch_active
      FROM feature_flags
      WHERE flag_key = 'question_bank.typed_engine'
    `).get(), {
      flag_key: 'question_bank.typed_engine',
      master_enabled: 0,
      default_enabled: 0,
      rollout_percentage: 0,
      kill_switch_active: 0,
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('publicação e ativação exigem sequência válida, revisão e conteúdo congelado', () => {
  const db = createPreTypedDatabase();
  try {
    const fixtures = seedLegacy(db);
    migration017.up(db);
    const compiled = choiceDefinition();
    const itemId = insertTypedItem(db, fixtures);

    assert.throws(() => insertVersion(db, fixtures, itemId, compiled, 2), {
      message: /typed_question_version_must_be_sequential/,
    });
    const versionId = insertVersion(db, fixtures, itemId, compiled, 1);
    assert.throws(() => db.prepare(`
      UPDATE typed_question_items
      SET status = 'active', revision = 2, updated_by = ?
      WHERE id = ?
    `).run(fixtures.reviewerId, itemId), {
      message: /typed_question_item_requires_published_current_version/,
    });

    publishVersion(db, fixtures, versionId);
    activateItem(db, fixtures, itemId, versionId);
    assert.deepEqual(db.prepare(`
      SELECT status, revision FROM typed_question_items WHERE id = ?
    `).get(itemId), { status: 'active', revision: 2 });

    assert.throws(() => db.prepare(`
      UPDATE typed_question_item_versions
      SET definition_json = ?, revision = revision + 1, updated_by = ?
      WHERE id = ?
    `).run(choiceDefinition('Enunciado alterado').definitionJson, fixtures.reviewerId, versionId), {
      message: /published_typed_question_version_is_immutable/,
    });
    assert.throws(() => db.prepare(`
      UPDATE typed_question_item_versions
      SET published_by = ?, revision = revision + 1, updated_by = ?
      WHERE id = ?
    `).run(fixtures.teacherId, fixtures.teacherId, versionId), {
      message: /typed_question_version_lifecycle_metadata_is_immutable/,
    });
    assert.throws(() => db.prepare(`
      DELETE FROM typed_question_item_versions WHERE id = ?
    `).run(versionId), { message: /typed_question_version_cannot_be_deleted/ });
    assert.throws(() => db.prepare(`
      UPDATE typed_question_items
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(itemId), { message: /typed_question_item_revision_must_increment/ });

    assert.deepEqual(db.prepare(`
      SELECT action, previous_value, current_value
      FROM typed_question_audit_log
      WHERE item_id = ?
      ORDER BY id
    `).all(itemId), [
      { action: 'item_created', previous_value: null, current_value: 'draft' },
      { action: 'version_created', previous_value: null, current_value: '1' },
      { action: 'version_published', previous_value: 'draft', current_value: 'published' },
      { action: 'current_version_activated', previous_value: null, current_value: String(versionId) },
      { action: 'item_status_changed', previous_value: 'draft', current_value: 'active' },
    ]);
    assert.throws(() => db.prepare(`
      DELETE FROM typed_question_audit_log WHERE item_id = ?
    `).run(itemId), { message: /typed_question_audit_log_is_immutable/ });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('troca de versão é explícita e nunca permite aposentar a versão corrente', () => {
  const db = createPreTypedDatabase();
  try {
    const fixtures = seedLegacy(db);
    migration017.up(db);
    const itemId = insertTypedItem(db, fixtures);
    const versionOneId = insertVersion(db, fixtures, itemId, choiceDefinition(), 1);
    publishVersion(db, fixtures, versionOneId);
    activateItem(db, fixtures, itemId, versionOneId);

    const versionTwoId = insertVersion(
      db,
      fixtures,
      itemId,
      choiceDefinition('Quanto é 18 dividido por 6?'),
      2,
    );
    publishVersion(db, fixtures, versionTwoId);
    db.prepare(`
      UPDATE typed_question_current_versions
      SET version_id = ?, revision = revision + 1,
          activated_by = ?, activated_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE item_id = ?
    `).run(versionTwoId, fixtures.reviewerId, itemId);

    db.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'retired', revision = revision + 1,
          updated_by = ?, retired_by = ?, retired_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixtures.reviewerId, fixtures.reviewerId, versionOneId);
    assert.throws(() => db.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'retired', revision = revision + 1,
          updated_by = ?, retired_by = ?, retired_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixtures.reviewerId, fixtures.reviewerId, versionTwoId), {
      message: /current_typed_question_version_cannot_be_retired/,
    });
    assert.deepEqual(db.prepare(`
      SELECT version_id, revision FROM typed_question_current_versions WHERE item_id = ?
    `).get(itemId), { version_id: versionTwoId, revision: 2 });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('snapshot copia somente a versão corrente e congela a avaliação fora do rascunho', () => {
  const db = createPreTypedDatabase();
  try {
    const fixtures = seedLegacy(db);
    migration017.up(db);
    const compiled = choiceDefinition();
    const itemId = insertTypedItem(db, fixtures);
    const versionId = insertVersion(db, fixtures, itemId, compiled, 1);
    publishVersion(db, fixtures, versionId);
    activateItem(db, fixtures, itemId, versionId);

    const assignmentId = db.prepare(`
      INSERT INTO class_assessment_assignments (
        public_id, class_id, owner_teacher_id, source_question_set_id,
        title_snapshot, snapshot_hash, question_count, created_by, updated_by
      ) VALUES (
        'typed-assignment-public-01', ?, ?, ?,
        'Diagnóstico inicial', ?, 1, ?, ?
      )
    `).run(
      fixtures.classId,
      fixtures.teacherId,
      fixtures.questionSetId,
      'a'.repeat(64),
      fixtures.teacherId,
      fixtures.teacherId,
    ).lastInsertRowid;
    const assessmentItemId = db.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id, source_question_id,
        source_skill_id, question_code_snapshot, skill_code_snapshot,
        skill_description_snapshot, statement_snapshot, difficulty_snapshot,
        question_type_snapshot, sort_order
      ) VALUES (?, ?, ?, ?, ?, 'EF07MA01-Q001', 'EF07MA01', ?, ?, 'media',
        'multiple_choice', 0)
    `).run(
      assignmentId,
      fixtures.classId,
      fixtures.teacherId,
      fixtures.questionId,
      fixtures.skillId,
      'Resolver problemas com números inteiros',
      'Quanto é 12 dividido por 3?',
    ).lastInsertRowid;

    const insertSnapshot = db.prepare(`
      INSERT INTO class_assessment_typed_item_snapshots (
        assessment_item_id, typed_item_id, typed_version_id,
        engine_version, format_version, interaction_type, correction_mode,
        scoring_strategy, partial_credit, definition_json, definition_hash
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    assert.throws(() => insertSnapshot.run(
      assessmentItemId,
      itemId,
      versionId,
      compiled.metadata.engineVersion,
      compiled.metadata.formatVersion,
      compiled.metadata.interactionType,
      compiled.metadata.correctionMode,
      compiled.metadata.scoringStrategy,
      0,
      compiled.definitionJson,
      'b'.repeat(64),
    ), { message: /invalid_typed_question_assessment_snapshot/ });

    insertSnapshot.run(
      assessmentItemId,
      itemId,
      versionId,
      compiled.metadata.engineVersion,
      compiled.metadata.formatVersion,
      compiled.metadata.interactionType,
      compiled.metadata.correctionMode,
      compiled.metadata.scoringStrategy,
      0,
      compiled.definitionJson,
      compiled.definitionHash,
    );
    assert.throws(() => db.prepare(`
      UPDATE class_assessment_typed_item_snapshots
      SET definition_hash = ? WHERE assessment_item_id = ?
    `).run('c'.repeat(64), assessmentItemId), {
      message: /typed_question_assessment_snapshot_is_immutable/,
    });
    db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'cancelled', cancelled_at = CURRENT_TIMESTAMP,
          revision = revision + 1, updated_by = ?
      WHERE id = ?
    `).run(fixtures.teacherId, assignmentId);
    assert.throws(() => db.prepare(`
      DELETE FROM class_assessment_typed_item_snapshots WHERE assessment_item_id = ?
    `).run(assessmentItemId), {
      message: /published_typed_question_snapshot_is_immutable/,
    });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
