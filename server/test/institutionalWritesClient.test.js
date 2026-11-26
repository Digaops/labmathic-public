const test = require('node:test'), assert = require('node:assert/strict');
const client = import('../../client/src/services/institutionalWrites.mjs');
const state = () => ({ mode: 'admin', environment: 'homologation', writable: true,
  municipalities: [{ publicId: 'm', name: 'Município', status: 'active' }, { publicId: 'other', name: 'Outro', status: 'active' }],
  schools: [{ publicId: 's', municipalityPublicId: 'm', name: 'Escola', status: 'active' }],
  professionals: [{ id: 1, name: 'Docente', email: 'teacher@example.invalid' }],
  memberships: [], teacherMemberships: [{ publicId: 'link', userId: 1, professionalName: 'Docente', professionalEmail: 'teacher@example.invalid', role: 'teacher', status: 'active', municipalityPublicId: 'm', schoolPublicId: 's' }],
  grades: [{ id: 1, name: '7º ano' }], disciplines: [{ id: 1, name: 'Matemática' }], guidedClasses: [] });
test('cadastros recusam respostas incompletas, repetidas e de outra conta', async () => {
  const { managementState } = await client;
  assert.equal(managementState(state(), { role: 'admin' }).mode, 'admin');
  for (const patch of [{ writable: false }, { environment: 'production' }, { schools: null }, { municipalities: [...state().municipalities, state().municipalities[0]] }]) assert.throws(() => managementState({ ...state(), ...patch }, { role: 'admin' }));
  assert.throws(() => managementState(state(), { role: 'professor', id: 1 }));
});
test('cadastros exigem município, escola, professor e ano escolar explícitos', async () => {
  const { prepareInstitutionalWrite: prepare } = await client;
  const command = { action: 'membership', url: '/institutions/management/memberships', data: { userId: 1, role: 'teacher', municipalityPublicId: 'm', schoolPublicId: 's' } };
  assert.equal(prepare(state(), command).expected.schoolPublicId, 's');
  for (const change of [{ userId: '' }, { municipalityPublicId: '' }, { municipalityPublicId: 'other' }, { schoolPublicId: '' }]) assert.throws(() => prepare(state(), { ...command, data: { ...command.data, ...change } }));
  const cls = { action: 'class', url: '/institutions/management/classes', data: { name: '7 A', membershipPublicId: 'link', gradeId: 1, academicYear: 2026, disciplineIds: [1] } };
  assert.equal(prepare(state(), cls).expected.userId, 1);
  for (const change of [{ membershipPublicId: '' }, { gradeId: 0 }, { disciplineIds: [] }, { disciplineIds: [1, 1] }, { disciplineIds: [99] }]) assert.throws(() => prepare(state(), { ...cls, data: { ...cls.data, ...change } }));
});
test('conferência é cópia estável e não inclui senha; quatro funções mantêm escopo', async () => {
  const { prepareInstitutionalWrite: prepare } = await client;
  for (const role of ['teacher', 'school_manager', 'school_coordinator', 'municipal_manager']) {
    const data = { name: 'Novo Docente', email: 'NOVO@example.invalid', temporaryPassword: 'Only-Synthetic-40!', role, municipalityPublicId: 'm', schoolPublicId: role === 'municipal_manager' ? null : 's' };
    const prepared = prepare(state(), { action: 'professional', url: '/institutions/management/professionals', data });
    data.name = 'Alterado';
    assert.equal(prepared.data.name, 'Novo Docente'); assert.equal(prepared.expected.email, 'novo@example.invalid');
    assert.doesNotMatch(JSON.stringify(prepared.summary), /Only-Synthetic|temporaryPassword/);
    assert.equal(prepared.expected.schoolPublicId, role === 'municipal_manager' ? null : 's');
  }
});
test('resultado e recibo exigem identidade, código, escopo e operação correspondentes', async () => {
  const { prepareInstitutionalWrite: prepare, institutionalWriteResult: result, institutionalReceipt: receipt } = await client;
  const op = prepare(state(), { action: 'municipality', url: '/institutions/management/municipalities', data: { name: ' Nova Vila ', ibgeCode: '1234567' } });
  const ack = { replayed: false, municipality: { publicId: 'new', name: 'Nova Vila', ibgeCode: '1234567' } };
  assert.equal(result(op, ack), ack); assert.equal(receipt(op, { found: false }), null);
  assert.equal(receipt(op, { found: true, operationType: 'create_municipality', result: ack }), ack);
  for (const bad of [{}, { ...ack, replayed: undefined }, { ...ack, municipality: { ...ack.municipality, name: 'Outra' } }]) assert.throws(() => result(op, bad));
  assert.throws(() => receipt(op, { found: true, operationType: 'create_school', result: ack }));
  const school = prepare(state(), { action: 'school', url: '/institutions/management/municipalities/m/schools', data: { name: 'Escola', censusCode: '' } });
  assert.equal(school.expected.municipalityPublicId, 'm');
  assert.throws(() => result(school, { replayed: false, school: { publicId: 's', name: 'Escola', censusCode: null, municipalityPublicId: 'other' } }));
});
test('confirmação docente exige turma pendente e mesma versão do contexto', async () => {
  const { prepareInstitutionalWrite: prepare, institutionalWriteResult: result } = await client;
  const row = { publicId: 'c', name: 'Turma', contextUpdatedAt: 'version', schoolName: 'Escola', municipalityName: 'Município', grade: { name: '7º ano' }, academicYear: 2026 };
  const s = { mode: 'professional', pendingConfirmations: [row] };
  const command = { action: 'confirm-c', url: '/institutions/management/classes/c/confirm', data: { expectedContextUpdatedAt: 'version' } };
  const op = prepare(s, command);
  assert.throws(() => prepare(s, { ...command, data: { expectedContextUpdatedAt: 'old' } }));
  assert.throws(() => result(op, { replayed: true, schoolClass: { publicId: 'other', migrationStatus: 'verified' } }));
  assert.equal(result(op, { replayed: true, schoolClass: { publicId: 'c', migrationStatus: 'verified' } }).replayed, true);
});
