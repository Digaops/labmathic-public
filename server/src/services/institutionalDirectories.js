const { InstitutionalManagementError } = require('./institutionalManagement');

const IBGE_MUNICIPALITIES_URL = 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios';
const IBGE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const IBGE_TIMEOUT_MS = 7_000;
const RESULT_LIMIT = 30;

let municipalityCache = null;
let municipalityRefresh = null;

function fail(status, code, message, details) {
  throw new InstitutionalManagementError(status, code, message, details);
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

function queryText(value, label, maximum = 100) {
  if (typeof value !== 'string') {
    fail(400, 'invalid_directory_query', `${label} deve ser informado.`);
  }
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (normalized.length < 2 || normalized.length > maximum) {
    fail(400, 'invalid_directory_query', `${label} deve ter entre 2 e ${maximum} caracteres.`);
  }
  return normalized;
}

function extractUf(item) {
  return item?.microrregiao?.mesorregiao?.UF?.sigla
    || item?.['regiao-imediata']?.['regiao-intermediaria']?.UF?.sigla
    || null;
}

function validateIbgePayload(payload) {
  if (!Array.isArray(payload) || payload.length < 5_000 || payload.length > 6_000) {
    throw new Error('Resposta do IBGE fora do formato ou volume esperado.');
  }
  const uniqueCodes = new Set();
  const rows = [];
  for (const item of payload) {
    const ibgeCode = String(item?.id || '');
    const name = typeof item?.nome === 'string' ? item.nome.replace(/\s+/g, ' ').trim() : '';
    const uf = String(extractUf(item) || '').toUpperCase();
    if (!/^\d{7}$/.test(ibgeCode) || name.length < 2 || !/^[A-Z]{2}$/.test(uf)) {
      throw new Error('Resposta do IBGE contém município inválido.');
    }
    if (uniqueCodes.has(ibgeCode)) throw new Error('Resposta do IBGE contém código duplicado.');
    uniqueCodes.add(ibgeCode);
    rows.push({
      ibgeCode,
      name,
      uf,
      searchName: normalizeSearch(`${name} ${uf}`),
    });
  }
  return rows;
}

async function refreshMunicipalities(fetchImpl) {
  const response = await fetchImpl(IBGE_MUNICIPALITIES_URL, {
    headers: { Accept: 'application/json' },
    signal: AbortSignal.timeout(IBGE_TIMEOUT_MS),
  });
  if (!response?.ok) throw new Error(`IBGE respondeu HTTP ${response?.status || 'desconhecido'}.`);
  const rows = validateIbgePayload(await response.json());
  municipalityCache = {
    rows,
    refreshedAt: new Date().toISOString(),
    expiresAt: Date.now() + IBGE_CACHE_TTL_MS,
  };
  return municipalityCache;
}

async function loadMunicipalities(fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') throw new Error('Cliente HTTP indisponível.');
  if (municipalityCache && municipalityCache.expiresAt > Date.now()) {
    return { ...municipalityCache, cacheStatus: 'fresh' };
  }
  if (!municipalityRefresh) {
    municipalityRefresh = refreshMunicipalities(fetchImpl).finally(() => {
      municipalityRefresh = null;
    });
  }
  try {
    const refreshed = await municipalityRefresh;
    return { ...refreshed, cacheStatus: 'fresh' };
  } catch (error) {
    if (municipalityCache) return { ...municipalityCache, cacheStatus: 'stale' };
    throw error;
  }
}

async function searchIbgeMunicipalities(query, { fetchImpl = globalThis.fetch } = {}) {
  const originalQuery = queryText(query, 'A busca do município', 80);
  const normalizedQuery = normalizeSearch(originalQuery);
  try {
    const directory = await loadMunicipalities(fetchImpl);
    const numericQuery = originalQuery.replace(/\D/g, '');
    const results = directory.rows
      .map((row) => {
        const nameIndex = row.searchName.indexOf(normalizedQuery);
        const codeMatch = numericQuery.length >= 2 && row.ibgeCode.startsWith(numericQuery);
        return { row, nameIndex, codeMatch };
      })
      .filter(({ nameIndex, codeMatch }) => nameIndex >= 0 || codeMatch)
      .sort((left, right) => {
        const leftRank = left.codeMatch ? -1 : left.nameIndex;
        const rightRank = right.codeMatch ? -1 : right.nameIndex;
        return leftRank - rightRank
          || left.row.name.localeCompare(right.row.name, 'pt-BR')
          || left.row.uf.localeCompare(right.row.uf);
      })
      .slice(0, RESULT_LIMIT)
      .map(({ row }) => ({ ibgeCode: row.ibgeCode, name: row.name, uf: row.uf }));
    return {
      source: {
        name: 'IBGE Localidades',
        url: IBGE_MUNICIPALITIES_URL,
        refreshedAt: directory.refreshedAt,
        cacheStatus: directory.cacheStatus,
      },
      results,
    };
  } catch (error) {
    if (error instanceof InstitutionalManagementError) throw error;
    fail(
      503,
      'ibge_directory_unavailable',
      'A consulta ao IBGE está temporariamente indisponível. Use o cadastro manual ou tente novamente.',
    );
  }
}

function searchSchoolDirectory(database, { municipalityPublicId, query }) {
  const normalizedPublicId = String(municipalityPublicId || '').trim();
  if (normalizedPublicId.length < 20 || normalizedPublicId.length > 64) {
    fail(400, 'invalid_directory_query', 'O município selecionado é inválido.');
  }
  const originalQuery = queryText(query, 'A busca da escola', 100);
  const municipality = database.prepare(`
    SELECT id, public_id, name, ibge_code
    FROM municipalities
    WHERE public_id = ? COLLATE NOCASE AND status = 'active'
  `).get(normalizedPublicId);
  if (!municipality) fail(404, 'municipality_not_found', 'Município não encontrado ou indisponível.');

  const base = {
    municipality: {
      publicId: municipality.public_id,
      name: municipality.name,
      ibgeCode: municipality.ibge_code,
    },
  };
  if (!municipality.ibge_code) {
    return {
      ...base,
      available: false,
      reason: 'municipality_without_ibge_code',
      source: null,
      results: [],
    };
  }

  const source = database.prepare(`
    SELECT id, source_name, source_year, source_url, source_sha256, row_count, imported_at
    FROM institutional_directory_imports
    WHERE directory_type = 'inep_school_catalog'
    ORDER BY source_year DESC, id DESC
    LIMIT 1
  `).get();
  if (!source) {
    return {
      ...base,
      available: false,
      reason: 'directory_not_imported',
      source: null,
      results: [],
    };
  }

  const normalizedQuery = normalizeSearch(originalQuery);
  const escapedLike = normalizedQuery.replace(/[\\%_]/g, (character) => `\\${character}`);
  const codeQuery = originalQuery.replace(/\D/g, '');
  const codePattern = codeQuery.length >= 2 ? `${codeQuery}%` : '__no_numeric_school_code__';
  const rows = database.prepare(`
    SELECT directory.census_code,
      directory.school_name,
      directory.municipality_name,
      directory.uf,
      directory.administrative_dependency,
      directory.operating_status,
      registered.public_id AS registered_public_id
    FROM institutional_school_directory directory
    LEFT JOIN schools registered
      ON registered.municipality_id = ?
      AND registered.census_code = directory.census_code COLLATE NOCASE
      AND registered.status = 'active'
    WHERE directory.import_id = ?
      AND directory.ibge_code = ? COLLATE NOCASE
      AND directory.administrative_dependency = 'municipal'
      AND (
        directory.search_name LIKE ? ESCAPE '\\'
        OR directory.census_code LIKE ?
      )
    ORDER BY
      CASE WHEN directory.search_name LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END,
      CASE directory.operating_status WHEN 'active' THEN 0 ELSE 1 END,
      directory.school_name COLLATE NOCASE,
      directory.census_code
    LIMIT ?
  `).all(
    municipality.id,
    source.id,
    municipality.ibge_code,
    `%${escapedLike}%`,
    codePattern,
    `${escapedLike}%`,
    RESULT_LIMIT,
  );

  return {
    ...base,
    available: true,
    reason: null,
    source: {
      name: source.source_name,
      censusYear: source.source_year,
      url: source.source_url,
      sha256: source.source_sha256,
      rowCount: source.row_count,
      administrativeDependency: 'municipal',
      importedAt: source.imported_at,
    },
    results: rows.map((row) => ({
      censusCode: row.census_code,
      name: row.school_name,
      municipalityName: row.municipality_name,
      uf: row.uf,
      administrativeDependency: row.administrative_dependency,
      operatingStatus: row.operating_status,
      alreadyRegistered: Boolean(row.registered_public_id),
      registeredSchoolPublicId: row.registered_public_id || null,
    })),
  };
}

function resetMunicipalityCacheForTests() {
  municipalityCache = null;
  municipalityRefresh = null;
}

module.exports = {
  IBGE_MUNICIPALITIES_URL,
  normalizeSearch,
  resetMunicipalityCacheForTests,
  searchIbgeMunicipalities,
  searchSchoolDirectory,
  validateIbgePayload,
};
