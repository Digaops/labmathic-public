const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');

const BACKUP_NAME_PATTERN = /^backup-\d{8}T\d{6}Z-[0-9a-f]{8}$/;

function timestamp(date = new Date()) {
  return date
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d{3}Z$/, 'Z');
}

function isSameOrInside(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function assertSafeBackupRoot(backupRoot, dbPath, uploadDir) {
  if (!path.isAbsolute(backupRoot)) {
    throw new Error('BACKUP_DIR deve ser um caminho absoluto.');
  }

  const resolvedRoot = path.resolve(backupRoot);
  const resolvedDb = path.resolve(dbPath);
  const resolvedUploads = path.resolve(uploadDir);

  if (
    isSameOrInside(resolvedRoot, resolvedUploads)
    || isSameOrInside(resolvedUploads, resolvedRoot)
    || isSameOrInside(resolvedDb, resolvedRoot)
    || isSameOrInside(resolvedRoot, path.dirname(resolvedDb))
  ) {
    throw new Error('BACKUP_DIR deve permanecer isolado de DB_PATH e UPLOAD_DIR.');
  }

  return resolvedRoot;
}

function ensurePrivateDirectory(directory) {
  if (fs.existsSync(directory) && fs.lstatSync(directory).isSymbolicLink()) {
    throw new Error('Diretorio privado nao pode ser um link simbolico.');
  }
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') {
    fs.chmodSync(directory, 0o700);
  }
}

function assertSufficientDiskSpace(directory, requiredBytes) {
  if (typeof fs.statfsSync !== 'function') return;

  const filesystem = fs.statfsSync(directory);
  const availableBytes = BigInt(filesystem.bavail) * BigInt(filesystem.bsize);
  const safetyMargin = BigInt(Math.max(64 * 1024 * 1024, Math.ceil(requiredBytes * 0.1)));
  const requiredWithMargin = BigInt(requiredBytes) + safetyMargin;

  if (availableBytes < requiredWithMargin) {
    throw new Error('Espaco livre insuficiente para criar o snapshot com margem de seguranca.');
  }
}

function hashFile(filePath) {
  const hash = crypto.createHash('sha256');
  const noFollow = fs.constants.O_NOFOLLOW || 0;
  const descriptor = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
  const buffer = Buffer.allocUnsafe(1024 * 1024);

  try {
    if (!fs.fstatSync(descriptor).isFile()) {
      throw new Error('Somente arquivos regulares podem ser validados por hash.');
    }
    let bytesRead;
    do {
      bytesRead = fs.readSync(descriptor, buffer, 0, buffer.length, null);
      if (bytesRead > 0) hash.update(buffer.subarray(0, bytesRead));
    } while (bytesRead > 0);
  } finally {
    fs.closeSync(descriptor);
  }

  return hash.digest('hex');
}

function directoryInventory(directory, { includeTimestamps = false, includeContentHashes = false } = {}) {
  if (!fs.existsSync(directory)) {
    throw new Error('Diretorio de uploads inexistente.');
  }

  const root = path.resolve(directory);
  const entries = [];
  const contentEntries = [];
  let bytes = 0;

  function walk(currentDirectory) {
    const children = fs.readdirSync(currentDirectory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));

    for (const child of children) {
      const fullPath = path.join(currentDirectory, child.name);
      const stats = fs.lstatSync(fullPath);

      if (stats.isSymbolicLink()) {
        throw new Error('Links simbolicos nao sao permitidos nos uploads do backup.');
      }

      if (stats.isDirectory()) {
        walk(fullPath);
        continue;
      }

      if (!stats.isFile()) {
        throw new Error('Somente arquivos regulares podem integrar o backup de uploads.');
      }

      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      const entry = `${relativePath}\0${stats.size}${includeTimestamps ? `\0${stats.mtimeMs}` : ''}`;
      entries.push(entry);
      if (includeContentHashes) {
        contentEntries.push(`${relativePath}\0${stats.size}\0${hashFile(fullPath)}`);
      }
      bytes += stats.size;
    }
  }

  walk(root);

  const inventory = {
    files: entries.length,
    bytes,
    inventory_sha256: crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex'),
  };
  if (includeContentHashes) {
    inventory.content_inventory_sha256 = crypto.createHash('sha256')
      .update(JSON.stringify(contentEntries))
      .digest('hex');
  }
  return inventory;
}

function verifyDatabase(databasePath) {
  const database = new Database(databasePath, { readonly: true, fileMustExist: true });

  try {
    database.pragma('query_only = ON');
    const integrityRows = database.pragma('integrity_check');
    const integrityOk = integrityRows.length === 1 && integrityRows[0].integrity_check === 'ok';
    if (!integrityOk) {
      throw new Error('PRAGMA integrity_check recusou o snapshot SQLite.');
    }

    const foreignKeyViolations = database.pragma('foreign_key_check');
    if (foreignKeyViolations.length > 0) {
      throw new Error('PRAGMA foreign_key_check encontrou violacoes no snapshot SQLite.');
    }

    return {
      sqlite_integrity_check: 'ok',
      foreign_key_violations: 0,
    };
  } finally {
    database.close();
  }
}

function readManifest(backupDirectory) {
  const manifestPath = path.join(backupDirectory, 'manifest.json');
  const manifestStats = fs.lstatSync(manifestPath);
  if (!manifestStats.isFile() || manifestStats.isSymbolicLink()) {
    throw new Error('Manifesto de backup invalido.');
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const directoryName = path.basename(backupDirectory);
  const matchesFinalName = manifest.backup_name === directoryName;
  const matchesIncompleteName = directoryName === `.incomplete-${manifest.backup_name}`;
  if (manifest.manifest_version !== 2 || (!matchesFinalName && !matchesIncompleteName)) {
    throw new Error('Versao ou identificador do manifesto invalido.');
  }

  return manifest;
}

function verifyBackup(backupDirectory) {
  const resolvedDirectory = path.resolve(backupDirectory);
  const directoryStats = fs.lstatSync(resolvedDirectory);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error('Diretorio de backup invalido.');
  }

  const manifest = readManifest(resolvedDirectory);
  const databasePath = path.resolve(resolvedDirectory, manifest.contents.database);
  const uploadsPath = path.resolve(resolvedDirectory, manifest.contents.uploads);

  if (!isSameOrInside(databasePath, resolvedDirectory) || !isSameOrInside(uploadsPath, resolvedDirectory)) {
    throw new Error('O manifesto tenta acessar conteudo fora do snapshot.');
  }

  const databaseStats = fs.lstatSync(databasePath);
  if (!databaseStats.isFile() || databaseStats.isSymbolicLink()) {
    throw new Error('Copia do banco invalida.');
  }
  if (databaseStats.size !== manifest.database.bytes || hashFile(databasePath) !== manifest.database.sha256) {
    throw new Error('Hash ou tamanho do banco nao corresponde ao manifesto.');
  }

  const uploads = directoryInventory(uploadsPath, { includeContentHashes: true });
  if (
    uploads.files !== manifest.uploads.files
    || uploads.bytes !== manifest.uploads.bytes
    || uploads.inventory_sha256 !== manifest.uploads.inventory_sha256
    || uploads.content_inventory_sha256 !== manifest.uploads.content_inventory_sha256
  ) {
    throw new Error('Inventario dos uploads nao corresponde ao manifesto.');
  }

  const databaseVerification = verifyDatabase(databasePath);
  return { manifest, databaseVerification, uploads };
}

function copyUploads(source, destination) {
  fs.cpSync(source, destination, {
    recursive: true,
    force: false,
    errorOnExist: true,
    preserveTimestamps: true,
    dereference: false,
    filter(sourcePath) {
      const stats = fs.lstatSync(sourcePath);
      if (stats.isSymbolicLink()) {
        throw new Error('Links simbolicos nao sao permitidos nos uploads do backup.');
      }
      if (!stats.isDirectory() && !stats.isFile()) {
        throw new Error('Somente arquivos regulares podem integrar o backup de uploads.');
      }
      return true;
    },
  });
}

function removeIncompleteDirectory(backupRoot, incompleteDirectory) {
  const resolvedRoot = path.resolve(backupRoot);
  const resolvedIncomplete = path.resolve(incompleteDirectory);
  const basename = path.basename(resolvedIncomplete);

  if (path.dirname(resolvedIncomplete) !== resolvedRoot || !basename.startsWith('.incomplete-backup-')) {
    throw new Error('Recusa ao remover diretorio temporario fora do escopo do backup.');
  }

  fs.rmSync(resolvedIncomplete, { recursive: true, force: true });
}

async function backupDatabase(sourceDatabasePath, destination) {
  const database = new Database(sourceDatabasePath, { readonly: true, fileMustExist: true });

  try {
    await database.backup(destination);
  } finally {
    database.close();
  }
}

async function createBackup({
  dbPath,
  uploadDir,
  backupRoot,
  now = new Date(),
  randomBytes = crypto.randomBytes,
} = {}) {
  if (!dbPath || !uploadDir || !backupRoot) {
    throw new Error('DB_PATH, UPLOAD_DIR e BACKUP_DIR sao obrigatorios.');
  }

  const declaredDbPath = path.resolve(dbPath);
  const declaredUploadDir = path.resolve(uploadDir);
  const declaredBackupRoot = assertSafeBackupRoot(backupRoot, declaredDbPath, declaredUploadDir);

  if (!fs.existsSync(declaredDbPath) || !fs.lstatSync(declaredDbPath).isFile()) {
    throw new Error('Banco de dados nao encontrado.');
  }
  if (fs.lstatSync(declaredDbPath).isSymbolicLink()) {
    throw new Error('DB_PATH nao pode ser um link simbolico.');
  }
  if (!fs.existsSync(declaredUploadDir) || !fs.lstatSync(declaredUploadDir).isDirectory()) {
    throw new Error('Diretorio de uploads nao encontrado.');
  }
  if (fs.lstatSync(declaredUploadDir).isSymbolicLink()) {
    throw new Error('UPLOAD_DIR nao pode ser um link simbolico.');
  }

  ensurePrivateDirectory(declaredBackupRoot);
  const resolvedDbPath = fs.realpathSync(declaredDbPath);
  const resolvedUploadDir = fs.realpathSync(declaredUploadDir);
  const resolvedBackupRoot = fs.realpathSync(declaredBackupRoot);
  assertSafeBackupRoot(resolvedBackupRoot, resolvedDbPath, resolvedUploadDir);

  const backupName = `backup-${timestamp(now)}-${randomBytes(4).toString('hex')}`;
  if (!BACKUP_NAME_PATTERN.test(backupName)) {
    throw new Error('Identificador de backup invalido.');
  }

  const backupDirectory = path.join(resolvedBackupRoot, backupName);
  const incompleteDirectory = path.join(resolvedBackupRoot, `.incomplete-${backupName}`);
  const databaseBackupPath = path.join(incompleteDirectory, 'database.sqlite');
  const uploadsBackupDirectory = path.join(incompleteDirectory, 'uploads');
  const manifestPath = path.join(incompleteDirectory, 'manifest.json');

  if (fs.existsSync(backupDirectory) || fs.existsSync(incompleteDirectory)) {
    throw new Error('Colisao de identificador de backup.');
  }

  ensurePrivateDirectory(incompleteDirectory);

  try {
    const sourceBefore = directoryInventory(resolvedUploadDir, { includeTimestamps: true });
    const sourceDatabaseBytes = fs.statSync(resolvedDbPath).size;
    assertSufficientDiskSpace(resolvedBackupRoot, sourceBefore.bytes + sourceDatabaseBytes);
    await backupDatabase(resolvedDbPath, databaseBackupPath);
    copyUploads(resolvedUploadDir, uploadsBackupDirectory);
    const sourceAfter = directoryInventory(resolvedUploadDir, { includeTimestamps: true });

    if (
      sourceBefore.files !== sourceAfter.files
      || sourceBefore.bytes !== sourceAfter.bytes
      || sourceBefore.inventory_sha256 !== sourceAfter.inventory_sha256
    ) {
      throw new Error('Uploads alterados durante a copia; o snapshot foi recusado e deve ser repetido.');
    }

    const sourceShape = directoryInventory(resolvedUploadDir, { includeContentHashes: true });
    const sourceFinal = directoryInventory(resolvedUploadDir, { includeTimestamps: true });
    if (
      sourceAfter.files !== sourceFinal.files
      || sourceAfter.bytes !== sourceFinal.bytes
      || sourceAfter.inventory_sha256 !== sourceFinal.inventory_sha256
    ) {
      throw new Error('Uploads alterados durante a verificacao; o snapshot foi recusado.');
    }

    const copiedUploads = directoryInventory(uploadsBackupDirectory, { includeContentHashes: true });
    if (
      copiedUploads.files !== sourceShape.files
      || copiedUploads.bytes !== sourceShape.bytes
      || copiedUploads.inventory_sha256 !== sourceShape.inventory_sha256
      || copiedUploads.content_inventory_sha256 !== sourceShape.content_inventory_sha256
    ) {
      throw new Error('A copia dos uploads nao corresponde byte a byte a origem.');
    }

    const databaseStats = fs.statSync(databaseBackupPath);
    const databaseVerification = verifyDatabase(databaseBackupPath);
    const manifest = {
      manifest_version: 2,
      created_at: now.toISOString(),
      backup_name: backupName,
      contents: {
        database: 'database.sqlite',
        uploads: 'uploads',
      },
      database: {
        bytes: databaseStats.size,
        sha256: hashFile(databaseBackupPath),
      },
      uploads: copiedUploads,
      verification: {
        ...databaseVerification,
        source_uploads_stable: true,
      },
    };

    const temporaryManifestPath = `${manifestPath}.tmp`;
    fs.writeFileSync(temporaryManifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
    fs.renameSync(temporaryManifestPath, manifestPath);
    verifyBackup(incompleteDirectory);
    fs.renameSync(incompleteDirectory, backupDirectory);

    return {
      backupName,
      backupDirectory,
      manifest,
    };
  } catch (error) {
    removeIncompleteDirectory(resolvedBackupRoot, incompleteDirectory);
    throw error;
  }
}

async function main() {
  const config = require('./config');
  const backupRoot = process.env.BACKUP_DIR
    || (config.appEnvironment === 'development' ? path.resolve(__dirname, '../backups') : '');

  if (!backupRoot) {
    throw new Error('BACKUP_DIR deve ser configurado explicitamente.');
  }

  const result = await createBackup({
    dbPath: config.dbPath,
    uploadDir: config.uploadDir,
    backupRoot,
  });

  console.log(`Backup verificado: ${result.backupName}`);
  console.log(`Banco: ${result.manifest.database.bytes} byte(s)`);
  console.log(`Uploads: ${result.manifest.uploads.files} arquivo(s), ${result.manifest.uploads.bytes} byte(s)`);
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Falha no backup: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  BACKUP_NAME_PATTERN,
  assertSafeBackupRoot,
  createBackup,
  directoryInventory,
  hashFile,
  isSameOrInside,
  readManifest,
  verifyBackup,
  verifyDatabase,
};
