const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { createBaselineDatabase } = require('../scripts/ci/migrationRehearsal');
const { runMigrations } = require('../src/migrations');
const { evaluateFeatureFlag } = require('../src/services/featureFlags');
const { FLAG, publication, portrait } = require('../src/services/municipalIndicators');
const service = require('../src/services/homologationNetworkPortrait');
function fixture(t) {
  const db = createBaselineDatabase(':memory:');
  runMigrations(db, { logger: { info() {} } });
  db.exec('CREATE TABLE homologation_snapshot_metadata(id INTEGER PRIMARY KEY,sanitized INTEGER); INSERT INTO homologation_snapshot_metadata VALUES(1,1)');
  const settings = { appEnvironment: 'homologation', deploymentMetadata: { sourceSha: 'b'.repeat(40),
    schemaVersion: 32, pullRequest: 3, targetBranch: 'homologacao', preparation: { version: 1, teacherHash: 'c'.repeat(64) } } };
  const receipt = { backupVerified: true, restorationVerified: true, sourceSha: 'b'.repeat(40), teacherHash: 'c'.repeat(64), backupName: 'synthetic-receipt' };
  t.after(() => db.close());
  return { db, settings, receipt, activate: () => service.activateHomologationNetworkPortrait(db, settings, receipt) };
}
test('pacote fixado reproduz somente a base pública revisada, incluindo ausências', () => {
  const batch = service.readBundledPortrait();
  assert.equal(batch.id, service.BATCH_ID); assert.equal(batch.rows.length, 18726); assert.equal(batch.places.length, 5571);
  assert.equal(batch.rows.find(r => r.ibgeCode === '1100015' && r.stage === 'elementary_final' && r.year === 2025).value, null);
  assert.ok(batch.rows.every(r => [2023, 2025].includes(r.year)));
});
test('produção e inicialização comum não abrem arquivos nem banco', () => {
  assert.deepEqual(service.activateHomologationNetworkPortrait(null, { appEnvironment: 'production' }, null), { status: 'skipped' });
  assert.deepEqual(service.activateHomologationNetworkPortrait(null, { appEnvironment: 'homologation' }, null), { status: 'skipped' });
});
test('metadados, recibo de restauração e marca de sanitização são obrigatórios', t => {
  for (const alter of [f => f.receipt.restorationVerified = false, f => f.receipt.sourceSha = 'd'.repeat(40),
    f => f.receipt.teacherHash = 'd'.repeat(64), f => f.settings.deploymentMetadata.targetBranch = 'modulo-banco-questoes',
    f => f.db.exec('UPDATE homologation_snapshot_metadata SET sanitized=0')]) {
    const f = fixture(t); alter(f); assert.throws(f.activate);
    assert.equal(publication(f.db).available, false); assert.equal(f.db.prepare('SELECT COUNT(*) FROM municipal_indicator_batches').pluck().get(), 0);
  }
});
test('importa e libera professores/admin atomicamente sem alterar cadastros, questões ou IA', t => {
  const f = fixture(t), before = f.db.prepare('SELECT * FROM users ORDER BY id').all();
  assert.equal(f.activate().status, 'published');
  assert.deepEqual(f.db.prepare('SELECT * FROM users ORDER BY id').all(), before);
  assert.equal(portrait(f.db, { ibgeCode: '2306405', stage: 'elementary_initial', year: 2025 }).current.value, 6.7);
  assert.equal(service.networkPortraitReadiness(f.db).releaseAudited, true);
  for (const role of ['professor', 'admin']) assert.equal(evaluateFeatureFlag(f.db, FLAG, { id: 1, role }).enabled, true);
  assert.equal(evaluateFeatureFlag(f.db, FLAG, { id: 1, role: 'student' }).enabled, false);
  assert.equal(evaluateFeatureFlag(f.db, 'question_bank.ai_assistant', { id: 1, role: 'professor' }).enabled, false);
  assert.equal(f.db.pragma('integrity_check', { simple: true }), 'ok'); assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM municipal_indicator_events').pluck().get(), 2);
  assert.match(f.db.prepare('SELECT reason FROM governance_audit_log WHERE action=?').pluck().get(service.ACTION), /PR #3, SHA b{40}/);
});
test('reinício não duplica lote nem remove kill switch, regra individual ou desativação administrativa', t => {
  const f = fixture(t); f.activate();
  f.db.prepare("UPDATE feature_flags SET master_enabled=0,kill_switch_active=1,kill_switch_reason='Suspensão administrativa' WHERE flag_key=?").run(FLAG);
  f.db.prepare('INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) SELECT id,1,0,? FROM feature_flags WHERE flag_key=?').run('Bloqueio individual', FLAG);
  f.settings.deploymentMetadata.sourceSha = f.receipt.sourceSha = 'd'.repeat(40);
  assert.equal(f.activate().status, 'already_published');
  assert.equal(service.networkPortraitReadiness(f.db).emergencyStop, true);
  assert.equal(service.networkPortraitReadiness(f.db).masterEnabled, false);
  assert.equal(f.db.prepare('SELECT COUNT(*) FROM municipal_indicator_events').pluck().get(), 2);
});
test('decisão anterior ou publicação diferente bloqueia primeira ativação', t => {
  for (const sql of ["UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Suspensão administrativa' WHERE flag_key='institutions.network_portrait'",
    'UPDATE municipal_indicator_publication SET revision=1',
    "INSERT INTO feature_flag_role_rules(feature_flag_id,role,enabled,reason) SELECT id,'professor',0,'Bloqueio' FROM feature_flags WHERE flag_key='institutions.network_portrait'"]) {
    const f = fixture(t); f.db.exec(sql); assert.throws(f.activate);
    assert.equal(f.db.prepare('SELECT COUNT(*) FROM municipal_indicator_batches').pluck().get(), 0);
  }
});
test('falha no recibo de auditoria reverte importação, publicação e liberação', t => {
  const f = fixture(t);
  f.db.exec(`CREATE TRIGGER reject_portrait BEFORE INSERT ON governance_audit_log WHEN NEW.action='${service.ACTION}' BEGIN SELECT RAISE(ABORT,'audit unavailable'); END`);
  assert.throws(f.activate, /audit unavailable/);
  assert.equal(publication(f.db).available, false);
  for (const table of ['municipal_indicator_batches', 'municipal_indicator_values', 'municipal_indicator_places', 'municipal_indicator_events', 'feature_flag_role_rules']) {
    assert.equal(f.db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get(), 0);
  }
  assert.equal(f.db.prepare('SELECT master_enabled FROM feature_flags WHERE flag_key=?').pluck().get(FLAG), 0);
});
test('artefato adulterado ou manifesto com travessia é recusado antes de importar', t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-portrait-artifact-'));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const m = require('../catalogs/municipal-ideb-2025.manifest.json');
  const manifestFile = path.join(folder, 'municipal-ideb-2025.manifest.json');
  fs.writeFileSync(manifestFile, JSON.stringify(m)); fs.writeFileSync(path.join(folder, m.artifact), 'tampered');
  assert.throws(() => service.readBundledPortrait(folder));
  fs.writeFileSync(manifestFile, JSON.stringify({ ...m, artifact: '../outside.gz' }));
  assert.throws(() => service.readBundledPortrait(folder));
});
