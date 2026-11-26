const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const migration003 = require('../src/migrations/003_classes_and_students_foundation');
const migration016 = require('../src/migrations/016_institutional_foundation');

function createPreInstitutionDatabase() {
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
  `);
  migration002.up(db);
  migration003.up(db);
  return db;
}

function seedLegacyFixtures(db) {
  const adminId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Administrador Geral', 'admin@teste.local', 'hash', 'admin')
  `).run().lastInsertRowid;
  const teacherOneId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professora Um', 'professora-um@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const teacherTwoId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Dois', 'professor-dois@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const managerId = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Gestora Municipal', 'gestora@teste.local', 'hash', 'professor')
  `).run().lastInsertRowid;
  const gradeId = db.prepare("INSERT INTO grades (name) VALUES ('7o Ano')")
    .run().lastInsertRowid;
  const disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Matematica')")
    .run().lastInsertRowid;

  const classOneId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('legacy-class-public-00001', ?, 'Turma A', ?, 2026, ?)
  `).run(teacherOneId, gradeId, teacherOneId).lastInsertRowid;
  const classTwoId = db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('legacy-class-public-00002', ?, 'Turma B', ?, 2026, ?)
  `).run(teacherTwoId, gradeId, teacherTwoId).lastInsertRowid;
  const studentId = db.prepare(`
    INSERT INTO students (
      public_id, owner_teacher_id, display_name, external_reference, created_by
    ) VALUES ('legacy-student-public-01', ?, 'Estudante Preservado', 'MAT-001', ?)
  `).run(teacherOneId, teacherOneId).lastInsertRowid;
  db.prepare(`
    INSERT INTO school_class_enrollments (
      class_id, student_id, owner_teacher_id, created_by
    ) VALUES (?, ?, ?, ?)
  `).run(classOneId, studentId, teacherOneId, teacherOneId);
  db.prepare(`
    INSERT INTO school_class_disciplines (
      class_id, owner_teacher_id, discipline_id, added_by
    ) VALUES (?, ?, ?, ?)
  `).run(classOneId, teacherOneId, disciplineId, teacherOneId);

  return {
    adminId,
    teacherOneId,
    teacherTwoId,
    managerId,
    gradeId,
    classOneId,
    classTwoId,
    studentId,
  };
}

function insertMunicipality(db, suffix, createdBy, ibgeCode) {
  return db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES (?, ?, ?, ?)
  `).run(
    `municipality-public-${suffix.padEnd(8, '0')}`,
    `Municipio ${suffix}`,
    ibgeCode,
    createdBy,
  ).lastInsertRowid;
}

function insertSchool(db, municipalityId, suffix, createdBy) {
  return db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, census_code, created_by)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    `school-public-${suffix.padEnd(14, '0')}`,
    municipalityId,
    `Escola ${suffix}`,
    `INEP-${suffix}`,
    createdBy,
  ).lastInsertRowid;
}

function insertMembership(db, {
  userId,
  role,
  municipalityId,
  schoolId = null,
  createdBy,
  suffix,
}) {
  return db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    `membership-public-${suffix.padEnd(10, '0')}`,
    userId,
    role,
    municipalityId,
    schoolId,
    createdBy,
  ).lastInsertRowid;
}

test('migração 016 expande o schema, preserva dados legados e mantém a flag desligada', () => {
  const db = createPreInstitutionDatabase();
  try {
    const fixtures = seedLegacyFixtures(db);
    const legacyClassesBefore = db.prepare('SELECT * FROM school_classes ORDER BY id').all();
    const legacyStudentsBefore = db.prepare('SELECT * FROM students ORDER BY id').all();
    const classColumnsBefore = db.pragma('table_info(school_classes)');

    migration016.up(db);

    const tables = new Set(
      db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
        .map(({ name }) => name),
    );
    for (const tableName of [
      'municipalities',
      'schools',
      'institutional_memberships',
      'school_class_institution_contexts',
      'institutional_audit_log',
    ]) {
      assert.equal(tables.has(tableName), true, `${tableName} deveria existir`);
    }

    assert.deepEqual(db.prepare('SELECT * FROM school_classes ORDER BY id').all(), legacyClassesBefore);
    assert.deepEqual(db.prepare('SELECT * FROM students ORDER BY id').all(), legacyStudentsBefore);
    assert.deepEqual(db.pragma('table_info(school_classes)'), classColumnsBefore);
    assert.deepEqual(
      db.prepare(`
        SELECT class_id, owner_teacher_id, migration_status, municipality_id, school_id
        FROM school_class_institution_contexts
        ORDER BY class_id
      `).all(),
      [
        {
          class_id: fixtures.classOneId,
          owner_teacher_id: fixtures.teacherOneId,
          migration_status: 'pending',
          municipality_id: null,
          school_id: null,
        },
        {
          class_id: fixtures.classTwoId,
          owner_teacher_id: fixtures.teacherTwoId,
          migration_status: 'pending',
          municipality_id: null,
          school_id: null,
        },
      ],
    );

    const newClassId = db.prepare(`
      INSERT INTO school_classes (
        public_id, owner_teacher_id, name, grade_id, academic_year, created_by
      ) VALUES ('new-class-public-00000001', ?, 'Turma Nova', ?, 2026, ?)
    `).run(fixtures.teacherOneId, fixtures.gradeId, fixtures.teacherOneId).lastInsertRowid;
    assert.deepEqual(
      db.prepare(`
        SELECT class_id, owner_teacher_id, migration_status
        FROM school_class_institution_contexts
        WHERE class_id = ?
      `).get(newClassId),
      {
        class_id: newClassId,
        owner_teacher_id: fixtures.teacherOneId,
        migration_status: 'pending',
      },
    );

    assert.deepEqual(
      db.prepare(`
        SELECT version, status
        FROM product_releases
        WHERE version = '2.1.0'
      `).get(),
      { version: '2.1.0', status: 'draft' },
    );
    assert.deepEqual(
      db.prepare(`
        SELECT flag_key, master_enabled, default_enabled, rollout_percentage,
          kill_switch_active
        FROM feature_flags
        WHERE flag_key = 'institutions.core'
      `).get(),
      {
        flag_key: 'institutions.core',
        master_enabled: 0,
        default_enabled: 0,
        rollout_percentage: 0,
        kill_switch_active: 0,
      },
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('banco permite professor multiescola e bloqueia qualquer vínculo entre municípios', () => {
  const db = createPreInstitutionDatabase();
  try {
    const fixtures = seedLegacyFixtures(db);
    migration016.up(db);
    const municipalityOneId = insertMunicipality(db, 'A', fixtures.adminId, '3550308');
    const municipalityTwoId = insertMunicipality(db, 'B', fixtures.adminId, '3304557');
    const schoolOneId = insertSchool(db, municipalityOneId, 'A1', fixtures.adminId);
    const schoolTwoId = insertSchool(db, municipalityOneId, 'A2', fixtures.adminId);
    const schoolOtherMunicipalityId = insertSchool(
      db,
      municipalityTwoId,
      'B1',
      fixtures.adminId,
    );

    insertMembership(db, {
      userId: fixtures.teacherOneId,
      role: 'teacher',
      municipalityId: municipalityOneId,
      schoolId: schoolOneId,
      createdBy: fixtures.adminId,
      suffix: 'teacher-a1',
    });
    insertMembership(db, {
      userId: fixtures.teacherOneId,
      role: 'teacher',
      municipalityId: municipalityOneId,
      schoolId: schoolTwoId,
      createdBy: fixtures.adminId,
      suffix: 'teacher-a2',
    });
    insertMembership(db, {
      userId: fixtures.teacherOneId,
      role: 'teacher',
      municipalityId: municipalityTwoId,
      schoolId: schoolOtherMunicipalityId,
      createdBy: fixtures.adminId,
      suffix: 'teacher-b1',
    });
    assert.equal(
      db.prepare(`
        SELECT COUNT(*) FROM institutional_memberships
        WHERE user_id = ? AND role = 'teacher' AND status = 'active'
      `).pluck().get(fixtures.teacherOneId),
      3,
    );

    assert.throws(
      () => insertMembership(db, {
        userId: fixtures.teacherTwoId,
        role: 'teacher',
        municipalityId: municipalityOneId,
        schoolId: schoolOtherMunicipalityId,
        createdBy: fixtures.adminId,
        suffix: 'cross-scope',
      }),
      /institutional_membership_requires_active_scope/,
    );
    assert.throws(
      () => insertMembership(db, {
        userId: fixtures.adminId,
        role: 'school_manager',
        municipalityId: municipalityOneId,
        schoolId: schoolOneId,
        createdBy: fixtures.adminId,
        suffix: 'admin-scope',
      }),
      /institutional_membership_requires_professional_user/,
    );

    db.prepare(`
      UPDATE school_class_institution_contexts
      SET municipality_id = ?,
          school_id = ?,
          migration_status = 'linked',
          linked_by = ?,
          linked_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE class_id = ?
    `).run(
      municipalityOneId,
      schoolOneId,
      fixtures.adminId,
      fixtures.classOneId,
    );
    assert.throws(
      () => db.prepare(`
        UPDATE school_class_institution_contexts
        SET municipality_id = ?,
            school_id = ?,
            migration_status = 'linked',
            linked_by = ?,
            linked_at = CURRENT_TIMESTAMP,
            updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ?
      `).run(
        municipalityOneId,
        schoolOneId,
        fixtures.adminId,
        fixtures.classTwoId,
      ),
      /class_context_requires_active_teacher_membership/,
    );
    assert.throws(
      () => db.prepare(`
        UPDATE school_class_institution_contexts
        SET municipality_id = ?, school_id = ?, updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ?
      `).run(municipalityTwoId, schoolOtherMunicipalityId, fixtures.classOneId),
      /class_context_scope_change_requires_pending_state/,
    );

    db.prepare(`
      UPDATE school_class_institution_contexts
      SET migration_status = 'verified',
          verified_by = ?,
          verified_at = CURRENT_TIMESTAMP,
          updated_at = CURRENT_TIMESTAMP
      WHERE class_id = ?
    `).run(fixtures.managerId, fixtures.classOneId);
    assert.throws(
      () => db.prepare(`
        UPDATE school_class_institution_contexts
        SET updated_at = CURRENT_TIMESTAMP
        WHERE class_id = ?
      `).run(fixtures.classOneId),
      /verified_class_context_is_immutable/,
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});

test('auditoria institucional exige contexto coerente e é imutável', () => {
  const db = createPreInstitutionDatabase();
  try {
    const fixtures = seedLegacyFixtures(db);
    migration016.up(db);
    const municipalityOneId = insertMunicipality(db, 'A', fixtures.adminId, '3550308');
    const municipalityTwoId = insertMunicipality(db, 'B', fixtures.adminId, '3304557');
    const schoolOneId = insertSchool(db, municipalityOneId, 'A1', fixtures.adminId);

    const auditId = db.prepare(`
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
        current_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      fixtures.adminId,
      'Administrador Geral',
      fixtures.teacherOneId,
      'Professora Um',
      'link_class',
      'school_class_context',
      'legacy-class-public-00001',
      municipalityOneId,
      schoolOneId,
      'Vinculo institucional confirmado pelo administrador geral.',
      JSON.stringify({ migrationStatus: 'linked' }),
    ).lastInsertRowid;

    assert.throws(
      () => db.prepare(`
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
          reason
        ) VALUES (?, 'Administrador Geral', ?, 'Professora Um',
          'link_class', 'school_class_context', 'cross-scope', ?, ?,
          'Tentativa de registrar um contexto institucional incoerente.')
      `).run(
        fixtures.adminId,
        fixtures.teacherOneId,
        municipalityTwoId,
        schoolOneId,
      ),
      /FOREIGN KEY constraint failed/,
    );
    assert.throws(
      () => db.prepare(`
        UPDATE institutional_audit_log
        SET reason = 'Motivo adulterado depois do registro original.'
        WHERE id = ?
      `).run(auditId),
      /institutional_audit_log_is_immutable/,
    );
    assert.throws(
      () => db.prepare('DELETE FROM institutional_audit_log WHERE id = ?').run(auditId),
      /institutional_audit_log_is_immutable/,
    );
    assert.equal(
      db.prepare('SELECT responsible_name_snapshot FROM institutional_audit_log WHERE id = ?')
        .pluck().get(auditId),
      'Professora Um',
    );
    assert.deepEqual(db.pragma('foreign_key_check'), []);
  } finally {
    db.close();
  }
});
