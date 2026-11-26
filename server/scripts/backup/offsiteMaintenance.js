const crypto = require('node:crypto');
const { readAlertConfig, sendBackupAlert } = require('./backupAlert');
const {
  BACKUP_TAG,
  acquireLock,
  runRestic,
  validateOffsiteConfig,
} = require('./offsiteCommon');

async function runOffsiteMaintenance({
  appEnvironment = 'production',
  env = process.env,
  runResticFn = runRestic,
  sendAlertFn = sendBackupAlert,
} = {}) {
  const runId = `maintenance-${new Date().toISOString()}-${crypto.randomBytes(3).toString('hex')}`;
  let releaseLock;

  try {
    readAlertConfig(env);
    const config = validateOffsiteConfig(env);
    releaseLock = acquireLock(config.backupRoot, '.offsite-operation.lock');

    runResticFn(config, ['check']);

    const apply = env.OFFSITE_RETENTION_CONFIRM === 'APPLY_RETENTION';
    const retentionArguments = [
      'forget',
      '--host', config.host,
      '--tag', BACKUP_TAG,
      '--group-by', 'host,tags',
      '--keep-within-daily', '7d',
      '--keep-within-weekly', '1m',
      '--keep-within-monthly', '1y',
      ...(apply ? ['--prune'] : ['--dry-run']),
    ];
    runResticFn(config, retentionArguments);

    if (apply) runResticFn(config, ['check']);

    if (String(env.BACKUP_NOTIFY_SUCCESS || '').toLowerCase() === 'true') {
      await sendAlertFn({ status: 'success', runId, environment: appEnvironment, env });
    }

    return { status: 'success', runId, applied: apply };
  } catch (error) {
    try {
      await sendAlertFn({
        status: 'failure',
        runId,
        environment: appEnvironment,
        error,
        env,
      });
    } catch (alertError) {
      console.error(`Falha adicional ao enviar alerta de manutencao: ${alertError.message}`);
    }
    throw error;
  } finally {
    if (releaseLock) releaseLock();
  }
}

async function main() {
  const config = require('../../src/config');
  const result = await runOffsiteMaintenance({ appEnvironment: config.appEnvironment });
  console.log(result.applied
    ? 'Retencao externa aplicada e repositorio verificado.'
    : 'Ensaio de retencao concluido sem remover snapshots.');
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Manutencao externa encerrada com falha: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = { runOffsiteMaintenance };
