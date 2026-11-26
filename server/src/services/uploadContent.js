const fs = require('node:fs/promises');
const path = require('node:path');
const { inflateRawSync } = require('node:zlib');
const policy = require('../../../shared/uploadPolicy.json');

const MiB = 1024 * 1024;
const TYPES = new Map(policy.groups.flatMap(group => group.extensions.map(ext => [ext, group.maxMiB * MiB])));
class UploadValidationError extends Error {
  constructor(code, message, status = 400) { super(message); this.code = code; this.status = status; }
}
function invalid() {
  throw new UploadValidationError('UPLOAD_CONTENT_MISMATCH', 'O conteúdo do arquivo não corresponde ao formato informado ou sua estrutura está incompleta. Exporte novamente e tente enviar.');
}
function uploadRule(filename, purpose = 'material') {
  const ext = path.extname(filename || '').toLowerCase();
  if (!TYPES.has(ext) || (purpose === 'image' && !policy.imageExtensions.includes(ext))) {
    throw new UploadValidationError('UPLOAD_EXTENSION', 'Tipo de arquivo não permitido para este campo.');
  }
  return { ext, maxBytes: TYPES.get(ext) };
}
function checkUploadSize(size, rule) {
  if (!size) throw new UploadValidationError('UPLOAD_EMPTY', 'O arquivo está vazio. Selecione um arquivo com conteúdo.');
  if (size > rule.maxBytes) throw new UploadValidationError('UPLOAD_TOO_LARGE', `Arquivos ${rule.ext.toUpperCase()} devem ter no máximo ${rule.maxBytes / MiB} MB.`, 413);
}
async function readAt(handle, size, offset, length) {
  if (offset < 0 || length < 0 || offset + length > size) invalid();
  const data = Buffer.alloc(length);
  let read = 0;
  while (read < length) {
    const result = await handle.read(data, read, length - read, offset + read);
    if (!result.bytesRead) invalid();
    read += result.bytesRead;
  }
  return data;
}
function utf8(buffer) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); } catch { return invalid(); }
}

// SAX parsing, no XML entity resolution, network requests, or DOM execution.
async function parseXml(text, onOpen, { onText = () => {}, onClose = () => {} } = {}) {
  const { Parser } = await import('saxen');
  const parser = new Parser();
  let depth = 0;
  let roots = 0;
  let count = 0;
  parser.on('error', invalid);
  parser.on('warn', invalid);
  parser.on('attention', invalid); // DTD / entity declarations
  parser.on('question', value => { if (!/^xml\s/i.test(value)) invalid(); });
  parser.on('text', (value, decode) => { if (depth === 0 && value.trim()) invalid(); onText(decode(value)); });
  parser.on('cdata', value => { if (!depth) invalid(); onText(value); });
  parser.on('openTag', (name, getAttrs, decode) => {
    if (++depth > 64 || ++count > 30000) invalid();
    if (depth === 1 && ++roots !== 1) invalid();
    const attrs = Object.fromEntries(Object.entries(getAttrs()).map(([key, value]) => [key, decode(value)]));
    onOpen(name, attrs, depth);
  });
  parser.on('closeTag', name => { depth -= 1; onClose(name); });
  parser.parse(text);
  if (depth !== 0 || roots !== 1) invalid();
}

const SVG_ELEMENTS = new Set(('svg g defs path rect circle ellipse line polyline polygon text tspan textPath title desc '
  + 'linearGradient radialGradient stop clipPath mask pattern marker use image symbol style').toLowerCase().split(' '));
function safeSvgCss(value) {
  // This is a deliberately restricted STATIC SVG profile, not a sanitizer.
  // Disallow CSS escapes, imports, active expressions and non-local URLs.
  if (/[\\@]|\/\*|(?:expression|image(?:-set)?|src)\s*\(|(?:javascript|https?|file|ftp)\s*:|behavior\s*:|-moz-binding/i.test(value)) invalid();
  const remaining = value.replace(/url\(\s*['"]?#[\w:.-]+['"]?\s*\)/gi, '');
  if (/url\s*\(/i.test(remaining)) invalid();
}
async function validateSvg(buffer) {
  const text = utf8(buffer);
  const stack = [];
  let css = '';
  await parseXml(text, (rawName, attrs, depth) => {
    const name = rawName.toLowerCase();
    if (stack.at(-1) === 'style') invalid();
    stack.push(name);
    if (!SVG_ELEMENTS.has(name) || (depth === 1 && name !== 'svg')) invalid();
    if (depth === 1 && attrs.xmlns !== 'http://www.w3.org/2000/svg') invalid();
    for (const [rawKey, value] of Object.entries(attrs)) {
      const key = rawKey.toLowerCase();
      if (key.split(':').at(-1).startsWith('on') || key === 'xml:base') invalid();
      if (key === 'xmlns' && value !== 'http://www.w3.org/2000/svg') invalid();
      if (key === 'href' || key.endsWith(':href')) {
        const local = /^#[\w:.-]+$/.test(value);
        const embedded = name === 'image' && /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/=\r\n]+$/i.test(value);
        if (!local && !embedded) invalid();
      } else if (!key.startsWith('xmlns')) safeSvgCss(value);
    }
  }, {
    onText(value) { if (stack.at(-1) === 'style') css += value; },
    onClose() { if (stack.pop() === 'style') { safeSvgCss(css); css = ''; } },
  });
}

const OFFICE = {
  '.docx': ['word/document.xml', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml'],
  '.xlsx': ['xl/workbook.xml', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml'],
  '.pptx': ['ppt/presentation.xml', 'application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml'],
};
async function validateOffice(handle, size, ext) {
  const tail = await readAt(handle, size, Math.max(0, size - 65557), Math.min(size, 65557));
  let end = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (tail.readUInt32LE(i) === 0x06054b50 && i + 22 + tail.readUInt16LE(i + 20) === tail.length) { end = i; break; }
  }
  if (end < 0) invalid();
  const count = tail.readUInt16LE(end + 10);
  const centralSize = tail.readUInt32LE(end + 12);
  const centralOffset = tail.readUInt32LE(end + 16);
  if (tail.readUInt16LE(end + 4) || tail.readUInt16LE(end + 6) || tail.readUInt16LE(end + 8) !== count
      || count < 3 || count > 4096 || centralSize > MiB
      || centralOffset + centralSize !== size - tail.length + end) invalid();
  const central = await readAt(handle, size, centralOffset, centralSize);
  const entries = new Map();
  let offset = 0;
  let expanded = 0;
  for (let i = 0; i < count; i++) {
    if (offset + 46 > central.length || central.readUInt32LE(offset) !== 0x02014b50) invalid();
    const flags = central.readUInt16LE(offset + 8);
    const method = central.readUInt16LE(offset + 10);
    const compressed = central.readUInt32LE(offset + 20);
    const original = central.readUInt32LE(offset + 24);
    const nameLength = central.readUInt16LE(offset + 28);
    const next = offset + 46 + nameLength + central.readUInt16LE(offset + 30) + central.readUInt16LE(offset + 32);
    const localOffset = central.readUInt32LE(offset + 42);
    if (next > central.length || (flags & 0x41) || ![0, 8].includes(method)
        || central.readUInt16LE(offset + 34) || localOffset + 30 + nameLength + compressed > centralOffset) invalid();
    const name = utf8(central.subarray(offset + 46, offset + 46 + nameLength));
    if (!name || /[\\\x00-\x1f:]/.test(name) || name.startsWith('/') || name.split('/').includes('..')
        || entries.has(name) || /vbaproject|macrosheets/i.test(name)) invalid();
    expanded += original;
    if (expanded > 500 * MiB) invalid();
    entries.set(name, { localOffset, compressed, original, method, flags });
    offset = next;
  }
  if (offset !== central.length) invalid();
  const [mainPart, contentType] = OFFICE[ext];
  for (const name of ['[Content_Types].xml', '_rels/.rels', mainPart]) {
    const entry = entries.get(name);
    if (!entry || !entry.original || !entry.compressed) invalid();
    const header = await readAt(handle, size, entry.localOffset, 30);
    if (header.readUInt32LE(0) !== 0x04034b50 || header.readUInt16LE(6) !== entry.flags
        || header.readUInt16LE(8) !== entry.method) invalid();
    const nameLength = header.readUInt16LE(26);
    const localName = await readAt(handle, size, entry.localOffset + 30, nameLength);
    if (utf8(localName) !== name) invalid();
    const dataOffset = entry.localOffset + 30 + nameLength + header.readUInt16LE(28);
    if (dataOffset + entry.compressed > centralOffset) invalid();
    if (name !== '[Content_Types].xml') continue;
    if (entry.original > 128 * 1024 || entry.compressed > 128 * 1024) invalid();
    const packed = await readAt(handle, size, dataOffset, entry.compressed);
    let xml;
    try { xml = entry.method === 0 ? packed : inflateRawSync(packed, { maxOutputLength: 128 * 1024 }); } catch { invalid(); }
    if (xml.length !== entry.original) invalid();
    let matches = false;
    await parseXml(utf8(xml), (name, attrs, depth) => {
      if (depth === 1 && (name !== 'Types' || attrs.xmlns !== 'http://schemas.openxmlformats.org/package/2006/content-types')) invalid();
      if (name === 'Override' && attrs.PartName === `/${mainPart}` && attrs.ContentType === contentType) matches = true;
      if (/macroenabled|vbaproject/i.test(attrs.ContentType || '')) invalid();
    });
    if (!matches) invalid();
  }
}

// Bounded signature/container checks, not an antivirus, a full decoder or CDR.
function binaryMatches(ext, head, tail, size) {
  const ascii = (start, end) => head.toString('latin1', start, end);
  const starts = hex => head.subarray(0, hex.length / 2).equals(Buffer.from(hex, 'hex'));
  if (ext === '.pdf') return /^%PDF-[12]\.\d/.test(ascii(0, 8)) && /%%EOF[\s\x00]*$/.test(tail.toString('latin1'));
  if (ext === '.png') return size >= 45 && starts('89504e470d0a1a0a') && ascii(12, 16) === 'IHDR'
    && head.readUInt32BE(8) === 13 && head.readUInt32BE(16) > 0 && head.readUInt32BE(20) > 0
    && head.readUInt32BE(16) <= 32768 && head.readUInt32BE(20) <= 32768
    && head.readUInt32BE(16) * head.readUInt32BE(20) <= 50_000_000 && tail.subarray(-12).equals(Buffer.from('0000000049454e44ae426082', 'hex'));
  if (ext === '.jpg' || ext === '.jpeg') return size >= 16 && starts('ffd8ff') && tail.subarray(-2).equals(Buffer.from('ffd9', 'hex'));
  if (ext === '.gif') return size >= 14 && /^GIF8[79]a$/.test(ascii(0, 6)) && head.readUInt16LE(6) > 0
    && head.readUInt16LE(8) > 0 && head.readUInt16LE(6) * head.readUInt16LE(8) <= 50_000_000 && tail.at(-1) === 0x3b;
  if (ext === '.webp') return size >= 20 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP'
    && ['VP8 ', 'VP8L', 'VP8X'].includes(ascii(12, 16)) && head.readUInt32LE(4) + 8 === size;
  if (['.doc', '.xls', '.ppt'].includes(ext)) return size >= 512 && starts('d0cf11e0a1b11ae1')
    && head.readUInt16LE(28) === 0xfffe && [9, 12].includes(head.readUInt16LE(30));
  if (ext === '.wav') return size >= 36 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE' && head.readUInt32LE(4) + 8 <= size;
  if (ext === '.mp3') return size >= 16 && ((ascii(0, 3) === 'ID3' && head[3] >= 2 && head[3] <= 4
    && head.subarray(6, 10).every(n => n < 128) && ((head[6] << 21) + (head[7] << 14) + (head[8] << 7) + head[9] + 10 < size))
    || (head[0] === 0xff && (head[1] & 0xe0) === 0xe0 && (head[1] & 6) !== 0 && (head[2] & 0xf0) !== 0xf0));
  if (ext === '.ogg') return size >= 28 && ascii(0, 4) === 'OggS' && head[4] === 0 && head[26] > 0;
  if (ext === '.webm') return size >= 16 && starts('1a45dfa3') && head.subarray(0, 4096).includes(Buffer.from('webm'));
  if (ext === '.mp4' || ext === '.mov') return size >= 16 && head.readUInt32BE(0) >= 8 && head.readUInt32BE(0) <= size
    && (ascii(4, 8) === 'ftyp' || (ext === '.mov' && ['moov', 'mdat', 'wide'].includes(ascii(4, 8))));
  return false;
}

async function validateUploadContent(file, purpose = 'material') {
  const rule = uploadRule(file.originalname, purpose);
  checkUploadSize(file.size, rule);
  const handle = await fs.open(file.path, 'r');
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size !== file.size) invalid();
    const size = stat.size;
    const head = await readAt(handle, size, 0, Math.min(65536, size));
    if (OFFICE[rule.ext]) {
      if (size < 22 || head.readUInt32LE(0) !== 0x04034b50) invalid();
      await validateOffice(handle, size, rule.ext);
    } else if (rule.ext === '.svg') {
      try { await validateSvg(await readAt(handle, size, 0, size)); }
      catch (error) {
        if (!(error instanceof UploadValidationError)) throw error;
        throw new UploadValidationError('UPLOAD_UNSAFE_SVG', 'Envie um SVG estático válido, sem scripts, animações, HTML ou recursos externos. Se necessário, exporte a imagem como PNG.');
      }
    } else if (rule.ext === '.txt' || rule.ext === '.csv') {
      const buffer = await readAt(handle, size, 0, size);
      // Accept UTF-8 and legacy Windows text; reject binary/control bytes. These
      // files remain protected, nosniff and sandboxed when served.
      if (buffer.some(byte => byte < 32 && ![9, 10, 12, 13].includes(byte))) invalid();
    } else {
      const tail = await readAt(handle, size, Math.max(0, size - 2048), Math.min(size, 2048));
      if (!binaryMatches(rule.ext, head, tail, size)) invalid();
    }
    const imageMime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
      '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' }[rule.ext];
    return { extension: rule.ext, imageMime, validation: 'signature-and-structure-v1' };
  } finally { await handle.close(); }
}

module.exports = { UploadValidationError, uploadRule, checkUploadSize, validateUploadContent };
