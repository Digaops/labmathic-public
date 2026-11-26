const multer = require('multer');
const config = require('../config');
const { UploadValidationError } = require('../services/uploadContent');
const { PasswordOperationError } = require('../services/passwordOperations');
const { AiAuthoringError } = require('../services/aiAuthoring');

module.exports = function apiErrors(error, _req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof AiAuthoringError) return res.status(error.status).json({ error: error.message, code: error.code });
  if (error instanceof PasswordOperationError) {
    if (error.status === 503) res.setHeader('Retry-After', '3');
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (!config.isProduction && process.env.NODE_ENV !== 'test') console.error(error.stack);
  if (error instanceof UploadValidationError) {
    return res.status(error.status).json({ error: error.message, code: error.code });
  }
  if (error.message?.includes('Tipo de arquivo não permitido')) {
    return res.status(400).json({ error: error.message });
  }
  if (error instanceof multer.MulterError) {
    return res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400)
      .json({ error: 'Upload inválido ou acima dos limites permitidos.' });
  }
  if (['Unexpected end of form', 'Multipart: Boundary not found'].includes(error.message)) {
    return res.status(400).json({ error: 'Upload incompleto. Envie o arquivo novamente.' });
  }
  if ([400, 404, 413, 416].includes(error.status)) {
    return res.status(error.status).json({ error: 'Requisição inválida ou recurso indisponível.' });
  }
  return res.status(500).json({ error: 'Erro interno do servidor.' });
};
