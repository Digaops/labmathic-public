const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/teacherHome.mjs');
const read = file => fs.readFileSync(path.resolve(__dirname, '../../client/src', file), 'utf8');

test('início distingue resposta vazia válida de formato inválido', async () => {
  const { homeList, homeClasses, homePlans, homeOverview } = await model;
  assert.deepEqual(homeList({ data: [] }), []);
  assert.deepEqual(homeClasses([]), []);
  assert.deepEqual(homePlans({ plans: [] }), []);
  for (const invalid of [null, {}, { data: null }, { data: [null] }, { data: [{ id: 1 }] }]) assert.throws(() => homeList(invalid));
  assert.throws(() => homeClasses([{ id: 1, name: 'A' }]));
  assert.throws(() => homePlans({ plans: [{ id: 1, title: 'Sem identidade de plano' }] }));
  assert.throws(() => homeOverview({ metrics: {}, recentAssessments: [], recentRecoveryPlans: [] }));
});

test('início usa link da turma e seção de aplicações sem interpretar o nome como vínculo', async () => {
  const { classHomePath, homeClasses } = await model;
  assert.equal(classHomePath('a&b'), '/turmas?turma=a%26b');
  assert.equal(classHomePath('a&b', true), '/turmas?turma=a%26b&secao=avaliacoes');
  assert.deepEqual(homeClasses([{ id: 'a', name: 'A', status: 'archived' }]), []);
});

test('trabalho recente respeita permissões, destino e situação de arquivamento', async () => {
  const { recentHomeWork } = await model;
  const overview = { recentAssessments: [{ id: 'a', title: 'Avaliação', status: 'open', class: { id: 'c', name: 'Turma' }, updatedAt: '2026-09-09' }],
    recentRecoveryPlans: [{ id: 'r', title: 'Plano', status: 'draft', updatedAt: '2026-09-08' }] };
  assert.deepEqual(recentHomeWork({ overview, assessmentsEnabled: false, recoveryEnabled: false }), []);
  const rows = recentHomeWork({ overview, activeClassIds: ['c'], assessmentsEnabled: true, recoveryEnabled: true,
    plans: [{ publicId: 'p', title: 'Planejamento', status: 'active', updatedAt: '2026-09-10' }, { publicId: 'old', status: 'archived' }] });
  assert.equal(rows.length, 3);
  assert.equal(rows[0].to, '/turmas?turma=c&secao=avaliacoes&avaliacao=a');
  assert.equal(rows[0].action, 'Acompanhar aplicação');
  assert.equal(rows[1].to, '/recomposicao?plano=r');
  assert.equal(rows[1].action, 'Continuar revisão');
  assert.equal(rows[2].to, '/planejamento/p');
  assert.equal(rows.some(row => row.key.includes('old')), false);
});

test('avaliação de turma fora da lista ativa não produz link que abriria outra turma', async () => {
  const { recentHomeWork } = await model;
  const overview = { recentAssessments: [{ id: 'a', title: 'Avaliação antiga', status: 'closed', class: { id: 'archived', name: 'Antiga' } }] };
  assert.deepEqual(recentHomeWork({ overview, activeClassIds: ['active'], assessmentsEnabled: true }), []);
  assert.deepEqual(recentHomeWork({ overview, assessmentsEnabled: true }), []);
});

test('recorte recente é limitado e não modifica a lista recebida', async () => {
  const { recentHomeWork } = await model;
  const plans = Array.from({ length: 8 }, (_, i) => ({ publicId: `p${i}`, title: `Plano ${i}`, status: 'draft', updatedAt: `2026-09-${10 + i}` }));
  const original = structuredClone(plans);
  assert.equal(recentHomeWork({ plans }).length, 4);
  assert.deepEqual(plans, original);
});

test('trabalho confirmado em andamento precede históricos mais recentes e não fabrica ações', async () => {
  const { recentHomeWork } = await model;
  const overview = {
    recentAssessments: [{ id: 'a', title: 'Avaliação', status: 'closed', class: { id: 'c', name: 'Turma' }, updatedAt: '2026-11-18' }],
    recentRecoveryPlans: [
      { id: 'r', title: 'Apoio', status: 'active', execution: null, updatedAt: '2026-11-01' },
      { id: '../outro', title: 'Identificador inválido', status: 'draft' },
      { id: 'desconhecido', title: 'Estado inválido', status: 'pending' },
    ],
  };
  const rows = recentHomeWork({ overview, activeClassIds: ['c'], assessmentsEnabled: true, recoveryEnabled: true,
    plans: [{ publicId: 'p', title: 'Planejamento', status: 'completed', updatedAt: '2026-11-19' }] });
  assert.deepEqual(rows.map(row => [row.to, row.action]), [
    ['/recomposicao?plano=r', 'Organizar aulas'],
    ['/planejamento/p', 'Consultar planejamento'],
    ['/turmas?turma=c&secao=avaliacoes&avaliacao=a', 'Consultar aplicação'],
  ]);
});

test('avisos de acompanhamento exigem dados reais e a flag correspondente', async () => {
  const { homeAttention } = await model;
  const permissions = { assessmentsEnabled: true, recoveryEnabled: true };
  assert.deepEqual(homeAttention(null, permissions), []);
  const overview = { metrics: { assessments: { open: 2, scheduled: 1 }, recoveryPlans: { draft: 3 } } };
  assert.equal(homeAttention(overview, permissions).length, 3);
  assert.equal(homeAttention(overview, { assessmentsEnabled: false, recoveryEnabled: false }).length, 0);
});

test('datas ausentes e inválidas não viram datas inventadas', async () => {
  const { homeDate } = await model;
  assert.equal(homeDate(null), '');
  assert.equal(homeDate('not-a-date'), '');
  assert.ok(homeDate('2026-09-09 12:00:00').includes('09'));
});

test('docência tem entrada própria, consulta cancelável e sem gravação', () => {
  const dashboard = read('pages/Dashboard.jsx');
  const teacher = read('components/TeacherHome.jsx');
  const hook = read('hooks/useHomeResource.js');
  assert.match(dashboard, /isAdmin \? <AdministrativeHome \/> : <TeacherHome \/>/);
  assert.match(teacher, /data-testid="dashboard-heading"/);
  assert.match(hook, /AbortController/);
  assert.match(hook, /snapshot.key === key/);
  assert.match(hook, /timeout: 15000/);
  assert.doesNotMatch(teacher + hook, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(teacher, /dashboard-stats|Criar primeira turma|<main/);
  assert.match(teacher, /!flags.loading && flags.isEnabled\(key\)/);
});

test('entrada docente preserva descoberta das áreas sem misturar exemplos com ciclo real', () => {
  const teacher = read('components/TeacherHome.jsx');
  for (const name of ['classes.core', 'classes.assessment_assignments', 'planning.lesson_planner',
    'institutions.read_model', 'question_bank.typed_preview', 'question_bank.feedback_preview', 'question_bank.catalog_preview']) assert.ok(teacher.includes(name));
  assert.match(teacher, /recoveryWorkspaceState\(user\?\.role, flags\)/);
  assert.match(teacher, /enabled\('question_bank.feedback_preview'\)/);
  assert.match(teacher, /to: '\/exemplos\/devolutivas'/);
  assert.match(teacher, /to="\/banco-questoes\/devolutivas"/);
  assert.match(teacher, /Conhecer os exemplos/);
  assert.match(teacher, /Elas não salvam atividades/);
});
