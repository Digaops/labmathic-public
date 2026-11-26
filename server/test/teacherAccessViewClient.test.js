const test = require('node:test'), assert = require('node:assert/strict');
const catalog = require('../../shared/teacherAccessCatalog.json');
const pilots = require('../../shared/teacherPilotAccessCatalog.json');
const mod = import('../../client/src/services/teacherAccessView.mjs');
const payload = () => ({ version: catalog.version, checkedAt: '2026-09-12T12:00:00.000Z',
  user: { id: 7, name: 'Docente sintético', email: 'qa@example.invalid', role: 'professor' },
  features: catalog.features.map(feature => ({ id: feature.id, enabled: true, checks: feature.requires.map(key => ({ key, enabled: true, reason: 'user_rule' })) })) });
test('acessos: resposta completa, identidade e dependências verificadas sem campos extras', async () => {
  const m = await mod, data = payload(); data.user.password = 'private'; data.secret = 'private';
  assert.equal(m.teacherAccessView(data, 7).features.length, catalog.features.length);
  assert.equal(JSON.stringify(m.teacherAccessView(data, 7)).includes('private'), false);
  for (const mutate of [d => d.version = 'unknown', d => d.user.id = 8, d => d.user.role = 'admin', d => d.checkedAt = 'invalid',
    d => d.features.pop(), d => d.features[1] = d.features[0], d => d.features[0].enabled = 'false',
    d => d.features[0].checks = [], d => d.features[0].checks[0].key = 'different', d => d.features[0].checks[0].reason = 'unknown',
    d => d.features[0].checks[0].reason = 'kill_switch', d => d.features[0].enabled = false,
    d => d.features[2].checks[0].reason = 'role_rule']) {
    const candidate = payload(); mutate(candidate); assert.throws(() => m.teacherAccessView(candidate, 7));
  }
});
test('acessos: interrupções e bloqueios individuais nunca se tornam autorização', async () => {
  const m = await mod;
  for (const reason of ['not_found', 'kill_switch', 'master_disabled', 'release_paused', 'release_retired', 'pilot_group_disabled', 'release_restricted_to_pilot', 'percentage_disabled', 'user_rule', 'role_rule', 'default']) {
    const data = payload(); data.features[0].enabled = false; Object.assign(data.features[0].checks[0], { enabled: false, reason });
    const row = m.teacherAccessView(data, 7).features[0]; assert.equal(row.enabled, false); assert.ok(m.accessReason(row.checks[0]).length > 10);
  }
  assert.match(m.accessReason({ enabled: true, reason: 'homologation_open_testing' }), /homologação/);
  assert.match(m.accessReason({ enabled: false, reason: 'user_rule' }), /Bloqueado especificamente/);
});
test('acessos: catálogo limita o escopo e separa exemplos do trabalho real', () => {
  assert.equal(new Set(catalog.features.map(f => f.id)).size, catalog.features.length);
  assert.equal(catalog.features.filter(f => f.group === 'work').length, 9);
  assert.deepEqual(catalog.features.find(f => f.id === 'exemptions').requires, ['classes.core', 'classes.assessment_assignments', 'classes.assessment_delivery', 'classes.assessment_exemptions']);
  assert.equal(catalog.features.filter(f => f.group === 'examples').length, 3);
  assert.deepEqual(catalog.features.find(f => f.id === 'feedback').requires, ['pedagogy.operational_cycle', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results']);
  for (const feature of catalog.features) for (const key of feature.requires) assert.ok(catalog.flags[key]);
});

const pilotPayload = () => ({ ...payload(), pilots: { version: pilots.version, features: pilots.features.map(feature => ({
  id: feature.id, enabled: true, checks: feature.requires.map(key => ({ key, enabled: true, reason: 'user_rule' })),
})) } });

test('acessos: extensão dos pilotos preserva catálogo legado e não inventa resultado em servidor antigo', async () => {
  const m = await mod, data = pilotPayload(), result = m.teacherAccessView(data, 7);
  assert.deepEqual(result.features, m.teacherAccessView(payload(), 7).features);
  assert.equal(m.teacherAccessView(payload(), 7).pilotFeatures, null);
  assert.equal(result.pilotFeatures.length, 4);
  assert.deepEqual(result.pilotFeatures.map(f => f.id), ['numeric_authoring', 'numeric_assessments', 'student_feedback', 'content_issues']);
  assert.deepEqual(pilots.features.find(f => f.id === 'numeric_assessments').requires,
    ['classes.core', 'classes.assessment_assignments', 'classes.numeric_assessments']);
  assert.deepEqual(pilots.features.find(f => f.id === 'student_feedback').requires,
    ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'classes.student_feedback_release']);
  for (const feature of pilots.features) {
    assert.equal(feature.group, 'pilots'); assert.ok(feature.hint.length > 20);
    for (const key of feature.requires) assert.ok(m.accessFlagLabels[key]);
  }
  data.pilots.secret = 'private'; data.pilots.features[0].checks[0].group_id = 'private';
  assert.equal(JSON.stringify(m.teacherAccessView(data, 7)).includes('private'), false);
});

test('acessos: pilotos parciais, inconsistentes ou com motivos desconhecidos não viram liberação', async () => {
  const m = await mod;
  for (const mutate of [d => d.pilots = null, d => d.pilots.version = 'unknown', d => delete d.pilots.features,
    d => d.pilots.features.pop(), d => d.pilots.features[1] = d.pilots.features[0],
    d => d.pilots.features[0].enabled = 'true', d => d.pilots.features[0].checks = [],
    d => d.pilots.features[0].checks[0].reason = 'unknown', d => d.pilots.features[0].checks[0].reason = 'kill_switch',
    d => d.pilots.features[0].checks[0].key = 'unknown', d => d.pilots.features[0].enabled = false,
    d => d.pilots.features[1].checks[0].reason = 'role_rule',
    d => { d.pilots.features[1].enabled = false; Object.assign(d.pilots.features[1].checks[0], { enabled: false, reason: 'user_rule' }); }]) {
    const data = pilotPayload(); mutate(data); assert.throws(() => m.teacherAccessView(data, 7));
  }
});

test('acessos: piloto bloqueado não esconde ferramentas independentes', async () => {
  const m = await mod, data = pilotPayload();
  data.pilots.features[0].enabled = false;
  Object.assign(data.pilots.features[0].checks[0], { enabled: false, reason: 'master_disabled' });
  const result = m.teacherAccessView(data, 7);
  assert.equal(result.pilotFeatures[0].enabled, false);
  assert.ok(result.features.every(f => f.enabled));
  assert.ok(result.pilotFeatures.slice(1).every(f => f.enabled));
});
