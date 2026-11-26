// Data only for the disposable, opt-in interactive host. Not a migration.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
function seedMaterialFormats({ db, admin, uploadDir }) {
  assert.equal(process.env.MATERIAL_FORMATS_AUDIT, '1');
  assert.equal(process.env.PLATFORM_JOURNEY_AUDIT, '1');
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  assert.equal(path.dirname(uploadDir), path.dirname(db.name));
  assert.ok(fs.existsSync(path.join(uploadDir, 'layout-fixture.pdf')));
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="320" viewBox="0 0 640 320"><rect width="640" height="320" fill="#f8fafc"/><text x="40" y="55" font-size="24" fill="#0f172a">Comparando partes iguais - teste</text><rect x="40" y="100" width="180" height="150" fill="#1d4ed8"/><rect x="220" y="100" width="180" height="150" fill="#10b981"/><rect x="400" y="100" width="180" height="150" fill="#f59e0b"/></svg>';
  fs.writeFileSync(path.join(uploadDir, 'format-qa-image.svg'), svg, { flag: 'wx' });
  fs.writeFileSync(path.join(uploadDir, 'format-qa-notes.txt'), 'Material sintético sem prévia.\n', { flag: 'wx' });
  const category = icon => Number(db.prepare('INSERT INTO material_types(name,icon) VALUES (?,?)').run('Formato QA · categoria ' + icon, icon).lastInsertRowid);
  const pdfCategory = category('pdf'), videoCategory = category('video');
  const cases = [
    ['pdf', 'PDF com categoria de vídeo', 'layout-fixture.pdf', 'PDF', videoCategory, null],
    ['image', 'Imagem com categoria de PDF', 'format-qa-image.svg', 'SVG', pdfCategory, null],
    ['missing', 'Vídeo temporariamente indisponível', 'format-qa-missing.webm', 'WEBM', pdfCategory, null],
    ['document', 'Arquivo sem prévia', 'format-qa-notes.txt', 'TXT', pdfCategory, null],
    ['youtube', 'Vídeo do YouTube com categoria de PDF', null, 'PDF', pdfCategory, 'https://youtu.be/abcdefghijk'],
    ['external', 'Material em outro site', null, null, videoCategory, 'https://example.invalid/recurso'],
  ];
  const result = { pdfCategory, videoCategory, cases: {} };
  for (const [key, title, file, format, categoryId, external] of cases) {
    const id = Number(db.prepare('INSERT INTO materials(title,file_path,file_format,material_type_id,external_url,created_by) VALUES (?,?,?,?,?,?)')
      .run('Formato QA · ' + title, file, format, categoryId, external, admin.id).lastInsertRowid);
    const token = randomBytes(32).toString('hex');
    db.prepare('INSERT INTO share_links(material_id,token,expires_at,created_by) VALUES (?,?,?,?)').run(id, token, new Date(Date.now() + 3600000).toISOString(), admin.id);
    result.cases[key] = { id, title: 'Formato QA · ' + title, file, token };
  }
  return result;
}
module.exports = { seedMaterialFormats };
