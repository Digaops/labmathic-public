const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/schoolCoordinationSupportView.mjs');
function sample() {
  return { school: { id: 'school', name: 'Escola', municipality: 'Município' },
    class: { id: 'class', name: '5º A', academicYear: 2026, gradeName: '5º ano' },
    minimumGroup: 5, total: 1, page: 1, limit: 20,
    items: [{ id: 'plan', status: 'active', activatedAt: '2026-09-17 12:00:00', sourceClosedAt: '2026-09-15 12:00:00',
      execution: { status: 'active', total: 3, taught: 1, skipped: 1, planned: 1 },
      verification: { status: 'not_created', closedAt: null, results: null } }] };
}
test('apoio escolar: contrato aceita planos, vazio, ausência de execução e página que ficou vazia', async () => {
  const { parseCoordinationSupport: parse } = await view;
  const value = sample(); assert.equal(parse(value, 'school', 'class', 1), value);
  value.items[0].execution = null; parse(value, 'school', 'class', 1);
  value.items = []; value.total = 0; parse(value, 'school', 'class', 1);
  value.page = 2; value.total = 20; parse(value, 'school', 'class', 2);
});
test('apoio escolar: rejeita dados de outra turma/escola/página, recortes e detalhes privados', async () => {
  const { parseCoordinationSupport: parse } = await view;
  for (const change of [v => { v.school.id = 'other'; }, v => { v.class.id = 'other'; }, v => { v.page = 2; },
    v => { v.minimumGroup = 4; }, v => { v.items = []; }, v => { v.total = 2; }, v => { v.total = -1; },
    v => { v.items[0].title = 'texto privado'; }, v => { v.items[0].status = 'draft'; },
    v => { v.items[0].execution.taught = 2; }, v => { v.items[0].execution.total = 2; },
    v => { v.items[0].execution.skipped = -1; }, v => { v.items[0].execution.status = 'draft'; },
    v => { v.items[0].verification.correctedCount = 4; }, v => { v.items[0].verification.results = 'available'; },
    v => { v.items[0].activatedAt = null; }, v => { v.items[0].sourceClosedAt = 'invalid'; },
    v => { v.items.push(structuredClone(v.items[0])); v.total = 2; }]) {
    const value = sample(); change(value); assert.throws(() => parse(value, 'school', 'class', 1));
  }
});
test('apoio escolar: somente avaliação encerrada admite sinalização protegida/disponível, nunca notas', async () => {
  const { parseCoordinationSupport: parse, supportVerificationText } = await view;
  for (const results of ['available', 'protected']) {
    const value = sample(); value.items[0].verification = { status: 'closed', closedAt: '2026-09-20 12:00:00', results };
    parse(value, 'school', 'class', 1);
    assert.match(supportVerificationText(value.items[0].verification), results === 'available' ? /correções disponíveis/ : /resultados protegidos/);
    value.items[0].verification.meanPercentage = 75;
    assert.throws(() => parse(value, 'school', 'class', 1));
  }
  for (const status of ['draft', 'scheduled', 'open', 'cancelled', 'not_created']) {
    const value = sample(); value.items[0].verification.status = status; parse(value, 'school', 'class', 1);
    assert.ok(supportVerificationText(value.items[0].verification));
    value.items[0].verification.closedAt = '2026-09-20 12:00:00'; assert.throws(() => parse(value, 'school', 'class', 1));
  }
});
test('apoio escolar: orientações não confundem aulas não realizadas, encerramento e aprendizagem', async () => {
  const { supportNextStep: next } = await view; const plan = sample().items[0];
  assert.match(next(plan), /aulas que ainda estão previstas/);
  plan.execution.planned = 0; assert.match(next(plan), /não realizadas/);
  plan.execution.skipped = 0; assert.match(next(plan), /nova atividade/);
  plan.verification = { status: 'open', closedAt: null, results: null }; assert.match(next(plan), /Aguarde o encerramento/);
  plan.verification.status = 'scheduled'; assert.match(next(plan), /data planejada/);
  plan.verification = { status: 'closed', closedAt: '2026-09-20 12:00:00', results: 'available' };
  assert.match(next(plan), /não comprovam melhoria/);
  plan.status = 'completed'; assert.match(next(plan), /não comprovam melhoria/);
  plan.verification.results = 'protected'; assert.match(next(plan), /própria conta/);
  plan.execution.status = 'archived'; assert.match(next(plan), /arquivadas/);
  plan.execution = null; assert.match(next(plan), /ainda não foi disponibilizada/);
});
