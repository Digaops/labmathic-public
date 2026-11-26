const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/schoolCoordinationComparisonView.mjs');
function sample() {
  return { school: { id: 'school', name: 'Escola', municipality: 'Município' },
    class: { id: 'class', name: '5º A', academicYear: 2026, gradeName: '5º ano' },
    plan: { id: 'plan', status: 'active', activatedAt: '2026-09-17 12:00:00' }, minimumGroup: 5,
    comparison: { status: 'available', methodology: 'matched-students-v2', hasProtectedSkills: false,
      sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: '2026-09-20 12:00:00',
      skills: [{ code: 'EF05MA01', description: 'Comparar números.', studentCount: 5,
        diagnostic: { questionCount: 2, opportunities: 10, successRate: 20 },
        verification: { questionCount: 1, opportunities: 5, successRate: 80 }, difference: 60 }] } };
}
test('comparação escolar: cliente aceita pares, proteção parcial, proteção total e espera sem inventar números', async () => {
  const { parseSchoolComparison: parse } = await view;
  const data = sample(); assert.equal(parse(data, 'school', 'class', 'plan'), data);
  data.comparison.hasProtectedSkills = true; parse(data, 'school', 'class', 'plan');
  data.comparison = { status: 'protected', sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: '2026-09-20 12:00:00' };
  parse(data, 'school', 'class', 'plan');
  data.comparison = { status: 'awaiting_verification', sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: null };
  parse(data, 'school', 'class', 'plan');
});
test('comparação escolar: cliente recusa escopo divergente, pequenos grupos, denominadores errados e diferenças fabricadas', async () => {
  const { parseSchoolComparison: parse } = await view;
  for (const change of [v => { v.school.id = 'other'; }, v => { v.class.id = 'other'; }, v => { v.plan.id = 'other'; },
    v => { v.plan.status = 'draft'; }, v => { v.minimumGroup = 4; }, v => { v.comparison.methodology = 'legacy'; },
    v => { v.comparison.skills[0].studentCount = 4; }, v => { v.comparison.skills[0].diagnostic.opportunities = 5; },
    v => { v.comparison.skills[0].verification.successRate = null; }, v => { v.comparison.skills[0].diagnostic.successRate = 101; },
    v => { v.comparison.skills[0].difference = 50; }, v => { v.comparison.skills[0].difference = NaN; },
    v => { v.comparison.skills[0].verification.questionCount = 0; }, v => { v.comparison.hasProtectedSkills = 'yes'; },
    v => { v.comparison.skills.push(structuredClone(v.comparison.skills[0])); }, v => { v.comparison.skills = []; },
    v => { v.comparison.verificationClosedAt = null; }, v => { v.plan.activatedAt = 'invalid'; }]) {
    const data = sample(); change(data); assert.throws(() => parse(data, 'school', 'class', 'plan'));
  }
});
test('comparação escolar: campos privados e detalhes sobre habilidades protegidas são recusados', async () => {
  const { parseSchoolComparison: parse } = await view;
  for (const change of [v => { v.plan.title = 'Privado'; }, v => { v.comparison.skills[0].excludedStudentCount = 1; },
    v => { v.comparison.skills[0].diagnosticSnapshot = { rate: 10 }; }, v => { v.comparison.cohort = []; },
    v => { v.comparison.status = 'protected'; }, v => { v.comparison.skills[0].verification.studentId = 1; }]) {
    const data = sample(); change(data); assert.throws(() => parse(data, 'school', 'class', 'plan'));
  }
  const data = sample(); data.comparison = { status: 'protected', sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: '2026-09-20 12:00:00', skills: [] };
  assert.throws(() => parse(data, 'school', 'class', 'plan'));
});
test('comparação escolar: diferença tem unidade explícita e zero não recebe rótulo de melhoria', async () => {
  const { schoolComparisonDifference: label, parseSchoolComparison: parse } = await view;
  assert.equal(label(0), 'Mesmo percentual de acertos');
  assert.equal(label(1), '1 ponto percentual a mais');
  assert.equal(label(-1), '1 ponto percentual a menos');
  assert.equal(label(-33.34), '33,34 pontos percentuais a menos');
  assert.equal(label(60), '60 pontos percentuais a mais');
  for (const [before, after, difference] of [[0, 0, 0], [100, 0, -100], [0, 100, 100], [66.67, 33.33, -33.34]]) {
    const data = sample(), skill = data.comparison.skills[0];
    skill.diagnostic.successRate = before; skill.verification.successRate = after; skill.difference = difference;
    parse(data, 'school', 'class', 'plan');
  }
});
