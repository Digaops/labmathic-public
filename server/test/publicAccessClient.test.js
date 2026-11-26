const test = require('node:test');
const assert = require('node:assert/strict');
const source = import('../../client/src/services/publicAccess.mjs');

test('acesso público aceita somente o formato real do link, sem normalizar segredo', async () => {
  const { validPublicToken } = await source;
  assert.equal(validPublicToken('a'.repeat(64)), true);
  for (const token of [null, '', 'abc', 'A'.repeat(64), 'a'.repeat(65), '../link', ' ' + 'a'.repeat(64)]) assert.equal(validPublicToken(token), false);
});
test('recuperação e nova senha exigem confirmação estruturada, não qualquer HTTP 200', async () => {
  const { confirmPublicMessage } = await source;
  assert.equal(confirmPublicMessage({ message: 'Pedido recebido.' }), true);
  for (const value of [null, {}, { message: {} }, { message: '' }, { message: ' ' }]) assert.throws(() => confirmPublicMessage(value));
});
test('senha respeita o contrato existente e não remove espaços significativos', async () => {
  const { passwordProblem } = await source;
  assert.equal(passwordProblem('12345678', '12345678'), '');
  assert.equal(passwordProblem(' senha  ', ' senha  '), '');
  assert.ok(passwordProblem('1234567', '1234567'));
  assert.ok(passwordProblem('x'.repeat(1025), 'x'.repeat(1025)));
  assert.ok(passwordProblem('12345678', '12345679'));
});
test('falha temporária não se confunde com link indisponível ou sucesso', async () => {
  const { publicWriteUncertain, sharedUnavailable, publicError } = await source;
  for (const status of [undefined, 500, 503]) { const e = { response: { status } }; assert.equal(publicWriteUncertain(e), true); assert.equal(sharedUnavailable(e), false); }
  for (const status of [400, 401, 403, 404, 410]) assert.equal(sharedUnavailable({ response: { status } }), true);
  assert.equal(publicWriteUncertain({ response: { status: 429 } }), false);
  assert.equal(publicError({ response: { data: { error: {} } } }, 'Falha'), 'Falha');
});
test('compartilhamento valida a identidade nas duas consultas', async () => {
  const { sharedMaterialId, parseSharedMaterial } = await source;
  assert.equal(sharedMaterialId({ material_id: 4 }), 4);
  for (const material_id of [0, -1, '4', null, 1.5]) assert.throws(() => sharedMaterialId({ material_id }));
  assert.equal(parseSharedMaterial({ id: 4, title: 'Material' }, 4).id, 4);
  for (const value of [{ id: 5, title: 'Outro' }, { id: 4, title: '' }, { id: 4, title: 'Bom', file_path: {} }]) assert.throws(() => parseSharedMaterial(value, 4));
});
test('o segredo de compartilhamento nunca é anexado a origem externa ou caminho inseguro', async () => {
  const { sharedFileUrl } = await source; const token = 'c'.repeat(64);
  assert.equal(sharedFileUrl('/uploads/aula 1.pdf', token), '/uploads/aula%201.pdf?share=' + token);
  for (const file of ['https://example.org/a.pdf', '//example.org/a.pdf', '../a.pdf', 'a\\b.pdf', 'javascript:alert(1)']) assert.equal(sharedFileUrl(file, token), null);
  assert.equal(sharedFileUrl('a.pdf', 'bad'), null);
});
