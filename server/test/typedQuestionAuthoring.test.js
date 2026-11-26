const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration017 = require('../src/migrations/017_typed_question_engine_foundation');
const migration018 = require('../src/migrations/018_typed_question_authoring_workflow');
const {
  activateTypedVersion,
  adoptTypedQuestion,
  cancelTypedReview,
  createNextTypedVersion,
  decideTypedReview,
  getTypedAuthoringState,
  listTypedReviewQueue,
  submitTypedReview,
  updateTypedDraft,
} = require('../src/services/typedQuestionAuthoring');

function createDatabase() {
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
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      question_code TEXT NOT NULL UNIQUE,
      skill_id INTEGER,
      statement TEXT NOT NULL,
      question_type TEXT NOT NULL DEFAULT 'multiple_choice',
      official_explanation TEXT,
      status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'inactive')),
      reviewed INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'official',
      created_by INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE TABLE class_assessment_items (id INTEGER PRIMARY KEY AUTOINCREMENT);
  `);
  migration002.up(db);
  migration017.up(db);
  migration018.up(db);
  return db;
}

function seed(db) {
  const addUser = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash', ?)
  `);
  const authorId = addUser.run('Professora Autora', 'autora@teste.local', 'professor')
    .lastInsertRowid;
  const otherTeacherId = addUser.run(
    'Professor Externo',
    'externo@teste.local',
    'professor',
  ).lastInsertRowid;
  const reviewerId = addUser.run('Revisora Um', 'revisora@teste.local', 'admin')
    .lastInsertRowid;
  const secondReviewerId = addUser.run('Revisor Dois', 'revisor2@teste.local', 'admin')
    .lastInsertRowid;
  const addQuestion = db.prepare(`
    INSERT INTO questions (
      question_code, skill_id, statement, source, created_by, status
    ) VALUES (?, 7, ?, ?, ?, 'active')
  `);
  const questionId = addQuestion.run(
    'AUT-QUESTION-001',
    'Quanto é três vezes quatro?',
    'teacher',
    authorId,
  ).lastInsertRowid;
  const otherQuestionId = addQuestion.run(
    'AUT-QUESTION-002',
    'Quanto é cinco vezes cinco?',
    'teacher',
    otherTeacherId,
  ).lastInsertRowid;
  const officialQuestionId = addQuestion.run(
    'OFFICIAL-QUESTION-001',
    'Questão oficial.',
    'official',
    reviewerId,
  ).lastInsertRowid;
  return {
    authorId,
    otherTeacherId,
    reviewerId,
    secondReviewerId,
    questionId,
    otherQuestionId,
    officialQuestionId,
  };
}

function enableFor(db, ...userIds) {
  const flag = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'question_bank.typed_engine'
  `).get();
  db.prepare(`
    UPDATE feature_flags SET master_enabled = 1 WHERE id = ?
  `).run(flag.id);
  const insert = db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason
    ) VALUES (?, ?, 1, 'Usuário sintético autorizado para teste isolado')
  `);
  for (const userId of userIds) insert.run(flag.id, userId);
}

function choiceDefinition(stem = 'Quanto é três vezes quatro?') {
  return {
    interactionType: 'single_choice',
    content: {
      stem,
      supportText: null,
      choices: [
        { id: 'answer_ten', text: '10' },
        { id: 'answer_twelve', text: '12' },
        { id: 'answer_fourteen', text: '14' },
      ],
    },
    scoring: { strategy: 'exact', partialCredit: false },
    answerKey: { choiceId: 'answer_twelve' },
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
      general: 'Represente a multiplicação.',
      correct: 'A estratégia está correta.',
      incorrect: 'Confira os grupos iguais.',
      choiceFeedback: {},
    },
  };
}

function key(label) {
  return `typed-authoring-${label}-2026-0001`;
}

function adopt(db, fixtures, suffix = 'adopt') {
  return adoptTypedQuestion(db, {
    actor: { id: fixtures.authorId, role: 'admin' },
    questionId: fixtures.questionId,
    definition: choiceDefinition(),
    idempotencyKey: key(suffix),
  });
}

test('migração 018 é aditiva e bloqueia publicação sem revisão independente', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    const questionsBefore = db.prepare('SELECT * FROM questions ORDER BY id').all();
    const tables = new Set(db.prepare(`
      SELECT name FROM sqlite_master WHERE type = 'table'
    `).all().map(({ name }) => name));
    assert.equal(tables.has('typed_question_review_cycles'), true);
    assert.equal(tables.has('typed_question_write_operations'), true);
    assert.deepEqual(db.prepare('SELECT * FROM questions ORDER BY id').all(), questionsBefore);

    const itemId = db.prepare(`
      INSERT INTO typed_question_items (
        public_id, question_id, created_by, updated_by
      ) VALUES ('migration-review-item-001', ?, ?, ?)
    `).run(fixtures.questionId, fixtures.authorId, fixtures.authorId).lastInsertRowid;
    const definition = require('../src/services/typedQuestionEngine')
      .compileTypedQuestionDefinition(choiceDefinition());
    const versionId = db.prepare(`
      INSERT INTO typed_question_item_versions (
        public_id, item_id, version, interaction_type, correction_mode,
        scoring_strategy, partial_credit, accessibility_ready, print_supported,
        definition_json, definition_hash, created_by, updated_by
      ) VALUES (
        'migration-review-version-1', ?, 1, 'single_choice', 'automatic',
        'exact', 0, 1, 1, ?, ?, ?, ?
      )
    `).run(
      itemId,
      definition.definitionJson,
      definition.definitionHash,
      fixtures.authorId,
      fixtures.authorId,
    ).lastInsertRowid;
    assert.throws(() => db.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'published', revision = 2,
          updated_by = ?, published_by = ?, published_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixtures.reviewerId, fixtures.reviewerId, versionId), {
      message: /typed_question_version_requires_approved_review/,
    });

    const reviewId = db.prepare(`
      INSERT INTO typed_question_review_cycles (
        public_id, item_id, version_id, review_round,
        version_revision, definition_hash, submitted_by
      ) VALUES ('migration-review-cycle-001', ?, ?, 1, 1, ?, ?)
    `).run(itemId, versionId, definition.definitionHash, fixtures.authorId).lastInsertRowid;
    assert.throws(() => db.prepare(`
      UPDATE typed_question_item_versions
      SET definition_json = definition_json, revision = 2
      WHERE id = ?
    `).run(versionId), { message: /typed_question_version_is_under_review/ });
    assert.throws(() => db.prepare(`
      UPDATE typed_question_review_cycles
      SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          decision_reason = 'Autor tentou aprovar a própria questão.', revision = 2
      WHERE id = ?
    `).run(fixtures.authorId, reviewId), {
      message: /invalid_typed_question_review_decision_actor/,
    });
    db.prepare(`
      UPDATE typed_question_review_cycles
      SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          decision_reason = 'Conteúdo conferido por revisora independente.', revision = 2
      WHERE id = ?
    `).run(fixtures.reviewerId, reviewId);
    db.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'published', revision = 2,
          updated_by = ?, published_by = ?, published_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(fixtures.reviewerId, fixtures.reviewerId, versionId);
    const operationId = db.prepare(`
      INSERT INTO typed_question_write_operations (
        public_id, operation_type, actor_id, item_id, version_id, review_id,
        idempotency_key_hash, request_fingerprint, result_json
      ) VALUES ('migration-write-operation-01', 'approve_review', ?, ?, ?, ?, ?, ?, '{}')
    `).run(
      fixtures.reviewerId,
      itemId,
      versionId,
      reviewId,
      'a'.repeat(64),
      'b'.repeat(64),
    ).lastInsertRowid;
    assert.throws(() => db.prepare(`
      UPDATE typed_question_write_operations SET result_json = '{}' WHERE id = ?
    `).run(operationId), { message: /typed_question_write_operation_is_immutable/ });
    assert.throws(() => db.prepare(`
      DELETE FROM typed_question_write_operations WHERE id = ?
    `).run(operationId), { message: /typed_question_write_operation_is_immutable/ });
    assert.throws(() => db.prepare(`
      DELETE FROM typed_question_review_cycles WHERE id = ?
    `).run(reviewId), { message: /typed_question_review_cannot_be_deleted/ });
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('flag desligada falha fechada sem qualquer escrita', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    assert.throws(() => adopt(db, fixtures), (error) => (
      error.code === 'feature_disabled' && error.status === 404
    ));
    assert.equal(db.prepare('SELECT COUNT(*) FROM typed_question_items').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM typed_question_write_operations').pluck().get(), 0);
  } finally {
    db.close();
  }
});

test('autoria completa é idempotente, revisionada e separa aprovação de ativação', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    enableFor(db, fixtures.authorId, fixtures.reviewerId);
    const created = adopt(db, fixtures);
    assert.equal(created.replayed, false);
    assert.equal(created.version.status, 'draft');
    assert.equal(created.version.revision, 1);
    assert.equal(created.item.currentVersion, null);

    const replay = adopt(db, fixtures);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version.publicId, created.version.publicId);
    assert.equal(db.prepare('SELECT COUNT(*) FROM typed_question_items').pluck().get(), 1);
    assert.equal(db.prepare('SELECT COUNT(*) FROM typed_question_write_operations').pluck().get(), 1);
    assert.throws(() => adoptTypedQuestion(db, {
      actor: { id: fixtures.authorId },
      questionId: fixtures.questionId,
      definition: choiceDefinition('Conteúdo diferente com a mesma chave.'),
      idempotencyKey: key('adopt'),
    }), (error) => error.code === 'idempotency_conflict');

    const updated = updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition('Uma caixa tem três fileiras com quatro livros. Quantos livros há?'),
      idempotencyKey: key('update'),
    });
    assert.equal(updated.version.revision, 2);
    assert.throws(() => updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition(),
      idempotencyKey: key('stale-update'),
    }), (error) => error.code === 'stale_typed_version');

    const submitted = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 2,
      idempotencyKey: key('submit'),
    });
    assert.equal(submitted.latestReview.status, 'pending');
    assert.equal(submitted.latestReview.round, 1);
    assert.throws(() => updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 2,
      definition: choiceDefinition(),
      idempotencyKey: key('edit-pending'),
    }), (error) => error.code === 'typed_version_under_review');
    const queue = listTypedReviewQueue(db, {
      actor: { id: fixtures.reviewerId },
      limit: 20,
    });
    assert.equal(queue.length, 1);
    assert.equal(queue[0].versionPublicId, created.version.publicId);

    const approved = decideTypedReview(db, {
      actor: { id: fixtures.reviewerId, role: 'professor' },
      reviewPublicId: submitted.latestReview.publicId,
      expectedRevision: 1,
      decision: 'approved',
      reason: 'Enunciado, gabarito, acessibilidade e impressão foram conferidos.',
      idempotencyKey: key('approve'),
    });
    assert.equal(approved.version.status, 'published');
    assert.equal(approved.latestReview.status, 'approved');
    assert.equal(approved.item.status, 'draft');
    assert.equal(approved.item.currentVersion, null);

    const activated = activateTypedVersion(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedItemRevision: 1,
      expectedCurrentRevision: null,
      idempotencyKey: key('activate'),
    });
    assert.equal(activated.item.status, 'active');
    assert.equal(activated.item.revision, 2);
    assert.equal(activated.item.currentVersion.publicId, created.version.publicId);
    assert.equal(activated.item.currentVersion.revision, 1);
    assert.equal(db.prepare(`
      SELECT COUNT(*) FROM typed_question_write_operations
    `).pluck().get(), 5);
    assert.equal(db.prepare(`
      SELECT COUNT(*) FROM typed_question_audit_log
    `).pluck().get(), 5);
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('rejeição permite correção e nova rodada, sem ativar conteúdo automaticamente', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    enableFor(db, fixtures.authorId, fixtures.reviewerId, fixtures.secondReviewerId);
    const created = adopt(db, fixtures, 'adopt-rounds');
    const firstSubmission = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      idempotencyKey: key('round1-submit'),
    });
    const rejected = decideTypedReview(db, {
      actor: { id: fixtures.reviewerId },
      reviewPublicId: firstSubmission.latestReview.publicId,
      expectedRevision: 1,
      decision: 'rejected',
      reason: 'A instrução impressa precisa indicar com mais clareza como responder.',
      idempotencyKey: key('round1-reject'),
    });
    assert.equal(rejected.version.status, 'draft');
    assert.equal(rejected.latestReview.status, 'rejected');

    const corrected = updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition('Há três grupos com quatro estudantes. Qual é o total?'),
      idempotencyKey: key('round2-update'),
    });
    assert.equal(corrected.version.revision, 2);
    const secondSubmission = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 2,
      idempotencyKey: key('round2-submit'),
    });
    assert.equal(secondSubmission.latestReview.round, 2);
    decideTypedReview(db, {
      actor: { id: fixtures.secondReviewerId },
      reviewPublicId: secondSubmission.latestReview.publicId,
      expectedRevision: 1,
      decision: 'approved',
      reason: 'A correção atende aos critérios editoriais e mantém equivalência em papel.',
      idempotencyKey: key('round2-approve'),
    });
    const reviews = db.prepare(`
      SELECT review_round, status
      FROM typed_question_review_cycles
      ORDER BY review_round
    `).all();
    assert.deepEqual(reviews, [
      { review_round: 1, status: 'rejected' },
      { review_round: 2, status: 'approved' },
    ]);
  } finally {
    db.close();
  }
});

test('nova versão parte da corrente e usa concorrência otimista na troca', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    enableFor(db, fixtures.authorId, fixtures.reviewerId);
    const first = adopt(db, fixtures, 'adopt-versioning');
    const firstReview = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: first.version.publicId,
      expectedRevision: 1,
      idempotencyKey: key('version1-submit'),
    });
    decideTypedReview(db, {
      actor: { id: fixtures.reviewerId },
      reviewPublicId: firstReview.latestReview.publicId,
      expectedRevision: 1,
      decision: 'approved',
      reason: 'Primeira versão conferida integralmente para o teste.',
      idempotencyKey: key('version1-approve'),
    });
    const activeFirst = activateTypedVersion(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: first.version.publicId,
      expectedItemRevision: 1,
      idempotencyKey: key('version1-activate'),
    });
    const second = createNextTypedVersion(db, {
      actor: { id: fixtures.authorId },
      itemPublicId: activeFirst.item.publicId,
      expectedCurrentRevision: 1,
      idempotencyKey: key('version2-create'),
    });
    assert.equal(second.version.number, 2);
    assert.equal(second.version.definitionHash, first.version.definitionHash);
    const secondUpdated = updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: second.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition('Nova versão do problema de multiplicação.'),
      idempotencyKey: key('version2-update'),
    });
    const secondReview = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: second.version.publicId,
      expectedRevision: secondUpdated.version.revision,
      idempotencyKey: key('version2-submit'),
    });
    decideTypedReview(db, {
      actor: { id: fixtures.reviewerId },
      reviewPublicId: secondReview.latestReview.publicId,
      expectedRevision: 1,
      decision: 'approved',
      reason: 'Segunda versão conferida sem alterar a habilidade observada.',
      idempotencyKey: key('version2-approve'),
    });
    assert.throws(() => activateTypedVersion(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: second.version.publicId,
      expectedItemRevision: 2,
      expectedCurrentRevision: 2,
      idempotencyKey: key('version2-stale-activate'),
    }), (error) => error.code === 'stale_current_version');
    const activeSecond = activateTypedVersion(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: second.version.publicId,
      expectedItemRevision: 2,
      expectedCurrentRevision: 1,
      idempotencyKey: key('version2-activate'),
    });
    assert.equal(activeSecond.item.revision, 3);
    assert.equal(activeSecond.item.currentVersion.publicId, second.version.publicId);
    assert.equal(activeSecond.item.currentVersion.revision, 2);
  } finally {
    db.close();
  }
});

test('cancelamento devolve o rascunho ao autor e preserva a decisão', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    enableFor(db, fixtures.authorId);
    const created = adopt(db, fixtures, 'adopt-cancel');
    const submitted = submitTypedReview(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      idempotencyKey: key('cancel-submit'),
    });
    const cancelled = cancelTypedReview(db, {
      actor: { id: fixtures.authorId },
      reviewPublicId: submitted.latestReview.publicId,
      expectedRevision: 1,
      reason: 'A autora identificou uma ambiguidade antes da decisão editorial.',
      idempotencyKey: key('cancel-review'),
    });
    assert.equal(cancelled.latestReview.status, 'cancelled');
    const updated = updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition('Enunciado corrigido após cancelamento voluntário.'),
      idempotencyKey: key('cancel-update'),
    });
    assert.equal(updated.version.revision, 2);
  } finally {
    db.close();
  }
});

test('isolamento usa o papel atual do banco e falha transacionalmente na auditoria', () => {
  const db = createDatabase();
  try {
    const fixtures = seed(db);
    enableFor(db, fixtures.authorId, fixtures.otherTeacherId, fixtures.reviewerId);
    assert.throws(() => adoptTypedQuestion(db, {
      actor: { id: fixtures.authorId },
      questionId: fixtures.otherQuestionId,
      definition: choiceDefinition(),
      idempotencyKey: key('foreign-adopt'),
    }), (error) => error.code === 'author_question_not_found');
    assert.throws(() => adoptTypedQuestion(db, {
      actor: { id: fixtures.authorId },
      questionId: fixtures.officialQuestionId,
      definition: choiceDefinition(),
      idempotencyKey: key('official-adopt'),
    }), (error) => error.code === 'author_question_not_found');

    const created = adopt(db, fixtures, 'adopt-isolation');
    assert.throws(() => getTypedAuthoringState(db, {
      actor: { id: fixtures.otherTeacherId, role: 'admin' },
      versionPublicId: created.version.publicId,
    }), (error) => error.code === 'typed_question_not_found');

    db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(fixtures.authorId);
    assert.throws(() => updateTypedDraft(db, {
      actor: { id: fixtures.authorId, role: 'professor' },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition(),
      idempotencyKey: key('stale-role'),
    }), (error) => error.code === 'professor_required');

    db.prepare("UPDATE users SET role = 'professor' WHERE id = ?").run(fixtures.authorId);
    db.exec(`
      CREATE TRIGGER test_typed_operation_failure
      BEFORE INSERT ON typed_question_write_operations
      WHEN NEW.operation_type = 'update_draft'
      BEGIN
        SELECT RAISE(ABORT, 'synthetic_authoring_audit_failure');
      END;
    `);
    assert.throws(() => updateTypedDraft(db, {
      actor: { id: fixtures.authorId },
      versionPublicId: created.version.publicId,
      expectedRevision: 1,
      definition: choiceDefinition('Alteração que deverá ser revertida integralmente.'),
      idempotencyKey: key('audit-failure'),
    }), /synthetic_authoring_audit_failure/);
    assert.deepEqual(db.prepare(`
      SELECT revision, definition_hash
      FROM typed_question_item_versions
      WHERE public_id = ?
    `).get(created.version.publicId), {
      revision: 1,
      definition_hash: created.version.definitionHash,
    });
  } finally {
    db.close();
  }
});
