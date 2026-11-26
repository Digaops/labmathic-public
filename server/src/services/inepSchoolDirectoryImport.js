const crypto = require('node:crypto');
const fs = require('node:fs');
const readline = require('node:readline');
const { v4: uuidv4 } = require('uuid');

const SOURCE_NAME = 'Inep · Censo Escolar';
const DEPENDENCIES = new Map([
  ['1', 'federal'],
  ['2', 'state'],
  ['3', 'municipal'],
  ['4', 'private'],
]);
const OPERATING_STATUSES = new Map([
  ['1', 'active'],
  ['2', 'paused'],
  ['3', 'closed'],
  ['4', 'closed'],
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function normalizeSearch(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLocaleLowerCase('pt-BR')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function normalizeHeader(value) {
  return String(value || '')
    .replace(/^\uFEFF/, '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

function countDelimiter(line, delimiter) {
  let quoted = false;
  let count = 0;
  for (let index = 0; index < line.length; index += 1) {
    if (line[index] === '"') {
      if (quoted && line[index + 1] === '"') index += 1;
      else quoted = !quoted;
    } else if (!quoted && line[index] === delimiter) count += 1;
  }
  return count;
}

function detectDelimiter(headerLine) {
  const semicolons = countDelimiter(headerLine, ';');
  const commas = countDelimiter(headerLine, ',');
  assert(Math.max(semicolons, commas) >= 5, 'O cabeçalho não parece ser um CSV do Censo Escolar.');
  return semicolons >= commas ? ';' : ',';
}

function parseDelimitedLine(line, delimiter) {
  const values = [];
  let value = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        value += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === delimiter && !quoted) {
      values.push(value);
      value = '';
    } else {
      value += character;
    }
  }
  assert(!quoted, 'O CSV contém uma linha com aspas não encerradas.');
  values.push(value);
  return values;
}

function findColumn(headers, aliases, required = true) {
  const index = headers.findIndex((header) => aliases.includes(header));
  if (required) assert(index >= 0, `Coluna obrigatória ausente: ${aliases[0]}.`);
  return index;
}

function mapColumns(rawHeaders) {
  const headers = rawHeaders.map(normalizeHeader);
  assert(new Set(headers).size === headers.length, 'O CSV contém cabeçalhos duplicados.');
  return {
    censusYear: findColumn(headers, ['NU_ANO_CENSO', 'ANO_CENSO'], false),
    censusCode: findColumn(headers, ['CO_ENTIDADE', 'CODIGO_ENTIDADE', 'CODIGO_INEP']),
    schoolName: findColumn(headers, ['NO_ENTIDADE', 'NOME_ENTIDADE', 'NOME_ESCOLA']),
    ibgeCode: findColumn(headers, ['CO_MUNICIPIO', 'CODIGO_MUNICIPIO']),
    municipalityName: findColumn(headers, ['NO_MUNICIPIO', 'NOME_MUNICIPIO']),
    uf: findColumn(headers, ['SG_UF', 'UF']),
    dependency: findColumn(headers, ['TP_DEPENDENCIA', 'DEPENDENCIA_ADMINISTRATIVA']),
    operatingStatus: findColumn(headers, ['TP_SITUACAO_FUNCIONAMENTO', 'SITUACAO_FUNCIONAMENTO']),
    length: headers.length,
  };
}

function normalizedText(value, label, minimum, maximum) {
  const normalized = String(value || '').replace(/\s+/g, ' ').trim();
  assert(
    normalized.length >= minimum && normalized.length <= maximum,
    `${label} possui tamanho inválido.`,
  );
  assert(!/[\u0000-\u001F\u007F]/.test(normalized), `${label} contém caracteres de controle.`);
  return normalized;
}

function mapSchoolRow(values, columns, expectedYear) {
  assert(values.length === columns.length, 'A linha possui quantidade de colunas diferente do cabeçalho.');
  if (columns.censusYear >= 0) {
    assert(String(values[columns.censusYear]).trim() === String(expectedYear), 'O CSV mistura anos de Censo Escolar.');
  }
  const censusCode = String(values[columns.censusCode] || '').trim();
  const ibgeCode = String(values[columns.ibgeCode] || '').trim();
  const uf = String(values[columns.uf] || '').trim().toUpperCase();
  assert(/^\d{8}$/.test(censusCode), 'Código Inep inválido.');
  assert(/^\d{7}$/.test(ibgeCode), 'Código IBGE de município inválido.');
  assert(/^[A-Z]{2}$/.test(uf), 'UF inválida.');
  const schoolName = normalizedText(values[columns.schoolName], 'Nome da escola', 2, 180);
  return {
    censusCode,
    ibgeCode,
    schoolName,
    searchName: normalizeSearch(schoolName),
    municipalityName: normalizedText(values[columns.municipalityName], 'Nome do município', 2, 160),
    uf,
    administrativeDependency: DEPENDENCIES.get(String(values[columns.dependency]).trim()) || 'unknown',
    operatingStatus: OPERATING_STATUSES.get(String(values[columns.operatingStatus]).trim()) || 'unknown',
  };
}

async function sha256File(filePath) {
  const digest = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(filePath)) digest.update(chunk);
  return digest.digest('hex');
}

function validateMetadata({ censusYear, sourceUrl, expectedSha256 }) {
  const year = Number(censusYear);
  assert(Number.isInteger(year) && year >= 2000 && year <= 2100, 'Ano do Censo Escolar inválido.');
  assert(/^[0-9a-f]{64}$/.test(String(expectedSha256 || '')), 'SHA-256 oficial esperado é obrigatório.');
  let parsedUrl;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    throw new Error('URL oficial da fonte é inválida.');
  }
  const officialHost = parsedUrl.hostname === 'www.gov.br'
    || parsedUrl.hostname === 'download.inep.gov.br'
    || parsedUrl.hostname.endsWith('.inep.gov.br');
  assert(parsedUrl.protocol === 'https:' && officialHost, 'A fonte deve apontar para um domínio HTTPS oficial do Inep.');
  return { year, sourceUrl: parsedUrl.toString(), expectedSha256 };
}

async function importInepSchoolDirectory(database, {
  sourcePath,
  censusYear,
  sourceUrl,
  expectedSha256,
  expectedRowCount,
  allowedAdministrativeDependencies = ['municipal'],
  encoding = 'utf8',
}) {
  const metadata = validateMetadata({ censusYear, sourceUrl, expectedSha256 });
  assert(['utf8', 'latin1'].includes(encoding), 'Codificação deve ser utf8 ou latin1.');
  assert(
    Array.isArray(allowedAdministrativeDependencies)
      && allowedAdministrativeDependencies.length === 1
      && allowedAdministrativeDependencies[0] === 'municipal',
    'O diretório escolar do LabMathic aceita somente a dependência municipal.',
  );
  const allowedDependencies = new Set(allowedAdministrativeDependencies);
  const actualSha256 = await sha256File(sourcePath);
  assert(actualSha256 === metadata.expectedSha256, 'O SHA-256 do arquivo não corresponde ao valor aprovado.');

  database.pragma('foreign_keys = ON');
  database.exec(`
    DROP TABLE IF EXISTS temp.inep_school_directory_stage;
    CREATE TEMP TABLE inep_school_directory_stage (
      census_code TEXT NOT NULL PRIMARY KEY,
      ibge_code TEXT NOT NULL,
      school_name TEXT NOT NULL,
      search_name TEXT NOT NULL,
      municipality_name TEXT NOT NULL,
      uf TEXT NOT NULL,
      administrative_dependency TEXT NOT NULL,
      operating_status TEXT NOT NULL
    );
  `);
  const insertStage = database.prepare(`
    INSERT INTO temp.inep_school_directory_stage (
      census_code, ibge_code, school_name, search_name, municipality_name, uf,
      administrative_dependency, operating_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  let rowCount = 0;
  let lineNumber = 0;
  let columns;
  let delimiter;
  let transactionOpen = false;
  try {
    database.exec('BEGIN IMMEDIATE');
    transactionOpen = true;
    const input = readline.createInterface({
      input: fs.createReadStream(sourcePath, { encoding }),
      crlfDelay: Infinity,
    });
    for await (const line of input) {
      lineNumber += 1;
      if (lineNumber === 1) {
        delimiter = detectDelimiter(line);
        columns = mapColumns(parseDelimitedLine(line, delimiter));
        continue;
      }
      if (!line.trim()) continue;
      try {
        const row = mapSchoolRow(parseDelimitedLine(line, delimiter), columns, metadata.year);
        assert(
          allowedDependencies.has(row.administrativeDependency),
          `A escola ${row.censusCode} não pertence à rede municipal.`,
        );
        insertStage.run(
          row.censusCode,
          row.ibgeCode,
          row.schoolName,
          row.searchName,
          row.municipalityName,
          row.uf,
          row.administrativeDependency,
          row.operatingStatus,
        );
        rowCount += 1;
      } catch (error) {
        throw new Error(`Linha ${lineNumber}: ${error.message}`);
      }
    }
    assert(columns, 'O arquivo está vazio.');
    assert(rowCount > 0, 'O arquivo não contém escolas.');
    if (expectedRowCount !== undefined) {
      assert(
        Number.isInteger(expectedRowCount) && expectedRowCount > 0,
        'O volume esperado do catálogo é inválido.',
      );
      assert(rowCount === expectedRowCount, 'O volume do catálogo diverge do manifesto aprovado.');
    }

    const importId = Number(database.prepare(`
      INSERT INTO institutional_directory_imports (
        public_id, directory_type, source_name, source_year, source_url,
        source_sha256, row_count
      ) VALUES (?, 'inep_school_catalog', ?, ?, ?, ?, ?)
    `).run(
      uuidv4(),
      SOURCE_NAME,
      metadata.year,
      metadata.sourceUrl,
      actualSha256,
      rowCount,
    ).lastInsertRowid);

    database.prepare(`DELETE FROM institutional_school_directory WHERE census_year = ?`)
      .run(metadata.year);
    database.prepare(`
      INSERT INTO institutional_school_directory (
        import_id, census_year, census_code, ibge_code, school_name, search_name,
        municipality_name, uf, administrative_dependency, operating_status
      )
      SELECT ?, ?, census_code, ibge_code, school_name, search_name,
        municipality_name, uf, administrative_dependency, operating_status
      FROM temp.inep_school_directory_stage
      ORDER BY census_code
    `).run(importId, metadata.year);
    database.exec('COMMIT');
    transactionOpen = false;
  } catch (error) {
    if (transactionOpen) database.exec('ROLLBACK');
    throw error;
  } finally {
    database.exec('DROP TABLE IF EXISTS temp.inep_school_directory_stage');
  }

  return {
    status: 'imported',
    sourceName: SOURCE_NAME,
    censusYear: metadata.year,
    sourceSha256: actualSha256,
    rowCount,
  };
}

module.exports = {
  detectDelimiter,
  importInepSchoolDirectory,
  mapColumns,
  mapSchoolRow,
  normalizeSearch,
  parseDelimitedLine,
  sha256File,
};
