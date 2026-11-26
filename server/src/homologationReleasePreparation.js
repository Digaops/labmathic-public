// Operação de release, nunca uma migração nem uma API de escrita.
// Só é solicitada por metadado técnico emitido pelo workflow protegido.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { createBackup, verifyBackup, isSameOrInside, BACKUP_NAME_PATTERN } = require('./backup');
const { inspectMigrations } = require('./migrations');
const { validPreparation } = require('./deploymentMetadata');
const { inspectNumericPilot, activateNumericPilot, numericReadiness } = require('./homologationNumericPilot');

const PILOT_FLAG = 'pedagogy.operational_cycle';
const FEEDBACK_PILOT_FLAG = 'classes.student_feedback_release';
const SANITIZER_STOP = 'Desativada automaticamente na cópia sanitizada.';
const LEGACY_FEATURES = Object.freeze([
  'classes.core', 'classes.student_import', 'classes.entry_codes', 'classes.assessment_assignments',
  'classes.assessment_delivery', 'classes.assessment_results', 'classes.student_assessment_portal',
  'classes.learning_recovery', 'question_bank.diagnostic_generator', 'planning.lesson_planner',
  'institutions.read_model', 'institutions.management_pilot', 'question_bank.typed_preview',
  'question_bank.feedback_preview', 'question_bank.catalog_preview',
]);
const ACTIVATION_ACTION = 'activate_homologation_pilot';
const teacherHash = email => crypto.createHash('sha256').update(String(email).trim().toLowerCase()).digest('hex');
const operationKey = metadata => `homologation-pilot:${metadata.sourceSha}`;
const fail = message => { const error = new Error(message); error.releaseSafe = true; throw error; };
const requestFingerprint = metadata => crypto.createHash('sha256').update(JSON.stringify([
  metadata.preparation.version, metadata.preparation.teacherHash, metadata.preparation.numericReviewerHash || null,
])).digest('hex');
const matchesRequest = (record, metadata) => record.requestFingerprint === requestFingerprint(metadata)
  || (record.requestFingerprint === undefined && metadata.preparation.version === 1);

function assertRequest(config) {
  const metadata = config.deploymentMetadata;
  if (!metadata?.preparation) return false;
  if (config.appEnvironment !== 'homologation' || metadata.targetBranch !== 'homologacao'
      || !/^[a-f0-9]{40}$/.test(metadata.sourceSha || '')
      || !validPreparation(metadata.preparation, metadata.schemaVersion)) {
    fail('Preparação de release recusada fora da homologação autorizada.');
  }
  return true;
}

function privatePaths(config) {
  const dbPath = fs.realpathSync(config.dbPath);
  const uploadDir = fs.realpathSync(config.uploadDir);
  if (fs.lstatSync(config.dbPath).isSymbolicLink() || fs.lstatSync(config.uploadDir).isSymbolicLink()) {
    fail('A preparação não aceita links simbólicos nos ativos persistentes.');
  }
  let root = path.dirname(dbPath);
  while (!isSameOrInside(uploadDir, root)) {
    const parent = path.dirname(root);
    if (parent === root) fail('Banco e uploads não possuem um diretório isolado comum.');
    root = parent;
  }
  // Se os dois ativos ficam em data/, subir apenas até o ancestral explicitamente isolado.
  while (!/(homolog|staging)/i.test(path.basename(root)) && path.dirname(root) !== root) root = path.dirname(root);
  // Nunca deduzir um cofre no home, na raiz, dentro do build ou sob o ativo.
  if (!/(homolog|staging)/i.test(path.basename(root))
      || [root, dbPath, uploadDir].some(item => /(?:^|[\\/])(?:nodejs|hbuilds|public_html|dist|node_modules)(?:[\\/]|$)/i.test(item))
      || root === uploadDir || path.dirname(root) === root
      || !fs.statSync(uploadDir).isDirectory() || !fs.statSync(dbPath).isFile()) {
    fail('Não foi possível delimitar um cofre persistente exclusivo da homologação.');
  }
  const vault = path.join(root, 'release-backups');
  if (fs.existsSync(vault) && fs.lstatSync(vault).isSymbolicLink()) fail('Cofre simbólico recusado.');
  if (!fs.existsSync(vault)) fs.mkdirSync(vault, { mode: 0o700 });
  if (!fs.statSync(vault).isDirectory()) fail('Cofre persistente inválido.');
  if (process.platform !== 'win32') fs.chmodSync(vault, 0o700);
  return { dbPath, uploadDir, vault };
}

function findTeacher(db, hash) {
  const matches = db.prepare('SELECT id, email, role FROM users').all().filter(row => teacherHash(row.email) === hash);
  if (matches.length !== 1 || matches[0].role !== 'professor') fail('A conta piloto não corresponde a um único professor existente.');
  return { id: matches[0].id, role: matches[0].role };
}

function activationRecord(db, metadata) {
  return db.prepare(`SELECT current_json FROM governance_audit_log WHERE action = ? AND entity_key = ? ORDER BY id DESC LIMIT 1`)
    .get(ACTIVATION_ACTION, operationKey(metadata));
}

function assertSanitized(db) {
  if (db.prepare('SELECT sanitized FROM homologation_snapshot_metadata WHERE id = 1').pluck().get() !== 1) {
    fail('Preparação recusada: banco sem marca de sanitização.');
  }
}

function isSanitizerStop(db, flag) {
  return flag.kill_switch_active === 1 && flag.kill_switch_reason === SANITIZER_STOP
    && flag.kill_switch_activated_by == null
    && !db.prepare("SELECT 1 FROM governance_audit_log WHERE entity_type = 'feature_flag' AND entity_id = ? LIMIT 1").get(flag.id);
}

function inspectActivation(db, metadata, { beforeMigration = false } = {}) {
  const teacher = findTeacher(db, metadata.preparation.teacherHash);
  const legacy = LEGACY_FEATURES.map(key => {
    const flag = db.prepare('SELECT * FROM feature_flags WHERE flag_key = ?').get(key);
    if (!flag) fail(`Dependência ausente: ${key}.`);
    if (flag.kill_switch_active && !isSanitizerStop(db, flag)) fail(`Bloqueio emergencial preservado: ${key}.`);
    return flag;
  });
  const flag = db.prepare(`SELECT ff.*, pr.status AS release_status FROM feature_flags ff
    LEFT JOIN product_releases pr ON pr.id = ff.release_id WHERE ff.flag_key = ?`).get(PILOT_FLAG);
  if (!flag && beforeMigration) return { teacher, legacy, flag: null };
  if (!flag || flag.kill_switch_active || ['paused', 'retired'].includes(flag.release_status)) {
    fail('O ciclo operacional está ausente ou sob bloqueio explícito.');
  }
  if (!flag.master_enabled && db.prepare(`SELECT 1 FROM governance_audit_log
      WHERE entity_type = 'feature_flag' AND entity_id = ? AND actor_id IS NOT NULL LIMIT 1`).get(flag.id)) {
    fail('A desativação administrativa do ciclo foi preservada.');
  }
  if (flag.default_enabled || flag.rollout_percentage !== 0
      || db.prepare('SELECT 1 FROM feature_flag_role_rules WHERE feature_flag_id = ? AND enabled = 1 LIMIT 1').get(flag.id)
      || db.prepare('SELECT 1 FROM feature_flag_group_rules WHERE feature_flag_id = ? AND enabled = 1 LIMIT 1').get(flag.id)
      || db.prepare('SELECT 1 FROM feature_flag_user_rules WHERE feature_flag_id = ? AND user_id != ? AND enabled = 1 LIMIT 1').get(flag.id, teacher.id)) {
    fail('O ciclo possui regras amplas; não é seguro declarar um piloto individual.');
  }
  const priorRule = db.prepare('SELECT * FROM feature_flag_user_rules WHERE feature_flag_id = ? AND user_id = ?').get(flag.id, teacher.id);
  if (priorRule?.enabled === 0) fail('O bloqueio individual existente do professor foi preservado.');
  return { teacher, legacy, flag, priorRule };
}

function inspectFeedbackPilot(db, metadata, { beforeMigration = false } = {}) {
  if (metadata.schemaVersion < 36) return null;
  const teacher = findTeacher(db, metadata.preparation.teacherHash);
  const flag = db.prepare(`SELECT ff.*, pr.status AS release_status FROM feature_flags ff
    LEFT JOIN product_releases pr ON pr.id=ff.release_id WHERE ff.flag_key=?`).get(FEEDBACK_PILOT_FLAG);
  if (!flag && beforeMigration) return null;
  if (!flag || (flag.kill_switch_active && !isSanitizerStop(db, flag))
    || ['paused', 'retired'].includes(flag.release_status)) fail('Devolutiva indisponível ou sob bloqueio explícito.');
  if (!flag.master_enabled && db.prepare(`SELECT 1 FROM governance_audit_log
    WHERE entity_type='feature_flag' AND entity_id=? AND actor_id IS NOT NULL LIMIT 1`).get(flag.id)) {
    fail('A desativação administrativa da devolutiva foi preservada.');
  }
  if (flag.default_enabled || flag.rollout_percentage !== 0
    || db.prepare('SELECT 1 FROM feature_flag_role_rules WHERE feature_flag_id=? AND enabled=1').get(flag.id)
    || db.prepare('SELECT 1 FROM feature_flag_group_rules WHERE feature_flag_id=? AND enabled=1').get(flag.id)
    || db.prepare('SELECT 1 FROM feature_flag_user_rules WHERE feature_flag_id=? AND user_id!=? AND enabled=1').get(flag.id, teacher.id)) {
    fail('A devolutiva possui regras amplas; o piloto deve ser individual.');
  }
  const priorRule = db.prepare('SELECT * FROM feature_flag_user_rules WHERE feature_flag_id=? AND user_id=?').get(flag.id, teacher.id);
  if (priorRule?.enabled === 0) fail('O bloqueio individual da devolutiva foi preservado.');
  return { teacher, flag, priorRule };
}

function writeReceipt(file, value) {
  const temporary = `${file}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify(value), { flag: 'wx', mode: 0o600 });
  fs.renameSync(temporary, file);
}

function verifyReceipt(file, vault, metadata) {
  const stats = fs.lstatSync(file);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) fail('Recibo de backup inválido.');
  const receipt = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (receipt.version !== 1 || receipt.sourceSha !== metadata.sourceSha
      || !matchesRequest(receipt, metadata)
      || receipt.teacherHash !== metadata.preparation.teacherHash || !receipt.restorationVerified
      || !BACKUP_NAME_PATTERN.test(receipt.backupName || '')) fail('Recibo não corresponde à publicação autorizada.');
  const verification = verifyBackup(path.join(vault, receipt.backupName));
  if (receipt.databaseHash !== verification.manifest.database.sha256) fail('Recibo não corresponde ao backup preservado.');
  return receipt;
}

async function prepareHomologationRelease(config) {
  if (!assertRequest(config)) return null;
  if (config.deploymentMetadata.schemaVersion >= 32) {
    // Fail before migration/activation if the approved public artifact is missing or corrupt.
    require('./services/homologationNetworkPortrait').readBundledPortrait();
  }
  const paths = privatePaths(config);
  const metadata = config.deploymentMetadata;
  const receiptPath = path.join(paths.vault, `release-${metadata.sourceSha}.json`);
  const db = new Database(paths.dbPath, { readonly: true, fileMustExist: true });
  let alreadyActivated;
  try {
    assertSanitized(db);
    const migrations = inspectMigrations(db);
    if (migrations.unknown.length || migrations.changed.length
        || Math.max(...migrations.applied.map(x => x.version), ...migrations.pending.map(x => x.version)) !== metadata.schemaVersion) {
      fail('O candidato e o histórico de migrações não correspondem.');
    }
    alreadyActivated = activationRecord(db, metadata);
    if (!alreadyActivated) {
      inspectActivation(db, metadata, { beforeMigration: migrations.pending.some(x => x.version === 26) });
      inspectFeedbackPilot(db, metadata, { beforeMigration: migrations.pending.some(x => x.version === 36) });
      // Numerical pilot is opt-in and requires its already installed schema, never activation by migration.
      inspectNumericPilot(db, metadata, isSanitizerStop);
    }
  } finally { db.close(); }
  if (alreadyActivated) {
    const receipt = verifyReceipt(receiptPath, paths.vault, metadata);
    const activation = JSON.parse(alreadyActivated.current_json);
    if (activation.backupName !== receipt.backupName || activation.sourceSha !== metadata.sourceSha
        || !matchesRequest(activation, metadata)) {
      fail('Recibo e auditoria de ativação não correspondem; revisão operacional necessária.');
    }
    return { ...receipt, backupVerified: true, reused: true };
  }

  // O helper existente valida SQLite, inventário estável e hashes de todos os arquivos.
  const backup = await createBackup({ ...paths, backupRoot: paths.vault });
  const restoreRoot = fs.mkdtempSync(path.join(paths.vault, '.restore-pilot-'));
  try {
    if (typeof fs.statfsSync === 'function') {
      const disk = fs.statfsSync(paths.vault);
      const needed = backup.manifest.database.bytes + backup.manifest.uploads.bytes + 64 * 1024 * 1024;
      if (BigInt(disk.bavail) * BigInt(disk.bsize) < BigInt(needed)) fail('Espaço insuficiente para ensaiar a restauração.');
    }
    const restoredDirectory = path.join(restoreRoot, backup.backupName);
    fs.cpSync(backup.backupDirectory, restoredDirectory, { recursive: true, errorOnExist: true, force: false });
    verifyBackup(restoredDirectory);
    const receipt = {
      version: 1, sourceSha: metadata.sourceSha, teacherHash: metadata.preparation.teacherHash,
      requestFingerprint: requestFingerprint(metadata),
      backupName: backup.backupName, databaseHash: backup.manifest.database.sha256,
      restorationVerified: true, completedAt: new Date().toISOString(),
    };
    writeReceipt(receiptPath, receipt);
    return { ...receipt, backupVerified: true, reused: false };
  } finally {
    // Somente a cópia temporária criada nesta execução; o backup original permanece.
    if (path.dirname(restoreRoot) !== paths.vault || !path.basename(restoreRoot).startsWith('.restore-pilot-')) {
      fail('Destino temporário inesperado; remoção recusada.');
    }
    fs.rmSync(restoreRoot, { recursive: true, force: true });
  }
}

function audit(db, { action, type, id, key, previous, current }, metadata) {
  db.prepare(`INSERT INTO governance_audit_log
    (actor_id, action, entity_type, entity_id, entity_key, reason, previous_json, current_json, user_agent)
    VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, 'protected-homologation-workflow/v1')`).run(
    action, type, id, key, `Publicação autorizada de homologação, PR #${metadata.pullRequest}, SHA ${metadata.sourceSha}.`,
    previous ? JSON.stringify(previous) : null, JSON.stringify(current),
  );
}

function activateHomologationPilot(db, config, receipt) {
  if (!assertRequest(config)) return null;
  const metadata = config.deploymentMetadata;
  if (!receipt?.backupVerified || !receipt.restorationVerified || receipt.sourceSha !== metadata.sourceSha
      || receipt.teacherHash !== metadata.preparation.teacherHash || !matchesRequest(receipt, metadata)) fail('Ativação exige backup e restauração verificados desta publicação.');
  return db.transaction(() => {
    assertSanitized(db);
    const previousActivation = activationRecord(db, metadata);
    if (previousActivation) {
      if (!matchesRequest(JSON.parse(previousActivation.current_json), metadata)) fail('A autorização desta revisão mudou; nova publicação necessária.');
      return { reused: true }; // Reiniciar nunca desfaz um kill switch posterior.
    }
    const { teacher, legacy, flag, priorRule } = inspectActivation(db, metadata);
    const feedbackPilot = inspectFeedbackPilot(db, metadata);
    const numericPilot = inspectNumericPilot(db, metadata, isSanitizerStop);
    for (const prior of legacy.filter(row => row.kill_switch_active)) {
      db.prepare(`UPDATE feature_flags SET kill_switch_active = 0, kill_switch_reason = NULL,
        kill_switch_activated_by = NULL, kill_switch_activated_at = NULL, revision = revision + 1,
        updated_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(prior.id);
      audit(db, { action: 'resume_sanitized_homologation_feature', type: 'feature_flag', id: prior.id,
        key: prior.flag_key, previous: prior, current: db.prepare('SELECT * FROM feature_flags WHERE id = ?').get(prior.id) }, metadata);
    }
    db.prepare(`UPDATE feature_flags SET master_enabled = 1, revision = revision + 1,
      updated_by = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(flag.id);
    audit(db, { action: 'enable_homologation_pilot_master', type: 'feature_flag', id: flag.id,
      key: PILOT_FLAG, previous: flag, current: db.prepare('SELECT * FROM feature_flags WHERE id = ?').get(flag.id) }, metadata);
    if (!priorRule) {
      const result = db.prepare(`INSERT INTO feature_flag_user_rules (feature_flag_id, user_id, enabled, reason)
        VALUES (?, ?, 1, ?)`).run(flag.id, teacher.id, 'Piloto individual autorizado na publicação de homologação.');
      audit(db, { action: 'enable_homologation_pilot_user', type: 'feature_flag_rule', id: Number(result.lastInsertRowid),
        key: PILOT_FLAG, current: { featureFlagId: flag.id, userId: teacher.id, enabled: true } }, metadata);
    }
    if (feedbackPilot) {
      const prior = feedbackPilot.flag;
      db.prepare(`UPDATE feature_flags SET master_enabled=1, kill_switch_active=0,
        kill_switch_reason=NULL, kill_switch_activated_by=NULL, kill_switch_activated_at=NULL,
        revision=revision+1, updated_by=NULL, updated_at=CURRENT_TIMESTAMP WHERE id=?`).run(prior.id);
      audit(db, { action: 'enable_homologation_feedback_master', type: 'feature_flag', id: prior.id,
        key: FEEDBACK_PILOT_FLAG, previous: prior, current: db.prepare('SELECT * FROM feature_flags WHERE id=?').get(prior.id) }, metadata);
      if (!feedbackPilot.priorRule) {
        const rule = db.prepare(`INSERT INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason)
          VALUES (?,?,1,'Piloto individual da devolutiva autorizado na publicação de homologação.')`).run(prior.id, teacher.id);
        audit(db, { action: 'enable_homologation_feedback_user', type: 'feature_flag_rule', id: Number(rule.lastInsertRowid),
          key: FEEDBACK_PILOT_FLAG, current: { featureFlagId: prior.id, userId: teacher.id, enabled: true } }, metadata);
      }
    }
    activateNumericPilot(db, numericPilot, metadata, audit);
    if (numericPilot) {
      const ready = numericReadiness(db, metadata);
      if (![ready.authoringEnabled, ready.reviewEnabled, ready.assessmentsEnabled, ready.dependenciesReady, ready.exclusive].every(Boolean)) {
        fail('O acesso numérico efetivo não corresponde ao piloto autorizado.');
      }
    }
    audit(db, { action: ACTIVATION_ACTION, type: 'feature_flag', id: flag.id, key: operationKey(metadata),
      current: { teacherId: teacher.id, sourceSha: metadata.sourceSha, backupName: receipt.backupName,
        requestFingerprint: requestFingerprint(metadata),
        restorationVerified: true, scope: 'individual' } }, metadata);
    return { reused: false };
  }).immediate();
}

function getReleaseReadiness(db, config, receipt) {
  if (!assertRequest(config)) return null;
  const { evaluateFeatureFlag } = require('./services/featureFlags');
  let teacher;
  try { teacher = findTeacher(db, config.deploymentMetadata.preparation.teacherHash); } catch { teacher = null; }
  const operationalCycleEnabled = Boolean(teacher && evaluateFeatureFlag(db, PILOT_FLAG, teacher).enabled);
  const dependenciesReady = Boolean(teacher && LEGACY_FEATURES.every(key => evaluateFeatureFlag(db, key, teacher).enabled));
  const flag = db.prepare('SELECT * FROM feature_flags WHERE flag_key = ?').get(PILOT_FLAG);
  const exclusive = Boolean(teacher && flag && !flag.default_enabled && flag.rollout_percentage === 0
    && !db.prepare('SELECT 1 FROM feature_flag_user_rules WHERE feature_flag_id = ? AND user_id != ? AND enabled = 1').get(flag.id, teacher.id)
    && !db.prepare('SELECT 1 FROM feature_flag_group_rules WHERE feature_flag_id = ? AND enabled = 1').get(flag.id)
    && !db.prepare('SELECT 1 FROM feature_flag_role_rules WHERE feature_flag_id = ? AND enabled = 1').get(flag.id));
  return {
    revision: config.deploymentMetadata.sourceSha,
    backup: { verified: receipt?.backupVerified === true, restorationVerified: receipt?.restorationVerified === true,
      completedAt: receipt?.completedAt || null },
    pilot: { accountFound: Boolean(teacher), operationalCycleEnabled, dependenciesReady, exclusive, scope: 'individual' },
    ...(config.deploymentMetadata.schemaVersion >= 36 ? { studentFeedback: {
      enabled: Boolean(teacher && evaluateFeatureFlag(db, FEEDBACK_PILOT_FLAG, teacher).enabled),
      scope: 'individual',
    } } : {}),
    auditRecorded: Boolean(activationRecord(db, config.deploymentMetadata)),
    ...(config.deploymentMetadata.preparation.version === 2
      ? { numericPilot: numericReadiness(db, config.deploymentMetadata) } : {}),
  };
}

module.exports = { prepareHomologationRelease, activateHomologationPilot, getReleaseReadiness,
  teacherHash, inspectActivation, LEGACY_FEATURES, SANITIZER_STOP, PILOT_FLAG };
