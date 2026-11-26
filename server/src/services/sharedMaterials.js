const db = require('../database');

function findActiveShare(token, materialId) {
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return null;
  const share = db.prepare('SELECT material_id, expires_at FROM share_links WHERE token = ?').get(token);
  if (!share || !Number.isFinite(Date.parse(share.expires_at)) || Date.parse(share.expires_at) <= Date.now()
      || (materialId !== undefined && share.material_id !== materialId)) return null;
  return share;
}

module.exports = { findActiveShare };
