const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const {
  createBackup,
  verifyBackup,
} = require('../src/backup');

function createFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-backup-'));
  const dataDirectory = path.join(root, 'data');
  const uploadDirectory = path.join(root, 'uploads');
  const backupRoot = path.join(root, 'vault');
  fs.mkdirSync(dataDirectory);
  fs.mkdirSync(uploadDirectory);
  fs.mkdirSync(path.join(uploadDirectory, 'materiais'));
  fs.writeFileSync(path.join(uploadDirectory, 'materiais', 'atividade.txt'), 'conteudo pedagogico\n');
  fs.writeFileSync(path.join(uploadDirectory, 'capa.png'), Buffer.from([1, 2, 3, 4]));

  const dbPath = path.join(dataDirectory, 'database.sqlite');
  const database = new Database(dbPath);
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE teachers (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE questions (
      id INTEGER PRIMARY KEY,
      teacher_id INTEGER NOT NULL REFERENCES teachers(id),
      statement TEXT NOT NULL
    );
    INSERT INTO teachers (id, name) VALUES (1, 'Professora Teste');
    INSERT INTO questions (teacher_id, statement) VALUES (1, 'Quanto e dois mais dois?');
  `);
  database.close();

  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { root, dbPath, uploadDirectory, backupRoot };
}

test('cria snapshot atomico, verificavel e sem expor caminhos absolutos', async (t) => {
  const fixture = createFixture(t);
  const result = await createBackup({
    dbPath: fixture.dbPath,
    uploadDir: fixture.uploadDirectory,
    backupRoot: fixture.backupRoot,
    now: new Date('2026-08-09T12:34:56.000Z'),
    randomBytes: () => Buffer.from('01020304', 'hex'),
  });

  assert.equal(result.backupName, 'backup-20260809T123456Z-01020304');
  assert.equal(fs.existsSync(result.backupDirectory), true);
  assert.equal(
    fs.readdirSync(fixture.backupRoot).some((name) => name.startsWith('.incomplete-backup-')),
    false
  );

  const manifestText = fs.readFileSync(path.join(result.backupDirectory, 'manifest.json'), 'utf8');
  assert.equal(manifestText.includes(fixture.root), false);

  const verification = verifyBackup(result.backupDirectory);
  assert.equal(verification.manifest.manifest_version, 2);
  assert.equal(verification.databaseVerification.sqlite_integrity_check, 'ok');
  assert.equal(verification.databaseVerification.foreign_key_violations, 0);
  assert.deepEqual(
    { files: verification.uploads.files, bytes: verification.uploads.bytes },
    { files: 2, bytes: 24 }
  );
});

test('recusa snapshot corrompido usando o hash do manifesto', async (t) => {
  const fixture = createFixture(t);
  const result = await createBackup({
    dbPath: fixture.dbPath,
    uploadDir: fixture.uploadDirectory,
    backupRoot: fixture.backupRoot,
  });

  fs.appendFileSync(path.join(result.backupDirectory, 'database.sqlite'), 'corrupcao');
  assert.throws(
    () => verifyBackup(result.backupDirectory),
    /Hash ou tamanho do banco/
  );
});

test('recusa BACKUP_DIR sobreposto aos dados ativos', async (t) => {
  const fixture = createFixture(t);

  await assert.rejects(
    createBackup({
      dbPath: fixture.dbPath,
      uploadDir: fixture.uploadDirectory,
      backupRoot: path.join(fixture.uploadDirectory, 'backups'),
    }),
    /isolado de DB_PATH e UPLOAD_DIR/
  );
});

test('recusa links simbolicos e remove somente o snapshot incompleto', async (t) => {
  if (process.platform === 'win32') {
    t.skip('Criacao de symlink exige privilegio adicional no Windows.');
    return;
  }

  const fixture = createFixture(t);
  fs.symlinkSync(path.join(fixture.uploadDirectory, 'capa.png'), path.join(fixture.uploadDirectory, 'atalho.png'));

  await assert.rejects(
    createBackup({
      dbPath: fixture.dbPath,
      uploadDir: fixture.uploadDirectory,
      backupRoot: fixture.backupRoot,
    }),
    /Links simbolicos/
  );
  assert.deepEqual(fs.readdirSync(fixture.backupRoot), []);
  assert.equal(fs.existsSync(fixture.dbPath), true);
  assert.equal(fs.existsSync(fixture.uploadDirectory), true);
});
