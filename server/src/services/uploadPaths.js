const fs = require('node:fs');
const path = require('node:path');
const config = require('../config');

function existingUploadPath(value) {
  if (typeof value !== 'string') return null;
  const filename = value.replace(/^\/uploads\//, '');
  if (!filename || filename.startsWith('.') || /[/\\\x00-\x1f]/.test(filename)) return null;
  try {
    const root = fs.realpathSync(config.uploadDir);
    const real = fs.realpathSync(path.join(root, filename));
    return real.startsWith(root + path.sep) && fs.statSync(real).isFile() ? real : null;
  } catch (error) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return null;
    throw error;
  }
}

module.exports = { existingUploadPath };
