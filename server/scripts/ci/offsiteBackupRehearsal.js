const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { verifyBackup } = require('../../src/backup');
const { runOffsiteBackup } = require('../backup/offsiteBackup');
const { runOffsiteMaintenance } = require('../backup/offsiteMaintenance');
const {
  BACKUP_TAG,
  runRestic,
  validateOffsiteConfig,
} = require('../backup/offsiteCommon');

const CONFIRMATION = 'RUN_SYNTHETIC_OFFSITE_REHEARSAL';
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');
const REPOSITORY_ROOT = path.resolve(__dirname, '../../..');

function resolveReportPath(reportPath) {
  const resolved = path.resolve(REPOSITORY_ROOT, reportPath);
  if (!resolved.startsWith(`${REPOSITORY_ROOT}${path.sep}`)) {
    throw new Error('O relatorio do ensaio deve permanecer dentro do workspace.');
  }
  return resolved;
}

function assertLoopbackEndpoint(rawEndpoint) {
  const endpoint = new URL(rawEndpoint);
  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '[::1]']);
  if (endpoint.protocol !== 'http:' || !loopbackHosts.has(endpoint.hostname)) {
    throw new Error('O ensaio aceita somente endpoint HTTP loopback descartavel.');
  }
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/') {
    throw new Error('Endpoint do ensaio nao pode conter credenciais, caminho, consulta ou fragmento.');
  }
  return endpoint;
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function awsV4Headers({ method, url, accessKeyId, secretAccessKey, region = 'us-east-1' }) {
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);
  const canonicalUri = url.pathname.split('/').map((part) => encodeURIComponent(part)).join('/');
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${EMPTY_SHA256}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [
    method,
    canonicalUri,
    '',
    canonicalHeaders,
    signedHeaders,
    EMPTY_SHA256,
  ].join('\n');
  const credentialScope = `${dateStamp}/${region}/s3/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    crypto.createHash('sha256').update(canonicalRequest).digest('hex'),
  ].join('\n');
  const dateKey = hmac(`AWS4${secretAccessKey}`, dateStamp);
  const regionKey = hmac(dateKey, region);
  const serviceKey = hmac(regionKey, 's3');
  const signingKey = hmac(serviceKey, 'aws4_request');
  const signature = hmac(signingKey, stringToSign, 'hex');

  return {
    host: url.host,
    'x-amz-content-sha256': EMPTY_SHA256,
    'x-amz-date': amzDate,
    authorization: `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

function createBucket({ endpoint, bucket, accessKeyId, secretAccessKey }) {
  const bucketUrl = new URL(`/${bucket}`, endpoint);
  const headers = awsV4Headers({
    method: 'PUT',
    url: bucketUrl,
    accessKeyId,
    secretAccessKey,
  });

  return new Promise((resolve, reject) => {
    const request = http.request(bucketUrl, { method: 'PUT', headers }, (response) => {
      response.resume();
      response.on('end', () => {
        if ([200, 204, 409].includes(response.statusCode)) {
          resolve();
          return;
        }
        reject(new Error(`Emulador S3 recusou a criacao do bucket (HTTP ${response.statusCode}).`));
      });
    });
    request.setTimeout(5000, () => request.destroy(new Error('Timeout ao acessar o emulador S3 local.')));
    request.on('error', reject);
    request.end();
  });
}

function createSyntheticFixture(root) {
  const dataDirectory = path.join(root, 'synthetic-data');
  const uploadDirectory = path.join(root, 'synthetic-uploads');
  const backupRoot = path.join(root, 'backup-vault');
  fs.mkdirSync(dataDirectory, { recursive: true });
  fs.mkdirSync(path.join(uploadDirectory, 'materiais'), { recursive: true });
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(backupRoot, 0o700);

  const dbPath = path.join(dataDirectory, 'database.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE teachers (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE);
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id),
      statement TEXT NOT NULL
    );
    INSERT INTO teachers (id, email) VALUES (1, 'synthetic-professor@example.invalid');
    INSERT INTO questions (teacher_id, statement)
      VALUES (1, 'SYNTHETIC-FIRST-SNAPSHOT-7d4720d8');
  `);
  database.close();

  fs.writeFileSync(
    path.join(uploadDirectory, 'materiais', 'atividade.txt'),
    'SYNTHETIC-UPLOAD-FIRST-4a82a733\n'
  );
  fs.writeFileSync(
    path.join(uploadDirectory, 'capa.bin'),
    crypto.createHash('sha256').update('synthetic-binary').digest()
  );

  return { dbPath, uploadDirectory, backupRoot };
}

function advanceSyntheticFixture(fixture) {
  const database = new Database(fixture.dbPath);
  database.prepare('INSERT INTO questions (teacher_id, statement) VALUES (?, ?)')
    .run(1, 'SYNTHETIC-SECOND-SNAPSHOT-baf74d21');
  database.close();
  fs.appendFileSync(
    path.join(fixture.uploadDirectory, 'materiais', 'atividade.txt'),
    'SYNTHETIC-UPLOAD-SECOND-d0c07e80\n'
  );
}

function snapshotList(config) {
  const output = runRestic(config, [
    'snapshots',
    '--json',
    '--tag', BACKUP_TAG,
    '--host', config.host,
  ]);
  const snapshots = JSON.parse(output);
  if (!Array.isArray(snapshots)) throw new Error('Lista de snapshots externos invalida.');
  return snapshots;
}

function restoreAndInspect(config, backupName, snapshotId, root) {
  const target = path.join(root, 'restores', backupName);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  runRestic(config, ['restore', snapshotId, '--target', target]);
  const verification = verifyBackup(target);
  const restoredDatabasePath = path.join(target, verification.manifest.contents.database);
  const database = new Database(restoredDatabasePath, { readonly: true, fileMustExist: true });

  try {
    return {
      questionCount: database.prepare('SELECT COUNT(*) AS count FROM questions').get().count,
      uploads: verification.uploads,
      integrity: verification.databaseVerification.sqlite_integrity_check,
    };
  } finally {
    database.close();
  }
}

function removeRehearsalRoot(root) {
  const resolvedRoot = path.resolve(root);
  const expectedParent = path.resolve(os.tmpdir());
  if (path.dirname(resolvedRoot) !== expectedParent || !path.basename(resolvedRoot).startsWith('labmathic-offsite-e2e-')) {
    throw new Error('Recusa ao remover diretorio fora do ensaio descartavel.');
  }
  fs.rmSync(resolvedRoot, { recursive: true, force: true });
}

async function runOffsiteBackupRehearsal({ env = process.env } = {}) {
  if (env.BACKUP_E2E_CONFIRM !== CONFIRMATION) {
    throw new Error(`Defina BACKUP_E2E_CONFIRM=${CONFIRMATION} para executar o ensaio.`);
  }
  if (!env.RESTIC_BIN || !env.RESTIC_BIN_SHA256) {
    throw new Error('RESTIC_BIN e RESTIC_BIN_SHA256 sao obrigatorios no ensaio.');
  }

  const endpoint = assertLoopbackEndpoint(env.BACKUP_E2E_ENDPOINT || 'http://127.0.0.1:5000');
  const reportPath = resolveReportPath(
    env.BACKUP_E2E_REPORT_PATH || '.ci-artifacts/offsite-backup-rehearsal.json'
  );
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-offsite-e2e-'));
  const bucket = `labmathic-e2e-${crypto.randomBytes(6).toString('hex')}`;
  const accessKeyId = 'synthetic-access-key';
  const secretAccessKey = crypto.randomBytes(32).toString('hex');
  const passwordFile = path.join(root, 'restic-password');
  const wrongPasswordFile = path.join(root, 'wrong-restic-password');
  let report;

  try {
    const fixture = createSyntheticFixture(root);
    fs.writeFileSync(passwordFile, `${crypto.randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
    fs.writeFileSync(wrongPasswordFile, `${crypto.randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
    if (process.platform !== 'win32') {
      fs.chmodSync(passwordFile, 0o600);
      fs.chmodSync(wrongPasswordFile, 0o600);
    }

    await createBucket({ endpoint, bucket, accessKeyId, secretAccessKey });

    const rehearsalEnv = {
      ...env,
      NODE_ENV: 'test',
      OFFSITE_ALLOW_LOOPBACK_HTTP: 'true',
      BACKUP_DIR: fixture.backupRoot,
      RESTIC_REPOSITORY: `s3:${endpoint.origin}/${bucket}/repository`,
      RESTIC_PASSWORD_FILE: passwordFile,
      AWS_ACCESS_KEY_ID: accessKeyId,
      AWS_SECRET_ACCESS_KEY: secretAccessKey,
      AWS_DEFAULT_REGION: 'us-east-1',
      OFFSITE_BACKUP_HOST: 'labmathic-synthetic-ci',
      OFFSITE_CHECK_PERCENT: '100',
      LOCAL_BACKUP_KEEP: '2',
      SMTP_HOST: 'smtp.example.invalid',
      SMTP_PORT: '587',
      SMTP_USER: 'synthetic-alert@example.invalid',
      SMTP_PASS: 'synthetic-not-used',
      SMTP_FROM: 'synthetic-alert@example.invalid',
      BACKUP_ALERT_EMAIL: 'synthetic-admin@example.invalid',
      BACKUP_NOTIFY_SUCCESS: 'false',
    };
    const appConfig = {
      dbPath: fixture.dbPath,
      uploadDir: fixture.uploadDirectory,
      appEnvironment: 'test',
    };
    const offsiteConfig = validateOffsiteConfig(rehearsalEnv);
    const resticVersion = runRestic(offsiteConfig, ['version']).trim();
    if (!/^restic 0\.19\.1\b/.test(resticVersion)) {
      throw new Error('O ensaio exige exatamente o Restic 0.19.1 aprovado.');
    }
    runRestic(offsiteConfig, ['init']);

    const first = await runOffsiteBackup({
      appConfig,
      env: rehearsalEnv,
      sendAlertFn: async () => {},
    });
    advanceSyntheticFixture(fixture);
    const second = await runOffsiteBackup({
      appConfig,
      env: rehearsalEnv,
      sendAlertFn: async () => {},
    });

    const snapshots = snapshotList(offsiteConfig);
    if (snapshots.length !== 2) throw new Error('O repositorio deveria conter exatamente dois snapshots.');

    const firstRestore = restoreAndInspect(
      offsiteConfig,
      first.backupName,
      first.snapshotId,
      root
    );
    const secondRestore = restoreAndInspect(
      offsiteConfig,
      second.backupName,
      second.snapshotId,
      root
    );
    if (firstRestore.questionCount !== 1 || secondRestore.questionCount !== 2) {
      throw new Error('Os dois pontos no tempo nao foram restaurados corretamente.');
    }

    runRestic(offsiteConfig, ['check', '--read-data']);

    let wrongPasswordRejected = false;
    try {
      runRestic({ ...offsiteConfig, passwordFile: wrongPasswordFile }, ['snapshots', '--json']);
    } catch {
      wrongPasswordRejected = true;
    }
    if (!wrongPasswordRejected) throw new Error('O repositorio aceitou uma senha de criptografia incorreta.');

    const maintenance = await runOffsiteMaintenance({
      appEnvironment: 'test',
      env: { ...rehearsalEnv, OFFSITE_RETENTION_CONFIRM: 'APPLY_RETENTION' },
      sendAlertFn: async () => {},
    });
    const snapshotsAfterRetention = snapshotList(offsiteConfig);
    if (!maintenance.applied || snapshotsAfterRetention.length !== 2) {
      throw new Error('A manutencao de retencao descartavel nao preservou os snapshots esperados.');
    }

    report = {
      status: 'passed',
      completedAt: new Date().toISOString(),
      resticVersion,
      s3Emulator: 'Moto 5.2.2',
      snapshotsCreated: snapshots.length,
      snapshotsAfterRetention: snapshotsAfterRetention.length,
      restores: {
        first: firstRestore,
        second: secondRestore,
      },
      externalRepositoryCheck: 'ok-read-all-data',
      wrongPasswordRejected,
      retentionApplied: maintenance.applied,
      safety: {
        syntheticSourcesOnly: true,
        loopbackS3Only: true,
        productionAccessed: false,
        productionDatabaseTouched: false,
        externalSecretsRequired: false,
      },
    };

    fs.mkdirSync(path.dirname(reportPath), { recursive: true });
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
    return report;
  } finally {
    removeRehearsalRoot(root);
  }
}

if (require.main === module) {
  runOffsiteBackupRehearsal()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`Ensaio externo recusado: ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONFIRMATION,
  assertLoopbackEndpoint,
  awsV4Headers,
  createBucket,
  resolveReportPath,
  runOffsiteBackupRehearsal,
};
