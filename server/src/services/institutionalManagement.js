const crypto = require('node:crypto');
const passwords = require('./passwordOperations');
const { v4: uuidv4 } = require('uuid');

const { recordInstitutionalAudit } = require('./institutionalAccess');
const { protectProfessionalFingerprint } = require('./institutionalReceiptFingerprint');

const FEATURE_KEY = 'institutions.management_pilot';
const IDEMPOTENCY_PATTERN = /^[A-Za-z0-9._:-]+$/;
const MEMBERSHIP_ROLES = new Set([
  'municipal_manager',
  'school_manager',
  'school_coordinator',
  'teacher',
]);

class InstitutionalManagementError extends Error {
  constructor(status, code, message, details = undefined) {
    super(message);
    this.name = 'InstitutionalManagementError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

function fail(status, code, message, details) {
  throw new InstitutionalManagementError(status, code, message, details);
}

function requiredText(value, field, minimum, maximum) {
  if (typeof value !== 'string') fail(400, 'invalid_request', `${field} é obrigatório.`);
  if (/[\u0000-\u001F\u007F]/.test(value)) {
    fail(400, 'invalid_request', `${field} contém caracteres não permitidos.`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length < minimum || normalized.length > maximum) {
    fail(400, 'invalid_request', `${field} deve ter entre ${minimum} e ${maximum} caracteres.`);
  }
  return normalized;
}

function optionalText(value, field, maximum) {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  return requiredText(String(value), field, 1, maximum);
}

function positiveInteger(value, field) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    fail(400, 'invalid_request', `${field} é inválido.`);
  }
  return number;
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
    fail(400, 'idempotency_key_required', 'Envie uma chave de idempotência para concluir a operação.');
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

function currentPrincipal(database, actor) {
  const actorId = positiveInteger(actor?.id, 'O usuário');
  const principal = database.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE id = ?
  `).get(actorId);
  if (!principal) fail(401, 'invalid_principal', 'A sessão não corresponde a um usuário ativo.');
  return principal;
}

function requireAdmin(principal) {
  if (principal.role !== 'admin') {
    fail(403, 'admin_required', 'A configuração da rede é exclusiva da administração geral neste piloto.');
  }
}

function requestAudit(requestMetadata = {}) {
  return {
    ipAddress: requestMetadata.ipAddress || null,
    userAgent: requestMetadata.userAgent || null,
  };
}

function operationReplay(database, principal, keyHash, operationType, requestFingerprint) {
  const operation = database.prepare(`
    SELECT operation_type, request_fingerprint, result_json
    FROM institutional_write_operations
    WHERE actor_user_id = ? AND idempotency_key_hash = ?
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

// Reads an existing receipt only; absence does not prove an in-flight request failed.
function getInstitutionalOperation(database, { actor, idempotencyKey }) {
  const principal = currentPrincipal(database, actor);
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const operation = database.prepare(`SELECT operation_type, result_json FROM institutional_write_operations
    WHERE actor_user_id = ? AND idempotency_key_hash = ?`).get(principal.id, keyHash);
  if (!operation || (principal.role !== 'admin' && operation.operation_type !== 'confirm_guided_class')) return { found: false };
  return { found: true, operationType: operation.operation_type, result: { ...JSON.parse(operation.result_json), replayed: true } };
}

function runIdempotent(database, {
  principal,
  idempotencyKey,
  operationType,
  fingerprintPayload,
  fingerprintRequest = fingerprint,
  perform,
}) {
  const keyHash = normalizeIdempotencyKey(idempotencyKey);
  const requestFingerprint = fingerprintRequest({ operationType, ...fingerprintPayload });
  return database.transaction(() => {
    const replay = operationReplay(
      database,
      principal,
      keyHash,
      operationType,
      requestFingerprint,
    );
    if (replay) return { ...replay, replayed: true };

    const performed = perform();
    database.prepare(`
      INSERT INTO institutional_write_operations (
        public_id,
        operation_type,
        actor_user_id,
        entity_type,
        entity_key,
        idempotency_key_hash,
        request_fingerprint,
        result_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      operationType,
      principal.id,
      performed.entityType,
      performed.entityKey,
      keyHash,
      requestFingerprint,
      JSON.stringify(performed.result),
    );
    return { ...performed.result, replayed: false };
  })();
}

function serializeMunicipality(row) {
  return {
    publicId: row.public_id,
    name: row.name,
    ibgeCode: row.ibge_code,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeSchool(row) {
  return {
    publicId: row.public_id,
    municipalityPublicId: row.municipality_public_id,
    municipalityName: row.municipality_name,
    name: row.name,
    censusCode: row.census_code,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeMembership(row) {
  return {
    publicId: row.public_id,
    userId: row.user_id,
    professionalName: row.professional_name,
    professionalEmail: row.professional_email,
    role: row.role,
    municipalityPublicId: row.municipality_public_id,
    municipalityName: row.municipality_name,
    schoolPublicId: row.school_public_id,
    schoolName: row.school_name,
    status: row.status,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeGuidedClass(row) {
  return {
    publicId: row.public_id,
    name: row.name,
    academicYear: row.academic_year,
    grade: { id: row.grade_id, name: row.grade_name },
    teacher: {
      id: row.owner_teacher_id,
      name: row.teacher_name,
      email: row.teacher_email,
    },
    municipalityPublicId: row.municipality_public_id,
    municipalityName: row.municipality_name,
    schoolPublicId: row.school_public_id,
    schoolName: row.school_name,
    migrationStatus: row.migration_status,
    origin: row.origin,
    contextUpdatedAt: row.context_updated_at,
    linkedAt: row.linked_at,
    verifiedAt: row.verified_at,
  };
}

function loadMunicipality(database, municipalityPublicId, { activeOnly = true } = {}) {
  const normalized = publicId(municipalityPublicId, 'O município');
  const row = database.prepare(`
    SELECT * FROM municipalities
    WHERE public_id = ? COLLATE NOCASE
      ${activeOnly ? "AND status = 'active'" : ''}
  `).get(normalized);
  if (!row) fail(404, 'municipality_not_found', 'Município não encontrado ou indisponível.');
  return row;
}

function loadSchool(database, municipalityId, schoolPublicId, { activeOnly = true } = {}) {
  const normalized = publicId(schoolPublicId, 'A escola');
  const row = database.prepare(`
    SELECT school.*,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name
    FROM schools school
    JOIN municipalities municipality ON municipality.id = school.municipality_id
    WHERE school.public_id = ? COLLATE NOCASE
      AND school.municipality_id = ?
      ${activeOnly ? "AND school.status = 'active' AND municipality.status = 'active'" : ''}
  `).get(normalized, municipalityId);
  if (!row) fail(404, 'school_not_found', 'Escola não encontrada nesse município.');
  return row;
}

function loadMembership(database, membershipPublicId) {
  const normalized = publicId(membershipPublicId, 'O vínculo profissional');
  const row = database.prepare(`
    SELECT membership.*,
      professional.name AS professional_name,
      professional.email AS professional_email,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      school.public_id AS school_public_id,
      school.name AS school_name
    FROM institutional_memberships membership
    JOIN users professional ON professional.id = membership.user_id
    JOIN municipalities municipality ON municipality.id = membership.municipality_id
    LEFT JOIN schools school ON school.id = membership.school_id
    WHERE membership.public_id = ? COLLATE NOCASE
  `).get(normalized);
  if (!row) fail(404, 'membership_not_found', 'Vínculo profissional não encontrado.');
  return row;
}

function validateIbgeCode(value) {
  const code = optionalText(value, 'O código IBGE', 7);
  if (code && !/^\d{7}$/.test(code)) {
    fail(400, 'invalid_ibge_code', 'O código IBGE deve conter exatamente sete números.');
  }
  return code;
}

function validateEmail(value) {
  const email = requiredText(value, 'O e-mail', 5, 254).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail(400, 'invalid_email', 'Informe um e-mail válido.');
  }
  return email;
}

function validateRole(value) {
  const role = String(value || '').trim();
  if (!MEMBERSHIP_ROLES.has(role)) {
    fail(400, 'invalid_membership_role', 'Selecione um papel institucional válido.');
  }
  return role;
}

function resolveScope(database, { municipalityPublicId, schoolPublicId, role }) {
  const municipality = loadMunicipality(database, municipalityPublicId);
  let school = null;
  if (role === 'municipal_manager') {
    if (schoolPublicId !== undefined && schoolPublicId !== null && String(schoolPublicId).trim()) {
      fail(400, 'invalid_membership_scope', 'A gestão municipal não deve apontar para uma escola.');
    }
  } else {
    school = loadSchool(database, municipality.id, schoolPublicId);
  }
  return { municipality, school };
}

function managementStateForAdmin(database) {
  const municipalities = database.prepare(`
    SELECT * FROM municipalities
    ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, name COLLATE NOCASE
  `).all().map(serializeMunicipality);
  const schools = database.prepare(`
    SELECT school.*,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name
    FROM schools school
    JOIN municipalities municipality ON municipality.id = school.municipality_id
    ORDER BY municipality.name COLLATE NOCASE, school.name COLLATE NOCASE
  `).all().map(serializeSchool);
  const memberships = database.prepare(`
    SELECT membership.*,
      professional.name AS professional_name,
      professional.email AS professional_email,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      school.public_id AS school_public_id,
      school.name AS school_name
    FROM institutional_memberships membership
    JOIN users professional ON professional.id = membership.user_id
    JOIN municipalities municipality ON municipality.id = membership.municipality_id
    LEFT JOIN schools school ON school.id = membership.school_id
    ORDER BY professional.name COLLATE NOCASE, municipality.name, school.name, membership.role
  `).all().map(serializeMembership);
  const professionals = database.prepare(`
    SELECT id, name, email, created_at
    FROM users
    WHERE role = 'professor'
    ORDER BY name COLLATE NOCASE, id
  `).all().map((row) => ({
    id: row.id,
    name: row.name,
    email: row.email,
    createdAt: row.created_at,
  }));
  const grades = database.prepare(`
    SELECT id, name FROM grades ORDER BY sort_order, name COLLATE NOCASE
  `).all();
  const disciplines = database.prepare(`
    SELECT id, name FROM disciplines ORDER BY name COLLATE NOCASE
  `).all();
  const guidedClasses = database.prepare(`
    SELECT school_class.*,
      grade.name AS grade_name,
      teacher.name AS teacher_name,
      teacher.email AS teacher_email,
      context.migration_status,
      context.origin,
      context.updated_at AS context_updated_at,
      context.linked_at,
      context.verified_at,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      school.public_id AS school_public_id,
      school.name AS school_name
    FROM school_classes school_class
    JOIN grades grade ON grade.id = school_class.grade_id
    JOIN users teacher ON teacher.id = school_class.owner_teacher_id
    JOIN school_class_institution_contexts context ON context.class_id = school_class.id
    JOIN municipalities municipality ON municipality.id = context.municipality_id
    JOIN schools school ON school.id = context.school_id
    WHERE context.origin = 'guided_pilot'
    ORDER BY school_class.created_at DESC, school_class.id DESC
    LIMIT 100
  `).all().map(serializeGuidedClass);

  return {
    mode: 'admin',
    environment: 'homologation',
    writable: true,
    municipalities,
    schools,
    professionals,
    memberships,
    teacherMemberships: memberships.filter((item) => item.role === 'teacher' && item.status === 'active'),
    grades,
    disciplines,
    guidedClasses,
    progress: {
      municipalityReady: municipalities.some((item) => item.status === 'active'),
      schoolReady: schools.some((item) => item.status === 'active'),
      teacherReady: memberships.some((item) => item.role === 'teacher' && item.status === 'active'),
      classReady: guidedClasses.some((item) => item.migrationStatus === 'verified'),
    },
  };
}

function managementStateForProfessional(database, principal) {
  const guidedClasses = database.prepare(`
    SELECT school_class.*,
      grade.name AS grade_name,
      teacher.name AS teacher_name,
      teacher.email AS teacher_email,
      context.migration_status,
      context.origin,
      context.updated_at AS context_updated_at,
      context.linked_at,
      context.verified_at,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      school.public_id AS school_public_id,
      school.name AS school_name
    FROM school_classes school_class
    JOIN grades grade ON grade.id = school_class.grade_id
    JOIN users teacher ON teacher.id = school_class.owner_teacher_id
    JOIN school_class_institution_contexts context ON context.class_id = school_class.id
    JOIN municipalities municipality ON municipality.id = context.municipality_id
    JOIN schools school ON school.id = context.school_id
    WHERE school_class.owner_teacher_id = ?
      AND context.origin = 'guided_pilot'
    ORDER BY school_class.created_at DESC, school_class.id DESC
  `).all(principal.id).map(serializeGuidedClass);
  return {
    mode: 'professional',
    environment: 'homologation',
    writable: true,
    guidedClasses,
    pendingConfirmations: guidedClasses.filter((item) => item.migrationStatus === 'linked'),
  };
}

function getInstitutionalManagementState(database, { actor }) {
  const principal = currentPrincipal(database, actor);
  return principal.role === 'admin'
    ? managementStateForAdmin(database)
    : managementStateForProfessional(database, principal);
}

function createMunicipality(database, {
  actor,
  name,
  ibgeCode,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const normalizedName = requiredText(name, 'O nome do município', 2, 160);
  const normalizedIbgeCode = validateIbgeCode(ibgeCode);
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_municipality',
    fingerprintPayload: { name: normalizedName, ibgeCode: normalizedIbgeCode },
    perform() {
      if (normalizedIbgeCode && database.prepare(`
        SELECT 1 FROM municipalities WHERE ibge_code = ? COLLATE NOCASE
      `).get(normalizedIbgeCode)) {
        fail(409, 'ibge_code_conflict', 'Já existe um município com esse código IBGE.');
      }
      const municipalityPublicId = uuidv4();
      database.prepare(`
        INSERT INTO municipalities (
          public_id, name, ibge_code, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?)
      `).run(municipalityPublicId, normalizedName, normalizedIbgeCode, principal.id, principal.id);
      const municipality = database.prepare(`
        SELECT * FROM municipalities WHERE public_id = ?
      `).get(municipalityPublicId);
      const result = { municipality: serializeMunicipality(municipality) };
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: principal.id,
        action: 'create_municipality',
        entityType: 'municipality',
        entityKey: municipalityPublicId,
        municipalityId: municipality.id,
        reason: 'Cadastro operacional guiado realizado na homologação.',
        current: result.municipality,
        ...requestAudit(requestMetadata),
      });
      return { result, entityType: 'municipality', entityKey: municipalityPublicId };
    },
  });
}

function updateMunicipality(database, {
  actor,
  municipalityPublicId,
  name,
  ibgeCode,
  expectedRevision,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const existing = loadMunicipality(database, municipalityPublicId);
  const normalizedName = requiredText(name, 'O nome do município', 2, 160);
  const normalizedIbgeCode = validateIbgeCode(ibgeCode);
  const revision = positiveInteger(expectedRevision, 'A revisão do município');
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'update_municipality',
    fingerprintPayload: {
      municipalityPublicId: existing.public_id,
      name: normalizedName,
      ibgeCode: normalizedIbgeCode,
      expectedRevision: revision,
    },
    perform() {
      if (normalizedIbgeCode && database.prepare(`
        SELECT 1 FROM municipalities WHERE ibge_code = ? AND id <> ?
      `).get(normalizedIbgeCode, existing.id)) {
        fail(409, 'ibge_code_conflict', 'Já existe outro município com esse código IBGE.');
      }
      const updated = database.prepare(`
        UPDATE municipalities
        SET name = ?, ibge_code = ?, revision = revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revision = ?
      `).run(normalizedName, normalizedIbgeCode, principal.id, existing.id, revision);
      if (!updated.changes) {
        fail(409, 'stale_revision', 'O município foi alterado em outra sessão. Atualize a tela.');
      }
      const current = database.prepare('SELECT * FROM municipalities WHERE id = ?').get(existing.id);
      const result = { municipality: serializeMunicipality(current) };
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: principal.id,
        action: 'update_municipality',
        entityType: 'municipality',
        entityKey: existing.public_id,
        municipalityId: existing.id,
        reason: 'Correção cadastral explícita realizada na homologação.',
        previous: serializeMunicipality(existing),
        current: result.municipality,
        ...requestAudit(requestMetadata),
      });
      return { result, entityType: 'municipality', entityKey: existing.public_id };
    },
  });
}

function createSchool(database, {
  actor,
  municipalityPublicId,
  name,
  censusCode,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const municipality = loadMunicipality(database, municipalityPublicId);
  const normalizedName = requiredText(name, 'O nome da escola', 2, 180);
  const normalizedCensusCode = optionalText(censusCode, 'O código da escola', 32);
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_school',
    fingerprintPayload: {
      municipalityPublicId: municipality.public_id,
      name: normalizedName,
      censusCode: normalizedCensusCode,
    },
    perform() {
      if (normalizedCensusCode && database.prepare(`
        SELECT 1 FROM schools WHERE municipality_id = ? AND census_code = ? COLLATE NOCASE
      `).get(municipality.id, normalizedCensusCode)) {
        fail(409, 'census_code_conflict', 'Já existe uma escola com esse código no município.');
      }
      const schoolPublicId = uuidv4();
      database.prepare(`
        INSERT INTO schools (
          public_id, municipality_id, name, census_code, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?)
      `).run(
        schoolPublicId,
        municipality.id,
        normalizedName,
        normalizedCensusCode,
        principal.id,
        principal.id,
      );
      const school = loadSchool(database, municipality.id, schoolPublicId);
      const result = { school: serializeSchool(school) };
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: principal.id,
        action: 'create_school',
        entityType: 'school',
        entityKey: schoolPublicId,
        municipalityId: municipality.id,
        schoolId: school.id,
        reason: 'Cadastro operacional guiado realizado na homologação.',
        current: result.school,
        ...requestAudit(requestMetadata),
      });
      return { result, entityType: 'school', entityKey: schoolPublicId };
    },
  });
}

function updateSchool(database, {
  actor,
  municipalityPublicId,
  schoolPublicId,
  name,
  censusCode,
  expectedRevision,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const municipality = loadMunicipality(database, municipalityPublicId);
  const existing = loadSchool(database, municipality.id, schoolPublicId);
  const normalizedName = requiredText(name, 'O nome da escola', 2, 180);
  const normalizedCensusCode = optionalText(censusCode, 'O código da escola', 32);
  const revision = positiveInteger(expectedRevision, 'A revisão da escola');
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'update_school',
    fingerprintPayload: {
      municipalityPublicId: municipality.public_id,
      schoolPublicId: existing.public_id,
      name: normalizedName,
      censusCode: normalizedCensusCode,
      expectedRevision: revision,
    },
    perform() {
      if (normalizedCensusCode && database.prepare(`
        SELECT 1 FROM schools
        WHERE municipality_id = ? AND census_code = ? COLLATE NOCASE AND id <> ?
      `).get(municipality.id, normalizedCensusCode, existing.id)) {
        fail(409, 'census_code_conflict', 'Já existe outra escola com esse código no município.');
      }
      const updated = database.prepare(`
        UPDATE schools
        SET name = ?, census_code = ?, revision = revision + 1,
            updated_by = ?, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND revision = ?
      `).run(normalizedName, normalizedCensusCode, principal.id, existing.id, revision);
      if (!updated.changes) {
        fail(409, 'stale_revision', 'A escola foi alterada em outra sessão. Atualize a tela.');
      }
      const current = loadSchool(database, municipality.id, existing.public_id);
      const result = { school: serializeSchool(current) };
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: principal.id,
        action: 'update_school',
        entityType: 'school',
        entityKey: existing.public_id,
        municipalityId: municipality.id,
        schoolId: existing.id,
        reason: 'Correção cadastral explícita realizada na homologação.',
        previous: serializeSchool(existing),
        current: result.school,
        ...requestAudit(requestMetadata),
      });
      return { result, entityType: 'school', entityKey: existing.public_id };
    },
  });
}

function createMembershipForUser(database, {
  principal,
  user,
  role,
  municipality,
  school,
  requestMetadata,
  action = 'create_membership',
}) {
  const existing = database.prepare(`
    SELECT * FROM institutional_memberships
    WHERE user_id = ? AND municipality_id = ?
      AND role = ?
      AND school_id IS ?
  `).get(user.id, municipality.id, role, school?.id || null);
  if (existing?.status === 'active') {
    fail(409, 'membership_exists', 'Esse profissional já possui o vínculo informado.');
  }

  let membershipPublicId;
  let previous = null;
  if (existing) {
    membershipPublicId = existing.public_id;
    previous = { status: existing.status, revision: existing.revision };
    database.prepare(`
      UPDATE institutional_memberships
      SET status = 'active', ended_at = NULL, revision = revision + 1,
          updated_by = ?, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'inactive'
    `).run(principal.id, existing.id);
  } else {
    membershipPublicId = uuidv4();
    database.prepare(`
      INSERT INTO institutional_memberships (
        public_id, user_id, role, municipality_id, school_id, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      membershipPublicId,
      user.id,
      role,
      municipality.id,
      school?.id || null,
      principal.id,
      principal.id,
    );
  }
  const membership = loadMembership(database, membershipPublicId);
  const serialized = serializeMembership(membership);
  recordInstitutionalAudit(database, {
    actorUserId: principal.id,
    responsibleUserId: user.id,
    action,
    entityType: 'membership',
    entityKey: membershipPublicId,
    municipalityId: municipality.id,
    schoolId: school?.id || null,
    reason: 'Vínculo profissional confirmado manualmente na homologação.',
    previous,
    current: serialized,
    ...requestAudit(requestMetadata),
  });
  return serialized;
}

function createMembership(database, {
  actor,
  userId,
  role,
  municipalityPublicId,
  schoolPublicId,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const professionalId = positiveInteger(userId, 'O profissional');
  const user = database.prepare(`
    SELECT id, name, email, role FROM users WHERE id = ?
  `).get(professionalId);
  if (!user || user.role !== 'professor') {
    fail(404, 'professional_not_found', 'Profissional não encontrado ou incompatível com o vínculo.');
  }
  const normalizedRole = validateRole(role);
  const { municipality, school } = resolveScope(database, {
    municipalityPublicId,
    schoolPublicId,
    role: normalizedRole,
  });
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_membership',
    fingerprintPayload: {
      userId: user.id,
      role: normalizedRole,
      municipalityPublicId: municipality.public_id,
      schoolPublicId: school?.public_id || null,
    },
    perform() {
      const membership = createMembershipForUser(database, {
        principal,
        user,
        role: normalizedRole,
        municipality,
        school,
        requestMetadata,
      });
      return {
        result: { membership },
        entityType: 'membership',
        entityKey: membership.publicId,
      };
    },
  });
}

async function createProfessional(database, {
  actor,
  name,
  email,
  temporaryPassword,
  role,
  municipalityPublicId,
  schoolPublicId,
  idempotencyKey,
  requestMetadata,
  fingerprintSecret,
  revalidate = () => {},
}) {
  requireAdmin(currentPrincipal(database, actor));
  const normalizedName = requiredText(name, 'O nome do profissional', 2, 100);
  const normalizedEmail = validateEmail(email);
  const password = requiredText(temporaryPassword, 'A senha temporária', 10, 200);
  const normalizedRole = validateRole(role);
  let { municipality, school } = resolveScope(database, {
    municipalityPublicId,
    schoolPublicId,
    role: normalizedRole,
  });
  // Validate before spending CPU; repeat scope/permission checks after the await.
  normalizeIdempotencyKey(idempotencyKey);
  const hash = await passwords.hash(password, 12);
  revalidate();
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  ({ municipality, school } = resolveScope(database, { municipalityPublicId, schoolPublicId, role: normalizedRole }));
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_professional',
    fingerprintRequest: payload => protectProfessionalFingerprint(fingerprint(payload), fingerprintSecret),
    fingerprintPayload: {
      name: normalizedName,
      email: normalizedEmail,
      passwordHash: sha256(password),
      role: normalizedRole,
      municipalityPublicId: municipality.public_id,
      schoolPublicId: school?.public_id || null,
    },
    perform() {
      if (database.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(normalizedEmail)) {
        fail(409, 'email_conflict', 'Já existe uma conta com esse e-mail. Vincule a conta existente.');
      }
      const userId = Number(database.prepare(`
        INSERT INTO users (name, email, password, role)
        VALUES (?, ?, ?, 'professor')
      `).run(normalizedName, normalizedEmail, hash).lastInsertRowid);
      const user = database.prepare(`
        SELECT id, name, email, role, created_at FROM users WHERE id = ?
      `).get(userId);
      const membership = createMembershipForUser(database, {
        principal,
        user,
        role: normalizedRole,
        municipality,
        school,
        requestMetadata,
        action: 'create_professional_membership',
      });
      return {
        result: {
          professional: {
            id: user.id,
            name: user.name,
            email: user.email,
            createdAt: user.created_at,
          },
          membership,
        },
        entityType: 'membership',
        entityKey: membership.publicId,
      };
    },
  });
}

function validateClassInput(database, { name, gradeId, academicYear, disciplineIds }) {
  const normalizedName = requiredText(name, 'O nome da turma', 2, 120);
  const normalizedGradeId = positiveInteger(gradeId, 'O ano escolar');
  const normalizedAcademicYear = positiveInteger(academicYear, 'O ano letivo');
  const currentYear = new Date().getFullYear();
  if (normalizedAcademicYear < 2000 || normalizedAcademicYear > currentYear + 5) {
    fail(400, 'invalid_academic_year', 'Informe um ano letivo válido.');
  }
  if (!Array.isArray(disciplineIds)) {
    fail(400, 'invalid_disciplines', 'Selecione ao menos um componente curricular.');
  }
  const normalizedDisciplineIds = [...new Set(
    disciplineIds.map((value) => positiveInteger(value, 'O componente curricular')),
  )];
  if (!normalizedDisciplineIds.length || normalizedDisciplineIds.length > 10) {
    fail(400, 'invalid_disciplines', 'Selecione entre um e dez componentes curriculares.');
  }
  const grade = database.prepare('SELECT id, name FROM grades WHERE id = ?').get(normalizedGradeId);
  const placeholders = normalizedDisciplineIds.map(() => '?').join(',');
  const disciplines = database.prepare(`
    SELECT id, name FROM disciplines WHERE id IN (${placeholders}) ORDER BY name
  `).all(...normalizedDisciplineIds);
  if (!grade || disciplines.length !== normalizedDisciplineIds.length) {
    fail(400, 'invalid_class_reference', 'Ano escolar ou componente curricular inválido.');
  }
  return {
    name: normalizedName,
    grade,
    academicYear: normalizedAcademicYear,
    disciplineIds: normalizedDisciplineIds,
    disciplines,
  };
}

function createGuidedClass(database, {
  actor,
  membershipPublicId,
  name,
  gradeId,
  academicYear,
  disciplineIds,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  requireAdmin(principal);
  const membership = loadMembership(database, membershipPublicId);
  if (membership.role !== 'teacher' || membership.status !== 'active' || !membership.school_id) {
    fail(409, 'active_teacher_membership_required', 'Selecione um vínculo docente ativo em uma escola.');
  }
  const input = validateClassInput(database, { name, gradeId, academicYear, disciplineIds });
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'create_guided_class',
    fingerprintPayload: {
      membershipPublicId: membership.public_id,
      name: input.name,
      gradeId: input.grade.id,
      academicYear: input.academicYear,
      disciplineIds: input.disciplineIds,
    },
    perform() {
      if (database.prepare(`
        SELECT 1 FROM school_classes
        WHERE owner_teacher_id = ? AND academic_year = ? AND name = ? COLLATE NOCASE
      `).get(membership.user_id, input.academicYear, input.name)) {
        fail(409, 'class_conflict', 'O professor já possui uma turma com esse nome no ano informado.');
      }
      const classPublicId = uuidv4();
      const classId = Number(database.prepare(`
        INSERT INTO school_classes (
          public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        classPublicId,
        membership.user_id,
        input.name,
        input.grade.id,
        input.academicYear,
        principal.id,
        principal.id,
      ).lastInsertRowid);
      const addDiscipline = database.prepare(`
        INSERT INTO school_class_disciplines (
          class_id, owner_teacher_id, discipline_id, added_by
        ) VALUES (?, ?, ?, ?)
      `);
      for (const disciplineId of input.disciplineIds) {
        addDiscipline.run(classId, membership.user_id, disciplineId, principal.id);
      }
      const linked = database.prepare(`
        UPDATE school_class_institution_contexts
        SET municipality_id = ?, school_id = ?, migration_status = 'linked',
            origin = 'guided_pilot', linked_by = ?, linked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ? AND migration_status = 'pending' AND origin = 'legacy'
      `).run(membership.municipality_id, membership.school_id, principal.id, classId);
      if (!linked.changes) fail(409, 'class_context_conflict', 'O contexto da turma não pôde ser preparado.');
      const row = database.prepare(`
        SELECT school_class.*,
          grade.name AS grade_name,
          teacher.name AS teacher_name,
          teacher.email AS teacher_email,
          context.migration_status,
          context.origin,
          context.updated_at AS context_updated_at,
          context.linked_at,
          context.verified_at,
          municipality.public_id AS municipality_public_id,
          municipality.name AS municipality_name,
          school.public_id AS school_public_id,
          school.name AS school_name
        FROM school_classes school_class
        JOIN grades grade ON grade.id = school_class.grade_id
        JOIN users teacher ON teacher.id = school_class.owner_teacher_id
        JOIN school_class_institution_contexts context ON context.class_id = school_class.id
        JOIN municipalities municipality ON municipality.id = context.municipality_id
        JOIN schools school ON school.id = context.school_id
        WHERE school_class.id = ?
      `).get(classId);
      const schoolClass = serializeGuidedClass(row);
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: membership.user_id,
        action: 'create_guided_class_context',
        entityType: 'school_class_context',
        entityKey: classPublicId,
        municipalityId: membership.municipality_id,
        schoolId: membership.school_id,
        reason: 'Turma preparada pela administração e enviada para confirmação docente.',
        previous: { migrationStatus: 'pending', origin: 'legacy' },
        current: schoolClass,
        ...requestAudit(requestMetadata),
      });
      return {
        result: { schoolClass },
        entityType: 'school_class_context',
        entityKey: classPublicId,
      };
    },
  });
}

function confirmGuidedClass(database, {
  actor,
  classPublicId,
  expectedContextUpdatedAt,
  idempotencyKey,
  requestMetadata,
}) {
  const principal = currentPrincipal(database, actor);
  if (principal.role !== 'professor') {
    fail(403, 'teacher_required', 'Somente o professor responsável pode confirmar esta turma.');
  }
  const normalizedClassPublicId = publicId(classPublicId, 'A turma');
  const expectedTimestamp = requiredText(
    expectedContextUpdatedAt,
    'A versão do contexto',
    10,
    64,
  );
  return runIdempotent(database, {
    principal,
    idempotencyKey,
    operationType: 'confirm_guided_class',
    fingerprintPayload: {
      classPublicId: normalizedClassPublicId,
      expectedContextUpdatedAt: expectedTimestamp,
    },
    perform() {
      const existing = database.prepare(`
        SELECT school_class.id AS class_id,
          school_class.public_id,
          school_class.name,
          school_class.owner_teacher_id,
          context.municipality_id,
          context.school_id,
          context.migration_status,
          context.origin,
          context.linked_by,
          context.linked_at,
          context.updated_at AS context_updated_at
        FROM school_classes school_class
        JOIN school_class_institution_contexts context ON context.class_id = school_class.id
        WHERE school_class.public_id = ? COLLATE NOCASE
      `).get(normalizedClassPublicId);
      if (!existing || existing.owner_teacher_id !== principal.id) {
        fail(404, 'guided_class_not_found', 'Turma guiada não encontrada para este professor.');
      }
      if (existing.origin !== 'guided_pilot' || existing.migration_status !== 'linked') {
        fail(409, 'guided_class_not_pending', 'A turma não está aguardando confirmação docente.');
      }
      if (existing.linked_by === principal.id) {
        fail(409, 'second_person_required', 'A confirmação exige uma pessoa diferente de quem preparou a turma.');
      }
      const membership = database.prepare(`
        SELECT 1 FROM institutional_memberships
        WHERE user_id = ? AND role = 'teacher' AND status = 'active'
          AND municipality_id = ? AND school_id = ?
      `).get(principal.id, existing.municipality_id, existing.school_id);
      if (!membership) {
        fail(409, 'active_teacher_membership_required', 'Seu vínculo docente não está ativo nessa escola.');
      }
      const updated = database.prepare(`
        UPDATE school_class_institution_contexts
        SET migration_status = 'verified', verified_by = ?,
            verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ? AND migration_status = 'linked'
          AND origin = 'guided_pilot' AND updated_at = ?
      `).run(principal.id, existing.class_id, expectedTimestamp);
      if (!updated.changes) {
        fail(409, 'stale_context', 'O contexto da turma mudou. Atualize a página antes de confirmar.');
      }
      const current = database.prepare(`
        SELECT migration_status, origin, linked_at, verified_at, updated_at
        FROM school_class_institution_contexts WHERE class_id = ?
      `).get(existing.class_id);
      const result = {
        schoolClass: {
          publicId: existing.public_id,
          name: existing.name,
          migrationStatus: current.migration_status,
          origin: current.origin,
          linkedAt: current.linked_at,
          verifiedAt: current.verified_at,
          contextUpdatedAt: current.updated_at,
        },
      };
      recordInstitutionalAudit(database, {
        actorUserId: principal.id,
        responsibleUserId: principal.id,
        action: 'confirm_guided_class_context',
        entityType: 'school_class_context',
        entityKey: existing.public_id,
        municipalityId: existing.municipality_id,
        schoolId: existing.school_id,
        reason: 'Professor responsável confirmou a turma preparada pela administração.',
        previous: {
          migrationStatus: existing.migration_status,
          origin: existing.origin,
          linkedAt: existing.linked_at,
        },
        current: result.schoolClass,
        ...requestAudit(requestMetadata),
      });
      return {
        result,
        entityType: 'school_class_context',
        entityKey: existing.public_id,
      };
    },
  });
}

module.exports = {
  FEATURE_KEY,
  InstitutionalManagementError,
  confirmGuidedClass,
  createGuidedClass,
  createMembership,
  createMunicipality,
  createProfessional,
  createSchool,
  getInstitutionalManagementState,
  getInstitutionalOperation,
  updateMunicipality,
  updateSchool,
};
