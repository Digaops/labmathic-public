const {
  INSTITUTIONAL_ROLES,
  authorizeMunicipalityAggregate,
  authorizeSchoolAggregate,
  getInstitutionalPrincipal,
} = require('./institutionalAccess');

const INSTITUTIONAL_ROLE_LABELS = Object.freeze({
  municipal_manager: 'Gestão municipal',
  school_manager: 'Gestão escolar',
  school_coordinator: 'Coordenação escolar',
  teacher: 'Professor(a)',
});

const MANAGEMENT_ROLES = new Set([
  INSTITUTIONAL_ROLES.MUNICIPAL_MANAGER,
  INSTITUTIONAL_ROLES.SCHOOL_MANAGER,
  INSTITUTIONAL_ROLES.SCHOOL_COORDINATOR,
]);

function number(value) {
  return Number(value) || 0;
}

function summaryCounts(db) {
  const row = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM municipalities WHERE status = 'active') AS active_municipalities,
      (SELECT COUNT(*) FROM schools WHERE status = 'active') AS active_schools,
      (SELECT COUNT(DISTINCT membership.user_id)
        FROM institutional_memberships membership
        JOIN municipalities municipality
          ON municipality.id = membership.municipality_id
          AND municipality.status = 'active'
        LEFT JOIN schools school
          ON school.id = membership.school_id
          AND school.municipality_id = membership.municipality_id
          AND school.status = 'active'
        WHERE membership.status = 'active'
          AND (membership.school_id IS NULL OR school.id IS NOT NULL)) AS linked_professionals,
      (SELECT COUNT(*) FROM institutional_memberships membership
        JOIN municipalities municipality
          ON municipality.id = membership.municipality_id
          AND municipality.status = 'active'
        WHERE membership.status = 'active'
          AND membership.role = 'municipal_manager') AS municipal_managers,
      (SELECT COUNT(*) FROM institutional_memberships membership
        JOIN municipalities municipality
          ON municipality.id = membership.municipality_id
          AND municipality.status = 'active'
        JOIN schools school
          ON school.id = membership.school_id
          AND school.municipality_id = membership.municipality_id
          AND school.status = 'active'
        WHERE membership.status = 'active'
          AND membership.role = 'school_manager') AS school_managers,
      (SELECT COUNT(*) FROM institutional_memberships membership
        JOIN municipalities municipality
          ON municipality.id = membership.municipality_id
          AND municipality.status = 'active'
        JOIN schools school
          ON school.id = membership.school_id
          AND school.municipality_id = membership.municipality_id
          AND school.status = 'active'
        WHERE membership.status = 'active'
          AND membership.role = 'school_coordinator') AS school_coordinators,
      (SELECT COUNT(*) FROM institutional_memberships membership
        JOIN municipalities municipality
          ON municipality.id = membership.municipality_id
          AND municipality.status = 'active'
        JOIN schools school
          ON school.id = membership.school_id
          AND school.municipality_id = membership.municipality_id
          AND school.status = 'active'
        WHERE membership.status = 'active'
          AND membership.role = 'teacher') AS teachers,
      (SELECT COUNT(*) FROM school_class_institution_contexts context
        JOIN municipalities municipality
          ON municipality.id = context.municipality_id
          AND municipality.status = 'active'
        JOIN schools school
          ON school.id = context.school_id
          AND school.municipality_id = context.municipality_id
          AND school.status = 'active'
        WHERE context.migration_status = 'verified') AS verified_classes,
      (SELECT COUNT(*) FROM school_class_institution_contexts
        WHERE migration_status = 'linked') AS linked_classes,
      (SELECT COUNT(*) FROM school_class_institution_contexts
        WHERE migration_status = 'pending') AS pending_classes
  `).get();

  return {
    activeMunicipalities: number(row.active_municipalities),
    activeSchools: number(row.active_schools),
    linkedProfessionals: number(row.linked_professionals),
    roleCoverage: {
      municipalManagers: number(row.municipal_managers),
      schoolManagers: number(row.school_managers),
      schoolCoordinators: number(row.school_coordinators),
      teachers: number(row.teachers),
    },
    verifiedClasses: number(row.verified_classes),
    linkedClasses: number(row.linked_classes),
    pendingClasses: number(row.pending_classes),
  };
}

function adminHierarchy(db) {
  const rows = db.prepare(`
    SELECT
      municipality.public_id AS municipality_public_id,
      municipality.name AS municipality_name,
      municipality.status AS municipality_status,
      school.public_id AS school_public_id,
      school.name AS school_name,
      school.status AS school_status,
      (
        SELECT COUNT(DISTINCT membership.user_id)
        FROM institutional_memberships membership
        LEFT JOIN schools membership_school
          ON membership_school.id = membership.school_id
          AND membership_school.municipality_id = membership.municipality_id
          AND membership_school.status = 'active'
        WHERE membership.municipality_id = municipality.id
          AND membership.status = 'active'
          AND (membership.school_id IS NULL OR membership_school.id IS NOT NULL)
      ) AS municipality_professional_count,
      (
        SELECT COUNT(DISTINCT membership.user_id)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = municipality.id
          AND membership.status = 'active'
      ) AS school_professional_count,
      (
        SELECT COUNT(*)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = municipality.id
          AND membership.status = 'active'
          AND membership.role = 'teacher'
      ) AS teacher_count,
      (
        SELECT COUNT(*)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = municipality.id
          AND membership.status = 'active'
          AND membership.role IN ('school_manager', 'school_coordinator')
      ) AS school_leadership_count,
      (
        SELECT COUNT(*)
        FROM school_class_institution_contexts context
        WHERE context.school_id = school.id
          AND context.municipality_id = municipality.id
          AND context.migration_status = 'verified'
      ) AS verified_class_count
    FROM municipalities municipality
    LEFT JOIN schools school
      ON school.municipality_id = municipality.id
      AND school.status = 'active'
    WHERE municipality.status = 'active'
    ORDER BY
      municipality.name,
      school.name
  `).all();

  const municipalities = new Map();
  for (const row of rows) {
    let municipality = municipalities.get(row.municipality_public_id);
    if (!municipality) {
      municipality = {
        publicId: row.municipality_public_id,
        name: row.municipality_name,
        status: row.municipality_status,
        professionalCount: number(row.municipality_professional_count),
        schools: [],
      };
      municipalities.set(row.municipality_public_id, municipality);
    }
    if (!row.school_public_id) continue;
    municipality.schools.push({
      publicId: row.school_public_id,
      name: row.school_name,
      status: row.school_status,
      professionalCount: number(row.school_professional_count),
      teacherCount: number(row.teacher_count),
      leadershipCount: number(row.school_leadership_count),
      verifiedClassCount: number(row.verified_class_count),
    });
  }
  return [...municipalities.values()];
}

function recentInstitutionalAudit(db) {
  return db.prepare(`
    SELECT action, entity_type, created_at
    FROM institutional_audit_log
    ORDER BY datetime(created_at) DESC, id DESC
    LIMIT 8
  `).all().map((row) => ({
    action: row.action,
    entityType: row.entity_type,
    createdAt: row.created_at,
  }));
}

function getAdminReadModel(db) {
  return {
    mode: 'admin',
    readOnly: true,
    summary: summaryCounts(db),
    municipalities: adminHierarchy(db),
    recentAudit: recentInstitutionalAudit(db),
  };
}

function managerGrants(db, principal) {
  const grants = new Map();
  for (const membership of principal.memberships) {
    if (!MANAGEMENT_ROLES.has(membership.role)) continue;
    let grant = grants.get(membership.municipalityId);
    if (!grant) {
      grant = {
        municipalityId: membership.municipalityId,
        municipalityPublicId: membership.municipalityPublicId,
        municipalityName: membership.municipalityName,
        fullMunicipality: false,
        schoolIds: new Set(),
        roles: new Set(),
      };
      grants.set(membership.municipalityId, grant);
    }

    if (membership.role === INSTITUTIONAL_ROLES.MUNICIPAL_MANAGER) {
      const decision = authorizeMunicipalityAggregate(db, principal.id, membership.municipalityId);
      if (!decision.allowed) continue;
      grant.fullMunicipality = true;
      grant.roles.add(membership.role);
      continue;
    }

    const decision = authorizeSchoolAggregate(
      db,
      principal.id,
      membership.municipalityId,
      membership.schoolId,
    );
    if (!decision.allowed) continue;
    grant.schoolIds.add(membership.schoolId);
    grant.roles.add(membership.role);
  }
  return [...grants.values()].filter((grant) => grant.fullMunicipality || grant.schoolIds.size > 0);
}

function scopedSchoolRows(db, grant) {
  const schoolIds = [...grant.schoolIds];
  const schoolRestriction = grant.fullMunicipality
    ? ''
    : `AND school.id IN (${schoolIds.map(() => '?').join(', ')})`;
  return db.prepare(`
    SELECT
      school.id,
      school.public_id,
      school.name,
      school.status,
      (SELECT COUNT(DISTINCT membership.user_id)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = school.municipality_id
          AND membership.status = 'active') AS professional_count,
      (SELECT COUNT(*)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = school.municipality_id
          AND membership.status = 'active'
          AND membership.role = 'teacher') AS teacher_count,
      (SELECT COUNT(*)
        FROM institutional_memberships membership
        WHERE membership.school_id = school.id
          AND membership.municipality_id = school.municipality_id
          AND membership.status = 'active'
          AND membership.role IN ('school_manager', 'school_coordinator')) AS leadership_count,
      (SELECT COUNT(*)
        FROM school_class_institution_contexts context
        WHERE context.school_id = school.id
          AND context.municipality_id = school.municipality_id
          AND context.migration_status = 'verified') AS verified_class_count
    FROM schools school
    WHERE school.municipality_id = ?
      AND school.status = 'active'
      ${schoolRestriction}
    ORDER BY school.name
  `).all(grant.municipalityId, ...(grant.fullMunicipality ? [] : schoolIds));
}

function scopedProfessionalIds(db, grant, schools) {
  if (grant.fullMunicipality) {
    return db.prepare(`
      SELECT DISTINCT membership.user_id
      FROM institutional_memberships membership
      JOIN municipalities municipality
        ON municipality.id = membership.municipality_id
        AND municipality.status = 'active'
      LEFT JOIN schools school
        ON school.id = membership.school_id
        AND school.municipality_id = membership.municipality_id
        AND school.status = 'active'
      WHERE membership.municipality_id = ?
        AND membership.status = 'active'
        AND (membership.school_id IS NULL OR school.id IS NOT NULL)
    `).all(grant.municipalityId).map((row) => row.user_id);
  }
  if (!schools.length) return [];
  const schoolIds = schools.map((school) => school.id);
  return db.prepare(`
    SELECT DISTINCT membership.user_id
    FROM institutional_memberships membership
    WHERE membership.municipality_id = ?
      AND membership.school_id IN (${schoolIds.map(() => '?').join(', ')})
      AND membership.status = 'active'
  `).all(grant.municipalityId, ...schoolIds).map((row) => row.user_id);
}

function getManagerReadModel(db, principal) {
  const grants = managerGrants(db, principal);
  if (!grants.length) return null;

  const professionalIds = new Set();
  const municipalities = grants.map((grant) => {
    const schools = scopedSchoolRows(db, grant);
    const municipalityProfessionalIds = scopedProfessionalIds(db, grant, schools);
    municipalityProfessionalIds.forEach((id) => professionalIds.add(id));
    return {
      publicId: grant.municipalityPublicId,
      name: grant.municipalityName,
      status: 'active',
      accessLevel: grant.fullMunicipality ? 'municipality' : 'schools',
      roleLabels: [...grant.roles].map((role) => INSTITUTIONAL_ROLE_LABELS[role]),
      professionalCount: new Set(municipalityProfessionalIds).size,
      schools: schools.map((school) => ({
        publicId: school.public_id,
        name: school.name,
        status: school.status,
        professionalCount: number(school.professional_count),
        teacherCount: number(school.teacher_count),
        leadershipCount: number(school.leadership_count),
        verifiedClassCount: number(school.verified_class_count),
      })),
    };
  });
  const schoolCount = municipalities.reduce((total, item) => total + item.schools.length, 0);
  const verifiedClassCount = municipalities.reduce(
    (total, item) => total + item.schools.reduce(
      (schoolTotal, school) => schoolTotal + school.verifiedClassCount,
      0,
    ),
    0,
  );
  const municipalityScopes = grants.filter((grant) => grant.fullMunicipality).length;

  return {
    mode: 'manager',
    readOnly: true,
    scopeLevel: municipalityScopes === grants.length
      ? 'municipality'
      : municipalityScopes === 0 ? 'school' : 'mixed',
    summary: {
      activeMunicipalities: municipalities.length,
      activeSchools: schoolCount,
      linkedProfessionals: professionalIds.size,
      verifiedClasses: verifiedClassCount,
    },
    municipalities,
  };
}

function professionalClasses(db, userId) {
  return db.prepare(`
    SELECT
      school_class.public_id,
      school_class.name,
      school_class.academic_year,
      school_class.status,
      grade.name AS grade_name,
      context.migration_status,
      CASE WHEN context.migration_status IN ('linked', 'verified')
        THEN municipality.name ELSE NULL END AS municipality_name,
      CASE WHEN context.migration_status IN ('linked', 'verified')
        THEN school.name ELSE NULL END AS school_name
    FROM school_classes school_class
    JOIN school_class_institution_contexts context
      ON context.class_id = school_class.id
      AND context.owner_teacher_id = school_class.owner_teacher_id
    LEFT JOIN grades grade ON grade.id = school_class.grade_id
    LEFT JOIN municipalities municipality
      ON municipality.id = context.municipality_id
    LEFT JOIN schools school
      ON school.id = context.school_id
      AND school.municipality_id = context.municipality_id
    WHERE school_class.owner_teacher_id = ?
    ORDER BY
      CASE context.migration_status
        WHEN 'verified' THEN 0 WHEN 'linked' THEN 1 ELSE 2 END,
      CASE school_class.status WHEN 'active' THEN 0 ELSE 1 END,
      school_class.academic_year DESC,
      school_class.name
  `).all(userId).map((row) => ({
    publicId: row.public_id,
    name: row.name,
    academicYear: row.academic_year,
    gradeName: row.grade_name || null,
    status: row.status,
    migrationStatus: row.migration_status,
    municipalityName: row.municipality_name,
    schoolName: row.school_name,
  }));
}

function professionalStatus(memberships, classes) {
  const verified = classes.filter((item) => item.migrationStatus === 'verified').length;
  const linked = classes.filter((item) => item.migrationStatus === 'linked').length;
  const pending = classes.filter((item) => item.migrationStatus === 'pending').length;
  if (verified > 0) return 'verified_context';
  if (linked > 0) return 'awaiting_verification';
  if (memberships.length > 0) return 'membership_ready';
  if (pending > 0) return 'pending_institutional_link';
  return 'no_context';
}

function getProfessionalReadModel(db, principal) {
  const classes = professionalClasses(db, principal.id);
  const memberships = principal.memberships.map((membership) => ({
    publicId: membership.publicId,
    role: membership.role,
    roleLabel: INSTITUTIONAL_ROLE_LABELS[membership.role] || membership.role,
    municipalityPublicId: membership.municipalityPublicId,
    municipalityName: membership.municipalityName,
    schoolPublicId: membership.schoolPublicId,
    schoolName: membership.schoolName,
  }));
  return {
    mode: 'professional',
    readOnly: true,
    status: professionalStatus(memberships, classes),
    memberships,
    summary: {
      memberships: memberships.length,
      classes: classes.length,
      verifiedClasses: classes.filter((item) => item.migrationStatus === 'verified').length,
      linkedClasses: classes.filter((item) => item.migrationStatus === 'linked').length,
      pendingClasses: classes.filter((item) => item.migrationStatus === 'pending').length,
    },
    classes,
  };
}

function getInstitutionalReadModel(db, userId) {
  const principal = getInstitutionalPrincipal(db, userId);
  if (!principal) {
    const error = new Error('Principal institucional não encontrado.');
    error.code = 'institutional_principal_not_found';
    throw error;
  }
  if (principal.isLabAdmin) return getAdminReadModel(db);
  const managerModel = getManagerReadModel(db, principal);
  if (managerModel) return managerModel;
  if (principal.legacyRole !== 'professor') {
    const error = new Error('Perfil institucional indisponível.');
    error.code = 'institutional_role_unsupported';
    throw error;
  }
  return getProfessionalReadModel(db, principal);
}

module.exports = {
  getInstitutionalReadModel,
  getManagerReadModel,
};
