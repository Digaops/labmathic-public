const express = require('express');
const db = require('../database');
const config = require('../config');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../helpers/activity');
const {
  evaluateFeatureFlags,
  findFeatureFlagById,
  isValidFlagKey,
  isValidGroupKey,
  isValidReleaseVersion,
  normalizeKey,
  serializeFeatureFlag,
} = require('../services/featureFlags');

const router = express.Router();
const RELEASE_STATUSES = new Set([
  'draft', 'pilot', 'rolling_out', 'general', 'paused', 'retired',
]);
const RELEASE_TRANSITIONS = {
  draft: new Set(['draft', 'pilot', 'retired']),
  pilot: new Set(['pilot', 'rolling_out', 'paused', 'retired']),
  rolling_out: new Set(['rolling_out', 'general', 'paused', 'retired']),
  general: new Set(['general', 'paused', 'retired']),
  paused: new Set(['paused', 'pilot', 'rolling_out', 'general', 'retired']),
  retired: new Set(['retired']),
};

router.use(authenticate);

function parsePositiveInteger(value) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseBoolean(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === true || value === 1 || value === '1') return true;
  if (value === false || value === 0 || value === '0') return false;
  return null;
}

function requiredReason(value) {
  const reason = String(value || '').trim();
  return reason.length >= 10 && reason.length <= 500 ? reason : null;
}

function cleanText(value, maxLength, fallback = null) {
  if (value === undefined) return fallback;
  const text = String(value || '').trim();
  return !text || text.length > maxLength ? null : text;
}

function toBoolean(value) {
  return Number(value) === 1;
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function serializeRelease(row) {
  return row ? {
    id: row.id,
    version: row.version,
    title: row.title,
    description: row.description,
    status: row.status,
    revision: row.revision,
    releasedAt: row.released_at,
    featureFlagCount: row.feature_flag_count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function serializePilotGroup(row) {
  return row ? {
    id: row.id,
    key: row.group_key,
    name: row.name,
    description: row.description,
    active: toBoolean(row.active),
    revision: row.revision,
    memberCount: row.member_count ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  } : null;
}

function insertGovernanceAudit({
  req,
  action,
  entityType,
  entityId,
  entityKey,
  reason,
  previous = null,
  current = null,
}) {
  db.prepare(`
    INSERT INTO governance_audit_log (
      actor_id, action, entity_type, entity_id, entity_key, reason,
      previous_json, current_json, ip_address, user_agent
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id,
    action,
    entityType,
    entityId || null,
    entityKey || null,
    reason,
    json(previous),
    json(current),
    req.ip || null,
    req.get('user-agent') || null
  );
}

function logGovernanceActivity(req, action, entityType, entity, reason, previous = null) {
  logActivity({
    user: req.user,
    action,
    module: 'governance',
    entityType,
    entityId: entity?.id || null,
    entityTitle: entity?.name || entity?.title || entity?.flag_key || entity?.version || null,
    description: `${req.user.name || req.user.email} realizou uma alteração de governança: ${reason}`,
    metadata: { previous, current: entity, reason },
    isCritical: action.includes('kill_switch') || action.includes('release_status'),
    req,
  });
}

function databaseConflict(error, res, next) {
  if (error?.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'Já existe um registro com esta identificação.' });
  }
  return next(error);
}

// Usuários autenticados recebem somente a decisão final. Regras internas,
// grupos e motivos permanecem restritos aos administradores.
router.get('/features', (req, res) => {
  const keys = String(req.query.keys || '')
    .split(',')
    .map(normalizeKey)
    .filter(Boolean);

  if (keys.length < 1 || keys.length > 50 || keys.some((key) => !isValidFlagKey(key))) {
    return res.status(400).json({
      error: 'Informe de 1 a 50 chaves de funcionalidades válidas.',
    });
  }

  const decisions = evaluateFeatureFlags(db, keys, req.user);
  return res.json({
    features: Object.fromEntries(decisions.map((item) => [item.key, item.enabled])),
  });
});

// O plano de controle permanece preservado para manter a trilha histórica e a
// compatibilidade das migrações, mas não faz parte do fluxo simplificado do
// produto. A avaliação de funcionalidades acima continua disponível para
// que o frontend receba apenas a decisão final.
router.use('/admin', (req, res, next) => {
  if (!config.governanceAdminEnabled) {
    return res.status(404).json({ error: 'Funcionalidade administrativa desativada.' });
  }
  return next();
}, requireAdmin);

router.get('/admin/releases', (_req, res) => {
  const releases = db.prepare(`
    SELECT pr.*, COUNT(ff.id) AS feature_flag_count
    FROM product_releases pr
    LEFT JOIN feature_flags ff ON ff.release_id = pr.id
    GROUP BY pr.id
    ORDER BY datetime(pr.created_at) DESC, pr.id DESC
  `).all().map(serializeRelease);
  res.json(releases);
});

router.post('/admin/releases', (req, res, next) => {
  const version = String(req.body.version || '').trim();
  const title = cleanText(req.body.title, 120);
  const description = req.body.description === undefined
    ? null
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const reason = requiredReason(req.body.reason);

  if (!isValidReleaseVersion(version) || !title || !reason) {
    return res.status(400).json({
      error: 'Versão semântica, título e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }

  try {
    const createRelease = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO product_releases (
          version, title, description, status, created_by, updated_by
        ) VALUES (?, ?, ?, 'draft', ?, ?)
      `).run(version, title, description, req.user.id, req.user.id);
      const release = db.prepare('SELECT * FROM product_releases WHERE id = ?')
        .get(result.lastInsertRowid);
      insertGovernanceAudit({
        req,
        action: 'create_release',
        entityType: 'release',
        entityId: release.id,
        entityKey: release.version,
        reason,
        current: serializeRelease(release),
      });
      return release;
    });
    const release = createRelease();
    logGovernanceActivity(req, 'create_release', 'release', release, reason);
    return res.status(201).json(serializeRelease(release));
  } catch (error) {
    return databaseConflict(error, res, next);
  }
});

router.patch('/admin/releases/:id', (req, res, next) => {
  const id = parsePositiveInteger(req.params.id);
  const expectedRevision = parsePositiveInteger(req.body.expected_revision);
  const reason = requiredReason(req.body.reason);
  const current = id
    ? db.prepare('SELECT * FROM product_releases WHERE id = ?').get(id)
    : null;

  if (!current) return res.status(404).json({ error: 'Release não encontrada.' });
  if (!expectedRevision || !reason) {
    return res.status(400).json({ error: 'Revisão esperada e motivo são obrigatórios.' });
  }

  const title = req.body.title === undefined ? current.title : cleanText(req.body.title, 120);
  const description = req.body.description === undefined
    ? current.description
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const status = req.body.status === undefined
    ? current.status
    : String(req.body.status || '').trim();

  if (!title || !RELEASE_STATUSES.has(status)) {
    return res.status(400).json({ error: 'Título ou status inválido.' });
  }
  if (!RELEASE_TRANSITIONS[current.status].has(status)) {
    return res.status(409).json({
      error: `Transição de ${current.status} para ${status} não é permitida.`,
    });
  }

  const releasedAt = current.released_at
    || (status !== 'draft' ? new Date().toISOString() : null);
  const updateRelease = db.transaction(() => {
    const result = db.prepare(`
      UPDATE product_releases
      SET title = ?, description = ?, status = ?, released_at = ?,
          updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      title, description, status, releasedAt, req.user.id, current.id, expectedRevision
    );
    if (result.changes !== 1) return null;

    const updated = db.prepare('SELECT * FROM product_releases WHERE id = ?').get(current.id);
    insertGovernanceAudit({
      req,
      action: current.status === status ? 'update_release' : 'update_release_status',
      entityType: 'release',
      entityId: updated.id,
      entityKey: updated.version,
      reason,
      previous: serializeRelease(current),
      current: serializeRelease(updated),
    });
    return updated;
  });

  try {
    const updated = updateRelease();
    if (!updated) {
      return res.status(409).json({
        error: 'A release foi alterada por outro administrador. Atualize a tela.',
      });
    }
    const action = current.status === updated.status ? 'update_release' : 'update_release_status';
    logGovernanceActivity(req, action, 'release', updated, reason, current);
    return res.json(serializeRelease(updated));
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/feature-flags', (_req, res) => {
  const flags = db.prepare(`
    SELECT
      ff.*,
      pr.version AS release_version,
      pr.status AS release_status,
      (SELECT COUNT(*) FROM feature_flag_group_rules r WHERE r.feature_flag_id = ff.id) AS group_rule_count,
      (SELECT COUNT(*) FROM feature_flag_user_rules r WHERE r.feature_flag_id = ff.id) AS user_rule_count
    FROM feature_flags ff
    LEFT JOIN product_releases pr ON pr.id = ff.release_id
    ORDER BY ff.name COLLATE NOCASE, ff.id
  `).all().map((row) => ({
    ...serializeFeatureFlag(row),
    groupRuleCount: row.group_rule_count,
    userRuleCount: row.user_rule_count,
  }));
  res.json(flags);
});

router.get('/admin/feature-flags/:id/rules', (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  const flag = id ? findFeatureFlagById(db, id) : null;
  if (!flag) return res.status(404).json({ error: 'Feature flag não encontrada.' });

  const groupRules = db.prepare(`
    SELECT
      r.id,
      r.enabled,
      r.reason,
      r.created_at,
      r.updated_at,
      pg.id AS group_id,
      pg.group_key,
      pg.name AS group_name,
      pg.active AS group_active,
      (SELECT COUNT(*) FROM pilot_group_members pgm WHERE pgm.group_id = pg.id) AS member_count
    FROM feature_flag_group_rules r
    JOIN pilot_groups pg ON pg.id = r.group_id
    WHERE r.feature_flag_id = ?
    ORDER BY pg.name COLLATE NOCASE, pg.id
  `).all(flag.id).map((rule) => ({
    ...rule,
    enabled: toBoolean(rule.enabled),
    group_active: toBoolean(rule.group_active),
  }));
  const userRules = db.prepare(`
    SELECT
      r.id,
      r.enabled,
      r.reason,
      r.created_at,
      r.updated_at,
      u.id AS user_id,
      u.name AS user_name,
      u.email AS user_email,
      u.role AS user_role
    FROM feature_flag_user_rules r
    JOIN users u ON u.id = r.user_id
    WHERE r.feature_flag_id = ?
    ORDER BY u.name COLLATE NOCASE, u.id
  `).all(flag.id).map((rule) => ({ ...rule, enabled: toBoolean(rule.enabled) }));
  const roleRules = db.prepare(`
    SELECT id, role, enabled, reason, created_at, updated_at
    FROM feature_flag_role_rules
    WHERE feature_flag_id = ?
    ORDER BY role
  `).all(flag.id).map((rule) => ({ ...rule, enabled: toBoolean(rule.enabled) }));

  return res.json({
    featureFlag: serializeFeatureFlag(flag),
    groupRules,
    userRules,
    roleRules,
  });
});

router.post('/admin/feature-flags', (req, res, next) => {
  const flagKey = normalizeKey(req.body.key);
  const name = cleanText(req.body.name, 120);
  const description = req.body.description === undefined
    ? null
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const releaseId = req.body.release_id === null || req.body.release_id === undefined
    ? null
    : parsePositiveInteger(req.body.release_id);
  const reason = requiredReason(req.body.reason);

  if (!isValidFlagKey(flagKey) || !name || !reason) {
    return res.status(400).json({
      error: 'Chave, nome e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }
  if (req.body.release_id !== undefined && req.body.release_id !== null && !releaseId) {
    return res.status(400).json({ error: 'Release inválida.' });
  }
  if (releaseId && !db.prepare('SELECT id FROM product_releases WHERE id = ?').get(releaseId)) {
    return res.status(404).json({ error: 'Release não encontrada.' });
  }

  try {
    const createFlag = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO feature_flags (
          flag_key, name, description, release_id,
          master_enabled, default_enabled, rollout_percentage,
          created_by, updated_by
        ) VALUES (?, ?, ?, ?, 0, 0, 0, ?, ?)
      `).run(flagKey, name, description, releaseId, req.user.id, req.user.id);
      const flag = findFeatureFlagById(db, result.lastInsertRowid);
      insertGovernanceAudit({
        req,
        action: 'create_feature_flag',
        entityType: 'feature_flag',
        entityId: flag.id,
        entityKey: flag.flag_key,
        reason,
        current: serializeFeatureFlag(flag),
      });
      return flag;
    });
    const flag = createFlag();
    logGovernanceActivity(req, 'create_feature_flag', 'feature_flag', flag, reason);
    return res.status(201).json(serializeFeatureFlag(flag));
  } catch (error) {
    return databaseConflict(error, res, next);
  }
});

router.patch('/admin/feature-flags/:id', (req, res, next) => {
  const id = parsePositiveInteger(req.params.id);
  const expectedRevision = parsePositiveInteger(req.body.expected_revision);
  const reason = requiredReason(req.body.reason);
  const current = id ? findFeatureFlagById(db, id) : null;

  if (!current) return res.status(404).json({ error: 'Feature flag não encontrada.' });
  if (!expectedRevision || !reason) {
    return res.status(400).json({ error: 'Revisão esperada e motivo são obrigatórios.' });
  }

  const name = req.body.name === undefined ? current.name : cleanText(req.body.name, 120);
  const description = req.body.description === undefined
    ? current.description
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const masterEnabled = parseBoolean(req.body.master_enabled, toBoolean(current.master_enabled));
  const defaultEnabled = parseBoolean(req.body.default_enabled, toBoolean(current.default_enabled));
  const rolloutPercentage = req.body.rollout_percentage === undefined
    ? current.rollout_percentage
    : Number(req.body.rollout_percentage);
  const releaseId = req.body.release_id === undefined
    ? current.release_id
    : req.body.release_id === null
      ? null
      : parsePositiveInteger(req.body.release_id);

  if (!name || masterEnabled === null || defaultEnabled === null
    || !Number.isInteger(rolloutPercentage)
    || rolloutPercentage < 0 || rolloutPercentage > 100) {
    return res.status(400).json({ error: 'Configuração da feature flag inválida.' });
  }
  if (req.body.release_id !== undefined && req.body.release_id !== null && !releaseId) {
    return res.status(400).json({ error: 'Release inválida.' });
  }
  if (releaseId && !db.prepare('SELECT id FROM product_releases WHERE id = ?').get(releaseId)) {
    return res.status(404).json({ error: 'Release não encontrada.' });
  }
  if (defaultEnabled && rolloutPercentage > 0 && rolloutPercentage < 100) {
    return res.status(400).json({
      error: 'Default ativo é incompatível com rollout parcial. Use default desativado.',
    });
  }

  const updateFlag = db.transaction(() => {
    const result = db.prepare(`
      UPDATE feature_flags
      SET name = ?, description = ?, release_id = ?, master_enabled = ?,
          default_enabled = ?, rollout_percentage = ?, updated_by = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      name,
      description,
      releaseId,
      masterEnabled ? 1 : 0,
      defaultEnabled ? 1 : 0,
      rolloutPercentage,
      req.user.id,
      current.id,
      expectedRevision
    );
    if (result.changes !== 1) return null;

    const updated = findFeatureFlagById(db, current.id);
    insertGovernanceAudit({
      req,
      action: 'update_feature_flag',
      entityType: 'feature_flag',
      entityId: updated.id,
      entityKey: updated.flag_key,
      reason,
      previous: serializeFeatureFlag(current),
      current: serializeFeatureFlag(updated),
    });
    return updated;
  });

  try {
    const updated = updateFlag();
    if (!updated) {
      return res.status(409).json({
        error: 'A feature flag foi alterada por outro administrador. Atualize a tela.',
      });
    }
    logGovernanceActivity(req, 'update_feature_flag', 'feature_flag', updated, reason, current);
    return res.json(serializeFeatureFlag(updated));
  } catch (error) {
    return next(error);
  }
});

router.post('/admin/feature-flags/:id/kill-switch', (req, res, next) => {
  const id = parsePositiveInteger(req.params.id);
  const expectedRevision = parsePositiveInteger(req.body.expected_revision);
  const active = parseBoolean(req.body.active);
  const reason = requiredReason(req.body.reason);
  const current = id ? findFeatureFlagById(db, id) : null;

  if (!current) return res.status(404).json({ error: 'Feature flag não encontrada.' });
  if (!expectedRevision || active === null || !reason) {
    return res.status(400).json({
      error: 'Estado, revisão esperada e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }

  const toggleKillSwitch = db.transaction(() => {
    const result = db.prepare(`
      UPDATE feature_flags
      SET kill_switch_active = ?, kill_switch_reason = ?,
          kill_switch_activated_by = ?, kill_switch_activated_at = ?,
          updated_by = ?, revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(
      active ? 1 : 0,
      active ? reason : null,
      active ? req.user.id : null,
      active ? new Date().toISOString() : null,
      req.user.id,
      current.id,
      expectedRevision
    );
    if (result.changes !== 1) return null;

    const updated = findFeatureFlagById(db, current.id);
    insertGovernanceAudit({
      req,
      action: active ? 'activate_kill_switch' : 'deactivate_kill_switch',
      entityType: 'feature_flag',
      entityId: updated.id,
      entityKey: updated.flag_key,
      reason,
      previous: serializeFeatureFlag(current),
      current: serializeFeatureFlag(updated),
    });
    return updated;
  });

  try {
    const updated = toggleKillSwitch();
    if (!updated) {
      return res.status(409).json({
        error: 'A feature flag foi alterada por outro administrador. Atualize a tela.',
      });
    }
    const action = active ? 'activate_kill_switch' : 'deactivate_kill_switch';
    logGovernanceActivity(req, action, 'feature_flag', updated, reason, current);
    return res.json(serializeFeatureFlag(updated));
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/pilot-groups', (_req, res) => {
  const groups = db.prepare(`
    SELECT pg.*, COUNT(pgm.id) AS member_count
    FROM pilot_groups pg
    LEFT JOIN pilot_group_members pgm ON pgm.group_id = pg.id
    GROUP BY pg.id
    ORDER BY pg.active DESC, pg.name COLLATE NOCASE
  `).all().map(serializePilotGroup);
  res.json(groups);
});

router.post('/admin/pilot-groups', (req, res, next) => {
  const groupKey = normalizeKey(req.body.key);
  const name = cleanText(req.body.name, 120);
  const description = req.body.description === undefined
    ? null
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const reason = requiredReason(req.body.reason);

  if (!isValidGroupKey(groupKey) || !name || !reason) {
    return res.status(400).json({
      error: 'Chave, nome e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }

  try {
    const createGroup = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO pilot_groups (
          group_key, name, description, active, created_by, updated_by
        ) VALUES (?, ?, ?, 1, ?, ?)
      `).run(groupKey, name, description, req.user.id, req.user.id);
      const group = db.prepare('SELECT * FROM pilot_groups WHERE id = ?')
        .get(result.lastInsertRowid);
      insertGovernanceAudit({
        req,
        action: 'create_pilot_group',
        entityType: 'pilot_group',
        entityId: group.id,
        entityKey: group.group_key,
        reason,
        current: serializePilotGroup(group),
      });
      return group;
    });
    const group = createGroup();
    logGovernanceActivity(req, 'create_pilot_group', 'pilot_group', group, reason);
    return res.status(201).json(serializePilotGroup(group));
  } catch (error) {
    return databaseConflict(error, res, next);
  }
});

router.patch('/admin/pilot-groups/:id', (req, res, next) => {
  const id = parsePositiveInteger(req.params.id);
  const expectedRevision = parsePositiveInteger(req.body.expected_revision);
  const reason = requiredReason(req.body.reason);
  const current = id ? db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(id) : null;

  if (!current) return res.status(404).json({ error: 'Grupo-piloto não encontrado.' });
  if (!expectedRevision || !reason) {
    return res.status(400).json({ error: 'Revisão esperada e motivo são obrigatórios.' });
  }

  const name = req.body.name === undefined ? current.name : cleanText(req.body.name, 120);
  const description = req.body.description === undefined
    ? current.description
    : String(req.body.description || '').trim().slice(0, 2000) || null;
  const active = parseBoolean(req.body.active, toBoolean(current.active));

  if (!name || active === null) {
    return res.status(400).json({ error: 'Configuração do grupo-piloto inválida.' });
  }

  const updateGroup = db.transaction(() => {
    const result = db.prepare(`
      UPDATE pilot_groups
      SET name = ?, description = ?, active = ?, updated_by = ?,
          revision = revision + 1, updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND revision = ?
    `).run(name, description, active ? 1 : 0, req.user.id, current.id, expectedRevision);
    if (result.changes !== 1) return null;

    const updated = db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(current.id);
    insertGovernanceAudit({
      req,
      action: 'update_pilot_group',
      entityType: 'pilot_group',
      entityId: updated.id,
      entityKey: updated.group_key,
      reason,
      previous: serializePilotGroup(current),
      current: serializePilotGroup(updated),
    });
    return updated;
  });

  try {
    const updated = updateGroup();
    if (!updated) {
      return res.status(409).json({
        error: 'O grupo foi alterado por outro administrador. Atualize a tela.',
      });
    }
    logGovernanceActivity(req, 'update_pilot_group', 'pilot_group', updated, reason, current);
    return res.json(serializePilotGroup(updated));
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/pilot-groups/:id/members', (req, res) => {
  const id = parsePositiveInteger(req.params.id);
  if (!id || !db.prepare('SELECT id FROM pilot_groups WHERE id = ?').get(id)) {
    return res.status(404).json({ error: 'Grupo-piloto não encontrado.' });
  }

  const members = db.prepare(`
    SELECT u.id, u.name, u.email, u.role, pgm.created_at AS added_at
    FROM pilot_group_members pgm
    JOIN users u ON u.id = pgm.user_id
    WHERE pgm.group_id = ?
    ORDER BY u.name COLLATE NOCASE, u.id
  `).all(id);
  return res.json(members);
});

router.post('/admin/pilot-groups/:id/members', (req, res, next) => {
  const groupId = parsePositiveInteger(req.params.id);
  const userId = parsePositiveInteger(req.body.user_id);
  const reason = requiredReason(req.body.reason);
  const group = groupId ? db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(groupId) : null;
  const user = userId
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;

  if (!group) return res.status(404).json({ error: 'Grupo-piloto não encontrado.' });
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (!reason) {
    return res.status(400).json({ error: 'Motivo com pelo menos 10 caracteres é obrigatório.' });
  }

  try {
    const addMember = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO pilot_group_members (group_id, user_id, added_by)
        VALUES (?, ?, ?)
      `).run(group.id, user.id, req.user.id);
      const membership = { id: result.lastInsertRowid, groupId: group.id, userId: user.id };
      insertGovernanceAudit({
        req,
        action: 'add_pilot_group_member',
        entityType: 'pilot_group_member',
        entityId: result.lastInsertRowid,
        entityKey: `${group.group_key}:${user.id}`,
        reason,
        current: membership,
      });
      return membership;
    });
    const membership = addMember();
    logGovernanceActivity(req, 'add_pilot_group_member', 'pilot_group_member', membership, reason);
    return res.status(201).json({ ...membership, user });
  } catch (error) {
    return databaseConflict(error, res, next);
  }
});

router.delete('/admin/pilot-groups/:groupId/members/:userId', (req, res, next) => {
  const groupId = parsePositiveInteger(req.params.groupId);
  const userId = parsePositiveInteger(req.params.userId);
  const reason = requiredReason(req.body.reason);
  const group = groupId ? db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(groupId) : null;
  const membership = groupId && userId
    ? db.prepare('SELECT * FROM pilot_group_members WHERE group_id = ? AND user_id = ?')
      .get(groupId, userId)
    : null;

  if (!group || !membership) {
    return res.status(404).json({ error: 'Membro do grupo não encontrado.' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Motivo com pelo menos 10 caracteres é obrigatório.' });
  }

  const removeMember = db.transaction(() => {
    db.prepare('DELETE FROM pilot_group_members WHERE id = ?').run(membership.id);
    insertGovernanceAudit({
      req,
      action: 'remove_pilot_group_member',
      entityType: 'pilot_group_member',
      entityId: membership.id,
      entityKey: `${group.group_key}:${userId}`,
      reason,
      previous: membership,
    });
  });

  try {
    removeMember();
    logGovernanceActivity(req, 'remove_pilot_group_member', 'pilot_group_member', membership, reason);
    return res.json({ message: 'Usuário removido do grupo-piloto.' });
  } catch (error) {
    return next(error);
  }
});

router.put('/admin/feature-flags/:flagId/pilot-groups/:groupId', (req, res, next) => {
  const flagId = parsePositiveInteger(req.params.flagId);
  const groupId = parsePositiveInteger(req.params.groupId);
  const enabled = parseBoolean(req.body.enabled, true);
  const reason = requiredReason(req.body.reason);
  const flag = flagId ? findFeatureFlagById(db, flagId) : null;
  const group = groupId ? db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(groupId) : null;

  if (!flag) return res.status(404).json({ error: 'Feature flag não encontrada.' });
  if (!group) return res.status(404).json({ error: 'Grupo-piloto não encontrado.' });
  if (enabled === null || !reason) {
    return res.status(400).json({
      error: 'Estado e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }

  const previous = db.prepare(`
    SELECT * FROM feature_flag_group_rules
    WHERE feature_flag_id = ? AND group_id = ?
  `).get(flag.id, group.id);
  const saveRule = db.transaction(() => {
    db.prepare(`
      INSERT INTO feature_flag_group_rules (
        feature_flag_id, group_id, enabled, reason, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_flag_id, group_id) DO UPDATE SET
        enabled = excluded.enabled,
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(flag.id, group.id, enabled ? 1 : 0, reason, req.user.id, req.user.id);
    const current = db.prepare(`
      SELECT * FROM feature_flag_group_rules
      WHERE feature_flag_id = ? AND group_id = ?
    `).get(flag.id, group.id);
    insertGovernanceAudit({
      req,
      action: 'upsert_feature_flag_group_rule',
      entityType: 'feature_flag_rule',
      entityId: current.id,
      entityKey: `${flag.flag_key}:${group.group_key}`,
      reason,
      previous,
      current,
    });
    return current;
  });

  try {
    const rule = saveRule();
    logGovernanceActivity(req, 'upsert_feature_flag_group_rule', 'feature_flag_rule', rule, reason, previous);
    return res.json({
      featureFlag: serializeFeatureFlag(flag),
      pilotGroup: serializePilotGroup(group),
      enabled,
      reason,
    });
  } catch (error) {
    return next(error);
  }
});

router.delete('/admin/feature-flags/:flagId/pilot-groups/:groupId', (req, res, next) => {
  const flagId = parsePositiveInteger(req.params.flagId);
  const groupId = parsePositiveInteger(req.params.groupId);
  const reason = requiredReason(req.body.reason);
  const flag = flagId ? findFeatureFlagById(db, flagId) : null;
  const group = groupId ? db.prepare('SELECT * FROM pilot_groups WHERE id = ?').get(groupId) : null;
  const rule = flagId && groupId
    ? db.prepare(`
      SELECT * FROM feature_flag_group_rules
      WHERE feature_flag_id = ? AND group_id = ?
    `).get(flagId, groupId)
    : null;

  if (!flag || !group || !rule) {
    return res.status(404).json({ error: 'Regra de grupo não encontrada.' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Motivo com pelo menos 10 caracteres é obrigatório.' });
  }

  const removeRule = db.transaction(() => {
    db.prepare('DELETE FROM feature_flag_group_rules WHERE id = ?').run(rule.id);
    insertGovernanceAudit({
      req,
      action: 'remove_feature_flag_group_rule',
      entityType: 'feature_flag_rule',
      entityId: rule.id,
      entityKey: `${flag.flag_key}:${group.group_key}`,
      reason,
      previous: rule,
    });
  });

  try {
    removeRule();
    logGovernanceActivity(req, 'remove_feature_flag_group_rule', 'feature_flag_rule', rule, reason);
    return res.json({ message: 'Regra do grupo-piloto removida.' });
  } catch (error) {
    return next(error);
  }
});

router.put('/admin/feature-flags/:flagId/users/:userId', (req, res, next) => {
  const flagId = parsePositiveInteger(req.params.flagId);
  const userId = parsePositiveInteger(req.params.userId);
  const enabled = parseBoolean(req.body.enabled);
  const reason = requiredReason(req.body.reason);
  const flag = flagId ? findFeatureFlagById(db, flagId) : null;
  const user = userId
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;

  if (!flag) return res.status(404).json({ error: 'Feature flag não encontrada.' });
  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (enabled === null || !reason) {
    return res.status(400).json({
      error: 'Estado e motivo com pelo menos 10 caracteres são obrigatórios.',
    });
  }

  const previous = db.prepare(`
    SELECT * FROM feature_flag_user_rules
    WHERE feature_flag_id = ? AND user_id = ?
  `).get(flag.id, user.id);
  const saveRule = db.transaction(() => {
    db.prepare(`
      INSERT INTO feature_flag_user_rules (
        feature_flag_id, user_id, enabled, reason, created_by, updated_by
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(feature_flag_id, user_id) DO UPDATE SET
        enabled = excluded.enabled,
        reason = excluded.reason,
        updated_by = excluded.updated_by,
        updated_at = CURRENT_TIMESTAMP
    `).run(flag.id, user.id, enabled ? 1 : 0, reason, req.user.id, req.user.id);
    const current = db.prepare(`
      SELECT * FROM feature_flag_user_rules
      WHERE feature_flag_id = ? AND user_id = ?
    `).get(flag.id, user.id);
    insertGovernanceAudit({
      req,
      action: 'upsert_feature_flag_user_rule',
      entityType: 'feature_flag_rule',
      entityId: current.id,
      entityKey: `${flag.flag_key}:user:${user.id}`,
      reason,
      previous,
      current,
    });
    return current;
  });

  try {
    const rule = saveRule();
    logGovernanceActivity(req, 'upsert_feature_flag_user_rule', 'feature_flag_rule', rule, reason, previous);
    return res.json({ featureFlag: flag.flag_key, user, enabled, reason });
  } catch (error) {
    return next(error);
  }
});

router.delete('/admin/feature-flags/:flagId/users/:userId', (req, res, next) => {
  const flagId = parsePositiveInteger(req.params.flagId);
  const userId = parsePositiveInteger(req.params.userId);
  const reason = requiredReason(req.body.reason);
  const flag = flagId ? findFeatureFlagById(db, flagId) : null;
  const user = userId
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;
  const rule = flagId && userId
    ? db.prepare(`
      SELECT * FROM feature_flag_user_rules
      WHERE feature_flag_id = ? AND user_id = ?
    `).get(flagId, userId)
    : null;

  if (!flag || !user || !rule) {
    return res.status(404).json({ error: 'Regra individual não encontrada.' });
  }
  if (!reason) {
    return res.status(400).json({ error: 'Motivo com pelo menos 10 caracteres é obrigatório.' });
  }

  const removeRule = db.transaction(() => {
    db.prepare('DELETE FROM feature_flag_user_rules WHERE id = ?').run(rule.id);
    insertGovernanceAudit({
      req,
      action: 'remove_feature_flag_user_rule',
      entityType: 'feature_flag_rule',
      entityId: rule.id,
      entityKey: `${flag.flag_key}:user:${user.id}`,
      reason,
      previous: rule,
    });
  });

  try {
    removeRule();
    logGovernanceActivity(req, 'remove_feature_flag_user_rule', 'feature_flag_rule', rule, reason);
    return res.json({ message: 'Regra individual removida.' });
  } catch (error) {
    return next(error);
  }
});

router.get('/admin/feature-flags/evaluate', (req, res) => {
  const userId = parsePositiveInteger(req.query.user_id);
  const keys = String(req.query.keys || '')
    .split(',')
    .map(normalizeKey)
    .filter(Boolean);
  const user = userId
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;

  if (!user) return res.status(404).json({ error: 'Usuário não encontrado.' });
  if (keys.length < 1 || keys.length > 50 || keys.some((key) => !isValidFlagKey(key))) {
    return res.status(400).json({ error: 'Informe de 1 a 50 chaves válidas.' });
  }

  return res.json({ user, decisions: evaluateFeatureFlags(db, keys, user) });
});

router.get('/admin/audit', (req, res) => {
  const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 200);
  const rows = db.prepare(`
    SELECT gal.*, u.name AS actor_name, u.email AS actor_email
    FROM governance_audit_log gal
    LEFT JOIN users u ON u.id = gal.actor_id
    ORDER BY datetime(gal.created_at) DESC, gal.id DESC
    LIMIT ?
  `).all(limit).map((row) => ({
    ...row,
    previous: row.previous_json ? JSON.parse(row.previous_json) : null,
    current: row.current_json ? JSON.parse(row.current_json) : null,
    previous_json: undefined,
    current_json: undefined,
  }));
  res.json(rows);
});

module.exports = router;
