const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const service = import('../../client/src/services/dashboardHome.mjs');
const source = name => fs.readFileSync(path.resolve(__dirname, '../../client/src', name), 'utf8');
const flags = features => ({ loading: false, unavailable: false, features: { 'institutions.read_model': true, ...features } });
const institutional = mode => ({ enabled: true, loading: false, refreshing: false, error: '', model: { mode } });

test('início mantém administração e docência e distingue gestão pelo modelo confirmado', async () => {
  const { dashboardHomeState } = await service;
  assert.equal(dashboardHomeState({ isAdmin: true, flags: { loading: true } }), 'admin');
  assert.equal(dashboardHomeState({ isAdmin: true, flags: flags(), institutional: institutional('manager') }), 'admin');
  assert.equal(dashboardHomeState({ flags: flags(), institutional: institutional('professional') }), 'teacher');
  assert.equal(dashboardHomeState({ flags: flags({ 'institutions.read_model': false }) }), 'teacher');
  for (const scopeLevel of ['municipality', 'school', 'mixed']) {
    const context = institutional('manager'); context.model.scopeLevel = scopeLevel;
    assert.equal(dashboardHomeState({ flags: flags(), institutional: context }), 'manager');
  }
});

test('contexto inicial, negado ou incompleto não vira início docente nem gestor', async () => {
  const { dashboardHomeState } = await service;
  assert.equal(dashboardHomeState({ flags: { loading: true } }), 'loading');
  assert.equal(dashboardHomeState({ flags: flags(), institutional: { enabled: true, loading: true, model: null } }), 'loading');
  for (const input of [
    { flags: { loading: false, unavailable: true, features: {} } },
    { flags: { loading: false, unavailable: false, features: {} } },
    { flags: flags(), institutional: { enabled: true, error: 'indisponível', model: null } },
    { flags: flags(), institutional: { enabled: false, model: { mode: 'manager' } } },
    { flags: flags(), institutional: institutional('admin') },
    { flags: flags(), institutional: institutional('unknown') },
    { flags: flags({ 'institutions.read_model': 'true' }), institutional: institutional('manager') },
  ]) assert.equal(dashboardHomeState(input), 'unavailable');
});

test('atualização e erro transitório conservam apenas o contexto confirmado pelo provider', async () => {
  const { dashboardHomeState } = await service;
  for (const [mode, expected] of [['manager', 'manager'], ['professional', 'teacher']]) {
    const context = institutional(mode);
    assert.equal(dashboardHomeState({ flags: flags(), institutional: { ...context, refreshing: true } }), expected);
    assert.equal(dashboardHomeState({ flags: { ...flags(), unavailable: true }, institutional: { ...context, error: 'falha transitória' } }), expected);
  }
  assert.equal(dashboardHomeState({ flags: flags(), institutional: { enabled: true, model: null, error: 'acesso negado' } }), 'unavailable');
  assert.equal(dashboardHomeState({ flags: flags(), institutional: { enabled: true, model: null, loading: true } }), 'loading');
  assert.equal(dashboardHomeState({ flags: flags(), institutional: institutional('professional') }), 'teacher');
});

test('falha de flags com snapshot válido mantém gestão e usa o aviso global de conexão', async () => {
  const { dashboardHomeState } = await service;
  assert.equal(dashboardHomeState({ flags: { ...flags(), unavailable: true }, institutional: institutional('manager') }), 'manager');
  const layout = source('components/Layout.jsx');
  assert.match(layout, /\{unavailable && <div role="status"/);
  assert.match(layout, /Conexão instável: mantendo as opções já confirmadas/);
});

test('acompanhamento exige todas as dependências existentes e retrato tem liberação própria', async () => {
  const { institutionalHomeLinks } = await service;
  const dependencies = ['institutions.school_coordination', 'institutions.read_model', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results'];
  const available = Object.fromEntries(dependencies.map(key => [key, true]));
  assert.equal(institutionalHomeLinks(available).network[0].to, '/acompanhamento-escolar');
  for (const key of dependencies) for (const value of [false, undefined, 'true']) {
    assert.ok(!institutionalHomeLinks({ ...available, [key]: value }).network.some(item => item.to === '/acompanhamento-escolar'));
  }
  assert.ok(!institutionalHomeLinks(available).network.some(item => item.to === '/retrato-da-rede'));
  assert.deepEqual(institutionalHomeLinks({ 'institutions.network_portrait': true }).network.map(item => item.to), ['/retrato-da-rede']);
  assert.deepEqual(institutionalHomeLinks().network, []);
});

test('gestão conserva recursos pessoais por liberação sem inferir vínculo docente de totais', async () => {
  const { institutionalHomeLinks } = await service;
  const basic = institutionalHomeLinks().personal.map(item => item.to);
  for (const route of ['/banco-questoes', '/simulados', '/biblioteca', '/favoritos', '/colecoes']) assert.ok(basic.includes(route));
  for (const route of ['/turmas', '/planejamento', '/recomposicao', '/banco-questoes/devolutivas']) assert.ok(!basic.includes(route));
  const enabled = { 'classes.core': true, 'planning.lesson_planner': true, 'classes.learning_recovery': true,
    'pedagogy.operational_cycle': true, 'classes.assessment_assignments': true, 'classes.assessment_results': true };
  const personal = institutionalHomeLinks(enabled).personal.map(item => item.to);
  for (const route of ['/turmas', '/planejamento', '/recomposicao', '/banco-questoes/devolutivas']) assert.ok(personal.includes(route));
  for (const key of ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results', 'classes.learning_recovery']) {
    assert.ok(!institutionalHomeLinks({ ...enabled, [key]: false }).personal.some(item => item.to === '/recomposicao'));
  }
  assert.ok(institutionalHomeLinks({ ...enabled, 'pedagogy.operational_cycle': false }).personal.some(item => item.to === '/recomposicao'));
  assert.doesNotMatch(source('services/dashboardHome.mjs'), /teacherCount|roleLabels|summary|memberships/);
});

test('entrada reutiliza providers, mantém estados acessíveis e não faz consultas ou gravações', () => {
  const dashboard = source('pages/Dashboard.jsx');
  const home = source('components/InstitutionalHome.jsx');
  assert.match(dashboard, /useInstitutionalReadModel/);
  assert.match(dashboard, /dashboardHomeState\(\{ isAdmin, flags, institutional \}\)/);
  assert.match(dashboard, /state === 'loading' \|\| state === 'unavailable'/);
  assert.match(dashboard, /state === 'manager'/);
  assert.match(dashboard, /isAdmin \? <AdministrativeHome \/> : <TeacherHome \/>/);
  assert.match(home, /data-institutional-home/);
  assert.match(home, /editorial-workspace/);
  assert.match(home, /role="alert"/);
  assert.match(home, /role="status"/);
  assert.match(home, /role=\{loading \? 'status' : 'alert'\}/);
  assert.match(home, /disabled=\{refreshing\}/);
  assert.match(home, /Recursos e trabalho pessoal/);
  assert.match(home, /focus-visible:outline/);
  assert.match(home, /min-h-11/);
  assert.doesNotMatch(dashboard + home, /api\.|fetch\(|localStorage|sessionStorage|useHomeResource|<main/);
  assert.doesNotMatch(home, /TeacherHome/);
});
