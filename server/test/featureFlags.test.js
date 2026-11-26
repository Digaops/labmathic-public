const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const migration002 = require('../src/migrations/002_release_governance_and_feature_flags');
const config = require('../src/config');
const {
  HOMOLOGATION_OPEN_FEATURES,
  evaluateFeatureFlag,
  stableRolloutBucket,
} = require('../src/services/featureFlags');

test('homologação libera somente funcionalidades de turmas já implementadas', (t) => {
  const db = createGovernanceDatabase(t);
  for (const key of HOMOLOGATION_OPEN_FEATURES) createFlag(db, { key });
  createFlag(db, { key: 'institutions.core', name: 'Fundação institucional' });
  createFlag(db, { key: 'question_bank.typed_engine', name: 'Motor tipado' });
  const previousEnvironment = config.appEnvironment;
  config.appEnvironment = 'homologation';
  t.after(() => {
    config.appEnvironment = previousEnvironment;
  });

  assert.deepEqual(
    evaluateFeatureFlag(db, 'classes.core', { id: 1, role: 'professor' }),
    {
      key: 'classes.core',
      enabled: true,
      reason: 'homologation_open_testing',
    }
  );
  assert.equal(
    evaluateFeatureFlag(db, 'classes.assessment_delivery', { id: 2, role: 'professor' }).enabled,
    true
  );
  assert.equal(
    evaluateFeatureFlag(db, 'classes.assessment_results', { id: 1, role: 'professor' }).enabled,
    true
  );
  assert.equal(
    evaluateFeatureFlag(db, 'classes.learning_recovery', { id: 1, role: 'professor' }).enabled,
    true
  );
  assert.equal(
    evaluateFeatureFlag(db, 'question_bank.diagnostic_generator', { id: 1, role: 'professor' }).enabled,
    true
  );
  assert.equal(
    evaluateFeatureFlag(db, 'qualquer.outra_feature', { id: 1, role: 'professor' }).enabled,
    false
  );
  assert.deepEqual(
    evaluateFeatureFlag(db, 'institutions.core', { id: 1, role: 'professor' }),
    { key: 'institutions.core', enabled: false, reason: 'master_disabled' }
  );
  assert.deepEqual(
    evaluateFeatureFlag(db, 'question_bank.typed_engine', { id: 1, role: 'professor' }),
    { key: 'question_bank.typed_engine', enabled: false, reason: 'master_disabled' }
  );
});

test('homologação exige flag cadastrada e respeita qualquer bloqueio, inclusive o legado da sanitização', (t) => {
  const db = createGovernanceDatabase(t);
  const previousEnvironment = config.appEnvironment;
  config.appEnvironment = 'homologation';
  t.after(() => { config.appEnvironment = previousEnvironment; });
  for (const key of HOMOLOGATION_OPEN_FEATURES) {
    assert.deepEqual(evaluateFeatureFlag(db, key, { id: 1, role: 'admin' }),
      { key, enabled: false, reason: 'not_found' });
    const flag = createFlag(db, { key });
    for (const reason of ['Desativada automaticamente na cópia sanitizada.', 'Interrupção preventiva']) {
      db.prepare('UPDATE feature_flags SET kill_switch_active = 1, kill_switch_reason = ? WHERE id = ?')
        .run(reason, flag.id);
      const before = db.prepare('SELECT * FROM feature_flags WHERE id = ?').get(flag.id);
      for (const role of ['admin', 'professor']) {
        assert.deepEqual(evaluateFeatureFlag(db, ` ${key.toUpperCase()} `, { id: 1, role }),
          { key, enabled: false, reason: 'kill_switch' });
      }
      assert.deepEqual(db.prepare('SELECT * FROM feature_flags WHERE id = ?').get(flag.id), before);
    }
    db.prepare('UPDATE feature_flags SET kill_switch_active = 0 WHERE id = ?').run(flag.id);
    assert.equal(evaluateFeatureFlag(db, key, { id: 1, role: 'professor' }).reason, 'homologation_open_testing');
  }
});

function createGovernanceDatabase(t) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-flags-'));
  const db = new Database(path.join(tempDir, 'database.sqlite'));
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      email TEXT NOT NULL UNIQUE,
      password TEXT NOT NULL,
      role TEXT NOT NULL
    )
  `);
  migration002.up(db);
  db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Piloto', 'piloto@teste.local', 'hash', 'professor')
  `).run();
  db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES ('Professor Controle', 'controle@teste.local', 'hash', 'professor')
  `).run();

  t.after(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  return db;
}

function createFlag(db, overrides = {}) {
  const release = db.prepare("SELECT id FROM product_releases WHERE version = '1.4.1'").get();
  const values = {
    key: 'turmas.nova_experiencia',
    name: 'Nova experiência de turmas',
    releaseId: release.id,
    masterEnabled: 0,
    defaultEnabled: 0,
    rolloutPercentage: 0,
    ...overrides,
  };
  const result = db.prepare(`
    INSERT INTO feature_flags (
      flag_key, name, release_id, master_enabled,
      default_enabled, rollout_percentage
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    values.key,
    values.name,
    values.releaseId,
    values.masterEnabled,
    values.defaultEnabled,
    values.rolloutPercentage
  );
  return { id: result.lastInsertRowid, ...values };
}

test('migração 002 cria a governança sem violações de chave estrangeira', (t) => {
  const db = createGovernanceDatabase(t);
  const requiredTables = [
    'product_releases',
    'feature_flags',
    'pilot_groups',
    'pilot_group_members',
    'feature_flag_group_rules',
    'feature_flag_user_rules',
    'feature_flag_role_rules',
    'governance_audit_log',
  ];
  const tables = new Set(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()
      .map((row) => row.name)
  );

  for (const table of requiredTables) assert.equal(tables.has(table), true);
  assert.deepEqual(
    db.prepare("SELECT version, status FROM product_releases WHERE version = '1.4.1'").get(),
    { version: '1.4.1', status: 'general' }
  );
  assert.equal(db.pragma('foreign_key_check').length, 0);
});

test('trilha de governança não pode ser alterada nem excluída', (t) => {
  const db = createGovernanceDatabase(t);
  db.prepare(`
    INSERT INTO governance_audit_log (
      actor_id, action, entity_type, entity_id, entity_key, reason
    ) VALUES (1, 'test_action', 'feature_flag', 1, 'teste.flag', 'Registro criado pelo teste')
  `).run();

  assert.throws(
    () => db.prepare("UPDATE governance_audit_log SET reason = 'adulterado' WHERE id = 1").run(),
    /immutable/
  );
  assert.throws(
    () => db.prepare('DELETE FROM governance_audit_log WHERE id = 1').run(),
    /immutable/
  );
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM governance_audit_log').get().count,
    1
  );
});

test('uma feature flag nasce e permanece desligada enquanto o mestre estiver desativado', (t) => {
  const db = createGovernanceDatabase(t);
  createFlag(db, { defaultEnabled: 1, rolloutPercentage: 100 });
  const user = { id: 1, role: 'professor' };

  assert.deepEqual(
    evaluateFeatureFlag(db, 'turmas.nova_experiencia', user),
    {
      key: 'turmas.nova_experiencia',
      enabled: false,
      reason: 'master_disabled',
    }
  );
});

test('grupo-piloto libera somente seus membros e regra individual pode bloquear', (t) => {
  const db = createGovernanceDatabase(t);
  const pilotRelease = db.prepare(`
    INSERT INTO product_releases (version, title, status)
    VALUES ('1.6.0', 'Release piloto', 'pilot')
  `).run();
  const flag = createFlag(db, {
    releaseId: pilotRelease.lastInsertRowid,
    masterEnabled: 1,
  });
  const group = db.prepare(`
    INSERT INTO pilot_groups (group_key, name)
    VALUES ('professores_piloto', 'Professores piloto')
  `).run();
  db.prepare('INSERT INTO pilot_group_members (group_id, user_id) VALUES (?, 1)')
    .run(group.lastInsertRowid);
  db.prepare(`
    INSERT INTO feature_flag_group_rules (
      feature_flag_id, group_id, enabled, reason
    ) VALUES (?, ?, 1, 'Grupo autorizado para o piloto')
  `).run(flag.id, group.lastInsertRowid);

  assert.equal(
    evaluateFeatureFlag(db, flag.key, { id: 1, role: 'professor' }).enabled,
    true
  );
  assert.deepEqual(
    evaluateFeatureFlag(db, flag.key, { id: 2, role: 'professor' }),
    {
      key: flag.key,
      enabled: false,
      reason: 'release_restricted_to_pilot',
    }
  );

  db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason
    ) VALUES (?, 1, 0, 'Bloqueio individual de segurança')
  `).run(flag.id);
  assert.deepEqual(
    evaluateFeatureFlag(db, flag.key, { id: 1, role: 'professor' }),
    { key: flag.key, enabled: false, reason: 'user_rule' }
  );
});

test('kill switch prevalece sobre liberação individual e grupo-piloto', (t) => {
  const db = createGovernanceDatabase(t);
  const flag = createFlag(db, { masterEnabled: 1 });
  db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason
    ) VALUES (?, 1, 1, 'Usuário liberado para validação')
  `).run(flag.id);
  db.prepare(`
    UPDATE feature_flags
    SET kill_switch_active = 1,
        kill_switch_reason = 'Interrupção preventiva durante o teste'
    WHERE id = ?
  `).run(flag.id);

  assert.deepEqual(
    evaluateFeatureFlag(db, flag.key, { id: 1, role: 'professor' }),
    { key: flag.key, enabled: false, reason: 'kill_switch' }
  );
});

test('rollout percentual usa o mesmo bucket para o mesmo usuário', (t) => {
  const db = createGovernanceDatabase(t);
  const rollingRelease = db.prepare(`
    INSERT INTO product_releases (version, title, status)
    VALUES ('1.7.0', 'Release gradual', 'rolling_out')
  `).run();
  const flag = createFlag(db, {
    releaseId: rollingRelease.lastInsertRowid,
    masterEnabled: 1,
    rolloutPercentage: 25,
  });
  const user = { id: 42, role: 'professor' };
  const first = evaluateFeatureFlag(db, flag.key, user);
  const second = evaluateFeatureFlag(db, flag.key, user);

  assert.deepEqual(first, second);
  assert.equal(first.bucket, stableRolloutBucket(flag.key, user.id));
  assert.equal(first.enabled, first.bucket < 25);
});

test('uma release pausada desliga a feature antes de qualquer regra', (t) => {
  const db = createGovernanceDatabase(t);
  const pausedRelease = db.prepare(`
    INSERT INTO product_releases (version, title, status)
    VALUES ('1.8.0', 'Release pausada', 'paused')
  `).run();
  const flag = createFlag(db, {
    releaseId: pausedRelease.lastInsertRowid,
    masterEnabled: 1,
  });
  db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason
    ) VALUES (?, 1, 1, 'Usuário explicitamente liberado')
  `).run(flag.id);

  assert.deepEqual(
    evaluateFeatureFlag(db, flag.key, { id: 1, role: 'professor' }),
    { key: flag.key, enabled: false, reason: 'release_paused' }
  );
});
