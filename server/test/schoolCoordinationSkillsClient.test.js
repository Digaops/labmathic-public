const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/schoolCoordinationView.mjs');
function sample() {
  return { school: { id: 'school', name: 'Escola', municipality: 'Município' },
    class: { id: 'class', name: '5º A', academicYear: 2026, gradeName: '5º ano' }, minimumGroup: 5,
    result: { status: 'available', correctedCount: 5, meanPercentage: 50, questionCount: 2, closedAt: '2026-09-19 12:00:00',
      skills: [{ code: 'EF05MA01', description: 'Números.', questionCount: 1, status: 'available', successRate: 0 },
        { code: null, description: null, questionCount: 1, status: 'available', successRate: 100 }] } };
}
test('habilidades escolares: aceita zero, ausência de classificação, vazio e proteção sem detalhes', async () => {
  const { parseCoordinationSkills } = await view;
  for (const result of [sample().result, null, { status: 'protected', questionCount: 2, closedAt: '2026-09-19 12:00:00' }]) {
    const value = { ...sample(), result };
    assert.equal(parseCoordinationSkills(value, 'school', 'class'), value);
  }
  const data = sample(); data.result.skills[1] = { code: null, description: null, questionCount: 1, status: 'unavailable' };
  parseCoordinationSkills(data, 'school', 'class');
});
test('habilidades escolares: resposta de outra escola/turma ou dados incompletos são recusados', async () => {
  const { parseCoordinationSkills } = await view;
  for (const change of [v => { v.school.id = 'other'; }, v => { v.class.id = 'other'; }, v => { v.class = null; },
    v => { v.minimumGroup = 4; }, v => { v.result.correctedCount = 4; }, v => { v.result.skills = []; },
    v => { v.result.skills[1] = { ...v.result.skills[0] }; }, v => { v.result.skills.pop(); },
    v => { v.result.skills[0].questionCount = 2; }, v => { v.result.skills[0].successRate = null; },
    v => { v.result.skills[0].successRate = 101; }, v => { v.result.skills[0].status = 'unavailable'; },
    v => { v.result = { status: 'protected', questionCount: 2, closedAt: '2026-09-19 12:00:00', skills: [] }; }]) {
    const value = sample(); change(value); assert.throws(() => parseCoordinationSkills(value, 'school', 'class'));
  }
});
