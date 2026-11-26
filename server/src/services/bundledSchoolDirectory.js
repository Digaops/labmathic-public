const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const zlib = require('node:zlib');

const {
  importInepSchoolDirectory,
  sha256File,
} = require('./inepSchoolDirectoryImport');

const DEFAULT_MANIFEST_PATH = path.resolve(
  __dirname,
  '../../catalogs/inep-schools-2025.manifest.json',
);
const MAX_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_CATALOG_BYTES = 40 * 1024 * 1024;
const SANITIZER_VERSION_WITH_APPROVED_DIRECTORY = 15;
const SANITIZER_SCHEMA_CEILINGS = new Map([
  [1, 2],
  [2, 3],
  [3, 7],
  [4, 8],
  [5, 9],
  [6, 12],
  [7, 14],
  [8, 15],
  [11, 22],
  [12, 23],
  [13, 24],
  [14, 25],
  [15, 26],
  // Historical sanitizers on the homologation branch, with their released schema ceilings.
  [16, 27],
  [17, 30],
  [18, 32],
  [21, 36],
  [23, 39],
  [24, 40], // UUIDs técnicos preservados e proteção dos recibos profissionais.
  [25, 41], // Inclui a remoção dos recibos de criação de simulados.
  [26, 42], // Inclui os metadados editoriais do acervo oficial.
  [27, 43], // Acrescenta desafios sem modificar a estrutura da curadoria.
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function regularFile(filePath, label) {
  assert(fs.existsSync(filePath), `${label} não existe.`);
  const stats = fs.lstatSync(filePath);
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} deve ser um arquivo regular.`);
  return stats;
}

function validateManifest(manifest) {
  assert(manifest && typeof manifest === 'object' && !Array.isArray(manifest), 'Manifesto do catálogo inválido.');
  assert(manifest.schemaVersion === 2, 'Versão do manifesto do catálogo não suportada.');
  assert(manifest.directoryType === 'inep_school_catalog', 'Tipo de diretório inválido no manifesto.');
  assert(
    manifest.scope?.administrativeDependency === 'municipal'
      && Object.keys(manifest.scope).length === 1,
    'O manifesto deve limitar o catálogo à dependência municipal.',
  );
  assert(Number.isInteger(manifest.censusYear) && manifest.censusYear >= 2025, 'Ano do catálogo inválido.');
  assert(manifest.sourceName === 'Inep · Censo Escolar', 'Fonte do catálogo inválida.');
  let sourceUrl;
  try {
    sourceUrl = new URL(manifest.sourceUrl);
  } catch {
    throw new Error('URL da fonte do catálogo inválida.');
  }
  assert(
    sourceUrl.protocol === 'https:' && sourceUrl.hostname === 'download.inep.gov.br',
    'O catálogo deve apontar para o download HTTPS oficial do Inep.',
  );
  assert(/^[0-9a-f]{64}$/.test(manifest.sourceArchiveSha256), 'SHA-256 do pacote oficial inválido.');
  assert(/^[0-9a-f]{32}$/.test(manifest.sourceEntryMd5), 'MD5 publicado pelo Inep inválido.');
  assert(
    manifest.ibgeSourceUrl === 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios',
    'Fonte municipal do IBGE inválida.',
  );
  assert(/^[0-9a-f]{64}$/.test(manifest.ibgeDirectorySha256), 'SHA-256 do diretório do IBGE inválido.');
  assert(manifest.catalogEncoding === 'utf8', 'Codificação do catálogo inválida.');
  assert(/^[0-9a-f]{64}$/.test(manifest.catalogSha256), 'SHA-256 do catálogo inválido.');
  assert(/^[0-9a-f]{64}$/.test(manifest.artifactSha256), 'SHA-256 do artefato inválido.');
  assert(/^[a-z0-9._-]+\.csv\.gz$/i.test(manifest.artifactFile), 'Nome do artefato inválido.');
  assert(Number.isInteger(manifest.catalogBytes) && manifest.catalogBytes > 0 && manifest.catalogBytes <= MAX_CATALOG_BYTES, 'Tamanho expandido do catálogo inválido.');
  assert(Number.isInteger(manifest.artifactBytes) && manifest.artifactBytes > 0 && manifest.artifactBytes <= MAX_ARTIFACT_BYTES, 'Tamanho compactado do catálogo inválido.');
  assert(Number.isInteger(manifest.rowCount) && manifest.rowCount >= 120000 && manifest.rowCount <= 140000, 'Volume municipal do catálogo inválido.');
  assert(Number.isInteger(manifest.activeCount) && manifest.activeCount >= 100000 && manifest.activeCount <= 120000, 'Volume de escolas municipais ativas inválido.');
  assert(manifest.municipalityCount >= 5500 && manifest.municipalityCount <= 5571, 'Cobertura municipal do catálogo inválida.');
  assert(manifest.ufCount >= 26 && manifest.ufCount <= 27, 'Cobertura de UFs do catálogo inválida.');
  assert(
    manifest.dependencies
      && Object.keys(manifest.dependencies).length === 1
      && manifest.dependencies.municipal === manifest.rowCount,
    'O catálogo contém dependências administrativas fora da rede municipal.',
  );
  assert(
    manifest.statuses
      && Object.values(manifest.statuses).every((count) => Number.isInteger(count) && count >= 0)
      && Object.values(manifest.statuses).reduce((sum, count) => sum + count, 0) === manifest.rowCount
      && manifest.statuses.active === manifest.activeCount,
    'As situações de funcionamento do catálogo estão inconsistentes.',
  );
  assert(
    manifest.excludedDependencies
      && ['federal', 'state', 'private'].every((dependency) => (
        Number.isInteger(manifest.excludedDependencies[dependency])
        && manifest.excludedDependencies[dependency] > 0
      ))
      && Object.keys(manifest.excludedDependencies).length === 3,
    'O manifesto não comprova a exclusão das redes não municipais.',
  );
  assert(
    Array.isArray(manifest.predecessorCatalogs)
      && manifest.predecessorCatalogs.length >= 1
      && manifest.predecessorCatalogs.every((catalog) => (
        catalog
        && /^[0-9a-f]{64}$/.test(catalog.catalogSha256)
        && catalog.catalogSha256 !== manifest.catalogSha256
        && Number.isInteger(catalog.rowCount)
        && catalog.rowCount > 0
        && catalog.rowCount <= 260000
      ))
      && new Set(manifest.predecessorCatalogs.map((catalog) => catalog.catalogSha256)).size
        === manifest.predecessorCatalogs.length,
    'A lista de catálogos predecessores aprovados é inválida.',
  );
  assert(Number.isInteger(manifest.repairedFromIbgeCount) && manifest.repairedFromIbgeCount >= 0 && manifest.repairedFromIbgeCount <= 100, 'Quantidade de reparos pelo IBGE inválida.');
  return manifest;
}

function inspectHomologationDatabase(database) {
  const metadata = database.prepare(`
    SELECT sanitized, sanitizer_version, source_schema_version
    FROM homologation_snapshot_metadata
    WHERE id = 1
  `).get();
  assert(metadata?.sanitized === 1, 'O catálogo só pode ser carregado em snapshot sanitizado.');
  const sanitizerVersion = Number(metadata.sanitizer_version);
  const sourceSchemaVersion = Number(metadata.source_schema_version);
  const supportedSourceSchema = SANITIZER_SCHEMA_CEILINGS.get(sanitizerVersion);
  assert(
    Number.isInteger(sanitizerVersion) && supportedSourceSchema !== undefined,
    'A versão do sanitizador do snapshot não pertence à matriz de compatibilidade.',
  );
  assert(
    Number.isInteger(sourceSchemaVersion)
      && sourceSchemaVersion >= 1
      && sourceSchemaVersion <= supportedSourceSchema,
    'O schema de origem é posterior às políticas da versão do sanitizador.',
  );
  const schemaVersion = database.prepare('SELECT COALESCE(MAX(version), 0) FROM schema_migrations')
    .pluck().get();
  assert(schemaVersion >= 24, 'A migração 024 ainda não foi aplicada.');
  assert(database.pragma('integrity_check', { simple: true }) === 'ok', 'O banco de homologação falhou no integrity_check.');
  assert(database.pragma('foreign_key_check').length === 0, 'O banco de homologação possui violações de chave estrangeira.');
  return {
    schemaVersion,
    sanitizerVersion,
    sourceSchemaVersion,
    sanitizerCompatibility: sanitizerVersion >= SANITIZER_VERSION_WITH_APPROVED_DIRECTORY
      ? 'current'
      : `v${sanitizerVersion}_migrated_to_schema24`,
  };
}

function findCurrentImport(database, manifest) {
  const receipt = database.prepare(`
    SELECT id, source_sha256, row_count
    FROM institutional_directory_imports
    WHERE directory_type = 'inep_school_catalog' AND source_year = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(manifest.censusYear);
  if (!receipt || receipt.source_sha256 !== manifest.catalogSha256) return null;
  const actualRows = database.prepare(`
    SELECT COUNT(*)
    FROM institutional_school_directory
    WHERE import_id = ? AND census_year = ?
  `).pluck().get(receipt.id, manifest.censusYear);
  const totalRows = database.prepare('SELECT COUNT(*) FROM institutional_school_directory')
    .pluck().get();
  assert(
    receipt.row_count === manifest.rowCount
      && actualRows === manifest.rowCount
      && totalRows === manifest.rowCount,
    'O catálogo existente está incompleto ou contém registros fora do recorte aprovado.',
  );
  return { importId: receipt.id, rowCount: actualRows };
}

function assertLegacyDirectoryState(database, databaseState, manifest) {
  const receipts = database.prepare(`
    SELECT id, source_name, source_year, source_sha256, row_count
    FROM institutional_directory_imports
    WHERE directory_type = 'inep_school_catalog'
    ORDER BY source_year DESC, id DESC
  `).all();
  const directoryRowCount = database.prepare(`
    SELECT COUNT(*)
    FROM institutional_school_directory
  `).pluck().get();

  if (receipts.length === 0 && directoryRowCount === 0) return;

  const approvedCatalogs = new Map(manifest.predecessorCatalogs.map((catalog) => [
    catalog.catalogSha256,
    catalog.rowCount,
  ]));
  const currentReceipt = receipts[0];
  const currentApprovedRows = approvedCatalogs.get(currentReceipt?.source_sha256);
  const rowsForCurrentReceipt = currentReceipt
    ? database.prepare(`
        SELECT COUNT(*)
        FROM institutional_school_directory
        WHERE import_id = ?
      `).pluck().get(currentReceipt.id)
    : 0;

  assert(
    receipts.every((receipt) => approvedCatalogs.get(receipt.source_sha256) === receipt.row_count)
      && Number.isInteger(currentApprovedRows)
      && receipts.every((receipt) => (
        receipt.source_name === manifest.sourceName
        && receipt.source_year === manifest.censusYear
      ))
      && currentReceipt.row_count === currentApprovedRows
      && database.prepare(`
        SELECT COUNT(*)
        FROM institutional_school_directory
        WHERE import_id = ? AND census_year = ?
      `).pluck().get(currentReceipt.id, manifest.censusYear) === currentApprovedRows
      && rowsForCurrentReceipt === currentApprovedRows
      && directoryRowCount === currentApprovedRows,
    'O snapshot sanitizado legado contém um diretório escolar não aprovado.',
  );
}

async function expandVerifiedArtifact(artifactPath, manifest, temporaryDirectory) {
  const artifactStats = regularFile(artifactPath, 'O catálogo escolar compactado');
  assert(artifactStats.size === manifest.artifactBytes, 'Tamanho do catálogo compactado diverge do manifesto.');
  assert(await sha256File(artifactPath) === manifest.artifactSha256, 'SHA-256 do catálogo compactado diverge do manifesto.');

  const temporaryPath = path.join(
    path.resolve(temporaryDirectory),
    `labmathic-homologation-inep-${manifest.censusYear}-${crypto.randomUUID()}.csv`,
  );
  const digest = crypto.createHash('sha256');
  let expandedBytes = 0;
  const verifier = new Transform({
    transform(chunk, _encoding, callback) {
      expandedBytes += chunk.length;
      if (expandedBytes > MAX_CATALOG_BYTES) {
        callback(new Error('O catálogo expandido excedeu o limite seguro.'));
        return;
      }
      digest.update(chunk);
      callback(null, chunk);
    },
  });
  try {
    await pipeline(
      fs.createReadStream(artifactPath),
      zlib.createGunzip(),
      verifier,
      fs.createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
    assert(expandedBytes === manifest.catalogBytes, 'Tamanho expandido diverge do manifesto.');
    assert(digest.digest('hex') === manifest.catalogSha256, 'SHA-256 expandido diverge do manifesto.');
    regularFile(temporaryPath, 'O catálogo escolar expandido');
    return temporaryPath;
  } catch (error) {
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    throw error;
  }
}

async function bootstrapBundledSchoolDirectory(database, {
  appEnvironment,
  nodeEnvironment,
  manifestPath = DEFAULT_MANIFEST_PATH,
  temporaryDirectory = os.tmpdir(),
} = {}) {
  if (appEnvironment !== 'homologation' || nodeEnvironment !== 'production') {
    return { status: 'skipped', reason: 'homologation_production_runtime_required', productionTouched: false };
  }

  const databaseState = inspectHomologationDatabase(database);
  const resolvedManifestPath = path.resolve(manifestPath);
  regularFile(resolvedManifestPath, 'O manifesto do catálogo escolar');
  const manifest = validateManifest(JSON.parse(fs.readFileSync(resolvedManifestPath, 'utf8')));
  const artifactPath = path.resolve(path.dirname(resolvedManifestPath), manifest.artifactFile);
  assert(path.dirname(artifactPath) === path.dirname(resolvedManifestPath), 'O artefato deve permanecer junto ao manifesto.');

  const current = findCurrentImport(database, manifest);
  if (current) {
    return {
      status: 'already_imported',
      censusYear: manifest.censusYear,
      rowCount: current.rowCount,
      ...databaseState,
      productionTouched: false,
    };
  }
  assertLegacyDirectoryState(database, databaseState, manifest);

  const temporaryCatalogPath = await expandVerifiedArtifact(
    artifactPath,
    manifest,
    temporaryDirectory,
  );
  try {
    const imported = await importInepSchoolDirectory(database, {
      sourcePath: temporaryCatalogPath,
      censusYear: manifest.censusYear,
      sourceUrl: manifest.sourceUrl,
      expectedSha256: manifest.catalogSha256,
      expectedRowCount: manifest.rowCount,
      allowedAdministrativeDependencies: [manifest.scope.administrativeDependency],
      encoding: manifest.catalogEncoding,
    });
    assert(imported.rowCount === manifest.rowCount, 'A importação não reproduziu o volume do manifesto.');
    const verified = findCurrentImport(database, manifest);
    assert(verified, 'O recibo imutável da importação não foi encontrado.');
    database.pragma('wal_checkpoint(FULL)');
    return {
      ...imported,
      status: 'imported',
      activeCount: manifest.activeCount,
      municipalityCount: manifest.municipalityCount,
      ufCount: manifest.ufCount,
      repairedFromIbgeCount: manifest.repairedFromIbgeCount,
      ...databaseState,
      productionTouched: false,
    };
  } finally {
    if (fs.existsSync(temporaryCatalogPath)) fs.rmSync(temporaryCatalogPath, { force: true });
  }
}

module.exports = {
  DEFAULT_MANIFEST_PATH,
  SANITIZER_SCHEMA_CEILINGS,
  assertLegacyDirectoryState,
  bootstrapBundledSchoolDirectory,
  expandVerifiedArtifact,
  inspectHomologationDatabase,
  validateManifest,
};
