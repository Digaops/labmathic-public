const path = require('path');
const { inflateRawSync } = require('node:zlib');
const readXlsxFile = require('read-excel-file/node');
const { zipSync } = require('fflate');

const MAX_IMPORT_ROWS = 500;
const MAX_XLSX_ENTRIES = 200;
const MAX_XLSX_UNCOMPRESSED_BYTES = 10 * 1024 * 1024;
const MAX_XLSX_ROW_POSITION = 2048;
const MAX_XLSX_COLUMNS = 256;
const MAX_XLSX_XML_ELEMENTS = 150_000;
const NAME_HEADERS = new Set(['nome', 'nome do estudante', 'nome do aluno', 'aluno', 'estudante']);
const REFERENCE_HEADERS = new Set([
  'matricula',
  'matricula do estudante',
  'identificador',
  'codigo',
  'codigo do estudante',
]);

function stripAccents(value) {
  return value.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

function cleanText(value, maxLength) {
  if (value === undefined || value === null) return '';
  if (typeof value === 'object') return '';

  const text = String(value)
    .replace(/[\u0000-\u001F\u007F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!text || text.length > maxLength || /^[=+\-@]/.test(text)) return '';
  return text;
}

function normalizeHeader(value) {
  return stripAccents(cleanText(value, 120).toLowerCase());
}

function parseCsvLine(line) {
  const cells = [];
  let cell = '';
  let quoted = false;

  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if ((character === ',' || character === ';') && !quoted) {
      cells.push(cell);
      cell = '';
    } else {
      cell += character;
    }
  }

  if (quoted) throw new Error('csv_invalid_quotes');
  cells.push(cell);
  return cells;
}

function parseCsv(buffer) {
  let content;
  try {
    content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
  } catch {
    throw new Error('csv_invalid_encoding');
  }

  return content
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .filter((line) => line.trim())
    .map(parseCsvLine);
}

async function rowsFromFile(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  if (extension === '.csv') return parseCsv(file.buffer);
  if (extension === '.xlsx') {
    const safeArchive = await validateXlsxArchive(file.buffer);
    const workbook = await readXlsxFile(Buffer.from(safeArchive), { sheets: [1] });
    // read-excel-file 9 retorna uma lista de planilhas quando `sheets` e usado.
    // A compatibilidade abaixo tambem aceita o formato antigo, que retornava as linhas.
    if (Array.isArray(workbook) && workbook.length === 1 && Array.isArray(workbook[0]?.data)) {
      return workbook[0].data;
    }
    return workbook;
  }
  throw new Error('unsupported_spreadsheet');
}

function validateWorkbookXml(Parser, xml, budget) {
  const parser = new Parser();
  const invalid = () => { throw new Error('xlsx_invalid_archive'); };
  const tooLarge = () => { throw new Error('xlsx_unsafe_grid'); };
  let depth = 0;
  let worksheet = false;
  let sheetDataSeen = false;
  let rowPosition = 0;
  parser.on('error', invalid);
  parser.on('warn', invalid);
  parser.on('attention', invalid); // DTDs and entity declarations.
  parser.on('openTag', (name, getAttrs, decode) => {
    if (++depth > 64 || --budget.remaining < 0) throw new Error('xlsx_unsafe_archive');
    const localName = name.split(':').at(-1);
    if (depth === 1) worksheet = localName === 'worksheet';
    if (localName === 'sheetData') sheetDataSeen = true;
    if ((worksheet || sheetDataSeen) && localName === 'f') throw new Error('xlsx_formulas_not_allowed');
    if (!sheetDataSeen || (localName !== 'row' && localName !== 'c')) return;
    const address = decode(getAttrs().r || '');
    if (localName === 'row') {
      if (address && !/^[1-9]\d{0,3}$/.test(address)) return tooLarge();
      rowPosition = Math.max(rowPosition + 1, Number(address));
      if (rowPosition > MAX_XLSX_ROW_POSITION) return tooLarge();
    } else {
      const cell = /^([A-Z]{1,3})([1-9]\d{0,3})$/.exec(address);
      if (!cell) return invalid();
      const column = [...cell[1]].reduce((n, letter) => n * 26 + letter.charCodeAt(0) - 64, 0);
      rowPosition = Math.max(rowPosition, Number(cell[2]));
      if (rowPosition > MAX_XLSX_ROW_POSITION || column > MAX_XLSX_COLUMNS) return tooLarge();
    }
  });
  parser.on('closeTag', () => { depth -= 1; });
  parser.parse(xml);
  return worksheet;
}

async function validateXlsxArchive(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22 || buffer.readUInt32LE(0) !== 0x04034b50) {
    throw new Error('xlsx_invalid_archive');
  }

  const minimumOffset = Math.max(0, buffer.length - 65_557);
  let endOffset = -1;
  for (let offset = buffer.length - 22; offset >= minimumOffset; offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50
      && offset + 22 + buffer.readUInt16LE(offset + 20) === buffer.length) {
      endOffset = offset;
      break;
    }
  }
  if (endOffset < 0) throw new Error('xlsx_invalid_archive');

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralSize = buffer.readUInt32LE(endOffset + 12);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  if (
    entryCount < 1
    || entryCount > MAX_XLSX_ENTRIES
    || buffer.readUInt16LE(endOffset + 4) !== 0
    || buffer.readUInt16LE(endOffset + 6) !== 0
    || buffer.readUInt16LE(endOffset + 8) !== entryCount
    || centralOffset + centralSize !== endOffset
  ) {
    throw new Error('xlsx_unsafe_archive');
  }

  let offset = centralOffset;
  let totalUncompressed = 0;
  const entries = Object.create(null);
  const names = new Set();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const { Parser } = await import('saxen');
  const xmlBudget = { remaining: MAX_XLSX_XML_ELEMENTS };
  let worksheetCount = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > endOffset || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error('xlsx_invalid_archive');
    }
    const flags = buffer.readUInt16LE(offset + 8);
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const uncompressedSize = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const nextOffset = offset + 46 + nameLength + extraLength + commentLength;
    if (nextOffset > endOffset || (flags & 0x0041) !== 0
      || ![0, 8].includes(method) || buffer.readUInt16LE(offset + 34) !== 0) {
      throw new Error('xlsx_unsafe_archive');
    }
    const nameBytes = buffer.subarray(offset + 46, offset + 46 + nameLength);
    const entryName = decoder.decode(nameBytes);
    if (!entryName || /[\\\x00-\x1f:]/.test(entryName) || entryName.startsWith('/')
      || entryName.split('/').includes('..') || names.has(entryName)) {
      throw new Error('xlsx_unsafe_archive');
    }
    names.add(entryName);
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > MAX_XLSX_UNCOMPRESSED_BYTES) {
      throw new Error('xlsx_unsafe_archive');
    }
    offset = nextOffset;
    // Keep only the XML parts the spreadsheet reader consumes. Rebuilding the ZIP
    // from those checked bytes prevents it from inflating unchecked local entries.
    if (!entryName.endsWith('.xml') && !entryName.endsWith('.xml.rels')) continue;
    if (localOffset + 30 > centralOffset || buffer.readUInt32LE(localOffset) !== 0x04034b50
      || buffer.readUInt16LE(localOffset + 6) !== flags || buffer.readUInt16LE(localOffset + 8) !== method
      || buffer.readUInt16LE(localOffset + 26) !== nameLength) throw new Error('xlsx_invalid_archive');
    const nameOffset = localOffset + 30;
    const start = nameOffset + nameLength + buffer.readUInt16LE(localOffset + 28);
    if (start + compressedSize > centralOffset
      || !nameBytes.equals(buffer.subarray(nameOffset, nameOffset + nameLength))) throw new Error('xlsx_invalid_archive');
    const packed = buffer.subarray(start, start + compressedSize);
    let unpacked;
    try {
      unpacked = method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: Math.max(1, uncompressedSize) });
    } catch {
      throw new Error('xlsx_unsafe_archive');
    }
    if (unpacked.length !== uncompressedSize) throw new Error('xlsx_unsafe_archive');
    if (validateWorkbookXml(Parser, decoder.decode(unpacked), xmlBudget)) worksheetCount += 1;
    entries[entryName] = unpacked;
  }
  if (!worksheetCount || offset !== endOffset) throw new Error('xlsx_invalid_archive');
  return zipSync(entries, { level: 0 });
}

function normalizeRows(rawRows) {
  if (!Array.isArray(rawRows) || rawRows.length < 2) {
    throw new Error('spreadsheet_empty');
  }

  const headers = rawRows[0].map(normalizeHeader);
  const nameIndex = headers.findIndex((header) => NAME_HEADERS.has(header));
  const referenceIndex = headers.findIndex((header) => REFERENCE_HEADERS.has(header));

  if (nameIndex < 0) throw new Error('spreadsheet_missing_name');

  const sourceRows = rawRows.slice(1).filter((row) => (
    Array.isArray(row) && row.some((cell) => String(cell ?? '').trim())
  ));
  if (sourceRows.length > MAX_IMPORT_ROWS) throw new Error('spreadsheet_too_many_rows');

  return sourceRows.map((row, index) => {
    const rawName = row[nameIndex];
    const rawReference = referenceIndex >= 0 ? row[referenceIndex] : null;
    const displayName = cleanText(rawName, 120);
    const externalReference = cleanText(rawReference, 80) || null;
    const errors = [];

    if (!displayName) errors.push('Informe um nome válido com até 120 caracteres.');
    if (rawReference && !externalReference) {
      errors.push('O identificador deve ter até 80 caracteres e não pode ser uma fórmula.');
    }
    if (rawName && typeof rawName === 'string' && /^[=+\-@]/.test(rawName.trim())) {
      errors.push('Fórmulas não são aceitas no campo de nome.');
    }

    return {
      rowNumber: index + 2,
      displayName,
      externalReference,
      errors,
    };
  });
}

async function parseStudentSpreadsheet(file) {
  return normalizeRows(await rowsFromFile(file));
}

function validateSubmittedRows(rows) {
  if (!Array.isArray(rows) || rows.length < 1 || rows.length > MAX_IMPORT_ROWS) {
    throw new Error('invalid_import_rows');
  }

  return rows.map((row, index) => {
    const displayName = cleanText(row?.displayName, 120);
    const externalReference = cleanText(row?.externalReference, 80) || null;
    const errors = [];
    if (!displayName) errors.push('Informe um nome válido com até 120 caracteres.');
    if (row?.externalReference && !externalReference) {
      errors.push('Informe um identificador válido com até 80 caracteres.');
    }
    return { rowNumber: index + 2, displayName, externalReference, errors };
  });
}

module.exports = {
  MAX_IMPORT_ROWS,
  validateXlsxArchive,
  normalizeRows,
  parseStudentSpreadsheet,
  validateSubmittedRows,
};
