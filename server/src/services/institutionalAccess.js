const INSTITUTIONAL_ROLES = Object.freeze({
  MUNICIPAL_MANAGER: 'municipal_manager',
  SCHOOL_MANAGER: 'school_manager',
  SCHOOL_COORDINATOR: 'school_coordinator',
  TEACHER: 'teacher',
});

const AUDIT_ENTITY_TYPES = new Set([
  'municipality',
  'school',
  'membership',
  'school_class_context',
  'authorization',
]);

const SENSITIVE_AUDIT_KEYS = new Set([
  'password',
  'senha',
  'token',
  'jwt',
  'authorization',
  'resettoken',
  'reset_token',
  'secret',
  'api_key',
  'apikey',
  'code',
  'codigo',
]);

function isSensitiveAuditKey(key) {
  const normalized = String(key || '').trim().toLowerCase();
  return SENSITIVE_AUDIT_KEYS.has(normalized)
    || /(password|senha|token|authorization|secret)/.test(normalized);
}

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function sanitizeAuditValue(value) {
  if (value === null || value === undefined) return value ?? null;
  if (Array.isArray(value)) return value.map((item) => sanitizeAuditValue(item));
  if (typeof value !== 'object') return value;

  return Object.entries(value).reduce((sanitized, [key, entry]) => {
    if (isSensitiveAuditKey(key)) return sanitized;
    sanitized[key] = sanitizeAuditValue(entry);
    return sanitized;
  }, {});
}

function serializeAuditValue(value) {
  if (value === undefined || value === null) return null;
  const serialized = JSON.stringify(sanitizeAuditValue(value));
  if (serialized.length > 16000) {
    throw new Error('O estado da auditoria institucional excede o limite seguro.');
  }
  return serialized;
}

function listActiveMemberships(db, userId) {
  const normalizedUserId = positiveInteger(userId);
  if (!normalizedUserId) return [];

  return db.prepare(`
    SELECT
      membership.id,
      membership.public_id,
      membership.role,
      membership.municipality_id,
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      membership.school_id,
      school.public_id AS school_public_id,
      school.name AS school_name,
      membership.revision
    FROM institutional_memberships membership
    JOIN municipalities municipality
      ON municipality.id = membership.municipality_id
      AND municipality.status = 'active'
    LEFT JOIN schools school
      ON school.id = membership.school_id
      AND school.municipality_id = membership.municipality_id
      AND school.status = 'active'
    WHERE membership.user_id = ?
      AND membership.status = 'active'
      AND (membership.school_id IS NULL OR school.id IS NOT NULL)
    ORDER BY municipality.name, school.name, membership.role, membership.id
  `).all(normalizedUserId).map((membership) => ({
    id: membership.id,
    publicId: membership.public_id,
    role: membership.role,
    municipalityId: membership.municipality_id,
    municipalityPublicId: membership.municipality_public_id,
    municipalityName: membership.municipality_name,
    schoolId: membership.school_id,
    schoolPublicId: membership.school_public_id,
    schoolName: membership.school_name,
    revision: membership.revision,
  }));
}

function getInstitutionalPrincipal(db, userId) {
  const normalizedUserId = positiveInteger(userId);
  if (!normalizedUserId) return null;
  const user = db.prepare(`
    SELECT id, name, email, role
    FROM users
    WHERE id = ?
  `).get(normalizedUserId);
  if (!user) return null;

  return {
    id: user.id,
    name: user.name,
    email: user.email,
    legacyRole: user.role,
    isLabAdmin: user.role === 'admin',
    memberships: user.role === 'admin' ? [] : listActiveMemberships(db, user.id),
  };
}

function denied(reason, principal = null) {
  return { allowed: false, reason, principal };
}

function allowed(reason, principal, membership = null) {
  return { allowed: true, reason, principal, membership };
}

function findMunicipality(db, municipalityId) {
  const normalizedId = positiveInteger(municipalityId);
  if (!normalizedId) return null;
  return db.prepare(`
    SELECT id, public_id, name
    FROM municipalities
    WHERE id = ? AND status = 'active'
  `).get(normalizedId) || null;
}

function findSchool(db, municipalityId, schoolId) {
  const normalizedMunicipalityId = positiveInteger(municipalityId);
  const normalizedSchoolId = positiveInteger(schoolId);
  if (!normalizedMunicipalityId || !normalizedSchoolId) return null;
  return db.prepare(`
    SELECT id, public_id, name, municipality_id
    FROM schools
    WHERE id = ? AND municipality_id = ? AND status = 'active'
  `).get(normalizedSchoolId, normalizedMunicipalityId) || null;
}

function authorizeMunicipalityAggregate(db, userId, municipalityId) {
  const municipality = findMunicipality(db, municipalityId);
  if (!municipality) return denied('municipality_unavailable');
  const principal = getInstitutionalPrincipal(db, userId);
  if (!principal) return denied('principal_not_found');
  if (principal.isLabAdmin) return allowed('lab_admin', principal);

  const membership = principal.memberships.find((item) => (
    item.role === INSTITUTIONAL_ROLES.MUNICIPAL_MANAGER
    && item.municipalityId === municipality.id
    && item.schoolId === null
  ));
  return membership
    ? allowed('municipal_manager', principal, membership)
    : denied('municipality_scope_denied', principal);
}

function authorizeSchoolAccess(db, userId, municipalityId, schoolId) {
  const school = findSchool(db, municipalityId, schoolId);
  if (!school) return denied('school_unavailable');
  const principal = getInstitutionalPrincipal(db, userId);
  if (!principal) return denied('principal_not_found');
  if (principal.isLabAdmin) return allowed('lab_admin', principal);

  const municipalMembership = principal.memberships.find((item) => (
    item.role === INSTITUTIONAL_ROLES.MUNICIPAL_MANAGER
    && item.municipalityId === school.municipality_id
    && item.schoolId === null
  ));
  if (municipalMembership) {
    return allowed('municipal_manager', principal, municipalMembership);
  }

  const schoolMembership = principal.memberships.find((item) => (
    item.municipalityId === school.municipality_id
    && item.schoolId === school.id
  ));
  return schoolMembership
    ? allowed(schoolMembership.role, principal, schoolMembership)
    : denied('school_scope_denied', principal);
}

function authorizeSchoolAggregate(db, userId, municipalityId, schoolId) {
  const decision = authorizeSchoolAccess(db, userId, municipalityId, schoolId);
  if (!decision.allowed) return decision;
  if (decision.reason === 'lab_admin' || decision.reason === 'municipal_manager') {
    return decision;
  }
  if (
    decision.membership?.role === INSTITUTIONAL_ROLES.SCHOOL_MANAGER
    || decision.membership?.role === INSTITUTIONAL_ROLES.SCHOOL_COORDINATOR
  ) {
    return decision;
  }
  return denied('aggregate_requires_manager', decision.principal);
}

function findVerifiedClassContext(db, classPublicId) {
  const normalizedPublicId = String(classPublicId || '').trim();
  if (!normalizedPublicId) return null;
  return db.prepare(`
    SELECT
      school_class.public_id AS class_public_id,
      school_class.owner_teacher_id,
      context.municipality_id,
      municipality.public_id AS municipality_public_id,
      context.school_id,
      school.public_id AS school_public_id,
      context.migration_status
    FROM school_classes school_class
    JOIN school_class_institution_contexts context
      ON context.class_id = school_class.id
      AND context.owner_teacher_id = school_class.owner_teacher_id
      AND context.migration_status = 'verified'
    JOIN municipalities municipality
      ON municipality.id = context.municipality_id
      AND municipality.status = 'active'
    JOIN schools school
      ON school.id = context.school_id
      AND school.municipality_id = context.municipality_id
      AND school.status = 'active'
    WHERE school_class.public_id = ? COLLATE NOCASE
  `).get(normalizedPublicId) || null;
}

function authorizeClassAggregate(db, userId, classPublicId) {
  const context = findVerifiedClassContext(db, classPublicId);
  if (!context) return denied('verified_class_context_required');
  const decision = authorizeSchoolAggregate(
    db,
    userId,
    context.municipality_id,
    context.school_id,
  );
  return decision.allowed ? { ...decision, context } : decision;
}

function recordInstitutionalAudit(db, payload) {
  const actorId = positiveInteger(payload?.actorUserId);
  const responsibleId = positiveInteger(payload?.responsibleUserId);
  const municipalityId = payload?.municipalityId === null || payload?.municipalityId === undefined
    ? null
    : positiveInteger(payload.municipalityId);
  const schoolId = payload?.schoolId === null || payload?.schoolId === undefined
    ? null
    : positiveInteger(payload.schoolId);
  const action = String(payload?.action || '').trim();
  const entityType = String(payload?.entityType || '').trim();
  const entityKey = String(payload?.entityKey || '').trim();
  const reason = String(payload?.reason || '').trim();

  if (!actorId || !responsibleId) {
    throw new Error('Ator e responsável são obrigatórios na auditoria institucional.');
  }
  if (!AUDIT_ENTITY_TYPES.has(entityType)) {
    throw new Error('Tipo de entidade inválido na auditoria institucional.');
  }
  if (action.length < 3 || action.length > 80 || entityKey.length < 1 || entityKey.length > 128) {
    throw new Error('Ação ou entidade inválida na auditoria institucional.');
  }
  if (reason.length < 10 || reason.length > 500) {
    throw new Error('O motivo da auditoria institucional deve ter entre 10 e 500 caracteres.');
  }
  if ((payload?.municipalityId !== null && payload?.municipalityId !== undefined) && !municipalityId) {
    throw new Error('Município inválido na auditoria institucional.');
  }
  if ((payload?.schoolId !== null && payload?.schoolId !== undefined) && !schoolId) {
    throw new Error('Escola inválida na auditoria institucional.');
  }
  if (schoolId && !municipalityId) {
    throw new Error('Uma escola auditada deve estar acompanhada do município.');
  }

  const actor = db.prepare('SELECT id, name FROM users WHERE id = ?').get(actorId);
  const responsible = db.prepare('SELECT id, name FROM users WHERE id = ?').get(responsibleId);
  if (!actor || !responsible) {
    throw new Error('Ator ou responsável não encontrado para a auditoria institucional.');
  }
  if (municipalityId && !findMunicipality(db, municipalityId)) {
    throw new Error('Município indisponível para a auditoria institucional.');
  }
  if (schoolId && !findSchool(db, municipalityId, schoolId)) {
    throw new Error('A escola não pertence ao município informado na auditoria institucional.');
  }

  const result = db.prepare(`
    INSERT INTO institutional_audit_log (
      actor_user_id,
      actor_name_snapshot,
      responsible_user_id,
      responsible_name_snapshot,
      action,
      entity_type,
      entity_key,
      municipality_id,
      school_id,
      reason,
      previous_json,
      current_json,
      ip_address,
      user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    actor.id,
    actor.name,
    responsible.id,
    responsible.name,
    action,
    entityType,
    entityKey,
    municipalityId,
    schoolId,
    reason,
    serializeAuditValue(payload.previous),
    serializeAuditValue(payload.current),
    payload.ipAddress || null,
    payload.userAgent || null,
  );

  return {
    id: Number(result.lastInsertRowid),
    actorUserId: actor.id,
    responsibleUserId: responsible.id,
    municipalityId,
    schoolId,
  };
}

module.exports = {
  INSTITUTIONAL_ROLES,
  authorizeClassAggregate,
  authorizeMunicipalityAggregate,
  authorizeSchoolAccess,
  authorizeSchoolAggregate,
  findVerifiedClassContext,
  getInstitutionalPrincipal,
  listActiveMemberships,
  recordInstitutionalAudit,
  sanitizeAuditValue,
};
