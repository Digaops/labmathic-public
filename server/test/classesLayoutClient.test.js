const test = require('node:test');
const assert = require('node:assert/strict');
const service = import('../../client/src/services/classesView.mjs');
const sample = { id: 'class-1', name: '7º A', grade: { id: 1, name: '7º Ano' }, academicYear: 2026, status: 'active', revision: 1, studentCount: 1, disciplines: [{ id: 2, name: 'Matemática' }] };
test('turmas: contratos distinguem lista vazia, detalhe e resposta inválida', async () => {
  const { parseClasses, parseClassDetail, parseClassesBootstrap } = await service;
  assert.deepEqual(parseClasses([]), []); assert.deepEqual(parseClasses([sample]), [sample]);
  for (const value of [null, {}, [{ ...sample, disciplines: null }], [{ ...sample, grade: null }], [{ ...sample, revision: -1 }]]) assert.throws(() => parseClasses(value));
  assert.deepEqual(parseClassDetail({ ...sample, students: [] }).students, []);
  assert.throws(() => parseClassDetail({ ...sample, students: [{ id: 'x', displayName: 'A' }] }));
  assert.throws(() => parseClassesBootstrap({ grades: [], disciplines: [] }));
});
test('turmas: URL conserva turma/seção/simulado, filtros e parâmetros alheios', async () => {
  const { classNavigation, classesQuery, classesRequest } = await service;
  const params = new URLSearchParams('turma=class-1&secao=avaliacoes&simulado=12&origem=inicio');
  assert.deepEqual(classesQuery(params), { id: 'class-1', section: 'avaliacoes', source: '12', assessment: null, status: 'active', search: '' });
  assert.equal(classNavigation(params, { turma: null, secao: null, simulado: null }).toString(), 'origem=inicio');
  assert.equal(classesQuery(new URLSearchParams('situacao=invalida&secao=x')).status, 'active');
  assert.equal(classesRequest('archived', '  7º A  '), '/classes?status=archived&search=7%C2%BA+A');
  assert.equal(classesQuery(new URLSearchParams('busca=' + 'x'.repeat(90))).search.length, 80);
});
test('turmas: busca local de estudante por nome, acento e matrícula', async () => {
  const { studentMatches } = await service;
  assert.equal(studentMatches({ displayName: 'José da Silva', externalReference: '2026-014' }, 'jose'), true);
  assert.equal(studentMatches({ displayName: 'José da Silva', externalReference: '2026-014' }, '014'), true);
  assert.equal(studentMatches({ displayName: 'José da Silva' }, 'Ana'), false);
});
