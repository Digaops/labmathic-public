const crypto = require('crypto');

const {
  authorizeMunicipalityAggregate,
  authorizeSchoolAggregate,
  getInstitutionalPrincipal,
  recordInstitutionalAudit,
} = require('./institutionalAccess');

const PLAN_FORMAT = 'labmathic.institutional-backfill-plan';
const LINK_RECEIPT_FORMAT = 'labmathic.institutional-backfill-link-receipt';
const VERIFICATION_RECEIPT_FORMAT = 'labmathic.institutional-backfill-verification-receipt';
const ARTIFACT_VERSION = 1;
const MAX_PLAN_ITEMS = 500;
const MAX_DIAGNOSTIC_ITEMS = 500;

class InstitutionalBackfillError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'InstitutionalBackfillError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new InstitutionalBackfillError(code, message, details);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function requiredText(value, label, minimum = 1, maximum = 500) {
  const normalized = String(value || '').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    fail('invalid_input', `${label} deve ter entre ${minimum} e ${maximum} caracteres.`);
  }
  return normalized;
}

function assertExactKeys(value, allowedKeys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_artifact_shape', `${label} deve ser um objeto.`);
  }
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.includes(key));
  const missing = allowedKeys.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    fail('invalid_artifact_shape', `${label} possui campos ausentes ou não permitidos.`, {
      unexpected,
      missing,
    });
  }
}

function normalizeTimestamp(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) fail('invalid_timestamp', 'Data do artefato inválida.');
  return date.toISOString();
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    return Object.keys(value)
      .sort()
      .reduce((result, key) => {
        result[key] = canonicalize(value[key]);
        return result;
      }, {});
  }
  return value;
}

function calculateArtifactDigest(value) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(canonicalize(value)))
    .digest('hex');
}

function sealArtifact(core, digestField) {
  return {
    ...core,
    [digestField]: calculateArtifactDigest(core),
  };
}

function verifyArtifactDigest(artifact, digestField) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    fail('invalid_artifact', 'O artefato de backfill deve ser um objeto JSON.');
  }
  const suppliedDigest = String(artifact[digestField] || '').trim().toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(suppliedDigest)) {
    fail('invalid_artifact_digest', `O campo ${digestField} não contém um SHA-256 válido.`);
  }
  const core = { ...artifact };
  delete core[digestField];
  const expectedDigest = calculateArtifactDigest(core);
  if (!crypto.timingSafeEqual(Buffer.from(suppliedDigest), Buffer.from(expectedDigest))) {
    fail('artifact_tampered', 'O conteúdo do artefato não corresponde ao hash informado.');
  }
  return { core, digest: suppliedDigest };
}

function findMunicipalityByPublicId(db, publicId) {
  return db.prepare(`
    SELECT id, public_id, name, status
    FROM municipalities
    WHERE public_id = ? COLLATE NOCASE
  `).get(requiredText(publicId, 'Identificador público do município', 20, 64)) || null;
}

function findSchoolByPublicId(db, municipalityId, publicId) {
  return db.prepare(`
    SELECT id, public_id, municipality_id, name, status
    FROM schools
    WHERE municipality_id = ? AND public_id = ? COLLATE NOCASE
  `).get(
    municipalityId,
    requiredText(publicId, 'Identificador público da escola', 20, 64),
  ) || null;
}

function findClassByPublicId(db, publicId) {
  return db.prepare(`
    SELECT
      school_class.id AS class_id,
      school_class.public_id AS class_public_id,
      school_class.name AS class_name,
      school_class.academic_year,
      school_class.status AS class_status,
      school_class.revision AS class_revision,
      school_class.owner_teacher_id,
      owner.name AS owner_teacher_name,
      grade.name AS grade_name,
      context.migration_status,
      context.municipality_id,
      context.school_id,
      context.linked_by,
      context.verified_by,
      context.linked_at,
      context.verified_at,
      context.updated_at AS context_updated_at
    FROM school_classes school_class
    JOIN users owner ON owner.id = school_class.owner_teacher_id
    JOIN grades grade ON grade.id = school_class.grade_id
    JOIN school_class_institution_contexts context
      ON context.class_id = school_class.id
      AND context.owner_teacher_id = school_class.owner_teacher_id
    WHERE school_class.public_id = ? COLLATE NOCASE
  `).get(requiredText(publicId, 'Identificador público da turma', 20, 64)) || null;
}

function listTeacherCandidateSchools(db, teacherId, municipalityId = null) {
  const conditions = municipalityId ? 'AND municipality.id = ?' : '';
  const params = municipalityId ? [teacherId, municipalityId] : [teacherId];
  return db.prepare(`
    SELECT
      municipality.id AS municipality_id,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      school.id AS school_id,
      school.public_id AS school_public_id,
      school.name AS school_name
    FROM institutional_memberships membership
    JOIN municipalities municipality
      ON municipality.id = membership.municipality_id
      AND municipality.status = 'active'
    JOIN schools school
      ON school.id = membership.school_id
      AND school.municipality_id = membership.municipality_id
      AND school.status = 'active'
    WHERE membership.user_id = ?
      AND membership.role = 'teacher'
      AND membership.status = 'active'
      ${conditions}
    ORDER BY municipality.name COLLATE NOCASE, school.name COLLATE NOCASE
  `).all(...params).map((row) => ({
    municipalityId: row.municipality_id,
    municipalityPublicId: row.municipality_public_id,
    municipalityName: row.municipality_name,
    schoolId: row.school_id,
    schoolPublicId: row.school_public_id,
    schoolName: row.school_name,
  }));
}

function assertMutationGuard({ appEnvironment, confirmation, operation, digest }) {
  if (appEnvironment !== 'homologation') {
    fail('homologation_required', 'O backfill institucional só pode escrever em homologação.');
  }
  const expected = `${operation} ${digest}`;
  if (confirmation !== expected) {
    fail(
      'confirmation_required',
      `Confirmação inválida. Informe exatamente: ${expected}`,
    );
  }
}

function assertReason(reason) {
  return requiredText(reason, 'Motivo operacional', 20, 500);
}

function assertActiveTeacherMembership(db, teacherId, municipalityId, schoolId) {
  const membership = db.prepare(`
    SELECT membership.id
    FROM institutional_memberships membership
    JOIN municipalities municipality
      ON municipality.id = membership.municipality_id
      AND municipality.status = 'active'
    JOIN schools school
      ON school.id = membership.school_id
      AND school.municipality_id = membership.municipality_id
      AND school.status = 'active'
    WHERE membership.user_id = ?
      AND membership.role = 'teacher'
      AND membership.municipality_id = ?
      AND membership.school_id = ?
      AND membership.status = 'active'
  `).get(teacherId, municipalityId, schoolId);
  if (!membership) {
    fail(
      'teacher_membership_required',
      'A turma só pode ser vinculada a uma escola com vínculo docente ativo.',
    );
  }
}

function createInstitutionalBackfillDiagnostic(db, options = {}) {
  const requestedLimit = options.limit === undefined
    ? MAX_DIAGNOSTIC_ITEMS
    : positiveInteger(options.limit);
  if (!requestedLimit || requestedLimit > MAX_DIAGNOSTIC_ITEMS) {
    fail(
      'invalid_diagnostic_limit',
      `O diagnóstico deve solicitar entre 1 e ${MAX_DIAGNOSTIC_ITEMS} turmas por página.`,
    );
  }
  const municipalityPublicId = options.municipalityPublicId
    ? requiredText(options.municipalityPublicId, 'Identificador público do município', 20, 64)
    : null;
  const municipality = municipalityPublicId
    ? findMunicipalityByPublicId(db, municipalityPublicId)
    : null;
  if (municipalityPublicId && (!municipality || municipality.status !== 'active')) {
    fail('municipality_unavailable', 'Município inexistente ou arquivado.');
  }

  let afterClassId = 0;
  if (options.afterClassPublicId) {
    const cursorClass = findClassByPublicId(db, options.afterClassPublicId);
    if (!cursorClass) fail('invalid_diagnostic_cursor', 'Cursor de turma não encontrado.');
    afterClassId = cursorClass.class_id;
  }
  const classPage = db.prepare(`
    SELECT school_class.public_id
    FROM school_classes school_class
    JOIN school_class_institution_contexts context
      ON context.class_id = school_class.id
    WHERE school_class.id > ?
    ORDER BY school_class.id
    LIMIT ?
  `).all(afterClassId, requestedLimit + 1);
  const hasMore = classPage.length > requestedLimit;
  const classes = classPage.slice(0, requestedLimit);

  const items = classes.map(({ public_id: classPublicId }) => {
    const schoolClass = findClassByPublicId(db, classPublicId);
    const candidates = listTeacherCandidateSchools(
      db,
      schoolClass.owner_teacher_id,
      municipality?.id || null,
    );
    if (municipality && candidates.length === 0) return null;
    return {
      classPublicId: schoolClass.class_public_id,
      className: schoolClass.class_name,
      academicYear: schoolClass.academic_year,
      classStatus: schoolClass.class_status,
      gradeName: schoolClass.grade_name,
      ownerTeacher: {
        userId: schoolClass.owner_teacher_id,
        name: schoolClass.owner_teacher_name,
      },
      migrationStatus: schoolClass.migration_status,
      candidateSchools: candidates.map((candidate) => ({
        municipalityPublicId: candidate.municipalityPublicId,
        municipalityName: candidate.municipalityName,
        schoolPublicId: candidate.schoolPublicId,
        schoolName: candidate.schoolName,
      })),
      requiresExplicitMapping: schoolClass.migration_status === 'pending',
    };
  }).filter(Boolean);

  const counts = items.reduce((result, item) => {
    result[item.migrationStatus] += 1;
    if (item.candidateSchools.length === 0) result.withoutCandidateSchool += 1;
    if (item.candidateSchools.length > 1) result.withMultipleCandidateSchools += 1;
    return result;
  }, {
    total: items.length,
    pending: 0,
    linked: 0,
    verified: 0,
    withoutCandidateSchool: 0,
    withMultipleCandidateSchools: 0,
  });

  return {
    format: 'labmathic.institutional-backfill-diagnostic',
    formatVersion: ARTIFACT_VERSION,
    generatedAt: normalizeTimestamp(options.generatedAt),
    scope: municipality ? {
      municipalityPublicId: municipality.public_id,
      municipalityName: municipality.name,
    } : { municipalityPublicId: null, municipalityName: null },
    policy: {
      automaticSelection: false,
      studentDataIncluded: false,
      sourceOfTruth: 'explicit_administrative_records',
    },
    counts,
    pagination: {
      limit: requestedLimit,
      hasMore,
      nextAfterClassPublicId: hasMore
        ? classes.at(-1)?.public_id || null
        : null,
    },
    items,
  };
}

function createInstitutionalBackfillPlan(db, options = {}) {
  const generatedByUserId = positiveInteger(options.generatedByUserId);
  if (!generatedByUserId) fail('invalid_actor', 'Responsável pelo plano inválido.');
  const municipality = findMunicipalityByPublicId(db, options.municipalityPublicId);
  if (!municipality || municipality.status !== 'active') {
    fail('municipality_unavailable', 'Município inexistente ou arquivado.');
  }
  const authorization = authorizeMunicipalityAggregate(db, generatedByUserId, municipality.id);
  if (!authorization.allowed) {
    fail('municipality_scope_denied', 'O responsável não pode planejar o backfill deste município.');
  }

  const assignments = options.assignments;
  if (!Array.isArray(assignments) || assignments.length < 1 || assignments.length > MAX_PLAN_ITEMS) {
    fail(
      'invalid_assignments',
      `O plano deve conter entre 1 e ${MAX_PLAN_ITEMS} vínculos explícitos.`,
    );
  }
  const seenClasses = new Set();
  const items = assignments.map((assignment, index) => {
    const classPublicId = requiredText(
      assignment?.classPublicId,
      `Identificador da turma no item ${index + 1}`,
      20,
      64,
    );
    const normalizedClassId = classPublicId.toLowerCase();
    if (seenClasses.has(normalizedClassId)) {
      fail('duplicate_class', `A turma ${classPublicId} aparece mais de uma vez no plano.`);
    }
    seenClasses.add(normalizedClassId);

    const school = findSchoolByPublicId(db, municipality.id, assignment?.schoolPublicId);
    if (!school || school.status !== 'active') {
      fail('school_unavailable', `A escola do item ${index + 1} não pertence ao município ativo.`);
    }
    const schoolClass = findClassByPublicId(db, classPublicId);
    if (!schoolClass) fail('class_unavailable', `Turma não encontrada: ${classPublicId}.`);
    if (schoolClass.migration_status !== 'pending') {
      fail('class_not_pending', `A turma ${classPublicId} não está pendente de vínculo.`);
    }
    assertActiveTeacherMembership(
      db,
      schoolClass.owner_teacher_id,
      municipality.id,
      school.id,
    );

    return {
      classPublicId: schoolClass.class_public_id,
      className: schoolClass.class_name,
      academicYear: schoolClass.academic_year,
      classStatus: schoolClass.class_status,
      gradeName: schoolClass.grade_name,
      ownerTeacher: {
        userId: schoolClass.owner_teacher_id,
        name: schoolClass.owner_teacher_name,
      },
      target: {
        municipalityPublicId: municipality.public_id,
        municipalityName: municipality.name,
        schoolPublicId: school.public_id,
        schoolName: school.name,
      },
      expected: {
        classRevision: schoolClass.class_revision,
        migrationStatus: schoolClass.migration_status,
        contextUpdatedAt: schoolClass.context_updated_at,
      },
      provenance: 'explicit_manual_mapping',
    };
  });

  return sealArtifact({
    format: PLAN_FORMAT,
    formatVersion: ARTIFACT_VERSION,
    generatedAt: normalizeTimestamp(options.generatedAt),
    generatedByUserId,
    scope: {
      municipalityPublicId: municipality.public_id,
      municipalityName: municipality.name,
    },
    policy: {
      automaticSelection: false,
      partialApplication: false,
      secondPersonVerificationRequired: true,
      studentDataIncluded: false,
    },
    items,
  }, 'planDigest');
}

function validatePlan(plan) {
  const verified = verifyArtifactDigest(plan, 'planDigest');
  const { core } = verified;
  assertExactKeys(core, [
    'format',
    'formatVersion',
    'generatedAt',
    'generatedByUserId',
    'scope',
    'policy',
    'items',
  ], 'O plano');
  assertExactKeys(core.scope, ['municipalityPublicId', 'municipalityName'], 'O escopo do plano');
  assertExactKeys(core.policy, [
    'automaticSelection',
    'partialApplication',
    'secondPersonVerificationRequired',
    'studentDataIncluded',
  ], 'A política do plano');
  if (core.format !== PLAN_FORMAT || core.formatVersion !== ARTIFACT_VERSION) {
    fail('unsupported_plan', 'Formato ou versão do plano de backfill não suportado.');
  }
  if (
    core.policy.automaticSelection !== false
    || core.policy.partialApplication !== false
    || core.policy.secondPersonVerificationRequired !== true
    || core.policy.studentDataIncluded !== false
  ) {
    fail('unsafe_plan_policy', 'A política segura do plano foi alterada.');
  }
  normalizeTimestamp(core.generatedAt);
  if (!positiveInteger(core.generatedByUserId)) {
    fail('invalid_plan_actor', 'O plano não identifica um responsável válido.');
  }
  if (!Array.isArray(core.items) || core.items.length < 1 || core.items.length > MAX_PLAN_ITEMS) {
    fail('invalid_plan_items', 'Quantidade de itens do plano inválida.');
  }
  const seen = new Set();
  core.items.forEach((item) => {
    assertExactKeys(item, [
      'classPublicId',
      'className',
      'academicYear',
      'classStatus',
      'gradeName',
      'ownerTeacher',
      'target',
      'expected',
      'provenance',
    ], 'Um item do plano');
    assertExactKeys(item.ownerTeacher, ['userId', 'name'], 'O professor do plano');
    assertExactKeys(item.target, [
      'municipalityPublicId',
      'municipalityName',
      'schoolPublicId',
      'schoolName',
    ], 'O destino do plano');
    assertExactKeys(item.expected, [
      'classRevision',
      'migrationStatus',
      'contextUpdatedAt',
    ], 'O snapshot do plano');
    const classPublicId = requiredText(item?.classPublicId, 'Identificador da turma', 20, 64);
    const key = classPublicId.toLowerCase();
    if (seen.has(key)) fail('duplicate_class', `Turma duplicada no plano: ${classPublicId}.`);
    seen.add(key);
    if (item?.provenance !== 'explicit_manual_mapping') {
      fail('invalid_provenance', `A turma ${classPublicId} não possui mapeamento explícito.`);
    }
    if (item?.expected?.migrationStatus !== 'pending') {
      fail('invalid_expected_status', `A turma ${classPublicId} não parte do estado pending.`);
    }
    if (!positiveInteger(item?.expected?.classRevision)) {
      fail('invalid_class_revision', `Revisão da turma inválida: ${classPublicId}.`);
    }
    requiredText(item?.expected?.contextUpdatedAt, 'Snapshot do contexto', 10, 64);
    requiredText(item?.target?.municipalityPublicId, 'Município de destino', 20, 64);
    requiredText(item?.target?.schoolPublicId, 'Escola de destino', 20, 64);
    if (!positiveInteger(item?.ownerTeacher?.userId)) {
      fail('invalid_owner', `Professor responsável inválido: ${classPublicId}.`);
    }
  });
  return { ...verified, plan: core };
}

function linkInstitutionalBackfillPlan(db, planArtifact, options = {}) {
  const validated = validatePlan(planArtifact);
  const actorUserId = positiveInteger(options.actorUserId);
  if (!actorUserId) fail('invalid_actor', 'Responsável pela vinculação inválido.');
  const reason = assertReason(options.reason);
  assertMutationGuard({
    appEnvironment: options.appEnvironment,
    confirmation: options.confirmation,
    operation: 'LINK',
    digest: validated.digest,
  });
  const linkedAt = normalizeTimestamp(options.linkedAt);

  const execute = db.transaction(() => {
    const municipality = findMunicipalityByPublicId(
      db,
      validated.plan.scope?.municipalityPublicId,
    );
    if (!municipality || municipality.status !== 'active') {
      fail('municipality_unavailable', 'O município do plano não está mais ativo.');
    }
    const authorization = authorizeMunicipalityAggregate(db, actorUserId, municipality.id);
    if (!authorization.allowed) {
      fail('municipality_scope_denied', 'O responsável não pode vincular turmas deste município.');
    }

    const receiptItems = validated.plan.items.map((item) => {
      const school = findSchoolByPublicId(db, municipality.id, item.target.schoolPublicId);
      const schoolClass = findClassByPublicId(db, item.classPublicId);
      if (!school || school.status !== 'active' || !schoolClass) {
        fail('stale_plan', `O destino ou a turma deixou de estar disponível: ${item.classPublicId}.`);
      }
      if (
        schoolClass.owner_teacher_id !== item.ownerTeacher.userId
        || schoolClass.class_revision !== item.expected.classRevision
      ) {
        fail('stale_plan', `A turma foi alterada depois do plano: ${item.classPublicId}.`);
      }
      assertActiveTeacherMembership(
        db,
        schoolClass.owner_teacher_id,
        municipality.id,
        school.id,
      );

      let outcome;
      if (schoolClass.migration_status === 'pending') {
        if (schoolClass.context_updated_at !== item.expected.contextUpdatedAt) {
          fail('stale_plan', `O contexto institucional mudou: ${item.classPublicId}.`);
        }
        const result = db.prepare(`
          UPDATE school_class_institution_contexts
          SET municipality_id = ?,
              school_id = ?,
              migration_status = 'linked',
              linked_by = ?,
              linked_at = ?,
              updated_at = ?
          WHERE class_id = ?
            AND migration_status = 'pending'
            AND updated_at = ?
        `).run(
          municipality.id,
          school.id,
          actorUserId,
          linkedAt,
          linkedAt,
          schoolClass.class_id,
          item.expected.contextUpdatedAt,
        );
        if (result.changes !== 1) {
          fail('concurrent_change', `Concorrência detectada na turma ${item.classPublicId}.`);
        }
        recordInstitutionalAudit(db, {
          actorUserId,
          responsibleUserId: schoolClass.owner_teacher_id,
          action: 'backfill_link_class_context',
          entityType: 'school_class_context',
          entityKey: schoolClass.class_public_id,
          municipalityId: municipality.id,
          schoolId: school.id,
          reason,
          previous: { migrationStatus: 'pending' },
          current: {
            migrationStatus: 'linked',
            municipalityPublicId: municipality.public_id,
            schoolPublicId: school.public_id,
            planDigest: validated.digest,
          },
        });
        outcome = 'linked';
      } else if (
        ['linked', 'verified'].includes(schoolClass.migration_status)
        && schoolClass.municipality_id === municipality.id
        && schoolClass.school_id === school.id
      ) {
        outcome = schoolClass.migration_status === 'linked'
          ? 'already_linked'
          : 'already_verified';
      } else {
        fail('conflicting_context', `A turma já possui outro contexto: ${item.classPublicId}.`);
      }

      const current = findClassByPublicId(db, item.classPublicId);
      return {
        classPublicId: current.class_public_id,
        ownerTeacherUserId: current.owner_teacher_id,
        target: {
          municipalityPublicId: municipality.public_id,
          schoolPublicId: school.public_id,
        },
        classRevision: current.class_revision,
        migrationStatus: current.migration_status,
        linkedByUserId: current.linked_by,
        linkedAt: current.linked_at,
        contextUpdatedAt: current.context_updated_at,
        outcome,
      };
    });

    return sealArtifact({
      format: LINK_RECEIPT_FORMAT,
      formatVersion: ARTIFACT_VERSION,
      generatedAt: linkedAt,
      planDigest: validated.digest,
      requestedByUserId: actorUserId,
      scope: validated.plan.scope,
      policy: {
        partialApplication: false,
        secondPersonVerificationRequired: true,
        aggregateAccessGranted: false,
      },
      items: receiptItems,
    }, 'receiptDigest');
  });

  return execute();
}

function validateLinkReceipt(receipt) {
  const verified = verifyArtifactDigest(receipt, 'receiptDigest');
  const { core } = verified;
  assertExactKeys(core, [
    'format',
    'formatVersion',
    'generatedAt',
    'planDigest',
    'requestedByUserId',
    'scope',
    'policy',
    'items',
  ], 'O recibo de vínculo');
  assertExactKeys(core.scope, ['municipalityPublicId', 'municipalityName'], 'O escopo do recibo');
  assertExactKeys(core.policy, [
    'partialApplication',
    'secondPersonVerificationRequired',
    'aggregateAccessGranted',
  ], 'A política do recibo');
  if (core.format !== LINK_RECEIPT_FORMAT || core.formatVersion !== ARTIFACT_VERSION) {
    fail('unsupported_receipt', 'Formato ou versão do recibo de vinculação não suportado.');
  }
  if (
    core.policy.partialApplication !== false
    || core.policy.secondPersonVerificationRequired !== true
    || core.policy.aggregateAccessGranted !== false
  ) {
    fail('unsafe_receipt_policy', 'A política segura do recibo foi alterada.');
  }
  if (!/^[a-f0-9]{64}$/.test(String(core.planDigest || ''))) {
    fail('invalid_plan_digest', 'O recibo não referencia um plano válido.');
  }
  if (!positiveInteger(core.requestedByUserId)) {
    fail('invalid_receipt_actor', 'O recibo não identifica o solicitante da vinculação.');
  }
  normalizeTimestamp(core.generatedAt);
  if (!Array.isArray(core.items) || core.items.length < 1 || core.items.length > MAX_PLAN_ITEMS) {
    fail('invalid_receipt_items', 'Quantidade de itens do recibo inválida.');
  }
  const seen = new Set();
  core.items.forEach((item) => {
    assertExactKeys(item, [
      'classPublicId',
      'ownerTeacherUserId',
      'target',
      'classRevision',
      'migrationStatus',
      'linkedByUserId',
      'linkedAt',
      'contextUpdatedAt',
      'outcome',
    ], 'Um item do recibo');
    assertExactKeys(item.target, [
      'municipalityPublicId',
      'schoolPublicId',
    ], 'O destino do recibo');
    const classPublicId = requiredText(item?.classPublicId, 'Identificador da turma', 20, 64);
    const key = classPublicId.toLowerCase();
    if (seen.has(key)) fail('duplicate_class', `Turma duplicada no recibo: ${classPublicId}.`);
    seen.add(key);
    if (!positiveInteger(item?.ownerTeacherUserId) || !positiveInteger(item?.linkedByUserId)) {
      fail('invalid_receipt_actor', `Responsáveis inválidos no recibo: ${classPublicId}.`);
    }
    if (!['linked', 'verified'].includes(item?.migrationStatus)) {
      fail('invalid_receipt_status', `Estado inválido no recibo: ${classPublicId}.`);
    }
    requiredText(item?.linkedAt, 'Data de vinculação', 10, 64);
    requiredText(item?.contextUpdatedAt, 'Snapshot do contexto', 10, 64);
    requiredText(item?.target?.municipalityPublicId, 'Município de destino', 20, 64);
    requiredText(item?.target?.schoolPublicId, 'Escola de destino', 20, 64);
  });
  return { ...verified, receipt: core };
}

function verifyInstitutionalBackfillReceipt(db, receiptArtifact, options = {}) {
  const validated = validateLinkReceipt(receiptArtifact);
  const reviewerUserId = positiveInteger(options.reviewerUserId);
  if (!reviewerUserId) fail('invalid_reviewer', 'Responsável pela verificação inválido.');
  const reason = assertReason(options.reason);
  assertMutationGuard({
    appEnvironment: options.appEnvironment,
    confirmation: options.confirmation,
    operation: 'VERIFY',
    digest: validated.digest,
  });
  const verifiedAt = normalizeTimestamp(options.verifiedAt);

  const execute = db.transaction(() => {
    const verificationItems = validated.receipt.items.map((item) => {
      const municipality = findMunicipalityByPublicId(
        db,
        item.target.municipalityPublicId,
      );
      const school = municipality
        ? findSchoolByPublicId(db, municipality.id, item.target.schoolPublicId)
        : null;
      const schoolClass = findClassByPublicId(db, item.classPublicId);
      if (!municipality || municipality.status !== 'active' || !school || !schoolClass) {
        fail('stale_receipt', `Escopo indisponível para a turma ${item.classPublicId}.`);
      }
      const authorization = authorizeSchoolAggregate(
        db,
        reviewerUserId,
        municipality.id,
        school.id,
      );
      if (!authorization.allowed) {
        fail('school_scope_denied', `O revisor não pode verificar a turma ${item.classPublicId}.`);
      }
      if (reviewerUserId === schoolClass.owner_teacher_id) {
        fail('owner_cannot_verify', `O professor da turma não pode verificá-la: ${item.classPublicId}.`);
      }
      if (reviewerUserId === item.linkedByUserId) {
        fail('second_person_required', `A turma exige uma segunda pessoa: ${item.classPublicId}.`);
      }
      if (
        schoolClass.owner_teacher_id !== item.ownerTeacherUserId
        || schoolClass.class_revision !== item.classRevision
        || schoolClass.municipality_id !== municipality.id
        || schoolClass.school_id !== school.id
        || schoolClass.linked_by !== item.linkedByUserId
        || schoolClass.linked_at !== item.linkedAt
      ) {
        fail('stale_receipt', `O contexto mudou depois da vinculação: ${item.classPublicId}.`);
      }
      assertActiveTeacherMembership(
        db,
        schoolClass.owner_teacher_id,
        municipality.id,
        school.id,
      );

      let outcome;
      if (schoolClass.migration_status === 'linked') {
        if (schoolClass.context_updated_at !== item.contextUpdatedAt) {
          fail('stale_receipt', `O contexto mudou antes da verificação: ${item.classPublicId}.`);
        }
        const result = db.prepare(`
          UPDATE school_class_institution_contexts
          SET migration_status = 'verified',
              verified_by = ?,
              verified_at = ?,
              updated_at = ?
          WHERE class_id = ?
            AND migration_status = 'linked'
            AND municipality_id = ?
            AND school_id = ?
            AND linked_by = ?
            AND linked_at = ?
            AND updated_at = ?
        `).run(
          reviewerUserId,
          verifiedAt,
          verifiedAt,
          schoolClass.class_id,
          municipality.id,
          school.id,
          item.linkedByUserId,
          item.linkedAt,
          item.contextUpdatedAt,
        );
        if (result.changes !== 1) {
          fail('concurrent_change', `Concorrência detectada na turma ${item.classPublicId}.`);
        }
        recordInstitutionalAudit(db, {
          actorUserId: reviewerUserId,
          responsibleUserId: schoolClass.owner_teacher_id,
          action: 'backfill_verify_class_context',
          entityType: 'school_class_context',
          entityKey: schoolClass.class_public_id,
          municipalityId: municipality.id,
          schoolId: school.id,
          reason,
          previous: {
            migrationStatus: 'linked',
            receiptDigest: validated.digest,
          },
          current: {
            migrationStatus: 'verified',
            municipalityPublicId: municipality.public_id,
            schoolPublicId: school.public_id,
            receiptDigest: validated.digest,
          },
        });
        outcome = 'verified';
      } else if (schoolClass.migration_status === 'verified') {
        outcome = 'already_verified';
      } else {
        fail('stale_receipt', `A turma não está vinculada: ${item.classPublicId}.`);
      }

      const current = findClassByPublicId(db, item.classPublicId);
      return {
        classPublicId: current.class_public_id,
        migrationStatus: current.migration_status,
        verifiedByUserId: current.verified_by,
        verifiedAt: current.verified_at,
        outcome,
      };
    });

    return sealArtifact({
      format: VERIFICATION_RECEIPT_FORMAT,
      formatVersion: ARTIFACT_VERSION,
      generatedAt: verifiedAt,
      linkReceiptDigest: validated.digest,
      requestedByUserId: reviewerUserId,
      policy: {
        partialApplication: false,
        aggregateAccessGrantedOnlyForVerifiedContexts: true,
      },
      items: verificationItems,
    }, 'verificationDigest');
  });

  return execute();
}

function authorizeBackfillDiagnostic(db, userId, municipalityPublicId = null) {
  const normalizedUserId = positiveInteger(userId);
  if (!normalizedUserId) return { allowed: false, reason: 'principal_not_found' };
  if (municipalityPublicId) {
    const municipality = findMunicipalityByPublicId(db, municipalityPublicId);
    if (!municipality || municipality.status !== 'active') {
      return { allowed: false, reason: 'municipality_unavailable' };
    }
    return authorizeMunicipalityAggregate(db, normalizedUserId, municipality.id);
  }
  const principal = getInstitutionalPrincipal(db, normalizedUserId);
  return principal?.isLabAdmin
    ? { allowed: true, reason: 'lab_admin', principal }
    : { allowed: false, reason: 'global_diagnostic_requires_lab_admin', principal };
}

module.exports = {
  ARTIFACT_VERSION,
  InstitutionalBackfillError,
  LINK_RECEIPT_FORMAT,
  MAX_DIAGNOSTIC_ITEMS,
  MAX_PLAN_ITEMS,
  PLAN_FORMAT,
  VERIFICATION_RECEIPT_FORMAT,
  authorizeBackfillDiagnostic,
  calculateArtifactDigest,
  createInstitutionalBackfillDiagnostic,
  createInstitutionalBackfillPlan,
  linkInstitutionalBackfillPlan,
  validateLinkReceipt,
  validatePlan,
  verifyArtifactDigest,
  verifyInstitutionalBackfillReceipt,
};
