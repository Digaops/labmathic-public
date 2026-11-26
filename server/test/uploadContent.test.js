const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { zipSync, strToU8 } = require('fflate');
const { uploadRule, checkUploadSize, validateUploadContent } = require('../src/services/uploadContent');
const policy = require('../../shared/uploadPolicy.json');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-upload-content-'));
test.after(() => fs.rmSync(temp, { recursive: true, force: true }));
let sequence = 0;
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aXioAAAAASUVORK5CYII=', 'base64');
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20"><defs><linearGradient id="g"><stop offset="0" stop-color="#fff"/></linearGradient></defs><rect width="20" height="20" fill="url(#g)"/><text>Matemática &amp; ciência</text></svg>';
function stored(name, data) {
  const buffer = Buffer.from(data);
  const filename = path.join(temp, String(++sequence));
  fs.writeFileSync(filename, buffer);
  return { path: filename, originalname: name, size: buffer.length };
}
function office(ext, extra = {}, declaredType) {
  const types = {
    docx: ['word/document.xml', 'wordprocessingml.document'],
    xlsx: ['xl/workbook.xml', 'spreadsheetml.sheet'],
    pptx: ['ppt/presentation.xml', 'presentationml.presentation'],
  };
  const [main, mime] = types[ext];
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8(`<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/${main}" ContentType="${declaredType || `application/vnd.openxmlformats-officedocument.${mime}.main+xml`}"/></Types>`),
    '_rels/.rels': strToU8('<Relationships/>'),
    [main]: strToU8('<document/>'), ...extra,
  }));
}

test('limites por formato aceitam a fronteira exata e recusam o próximo byte', () => {
  for (const { extensions, maxMiB } of policy.groups) {
    for (const ext of extensions) {
      const rule = uploadRule(`Material${ext.toUpperCase()}`);
      assert.equal(rule.maxBytes, maxMiB * 1024 * 1024);
      assert.doesNotThrow(() => checkUploadSize(rule.maxBytes, rule));
      assert.throws(() => checkUploadSize(rule.maxBytes + 1, rule), error => error.status === 413);
      assert.throws(() => checkUploadSize(0, rule), error => error.code === 'UPLOAD_EMPTY');
    }
  }
  for (const name of ['document.pdf', 'video.mp4', 'planilha.xlsx']) assert.throws(() => uploadRule(name, 'image'));
  for (const name of ['.hidden', 'foto.png.exe', 'virus.exe', 'sem-extensao']) assert.throws(() => uploadRule(name));
});

test('PNG válido passa, PNG truncado ou conteúdo renomeado é recusado', async () => {
  assert.equal((await validateUploadContent(stored('Foto.PNG', PNG), 'image')).imageMime, 'image/png');
  for (const content of ['<html><script>alert(1)</script></html>', 'MZ executable', '%PDF-1.7', PNG.subarray(0, 24)]) {
    await assert.rejects(validateUploadContent(stored('foto.png', content), 'image'), error => error.code === 'UPLOAD_CONTENT_MISMATCH');
  }
  const bomb = Buffer.from(PNG); bomb.writeUInt32BE(999999, 16);
  await assert.rejects(validateUploadContent(stored('gigante.png', bomb)));
});

test('PDF exige assinatura e marcador final; texto renomeado não passa', async () => {
  await validateUploadContent(stored('aula.pdf', '%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n'));
  for (const content of ['%PDF-1.7 sem fechamento', '<html>PDF</html>', PNG]) {
    await assert.rejects(validateUploadContent(stored('aula.pdf', content)));
  }
});

test('SVG estático com referências internas passa sem buscar recursos externos', async () => {
  await validateUploadContent(stored('grafico.svg', SVG), 'image');
});

for (const fragment of [
  '<script>alert(1)</script>', '<rect onload="alert(1)"/>', '<foreignObject><div>HTML</div></foreignObject>',
  '<image href="https://example.invalid/a.png"/>', '<use href="javascript:alert(1)"/>',
  '<rect fill="url(https://example.invalid/a.svg)"/>', '<rect style="fill:u&#114;l(https://example.invalid/a.svg)"/>',
  '<rect style="fill:u\\72l(https://example.invalid/a.svg)"/>', '<animate attributeName="href"/>',
  '<style>svg { background-image: image-set("//example.invalid/a.png" 1x); }</style>',
  '</svg><svg xmlns="http://www.w3.org/2000/svg">', '<g>',
]) {
  test(`SVG recusa estrutura/conteúdo não estático: ${fragment.slice(0, 46)}`, async () => {
    await assert.rejects(validateUploadContent(stored('teste.svg', `<svg xmlns="http://www.w3.org/2000/svg">${fragment}</svg>`), 'image'));
  });
}
test('SVG recusa DTD e instrução para carregar stylesheet', async () => {
  for (const prefix of ['<!DOCTYPE svg [<!ENTITY x SYSTEM "file:///secret">]>', '<?xml-stylesheet href="https://example.invalid/a.css"?>']) {
    await assert.rejects(validateUploadContent(stored('teste.svg', prefix + SVG)));
  }
});

for (const ext of ['docx', 'xlsx', 'pptx']) {
  test(`${ext}: identifica estrutura interna sem extrair o documento`, async () => {
    await validateUploadContent(stored(`aula.${ext}`, office(ext)));
    await assert.rejects(validateUploadContent(stored(`aula.${ext}`, office(ext === 'docx' ? 'xlsx' : 'docx'))));
    await assert.rejects(validateUploadContent(stored(`aula.${ext}`, zipSync({ 'arquivo.txt': strToU8('qualquer zip') }))));
    await assert.rejects(validateUploadContent(stored(`aula.${ext}`, office(ext, { 'word/vbaProject.bin': strToU8('macro') }))));
    await assert.rejects(validateUploadContent(stored(`aula.${ext}`, office(ext, { '../fora.txt': strToU8('traversal') }))));
  });
}
test('OOXML rejeita expansão excessiva e metadados comprimidos que mentem sobre seu tamanho', async () => {
  const bomb = office('docx', { 'word/extra.xml': strToU8('x') });
  let entry = bomb.indexOf(Buffer.from('504b0102', 'hex'));
  bomb.writeUInt32LE(600 * 1024 * 1024, entry + 24);
  await assert.rejects(validateUploadContent(stored('bomba.docx', bomb)));
  const oversized = office('docx', { '[Content_Types].xml': strToU8('a'.repeat(1024 * 1024)) });
  entry = oversized.indexOf(Buffer.from('504b0102', 'hex'));
  oversized.writeUInt32LE(100, entry + 24);
  await assert.rejects(validateUploadContent(stored('mentira.docx', oversized)));
});

test('textos UTF-8/Windows comuns passam, arquivos vazios e binários não', async () => {
  await validateUploadContent(stored('aula.txt', 'Conteúdo de Matemática\n'));
  await validateUploadContent(stored('aula.csv', Buffer.from('Nome;Matrícula\r\nJoão;001', 'latin1')));
  await assert.rejects(validateUploadContent(stored('vazio.txt', '')), error => error.code === 'UPLOAD_EMPTY');
  await assert.rejects(validateUploadContent(stored('binario.csv', Buffer.from([65, 0, 66]))));
});

test('famílias binárias legadas e de mídia mantêm suas assinaturas reconhecidas', async () => {
  const cfb = Buffer.alloc(512); Buffer.from('d0cf11e0a1b11ae1', 'hex').copy(cfb); cfb.writeUInt16LE(0xfffe, 28); cfb.writeUInt16LE(9, 30);
  for (const ext of ['doc', 'xls', 'ppt']) await validateUploadContent(stored(`legado.${ext}`, cfb));
  const wav = Buffer.alloc(44); wav.write('RIFF'); wav.writeUInt32LE(36, 4); wav.write('WAVE', 8);
  await validateUploadContent(stored('audio.wav', wav));
  const mp3 = Buffer.alloc(20); mp3.write('ID3'); mp3[3] = 4;
  await validateUploadContent(stored('audio.mp3', mp3));
  const ogg = Buffer.alloc(40); ogg.write('OggS'); ogg[26] = 1;
  await validateUploadContent(stored('video.ogg', ogg));
  const webm = Buffer.concat([Buffer.from('1a45dfa3', 'hex'), Buffer.from('synthetic webm header')]);
  await validateUploadContent(stored('video.webm', webm));
  const mp4 = Buffer.alloc(32); mp4.writeUInt32BE(32); mp4.write('ftyp', 4); mp4.write('isom', 8);
  for (const ext of ['mp4', 'mov']) await validateUploadContent(stored(`video.${ext}`, mp4));
  const jpg = Buffer.concat([Buffer.from('ffd8ff', 'hex'), Buffer.alloc(20), Buffer.from('ffd9', 'hex')]);
  await validateUploadContent(stored('foto.jpeg', jpg));
  const gif = Buffer.from('47494638396101000100800000000000ffffff2c00000000010001000002024401003b', 'hex');
  await validateUploadContent(stored('foto.gif', gif));
  const webp = Buffer.alloc(24); webp.write('RIFF'); webp.writeUInt32LE(16, 4); webp.write('WEBPVP8 ', 8);
  await validateUploadContent(stored('foto.webp', webp));
});

test('vídeo grande usa leituras limitadas e não carrega todo o conteúdo em memória', async () => {
  const file = stored('video.mp4', Buffer.alloc(32));
  const fd = fs.openSync(file.path, 'r+');
  try {
    const header = Buffer.alloc(32); header.writeUInt32BE(32); header.write('ftypisom', 4);
    fs.writeSync(fd, header, 0, header.length, 0); fs.ftruncateSync(fd, 110 * 1024 * 1024);
  } finally { fs.closeSync(fd); }
  file.size = 110 * 1024 * 1024;
  let bytesRead = 0;
  const open = fs.promises.open;
  const original = await open(file.path, 'r');
  const wrapped = { stat: () => original.stat(), close: () => original.close(), read: async (...args) => {
    const result = await original.read(...args); bytesRead += result.bytesRead; return result;
  } };
  const mock = test.mock.method(fs.promises, 'open', async () => wrapped);
  try { await validateUploadContent(file); } finally { mock.mock.restore(); }
  assert.ok(bytesRead <= 65536 + 2048, `${bytesRead} bytes lidos`);
});
