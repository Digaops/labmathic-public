const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');
const { authorizeClassAggregate } = require('../src/services/institutionalAccess');
const {
  calculateArtifactDigest,
  createInstitutionalBackfillDiagnostic,
  createInstitutionalBackfillPlan,
  linkInstitutionalBackfillPlan,
  validatePlan,
  verifyInstitutionalBackfillReceipt,
} = require('../src/services/institutionalBackfill');

function createDatabase() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('professor', 'admin')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE disciplines (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE);
    CREATE TABLE grades (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      sort_order INTEGER DEFAULT 0
    );
  `);
  migration002.up(db);
  migration003.up(db);
  migration016.up(db);
  return db;
}

function addUser(db, suffix, name, role = 'professor') {
  return Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-inerte', ?)
  `).run(name, `${suffix}@homologacao.invalid`, role).lastInsertRowid);
}

function addMembership(db, suffix, userId, role, municipalityId, schoolId, actorId) {
  return Number(db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `membership-backfill-${suffix}`,
    userId,
    role,
    municipalityId,
    schoolId,
    actorId,
  ).lastInsertRowid);
}

function seedBackfillScenario(db) {
  const planAdminId = addUser(db, 'admin-plano', 'Administradora do Plano', 'admin');
  const linkAdminId = addUser(db, 'admin-vinculo', 'Administrador do Vínculo', 'admin');
  const municipalReviewerId = addUser(db, 'gestora-municipal', 'Gestora Municipal');
  const schoolReviewerId = addUser(db, 'coordenadora-escolar', 'Coordenadora Escolar');
  const teacherId = addUser(db, 'professora-titular', 'Professora Titular');
  const outsiderId = addUser(db, 'gestora-externa', 'Gestora Externa');
  db.prepare("INSERT INTO grades (id, name, sort_order) VALUES (1, '7º ano', 7)").run();

  const municipalityId = Number(db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-backfill-0001', 'Município Principal', '3550308', ?)
  `).run(planAdminId).lastInsertRowid);
  const otherMunicipalityId = Number(db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-backfill-0002', 'Município Externo', '3304557', ?)
  `).run(planAdminId).lastInsertRowid);
  const schoolOneId = Number(db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-backfill-one-0001', ?, 'Escola Um', ?)
  `).run(municipalityId, planAdminId).lastInsertRowid);
  const schoolTwoId = Number(db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-backfill-two-0002', ?, 'Escola Dois', ?)
  `).run(municipalityId, planAdminId).lastInsertRowid);
  const otherSchoolId = Number(db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-backfill-other-003', ?, 'Escola Externa', ?)
  `).run(otherMunicipalityId, planAdminId).lastInsertRowid);

  addMembership(
    db, 'municipal-reviewer-01', municipalReviewerId, 'municipal_manager',
    municipalityId, null, planAdminId,
  );
  addMembership(
    db, 'school-reviewer-001', schoolReviewerId, 'school_coordinator',
    municipalityId, schoolOneId, planAdminId,
  );
  addMembership(
    db, 'teacher-school-one1', teacherId, 'teacher',
    municipalityId, schoolOneId, planAdminId,
  );
  addMembership(
    db, 'teacher-school-two2', teacherId, 'teacher',
    municipalityId, schoolTwoId, planAdminId,
  );
  addMembership(
    db, 'outsider-manager-001', outsiderId, 'school_manager',
    otherMunicipalityId, otherSchoolId, planAdminId,
  );

  const classOneId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-backfill-one-00001', ?, 'Turma 7A', 1, 2026, ?)
  `).run(teacherId, teacherId).lastInsertRowid);
  const classTwoId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-backfill-two-00002', ?, 'Turma 7B', 1, 2026, ?)
  `).run(teacherId, teacherId).lastInsertRowid);
  const studentId = Number(db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by
    ) VALUES ('student-backfill-safe-001', ?, 'Estudante Preservado', 'REF-SAFE', ?)
  `).run(teacherId, teacherId).lastInsertRowid);
  db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(classOneId, studentId, teacherId, teacherId);

  return {
    planAdminId,
    linkAdminId,
    municipalReviewerId,
    schoolReviewerId,
    teacherId,
    outsiderId,
    municipalityId,
    otherMunicipalityId,
    schoolOneId,
    schoolTwoId,
    otherSchoolId,
    classOneId,
    classTwoId,
  };
}

function createTwoClassPlan(db, scope, generatedAt = '2026-08-16T12:00:00.000Z') {
  return createInstitutionalBackfillPlan(db, {
    generatedByUserId: scope.planAdminId,
    municipalityPublicId: 'municipality-backfill-0001',
    generatedAt,
    assignments: [
      {
        classPublicId: 'class-backfill-one-00001',
        schoolPublicId: 'school-backfill-one-0001',
      },
      {
        classPublicId: 'class-backfill-two-00002',
        schoolPublicId: 'school-backfill-two-0002',
      },
    ],
  });
}

test('diagnóstico mostra candidatas sem escolher escola automaticamente', () => {
  const db = createDatabase();
  try {
    seedBackfillScenario(db);
    const diagnostic = createInstitutionalBackfillDiagnostic(db, {
      municipalityPublicId: 'municipality-backfill-0001',
      generatedAt: '2026-08-16T11:00:00.000Z',
    });

    assert.equal(diagnostic.policy.automaticSelection, false);
    assert.equal(diagnostic.policy.studentDataIncluded, false);
    assert.equal(diagnostic.counts.pending, 2);
    assert.equal(diagnostic.counts.withMultipleCandidateSchools, 2);
    assert.equal(diagnostic.items[0].requiresExplicitMapping, true);
    assert.deepEqual(
      diagnostic.items[0].candidateSchools.map(({ schoolPublicId }) => schoolPublicId),
      ['school-backfill-two-0002', 'school-backfill-one-0001'],
    );
    assert.doesNotMatch(JSON.stringify(diagnostic), /Estudante Preservado|REF-SAFE/);

    const firstPage = createInstitutionalBackfillDiagnostic(db, {
      municipalityPublicId: 'municipality-backfill-0001',
      limit: 1,
    });
    assert.equal(firstPage.items.length, 1);
    assert.equal(firstPage.pagination.hasMore, true);
    const secondPage = createInstitutionalBackfillDiagnostic(db, {
      municipalityPublicId: 'municipality-backfill-0001',
      limit: 1,
      afterClassPublicId: firstPage.pagination.nextAfterClassPublicId,
    });
    assert.equal(secondPage.items.length, 1);
    assert.equal(secondPage.pagination.hasMore, false);
    assert.notEqual(secondPage.items[0].classPublicId, firstPage.items[0].classPublicId);
  } finally {
    db.close();
  }
});

test('plano exige mapeamento explícito, vínculo docente e hash íntegro', () => {
  const db = createDatabase();
  try {
    const scope = seedBackfillScenario(db);
    const plan = createTwoClassPlan(db, scope);
    assert.equal(plan.policy.automaticSelection, false);
    assert.equal(plan.policy.secondPersonVerificationRequired, true);
    assert.equal(plan.items.length, 2);
    assert.equal(plan.items[0].provenance, 'explicit_manual_mapping');
    assert.equal(validatePlan(plan).digest, plan.planDigest);

    const tampered = structuredClone(plan);
    tampered.items[0].target.schoolPublicId = 'school-backfill-two-0002';
    assert.throws(
      () => validatePlan(tampered),
      (error) => error.code === 'artifact_tampered',
    );

    const unsafeCore = structuredClone(plan);
    delete unsafeCore.planDigest;
    unsafeCore.items[0].studentName = 'Dado que não pode entrar no artefato';
    const unsafePlan = {
      ...unsafeCore,
      planDigest: calculateArtifactDigest(unsafeCore),
    };
    assert.throws(
      () => validatePlan(unsafePlan),
      (error) => error.code === 'invalid_artifact_shape',
    );

    assert.throws(
      () => createInstitutionalBackfillPlan(db, {
        generatedByUserId: scope.planAdminId,
        municipalityPublicId: 'municipality-backfill-0002',
        assignments: [{
          classPublicId: 'class-backfill-one-00001',
          schoolPublicId: 'school-backfill-other-003',
        }],
      }),
      (error) => error.code === 'teacher_membership_required',
    );
  } finally {
    db.close();
  }
});

test('vinculação e verificação são atômicas, auditadas, idempotentes e preservam estudantes', () => {
  const db = createDatabase();
  try {
    const scope = seedBackfillScenario(db);
    const studentBefore = db.prepare('SELECT * FROM students ORDER BY id').all();
    const enrollmentBefore = db.prepare('SELECT * FROM school_class_enrollments ORDER BY id').all();
    const plan = createTwoClassPlan(db, scope);

    assert.throws(
      () => linkInstitutionalBackfillPlan(db, plan, {
        actorUserId: scope.linkAdminId,
        reason: 'Vinculação conferida nos registros administrativos da rede.',
        appEnvironment: 'production',
        confirmation: `LINK ${plan.planDigest}`,
      }),
      (error) => error.code === 'homologation_required',
    );
    assert.throws(
      () => linkInstitutionalBackfillPlan(db, plan, {
        actorUserId: scope.linkAdminId,
        reason: 'Tentativa sem a confirmação exata exigida pelo plano.',
        appEnvironment: 'homologation',
        confirmation: 'LINK hash-incorreto',
      }),
      (error) => error.code === 'confirmation_required',
    );

    const linkReceipt = linkInstitutionalBackfillPlan(db, plan, {
      actorUserId: scope.linkAdminId,
      reason: 'Vinculação conferida nos registros administrativos da rede.',
      appEnvironment: 'homologation',
      confirmation: `LINK ${plan.planDigest}`,
      linkedAt: '2026-08-16T13:00:00.000Z',
    });
    assert.deepEqual(linkReceipt.items.map(({ outcome }) => outcome), ['linked', 'linked']);
    assert.equal(
      db.prepare("SELECT COUNT(*) FROM institutional_audit_log WHERE action = 'backfill_link_class_context'")
        .pluck().get(),
      2,
    );
    assert.equal(
      authorizeClassAggregate(db, scope.planAdminId, 'class-backfill-one-00001').allowed,
      false,
    );

    const retryReceipt = linkInstitutionalBackfillPlan(db, plan, {
      actorUserId: scope.linkAdminId,
      reason: 'Reexecução idempotente após conferência do primeiro recibo.',
      appEnvironment: 'homologation',
      confirmation: `LINK ${plan.planDigest}`,
      linkedAt: '2026-08-16T13:05:00.000Z',
    });
    assert.deepEqual(
      retryReceipt.items.map(({ outcome }) => outcome),
      ['already_linked', 'already_linked'],
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 2);

    const verification = verifyInstitutionalBackfillReceipt(db, linkReceipt, {
      reviewerUserId: scope.municipalReviewerId,
      reason: 'Segunda conferência concluída por responsável municipal autorizado.',
      appEnvironment: 'homologation',
      confirmation: `VERIFY ${linkReceipt.receiptDigest}`,
      verifiedAt: '2026-08-16T14:00:00.000Z',
    });
    assert.deepEqual(verification.items.map(({ outcome }) => outcome), ['verified', 'verified']);
    assert.equal(
      authorizeClassAggregate(db, scope.municipalReviewerId, 'class-backfill-one-00001').allowed,
      true,
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 4);

    const retryVerification = verifyInstitutionalBackfillReceipt(db, linkReceipt, {
      reviewerUserId: scope.municipalReviewerId,
      reason: 'Reexecução idempotente da segunda conferência já registrada.',
      appEnvironment: 'homologation',
      confirmation: `VERIFY ${linkReceipt.receiptDigest}`,
      verifiedAt: '2026-08-16T14:05:00.000Z',
    });
    assert.deepEqual(
      retryVerification.items.map(({ outcome }) => outcome),
      ['already_verified', 'already_verified'],
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 4);
    assert.deepEqual(db.prepare('SELECT * FROM students ORDER BY id').all(), studentBefore);
    assert.deepEqual(
      db.prepare('SELECT * FROM school_class_enrollments ORDER BY id').all(),
      enrollmentBefore,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('segunda pessoa e autorização escolar são obrigatórias', () => {
  const db = createDatabase();
  try {
    const scope = seedBackfillScenario(db);
    const plan = createTwoClassPlan(db, scope);
    const linkReceipt = linkInstitutionalBackfillPlan(db, plan, {
      actorUserId: scope.linkAdminId,
      reason: 'Primeira conferência feita pelo administrador de homologação.',
      appEnvironment: 'homologation',
      confirmation: `LINK ${plan.planDigest}`,
      linkedAt: '2026-08-16T15:00:00.000Z',
    });

    assert.throws(
      () => verifyInstitutionalBackfillReceipt(db, linkReceipt, {
        reviewerUserId: scope.linkAdminId,
        reason: 'Tentativa inválida de autocertificação do vínculo institucional.',
        appEnvironment: 'homologation',
        confirmation: `VERIFY ${linkReceipt.receiptDigest}`,
      }),
      (error) => error.code === 'second_person_required',
    );
    assert.throws(
      () => verifyInstitutionalBackfillReceipt(db, linkReceipt, {
        reviewerUserId: scope.outsiderId,
        reason: 'Tentativa inválida por responsável pertencente a outro município.',
        appEnvironment: 'homologation',
        confirmation: `VERIFY ${linkReceipt.receiptDigest}`,
      }),
      (error) => error.code === 'school_scope_denied',
    );
    addMembership(
      db, 'teacher-manager-own1', scope.teacherId, 'school_manager',
      scope.municipalityId, scope.schoolOneId, scope.planAdminId,
    );
    assert.throws(
      () => verifyInstitutionalBackfillReceipt(db, linkReceipt, {
        reviewerUserId: scope.teacherId,
        reason: 'Tentativa inválida de verificar a própria turma como gestor.',
        appEnvironment: 'homologation',
        confirmation: `VERIFY ${linkReceipt.receiptDigest}`,
      }),
      (error) => error.code === 'owner_cannot_verify',
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM school_class_institution_contexts
        WHERE migration_status = 'verified'
      `).pluck().get(),
      0,
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 2);
  } finally {
    db.close();
  }
});

test('mudança concorrente cancela o lote inteiro sem vínculo ou auditoria parcial', () => {
  const db = createDatabase();
  try {
    const scope = seedBackfillScenario(db);
    const plan = createTwoClassPlan(db, scope);
    db.prepare(`
      UPDATE school_classes
      SET revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(scope.classTwoId);

    assert.throws(
      () => linkInstitutionalBackfillPlan(db, plan, {
        actorUserId: scope.linkAdminId,
        reason: 'Lote que deve ser cancelado integralmente por concorrência.',
        appEnvironment: 'homologation',
        confirmation: `LINK ${plan.planDigest}`,
      }),
      (error) => error.code === 'stale_plan',
    );
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM school_class_institution_contexts
        WHERE migration_status <> 'pending'
      `).pluck().get(),
      0,
    );
    assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 0);
  } finally {
    db.close();
  }
});
