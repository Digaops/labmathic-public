const test = require('node:test'), assert = require('node:assert/strict');
const modulePromise = import('../../client/src/services/adminCategoriesView.mjs');
const item = { id: 1, name: 'Frações', version: 'a'.repeat(64), material_count: 0, other_usage_count: 1 };
test('categoria exige identidade, vínculos e versão; área desconhecida não é executável', async () => {
  const v = await modulePromise; assert.equal(v.categoryArea('topics'), 'topics'); assert.equal(v.categoryArea('__proto__'), 'disciplines');
  assert.deepEqual(v.categoryList({ kind:'topics',items:[item] },'topics'),[item]);
  for (const invalid of [{...item,id:0},{...item,version:''},{...item,other_usage_count:-1}]) assert.throws(()=>v.categoryItem(invalid,'topics'));
  assert.throws(()=>v.categoryList({kind:'grades',items:[item]},'topics')); assert.throws(()=>v.categoryList({kind:'topics',items:[item,item]},'topics')); assert.throws(()=>v.categoryDetail({kind:'topics',item},'topics',2));
});
test('busca ignora acentos e maiúsculas; rascunho mantém zero e ícone legado', async () => {
  const v = await modulePromise; assert.deepEqual(v.categorySearch([item], ' FRACOES '), [item]); assert.deepEqual(v.categorySearch([item], 'outra'), []);
  assert.equal(v.categoryDraft({...item,sort_order:0,icon:'legacy'}).sort_order,'0'); assert.equal(v.categoryDraft({...item,icon:'legacy'}).icon,'legacy');
});
test('validação e payload não confundem nome, ordem e versão', async () => {
  const v = await modulePromise; const form = v.categoryDraft({...item,sort_order:0});
  assert.equal(v.categoryIssue(form,'grades'),null); assert.equal(v.categoryPayload(form,'grades',item).sort_order,0); assert.equal(v.categoryPayload(form,'grades',item).expectedVersion,item.version);
  assert.ok(v.categoryIssue({...form,name:' '},'topics')); assert.ok(v.categoryIssue({...form,sort_order:'-1'},'grades')); assert.ok(v.categoryIssue({...form,sort_order:'2.5'},'grades')); assert.equal(v.categoryPayload(form,'topics',null).expectedVersion,undefined);
});
