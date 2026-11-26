const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../client/src/services/assessmentRoster.mjs');
const person = { id: 'a', displayName: 'Ana', enrollmentStatus: 'withdrawn', studentStatus: 'active', eligible: false, canRemove: true };

test('dispensado permanece na lista histórica e não entra como matrícula pendente nem apto', async () => {
  const { parseRosterReadiness, rosterIssue } = await load();
  const exempt = { ...person, status: 'exempted', canRemove: false, canExempt: false };
  const data = { classActive: true, participants: [exempt], assignment: { id: 'app', title: 'Teste', revision: 2, status: 'draft', questionCount: 1, participantCount: 1,
    roster: { eligibleCount: 0, ineligibleCount: 0, exemptedCount: 1 } } };
  assert.equal(parseRosterReadiness(data), data);
  assert.equal(rosterIssue(exempt), 'Dispensado desta avaliação');
  assert.throws(() => parseRosterReadiness({ ...data, assignment: { ...data.assignment, roster: { eligibleCount: 1, ineligibleCount: 0, exemptedCount: 0 } } }));
});

test('lista salva conserva nome retirado e prevalece sobre bootstrap desatualizado', async () => {
  const { mergeAssessmentRoster, rosterIssue } = await load();
  const active = Object.freeze([{ id: 'a', displayName: 'Nome antigo' }, { id: 'b', displayName: 'Bruno' }]);
  const merged = mergeAssessmentRoster(active, [Object.freeze(person)]);
  assert.equal(merged.length, 2); assert.equal(merged[0], person); assert.equal(merged[0].eligible, false);
  assert.equal(merged[1].eligible, true); assert.equal(rosterIssue(person), 'Retirado da turma');
  assert.equal(rosterIssue({ studentStatus: 'archived' }), 'Cadastro arquivado');
  assert.equal(active[0].displayName, 'Nome antigo');
});

test('conferência exige contagens, matrícula, cadastro e permissão de retirada consistentes', async () => {
  const { parseSavedRoster, parseRosterReadiness } = await load();
  const data = { classActive: true, participants: [person], assignment: { id: 'app', title: 'Teste', revision: 1, status: 'draft', questionCount: 1, participantCount: 1, roster: { eligibleCount: 0, ineligibleCount: 1 } } };
  assert.equal(parseRosterReadiness(data), data);
  for (const value of [null, {}, { ...person, eligible: true }, { ...person, canRemove: undefined }, { ...person, studentStatus: 'other' }]) assert.throws(() => parseSavedRoster([value]));
  assert.throws(() => parseSavedRoster([person, person]));
  for (const value of [{ ...data, classActive: undefined }, { ...data, participants: [] }, { ...data, assignment: { ...data.assignment, roster: { eligibleCount: 1, ineligibleCount: 0 } } }]) assert.throws(() => parseRosterReadiness(value));
});
