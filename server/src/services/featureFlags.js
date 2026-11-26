const crypto = require('crypto');
const config = require('../config');

// Na homologação, todos os professores precisam validar a mesma versão da
// funcionalidade. A lista é intencionalmente fechada: somente recursos prontos
// para teste ficam disponíveis a todos; motor tipado incompleto e TRI seguem fora.
const HOMOLOGATION_OPEN_FEATURES = new Set([
  'classes.core',
  'classes.student_import',
  'classes.entry_codes',
  'classes.assessment_assignments',
  'classes.assessment_delivery',
  'classes.assessment_results',
  'classes.student_assessment_portal',
  'classes.learning_recovery',
  'question_bank.diagnostic_generator',
  'planning.lesson_planner',
  'institutions.read_model',
  'institutions.management_pilot',
  'question_bank.typed_preview',
  'question_bank.feedback_preview',
  'question_bank.catalog_preview',
]);

const FLAG_KEY_PATTERN = /^[a-z][a-z0-9_.-]{2,63}$/;
const GROUP_KEY_PATTERN = /^[a-z][a-z0-9_-]{2,63}$/;
const RELEASE_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function normalizeKey(value) {
  return String(value || '').trim().toLowerCase();
}

function isValidFlagKey(value) {
  return FLAG_KEY_PATTERN.test(normalizeKey(value));
}

function isValidGroupKey(value) {
  return GROUP_KEY_PATTERN.test(normalizeKey(value));
}

function isValidReleaseVersion(value) {
  return RELEASE_VERSION_PATTERN.test(String(value || '').trim());
}

function stableRolloutBucket(flagKey, userId) {
  const digest = crypto
    .createHash('sha256')
    .update(`${normalizeKey(flagKey)}:${String(userId)}`)
    .digest();

  return digest.readUInt32BE(0) % 100;
}

function toBoolean(value) {
  return Number(value) === 1;
}

function serializeFeatureFlag(row) {
  if (!row) return null;

  return {
    id: row.id,
    key: row.flag_key,
    name: row.name,
    description: row.description,
    releaseId: row.release_id,
    releaseVersion: row.release_version || null,
    releaseStatus: row.release_status || null,
    masterEnabled: toBoolean(row.master_enabled),
    defaultEnabled: toBoolean(row.default_enabled),
    rolloutPercentage: row.rollout_percentage,
    killSwitchActive: toBoolean(row.kill_switch_active),
    killSwitchReason: row.kill_switch_reason,
    killSwitchActivatedBy: row.kill_switch_activated_by,
    killSwitchActivatedAt: row.kill_switch_activated_at,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function findFeatureFlag(db, flagKey) {
  return db.prepare(`
    SELECT
      ff.*,
      pr.version AS release_version,
      pr.status AS release_status
    FROM feature_flags ff
    LEFT JOIN product_releases pr ON pr.id = ff.release_id
    WHERE ff.flag_key = ? COLLATE NOCASE
  `).get(normalizeKey(flagKey));
}

function findFeatureFlagById(db, id) {
  return db.prepare(`
    SELECT
      ff.*,
      pr.version AS release_version,
      pr.status AS release_status
    FROM feature_flags ff
    LEFT JOIN product_releases pr ON pr.id = ff.release_id
    WHERE ff.id = ?
  `).get(id);
}

function evaluateFeatureFlag(db, flagKey, user) {
  const normalizedKey = normalizeKey(flagKey);
  const flag = findFeatureFlag(db, normalizedKey);

  if (!flag) {
    return { key: normalizedKey, enabled: false, reason: 'not_found' };
  }

  if (toBoolean(flag.kill_switch_active)) {
    return { key: flag.flag_key, enabled: false, reason: 'kill_switch' };
  }

  // Open testing bypasses rollout restrictions, never missing governance or an
  // emergency stop. Do not reset legacy/sanitizer kill switches automatically.
  if (config.appEnvironment === 'homologation'
      && HOMOLOGATION_OPEN_FEATURES.has(normalizedKey)) {
    return { key: flag.flag_key, enabled: true, reason: 'homologation_open_testing' };
  }

  if (!toBoolean(flag.master_enabled)) {
    return { key: flag.flag_key, enabled: false, reason: 'master_disabled' };
  }

  if (flag.release_status === 'paused' || flag.release_status === 'retired') {
    return { key: flag.flag_key, enabled: false, reason: `release_${flag.release_status}` };
  }

  const userRule = db.prepare(`
    SELECT enabled
    FROM feature_flag_user_rules
    WHERE feature_flag_id = ? AND user_id = ?
  `).get(flag.id, user.id);

  if (userRule) {
    return {
      key: flag.flag_key,
      enabled: toBoolean(userRule.enabled),
      reason: 'user_rule',
    };
  }

  const groupRules = db.prepare(`
    SELECT ffgr.enabled
    FROM feature_flag_group_rules ffgr
    JOIN pilot_groups pg
      ON pg.id = ffgr.group_id AND pg.active = 1
    JOIN pilot_group_members pgm
      ON pgm.group_id = pg.id AND pgm.user_id = ?
    WHERE ffgr.feature_flag_id = ?
    ORDER BY ffgr.enabled ASC, ffgr.id ASC
  `).all(user.id, flag.id);

  if (groupRules.length > 0) {
    const hasDisabledRule = groupRules.some((rule) => !toBoolean(rule.enabled));
    return {
      key: flag.flag_key,
      enabled: !hasDisabledRule,
      reason: hasDisabledRule ? 'pilot_group_disabled' : 'pilot_group_enabled',
    };
  }

  const roleRule = db.prepare(`
    SELECT enabled
    FROM feature_flag_role_rules
    WHERE feature_flag_id = ? AND role = ?
  `).get(flag.id, user.role);

  if (roleRule) {
    return {
      key: flag.flag_key,
      enabled: toBoolean(roleRule.enabled),
      reason: 'role_rule',
    };
  }

  if (flag.release_status === 'draft' || flag.release_status === 'pilot') {
    return {
      key: flag.flag_key,
      enabled: false,
      reason: 'release_restricted_to_pilot',
    };
  }

  const bucket = stableRolloutBucket(flag.flag_key, user.id);
  if (flag.rollout_percentage > 0) {
    const enabled = bucket < flag.rollout_percentage;
    return {
      key: flag.flag_key,
      enabled,
      reason: enabled ? 'percentage_enabled' : 'percentage_disabled',
      bucket,
    };
  }

  return {
    key: flag.flag_key,
    enabled: toBoolean(flag.default_enabled),
    reason: 'default',
    bucket,
  };
}

function evaluateFeatureFlags(db, flagKeys, user) {
  const uniqueKeys = [...new Set(flagKeys.map(normalizeKey))].slice(0, 50);
  return uniqueKeys.map((key) => evaluateFeatureFlag(db, key, user));
}

module.exports = {
  HOMOLOGATION_OPEN_FEATURES,
  evaluateFeatureFlag,
  evaluateFeatureFlags,
  findFeatureFlag,
  findFeatureFlagById,
  isValidFlagKey,
  isValidGroupKey,
  isValidReleaseVersion,
  normalizeKey,
  serializeFeatureFlag,
  stableRolloutBucket,
};
