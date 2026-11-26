const { createHash } = require('node:crypto');

// Optimistic precondition for new deletion clients. Not an authorization token.
function materialDeletionVersion(db, material) {
  const topicIds = db.prepare('SELECT topic_id FROM material_topics WHERE material_id=? ORDER BY topic_id').pluck().all(material.id);
  const collectionIds = db.prepare('SELECT collection_id FROM collection_items WHERE material_id=? ORDER BY collection_id').pluck().all(material.id);
  return createHash('sha256').update(JSON.stringify({ material, topicIds, collectionIds })).digest('hex');
}
function checkDeletionVersion(db, material, version) {
  if (version === undefined) return; // Legacy callers retain their existing contract.
  if (typeof version !== 'string' || !/^[a-f0-9]{64}$/.test(version)) throw Object.assign(new Error('Conferência de exclusão inválida.'), { status: 400 });
  if (!material || materialDeletionVersion(db, material) !== version) throw Object.assign(new Error('O material mudou ou foi removido. Atualize a conferência antes de excluir.'), { status: 409 });
}
module.exports = { materialDeletionVersion, checkDeletionVersion };
