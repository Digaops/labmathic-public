module.exports = {
  version: 2,
  name: 'release_governance_and_feature_flags',
  description: 'Cria releases, feature flags, grupos-piloto, regras e auditoria imutavel.',
  up(db) {
    db.exec(`
      CREATE TABLE product_releases (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        version TEXT NOT NULL COLLATE NOCASE UNIQUE,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'draft'
          CHECK(status IN ('draft', 'pilot', 'rolling_out', 'general', 'paused', 'retired')),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        released_at DATETIME,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE feature_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        flag_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        release_id INTEGER,
        master_enabled INTEGER NOT NULL DEFAULT 0 CHECK(master_enabled IN (0, 1)),
        default_enabled INTEGER NOT NULL DEFAULT 0 CHECK(default_enabled IN (0, 1)),
        rollout_percentage INTEGER NOT NULL DEFAULT 0
          CHECK(rollout_percentage BETWEEN 0 AND 100),
        kill_switch_active INTEGER NOT NULL DEFAULT 0 CHECK(kill_switch_active IN (0, 1)),
        kill_switch_reason TEXT,
        kill_switch_activated_by INTEGER,
        kill_switch_activated_at DATETIME,
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CHECK(
          kill_switch_active = 0
          OR length(trim(COALESCE(kill_switch_reason, ''))) >= 10
        ),
        FOREIGN KEY (release_id) REFERENCES product_releases(id) ON DELETE SET NULL,
        FOREIGN KEY (kill_switch_activated_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE pilot_groups (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_key TEXT NOT NULL COLLATE NOCASE UNIQUE,
        name TEXT NOT NULL,
        description TEXT,
        active INTEGER NOT NULL DEFAULT 1 CHECK(active IN (0, 1)),
        revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE pilot_group_members (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        group_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        added_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(group_id, user_id),
        FOREIGN KEY (group_id) REFERENCES pilot_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (added_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE feature_flag_group_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_flag_id INTEGER NOT NULL,
        group_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0, 1)),
        reason TEXT NOT NULL,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feature_flag_id, group_id),
        FOREIGN KEY (feature_flag_id) REFERENCES feature_flags(id) ON DELETE CASCADE,
        FOREIGN KEY (group_id) REFERENCES pilot_groups(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE feature_flag_user_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_flag_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        reason TEXT NOT NULL,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feature_flag_id, user_id),
        FOREIGN KEY (feature_flag_id) REFERENCES feature_flags(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE feature_flag_role_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        feature_flag_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        enabled INTEGER NOT NULL CHECK(enabled IN (0, 1)),
        reason TEXT NOT NULL,
        created_by INTEGER,
        updated_by INTEGER,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(feature_flag_id, role),
        FOREIGN KEY (feature_flag_id) REFERENCES feature_flags(id) ON DELETE CASCADE,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL,
        FOREIGN KEY (updated_by) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE TABLE governance_audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id INTEGER,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL
          CHECK(entity_type IN ('release', 'feature_flag', 'pilot_group', 'pilot_group_member', 'feature_flag_rule')),
        entity_id INTEGER,
        entity_key TEXT,
        reason TEXT NOT NULL,
        previous_json TEXT,
        current_json TEXT,
        ip_address TEXT,
        user_agent TEXT,
        created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (actor_id) REFERENCES users(id) ON DELETE SET NULL
      );

      CREATE INDEX idx_product_releases_status
        ON product_releases(status, created_at);
      CREATE INDEX idx_feature_flags_release
        ON feature_flags(release_id);
      CREATE INDEX idx_feature_flags_runtime
        ON feature_flags(master_enabled, kill_switch_active);
      CREATE INDEX idx_pilot_groups_active
        ON pilot_groups(active, name);
      CREATE INDEX idx_pilot_group_members_user
        ON pilot_group_members(user_id, group_id);
      CREATE INDEX idx_feature_flag_group_rules_flag
        ON feature_flag_group_rules(feature_flag_id, enabled);
      CREATE INDEX idx_feature_flag_user_rules_user
        ON feature_flag_user_rules(user_id, feature_flag_id);
      CREATE INDEX idx_feature_flag_role_rules_role
        ON feature_flag_role_rules(role, feature_flag_id);
      CREATE INDEX idx_governance_audit_entity
        ON governance_audit_log(entity_type, entity_id, created_at);
      CREATE INDEX idx_governance_audit_actor
        ON governance_audit_log(actor_id, created_at);

      CREATE TRIGGER governance_audit_log_prevent_update
      BEFORE UPDATE ON governance_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'governance_audit_log is immutable');
      END;

      CREATE TRIGGER governance_audit_log_prevent_delete
      BEFORE DELETE ON governance_audit_log
      BEGIN
        SELECT RAISE(ABORT, 'governance_audit_log is immutable');
      END;

      INSERT INTO product_releases (
        version,
        title,
        description,
        status,
        released_at
      ) VALUES (
        '1.4.1',
        'LabMathic v1.4.1',
        'Baseline funcional anterior ao sistema de liberacao gradual.',
        'general',
        CURRENT_TIMESTAMP
      );
    `);
  },
};
