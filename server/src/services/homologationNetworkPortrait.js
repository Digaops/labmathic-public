// Explicit release operation backed by the protected workflow's verified receipt.
// Never runs for a normal application startup, a missing receipt, or production.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');
const { validPreparation } = require('../deploymentMetadata');
const { FLAG, validatePrepared, stageIndicators, activateIndicators, publication } = require('./municipalIndicators');
const BATCH_ID = '630a121381c0121aeabdf8a9da10feb5b41f962afa7fb335262f9f3ad17fe758';
const ACTION = 'publish_homologation_network_portrait';
const KEY = `network-portrait:${BATCH_ID}`;
const FOLDER = path.resolve(__dirname, '../../catalogs');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function readFile(file, limit) {
  const stat = fs.lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= limit, 'Artefato público inválido.');
  return fs.readFileSync(file);
}
function readBundledPortrait(folder = FOLDER) {
  const m = JSON.parse(readFile(path.join(folder, 'municipal-ideb-2025.manifest.json'), 4096));
  assert.equal(m.version, 1); assert.equal(m.batchId, BATCH_ID);
  assert.equal(m.artifact, 'municipal-ideb-2025.json.gz');
  const packed = readFile(path.join(folder, m.artifact), 1024 * 1024);
  assert.equal(packed.length, m.artifactBytes); assert.equal(sha(packed), m.artifactSha256);
  const bytes = zlib.gunzipSync(packed, { maxOutputLength: 4 * 1024 * 1024 });
  assert.equal(bytes.length, m.expandedBytes); assert.equal(sha(bytes), m.expandedSha256);
  const batch = validatePrepared(JSON.parse(bytes));
  assert.equal(batch.id, BATCH_ID); assert.equal(batch.rows.length, 18726); assert.equal(batch.places.length, 5571);
  assert.equal(m.rowCount, batch.rows.length); assert.equal(m.placeCount, batch.places.length);
  return batch;
}
function activationRecord(db) {
  return db.prepare('SELECT current_json FROM governance_audit_log WHERE action=? AND entity_key=? ORDER BY id DESC LIMIT 1').get(ACTION, KEY);
}
function activateHomologationNetworkPortrait(db, config, receipt) {
  if (config.appEnvironment !== 'homologation' || !config.deploymentMetadata?.preparation) return { status: 'skipped' };
  const m = config.deploymentMetadata;
  assert.ok(m.targetBranch === 'homologacao' && m.schemaVersion >= 32 && /^[a-f0-9]{40}$/.test(m.sourceSha)
    && Number.isSafeInteger(m.pullRequest) && m.pullRequest > 0
    && validPreparation(m.preparation,m.schemaVersion), 'Publicação não autorizada.');
  assert.ok(receipt?.backupVerified === true && receipt.restorationVerified === true && receipt.sourceSha === m.sourceSha
    && receipt.teacherHash === m.preparation.teacherHash, 'Publicação exige backup restaurável desta release.');
  assert.equal(db.prepare('SELECT sanitized FROM homologation_snapshot_metadata WHERE id=1').pluck().get(), 1);
  // Check the artifact even on restart, but never overwrite a later publication or admin decision.
  const batch = readBundledPortrait();
  return db.transaction(() => {
    if (activationRecord(db)) return { status: 'already_published', batchId: publication(db).batchId };
    const current = publication(db);
    assert.ok(current.revision === 0 && current.batchId === null, 'Já existe uma publicação; revisão operacional necessária.');
    const flag = db.prepare('SELECT * FROM feature_flags WHERE flag_key=?').get(FLAG);
    assert.ok(flag && !flag.kill_switch_active && !flag.master_enabled && !flag.default_enabled
      && flag.rollout_percentage === 0 && !flag.release_id, 'Decisão existente sobre a flag foi preservada.');
    assert.ok(!db.prepare("SELECT 1 FROM governance_audit_log WHERE entity_type='feature_flag' AND entity_id=?").get(flag.id), 'Decisão administrativa anterior preservada.');
    for (const table of ['feature_flag_user_rules', 'feature_flag_group_rules', 'feature_flag_role_rules']) {
      assert.ok(!db.prepare(`SELECT 1 FROM ${table} WHERE feature_flag_id=?`).get(flag.id), 'Regra de acesso anterior preservada.');
    }
    stageIndicators(db, batch);
    const result = activateIndicators(db, { batchId: BATCH_ID, expectedRevision: 0, confirmation: 'PUBLISH_REVIEWED_NETWORK_PORTRAIT' });
    db.prepare('UPDATE feature_flags SET master_enabled=1,revision=revision+1,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(flag.id);
    const reason = `Teste docente autorizado na homologação, PR #${m.pullRequest}, SHA ${m.sourceSha}.`;
    for (const role of ['professor', 'admin']) db.prepare('INSERT INTO feature_flag_role_rules(feature_flag_id,role,enabled,reason) VALUES(?,?,1,?)').run(flag.id, role, reason);
    db.prepare(`INSERT INTO governance_audit_log(action,entity_type,entity_id,entity_key,reason,previous_json,current_json,user_agent)
      VALUES(?,'feature_flag',?,?,?,?,?,'protected-homologation-workflow/network-portrait-v1')`).run(
      ACTION, flag.id, KEY, reason, JSON.stringify({ flag, publication: current }),
      JSON.stringify({ batchId: BATCH_ID, sourceSha: m.sourceSha, pullRequest: m.pullRequest, backupName: receipt.backupName,
        restorationVerified: true, scope: ['professor', 'admin'], approvalReference: 'docs/releases/2026-09-14-functional-homologation.md' }));
    return { status: 'published', ...result };
  }).immediate();
}
function networkPortraitReadiness(db) {
  const current = publication(db);
  const flag = db.prepare('SELECT master_enabled,kill_switch_active FROM feature_flags WHERE flag_key=?').get(FLAG);
  return { published: current.available, batchId: current.batchId, revision: current.revision,
    masterEnabled: flag?.master_enabled === 1, emergencyStop: flag?.kill_switch_active === 1,
    releaseAudited: Boolean(activationRecord(db)) };
}
module.exports = { BATCH_ID, ACTION, readBundledPortrait, activateHomologationNetworkPortrait, networkPortraitReadiness };
