const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const readline = require('node:readline');
const { Transform } = require('node:stream');
const { finished } = require('node:stream/promises');
const zlib = require('node:zlib');

const {
  mapColumns,
  mapSchoolRow,
  parseDelimitedLine,
  sha256File,
} = require('../../src/services/inepSchoolDirectoryImport');
const {
  IBGE_MUNICIPALITIES_URL,
  validateIbgePayload,
} = require('../../src/services/institutionalDirectories');

const CONFIRMATION = 'PREPARE_VERSIONED_INEP_SCHOOL_DIRECTORY';
const ALLOWED_ARGUMENTS = new Set([
  'archive',
  'entry',
  'output',
  'manifest',
  'year',
  'source-url',
  'expected-archive-sha256',
  'expected-entry-md5',
  'ibge-directory',
  'expected-ibge-sha256',
  'predecessor-catalog-sha256',
  'predecessor-catalog-row-count',
  'confirmation',
]);
const CANONICAL_HEADER = [
  'NU_ANO_CENSO',
  'CO_ENTIDADE',
  'NO_ENTIDADE',
  'CO_MUNICIPIO',
  'NO_MUNICIPIO',
  'SG_UF',
  'TP_DEPENDENCIA',
  'TP_SITUACAO_FUNCIONAMENTO',
];

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
  assert(stats.isFile() && !stats.isSymbolicLink(), `${label} deve ser um arquivo regular.`);
  return stats;
}

function resolveWorkspaceOutput(value, label, workspaceRoot = process.cwd()) {
  assert(value, `Informe ${label}.`);
  const resolvedRoot = path.resolve(workspaceRoot);
  const resolved = path.resolve(value);
  const relative = path.relative(resolvedRoot, resolved);
  assert(relative && !relative.startsWith('..') && !path.isAbsolute(relative), `${label} deve ficar no workspace.`);
  assert(!fs.existsSync(resolved), `${label} já existe; preserve o artefato anterior e use outro destino.`);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  return resolved;
}

function validateSourceUrl(value) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error('URL oficial da fonte é inválida.');
  }
  assert(
    parsed.protocol === 'https:' && parsed.hostname === 'download.inep.gov.br',
    'A preparação aceita somente download HTTPS oficial do Inep.',
  );
  return parsed.toString();
}

function csvValue(value) {
  const normalized = String(value ?? '');
  return /[;"\r\n]/.test(normalized)
    ? `"${normalized.replace(/"/g, '""')}"`
    : normalized;
}

function dependencyCode(value) {
  return new Map([
    ['federal', '1'],
    ['state', '2'],
    ['municipal', '3'],
    ['private', '4'],
    ['unknown', ''],
  ]).get(value);
}

function operatingStatusCode(value) {
  return new Map([
    ['active', '1'],
    ['paused', '2'],
    ['closed', '3'],
    ['unknown', ''],
  ]).get(value);
}

function createWindows1252Decoder(md5) {
  const decoder = new TextDecoder('windows-1252');
  return new Transform({
    transform(chunk, _encoding, callback) {
      md5.update(chunk);
      callback(null, decoder.decode(chunk, { stream: true }));
    },
    flush(callback) {
      callback(null, decoder.decode());
    },
  });
}

function validateCatalogStats(stats) {
  assert(stats.rowCount >= 120000 && stats.rowCount <= 140000, 'Volume municipal de escolas fora da faixa segura.');
  assert(stats.activeCount >= 100000 && stats.activeCount <= 120000, 'Volume de escolas municipais ativas fora da faixa segura.');
  assert(stats.ufCount >= 26 && stats.ufCount <= 27, 'Cobertura de unidades federativas fora da faixa segura.');
  assert(stats.municipalityCount >= 5500 && stats.municipalityCount <= 5571, 'Cobertura municipal fora da faixa segura.');
  assert(
    stats.dependencies
      && Object.keys(stats.dependencies).length === 1
      && stats.dependencies.municipal === stats.rowCount,
    'O catálogo preparado deve conter somente escolas municipais.',
  );
}

async function prepareArtifact(options) {
  const archivePath = path.resolve(options.archivePath);
  const archiveStats = regularFile(archivePath, 'O pacote oficial do Inep');
  assert(archiveStats.size > 0 && archiveStats.size <= 2 * 1024 * 1024 * 1024, 'Tamanho do pacote oficial inválido.');
  assert(/^[0-9a-f]{64}$/.test(options.expectedArchiveSha256), 'SHA-256 esperado do pacote é inválido.');
  assert(/^[0-9a-f]{32}$/.test(options.expectedEntryMd5), 'MD5 publicado para a tabela escolar é inválido.');
  assert(/^\d{4}$/.test(String(options.year)), 'Ano do Censo Escolar inválido.');
  assert(/\.csv$/i.test(options.entry) && !options.entry.includes('..'), 'Entrada escolar do ZIP inválida.');
  assert(/^[0-9a-f]{64}$/.test(String(options.predecessorCatalogSha256 || '')), 'SHA-256 do catálogo predecessor inválido.');
  assert(
    Number.isInteger(options.predecessorCatalogRowCount) && options.predecessorCatalogRowCount > 0,
    'Volume do catálogo predecessor inválido.',
  );

  const actualArchiveSha256 = await sha256File(archivePath);
  assert(actualArchiveSha256 === options.expectedArchiveSha256, 'SHA-256 do pacote oficial não confere.');

  assert(options.ibgeDirectoryPath, 'Informe o diretório oficial do IBGE.');
  const ibgeDirectoryPath = path.resolve(options.ibgeDirectoryPath);
  const ibgeStats = regularFile(ibgeDirectoryPath, 'O diretório oficial do IBGE');
  assert(ibgeStats.size >= 1_000_000 && ibgeStats.size <= 10_000_000, 'Tamanho do diretório do IBGE inválido.');
  assert(/^[0-9a-f]{64}$/.test(options.expectedIbgeSha256), 'SHA-256 esperado do IBGE é inválido.');
  const actualIbgeSha256 = await sha256File(ibgeDirectoryPath);
  assert(actualIbgeSha256 === options.expectedIbgeSha256, 'SHA-256 do diretório do IBGE não confere.');
  const ibgeRows = validateIbgePayload(JSON.parse(fs.readFileSync(ibgeDirectoryPath, 'utf8')));
  const ibgeByCode = new Map(ibgeRows.map((row) => [row.ibgeCode, row]));

  const sourceUrl = validateSourceUrl(options.sourceUrl);
  const temporaryArtifact = `${options.outputPath}.partial-${process.pid}`;
  const gzip = zlib.createGzip({ level: 9, mtime: 0 });
  const artifactOutput = fs.createWriteStream(temporaryArtifact, { flags: 'wx', mode: 0o600 });
  gzip.pipe(artifactOutput);

  const catalogSha256 = crypto.createHash('sha256');
  const entryMd5 = crypto.createHash('md5');
  let catalogBytes = 0;
  const schoolCodes = new Set();
  const municipalityCodes = new Set();
  const ufs = new Set();
  const dependencies = {};
  const excludedDependencies = {};
  const statuses = {};
  let activeCount = 0;
  let repairedFromIbgeCount = 0;
  let rowCount = 0;
  let columns;

  async function writeCatalogLine(values) {
    const bytes = Buffer.from(`${values.map(csvValue).join(';')}\n`, 'utf8');
    catalogSha256.update(bytes);
    catalogBytes += bytes.length;
    if (!gzip.write(bytes)) await once(gzip, 'drain');
  }

  const tar = spawn('tar', ['-xOf', archivePath, options.entry], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  tar.stderr.setEncoding('utf8');
  tar.stderr.on('data', (chunk) => {
    if (stderr.length < 4000) stderr += chunk;
  });
  const tarExit = once(tar, 'exit');
  const decodedInput = tar.stdout.pipe(createWindows1252Decoder(entryMd5));
  const lines = readline.createInterface({ input: decodedInput, crlfDelay: Infinity });

  try {
    await writeCatalogLine(CANONICAL_HEADER);
    let lineNumber = 0;
    for await (const line of lines) {
      lineNumber += 1;
      if (lineNumber === 1) {
        columns = mapColumns(parseDelimitedLine(line, ';'));
        continue;
      }
      if (!line.trim()) continue;
      let row;
      try {
        const values = parseDelimitedLine(line, ';');
        const ibgeCode = String(values[columns.ibgeCode] || '').trim();
        const needsMunicipalityRepair = !String(values[columns.municipalityName] || '').trim()
          || !/^[A-Z]{2}$/.test(String(values[columns.uf] || '').trim().toUpperCase());
        if (needsMunicipalityRepair) {
          const officialMunicipality = ibgeByCode.get(ibgeCode);
          assert(officialMunicipality, `Município ${ibgeCode || 'ausente'} não encontrado no IBGE.`);
          values[columns.municipalityName] = officialMunicipality.name;
          values[columns.uf] = officialMunicipality.uf;
          repairedFromIbgeCount += 1;
        }
        row = mapSchoolRow(values, columns, Number(options.year));
      } catch (error) {
        throw new Error(`Tabela oficial, linha ${lineNumber}: ${error.message}`);
      }
      if (row.administrativeDependency !== 'municipal') {
        excludedDependencies[row.administrativeDependency] = (excludedDependencies[row.administrativeDependency] || 0) + 1;
        continue;
      }
      assert(!schoolCodes.has(row.censusCode), `Código Inep duplicado: ${row.censusCode}.`);
      schoolCodes.add(row.censusCode);
      municipalityCodes.add(row.ibgeCode);
      ufs.add(row.uf);
      dependencies[row.administrativeDependency] = (dependencies[row.administrativeDependency] || 0) + 1;
      statuses[row.operatingStatus] = (statuses[row.operatingStatus] || 0) + 1;
      if (row.operatingStatus === 'active') activeCount += 1;
      rowCount += 1;
      await writeCatalogLine([
        options.year,
        row.censusCode,
        row.schoolName,
        row.ibgeCode,
        row.municipalityName,
        row.uf,
        dependencyCode(row.administrativeDependency),
        operatingStatusCode(row.operatingStatus),
      ]);
    }

    const [exitCode, signal] = await tarExit;
    assert(exitCode === 0 && !signal, `Falha ao extrair a tabela escolar: ${stderr.trim() || `código ${exitCode}`}.`);
    assert(columns, 'A tabela escolar oficial está vazia.');
    const actualEntryMd5 = entryMd5.digest('hex');
    assert(actualEntryMd5 === options.expectedEntryMd5, 'MD5 da tabela escolar não corresponde ao checksum publicado pelo Inep.');
    validateCatalogStats({
      rowCount,
      activeCount,
      ufCount: ufs.size,
      municipalityCount: municipalityCodes.size,
      dependencies,
    });
    assert(repairedFromIbgeCount <= 100, 'O Inep exigiu reparos municipais acima do limite seguro.');
    assert(
      ['federal', 'state', 'private'].every((dependency) => excludedDependencies[dependency] > 0),
      'A preparação não comprovou a exclusão das redes não municipais.',
    );

    gzip.end();
    await finished(artifactOutput);
    fs.renameSync(temporaryArtifact, options.outputPath);
    const artifactSha256 = await sha256File(options.outputPath);
    const artifactStats = regularFile(options.outputPath, 'O catálogo compactado');
    const manifest = {
      schemaVersion: 2,
      directoryType: 'inep_school_catalog',
      scope: { administrativeDependency: 'municipal' },
      censusYear: Number(options.year),
      sourceName: 'Inep · Censo Escolar',
      sourceUrl,
      sourceArchive: path.basename(archivePath),
      sourceArchiveBytes: archiveStats.size,
      sourceArchiveSha256: actualArchiveSha256,
      sourceEntry: options.entry,
      sourceEntryMd5: actualEntryMd5,
      ibgeSourceUrl: IBGE_MUNICIPALITIES_URL,
      ibgeDirectorySha256: actualIbgeSha256,
      repairedFromIbgeCount,
      catalogEncoding: 'utf8',
      catalogSha256: catalogSha256.digest('hex'),
      catalogBytes,
      artifactFile: path.basename(options.outputPath),
      artifactSha256,
      artifactBytes: artifactStats.size,
      rowCount,
      activeCount,
      municipalityCount: municipalityCodes.size,
      ufCount: ufs.size,
      dependencies,
      excludedDependencies,
      statuses,
      predecessorCatalogs: [{
        catalogSha256: options.predecessorCatalogSha256,
        rowCount: options.predecessorCatalogRowCount,
      }],
    };
    fs.writeFileSync(options.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    return manifest;
  } catch (error) {
    tar.kill();
    gzip.destroy();
    artifactOutput.destroy();
    if (fs.existsSync(temporaryArtifact)) fs.rmSync(temporaryArtifact, { force: true });
    if (fs.existsSync(options.outputPath)) fs.rmSync(options.outputPath, { force: true });
    throw error;
  }
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArguments(argv);
  assert(args.confirmation === CONFIRMATION, 'Confirmação explícita de preparação ausente.');
  assert(args.archive, 'Informe --archive.');
  assert(args.entry, 'Informe --entry.');
  assert(/^[0-9a-f]{64}$/.test(String(args['predecessor-catalog-sha256'] || '')), 'Informe o SHA-256 do catálogo predecessor aprovado.');
  const predecessorCatalogRowCount = Number(args['predecessor-catalog-row-count']);
  assert(Number.isInteger(predecessorCatalogRowCount) && predecessorCatalogRowCount > 0, 'Informe o volume do catálogo predecessor aprovado.');
  const outputPath = resolveWorkspaceOutput(args.output, '--output');
  assert(/\.csv\.gz$/i.test(outputPath), '--output deve terminar em .csv.gz.');
  const manifestPath = resolveWorkspaceOutput(args.manifest, '--manifest');
  assert(/\.manifest\.json$/i.test(manifestPath), '--manifest deve terminar em .manifest.json.');
  try {
    return await prepareArtifact({
      archivePath: args.archive,
      entry: args.entry,
      outputPath,
      manifestPath,
      year: args.year,
      sourceUrl: args['source-url'],
      expectedArchiveSha256: String(args['expected-archive-sha256'] || '').toLowerCase(),
      expectedEntryMd5: String(args['expected-entry-md5'] || '').toLowerCase(),
      ibgeDirectoryPath: args['ibge-directory'],
      expectedIbgeSha256: String(args['expected-ibge-sha256'] || '').toLowerCase(),
      predecessorCatalogSha256: String(args['predecessor-catalog-sha256']).toLowerCase(),
      predecessorCatalogRowCount,
    });
  } catch (error) {
    for (const target of [outputPath, manifestPath]) {
      if (fs.existsSync(target)) fs.rmSync(target, { force: true });
    }
    throw error;
  }
}

if (require.main === module) {
  run()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(`[inep-school-directory:prepare] ${error.message}`);
      process.exitCode = 1;
    });
}

module.exports = {
  CONFIRMATION,
  parseArguments,
  prepareArtifact,
  run,
  validateCatalogStats,
};
