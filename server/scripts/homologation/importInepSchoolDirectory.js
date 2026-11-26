const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

const { importInepSchoolDirectory } = require('../../src/services/inepSchoolDirectoryImport');

const CONFIRMATION = 'IMPORT_VERSIONED_INEP_SCHOOL_DIRECTORY';
const HOMOLOGATION_PATH_PATTERN = /(homolog|staging)/i;
const ALLOWED_ARGUMENTS = new Set([
  'database',
  'source',
  'year',
  'source-url',
  'sha256',
  'encoding',
  'confirmation',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    assert(argument.startsWith('--'), `Argumento inesperado: ${argument}.`);
    const name = argument.slice(2);
    assert(ALLOWED_ARGUMENTS.has(name), `Argumento não permitido: --${name}.`);
    assert(result[name] === undefined, `Argumento duplicado: --${name}.`);
    const value = argv[index + 1];
    assert(value && !value.startsWith('--'), `Valor ausente para --${name}.`);
    result[name] = value;
    index += 1;
  }
  return result;
}

function regularFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} não existe.`);
  const stats = fs.lstatSync(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} deve ser um arquivo regular, não um link.`);
}

function resolveDatabasePath(value, env = process.env) {
  assert(value, 'Informe --database.');
  const resolved = path.resolve(value);
  assert(HOMOLOGATION_PATH_PATTERN.test(resolved), 'O banco deve estar em um caminho de homologação.');
  regularFile(resolved, 'O banco de homologação');
  assert(HOMOLOGATION_PATH_PATTERN.test(fs.realpathSync(resolved)), 'O destino real do banco deve permanecer na homologação.');
  assert(path.resolve(env.DB_PATH || '') === resolved, 'DB_PATH deve apontar exatamente para o banco informado.');
  for (const sidecar of [`${resolved}-wal`, `${resolved}-shm`]) {
    assert(!fs.existsSync(sidecar), 'Pare a homologação e execute checkpoint: foi encontrado WAL/SHM ativo.');
  }
  return resolved;
}

function resolveSourcePath(value) {
  assert(value, 'Informe --source.');
  const resolved = path.resolve(value);
  regularFile(resolved, 'O CSV do Inep');
  const size = fs.statSync(resolved).size;
  assert(size > 0 && size <= 4 * 1024 * 1024 * 1024, 'O CSV possui tamanho inválido.');
  return resolved;
}

function inspectDatabase(database) {
  database.pragma('foreign_keys = ON');
  const metadata = database.prepare(`
    SELECT sanitized, sanitizer_version
    FROM homologation_snapshot_metadata
    WHERE id = 1
  `).get();
  assert(metadata?.sanitized === 1, 'O banco não é um snapshot sanitizado de homologação.');
  assert(Number(metadata.sanitizer_version) >= 13, 'O catálogo exige sanitizador versão 13 ou superior.');
  const schemaVersion = database.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')
    .pluck().get();
  assert(schemaVersion >= 24, 'A migração 024 ainda não foi aplicada.');
  assert(database.pragma('integrity_check', { simple: true }) === 'ok', 'O banco falhou no integrity_check.');
  assert(database.pragma('foreign_key_check').length === 0, 'O banco possui violações de chave estrangeira.');
  return { schemaVersion, sanitizerVersion: String(metadata.sanitizer_version) };
}

async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArguments(argv);
  assert(env.NODE_ENV === 'production', 'NODE_ENV deve ser production para manter as proteções HTTP.');
  assert(env.APP_ENV === 'homologation', 'APP_ENV deve ser homologation.');
  assert(args.confirmation === CONFIRMATION, 'Confirmação explícita de importação ausente.');
  const databasePath = resolveDatabasePath(args.database, env);
  const sourcePath = resolveSourcePath(args.source);

  const database = new Database(databasePath);
  try {
    const before = inspectDatabase(database);
    const result = await importInepSchoolDirectory(database, {
      sourcePath,
      censusYear: args.year,
      sourceUrl: args['source-url'],
      expectedSha256: args.sha256,
      allowedAdministrativeDependencies: ['municipal'],
      encoding: args.encoding || 'utf8',
    });
    assert(database.pragma('integrity_check', { simple: true }) === 'ok', 'O banco falhou após a importação.');
    assert(database.pragma('foreign_key_check').length === 0, 'A importação criou violações de chave estrangeira.');
    return {
      ...result,
      environment: 'homologation',
      schemaVersion: before.schemaVersion,
      sanitizerVersion: before.sanitizerVersion,
      productionTouched: false,
    };
  } finally {
    database.close();
  }
}

if (require.main === module) {
  run()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`[inep-school-directory] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONFIRMATION,
  parseArguments,
  resolveDatabasePath,
  run,
};
