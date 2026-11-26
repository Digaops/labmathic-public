const multer = require('multer');
const path = require('node:path');
const fs = require('node:fs');
const { Transform, pipeline } = require('node:stream');
const { randomUUID } = require('node:crypto');
const config = require('../config');
const { verifyUserToken } = require('../services/authSessions');
const { logActivity } = require('../helpers/activity');
const { UploadValidationError, uploadRule, checkUploadSize, validateUploadContent } = require('../services/uploadContent');

fs.mkdirSync(config.uploadDir, { recursive: true });

// Only for files created by this storage engine and not yet handed to a route.
function removePending(file, callback) {
  if (!file?.path || path.dirname(path.resolve(file.path)) !== path.resolve(config.uploadDir)
      || !/^[a-f0-9-]{36}\.[a-z0-9]+$/i.test(path.basename(file.path))) {
    return callback(new Error('Invalid pending upload path.'));
  }
  fs.unlink(file.path, error => callback(error?.code === 'ENOENT' ? null : error));
}

function createUpload(purpose) {
  const storage = {
    _handleFile(req, file, callback) {
      const rule = uploadRule(file.originalname, purpose);
      const filename = `${randomUUID()}${rule.ext}`;
      const filePath = path.join(config.uploadDir, filename);
      let size = 0;
      let opened = false;
      const destination = fs.createWriteStream(filePath, { flags: 'wx' });
      destination.once('open', () => { opened = true; });
      const counter = new Transform({
        transform(chunk, _encoding, done) {
          size += chunk.length;
          try { checkUploadSize(size, rule); done(null, chunk); } catch (error) { done(error); }
        },
      });
      pipeline(file.stream, counter, destination, error => {
        if (!error) return callback(null, { destination: config.uploadDir, filename, path: filePath, size });
        // Never unlink an existing file if exclusive creation failed.
        if (!opened) return callback(error);
        removePending({ path: filePath }, cleanupError => callback(cleanupError || error));
      });
    },
    _removeFile(_req, file, callback) { removePending(file, callback); },
  };
  const parser = multer({
    storage,
    fileFilter(_req, file, callback) {
      try { uploadRule(file.originalname, purpose); callback(null, true); } catch (error) { callback(error); }
    },
    limits: { fileSize: (purpose === 'image' ? 10 : 500) * 1024 * 1024 + 1,
      files: 1, fields: 40, parts: 42, fieldSize: 1024 * 1024 },
  });
  return {
    single(field) {
      const parse = parser.single(field);
      return (req, res, next) => {
        parse(req, res, async error => {
          try {
            if (error) throw error;
            if (req.file) {
              req.file.contentValidation = await validateUploadContent(req.file, purpose);
              if (req.file.contentValidation.imageMime) req.file.mimetype = req.file.contentValidation.imageMime;
            }
            // Recheck after upload: logout/password/role may change in transit.
            try {
              req.user = verifyUserToken(req.authToken).user;
            } catch (error) {
              if (error.code?.startsWith('SQLITE_')) throw error;
              throw new UploadValidationError('UPLOAD_SESSION_EXPIRED', 'Sua sessão expirou. Entre novamente antes de salvar.', 401);
            }
            if (req.aborted || res.destroyed) throw new Error('Upload request disconnected.');
          } catch (failure) {
            if (req.file) {
              try { await new Promise((resolve, reject) => removePending(req.file, err => err ? reject(err) : resolve())); }
              catch { console.error('Falha ao limpar upload pendente; necessária conferência operacional.'); }
              delete req.file;
            }
            logActivity({ user: req.user, action: 'upload_rejected', module: 'uploads',
              description: 'Envio de arquivo recusado antes de alterar o acervo.',
              metadata: { purpose, code: failure instanceof UploadValidationError || failure instanceof multer.MulterError ? failure.code : 'UPLOAD_FAILED' }, req });
            return next(failure);
          }
          return next();
        });
      };
    },
  };
}

module.exports = createUpload('material');
module.exports.images = createUpload('image');
