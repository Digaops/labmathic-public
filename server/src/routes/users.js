const express = require('express');
const passwords = require('../services/passwordOperations');
const { passwordRoute, revalidatePasswordActor, unchangedPasswordUser } = require('../services/passwordAccess');
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivityStrict } = require('../helpers/activity');
const { readUsers, checkVersion, deletionBlock, roleChangeBlock, userId, fields, fail } = require('../services/userManagement');
const { teacherAccess } = require('../services/teacherAccess');

const router = express.Router();
router.use(authenticate, requireAdmin, (_req, res, next) => { res.set('Cache-Control', 'private, no-store'); next(); });
const safeMetadata = item => ({ name: item.name, email: item.email, role: item.role });
function audit(req, action, item, previous) {
  const verbs = { create_user: 'criou', update_user: 'atualizou', reset_user_password: 'redefiniu a senha de', delete_user: 'excluiu' };
  logActivityStrict({ user: req.user, action, module: 'users', entityType: 'user', entityId: item.id, entityTitle: item.name,
    description: `${req.user.name} ${verbs[action]} o usuário "${item.name}".`,
    metadata: previous ? { previous: safeMetadata(previous), current: safeMetadata(item) } : safeMetadata(item),
    isCritical: ['reset_user_password', 'delete_user'].includes(action) || (previous ? previous.role !== item.role : item.role === 'admin'), req });
}
function uniqueEmail(email, id = 0) {
  if (db.prepare('SELECT 1 FROM users WHERE LOWER(TRIM(email))=? AND id<>?').get(email, id)) fail(409, 'EMAIL_CONFLICT', 'Já existe uma conta com este e-mail.');
}
function validPassword(password) {
  if (typeof password !== 'string' || password.length < 8 || password.length > 1024) fail(400, 'INVALID_PASSWORD', 'A senha deve ter de 8 a 1024 caracteres.');
}

// Legacy array/fields remain available; versions are additive.
router.get('/', passwordRoute((_req, res) => res.json(readUsers(db))));
router.get('/:id/access-check', passwordRoute((req, res) => {
  res.set({ 'Surrogate-Control': 'no-store', Vary: 'Authorization' });
  const id = userId(req.params.id);
  if (Object.keys(req.query).length) fail(400, 'INVALID_QUERY', 'Esta consulta não aceita filtros.');
  const snapshot = db.transaction(() => {
    revalidatePasswordActor(req, true);
    const result = teacherAccess(db, id);
    // A consultation must not bump the account's edit version (entity_type=user).
    logActivityStrict({ user: req.user, action: 'check_teacher_access', module: 'users', entityType: 'user_access',
      entityId: id, entityTitle: result.user.name, description: 'Consultou as liberações de recursos de uma conta docente. Nenhuma permissão foi alterada.',
      metadata: { version: result.version, checkedAt: result.checkedAt, features: result.features, pilots: result.pilots }, req });
    return result;
  })();
  res.json(snapshot);
}));
router.get('/:id', passwordRoute((req, res) => {
  const item = readUsers(db, userId(req.params.id))[0]; checkVersion(item);
  res.json({ ...item, deletion_block: deletionBlock(db, item, req.user.id), role_change_block: roleChangeBlock(db, item) });
}));

router.post('/', passwordRoute(async (req, res) => {
  const data = fields(req.body); validPassword(req.body?.password); uniqueEmail(data.email);
  const hash = await passwords.hash(req.body.password, 10);
  const created = db.transaction(() => {
    revalidatePasswordActor(req, true); uniqueEmail(data.email);
    const result = db.prepare('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)').run(data.name, data.email, hash, data.role);
    const item = readUsers(db, Number(result.lastInsertRowid))[0]; audit(req, 'create_user', item);
    return readUsers(db, item.id)[0];
  }).immediate();
  res.status(201).json(created);
}));

router.put('/:id', passwordRoute((req, res) => {
  const id = userId(req.params.id);
  if (req.body?.password) fail(400, 'PASSWORD_SEPARATE', 'Use a ação Redefinir senha para trocar a senha desta conta.');
  const updated = db.transaction(() => {
    revalidatePasswordActor(req, true);
    const item = readUsers(db, id)[0]; checkVersion(item, req.body?.expectedVersion);
    const data = fields(req.body, item); uniqueEmail(data.email, id);
    const roleBlock = data.role !== item.role && roleChangeBlock(db, item);
    if (roleBlock) fail(409, 'ROLE_LINKED', roleBlock);
    if (item.role === 'admin' && data.role !== 'admin' && db.prepare("SELECT COUNT(*) AS n FROM users WHERE role='admin'").get().n <= 1) fail(409, 'LAST_ADMIN', 'Mantenha ao menos um administrador no sistema.');
    db.prepare('UPDATE users SET name=?,email=?,role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(data.name, data.email, data.role, id);
    audit(req, 'update_user', { ...item, ...data }, item);
    return readUsers(db, id)[0];
  }).immediate();
  res.json(updated);
}));

router.put('/:id/reset-password', passwordRoute(async (req, res) => {
  const id = userId(req.params.id); validPassword(req.body?.password);
  checkVersion(readUsers(db, id)[0], req.body?.expectedVersion);
  const previous = db.prepare('SELECT * FROM users WHERE id=?').get(id);
  const hash = await passwords.hash(req.body.password, 10);
  const updated = db.transaction(() => {
    revalidatePasswordActor(req, true); unchangedPasswordUser(db, previous);
    const item = readUsers(db, id)[0]; checkVersion(item, req.body?.expectedVersion);
    db.prepare('UPDATE users SET password=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hash, id);
    db.prepare('UPDATE password_reset_tokens SET used=1 WHERE user_id=?').run(id);
    audit(req, 'reset_user_password', item);
    return readUsers(db, id)[0];
  }).immediate();
  res.json({ message: 'Senha redefinida com sucesso.', user: updated });
}));

router.delete('/:id', passwordRoute((req, res) => {
  const id = userId(req.params.id);
  db.transaction(() => {
    revalidatePasswordActor(req, true);
    const item = readUsers(db, id)[0]; checkVersion(item, req.body?.expectedVersion);
    const block = deletionBlock(db, item, req.user.id);
    if (block) fail(id === req.user.id ? 400 : 409, 'USER_LINKED', block);
    db.prepare('DELETE FROM users WHERE id=?').run(id);
    audit(req, 'delete_user', item);
  }).immediate();
  res.json({ message: 'Usuário excluído com sucesso.', deleted: id });
}));
module.exports = router;
