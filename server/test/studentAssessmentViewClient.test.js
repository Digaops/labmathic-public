const test = require('node:test');
const assert = require('node:assert/strict');
const view = import('../../client/src/services/studentAssessmentView.mjs');
function access() {
  return { assessment: { id: 'a', title: 'Avaliação', className: 'Turma', revision: 2, status: 'open', studentAccessEnabled: true, studentResultMode: 'hidden' }, summary: { participantCount: 2, activeCredentialCount: 2, accessedCount: 0, submittedCount: 0 }, participants: ['a','b'].map(id => ({ id, displayName: 'Estudante ' + id, participantStatus: 'assigned', attemptStatus: 'pending', credential: { id: 'credential-' + id, status: 'active', hint: '1234', revision: 1 } })) };
}
test('acessos inválidos não podem parecer lista vazia válida', async () => {
  const { parseStudentAccess } = await view;
  assert.equal(parseStudentAccess(access()).participants.length, 2);
  for (const value of [null, {}, { ...access(), participants: null }, { ...access(), summary: {} }]) assert.throws(() => parseStudentAccess(value));
});
test('códigos únicos preservam os demais cartões ao renovar apenas um estudante', async () => {
  const { mergeIssuedCodes } = await view;
  const current = access();
  const old = [{ id: 'a', credentialId: 'old-a', code: 'OLD1-OLD1-OLD1-1234' }, { id: 'b', credentialId: 'credential-b', code: 'BBBB-BBBB-BBBB-1234' }];
  const merged = mergeIssuedCodes(old, { access: current, generated: [{ id: 'a', displayName: 'Estudante a', code: 'AAAA-AAAA-AAAA-1234' }] });
  assert.equal(merged.length, 2); assert.equal(merged.find(c => c.id === 'b').code, old[1].code);
  assert.equal(merged.find(c => c.id === 'a').credentialId, 'credential-a');
});
test('revogação/expiração e identidade da credencial removem cartão obsoleto, mesmo com final igual', async () => {
  const { retainActiveCodes } = await view;
  const current = access(), code = [{ id: 'a', credentialId: 'credential-a', code: 'AAAA-AAAA-AAAA-1234' }];
  assert.equal(retainActiveCodes(code, current).length, 1);
  current.participants[0].credential.id = 'replacement-with-same-hint'; assert.deepEqual(retainActiveCodes(code, current), []);
  current.participants[0].credential.id = 'credential-a'; current.participants[0].credential.status = 'expired'; assert.deepEqual(retainActiveCodes(code, current), []);
});
test('geração incompleta não confirma códigos e estudantes inelegíveis não recebem ação', async () => {
  const { mergeIssuedCodes, canIssueStudentCode } = await view;
  assert.throws(() => mergeIssuedCodes([], { access: access(), generated: [{ id: 'a', displayName: 'A', code: 'incompleto' }] }));
  for (const p of [{ participantStatus: 'exempted' }, { attemptStatus: 'submitted' }, { attemptStatus: 'draft', submissionChannel: 'teacher_entry' }]) assert.equal(canIssueStudentCode(p), false);
  assert.equal(canIssueStudentCode({ attemptStatus: 'draft', submissionChannel: 'student_online' }), true);
});
test('dados do portal são conferidos antes de iniciar ou reconciliar a resposta', async () => {
  const { parseStudentPortal } = await view;
  const portal = { student: { displayName: 'Estudante' }, assessment: { title: 'Avaliação', className: 'Turma', questionCount: 1, status: 'open' }, attempt: { status: 'draft', revision: 1 }, serverTime: '2026-09-09T12:00:00Z', items: [{ id: 'item', number: 1, statement: 'Quanto?', selectedOptionId: 'option', options: [{ id: 'option', label: 'A', text: 'Resposta' }] }] };
  assert.equal(parseStudentPortal(portal), portal);
  const withFeedback = { ...portal, feedback: { message: 'Revise a estratégia e tente novamente.', releasedAt: '2026-09-09T12:00:00Z' } };
  assert.equal(parseStudentPortal(withFeedback), withFeedback);
  for (const value of [{}, { ...portal, items: [] }, { ...portal, attempt: { status: 'draft' } }, { ...portal, serverTime: 'inválido' }, { ...portal, items: [{ ...portal.items[0], selectedOptionId: 'outro' }] }]) assert.throws(() => parseStudentPortal(value));
});
