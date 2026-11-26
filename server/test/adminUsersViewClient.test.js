const test = require('node:test'), assert = require('node:assert/strict');
const mod = import('../../client/src/services/adminUsersView.mjs');
const item = { id: 1, name: 'Conceição Silva', email: 'pessoa@example.invalid', role: 'professor', version: 'a'.repeat(64), deletion_block: null };
test('contas: valida resposta e identidade sem transportar campos sensíveis', async () => {
  const m = await mod; assert.equal(m.userList([item]).length, 1); assert.equal(m.userItem({ ...item, password: 'private' }).password, undefined);
  for (const data of [null, {}, [{ ...item, role: 'root' }], [{ ...item, version: '' }], [item, item]]) assert.throws(() => m.userList(data));
  assert.throws(() => m.userDetail(item, 2)); assert.throws(() => m.userDetail({ ...item, deletion_block: undefined }, 1));
});
test('contas: busca por nome/e-mail sem acento e filtro de perfil', async () => {
  const m = await mod; assert.equal(m.filterUsers([item], ' CONCEICAO ', '').length, 1); assert.equal(m.filterUsers([item], 'EXAMPLE', 'professor').length, 1); assert.equal(m.filterUsers([item], '', 'admin').length, 0);
});
test('contas: validações e payload separam senha da edição', async () => {
  const m = await mod, draft = { ...m.userDraft(item), password: 'Senha-Nova-37!' };
  assert.equal(m.userIssue(draft, 'create'), null); assert.equal(m.userIssue({ ...draft, password: '1' }, 'reset')[0], 'password'); assert.equal(m.userIssue({ ...draft, email: '' }, 'edit')[0], 'email');
  assert.equal(m.userPayload(draft, 'edit', item).password, undefined); assert.deepEqual(m.userPayload(draft, 'reset', item), { password: draft.password, expectedVersion: item.version }); assert.deepEqual(m.userPayload(draft, 'delete', item), { expectedVersion: item.version });
});
