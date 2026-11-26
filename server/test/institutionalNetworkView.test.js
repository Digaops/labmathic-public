const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../client/src/services/institutionalNetworkView.mjs');
function fixture() {
  return { mode: 'admin', readOnly: true, summary: { activeMunicipalities: 2, activeSchools: 2, linkedProfessionals: 1, verifiedClasses: 1, pendingClasses: 0, linkedClasses: 1, roleCoverage: { municipalManagers: 0, schoolManagers: 1, schoolCoordinators: 0, teachers: 1 } }, municipalities: [
    { publicId: 'm1', name: 'São João', status: 'active', professionalCount: 1, schools: [{ publicId: 's1', name: 'Escola Conceição', status: 'active', professionalCount: 1, teacherCount: 1, leadershipCount: 1, verifiedClassCount: 1 }, { publicId: 's2', name: 'Escola Leste', status: 'active', professionalCount: 0, teacherCount: 0, leadershipCount: 0, verifiedClassCount: 0 }] },
    { publicId: 'm2', name: 'Vila Nova', status: 'active', professionalCount: 0, schools: [] },
  ] };
}
test('consulta da rede aceita totais zero confirmados e não converte dados ausentes ou negativos em zero', async () => {
  const { institutionalModel } = await load(), valid = fixture();
  assert.equal(institutionalModel(valid, 'admin'), valid);
  for (const mutate of [v => delete v.summary.activeSchools, v => v.summary.roleCoverage.teachers = -1, v => v.summary.pendingClasses = '0', v => v.municipalities[0].schools[0].teacherCount = NaN, v => delete v.municipalities[0].schools[0].verifiedClassCount, v => v.readOnly = false]) { const broken = fixture(); mutate(broken); assert.throws(() => institutionalModel(broken, 'admin')); }
  for (const value of [null, {}, [], '']) assert.throws(() => institutionalModel(value, 'admin'));
});
test('consulta rejeita escopo/identidades incoerentes e preserva visão limitada de gestores', async () => {
  const { institutionalModel } = await load(), admin = fixture();
  assert.throws(() => institutionalModel(admin, 'professor'));
  const manager = { ...admin, mode: 'manager', scopeLevel: 'school', municipalities: [ { ...admin.municipalities[0], accessLevel: 'schools', roleLabels: ['Gestão escolar'], schools: [admin.municipalities[0].schools[0]] } ] };
  delete manager.summary.roleCoverage; delete manager.summary.pendingClasses; delete manager.summary.linkedClasses;
  assert.equal(institutionalModel(manager, 'professor'), manager);
  assert.throws(() => institutionalModel(manager, 'admin'));
  for (const mutate of [v => v.scopeLevel = 'global', v => v.municipalities[0].accessLevel = 'all', v => v.municipalities[0].roleLabels = null, v => v.municipalities.push(v.municipalities[0]), v => v.municipalities[0].schools.push(v.municipalities[0].schools[0])]) { const broken = structuredClone(manager); mutate(broken); assert.throws(() => institutionalModel(broken, 'professor')); }
});
test('consulta docente conserva campos nulos válidos e impede contrato parcial', async () => {
  const { institutionalModel } = await load();
  const value = { mode: 'professional', readOnly: true, status: 'pending_institutional_link', summary: { memberships: 1, classes: 1, verifiedClasses: 0, linkedClasses: 0, pendingClasses: 1 }, memberships: [{ publicId: 'v1', role: 'teacher', roleLabel: 'Professor(a)', municipalityPublicId: 'm1', municipalityName: 'São João', schoolPublicId: null, schoolName: null }], classes: [{ publicId: 'c1', name: 'Turma 1', academicYear: 2026, status: 'active', migrationStatus: 'pending', gradeName: null, schoolName: null, municipalityName: null }] };
  assert.equal(institutionalModel(value, 'professor'), value);
  for (const mutate of [v => delete v.classes, v => v.classes[0].migrationStatus = 'unknown', v => delete v.memberships[0].municipalityName, v => v.classes[0].academicYear = '2026']) { const broken = structuredClone(value); mutate(broken); assert.throws(() => institutionalModel(broken, 'professor')); }
});
test('busca por escola e município ignora acentos, mantém totais e aplica os filtros em conjunto', async () => {
  const { networkResults } = await load(), data = fixture().municipalities, before = JSON.stringify(data);
  assert.equal(networkResults(data, '  sAO joaO ')[0].visibleSchools.length, 2);
  assert.equal(networkResults(data, 'conceicao')[0].visibleSchools[0].publicId, 's1');
  assert.equal(networkResults(data, 'conceicao')[0].professionalCount, 1);
  assert.equal(networkResults(data, '', 'm2')[0].visibleSchools.length, 0);
  assert.deepEqual(networkResults(data, 'conceicao', 'm2'), []);
  assert.deepEqual(networkResults(data, 'nao-existe'), []);
  assert.deepEqual(networkResults(data, '', 'fora-do-escopo'), []);
  assert.equal(networkResults(data).length, 2);
  assert.deepEqual(networkResults([data[1], data[0]]).map(item => item.publicId), ['m1', 'm2']);
  assert.equal(JSON.stringify(data), before);
});
