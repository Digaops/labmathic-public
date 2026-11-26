const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/schoolCoordinationView.mjs');
test('resultados protegidos não admitem percentuais nem contagens; zero é um resultado válido', async () => {
  const { parseCoordinationClasses, coordinationResultText, coordinationDate } = await view;
  const result = { status: 'available', correctedCount: 5, meanPercentage: 0, questionCount: 1, closedAt: '2026-09-16 01:00:00' };
  const data = { school: { id: 'school', name: 'Escola', municipality: 'Município' }, items: [{ id: 'class', name: 'Turma', gradeName: '5º', academicYear: 2026, openCount: 0, closedCount: 1, result }], total: 1, limit: 20, page: 1, year: null, minimumGroup: 5 };
  assert.equal(parseCoordinationClasses(data), data); assert.match(coordinationResultText(result), /^0%/); assert.match(coordinationResultText(result), /1 questão$/);
  assert.equal(coordinationDate(result.closedAt), '15/09/2026'); assert.match(coordinationResultText(null), /Ainda não/);
  for (const closedAt of ['2026-09-16T01:00:00.000Z', '2026-09-15T22:00:00-03:00']) {
    parseCoordinationClasses({ ...data, items: [{ ...data.items[0], result: { ...result, closedAt } }] });
    assert.equal(coordinationDate(closedAt), '15/09/2026');
  }
  for (const patch of [{ meanPercentage: null }, { meanPercentage: 101 }, { correctedCount: 4 }, { closedAt: 'invalid' }, { status: 'protected' }]) {
    assert.throws(() => parseCoordinationClasses({ ...data, items: [{ ...data.items[0], result: { ...result, ...patch } }] }));
  }
  const protectedResult = { status: 'protected', questionCount: 1, closedAt: result.closedAt };
  parseCoordinationClasses({ ...data, items: [{ ...data.items[0], result: protectedResult }] });
  assert.match(coordinationResultText(protectedResult), /pelo menos 5/);
});
test('lista de escolas rejeita respostas incompletas', async () => {
  const { parseCoordinationSchools } = await view;
  for (const value of [null, {}, { items: [], page: 0, limit: 20, total: 0 }, { items: [{ id: 'a', name: 'a' }], page: 1, limit: 20, total: 1 }]) assert.throws(() => parseCoordinationSchools(value));
  parseCoordinationSchools({ items: [], page: 1, limit: 20, total: 0 });
});
