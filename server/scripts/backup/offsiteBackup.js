const crypto = require('node:crypto');
const { createBackup } = require('../../src/backup');
const { readAlertConfig, sendBackupAlert } = require('./backupAlert');
const {
  BACKUP_TAG,
  acquireLock,
  parseSnapshotId,
  pruneVerifiedLocalBackups,
  runRestic,
  validateOffsiteConfig,
  writeOffsiteReceipt,
} = require('./offsiteCommon');

async function runOffsiteBackup({
  appConfig,
  env = process.env,
  createBackupFn = createBackup,
  runResticFn = runRestic,
  sendAlertFn = sendBackupAlert,
} = {}) {
  const runId = `offsite-${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
  let releaseLock;
  let backupResult;

  try {
    readAlertConfig(env);
    const offsiteConfig = validateOffsiteConfig(env);
    releaseLock = acquireLock(offsiteConfig.backupRoot, '.offsite-operation.lock');

    runResticFn(offsiteConfig, ['snapshots', '--json', '--tag', BACKUP_TAG, '--host', offsiteConfig.host]);

    backupResult = await createBackupFn({
      dbPath: appConfig.dbPath,
      uploadDir: appConfig.uploadDir,
      backupRoot: offsiteConfig.backupRoot,
    });

    const backupOutput = runResticFn(offsiteConfig, [
      'backup',
      '.',
      '--host', offsiteConfig.host,
      '--tag', BACKUP_TAG,
      '--tag', 'automated',
      '--group-by', 'host,tags',
      '--json',
    ], { cwd: backupResult.backupDirectory });
    const snapshotId = parseSnapshotId(backupOutput);

    runResticFn(offsiteConfig, [
      'check',
      `--read-data-subset=${offsiteConfig.dataCheckPercent}%`,
    ]);

    writeOffsiteReceipt(offsiteConfig, backupResult, snapshotId);
    const removedLocalBackups = pruneVerifiedLocalBackups(offsiteConfig);

    if (String(env.BACKUP_NOTIFY_SUCCESS || '').toLowerCase() === 'true') {
      await sendAlertFn({
        status: 'success',
        runId,
        backupName: backupResult.backupName,
        environment: appConfig.appEnvironment,
        env,
      });
    }

    return {
      status: 'success',
      runId,
      backupName: backupResult.backupName,
      snapshotId,
      removedLocalBackups,
    };
  } catch (error) {
    try {
      await sendAlertFn({
        status: 'failure',
        runId,
        backupName: backupResult?.backupName,
        environment: appConfig?.appEnvironment || 'production',
        error,
        env,
      });
    } catch (alertError) {
      console.error(`Falha adicional ao enviar alerta de backup: ${alertError.message}`);
    }
    throw error;
  } finally {
    if (releaseLock) releaseLock();
  }
}

async function main() {
  const appConfig = require('../../src/config');
  const result = await runOffsiteBackup({ appConfig });
  console.log(`Backup externo verificado: ${result.backupName}`);
  console.log(`Snapshot externo: ${result.snapshotId.slice(0, 12)}`);
  console.log(`Backups locais removidos pela retencao: ${result.removedLocalBackups.length}`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Rotina externa encerrada com falha: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runOffsiteBackup };
