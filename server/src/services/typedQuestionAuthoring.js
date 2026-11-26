const crypto = require('node:crypto');
const { v4: uuidv4 } = require('uuid');

const { evaluateFeatureFlag } = require('./featureFlags');
const {
  TypedQuestionEngineError,
  compileTypedQuestionDefinition,
} = require('./typedQuestionEngine');

const FEATURE_KEY = 'question_bank.typed_engine';
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]+$/;

class TypedQuestionAuthoringError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'TypedQuestionAuthoringError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new TypedQuestionAuthoringError(status, code, message, details);
}

function positiveInteger(value, field, { optional = false } = {}) {
  if (optional && (value === null || value === undefined || value === '')) return null;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  return number;
}

function requiredText(value, field, minimum, maximum) {
  if (typeof value !== 'string') fail(400, 'invalid_request', `${field} é obrigatório.`);
  const normalized = value.trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    fail(
      400,
      'invalid_request',
      `${field} deve ter entre ${minimum} e ${maximum} caracteres.`,
    );
  }
  return normalized;
}

function publicId(value, field) {
  return requiredText(value, field, 20, 64);
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function fingerprint(value) {
  return sha256(JSON.stringify(canonicalize(value)));
}

function normalizeIdempotencyKey(value) {
  if (typeof value !== 'string') {
    fail(
      400,
      'idempotency_key_required',
      'Envie uma chave de idempotência para concluir a operação.',
    );
  }
  const normalized = value.trim();
  if (
    normalized.length < 20
    || normalized.length > 200
    || !IDEMPOTENCY_PATTERN.test(normalized)
  ) {
    fail(
      400,
      'invalid_idempotency_key',
      'A chave de idempotência deve ter entre 20 e 200 caracteres seguros.',
    );
  }
  return sha256(normalized);
}

function compileDefinition(value) {
  try {
    return compileTypedQuestionDefinition(value);
  } catch (error) {
    if (error instanceof TypedQuestionEngineError) {
      fail(400, error.code, error.message, error.details || undefined);
    }
    throw error;
  }
}

function currentPrincipal(database, actor) {
  const actorId = positiveInteger(actor?.id, 'O usuário');
  const principal = database.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE id = ?
  `).get(actorId);
  if (!principal) fail(401, 'invalid_principal', 'A sessão não corresponde a um usuário ativo.');
  if (!['professor', 'admin'].includes(principal.role)) {
    fail(403, 'forbidden', 'Este perfil não pode usar a autoria tipada.');
  }

  const decision = evaluateFeatureFlag(database, FEATURE_KEY, principal);
  if (!decision.enabled) {
    fail(404, 'feature_disabled', 'A autoria tipada ainda não está disponível.', {
      reason: decision.reason,
    });
  }
  return principal;
}

function requireProfessor(principal) {
  if (principal.role !== 'professor') {
    fail(403, 'professor_required', 'A autoria e a ativação são exclusivas do professor autor.');
  }
}

function requireReviewer(principal) {
  if (principal.role !== 'admin') {
    fail(403, 'reviewer_required', 'A decisão editorial exige um administrador revisor.');
  }
}

function loadItem(database, itemPublicId) {
  return database.prepare(`
    SELECT item.*, question.question_code, question.skill_id,
      question.source AS question_source, question.created_by AS question_created_by,
      question.status AS question_status
    FROM typed_question_items item
    JOIN questions question ON question.id = item.question_id
    WHERE item.public_id = ? COLLATE NOCASE AND question.question_type IS NOT 'numeric_draft'
  `).get(itemPublicId);
}

function loadVersion(database, versionPublicId) {
  return database.prepare(`
    SELECT version.*, item.public_id AS item_public_id, item.question_id,
      item.status AS item_status, item.revision AS item_revision,
      item.created_by AS item_created_by,
      question.question_code, question.skill_id,
      question.source AS question_source,
      question.created_by AS question_created_by,
      current_version.version_id AS current_version_id,
      current_version.revision AS current_revision
    FROM typed_question_item_versions version
    JOIN typed_question_items item ON item.id = version.item_id
    JOIN questions question ON question.id = item.question_id
    LEFT JOIN typed_question_current_versions current_version
      ON current_version.item_id = item.id
    WHERE version.public_id = ? COLLATE NOCASE AND question.question_type IS NOT 'numeric_draft'
  `).get(versionPublicId);
}

function loadReview(database, reviewPublicId) {
  return database.prepare(`
    SELECT review.*, version.public_id AS version_public_id,
      version.status AS version_status, version.revision AS current_version_revision,
      version.definition_json, version.created_by AS version_created_by,
      item.public_id AS item_public_id, item.status AS item_status,
      item.revision AS item_revision, item.question_id,
      question.question_code, question.skill_id,
      question.source AS question_source,
      question.created_by AS question_created_by
    FROM typed_question_review_cycles review
    JOIN typed_question_item_versions version ON version.id = review.version_id
    JOIN typed_question_items item ON item.id = review.item_id
    JOIN questions question ON question.id = item.question_id
    WHERE review.public_id = ? COLLATE NOCASE AND question.question_type IS NOT 'numeric_draft'
  `).get(reviewPublicId);
}

function assertOwned(row, principal, notFoundCode = 'typed_question_not_found') {
  if (!row || row.question_source !== 'teacher' || row.question_created_by !== principal.id) {
    fail(404, notFoundCode, 'Questão tipada não encontrada.');
  }
}

function serializeVersion(database, version) {
  const current = database.prepare(`
    SELECT current_version.version_id, current_version.revision,
      current_version.activated_at, version.public_id AS version_public_id
    FROM typed_question_current_versions current_version
    JOIN typed_question_item_versions version ON version.id = current_version.version_id
    WHERE current_version.item_id = ?
  `).get(version.item_id);
  const latestReview = database.prepare(`
    SELECT public_id, review_round, version_revision, definition_hash,
      status, revision, submitted_by, submitted_at,
      decided_by, decided_at, decision_reason
    FROM typed_question_review_cycles
    WHERE version_id = ?
    ORDER BY review_round DESC
    LIMIT 1
  `).get(version.id);

  return {
    item: {
      publicId: version.item_public_id,
      status: version.item_status,
      revision: version.item_revision,
      question: {
        id: version.question_id,
        code: version.question_code,
        skillId: version.skill_id,
      },
      currentVersion: current ? {
        publicId: current.version_public_id,
        revision: current.revision,
        activatedAt: current.activated_at,
      } : null,
    },
    version: {
      publicId: version.public_id,
      number: version.version,
      status: version.status,
      revision: version.revision,
      definitionHash: version.definition_hash,
      definition: JSON.parse(version.definition_json),
      interactionType: version.interaction_type,
      scoringStrategy: version.scoring_strategy,
      partialCredit: version.partial_credit === 1,
      createdAt: version.created_at,
      updatedAt: version.updated_at,
      publishedAt: version.published_at,
    },
    latestReview: latestReview ? serializeReview(latestReview) : null,
  };
}

function serializeReview(review) {
  if (!review) return null;
  return {
    publicId: review.public_id,
    round: review.review_round,
    status: review.status,
    revision: review.revision,
    versionRevision: review.version_revision,
    definitionHash: review.definition_hash,
    submittedBy: review.submitted_by,
    submittedAt: review.submitted_at,
    decidedBy: review.decided_by,
    decidedAt: review.decided_at,
    decisionReason: review.decision_reason,
  };
}

function operationReplay(database, principal, keyHash, operationType, requestFingerprint) {
  const operation = database.prepare(`
    SELECT operation_type, request_fingerprint, result_json
    FROM typed_question_write_operations
    WHERE actor_id = ? AND idempotency_key_hash = ?
  `).get(principal.id, keyHash);
  if (!operation) return null;
  if (
    operation.operation_type !== operationType
    || operation.request_fingerprint !== requestFingerprint
  ) {
    fail(
      409,
      'idempotency_conflict',
      'Esta chave de idempotência já foi usada com outra operação ou conteúdo.',
    );
  }
  return JSON.parse(operation.result_json);
}

function recordOperation(database, {
  operationType,
  principal,
  itemId,
  versionId,
  reviewId = null,
  keyHash,
  requestFingerprint,
  result,
}) {
  database.prepare(`
    INSERT INTO typed_question_write_operations (
      public_id, operation_type, actor_id, item_id, version_id, review_id,
      idempotency_key_hash, request_fingerprint, result_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    uuidv4(),
    operationType,
    principal.id,
    itemId,
    versionId,
    reviewId,
    keyHash,
    requestFingerprint,
    JSON.stringify(result),
  );
}

function runIdempotent(database, {
  principal,
  idempotencyKey,
  operationType,
  fingerprintPayload,
  perform,
}) {
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprint({ operationType, ...fingerprintPayload });
  const transaction = database.transaction(() => {
    const replay = operationReplay(
      database,
      principal,
      keyHash,
      operationType,
      requestFingerprint,
    );
    if (replay) return { result: replay, replayed: true };
    const performed = perform();
    recordOperation(database, {
      operationType,
      principal,
      keyHash,
      requestFingerprint,
      ...performed,
    });
    return { result: performed.result, replayed: false };
  });
  return transaction();
}

function loadSerializedVersion(database, versionPublicId, principal, allowReviewer = false) {
  const version = loadVersion(database, versionPublicId);
  if (!version) fail(404, 'typed_question_not_found', 'Questão tipada não encontrada.');
  if (!allowReviewer || principal.role !== 'admin') assertOwned(version, principal);
  return serializeVersion(database, version);
}

function adoptTypedQuestion(database, {
  actor,
  questionId,
  definition,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedQuestionId = positiveInteger(questionId, 'A questão');
  const compiled = compileDefinition(definition);
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'adopt_question',
    fingerprintPayload: {
      questionId: normalizedQuestionId,
      definitionHash: compiled.definitionHash,
    },
    perform() {
      const question = database.prepare(`
        SELECT id, question_code, source, created_by, status
        FROM questions
        WHERE id = ?
      `).get(normalizedQuestionId);
      if (
        !question
        || question.source !== 'teacher'
        || question.created_by !== principal.id
      ) {
        fail(404, 'author_question_not_found', 'Questão autoral não encontrada.');
      }
      if (question.status !== 'active') {
        fail(409, 'author_question_inactive', 'Somente uma questão autoral ativa pode iniciar a versão tipada.');
      }
      if (database.prepare(`
        SELECT 1 FROM typed_question_items WHERE question_id = ?
      `).get(question.id)) {
        fail(409, 'typed_question_already_exists', 'Esta questão já possui uma autoria tipada.');
      }

      const itemId = database.prepare(`
        INSERT INTO typed_question_items (
          public_id, question_id, created_by, updated_by
        ) VALUES (?, ?, ?, ?)
      `).run(uuidv4(), question.id, principal.id, principal.id).lastInsertRowid;
      const item = database.prepare(`
        SELECT public_id FROM typed_question_items WHERE id = ?
      `).get(itemId);
      const versionId = database.prepare(`
        INSERT INTO typed_question_item_versions (
          public_id, item_id, version, engine_version, format_version,
          interaction_type, correction_mode, scoring_strategy, partial_credit,
          accessibility_ready, print_supported, definition_json, definition_hash,
          created_by, updated_by
        ) VALUES (?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(),
        itemId,
        compiled.metadata.engineVersion,
        compiled.metadata.formatVersion,
        compiled.metadata.interactionType,
        compiled.metadata.correctionMode,
        compiled.metadata.scoringStrategy,
        compiled.metadata.partialCredit ? 1 : 0,
        compiled.metadata.accessibilityReady ? 1 : 0,
        compiled.metadata.printSupported ? 1 : 0,
        compiled.definitionJson,
        compiled.definitionHash,
        principal.id,
        principal.id,
      ).lastInsertRowid;
      const version = database.prepare(`
        SELECT public_id FROM typed_question_item_versions WHERE id = ?
      `).get(versionId);
      const result = {
        itemPublicId: item.public_id,
        versionPublicId: version.public_id,
        reviewPublicId: null,
      };
      return { result, itemId, versionId };
    },
  });
  return {
    ...loadSerializedVersion(
      database,
      operation.result.versionPublicId,
      principal,
    ),
    replayed: operation.replayed,
  };
}

function updateTypedDraft(database, {
  actor,
  versionPublicId,
  expectedRevision,
  definition,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedVersionPublicId = publicId(versionPublicId, 'A versão');
  const normalizedRevision = positiveInteger(expectedRevision, 'A revisão esperada');
  const compiled = compileDefinition(definition);
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'update_draft',
    fingerprintPayload: {
      versionPublicId: normalizedVersionPublicId,
      expectedRevision: normalizedRevision,
      definitionHash: compiled.definitionHash,
    },
    perform() {
      const version = loadVersion(database, normalizedVersionPublicId);
      assertOwned(version, principal);
      if (version.item_status === 'retired') {
        fail(409, 'typed_question_retired', 'A questão tipada está aposentada.');
      }
      if (version.status !== 'draft') {
        fail(409, 'typed_version_frozen', 'Somente uma versão em rascunho pode ser editada.');
      }
      if (version.revision !== normalizedRevision) {
        fail(409, 'stale_typed_version', 'A versão foi alterada em outro acesso.', {
          currentRevision: version.revision,
        });
      }
      if (database.prepare(`
        SELECT 1
        FROM typed_question_review_cycles
        WHERE version_id = ? AND status = 'pending'
      `).get(version.id)) {
        fail(409, 'typed_version_under_review', 'Cancele ou aguarde a revisão antes de editar o rascunho.');
      }
      const result = database.prepare(`
        UPDATE typed_question_item_versions
        SET interaction_type = ?, correction_mode = ?, scoring_strategy = ?,
            partial_credit = ?, accessibility_ready = ?, print_supported = ?,
            definition_json = ?, definition_hash = ?, revision = revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revision = ? AND status = 'draft'
      `).run(
        compiled.metadata.interactionType,
        compiled.metadata.correctionMode,
        compiled.metadata.scoringStrategy,
        compiled.metadata.partialCredit ? 1 : 0,
        compiled.metadata.accessibilityReady ? 1 : 0,
        compiled.metadata.printSupported ? 1 : 0,
        compiled.definitionJson,
        compiled.definitionHash,
        principal.id,
        version.id,
        normalizedRevision,
      );
      if (result.changes !== 1) fail(409, 'stale_typed_version', 'A versão foi alterada em outro acesso.');
      return {
        result: {
          itemPublicId: version.item_public_id,
          versionPublicId: version.public_id,
          reviewPublicId: null,
        },
        itemId: version.item_id,
        versionId: version.id,
      };
    },
  });
  return {
    ...loadSerializedVersion(database, operation.result.versionPublicId, principal),
    replayed: operation.replayed,
  };
}

function createNextTypedVersion(database, {
  actor,
  itemPublicId,
  expectedCurrentRevision,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedItemPublicId = publicId(itemPublicId, 'O item');
  const normalizedCurrentRevision = positiveInteger(
    expectedCurrentRevision,
    'A revisão da versão corrente',
  );
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_version',
    fingerprintPayload: {
      itemPublicId: normalizedItemPublicId,
      expectedCurrentRevision: normalizedCurrentRevision,
    },
    perform() {
      const item = loadItem(database, normalizedItemPublicId);
      assertOwned(item, principal);
      if (item.status !== 'active') {
        fail(409, 'typed_question_not_active', 'A próxima versão exige uma questão tipada ativa.');
      }
      const current = database.prepare(`
        SELECT current_version.revision AS current_revision,
          version.*
        FROM typed_question_current_versions current_version
        JOIN typed_question_item_versions version ON version.id = current_version.version_id
        WHERE current_version.item_id = ?
      `).get(item.id);
      if (!current || current.current_revision !== normalizedCurrentRevision) {
        fail(409, 'stale_current_version', 'A versão corrente foi alterada em outro acesso.', {
          currentRevision: current?.current_revision || null,
        });
      }
      if (database.prepare(`
        SELECT 1
        FROM typed_question_item_versions
        WHERE item_id = ? AND status = 'draft'
      `).get(item.id)) {
        fail(409, 'typed_draft_already_exists', 'Conclua o rascunho existente antes de criar outra versão.');
      }
      const compiled = compileDefinition(JSON.parse(current.definition_json));
      const nextVersion = database.prepare(`
        SELECT COALESCE(MAX(version), 0) + 1 AS value
        FROM typed_question_item_versions
        WHERE item_id = ?
      `).pluck().get(item.id);
      const versionId = database.prepare(`
        INSERT INTO typed_question_item_versions (
          public_id, item_id, version, engine_version, format_version,
          interaction_type, correction_mode, scoring_strategy, partial_credit,
          accessibility_ready, print_supported, definition_json, definition_hash,
          created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), item.id, nextVersion,
        compiled.metadata.engineVersion, compiled.metadata.formatVersion,
        compiled.metadata.interactionType, compiled.metadata.correctionMode,
        compiled.metadata.scoringStrategy, compiled.metadata.partialCredit ? 1 : 0,
        compiled.metadata.accessibilityReady ? 1 : 0,
        compiled.metadata.printSupported ? 1 : 0,
        compiled.definitionJson, compiled.definitionHash,
        principal.id, principal.id,
      ).lastInsertRowid;
      const versionPublic = database.prepare(`
        SELECT public_id FROM typed_question_item_versions WHERE id = ?
      `).pluck().get(versionId);
      return {
        result: {
          itemPublicId: item.public_id,
          versionPublicId: versionPublic,
          reviewPublicId: null,
        },
        itemId: item.id,
        versionId,
      };
    },
  });
  return {
    ...loadSerializedVersion(database, operation.result.versionPublicId, principal),
    replayed: operation.replayed,
  };
}

function submitTypedReview(database, {
  actor,
  versionPublicId,
  expectedRevision,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedVersionPublicId = publicId(versionPublicId, 'A versão');
  const normalizedRevision = positiveInteger(expectedRevision, 'A revisão esperada');
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'submit_review',
    fingerprintPayload: {
      versionPublicId: normalizedVersionPublicId,
      expectedRevision: normalizedRevision,
    },
    perform() {
      const version = loadVersion(database, normalizedVersionPublicId);
      assertOwned(version, principal);
      if (version.status !== 'draft') {
        fail(409, 'typed_version_frozen', 'Somente rascunhos podem ser enviados para revisão.');
      }
      if (version.revision !== normalizedRevision) {
        fail(409, 'stale_typed_version', 'A versão foi alterada em outro acesso.', {
          currentRevision: version.revision,
        });
      }
      const reviewRound = database.prepare(`
        SELECT COALESCE(MAX(review_round), 0) + 1
        FROM typed_question_review_cycles
        WHERE version_id = ?
      `).pluck().get(version.id);
      const reviewId = database.prepare(`
        INSERT INTO typed_question_review_cycles (
          public_id, item_id, version_id, review_round,
          version_revision, definition_hash, submitted_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        uuidv4(), version.item_id, version.id, reviewRound,
        version.revision, version.definition_hash, principal.id,
      ).lastInsertRowid;
      const reviewPublic = database.prepare(`
        SELECT public_id FROM typed_question_review_cycles WHERE id = ?
      `).pluck().get(reviewId);
      return {
        result: {
          itemPublicId: version.item_public_id,
          versionPublicId: version.public_id,
          reviewPublicId: reviewPublic,
        },
        itemId: version.item_id,
        versionId: version.id,
        reviewId,
      };
    },
  });
  const state = loadSerializedVersion(database, operation.result.versionPublicId, principal);
  return { ...state, replayed: operation.replayed };
}

function decideTypedReview(database, {
  actor,
  reviewPublicId,
  expectedRevision,
  decision,
  reason,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireReviewer(principal);
  const normalizedReviewPublicId = publicId(reviewPublicId, 'A revisão');
  const normalizedRevision = positiveInteger(expectedRevision, 'A revisão esperada');
  const normalizedDecision = String(decision || '').trim().toLowerCase();
  if (!['approved', 'rejected'].includes(normalizedDecision)) {
    fail(400, 'invalid_review_decision', 'A decisão deve aprovar ou rejeitar a versão.');
  }
  const normalizedReason = requiredText(reason, 'A justificativa editorial', 10, 1000);
  const operationType = normalizedDecision === 'approved' ? 'approve_review' : 'reject_review';
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType,
    fingerprintPayload: {
      reviewPublicId: normalizedReviewPublicId,
      expectedRevision: normalizedRevision,
      decision: normalizedDecision,
      reason: normalizedReason,
    },
    perform() {
      const review = loadReview(database, normalizedReviewPublicId);
      if (!review || review.question_source !== 'teacher') {
        fail(404, 'typed_review_not_found', 'Revisão tipada não encontrada.');
      }
      if (review.version_created_by === principal.id) {
        fail(403, 'independent_reviewer_required', 'O autor não pode revisar a própria versão.');
      }
      if (review.status !== 'pending') {
        fail(409, 'typed_review_decided', 'Esta revisão já recebeu uma decisão.');
      }
      if (review.revision !== normalizedRevision) {
        fail(409, 'stale_typed_review', 'A revisão foi alterada em outro acesso.', {
          currentRevision: review.revision,
        });
      }
      if (
        review.version_status !== 'draft'
        || review.current_version_revision !== review.version_revision
        || review.definition_hash !== sha256(review.definition_json)
      ) {
        fail(409, 'typed_review_stale_content', 'O conteúdo não corresponde mais à revisão enviada.');
      }
      const decisionResult = database.prepare(`
        UPDATE typed_question_review_cycles
        SET status = ?, decided_by = ?, decided_at = CURRENT_TIMESTAMP,
            decision_reason = ?, revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending' AND revision = ?
      `).run(
        normalizedDecision,
        principal.id,
        normalizedReason,
        review.id,
        normalizedRevision,
      );
      if (decisionResult.changes !== 1) {
        fail(409, 'stale_typed_review', 'A revisão foi alterada em outro acesso.');
      }
      if (normalizedDecision === 'approved') {
        const publishResult = database.prepare(`
          UPDATE typed_question_item_versions
          SET status = 'published', revision = revision + 1,
              updated_by = ?, published_by = ?, published_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE id = ? AND status = 'draft' AND revision = ?
        `).run(
          principal.id,
          principal.id,
          review.version_id,
          review.version_revision,
        );
        if (publishResult.changes !== 1) {
          fail(409, 'typed_review_stale_content', 'O conteúdo mudou durante a decisão editorial.');
        }
      }
      return {
        result: {
          itemPublicId: review.item_public_id,
          versionPublicId: review.version_public_id,
          reviewPublicId: review.public_id,
        },
        itemId: review.item_id,
        versionId: review.version_id,
        reviewId: review.id,
      };
    },
  });
  const state = loadSerializedVersion(
    database,
    operation.result.versionPublicId,
    principal,
    true,
  );
  return { ...state, replayed: operation.replayed };
}

function cancelTypedReview(database, {
  actor,
  reviewPublicId,
  expectedRevision,
  reason,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedReviewPublicId = publicId(reviewPublicId, 'A revisão');
  const normalizedRevision = positiveInteger(expectedRevision, 'A revisão esperada');
  const normalizedReason = requiredText(reason, 'O motivo do cancelamento', 10, 1000);
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'cancel_review',
    fingerprintPayload: {
      reviewPublicId: normalizedReviewPublicId,
      expectedRevision: normalizedRevision,
      reason: normalizedReason,
    },
    perform() {
      const review = loadReview(database, normalizedReviewPublicId);
      assertOwned(review, principal, 'typed_review_not_found');
      if (review.status !== 'pending') {
        fail(409, 'typed_review_decided', 'Esta revisão já recebeu uma decisão.');
      }
      if (review.revision !== normalizedRevision) {
        fail(409, 'stale_typed_review', 'A revisão foi alterada em outro acesso.', {
          currentRevision: review.revision,
        });
      }
      const result = database.prepare(`
        UPDATE typed_question_review_cycles
        SET status = 'cancelled', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
            decision_reason = ?, revision = revision + 1,
            updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND status = 'pending' AND revision = ?
      `).run(principal.id, normalizedReason, review.id, normalizedRevision);
      if (result.changes !== 1) fail(409, 'stale_typed_review', 'A revisão foi alterada em outro acesso.');
      return {
        result: {
          itemPublicId: review.item_public_id,
          versionPublicId: review.version_public_id,
          reviewPublicId: review.public_id,
        },
        itemId: review.item_id,
        versionId: review.version_id,
        reviewId: review.id,
      };
    },
  });
  return {
    ...loadSerializedVersion(database, operation.result.versionPublicId, principal),
    replayed: operation.replayed,
  };
}

function activateTypedVersion(database, {
  actor,
  versionPublicId,
  expectedItemRevision,
  expectedCurrentRevision = null,
  idempotencyKey,
}) {
  const principal = currentPrincipal(database, actor);
  requireProfessor(principal);
  const normalizedVersionPublicId = publicId(versionPublicId, 'A versão');
  const normalizedItemRevision = positiveInteger(expectedItemRevision, 'A revisão do item');
  const normalizedCurrentRevision = positiveInteger(
    expectedCurrentRevision,
    'A revisão corrente',
    { optional: true },
  );
  const operation = runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'activate_version',
    fingerprintPayload: {
      versionPublicId: normalizedVersionPublicId,
      expectedItemRevision: normalizedItemRevision,
      expectedCurrentRevision: normalizedCurrentRevision,
    },
    perform() {
      const version = loadVersion(database, normalizedVersionPublicId);
      assertOwned(version, principal);
      if (version.status !== 'published') {
        fail(409, 'typed_version_not_published', 'Somente uma versão aprovada e publicada pode ser ativada.');
      }
      if (version.item_status === 'retired') {
        fail(409, 'typed_question_retired', 'A questão tipada está aposentada.');
      }
      if (version.item_revision !== normalizedItemRevision) {
        fail(409, 'stale_typed_item', 'O item foi alterado em outro acesso.', {
          currentRevision: version.item_revision,
        });
      }
      const current = database.prepare(`
        SELECT version_id, revision
        FROM typed_question_current_versions
        WHERE item_id = ?
      `).get(version.item_id);
      if (current) {
        if (current.version_id === version.id) {
          fail(409, 'typed_version_already_active', 'Esta versão já está ativa.');
        }
        if (current.revision !== normalizedCurrentRevision) {
          fail(409, 'stale_current_version', 'A versão corrente foi alterada em outro acesso.', {
            currentRevision: current.revision,
          });
        }
        const currentUpdate = database.prepare(`
          UPDATE typed_question_current_versions
          SET version_id = ?, revision = revision + 1,
              activated_by = ?, activated_at = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
          WHERE item_id = ? AND revision = ?
        `).run(version.id, principal.id, version.item_id, normalizedCurrentRevision);
        if (currentUpdate.changes !== 1) {
          fail(409, 'stale_current_version', 'A versão corrente foi alterada durante a ativação.');
        }
      } else {
        if (normalizedCurrentRevision !== null) {
          fail(409, 'stale_current_version', 'O item ainda não possui versão corrente.', {
            currentRevision: null,
          });
        }
        database.prepare(`
          INSERT INTO typed_question_current_versions (
            item_id, version_id, activated_by
          ) VALUES (?, ?, ?)
        `).run(version.item_id, version.id, principal.id);
      }

      const itemUpdate = database.prepare(`
        UPDATE typed_question_items
        SET status = 'active', revision = revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revision = ? AND status IN ('draft', 'active')
      `).run(principal.id, version.item_id, normalizedItemRevision);
      if (itemUpdate.changes !== 1) {
        fail(409, 'stale_typed_item', 'O item foi alterado durante a ativação.');
      }
      return {
        result: {
          itemPublicId: version.item_public_id,
          versionPublicId: version.public_id,
          reviewPublicId: null,
        },
        itemId: version.item_id,
        versionId: version.id,
      };
    },
  });
  return {
    ...loadSerializedVersion(database, operation.result.versionPublicId, principal),
    replayed: operation.replayed,
  };
}

function getTypedAuthoringState(database, { actor, versionPublicId }) {
  const principal = currentPrincipal(database, actor);
  const normalizedVersionPublicId = publicId(versionPublicId, 'A versão');
  return loadSerializedVersion(
    database,
    normalizedVersionPublicId,
    principal,
    principal.role === 'admin',
  );
}

function listTypedReviewQueue(database, { actor, limit = 50 }) {
  const principal = currentPrincipal(database, actor);
  requireReviewer(principal);
  const normalizedLimit = Math.min(100, positiveInteger(limit, 'O limite'));
  return database.prepare(`
    SELECT review.public_id, review.review_round, review.version_revision,
      review.definition_hash, review.status, review.revision,
      review.submitted_by, review.submitted_at,
      version.public_id AS version_public_id,
      version.interaction_type, item.public_id AS item_public_id,
      question.id AS question_id, question.question_code,
      submitter.name AS submitter_name
    FROM typed_question_review_cycles review
    JOIN typed_question_item_versions version ON version.id = review.version_id
    JOIN typed_question_items item ON item.id = review.item_id
    JOIN questions question ON question.id = item.question_id
    JOIN users submitter ON submitter.id = review.submitted_by
    WHERE review.status = 'pending' AND question.question_type IS NOT 'numeric_draft'
    ORDER BY review.submitted_at ASC, review.id ASC
    LIMIT ?
  `).all(normalizedLimit).map((review) => ({
    publicId: review.public_id,
    round: review.review_round,
    status: review.status,
    revision: review.revision,
    versionRevision: review.version_revision,
    definitionHash: review.definition_hash,
    submittedBy: review.submitted_by,
    submittedAt: review.submitted_at,
    submitterName: review.submitter_name,
    itemPublicId: review.item_public_id,
    versionPublicId: review.version_public_id,
    interactionType: review.interaction_type,
    question: { id: review.question_id, code: review.question_code },
  }));
}

module.exports = {
  FEATURE_KEY,
  TypedQuestionAuthoringError,
  activateTypedVersion,
  adoptTypedQuestion,
  cancelTypedReview,
  createNextTypedVersion,
  decideTypedReview,
  getTypedAuthoringState,
  listTypedReviewQueue,
  submitTypedReview,
  updateTypedDraft,
  runIdempotent,
};
