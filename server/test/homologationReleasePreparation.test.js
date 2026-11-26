const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const Database = require('better-sqlite3');
const { createBaselineDatabase } = require('../scripts/ci/migrationRehearsal');
const { runMigrations } = require('../src/migrations');
const { hashFile, verifyBackup } = require('../src/backup');
const service = require('../src/homologationReleasePreparation');
const appConfig = require('../src/config');
const { evaluateFeatureFlag } = require('../src/services/featureFlags');
const runtimeSchemaVersion = 43;

function fixture(t, schema = 25, fullRuntime = false) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-staging-pilot-'));
  fs.mkdirSync(path.join(root, 'data')); fs.mkdirSync(path.join(root, 'uploads'));
  const config = { appEnvironment: 'homologation', dbPath: path.join(root, 'data', 'database.sqlite'),
    uploadDir: path.join(root, 'uploads'), deploymentMetadata: {
      sourceSha: 'b'.repeat(40), schemaVersion: runtimeSchemaVersion, targetBranch: 'homologacao', pullRequest: 3,
      preparation: { version: 1, teacherHash: service.teacherHash('pilot@example.invalid') },
    } };
  fs.writeFileSync(path.join(config.uploadDir, 'lesson.txt'), 'synthetic educational content');
  if (fullRuntime) {
    require('node:child_process').execFileSync(process.execPath, ['-e', "require('./src/database').close()"], {
      cwd: path.resolve(__dirname, '..'), windowsHide: true, stdio: 'pipe', env: { ...process.env,
        NODE_ENV: 'test', APP_ENV: 'development', DB_PATH: config.dbPath, UPLOAD_DIR: config.uploadDir,
      },
    });
  }
  const db = fullRuntime ? new Database(config.dbPath) : createBaselineDatabase(config.dbPath);
  if (fullRuntime) db.exec(`INSERT INTO users (id,name,email,password,role) VALUES
    (1,'Pilot','pilot@example.invalid','synthetic','professor'),
    (2,'Admin','admin@example.invalid','synthetic','admin')`);
  const folder = path.resolve(__dirname, '../src/migrations');
  const migrations = fs.readdirSync(folder).filter(name => /^\d{3}_.*\.js$/.test(name)).sort()
    .map(name => require(path.join(folder, name))).filter(item => item.version <= schema);
  runMigrations(db, { migrations, logger: { info() {} } });
  db.exec(`CREATE TABLE homologation_snapshot_metadata (id INTEGER PRIMARY KEY, sanitized INTEGER);
    INSERT INTO homologation_snapshot_metadata VALUES (1, 1);`);
  db.prepare("UPDATE users SET email = 'pilot@example.invalid', role = 'professor' WHERE id = 1").run();
  db.prepare("INSERT INTO users (name, email, password, role) VALUES ('Other teacher','other@example.invalid','synthetic','professor')").run();
  db.prepare(`UPDATE feature_flags SET kill_switch_active = 1, kill_switch_reason = ?,
    kill_switch_activated_by = NULL, master_enabled = 0, default_enabled = 0, rollout_percentage = 0
    WHERE flag_key != ? AND flag_key != 'institutions.network_portrait'`).run(service.SANITIZER_STOP, service.PILOT_FLAG);
  db.close();
  const opened = [];
  t.after(() => { opened.forEach(item => { if (item.open) item.close(); }); fs.rmSync(root, { recursive: true, force: true }); });
  return { config, root, open: () => { const item = new Database(config.dbPath); opened.push(item); return item; } };
}

test('backup integral e restauração antecedem a migração; piloto individual auditado e repetível', async t => {
  const f = fixture(t);
  const before = hashFile(f.config.dbPath);
  const receipt = await service.prepareHomologationRelease(f.config);
  assert.equal(hashFile(f.config.dbPath), before, 'a preparação não escreve no banco ativo');
  assert.equal(receipt.backupVerified, true); assert.equal(receipt.restorationVerified, true);
  const vault = path.join(f.root, 'release-backups');
  const backup = verifyBackup(path.join(vault, receipt.backupName));
  assert.equal(backup.uploads.files, 1);
  assert.ok(!fs.readdirSync(vault).some(x => x.startsWith('.restore-')));
  const original = new Database(path.join(vault, receipt.backupName, 'database.sqlite'), { readonly: true });
  assert.equal(original.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 25);
  original.close();
  const db = f.open();
  runMigrations(db, { logger: { info() {} } });
  assert.deepEqual(service.activateHomologationPilot(db, f.config, receipt), { reused: false });
  const auditCount = db.prepare('SELECT COUNT(*) FROM governance_audit_log').pluck().get();
  assert.ok(auditCount > 10);
  assert.deepEqual(service.activateHomologationPilot(db, f.config, receipt), { reused: true });
  assert.equal(db.prepare('SELECT COUNT(*) FROM governance_audit_log').pluck().get(), auditCount);
  appConfig.appEnvironment = 'homologation';
  t.after(() => { appConfig.appEnvironment = 'development'; });
  assert.equal(evaluateFeatureFlag(db, service.PILOT_FLAG, { id: 1, role: 'professor' }).enabled, true);
  assert.equal(evaluateFeatureFlag(db, service.PILOT_FLAG, { id: 3, role: 'professor' }).enabled, false);
  const readiness = service.getReleaseReadiness(db, f.config, receipt);
  assert.deepEqual(readiness.pilot, { accountFound: true, operationalCycleEnabled: true, dependenciesReady: true, exclusive: true, scope: 'individual' });
  assert.equal(readiness.auditRecorded, true);
  assert.deepEqual(readiness.studentFeedback, { enabled: true, scope: 'individual' });
  assert.equal(evaluateFeatureFlag(db, 'classes.student_feedback_release', { id: 3, role: 'professor' }).enabled, false);
  assert.doesNotMatch(JSON.stringify(readiness), /email|teacherHash|teacherId|databaseHash|backupName|example.invalid/);
  assert.equal(db.prepare("SELECT kill_switch_active FROM feature_flags WHERE flag_key = 'question_bank.typed_engine'").pluck().get(), 1);
  assert.equal(fs.readFileSync(path.join(f.config.uploadDir, 'lesson.txt'), 'utf8'), 'synthetic educational content');
  assert.throws(() => db.exec('DELETE FROM governance_audit_log'), /immutable/);
  db.prepare("UPDATE feature_flags SET kill_switch_active = 1, kill_switch_reason = 'Suspensão posterior ao piloto.' WHERE flag_key = ?").run(service.PILOT_FLAG);
  const reused = await service.prepareHomologationRelease(f.config);
  assert.equal(reused.reused, true);
  service.activateHomologationPilot(db, f.config, reused);
  assert.equal(service.getReleaseReadiness(db, f.config, reused).pilot.operationalCycleEnabled, false);
});

test('sem instrução não toca arquivos; produção não pode preparar ou ativar piloto', async () => {
  assert.equal(await service.prepareHomologationRelease({ appEnvironment: 'production' }), null);
  const config = { appEnvironment: 'production', deploymentMetadata: { sourceSha: 'a'.repeat(40), schemaVersion: 26,
    targetBranch: 'homologacao', preparation: { version: 1, teacherHash: 'c'.repeat(64) } } };
  await assert.rejects(service.prepareHomologationRelease(config), /fora da homologação/);
  assert.throws(() => service.activateHomologationPilot(null, config, {}), /fora da homologação/);
});

test('ausência de professor, marca sanitizada inválida e schema divergente bloqueiam antes da migração', async t => {
  for (const alter of [
    db => db.prepare("UPDATE users SET role = 'admin' WHERE id = 1").run(),
    db => db.exec('UPDATE homologation_snapshot_metadata SET sanitized = 0'),
    db => db.exec("UPDATE schema_migrations SET checksum = 'invalido' WHERE version = 25"),
  ]) {
    const f = fixture(t); const db = f.open(); alter(db); db.close();
    const before = hashFile(f.config.dbPath);
    await assert.rejects(service.prepareHomologationRelease(f.config));
    assert.equal(hashFile(f.config.dbPath), before);
  }
});

test('bloqueio emergencial humano nunca é confundido com o bloqueio da sanitização', async t => {
  for (const audited of [false, true]) {
    const f = fixture(t); const db = f.open();
    if (audited) {
      db.exec(`INSERT INTO governance_audit_log (action, entity_type, entity_id, reason)
        SELECT 'kill_switch_enabled', 'feature_flag', id, 'Bloqueio por decisão humana.' FROM feature_flags WHERE flag_key = 'classes.core'`);
    } else {
      db.exec("UPDATE feature_flags SET kill_switch_reason = 'Incidente sob investigação.' WHERE flag_key = 'classes.core'");
    }
    db.close();
    await assert.rejects(service.prepareHomologationRelease(f.config), /Bloqueio emergencial preservado/);
  }
});

test('falha de auditoria desfaz todas as liberações sem modificar uploads ou backup', async t => {
  const f = fixture(t, 39); const receipt = await service.prepareHomologationRelease(f.config);
  const db = f.open();
  const before = db.prepare('SELECT * FROM feature_flags ORDER BY id').all();
  db.exec(`CREATE TRIGGER reject_pilot_audit BEFORE INSERT ON governance_audit_log
    WHEN NEW.action = 'activate_homologation_pilot' BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END`);
  assert.throws(() => service.activateHomologationPilot(db, f.config, receipt), /audit unavailable/);
  assert.deepEqual(db.prepare('SELECT * FROM feature_flags ORDER BY id').all(), before);
  assert.equal(db.prepare('SELECT COUNT(*) FROM governance_audit_log').pluck().get(), 0);
  assert.equal(db.prepare('SELECT COUNT(*) FROM feature_flag_user_rules').pluck().get(), 0);
  assert.ok(fs.existsSync(path.join(f.root, 'release-backups', receipt.backupName, 'database.sqlite')));
});

test('não amplia rollout nem remove bloqueio individual ou release pausada', async t => {
  for (const sql of [
    "UPDATE feature_flags SET default_enabled = 1 WHERE flag_key = 'pedagogy.operational_cycle'",
    "INSERT INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason) SELECT id,1,0,'Suspensão individual explícita.' FROM feature_flags WHERE flag_key = 'pedagogy.operational_cycle'",
    "UPDATE product_releases SET status = 'paused' WHERE id = (SELECT release_id FROM feature_flags WHERE flag_key = 'pedagogy.operational_cycle')",
  ]) {
    const f = fixture(t, 26); const db = f.open(); db.exec(sql); db.close();
    await assert.rejects(service.prepareHomologationRelease(f.config));
  }
});

test('reuso recusa backup corrompido e recibo de outra conta', async t => {
  const f = fixture(t, 39); const receipt = await service.prepareHomologationRelease(f.config);
  const db = f.open(); service.activateHomologationPilot(db, f.config, receipt); db.close();
  const vault = path.join(f.root, 'release-backups');
  const receiptPath = path.join(vault, `release-${f.config.deploymentMetadata.sourceSha}.json`);
  const saved = fs.readFileSync(receiptPath, 'utf8');
  fs.writeFileSync(receiptPath, JSON.stringify({ ...JSON.parse(saved), teacherHash: '0'.repeat(64) }));
  await assert.rejects(service.prepareHomologationRelease(f.config), /Recibo não corresponde/);
  fs.writeFileSync(receiptPath, saved);
  fs.appendFileSync(path.join(vault, receipt.backupName, 'uploads', 'lesson.txt'), 'changed');
  await assert.rejects(service.prepareHomologationRelease(f.config), /Inventario/);
});

test('não deduz cofre em diretório amplo ou sobre uploads', async t => {
  const f = fixture(t);
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'unrelated-assets-'));
  t.after(() => fs.rmSync(outside, { recursive: true, force: true }));
  await assert.rejects(service.prepareHomologationRelease({ ...f.config, uploadDir: outside }), /delimitar/);
});

test('hash de identidade é normalizado, não uma credencial de autenticação', () => {
  assert.equal(service.teacherHash(' PILOT@EXAMPLE.INVALID '), service.teacherHash('pilot@example.invalid'));
});

test('piloto de devolutiva preserva suspensão humana, regra individual e abrangência restrita', async t => {
  for (const sql of [
    "UPDATE feature_flags SET kill_switch_reason='Incidente em investigação' WHERE flag_key='classes.student_feedback_release'",
    "UPDATE feature_flags SET default_enabled=1 WHERE flag_key='classes.student_feedback_release'",
    "INSERT INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason) SELECT id,1,0,'Suspensão individual' FROM feature_flags WHERE flag_key='classes.student_feedback_release'",
  ]) {
    const f = fixture(t, 39); const db = f.open(); db.exec(sql); db.close();
    await assert.rejects(service.prepareHomologationRelease(f.config), /Devolutiva|devolutiva/);
  }
  const f = fixture(t, 39); const receipt = await service.prepareHomologationRelease(f.config);
  const db = f.open(); service.activateHomologationPilot(db, f.config, receipt);
  db.exec("UPDATE feature_flags SET kill_switch_active=1, kill_switch_reason='Suspensão posterior' WHERE flag_key='classes.student_feedback_release'");
  assert.deepEqual(service.activateHomologationPilot(db, f.config, receipt), { reused: true });
  assert.equal(service.getReleaseReadiness(db, f.config, receipt).studentFeedback.enabled, false);
});

for (const preparationVersion of [1, 2]) test(`aplicação real restringe pilotos e prontidão, preparação v${preparationVersion}`, { timeout: 45000 }, async t => {
  const { spawn } = require('node:child_process');
  const net = require('node:net');
  const bcrypt = require('bcryptjs');
  const f = fixture(t, runtimeSchemaVersion, true);
  const db = f.open();
  const password = 'synthetic-pilot-runtime-password';
  db.prepare('UPDATE users SET password = ?').run(bcrypt.hashSync(password, 10));
  const admin = db.prepare("SELECT email FROM users WHERE role = 'admin' LIMIT 1").get();
  if (preparationVersion === 2) f.config.deploymentMetadata.preparation = {
    ...f.config.deploymentMetadata.preparation, version:2, numericReviewerHash:service.teacherHash(admin.email),
  };
  db.close();
  const reservation = net.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const child = spawn(process.execPath, ['-e', `
    const config = require('./src/config');
    config.deploymentMetadata = JSON.parse(process.env.TEST_PILOT_METADATA);
    // O catálogo Inep tem testes próprios; esta fixture não usa rede externa nem catálogo real.
    const directory = require.resolve('./src/services/bundledSchoolDirectory');
    require.cache[directory] = { id: directory, filename: directory, loaded: true,
      exports: { bootstrapBundledSchoolDirectory: async () => ({ status: 'skipped' }) } };
    require('./src/index').catch(error => console.error(error.stack));
  `], { cwd: path.resolve(__dirname, '..'), windowsHide: true, env: { ...process.env,
    NODE_ENV: 'production', APP_ENV: 'homologation', PORT: String(port),
    DB_PATH: f.config.dbPath, UPLOAD_DIR: f.config.uploadDir, JWT_SECRET: 'synthetic-runtime-only-key',
    SMTP_USER: '', SMTP_PASS: '', STUDENT_ASSESSMENT_ACCESS_SECRET: 'synthetic-student-only-key',
    GOVERNANCE_ADMIN_ENABLED: 'false', TEST_PILOT_METADATA: JSON.stringify(f.config.deploymentMetadata), OPENAI_API_KEY: '',
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  // Fechar antes da limpeza da fixture, inclusive no Windows.
  let errorOutput = ''; child.stderr.on('data', part => { errorOutput += part.toString().slice(0, 2000); });
  child.stdout.resume();
  const ended = new Promise(resolve => child.once('exit', resolve));
  const origin = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 20000; let healthy = false;
    while (Date.now() < deadline && child.exitCode === null) {
      try { const response = await fetch(`${origin}/api/health`); healthy = response.ok && (await response.json()).schemaVersion === runtimeSchemaVersion; } catch { /* aguardar listener */ }
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(healthy, `runtime isolado indisponível: ${errorOutput}`);
    async function login(email) {
      const response = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      assert.equal(response.status, 200); return (await response.json()).token;
    }
    const adminToken = await login(admin.email); const pilotToken = await login('pilot@example.invalid'); const otherToken = await login('other@example.invalid');
    // Real application starts without an OpenAI key; only the new AI route reports configuration missing.
    const ai = await fetch(`${origin}/api/ai/questions/generate`, { method: 'POST', headers: {
      'Content-Type': 'application/json', Authorization: `Bearer ${pilotToken}` }, body: '{}' });
    assert.equal(ai.status, 503); assert.equal((await ai.json()).code, 'AI_NOT_CONFIGURED');
    async function get(route, token) { return fetch(`${origin}${route}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} }); }
    const contentIssues = await get('/api/content-issues', pilotToken);
    assert.equal(contentIssues.status, 404);
    assert.equal((await contentIssues.json()).code, 'feature_disabled');
    const coordination = await get('/api/school-coordination/schools', pilotToken);
    assert.equal(coordination.status, 404);
    assert.equal((await coordination.json()).code, 'feature_disabled');
    assert.equal((await get('/api/homologation/release-readiness')).status, 401);
    assert.equal((await get('/api/homologation/release-readiness', pilotToken)).status, 403);
    const ready = await get('/api/homologation/release-readiness', adminToken);
    assert.equal(ready.status, 200); assert.match(ready.headers.get('cache-control'), /no-store/);
    const readiness = await ready.json();
    assert.equal(readiness.pilot.operationalCycleEnabled, true);
    assert.equal(readiness.studentFeedback.enabled, true);
    if (preparationVersion === 2) {
      assert.equal(readiness.numericPilot.exclusive,true);
      assert.equal(readiness.numericPilot.reviewEnabled,true);
      assert.equal((await get('/api/question-bank/numeric-drafts',pilotToken)).status,200);
      assert.equal((await get('/api/question-bank/numeric-drafts/reviews/queue',adminToken)).status,200);
      assert.equal((await get('/api/question-bank/numeric-drafts/reviews/queue',pilotToken)).status,403);
      assert.equal((await get('/api/question-bank/numeric-drafts',adminToken)).status,403);
    } else assert.equal(readiness.numericPilot,undefined);
    assert.equal((await get('/api/question-bank/numeric-drafts',otherToken)).status,404);
    for (const [token,expected] of [[pilotToken,preparationVersion===2],[otherToken,false],[adminToken,false]]) {
      const response=await get('/api/governance/features?keys=classes.numeric_assessments',token);
      assert.equal((await response.json()).features['classes.numeric_assessments'],expected);
    }
    for (const [token, enabled] of [[pilotToken, true], [otherToken, false]]) {
      const featureResponse = await get('/api/governance/features?keys=classes.student_feedback_release', token);
      assert.equal(featureResponse.status, 200);
      const flags = await featureResponse.json();
      assert.equal(flags.features['classes.student_feedback_release'], enabled);
    }
    for (const actorToken of [pilotToken, otherToken, adminToken]) {
      const portrait = await get('/api/municipal-indicators/municipalities/2306405?stage=elementary_initial&year=2025', actorToken);
      assert.equal(portrait.status, 200);
      const result = await portrait.json();
      assert.equal(result.current.value, 6.7); assert.equal(result.comparison.change, 0.3);
    }
    assert.equal((await get('/api/municipal-indicators')).status, 401);
    assert.equal((await get('/api/question-bank/ai-authoring', pilotToken)).status, 404);
    assert.equal((await get('/api/pedagogical-cycle/classes', pilotToken)).status, 200);
    assert.equal((await get('/api/pedagogical-cycle/classes', otherToken)).status, 404);
    assert.equal((await get('/api/pedagogical-cycle/classes', adminToken)).status, 403);
    assert.equal((await get('/api/governance/admin/releases', adminToken)).status, 404);
  } finally {
    child.kill(); await ended;
  }
});

function numericFixture(t) {
  const f = fixture(t,39);
  const db = f.open();
  db.exec("UPDATE users SET email='reviewer@example.invalid' WHERE id=2");
  db.close();
  f.config.deploymentMetadata.preparation = {version:2,teacherHash:service.teacherHash('pilot@example.invalid'),
    numericReviewerHash:service.teacherHash('reviewer@example.invalid')};
  const prior = appConfig.appEnvironment;
  appConfig.appEnvironment='homologation';
  t.after(()=>{appConfig.appEnvironment=prior;});
  return f;
}

test('piloto numérico libera somente autor/revisor, preserva dados e reuso não desfaz suspensão', async t => {
  const f=numericFixture(t);
  const before=hashFile(f.config.dbPath);
  const receipt=await service.prepareHomologationRelease(f.config);
  assert.equal(hashFile(f.config.dbPath),before);
  const db=f.open();
  const users=db.prepare('SELECT * FROM users ORDER BY id').all();
  service.activateHomologationPilot(db,f.config,receipt);
  assert.deepEqual(db.prepare('SELECT * FROM users ORDER BY id').all(),users);
  const ready=service.getReleaseReadiness(db,f.config,receipt);
  assert.deepEqual(ready.numericPilot,{accountsFound:true,authoringEnabled:true,reviewEnabled:true,
    assessmentsEnabled:true,dependenciesReady:true,exclusive:true,scope:'teacher_and_reviewer'});
  assert.doesNotMatch(JSON.stringify(ready),/Hash|Fingerprint|teacherId|reviewerId|@/);
  assert.equal(evaluateFeatureFlag(db,'question_bank.numeric_drafts',{id:3,role:'professor'}).enabled,false);
  assert.equal(evaluateFeatureFlag(db,'classes.numeric_assessments',{id:2,role:'admin'}).enabled,false);
  for(const key of ['question_bank.numeric_drafts','classes.numeric_assessments']) {
    assert.deepEqual(db.prepare('SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key=?').get(key),
      {master_enabled:1,default_enabled:0,rollout_percentage:0});
  }
  const auditCount=db.prepare('SELECT count(*) FROM governance_audit_log').pluck().get();
  db.exec("UPDATE feature_flags SET master_enabled=0 WHERE flag_key='question_bank.numeric_drafts'");
  const reused=await service.prepareHomologationRelease(f.config);
  assert.equal(reused.reused,true);
  assert.deepEqual(service.activateHomologationPilot(db,f.config,reused),{reused:true});
  assert.equal(service.getReleaseReadiness(db,f.config,reused).numericPilot.reviewEnabled,false);
  assert.equal(db.prepare('SELECT count(*) FROM governance_audit_log').pluck().get(),auditCount);
  const next={...f.config,deploymentMetadata:{...f.config.deploymentMetadata,sourceSha:'c'.repeat(40)}};
  await assert.rejects(service.prepareHomologationRelease(next),/Desativação anterior/);
  db.exec("UPDATE users SET role='professor' WHERE id=2");
  assert.equal(service.getReleaseReadiness(db,f.config,reused).numericPilot.accountsFound,false);
});

test('piloto numérico recusa contas, bloqueios e regras amplas antes de alterar banco', async t => {
  const key="'question_bank.numeric_drafts'";
  const cases=[
    "DELETE FROM users WHERE id=2",
    "UPDATE users SET role='professor' WHERE id=2",
    "UPDATE users SET role='admin' WHERE id=1",
    `UPDATE feature_flags SET kill_switch_reason='Suspensão humana' WHERE flag_key=${key}`,
    `UPDATE feature_flags SET kill_switch_activated_by=2 WHERE flag_key=${key}`,
    `INSERT INTO governance_audit_log(action,entity_type,entity_id,reason) SELECT 'stop','feature_flag',id,'Suspensão explícita' FROM feature_flags WHERE flag_key=${key}`,
    `UPDATE feature_flags SET default_enabled=1 WHERE flag_key=${key}`,
    `UPDATE feature_flags SET rollout_percentage=1 WHERE flag_key=${key}`,
    `INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) SELECT id,3,1,'Outro docente' FROM feature_flags WHERE flag_key=${key}`,
    `INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) SELECT id,1,0,'Suspensão' FROM feature_flags WHERE flag_key=${key}`,
    `INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) SELECT id,2,0,'Suspensão' FROM feature_flags WHERE flag_key=${key}`,
    `INSERT INTO feature_flag_role_rules(feature_flag_id,role,enabled,reason) SELECT id,'professor',1,'Amplo' FROM feature_flags WHERE flag_key=${key}`,
    `INSERT INTO feature_flag_role_rules(feature_flag_id,role,enabled,reason) SELECT id,'admin',0,'Negado' FROM feature_flags WHERE flag_key=${key}`,
    `INSERT INTO pilot_groups(group_key,name) VALUES('numeric','Numeric');
      INSERT INTO pilot_group_members(group_id,user_id) SELECT id,1 FROM pilot_groups WHERE group_key='numeric';
      INSERT INTO feature_flag_group_rules(feature_flag_id,group_id,enabled,reason) SELECT f.id,g.id,0,'Negado' FROM feature_flags f,pilot_groups g WHERE f.flag_key=${key} AND g.group_key='numeric';`,
    `INSERT INTO pilot_groups(group_key,name) VALUES('numeric','Numeric');
      INSERT INTO feature_flag_group_rules(feature_flag_id,group_id,enabled,reason) SELECT f.id,g.id,1,'Amplo' FROM feature_flags f,pilot_groups g WHERE f.flag_key=${key} AND g.group_key='numeric';`,
    `UPDATE feature_flags SET release_id=(SELECT id FROM product_releases LIMIT 1) WHERE flag_key=${key}; UPDATE product_releases SET status='paused';`,
    "INSERT INTO feature_flag_user_rules(feature_flag_id,user_id,enabled,reason) SELECT id,2,1,'Admin aplicador indevido' FROM feature_flags WHERE flag_key='classes.numeric_assessments'",
  ];
  for(const [index,sql] of cases.entries()) await t.test(`restrição ${index+1}`,async t=>{
    const f=numericFixture(t);const db=f.open();db.exec(sql);db.close();const hash=hashFile(f.config.dbPath);
    await assert.rejects(service.prepareHomologationRelease(f.config));
    assert.equal(hashFile(f.config.dbPath),hash);
  });
});

test('mudança depois do backup ou falha de auditoria desfaz toda ativação numérica', async t=>{
  for(const auditFailure of [false,true]) {
    const f=numericFixture(t);const receipt=await service.prepareHomologationRelease(f.config);const db=f.open();
    if(auditFailure) db.exec(`CREATE TRIGGER reject_numeric_audit BEFORE INSERT ON governance_audit_log
      WHEN NEW.action='enable_homologation_numeric_user' BEGIN SELECT RAISE(ABORT,'numeric audit unavailable'); END`);
    else db.exec("UPDATE feature_flags SET kill_switch_reason='Suspensão após backup' WHERE flag_key='classes.numeric_assessments'");
    const flags=db.prepare('SELECT * FROM feature_flags ORDER BY id').all();
    assert.throws(()=>service.activateHomologationPilot(db,f.config,receipt));
    assert.deepEqual(db.prepare('SELECT * FROM feature_flags ORDER BY id').all(),flags);
    assert.equal(db.prepare('SELECT count(*) FROM governance_audit_log').pluck().get(),0);
    assert.equal(db.prepare('SELECT count(*) FROM feature_flag_user_rules').pluck().get(),0);
  }
});

test('recibo e auditoria numéricos não podem ser reutilizados para outro revisor ou contrato', async t=>{
  const f=numericFixture(t);const receipt=await service.prepareHomologationRelease(f.config);const db=f.open();
  const altered={...f.config,deploymentMetadata:{...f.config.deploymentMetadata,preparation:{...f.config.deploymentMetadata.preparation,numericReviewerHash:'c'.repeat(64)}}};
  assert.throws(()=>service.activateHomologationPilot(db,altered,receipt),/backup/);
  service.activateHomologationPilot(db,f.config,receipt);
  await assert.rejects(service.prepareHomologationRelease(altered),/Recibo/);
  const legacy={...f.config,deploymentMetadata:{...f.config.deploymentMetadata,preparation:{version:1,teacherHash:f.config.deploymentMetadata.preparation.teacherHash}}};
  await assert.rejects(service.prepareHomologationRelease(legacy),/Recibo/);
  assert.throws(()=>service.activateHomologationPilot(db,f.config,{...receipt,requestFingerprint:undefined}),/backup/);
  const audit=db.prepare("SELECT current_json FROM governance_audit_log WHERE action='activate_homologation_pilot'").get();
  assert.ok(JSON.parse(audit.current_json).requestFingerprint);
});
