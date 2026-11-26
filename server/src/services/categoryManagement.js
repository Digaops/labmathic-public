const { createHash } = require('node:crypto');
const definitions = Object.freeze({
  disciplines: { table: 'disciplines', label: 'Disciplina' },
  grades: { table: 'grades', label: 'Ano escolar' },
  topics: { table: 'topics', label: 'Assunto' },
  'material-types': { table: 'material_types', label: 'Tipo de material' },
});
const fail = (status, code, message) => { throw Object.assign(new Error(message), { status, code }); };
const quote = value => '"' + value.replaceAll('"', '""') + '"';
const cache = new WeakMap();
function definition(kind) {
  if (!Object.hasOwn(definitions, kind)) fail(404, 'category_missing', 'Área de organização não encontrada.');
  return definitions[kind];
}

// Discover actual foreign keys, including CASCADE/SET NULL. Never rely only on material counts.
// Schema metadata is cached; usage itself is always read inside the current transaction.
function references(database, table) {
  const schema = database.pragma('schema_version', { simple: true });
  let saved = cache.get(database);
  if (!saved || saved.schema !== schema) {
    const links = [];
    for (const { name } of database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) {
      for (const fk of database.prepare('SELECT * FROM pragma_foreign_key_list(?)').all(name)) {
        if (Object.values(definitions).some(d => d.table === fk.table)) {
          // All current category references target their integer id. A future schema must not
          // silently count references to a different key as zero and permit a cascade.
          if (fk.to && fk.to !== 'id') throw Error('Referência de categoria não suportada; necessária revisão do schema.');
          links.push({ table: name, column: fk.from, parent: fk.table });
        }
      }
    }
    saved = { schema, links }; cache.set(database, saved);
  }
  return saved.links.filter(r => r.parent === table).filter((r, i, all) => all.findIndex(s => s.table === r.table && s.column === r.column) === i);
}
function usage(database, table, id) {
  const totals = new Map();
  for (const ref of references(database, table)) {
    const rows = database.prepare(`SELECT ${quote(ref.column)} AS id, COUNT(*) AS n FROM ${quote(ref.table)}
      WHERE ${quote(ref.column)} ${id ? '= ?' : 'IS NOT NULL'} GROUP BY ${quote(ref.column)}`).all(...(id ? [id] : []));
    for (const row of rows) {
      const count = totals.get(row.id) || { material_count: 0, other_usage_count: 0 };
      count[ref.table === 'materials' || ref.table === 'material_topics' ? 'material_count' : 'other_usage_count'] += row.n;
      totals.set(row.id, count);
    }
  }
  return totals;
}
function version(row, lastAudit) {
  return createHash('sha256').update(JSON.stringify({ row, lastAudit: lastAudit || 0 })).digest('hex');
}
function readCategories(database, kind, id) {
  const { table } = definition(kind);
  const rows = database.prepare(`SELECT * FROM ${quote(table)}${id ? ' WHERE id=?' : ''} ORDER BY ${kind === 'grades' ? 'sort_order,' : ''}name,id`).all(...(id ? [id] : []));
  const totals = usage(database, table, id);
  const audits = new Map(database.prepare(`SELECT entity_id, MAX(id) AS revision FROM activity_log WHERE entity_type=?${id ? ' AND entity_id=?' : ''} GROUP BY entity_id`)
    .all('category_' + table, ...(id ? [id] : [])).map(r => [r.entity_id, r.revision]));
  return rows.map(row => ({ ...row, ...(totals.get(row.id) || { material_count: 0, other_usage_count: 0 }), version: version(row, audits.get(row.id)) }));
}
function checkVersion(item, expected) {
  if (!item) fail(404, 'category_missing', 'Esta categoria não está mais disponível. Atualize a lista.');
  if (expected === undefined) return; // Existing clients retain their write contract.
  if (typeof expected !== 'string' || !/^[a-f0-9]{64}$/.test(expected)) fail(400, 'invalid_version', 'Atualize a categoria antes de continuar.');
  if (item.version !== expected) fail(409, 'category_changed', 'Esta categoria mudou. Suas alterações não foram salvas. Confira a versão atual.');
}
function categoryFields(kind, body, existing) {
  if (typeof body?.name !== 'string' || !body.name.trim() || body.name.trim().length > 200) fail(400, 'invalid_fields', 'Informe um nome com até 200 caracteres.');
  const fields = { name: body.name.trim() };
  if (kind === 'grades') {
    fields.sort_order = body.sort_order ?? existing?.sort_order ?? 0;
    if (!Number.isSafeInteger(fields.sort_order) || fields.sort_order < 0 || fields.sort_order > 9999) fail(400, 'invalid_fields', 'Use uma ordem inteira de 0 a 9999.');
  }
  if (kind === 'material-types') {
    fields.icon = body.icon || existing?.icon || 'file';
    if (typeof fields.icon !== 'string' || (!['video', 'image', 'pdf', 'document', 'presentation', 'file'].includes(fields.icon) && fields.icon !== existing?.icon)) fail(400, 'invalid_fields', 'Escolha um dos ícones disponíveis.');
  }
  return fields;
}
module.exports = { definitions, definition, readCategories, checkVersion, categoryFields, fail };
