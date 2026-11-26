const { createHash } = require('node:crypto');
const { PasswordOperationError } = require('./passwordOperations');
const fail = (status, code, message) => { throw new PasswordOperationError(status, code, message); };
const quote = s => '"' + s.replaceAll('"', '""') + '"';
const linksCache = new WeakMap();

function readUsers(db, id) {
  // Never select or expose a password hash. auth_version changes when credentials change.
  const rows = db.prepare(`SELECT id,name,email,role,created_at,updated_at,auth_version FROM users${id ? ' WHERE id=?' : ''} ORDER BY name,id`).all(...(id ? [id] : []));
  const audits = new Map(db.prepare(`SELECT entity_id,MAX(id) AS revision FROM activity_log WHERE entity_type='user' AND module='users'${id ? ' AND entity_id=?' : ''} GROUP BY entity_id`).all(...(id ? [id] : [])).map(r => [r.entity_id, r.revision]));
  return rows.map(row => {
    const version = createHash('sha256').update(JSON.stringify([row, audits.get(row.id) || 0])).digest('hex');
    const { auth_version, updated_at, ...safe } = row;
    return { ...safe, version };
  });
}
function checkVersion(item, expected) {
  if (!item) fail(404, 'USER_MISSING', 'Esta conta não está mais disponível. Atualize a lista.');
  if (expected === undefined) return; // Compatibility with existing clients.
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail(400, 'INVALID_VERSION', 'Confira a conta novamente antes de continuar.');
  if (item.version !== expected) fail(409, 'USER_CHANGED', 'Esta conta mudou. Nada foi alterado neste envio. Confira os dados atuais.');
}
function userReferences(db) {
  const schema = db.pragma('schema_version', { simple: true });
  let cached = linksCache.get(db);
  if (!cached || cached.schema !== schema) {
    const links = [];
    for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const fk of db.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name)) {
        if (fk.table === 'users') links.push({ table: name, column: fk.from, parentColumn: fk.to || 'id' });
      }
    }
    cached = { schema, links }; linksCache.set(db, cached);
  }
  return cached.links;
}
function deletionBlock(db, item, actorId) {
  if (item.id === actorId) return 'Você não pode excluir sua própria conta.';
  if (item.role === 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n <= 1) return 'Mantenha ao menos um administrador no sistema.';
  for (const ref of userReferences(db)) {
    // Unknown future keys must fail closed, not silently allow destructive cascades.
    if (ref.parentColumn !== 'id') return 'A estrutura dos vínculos mudou. A exclusão precisa de revisão técnica.';
    if (db.prepare(`SELECT 1 FROM ${quote(ref.table)} WHERE ${quote(ref.column)}=? LIMIT 1`).get(item.id)) return 'Esta conta tem dados ou histórico vinculados e não pode ser excluída por aqui. Nada será apagado.';
  }
  return null;
}
function userId(value) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'INVALID_USER', 'Conta inválida. Atualize a lista.');
  return Number(value);
}
function roleChangeBlock(db, item) {
  return item.role === 'professor' && db.prepare('SELECT 1 FROM teacher_grade_preference_profiles WHERE teacher_id=?').get(item.id)
    ? 'Esta pessoa já configurou seus anos escolares. A troca para administrador precisa de revisão para preservar essa configuração.' : null;
}
function fields(body, previous) {
  const name = body?.name ?? previous?.name, email = body?.email ?? previous?.email, role = body?.role ?? previous?.role ?? 'professor';
  if (typeof name !== 'string' || !name.trim() || name.trim().length > 100) fail(400, 'INVALID_NAME', 'Informe um nome com até 100 caracteres.');
  if (typeof email !== 'string' || email.trim().length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())) fail(400, 'INVALID_EMAIL', 'Informe um e-mail válido.');
  if (!['professor', 'admin'].includes(role)) fail(400, 'INVALID_ROLE', 'Escolha Professor(a) ou Administrador(a).');
  return { name: name.trim(), email: email.trim().toLowerCase(), role };
}
module.exports = { readUsers, checkVersion, deletionBlock, roleChangeBlock, userId, fields, fail };
