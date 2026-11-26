const express = require('express');
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const { logActivityStrict } = require('../helpers/activity');
const { definitions, definition, readCategories, checkVersion, categoryFields, fail } = require('../services/categoryManagement');

const router = express.Router();
router.use(authenticate, (_req, res, next) => { res.setHeader('Cache-Control', 'private, no-store'); next(); });
const idFor = value => {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) fail(400, 'invalid_id', 'Categoria inválida.');
  return Number(value);
};
function handle(callback) {
  return (req, res, next) => {
    try { callback(req, res); }
    catch (error) {
      if (error.status) return res.status(error.status).json({ error: error.message, code: error.code });
      if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ code: 'duplicate_category', error: 'Já existe uma categoria com esse nome nesta área.' });
      if (error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY') return res.status(409).json({ code: 'category_in_use', error: 'Esta categoria está em uso e não pode ser excluída.' });
      next(error);
    }
  };
}
router.get('/management/:kind', requireAdmin, handle((req, res) => {
  definition(req.params.kind);
  res.json({ kind: req.params.kind, items: db.transaction(() => readCategories(db, req.params.kind))() });
}));
router.get('/management/:kind/:id', requireAdmin, handle((req, res) => {
  const id = idFor(req.params.id);
  const item = db.transaction(() => readCategories(db, req.params.kind, id)[0])();
  checkVersion(item);
  res.json({ kind: req.params.kind, item });
}));
router.get('/topics/search', handle((req, res) => {
  const q = req.query.q ?? '';
  if (typeof q !== 'string' || q.length > 200) fail(400, 'invalid_search', 'Busca inválida.');
  res.json(db.prepare('SELECT id,name FROM topics WHERE name LIKE ? ORDER BY name LIMIT 20').all('%' + q + '%'));
}));

for (const [kind, { table, label }] of Object.entries(definitions)) {
  // Teacher-facing lists retain the original array and material_count fields.
  router.get('/' + kind, handle((_req, res) => {
    const topics = kind === 'topics';
    res.json(db.prepare('SELECT c.*,COUNT(m.' + (topics ? 'material_id' : 'id') + ') AS material_count FROM ' + table + ' c LEFT JOIN '
      + (topics ? 'material_topics m ON m.topic_id' : 'materials m ON m.' + ({ disciplines: 'discipline_id', grades: 'grade_id', 'material-types': 'material_type_id' })[kind])
      + '=c.id GROUP BY c.id ORDER BY ' + (kind === 'grades' ? 'c.sort_order,' : '') + 'c.name').all());
  }));
  const audit = (req, action, before, after) => logActivityStrict({
    user: req.user, action: action + '_category', module: 'admin', entityType: 'category_' + table,
    entityId: after?.id || before.id, entityTitle: after?.name || before.name,
    description: label + (action === 'create' ? ' cadastrada.' : action === 'update' ? ' atualizada.' : ' excluída sem vínculos.'),
    metadata: { category_kind: kind, before, after }, isCritical: action === 'delete', req,
  }, db);

  router.post('/' + kind, requireAdmin, handle((req, res) => {
    const item = db.transaction(() => {
      const fields = categoryFields(kind, req.body);
      const columns = Object.keys(fields);
      const id = Number(db.prepare('INSERT INTO ' + table + ' (' + columns.join(',') + ') VALUES (' + columns.map(() => '?').join(',') + ')').run(...Object.values(fields)).lastInsertRowid);
      audit(req, 'create', null, { id, ...fields });
      return readCategories(db, kind, id)[0];
    }).immediate();
    res.status(201).json(item);
  }));
  router.put('/' + kind + '/:id', requireAdmin, handle((req, res) => {
    const id = idFor(req.params.id);
    const item = db.transaction(() => {
      const before = readCategories(db, kind, id)[0];
      checkVersion(before, req.body?.expectedVersion);
      const fields = categoryFields(kind, req.body, before);
      db.prepare('UPDATE ' + table + ' SET ' + Object.keys(fields).map(key => key + '=?').join(',') + ' WHERE id=?').run(...Object.values(fields), id);
      audit(req, 'update', before, { id, ...fields });
      return readCategories(db, kind, id)[0];
    }).immediate();
    res.json(item);
  }));
  router.delete('/' + kind + '/:id', requireAdmin, handle((req, res) => {
    const id = idFor(req.params.id);
    db.transaction(() => {
      const before = readCategories(db, kind, id)[0];
      checkVersion(before, req.body?.expectedVersion);
      if (before.material_count || before.other_usage_count) fail(400, 'category_in_use',
        'Esta categoria está em uso. Ela será mantida para preservar os materiais e os demais vínculos.');
      db.prepare('DELETE FROM ' + table + ' WHERE id=?').run(id);
      audit(req, 'delete', before, null);
    }).immediate();
    res.json({ message: label + ' excluída.', deleted: id });
  }));
}
module.exports = router;
