const fs = require('fs');

const ALLOWED_KEYS = new Set(['sourceSha', 'pullRequest', 'targetBranch', 'schemaVersion', 'preparation']);

function validPreparation(preparation, schemaVersion) {
  if (!preparation || Array.isArray(preparation) || typeof preparation !== 'object'
      || typeof preparation.teacherHash !== 'string' || !/^[0-9a-f]{64}$/.test(preparation.teacherHash)
      || !Number.isSafeInteger(schemaVersion)) return false;
  const keys = Object.keys(preparation).sort().join(',');
  if (preparation.version === 1) return keys === 'teacherHash,version' && schemaVersion >= 26;
  return preparation.version === 2 && schemaVersion >= 39
    && keys === 'numericReviewerHash,teacherHash,version'
    && typeof preparation.numericReviewerHash === 'string'
    && /^[0-9a-f]{64}$/.test(preparation.numericReviewerHash)
    && preparation.numericReviewerHash !== preparation.teacherHash;
}

function readDeploymentMetadata(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const stats = fs.lstatSync(filePath);
  if (!stats.isFile() || stats.isSymbolicLink() || stats.size > 4096) {
    throw new Error('arquivo ausente, simbólico ou maior que o limite');
  }

  const metadata = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  if (!metadata || Array.isArray(metadata) || typeof metadata !== 'object') {
    throw new Error('estrutura inválida');
  }
  if (Object.keys(metadata).some((key) => !ALLOWED_KEYS.has(key))) {
    throw new Error('campo não permitido');
  }
  if (!/^[0-9a-f]{40}$/.test(metadata.sourceSha || '')) {
    throw new Error('sourceSha inválido');
  }
  if (!Number.isSafeInteger(metadata.pullRequest) || metadata.pullRequest < 1) {
    throw new Error('pullRequest inválido');
  }
  if (metadata.targetBranch !== 'homologacao') {
    throw new Error('targetBranch inválida');
  }
  if (metadata.schemaVersion !== undefined
      && (!Number.isSafeInteger(metadata.schemaVersion) || metadata.schemaVersion < 1)) {
    throw new Error('schemaVersion inválida');
  }

  if (metadata.preparation !== undefined) {
    const preparation = metadata.preparation;
    if (!validPreparation(preparation, metadata.schemaVersion)) {
      throw new Error('preparação do piloto inválida');
    }
    Object.freeze(preparation);
  }
  return Object.freeze({ ...metadata });
}

module.exports = { readDeploymentMetadata, validPreparation };
