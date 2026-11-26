const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const {
  authorizeClassAggregate,
  authorizeMunicipalityAggregate,
  authorizeSchoolAccess,
  authorizeSchoolAggregate,
  getInstitutionalPrincipal,
  recordInstitutionalAudit,
} = require('../src/services/institutionalAccess');
const { getInstitutionalReadModel } = require('../src/services/institutionalReadModel');

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
    CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE grades (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
  `);
  migration002.up(db);
  migration003.up(db);
  migration016.up(db);
  return db;
}

function addUser(db, name, role = 'professor') {
  return db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash', ?)
  `).run(name, `${name.toLowerCase().replace(/\s+/g, '-')}@teste.local`, role).lastInsertRowid;
}

function addMembership(db, suffix, userId, role, municipalityId, schoolId, actorId) {
  return db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `membership-access-${suffix.padEnd(10, '0')}`,
    userId,
    role,
    municipalityId,
    schoolId,
    actorId,
  ).lastInsertRowid;
}

function seedScopes(db) {
  const adminId = addUser(db, 'Admin Geral', 'admin');
  const municipalManagerId = addUser(db, 'Gestora Municipal');
  const schoolManagerId = addUser(db, 'Gestor Escolar');
  const coordinatorId = addUser(db, 'Coordenadora Escolar');
  const teacherId = addUser(db, 'Professora Titular');
  const outsiderId = addUser(db, 'Professora Externa');
  db.prepare("INSERT INTO grades (id, name) VALUES (1, '7o Ano')").run();
  const municipalityOneId = db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-access-0001', 'Municipio Um', '3550308', ?)
  `).run(adminId).lastInsertRowid;
  const municipalityTwoId = db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-access-0002', 'Municipio Dois', '3304557', ?)
  `).run(adminId).lastInsertRowid;
  const schoolOneId = db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-access-public-001', ?, 'Escola Um', ?)
  `).run(municipalityOneId, adminId).lastInsertRowid;
  const schoolTwoId = db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-access-public-002', ?, 'Escola Dois', ?)
  `).run(municipalityTwoId, adminId).lastInsertRowid;

  addMembership(
    db, 'municipal', municipalManagerId, 'municipal_manager',
    municipalityOneId, null, adminId,
  );
  addMembership(
    db, 'manager', schoolManagerId, 'school_manager',
    municipalityOneId, schoolOneId, adminId,
  );
  addMembership(
    db, 'coordinate', coordinatorId, 'school_coordinator',
    municipalityOneId, schoolOneId, adminId,
  );
  const teacherMembershipId = addMembership(
    db, 'teacher', teacherId, 'teacher', municipalityOneId, schoolOneId, adminId,
  );

  const classId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('verified-class-public-01', ?, 'Turma Verificada', 1, 2026, ?)
  `).run(teacherId, teacherId).lastInsertRowid;
  db.prepare(`
    UPDATE school_class_institution_contexts
    SET municipality_id = ?, school_id = ?, migration_status = 'linked',
      linked_by = ?, linked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ?
  `).run(municipalityOneId, schoolOneId, adminId, classId);
  db.prepare(`
    UPDATE school_class_institution_contexts
    SET migration_status = 'verified', verified_by = ?,
      verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ?
  `).run(municipalManagerId, classId);

  db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('pending-class-public-001', ?, 'Turma Pendente', 1, 2026, ?)
  `).run(teacherId, teacherId);

  return {
    adminId,
    municipalManagerId,
    schoolManagerId,
    coordinatorId,
    teacherId,
    outsiderId,
    teacherMembershipId,
    municipalityOneId,
    municipalityTwoId,
    schoolOneId,
    schoolTwoId,
  };
}

test('autorização institucional consulta o banco atual e falha fechada fora do escopo', () => {
  const db = createDatabase();
  try {
    const scope = seedScopes(db);
    assert.equal(getInstitutionalPrincipal(db, scope.adminId).isLabAdmin, true);
    assert.equal(
      authorizeMunicipalityAggregate(db, scope.adminId, scope.municipalityOneId).allowed,
      true,
    );
    assert.equal(
      authorizeMunicipalityAggregate(
        db,
        scope.municipalManagerId,
        scope.municipalityOneId,
      ).allowed,
      true,
    );
    assert.equal(
      authorizeMunicipalityAggregate(
        db,
        scope.municipalManagerId,
        scope.municipalityTwoId,
      ).allowed,
      false,
    );
    assert.equal(
      authorizeMunicipalityAggregate(db, scope.schoolManagerId, scope.municipalityOneId).allowed,
      false,
    );
    assert.equal(
      authorizeSchoolAggregate(
        db,
        scope.schoolManagerId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      true,
    );
    assert.equal(
      authorizeSchoolAggregate(
        db,
        scope.coordinatorId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      true,
    );
    assert.equal(
      authorizeSchoolAggregate(
        db,
        scope.teacherId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      false,
    );
    assert.equal(
      authorizeSchoolAccess(
        db,
        scope.teacherId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      true,
    );
    assert.equal(
      authorizeSchoolAccess(
        db,
        scope.outsiderId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      false,
    );
    assert.equal(
      authorizeSchoolAggregate(
        db,
        scope.schoolManagerId,
        scope.municipalityTwoId,
        scope.schoolTwoId,
      ).allowed,
      false,
    );

    db.prepare(`
      UPDATE institutional_memberships
      SET status = 'inactive', ended_at = CURRENT_TIMESTAMP,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(scope.teacherMembershipId);
    assert.equal(
      authorizeSchoolAccess(
        db,
        scope.teacherId,
        scope.municipalityOneId,
        scope.schoolOneId,
      ).allowed,
      false,
    );
  } finally {
    db.close();
  }
});

test('visão agregada exige contexto verificado e nunca expõe turma pendente', () => {
  const db = createDatabase();
  try {
    const scope = seedScopes(db);
    assert.equal(
      authorizeClassAggregate(db, scope.municipalManagerId, 'verified-class-public-01').allowed,
      true,
    );
    assert.equal(
      authorizeClassAggregate(db, scope.schoolManagerId, 'verified-class-public-01').allowed,
      true,
    );
    assert.equal(
      authorizeClassAggregate(db, scope.teacherId, 'verified-class-public-01').allowed,
      false,
    );
    assert.equal(
      authorizeClassAggregate(db, scope.outsiderId, 'verified-class-public-01').allowed,
      false,
    );
    assert.deepEqual(
      authorizeClassAggregate(db, scope.adminId, 'pending-class-public-001'),
      { allowed: false, reason: 'verified_class_context_required', principal: null },
    );
  } finally {
    db.close();
  }
});

test('helper de auditoria registra escopo e responsável sem copiar segredos', () => {
  const db = createDatabase();
  try {
    const scope = seedScopes(db);
    const recorded = recordInstitutionalAudit(db, {
      actorUserId: scope.adminId,
      responsibleUserId: scope.teacherId,
      action: 'verify_class_context',
      entityType: 'school_class_context',
      entityKey: 'verified-class-public-01',
      municipalityId: scope.municipalityOneId,
      schoolId: scope.schoolOneId,
      reason: 'Contexto revisado antes de qualquer visibilidade agregada.',
      current: {
        migrationStatus: 'verified',
        token: 'nao-pode-ser-copiado',
        nested: { password: 'nem-este', safe: 'preservado' },
      },
    });
    const row = db.prepare('SELECT * FROM institutional_audit_log WHERE id = ?')
      .get(recorded.id);
    assert.equal(row.municipality_id, scope.municipalityOneId);
    assert.equal(row.school_id, scope.schoolOneId);
    assert.equal(row.responsible_user_id, scope.teacherId);
    assert.equal(row.responsible_name_snapshot, 'Professora Titular');
    assert.doesNotMatch(row.current_json, /nao-pode-ser-copiado|nem-este/);
    assert.match(row.current_json, /preservado/);

    assert.throws(
      () => recordInstitutionalAudit(db, {
        actorUserId: scope.adminId,
        responsibleUserId: scope.teacherId,
        action: 'verify_class_context',
        entityType: 'school_class_context',
        entityKey: 'cross-scope',
        municipalityId: scope.municipalityTwoId,
        schoolId: scope.schoolOneId,
        reason: 'Este contexto deve ser recusado por pertencer a outro município.',
      }),
      /escola não pertence ao município/i,
    );
  } finally {
    db.close();
  }
});

test('read model agrega somente contextos verificados e limita o professor ao próprio escopo', () => {
  const db = createDatabase();
  try {
    const scope = seedScopes(db);
    const outsiderClassId = db.prepare(`
      INSERT INTO school_classes (
        public_id, owner_teacher_id, name, grade_id, academic_year, created_by
      ) VALUES ('outsider-private-class-01', ?, 'Turma de Outro Professor', 1, 2026, ?)
    `).run(scope.outsiderId, scope.outsiderId).lastInsertRowid;
    assert.ok(outsiderClassId);

    const adminModel = getInstitutionalReadModel(db, scope.adminId);
    assert.equal(adminModel.mode, 'admin');
    assert.equal(adminModel.readOnly, true);
    assert.equal(adminModel.summary.activeMunicipalities, 2);
    assert.equal(adminModel.summary.activeSchools, 2);
    assert.equal(adminModel.summary.verifiedClasses, 1);
    assert.equal(adminModel.summary.pendingClasses, 2);
    const school = adminModel.municipalities
      .find((item) => item.publicId === 'municipality-access-0001')
      .schools.find((item) => item.publicId === 'school-access-public-001');
    assert.equal(school.verifiedClassCount, 1);
    assert.equal(school.teacherCount, 1);
    assert.doesNotMatch(JSON.stringify(adminModel), /Professora Titular|Turma de Outro Professor/);

    addMembership(
      db,
      'dual-manager',
      scope.municipalManagerId,
      'school_manager',
      scope.municipalityOneId,
      scope.schoolOneId,
      scope.adminId,
    );
    const municipalManagerModel = getInstitutionalReadModel(db, scope.municipalManagerId);
    assert.equal(municipalManagerModel.mode, 'manager');
    assert.equal(municipalManagerModel.scopeLevel, 'municipality');
    assert.equal(municipalManagerModel.summary.activeMunicipalities, 1);
    assert.equal(municipalManagerModel.summary.activeSchools, 1);
    assert.equal(municipalManagerModel.summary.linkedProfessionals, 4);
    assert.equal(municipalManagerModel.summary.verifiedClasses, 1);
    assert.deepEqual(
      new Set(municipalManagerModel.municipalities[0].roleLabels),
      new Set(['Gestão municipal', 'Gestão escolar']),
    );
    assert.deepEqual(
      municipalManagerModel.municipalities.map((item) => item.publicId),
      ['municipality-access-0001'],
    );
    assert.doesNotMatch(
      JSON.stringify(municipalManagerModel),
      /Municipio Dois|Escola Dois|Professora Titular|Turma Verificada|Turma Pendente/,
    );

    const schoolManagerModel = getInstitutionalReadModel(db, scope.schoolManagerId);
    assert.equal(schoolManagerModel.mode, 'manager');
    assert.equal(schoolManagerModel.scopeLevel, 'school');
    assert.equal(schoolManagerModel.summary.activeMunicipalities, 1);
    assert.equal(schoolManagerModel.summary.activeSchools, 1);
    assert.equal(schoolManagerModel.summary.linkedProfessionals, 4);
    assert.equal(schoolManagerModel.summary.verifiedClasses, 1);
    assert.deepEqual(
      schoolManagerModel.municipalities[0].schools.map((item) => item.publicId),
      ['school-access-public-001'],
    );
    assert.doesNotMatch(
      JSON.stringify(schoolManagerModel),
      /Municipio Dois|Escola Dois|Professora Titular|Turma Verificada|Turma Pendente/,
    );

    const coordinatorModel = getInstitutionalReadModel(db, scope.coordinatorId);
    assert.equal(coordinatorModel.mode, 'manager');
    assert.equal(coordinatorModel.summary.activeSchools, 1);
    assert.doesNotMatch(JSON.stringify(coordinatorModel), /Municipio Dois|Escola Dois/);

    db.prepare(`
      UPDATE schools SET status = 'archived', archived_at = CURRENT_TIMESTAMP
      WHERE public_id = 'school-access-public-002'
    `).run();
    const activeHierarchy = getInstitutionalReadModel(db, scope.adminId);
    assert.equal(activeHierarchy.summary.activeSchools, 1);
    assert.doesNotMatch(JSON.stringify(activeHierarchy.municipalities), /Escola Dois/);

    const teacherModel = getInstitutionalReadModel(db, scope.teacherId);
    assert.equal(teacherModel.mode, 'professional');
    assert.equal(teacherModel.status, 'verified_context');
    assert.equal(teacherModel.memberships.length, 1);
    assert.deepEqual(
      teacherModel.classes.map((item) => item.name),
      ['Turma Verificada', 'Turma Pendente'],
    );
    assert.doesNotMatch(JSON.stringify(teacherModel), /Turma de Outro Professor/);

    const outsiderModel = getInstitutionalReadModel(db, scope.outsiderId);
    assert.equal(outsiderModel.status, 'pending_institutional_link');
    assert.deepEqual(outsiderModel.classes.map((item) => item.name), ['Turma de Outro Professor']);
    assert.doesNotMatch(JSON.stringify(outsiderModel), /Turma Verificada|Turma Pendente/);
  } finally {
    db.close();
  }
});
