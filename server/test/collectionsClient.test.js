const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const service = import('../../client/src/services/collectionsView.mjs');
const sample = { id: 1, name: 'Coleção', is_public: 1, description: null, image_path: null, item_count: 2 };

test('coleções: contratos distinguem vazio de resposta inválida', async () => {
  const { parseCollectionList, parseCollection } = await service;
  assert.deepEqual(parseCollectionList([]), []);
  assert.deepEqual(parseCollectionList([sample]), [sample]);
  for (const invalid of [null, {}, [null], [{ ...sample, item_count: -1 }], [{ ...sample, is_public: 'false' }], [{ ...sample, image_path: {} }]]) assert.throws(() => parseCollectionList(invalid));
  assert.deepEqual(parseCollection({ ...sample, materials: [] }).materials, []);
  for (const materials of [null, {}, [{ id: 1 }], [{ id: -1, title: 'Inválido' }]]) assert.throws(() => parseCollection({ ...sample, materials }));
});
test('coleções: todos os materiais na entrada, filtros opcionais e URLs legadas', async () => {
  const { filterCollection, collectionGrade, collectionType, collectionOptions } = await service;
  const materials = [{ id: 1, grade_name: '9º Ano', material_type_name: 'PDF' }, { id: 2, grade_name: '2º Ano', material_type_name: 'Vídeo' }, { id: 3 }];
  assert.equal(filterCollection(materials, '', '').length, 3);
  assert.deepEqual(filterCollection(materials, '9º Ano', 'PDF').map(m => m.id), [1]);
  assert.deepEqual(filterCollection(materials, '', 'Vídeo').map(m => m.id), [2]);
  assert.deepEqual(filterCollection(materials, '9º Ano', 'Vídeo'), []);
  assert.deepEqual(collectionOptions(materials, collectionGrade, 'Sem ano definido'), ['2º Ano', '9º Ano', 'Sem ano definido']);
  assert.equal(collectionType({}), 'Sem tipo definido');
  assert.equal(collectionGrade({ gradeName: 'Legado' }), 'Legado');
  assert.deepEqual(filterCollection(materials, 'Sem ano definido', 'Sem tipo definido').map(m => m.id), [3]);
});
test('coleções: proteção de sessão, confirmação e prévia de imagem com descarte', () => {
  const read = name => fs.readFileSync(path.resolve(__dirname, '../../client/src', name), 'utf8');
  assert.match(read('pages/Collections.jsx'), /key=\{identity\}/);
  assert.match(read('pages/CollectionView.jsx'), /key=\{`\$\{identity\}:\$\{id\}`\}/);
  assert.match(read('pages/CollectionView.jsx'), /compactOnMobile/);
  assert.doesNotMatch(read('pages/CollectionView.jsx'), /Etapa [123] de 3|group-hover:opacity/);
  const dialogs = read('components/CollectionDialogs.jsx');
  assert.match(dialogs, /URL\.revokeObjectURL\(url\)/);
  assert.match(dialogs, /closeDisabled=\{busy\}/);
  assert.match(dialogs, /useMaterialAction/);
  assert.match(dialogs, /Os materiais continuarão na Biblioteca/);
});
