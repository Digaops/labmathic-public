const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { runOffsiteBackup } = require('../scripts/backup/offsiteBackup');
const { runOffsiteMaintenance } = require('../scripts/backup/offsiteMaintenance');
const { validateOffsiteConfig } = require('../scripts/backup/offsiteCommon');
const { readAlertConfig } = require('../scripts/backup/backupAlert');
const { hashFile } = require('../src/backup');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-offsite-'));
  const dataDirectory = path.join(root, 'data');
  const uploadDirectory = path.join(root, 'uploads');
  const backupRoot = path.join(root, 'vault');
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(uploadDirectory);
  fs.mkdirSync(backupRoot, { mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(backupRoot, 0o700);
  fs.writeFileSync(path.join(uploadDirectory, 'material.txt'), 'teste');

  const dbPath = path.join(dataDirectory, 'database.sqlite');
  const database = new Database(dbPath);
  database.exec('CREATE TABLE sample (id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample (value) VALUES (\'ok\');');
  database.close();

  const resticBin = path.join(root, process.platform === 'win32' ? 'restic.exe' : 'restic');
  const passwordFile = path.join(root, 'restic-password');
  fs.writeFileSync(resticBin, 'fake');
  fs.writeFileSync(passwordFile, 'uma-senha-forte-de-teste\n', { mode: 0o600 });
  if (process.platform !== 'win32') {
    fs.chmodSync(resticBin, 0o700);
    fs.chmodSync(passwordFile, 0o600);
  }

  const env = {
    BACKUP_DIR: backupRoot,
    RESTIC_BIN: resticBin,
    RESTIC_BIN_SHA256: hashFile(resticBin),
    RESTIC_REPOSITORY: 's3:https://s3.example.test/labmathic-backups',
    RESTIC_PASSWORD_FILE: passwordFile,
    AWS_ACCESS_KEY_ID: 'backup-only-key',
    AWS_SECRET_ACCESS_KEY: 'backup-only-secret',
    OFFSITE_CHECK_PERCENT: '10',
    LOCAL_BACKUP_KEEP: '2',
    SMTP_HOST: 'smtp.example.test',
    SMTP_PORT: '587',
    SMTP_USER: 'alerts@example.test',
    SMTP_PASS: 'smtp-secret',
    SMTP_FROM: 'alerts@example.test',
    BACKUP_ALERT_EMAIL: 'admin@example.test',
  };

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    dbPath,
    uploadDirectory,
    backupRoot,
    env,
    appConfig: { dbPath, uploadDir: uploadDirectory, appEnvironment: 'production' },
  };
}

test('valida configuracao externa sem aceitar senha direta ou TLS inseguro', (t) => {
  const fixture = createFixture(t);
  assert.equal(validateOffsiteConfig(fixture.env).host, 'labmathic-production');

  assert.throws(
    () => validateOffsiteConfig({ ...fixture.env, RESTIC_PASSWORD: 'nao-aceito' }),
    /RESTIC_PASSWORD_FILE/
  );
  assert.throws(
    () => validateOffsiteConfig({ ...fixture.env, RESTIC_INSECURE_TLS: 'true' }),
    /nao pode ser habilitado/
  );
  assert.throws(
    () => validateOffsiteConfig({
      ...fixture.env,
      RESTIC_REPOSITORY: 's3:http://storage.example.test/backups',
    }),
    /deve usar HTTPS/
  );
  assert.doesNotThrow(() => validateOffsiteConfig({
    ...fixture.env,
    NODE_ENV: 'test',
    OFFSITE_ALLOW_LOOPBACK_HTTP: 'true',
    RESTIC_REPOSITORY: 's3:http://127.0.0.1:5000/backups',
  }));
  assert.throws(
    () => validateOffsiteConfig({ ...fixture.env, OFFSITE_CHECK_PERCENT: '10junk' }),
    /OFFSITE_CHECK_PERCENT/
  );
  assert.throws(
    () => readAlertConfig({ ...fixture.env, SMTP_PORT: '587junk' }),
    /SMTP_PORT invalido/
  );
});

test('executa backup externo, verificacao de dados e gera recibo local', async (t) => {
  const fixture = createFixture(t);
  const calls = [];
  const snapshotId = 'a'.repeat(64);

  const result = await runOffsiteBackup({
    appConfig: fixture.appConfig,
    env: fixture.env,
    runResticFn(config, args, options) {
      calls.push({ args, cwd: options?.cwd || config.backupRoot });
      if (args[0] === 'backup') return `${JSON.stringify({ message_type: 'summary', snapshot_id: snapshotId })}\n`;
      return '[]';
    },
    sendAlertFn: async () => assert.fail('Nao deveria alertar sucesso sem opt-in.'),
  });

  assert.equal(result.status, 'success');
  assert.equal(result.snapshotId, snapshotId);
  assert.equal(calls[0].args[0], 'snapshots');
  assert.equal(calls[1].args[0], 'backup');
  assert.equal(calls[2].args[0], 'check');
  assert.equal(calls[2].args.includes('--read-data-subset=10%'), true);
  assert.equal(
    fs.existsSync(path.join(fixture.backupRoot, '.offsite-receipts', `${result.backupName}.json`)),
    true
  );
  assert.equal(fs.existsSync(path.join(fixture.backupRoot, '.offsite-operation.lock')), false);
});

test('falha fechada, envia um alerta e libera a trava', async (t) => {
  const fixture = createFixture(t);
  const alerts = [];

  await assert.rejects(
    runOffsiteBackup({
      appConfig: fixture.appConfig,
      env: fixture.env,
      runResticFn() {
        throw new Error('repositorio indisponivel');
      },
      sendAlertFn: async (alert) => alerts.push(alert),
    }),
    /repositorio indisponivel/
  );

  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].status, 'failure');
  assert.equal(fs.existsSync(path.join(fixture.backupRoot, '.offsite-operation.lock')), false);
  assert.equal(
    fs.readdirSync(fixture.backupRoot).some((name) => name.startsWith('backup-')),
    false
  );
});

test('manutencao ensaia retencao por padrao e exige confirmacao para apagar', async (t) => {
  const fixture = createFixture(t);
  const dryRunCalls = [];
  const dryRun = await runOffsiteMaintenance({
    env: fixture.env,
    runResticFn(config, args) {
      dryRunCalls.push(args);
      return '';
    },
    sendAlertFn: async () => {},
  });
  assert.equal(dryRun.applied, false);
  assert.equal(dryRunCalls[1].includes('--dry-run'), true);
  assert.equal(dryRunCalls[1].includes('--prune'), false);

  const applyCalls = [];
  const applied = await runOffsiteMaintenance({
    env: { ...fixture.env, OFFSITE_RETENTION_CONFIRM: 'APPLY_RETENTION' },
    runResticFn(config, args) {
      applyCalls.push(args);
      return '';
    },
    sendAlertFn: async () => {},
  });
  assert.equal(applied.applied, true);
  assert.equal(applyCalls[1].includes('--prune'), true);
  assert.equal(applyCalls.filter((args) => args[0] === 'check').length, 2);
});
