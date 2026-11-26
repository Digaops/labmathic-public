const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { hashFile, verifyBackup, BACKUP_NAME_PATTERN } = require('../../src/backup');

const BACKUP_TAG = 'labmathic-production';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

function parseInteger(value, fallback, { min, max, name }) {
  const normalized = String(value ?? fallback);
  const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN;
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${name} deve estar entre ${min} e ${max}.`);
  }
  return parsed;
}

function validateOffsiteConfig(env = process.env) {
  if (!env.BACKUP_DIR || !path.isAbsolute(env.BACKUP_DIR)) {
    throw new Error('BACKUP_DIR absoluto e obrigatorio para o backup externo.');
  }
  if (!env.RESTIC_BIN || !path.isAbsolute(env.RESTIC_BIN)) {
    throw new Error('RESTIC_BIN deve apontar para um executavel absoluto e fixado.');
  }
  if (!fs.existsSync(env.RESTIC_BIN) || !fs.lstatSync(env.RESTIC_BIN).isFile()) {
    throw new Error('RESTIC_BIN nao existe ou nao e um arquivo regular.');
  }
  if (fs.lstatSync(env.RESTIC_BIN).isSymbolicLink()) {
    throw new Error('RESTIC_BIN nao pode ser um link simbolico.');
  }
  if (process.platform !== 'win32') {
    fs.accessSync(env.RESTIC_BIN, fs.constants.X_OK);
  }
  if (!/^[0-9a-f]{64}$/.test(env.RESTIC_BIN_SHA256 || '')) {
    throw new Error('RESTIC_BIN_SHA256 e obrigatorio e deve conter SHA-256 valido.');
  }
  if (hashFile(env.RESTIC_BIN) !== env.RESTIC_BIN_SHA256) {
    throw new Error('O executavel Restic nao corresponde ao SHA-256 aprovado.');
  }

  if (!env.RESTIC_REPOSITORY || !env.RESTIC_REPOSITORY.startsWith('s3:')) {
    throw new Error('RESTIC_REPOSITORY deve usar um armazenamento S3 compativel.');
  }
  let repositoryUrl;
  try {
    repositoryUrl = new URL(env.RESTIC_REPOSITORY.slice(3));
  } catch {
    throw new Error('RESTIC_REPOSITORY deve usar o formato s3:https://endpoint/bucket/prefixo.');
  }
  if (
    repositoryUrl.username
    || repositoryUrl.password
    || repositoryUrl.search
    || repositoryUrl.hash
    || /\s/.test(env.RESTIC_REPOSITORY)
  ) {
    throw new Error('RESTIC_REPOSITORY nao pode conter credenciais, espacos, consulta ou fragmento.');
  }
  const explicitLoopbackTest = (
    env.NODE_ENV === 'test'
    && env.OFFSITE_ALLOW_LOOPBACK_HTTP === 'true'
    && repositoryUrl.protocol === 'http:'
    && LOOPBACK_HOSTS.has(repositoryUrl.hostname)
  );
  if (repositoryUrl.protocol !== 'https:' && !explicitLoopbackTest) {
    throw new Error('RESTIC_REPOSITORY deve usar HTTPS; HTTP e permitido somente no ensaio loopback.');
  }
  if (repositoryUrl.pathname.split('/').filter(Boolean).length < 1) {
    throw new Error('RESTIC_REPOSITORY deve indicar ao menos um bucket dedicado.');
  }
  if (env.RESTIC_PASSWORD) {
    throw new Error('Use RESTIC_PASSWORD_FILE; RESTIC_PASSWORD em texto no ambiente foi recusado.');
  }
  if (!env.RESTIC_PASSWORD_FILE || !path.isAbsolute(env.RESTIC_PASSWORD_FILE)) {
    throw new Error('RESTIC_PASSWORD_FILE absoluto e obrigatorio.');
  }

  const passwordStats = fs.lstatSync(env.RESTIC_PASSWORD_FILE);
  if (!passwordStats.isFile() || passwordStats.isSymbolicLink()) {
    throw new Error('RESTIC_PASSWORD_FILE deve ser um arquivo regular.');
  }
  if (process.platform !== 'win32' && (passwordStats.mode & 0o077) !== 0) {
    throw new Error('RESTIC_PASSWORD_FILE deve ter permissao 600 ou mais restritiva.');
  }

  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) {
    throw new Error('Credenciais S3 exclusivas do backup sao obrigatorias.');
  }
  if (String(env.RESTIC_INSECURE_TLS || '').toLowerCase() === 'true') {
    throw new Error('RESTIC_INSECURE_TLS nao pode ser habilitado.');
  }

  const host = env.OFFSITE_BACKUP_HOST || 'labmathic-production';
  if (!/^[a-z0-9][a-z0-9.-]{2,62}$/.test(host)) {
    throw new Error('OFFSITE_BACKUP_HOST invalido.');
  }

  const backupRoot = path.resolve(env.BACKUP_DIR);
  if (!fs.existsSync(backupRoot)) {
    throw new Error('BACKUP_DIR deve existir antes da ativacao da rotina externa.');
  }
  const backupRootStats = fs.lstatSync(backupRoot);
  if (!backupRootStats.isDirectory() || backupRootStats.isSymbolicLink()) {
    throw new Error('BACKUP_DIR deve ser um diretorio real, nao simbolico.');
  }
  if (process.platform !== 'win32' && (backupRootStats.mode & 0o077) !== 0) {
    throw new Error('BACKUP_DIR deve ter permissao 700 ou mais restritiva.');
  }
  const cacheDirectory = path.resolve(env.RESTIC_CACHE_DIR || path.join(backupRoot, '.restic-cache'));
  if (cacheDirectory === backupRoot || !cacheDirectory.startsWith(`${backupRoot}${path.sep}`)) {
    throw new Error('RESTIC_CACHE_DIR deve ficar dentro de BACKUP_DIR.');
  }
  if (fs.existsSync(cacheDirectory) && fs.lstatSync(cacheDirectory).isSymbolicLink()) {
    throw new Error('RESTIC_CACHE_DIR nao pode ser um link simbolico.');
  }
  fs.mkdirSync(cacheDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(cacheDirectory, 0o700);

  return {
    resticBin: env.RESTIC_BIN,
    repository: env.RESTIC_REPOSITORY,
    passwordFile: env.RESTIC_PASSWORD_FILE,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    region: env.AWS_DEFAULT_REGION || '',
    backupRoot,
    cacheDirectory,
    host,
    dataCheckPercent: parseInteger(env.OFFSITE_CHECK_PERCENT, 10, {
      min: 1,
      max: 100,
      name: 'OFFSITE_CHECK_PERCENT',
    }),
    localKeep: parseInteger(env.LOCAL_BACKUP_KEEP, 2, {
      min: 2,
      max: 30,
      name: 'LOCAL_BACKUP_KEEP',
    }),
  };
}

function resticEnvironment(config) {
  return {
    RESTIC_REPOSITORY: config.repository,
    RESTIC_PASSWORD_FILE: config.passwordFile,
    RESTIC_CACHE_DIR: config.cacheDirectory,
    RESTIC_HOST: config.host,
    AWS_ACCESS_KEY_ID: config.accessKeyId,
    AWS_SECRET_ACCESS_KEY: config.secretAccessKey,
    ...(config.region ? { AWS_DEFAULT_REGION: config.region } : {}),
    ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}),
    ...(process.env.TEMP ? { TEMP: process.env.TEMP } : {}),
    ...(process.env.TMP ? { TMP: process.env.TMP } : {}),
  };
}

function runRestic(config, args, { cwd = config.backupRoot } = {}) {
  const result = spawnSync(config.resticBin, args, {
    cwd,
    env: resticEnvironment(config),
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
  });

  if (result.error || result.status !== 0) {
    const code = result.status === null ? 'indisponivel' : result.status;
    throw new Error(`Restic recusou a etapa solicitada (codigo ${code}).`);
  }

  return result.stdout || '';
}

function acquireLock(backupRoot, lockName) {
  const lockPath = path.join(path.resolve(backupRoot), lockName);
  const descriptor = fs.openSync(lockPath, 'wx', 0o600);
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() })}\n`);
  } catch (error) {
    fs.closeSync(descriptor);
    fs.rmSync(lockPath, { force: true });
    throw error;
  }

  return () => {
    try {
      fs.closeSync(descriptor);
    } finally {
      fs.rmSync(lockPath, { force: true });
    }
  };
}

function parseSnapshotId(output) {
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (typeof value.snapshot_id === 'string' && /^[0-9a-f]{64}$/.test(value.snapshot_id)) {
        return value.snapshot_id;
      }
    } catch {
      // Restic may combine JSON summaries with progress lines in older releases.
    }
  }
  throw new Error('Restic nao retornou um identificador de snapshot valido.');
}

function writeOffsiteReceipt(config, backupResult, snapshotId) {
  const receiptsDirectory = path.join(config.backupRoot, '.offsite-receipts');
  fs.mkdirSync(receiptsDirectory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') fs.chmodSync(receiptsDirectory, 0o700);

  const receiptPath = path.join(receiptsDirectory, `${backupResult.backupName}.json`);
  const receipt = {
    receipt_version: 1,
    backup_name: backupResult.backupName,
    offsite_snapshot_id: snapshotId,
    manifest_sha256: hashFile(path.join(backupResult.backupDirectory, 'manifest.json')),
    verified_at: new Date().toISOString(),
  };
  fs.writeFileSync(receiptPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  return receipt;
}

function pruneVerifiedLocalBackups(config) {
  const receiptsDirectory = path.join(config.backupRoot, '.offsite-receipts');
  if (!fs.existsSync(receiptsDirectory)) return [];

  const candidates = fs.readdirSync(receiptsDirectory)
    .filter((name) => name.endsWith('.json'))
    .map((name) => {
      const receiptPath = path.join(receiptsDirectory, name);
      const receiptStats = fs.lstatSync(receiptPath);
      if (!receiptStats.isFile() || receiptStats.isSymbolicLink()) {
        throw new Error('Recibo externo invalido ou simbolico.');
      }
      const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
      return { name, receiptPath, receipt };
    })
    .filter(({ name, receipt }) => (
      receipt.receipt_version === 1
      && BACKUP_NAME_PATTERN.test(receipt.backup_name)
      && name === `${receipt.backup_name}.json`
    ))
    .sort((left, right) => right.receipt.backup_name.localeCompare(left.receipt.backup_name));

  const removed = [];
  for (const { receiptPath, receipt } of candidates.slice(config.localKeep)) {
    const backupDirectory = path.join(config.backupRoot, receipt.backup_name);
    if (path.dirname(backupDirectory) !== config.backupRoot || !fs.existsSync(backupDirectory)) continue;

    const verification = verifyBackup(backupDirectory);
    const manifestHash = hashFile(path.join(backupDirectory, 'manifest.json'));
    if (manifestHash !== receipt.manifest_sha256 || verification.manifest.backup_name !== receipt.backup_name) {
      throw new Error('Retencao local recusada por divergencia no recibo externo.');
    }

    fs.rmSync(backupDirectory, { recursive: true, force: false });
    fs.rmSync(receiptPath, { force: false });
    removed.push(receipt.backup_name);
  }

  return removed;
}

module.exports = {
  BACKUP_TAG,
  acquireLock,
  parseInteger,
  parseSnapshotId,
  pruneVerifiedLocalBackups,
  resticEnvironment,
  runRestic,
  validateOffsiteConfig,
  writeOffsiteReceipt,
};
