const fs = require('node:fs');
const path = require('node:path');

const sqliteSignature = Buffer.from('SQLite format 3\0');

function startupError(message) {
  const error = new Error(message);
  error.releaseSafe = true;
  return error;
}

function assertProductionStartup({ dbPath, uploadDir }, clientDist) {
  try {
    const databaseStat = fs.statSync(dbPath);
    if (!databaseStat.isFile() || databaseStat.size < 100) throw new Error();
    const fd = fs.openSync(dbPath, 'r');
    try {
      const header = Buffer.alloc(sqliteSignature.length);
      if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(sqliteSignature)) {
        throw new Error();
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    throw startupError('DB_PATH deve apontar para um arquivo SQLite existente e legível.');
  }

  try {
    if (!fs.statSync(uploadDir).isDirectory()) throw new Error();
    fs.accessSync(uploadDir, fs.constants.R_OK | fs.constants.W_OK | fs.constants.X_OK);
  } catch {
    throw startupError('UPLOAD_DIR deve apontar para um diretório persistente existente e acessível.');
  }

  try {
    const html = fs.readFileSync(path.join(clientDist, 'index.html'), 'utf8');
    const assets = Array.from(html.matchAll(/\b(?:src|href)=["'](\/assets\/[\w.-]+)["']/g), ([, asset]) => asset);
    if (!/<script\b[^>]*\bsrc=["']\/assets\/[\w.-]+\.js["']/.test(html)) throw new Error();
    for (const asset of new Set(assets)) {
      const stat = fs.statSync(path.join(clientDist, asset));
      if (!stat.isFile() || stat.size === 0) throw new Error();
    }
  } catch {
    throw startupError('Build do frontend ausente ou incompleto. Execute o build da revisão antes de iniciar.');
  }
}

module.exports = { assertProductionStartup };
