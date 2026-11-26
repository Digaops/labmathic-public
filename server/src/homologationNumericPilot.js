// Closed release operation; never an HTTP write route or a general grant mechanism.
const crypto = require('node:crypto');
const { evaluateFeatureFlag } = require('./services/featureFlags');
const AUTHORING = 'question_bank.numeric_drafts';
const ASSESSMENTS = 'classes.numeric_assessments';
const DEPENDENCIES = ['classes.core', 'classes.assessment_assignments', 'classes.assessment_delivery',
  'classes.assessment_results', 'classes.student_assessment_portal', 'classes.learning_recovery'];
const fail = message => { const error = new Error(message); error.releaseSafe = true; throw error; };

function accounts(db, preparation) {
  const rows = db.prepare('SELECT id, email, role FROM users').all();
  function find(hash, role) {
    const matches = rows.filter(row => crypto.createHash('sha256').update(String(row.email).trim().toLowerCase()).digest('hex') === hash);
    if (matches.length !== 1 || matches[0].role !== role) fail('Piloto numérico exige professor e administrador existentes e distintos.');
    return { id: matches[0].id, role };
  }
  const teacher = find(preparation.teacherHash, 'professor');
  const reviewer = find(preparation.numericReviewerHash, 'admin');
  if (teacher.id === reviewer.id) fail('A revisão numérica exige uma conta distinta do autor.');
  return { teacher, reviewer };
}

function exclusive(db, flag, allowed) {
  if (!flag || flag.default_enabled || flag.rollout_percentage !== 0) return false;
  if (db.prepare('SELECT 1 FROM feature_flag_group_rules WHERE feature_flag_id=? AND enabled=1').get(flag.id)
    || db.prepare('SELECT 1 FROM feature_flag_role_rules WHERE feature_flag_id=? AND enabled=1').get(flag.id)) return false;
  return db.prepare('SELECT user_id FROM feature_flag_user_rules WHERE feature_flag_id=? AND enabled=1').all(flag.id)
    .every(row => allowed.some(account => account.id === row.user_id));
}

function inspectNumericPilot(db, metadata, isSanitizerStop) {
  if (metadata.preparation.version !== 2) return null;
  const { teacher, reviewer } = accounts(db, metadata.preparation);
  const grants = [[AUTHORING, [teacher, reviewer]], [ASSESSMENTS, [teacher]]].map(([key, allowed]) => {
    const flag = db.prepare(`SELECT ff.*, pr.status AS release_status FROM feature_flags ff
      LEFT JOIN product_releases pr ON pr.id=ff.release_id WHERE ff.flag_key=?`).get(key);
    if (!flag || ['paused', 'retired'].includes(flag.release_status)
      || (flag.kill_switch_active && !isSanitizerStop(db, flag))) fail(`Bloqueio ou ausência do piloto numérico: ${key}.`);
    if (!flag.master_enabled && db.prepare("SELECT 1 FROM governance_audit_log WHERE entity_type='feature_flag' AND entity_id=?").get(flag.id)) {
      fail(`Desativação anterior do piloto numérico preservada: ${key}.`);
    }
    if (!exclusive(db, flag, allowed)) fail(`Regras amplas impedem a liberação numérica restrita: ${key}.`);
    const rules = allowed.map(account => {
      const prior = db.prepare('SELECT * FROM feature_flag_user_rules WHERE feature_flag_id=? AND user_id=?').get(flag.id, account.id);
      const roleDenied = db.prepare('SELECT 1 FROM feature_flag_role_rules WHERE feature_flag_id=? AND role=? AND enabled=0').get(flag.id, account.role);
      const groupDenied = db.prepare(`SELECT 1 FROM feature_flag_group_rules r
        JOIN pilot_groups g ON g.id=r.group_id AND g.active=1
        JOIN pilot_group_members m ON m.group_id=g.id
        WHERE r.feature_flag_id=? AND m.user_id=? AND r.enabled=0`).get(flag.id, account.id);
      if (prior?.enabled === 0 || roleDenied || groupDenied) fail(`Bloqueio de conta, papel ou grupo preservado no piloto numérico: ${key}.`);
      return { account, prior };
    });
    return { key, flag, rules };
  });
  return { teacher, reviewer, grants };
}

function activateNumericPilot(db, inspected, metadata, audit) {
  if (!inspected) return;
  for (const { key, flag, rules } of inspected.grants) {
    db.prepare(`UPDATE feature_flags SET master_enabled=1, kill_switch_active=0, kill_switch_reason=NULL,
      kill_switch_activated_by=NULL, kill_switch_activated_at=NULL, revision=revision+1,
      updated_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(flag.id);
    audit(db, { action:'enable_homologation_numeric_master', type:'feature_flag', id:flag.id, key,
      previous:flag, current:db.prepare('SELECT * FROM feature_flags WHERE id=?').get(flag.id) }, metadata);
    for (const { account, prior } of rules) {
      if (prior) continue;
      const rule = db.prepare(`INSERT INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason)
        VALUES (?,?,1,'Piloto numérico restrito autorizado pelo fluxo de homologação.')`).run(flag.id, account.id);
      audit(db, { action:'enable_homologation_numeric_user', type:'feature_flag_rule', id:Number(rule.lastInsertRowid), key,
        current:{ featureFlagId:flag.id, userId:account.id, enabled:true } }, metadata);
    }
  }
}

function numericReadiness(db, metadata) {
  if (metadata.preparation.version !== 2) return undefined;
  const result = { accountsFound:false, authoringEnabled:false, reviewEnabled:false,
    assessmentsEnabled:false, dependenciesReady:false, exclusive:false, scope:'teacher_and_reviewer' };
  let actors;
  try { actors = accounts(db, metadata.preparation); } catch { return result; }
  const { teacher, reviewer } = actors;
  const enabled = (key, actor) => evaluateFeatureFlag(db, key, actor).enabled;
  const flag = key => db.prepare('SELECT * FROM feature_flags WHERE flag_key=?').get(key);
  return { ...result, accountsFound:true, authoringEnabled:enabled(AUTHORING, teacher),
    reviewEnabled:enabled(AUTHORING, reviewer), assessmentsEnabled:enabled(ASSESSMENTS, teacher),
    dependenciesReady:DEPENDENCIES.every(key => enabled(key, teacher)),
    exclusive:exclusive(db, flag(AUTHORING), [teacher,reviewer]) && exclusive(db, flag(ASSESSMENTS), [teacher]) };
}

module.exports = { inspectNumericPilot, activateNumericPilot, numericReadiness };
