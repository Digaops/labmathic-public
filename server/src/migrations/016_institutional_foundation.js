module.exports = {
  version: 16,
  name: 'institutional_foundation',
  description: 'Adiciona municipios, escolas, vinculos profissionais, contexto institucional de turmas e auditoria imutavel.',
  up(db) {
    db.exec(`
      CREATE TABLE municipalities (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL COLLATE NOCASE,
        ibge_code TEXT COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(name)) BETWEEN 2 AND 160),
        CHECK(
          ibge_code IS NULL
          OR (
            length(ibge_code) = 7
            AND ibge_code NOT GLOB '*[^0-9]*'
          )
        ),
        CHECK(
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND julianday(archived_at) IS NOT NULL)
        ),
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX idx_municipalities_ibge_code
        ON municipalities(ibge_code)
        WHERE ibge_code IS NOT NULL;
      CREATE INDEX idx_municipalities_status_name
        ON municipalities(status, name);

      CREATE TABLE schools (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        municipality_id INTEGER NOT NULL,
        name TEXT NOT NULL COLLATE NOCASE,
        census_code TEXT COLLATE NOCASE,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'archived')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        archived_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(length(trim(name)) BETWEEN 2 AND 180),
        CHECK(
          census_code IS NULL
          OR length(trim(census_code)) BETWEEN 1 AND 32
        ),
        CHECK(
          (status = 'active' AND archived_at IS NULL)
          OR (status = 'archived' AND julianday(archived_at) IS NOT NULL)
        ),
        UNIQUE(id, municipality_id),
        FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX idx_schools_municipality_census_code
        ON schools(municipality_id, census_code)
        WHERE census_code IS NOT NULL;
      CREATE INDEX idx_schools_municipality_status_name
        ON schools(municipality_id, status, name);

      CREATE TABLE institutional_memberships (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        public_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL
          CHECK(role IN ('municipal_manager', 'school_manager', 'school_coordinator', 'teacher')),
        municipality_id INTEGER NOT NULL,
        school_id INTEGER,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK(status IN ('active', 'inactive')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        ended_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(public_id)) BETWEEN 20 AND 64),
        CHECK(
          (role = 'municipal_manager' AND school_id IS NULL)
          OR (role <> 'municipal_manager' AND school_id IS NOT NULL)
        ),
        CHECK(
          (status = 'active' AND ended_at IS NULL)
          OR (status = 'inactive' AND julianday(ended_at) IS NOT NULL)
        ),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE RESTRICT,
        FOREIGN KEY (school_id, municipality_id)
          REFERENCES schools(id, municipality_id) ON DELETE RESTRICT,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE UNIQUE INDEX idx_institutional_memberships_municipality_scope
        ON institutional_memberships(user_id, municipality_id, role)
        WHERE school_id IS NULL;
      CREATE UNIQUE INDEX idx_institutional_memberships_school_scope
        ON institutional_memberships(user_id, municipality_id, school_id, role)
        WHERE school_id IS NOT NULL;
      CREATE INDEX idx_institutional_memberships_user_active
        ON institutional_memberships(user_id, status, role);
      CREATE INDEX idx_institutional_memberships_municipality_active
        ON institutional_memberships(municipality_id, status, role);
      CREATE INDEX idx_institutional_memberships_school_active
        ON institutional_memberships(school_id, status, role);

      CREATE TABLE school_class_institution_contexts (
        class_id INTEGER PRIMARY KEY,
        owner_teacher_id INTEGER NOT NULL,
        municipality_id INTEGER,
        school_id INTEGER,
        migration_status TEXT NOT NULL DEFAULT 'pending'
          CHECK(migration_status IN ('pending', 'linked', 'verified')),
        linked_by INTEGER,
        verified_by INTEGER,
        linked_at DATETIME,
        verified_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(
          (
            migration_status = 'pending'
            AND municipality_id IS NULL
            AND school_id IS NULL
            AND linked_by IS NULL
            AND verified_by IS NULL
            AND linked_at IS NULL
            AND verified_at IS NULL
          )
          OR (
            migration_status = 'linked'
            AND municipality_id IS NOT NULL
            AND school_id IS NOT NULL
            AND linked_by IS NOT NULL
            AND julianday(linked_at) IS NOT NULL
            AND verified_by IS NULL
            AND verified_at IS NULL
          )
          OR (
            migration_status = 'verified'
            AND municipality_id IS NOT NULL
            AND school_id IS NOT NULL
            AND linked_by IS NOT NULL
            AND julianday(linked_at) IS NOT NULL
            AND verified_by IS NOT NULL
            AND julianday(verified_at) IS NOT NULL
          )
        ),
        UNIQUE(class_id, owner_teacher_id),
        FOREIGN KEY (class_id, owner_teacher_id)
          REFERENCES school_classes(id, owner_teacher_id) ON DELETE RESTRICT,
        FOREIGN KEY (school_id, municipality_id)
          REFERENCES schools(id, municipality_id) ON DELETE RESTRICT,
        FOREIGN KEY (linked_by) REFERENCES users(id) ON DELETE RESTRICT,
        FOREIGN KEY (verified_by) REFERENCES users(id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_school_class_contexts_migration_status
        ON school_class_institution_contexts(migration_status, class_id);
      CREATE INDEX idx_school_class_contexts_municipality_school
        ON school_class_institution_contexts(municipality_id, school_id, migration_status);
      CREATE INDEX idx_school_class_contexts_owner
        ON school_class_institution_contexts(owner_teacher_id, migration_status);

      CREATE TABLE institutional_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_user_id INTEGER,
        actor_name_snapshot TEXT NOT NULL,
        responsible_user_id INTEGER,
        responsible_name_snapshot TEXT NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL
          CHECK(entity_type IN ('municipality', 'school', 'membership', 'school_class_context', 'authorization')),
        entity_key TEXT NOT NULL,
        municipality_id INTEGER,
        school_id INTEGER,
        reason TEXT NOT NULL,
        previous_json TEXT,
        current_json TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(length(trim(actor_name_snapshot)) BETWEEN 1 AND 160),
        CHECK(length(trim(responsible_name_snapshot)) BETWEEN 1 AND 160),
        CHECK(length(trim(action)) BETWEEN 3 AND 80),
        CHECK(length(trim(entity_key)) BETWEEN 1 AND 128),
        CHECK(length(trim(reason)) BETWEEN 10 AND 500),
        CHECK(school_id IS NULL OR municipality_id IS NOT NULL),
        FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (responsible_user_id) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (municipality_id) REFERENCES municipalities(id) ON DELETE RESTRICT,
        FOREIGN KEY (school_id, municipality_id)
          REFERENCES schools(id, municipality_id) ON DELETE RESTRICT
      );

      CREATE INDEX idx_institutional_audit_municipality_created
        ON institutional_audit_log(municipality_id, created_at);
      CREATE INDEX idx_institutional_audit_school_created
        ON institutional_audit_log(school_id, created_at);
      CREATE INDEX idx_institutional_audit_actor_created
        ON institutional_audit_log(actor_user_id, created_at);
      CREATE INDEX idx_institutional_audit_responsible_created
        ON institutional_audit_log(responsible_user_id, created_at);
      CREATE INDEX idx_institutional_audit_entity_created
        ON institutional_audit_log(entity_type, entity_key, created_at);

      CREATE TRIGGER schools_require_active_municipality_insert
      BEFORE INSERT ON schools
      WHEN NEW.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM municipalities
          WHERE id = NEW.municipality_id AND status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'active_school_requires_active_municipality');
      END;

      CREATE TRIGGER schools_require_active_municipality_update
      BEFORE UPDATE OF status, municipality_id ON schools
      WHEN NEW.status = 'active'
        AND NOT EXISTS (
          SELECT 1 FROM municipalities
          WHERE id = NEW.municipality_id AND status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'active_school_requires_active_municipality');
      END;

      CREATE TRIGGER schools_municipality_is_immutable
      BEFORE UPDATE OF municipality_id ON schools
      WHEN NEW.municipality_id IS NOT OLD.municipality_id
      BEGIN
        SELECT RAISE(ABORT, 'school_municipality_is_immutable');
      END;

      CREATE TRIGGER municipalities_archive_requires_inactive_scope
      BEFORE UPDATE OF status ON municipalities
      WHEN NEW.status = 'archived'
        AND (
          EXISTS (
            SELECT 1 FROM schools
            WHERE municipality_id = OLD.id AND status = 'active'
          )
          OR EXISTS (
            SELECT 1 FROM institutional_memberships
            WHERE municipality_id = OLD.id AND status = 'active'
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'municipality_has_active_scope');
      END;

      CREATE TRIGGER schools_archive_requires_inactive_memberships
      BEFORE UPDATE OF status ON schools
      WHEN NEW.status = 'archived'
        AND EXISTS (
          SELECT 1 FROM institutional_memberships
          WHERE school_id = OLD.id AND status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'school_has_active_memberships');
      END;

      CREATE TRIGGER institutional_memberships_require_professional_user_insert
      BEFORE INSERT ON institutional_memberships
      WHEN COALESCE((SELECT role FROM users WHERE id = NEW.user_id), '') <> 'professor'
      BEGIN
        SELECT RAISE(ABORT, 'institutional_membership_requires_professional_user');
      END;

      CREATE TRIGGER institutional_memberships_require_active_scope_insert
      BEFORE INSERT ON institutional_memberships
      WHEN NEW.status = 'active'
        AND (
          NOT EXISTS (
            SELECT 1 FROM municipalities
            WHERE id = NEW.municipality_id AND status = 'active'
          )
          OR (
            NEW.school_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM schools
              WHERE id = NEW.school_id
                AND municipality_id = NEW.municipality_id
                AND status = 'active'
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'institutional_membership_requires_active_scope');
      END;

      CREATE TRIGGER institutional_memberships_require_active_scope_update
      BEFORE UPDATE OF status ON institutional_memberships
      WHEN NEW.status = 'active'
        AND (
          NOT EXISTS (
            SELECT 1 FROM municipalities
            WHERE id = NEW.municipality_id AND status = 'active'
          )
          OR (
            NEW.school_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM schools
              WHERE id = NEW.school_id
                AND municipality_id = NEW.municipality_id
                AND status = 'active'
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'institutional_membership_requires_active_scope');
      END;

      CREATE TRIGGER institutional_membership_scope_is_immutable
      BEFORE UPDATE OF user_id, role, municipality_id, school_id, created_at
      ON institutional_memberships
      WHEN NEW.user_id IS NOT OLD.user_id
        OR NEW.role IS NOT OLD.role
        OR NEW.municipality_id IS NOT OLD.municipality_id
        OR NEW.school_id IS NOT OLD.school_id
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'institutional_membership_scope_is_immutable');
      END;

      CREATE TRIGGER school_class_contexts_validate_insert
      BEFORE INSERT ON school_class_institution_contexts
      WHEN NEW.migration_status IN ('linked', 'verified')
        AND NOT EXISTS (
          SELECT 1
          FROM institutional_memberships membership
          JOIN schools school
            ON school.id = membership.school_id
            AND school.municipality_id = membership.municipality_id
          JOIN municipalities municipality
            ON municipality.id = membership.municipality_id
          WHERE membership.user_id = NEW.owner_teacher_id
            AND membership.role = 'teacher'
            AND membership.municipality_id = NEW.municipality_id
            AND membership.school_id = NEW.school_id
            AND membership.status = 'active'
            AND school.status = 'active'
            AND municipality.status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'class_context_requires_active_teacher_membership');
      END;

      CREATE TRIGGER school_class_contexts_validate_update
      BEFORE UPDATE OF migration_status, municipality_id, school_id
      ON school_class_institution_contexts
      WHEN NEW.migration_status IN ('linked', 'verified')
        AND NOT EXISTS (
          SELECT 1
          FROM institutional_memberships membership
          JOIN schools school
            ON school.id = membership.school_id
            AND school.municipality_id = membership.municipality_id
          JOIN municipalities municipality
            ON municipality.id = membership.municipality_id
          WHERE membership.user_id = NEW.owner_teacher_id
            AND membership.role = 'teacher'
            AND membership.municipality_id = NEW.municipality_id
            AND membership.school_id = NEW.school_id
            AND membership.status = 'active'
            AND school.status = 'active'
            AND municipality.status = 'active'
        )
      BEGIN
        SELECT RAISE(ABORT, 'class_context_requires_active_teacher_membership');
      END;

      CREATE TRIGGER school_class_context_identity_is_immutable
      BEFORE UPDATE OF class_id, owner_teacher_id, created_at
      ON school_class_institution_contexts
      WHEN NEW.class_id IS NOT OLD.class_id
        OR NEW.owner_teacher_id IS NOT OLD.owner_teacher_id
        OR NEW.created_at IS NOT OLD.created_at
      BEGIN
        SELECT RAISE(ABORT, 'class_context_identity_is_immutable');
      END;

      CREATE TRIGGER school_class_context_verified_is_immutable
      BEFORE UPDATE ON school_class_institution_contexts
      WHEN OLD.migration_status = 'verified'
      BEGIN
        SELECT RAISE(ABORT, 'verified_class_context_is_immutable');
      END;

      CREATE TRIGGER school_class_context_status_transition
      BEFORE UPDATE OF migration_status ON school_class_institution_contexts
      WHEN NEW.migration_status <> OLD.migration_status
        AND NOT (
          (OLD.migration_status = 'pending' AND NEW.migration_status = 'linked')
          OR (OLD.migration_status = 'linked' AND NEW.migration_status IN ('pending', 'verified'))
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid_class_context_status_transition');
      END;

      CREATE TRIGGER school_class_context_scope_change_requires_transition
      BEFORE UPDATE OF municipality_id, school_id ON school_class_institution_contexts
      WHEN OLD.migration_status <> 'pending'
        AND NOT (
          NEW.migration_status = 'pending'
          AND NEW.municipality_id IS NULL
          AND NEW.school_id IS NULL
        )
        AND (
          NEW.municipality_id IS NOT OLD.municipality_id
          OR NEW.school_id IS NOT OLD.school_id
        )
      BEGIN
        SELECT RAISE(ABORT, 'class_context_scope_change_requires_pending_state');
      END;

      CREATE TRIGGER school_class_contexts_prevent_delete
      BEFORE DELETE ON school_class_institution_contexts
      BEGIN
        SELECT RAISE(ABORT, 'school_class_context_history_is_immutable');
      END;

      CREATE TRIGGER school_classes_create_pending_institution_context
      AFTER INSERT ON school_classes
      BEGIN
        INSERT INTO school_class_institution_contexts (
          class_id,
          owner_teacher_id,
          migration_status
        ) VALUES (NEW.id, NEW.owner_teacher_id, 'pending');
      END;

      CREATE TRIGGER institutional_audit_log_prevent_update
      BEFORE UPDATE ON institutional_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'institutional_audit_log_is_immutable');
      END;

      CREATE TRIGGER institutional_audit_log_prevent_delete
      BEFORE DELETE ON institutional_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'institutional_audit_log_is_immutable');
      END;

      INSERT INTO school_class_institution_contexts (
        class_id,
        owner_teacher_id,
        migration_status
      )
      SELECT id, owner_teacher_id, 'pending'
      FROM school_classes;

      INSERT INTO product_releases (
        version,
        title,
        description,
        status
      ) VALUES (
        '2.1.0',
        'Fundacao institucional',
        'Hierarquia segura de municipios, escolas, profissionais e turmas.',
        'draft'
      );

      INSERT INTO feature_flags (
        flag_key,
        name,
        description,
        release_id,
        master_enabled,
        default_enabled,
        rollout_percentage
      )
      SELECT
        'institutions.core',
        'Fundacao institucional',
        'Contexto institucional de municipios, escolas, profissionais e turmas.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.1.0';
    `);
  },
};
