const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/classesView.mjs');
const read = file => fs.readFileSync(path.resolve(__dirname, '../../client/src', file), 'utf8');

test('buscar antes de escolher a primeira turma conserva o simulado, sem carregá-lo para outra turma', async () => {
  const { classesQuery, classNavigation, classSearchChange, classSelectionChange } = await model;
  const original = new URLSearchParams('secao=avaliacoes&simulado=42&origem=banco');
  const searched = classNavigation(original, classSearchChange(classesQuery(original), '  7º A  '));
  assert.equal(searched.get('simulado'), '42');
  assert.equal(searched.get('busca'), '7º A');
  assert.equal(searched.get('origem'), 'banco');
  assert.equal(searched.get('turma'), null);
  const selected = classNavigation(searched, classSelectionChange(classesQuery(searched), 'class-a'));
  assert.equal(selected.get('simulado'), '42');
  assert.equal(selected.get('secao'), 'avaliacoes');
  for (const changes of [classSelectionChange(classesQuery(selected), 'class-b'), classSearchChange(classesQuery(selected), '8º')]) {
    const changed = classNavigation(selected, changes);
    assert.equal(changed.get('simulado'), null);
    assert.equal(changed.get('secao'), null);
  }
  assert.equal(original.get('busca'), null);
});

test('origens inválidas não sobrevivem à busca inicial nem viram um atalho', async () => {
  const { classesQuery, classSearchChange } = await model;
  for (const source of ['', '0', '-1', '1.5', 'NaN', '9007199254740992', '//external.test', '<script>']) {
    const query = classesQuery(new URLSearchParams({ simulado: source, secao: 'avaliacoes' }));
    assert.equal(classSearchChange(query, 'A').simulado, null, source);
  }
});

test('retorno à aplicação usa caminho fixo, IDs opacos válidos e não aceita destinos externos', async () => {
  const { classAssessmentPath } = await model;
  assert.equal(classAssessmentPath('class-a', 'assessment-b'), '/turmas?turma=class-a&secao=avaliacoes&avaliacao=assessment-b');
  assert.equal(classAssessmentPath('class-a'), '/turmas?turma=class-a&secao=avaliacoes');
  for (const invalid of [null, 1, '', '//external.test', 'https://external.test', '../a', 'a&returnTo=x', 'a b', 'x'.repeat(81)]) {
    assert.equal(classAssessmentPath(invalid, 'assessment-b'), null);
    if (invalid !== '') assert.equal(classAssessmentPath('class-a', invalid), null);
  }
});

test('avaliacao é intenção somente de leitura, depende de turma/seção e prevalece sobre preparação', async () => {
  const { classesQuery } = await model;
  const valid = classesQuery(new URLSearchParams('turma=class-a&secao=avaliacoes&avaliacao=assessment-b&simulado=42&returnTo=https://external.test'));
  assert.equal(valid.assessment, 'assessment-b');
  assert.equal(valid.source, null);
  assert.equal(classesQuery(new URLSearchParams('avaliacao=assessment-b&secao=avaliacoes')).assessment, null);
  assert.equal(classesQuery(new URLSearchParams('turma=class-a&avaliacao=assessment-b')).assessment, null);
  for (const invalid of ['', '//external.test', '../a', '<script>', 'x'.repeat(81)]) {
    const query = classesQuery(new URLSearchParams({ turma: 'class-a', secao: 'avaliacoes', avaliacao: invalid, simulado: '42' }));
    assert.equal(query.assessment, null);
    assert.equal(query.source, null);
  }
});

test('trocar turma, seção ou filtros limpa a avaliação sem apagar parâmetros alheios', async () => {
  const { classNavigation } = await model;
  const original = new URLSearchParams('turma=class-a&secao=avaliacoes&avaliacao=assessment-b&origem=inicio');
  for (const changes of [{ turma: 'class-b' }, { turma: null }, { secao: null }, { busca: 'A' }, { busca: null }, { situacao: 'archived' }]) {
    const next = classNavigation(original, changes);
    assert.equal(next.get('avaliacao'), null);
    assert.equal(next.get('origem'), 'inicio');
  }
  assert.equal(classNavigation(original, { simulado: null }).get('avaliacao'), 'assessment-b');
  assert.equal(original.get('avaliacao'), 'assessment-b');
});

test('limpar busca ou trocar aba nunca reativa o simulado descartado por um retorno à avaliação', async () => {
  const { classesQuery, classNavigation } = await model;
  const original = new URLSearchParams('turma=class-a&secao=avaliacoes&avaliacao=assessment-b&simulado=42&busca=sem-resultado');
  for (const changes of [{ busca: null }, { secao: null }, { secao: 'avaliacoes' }, { turma: 'class-b' }, { avaliacao: null, simulado: '42' }]) {
    const next = classNavigation(original, changes);
    assert.equal(next.get('avaliacao'), null);
    assert.equal(next.get('simulado'), null);
    assert.equal(classesQuery(next).source, null);
  }
  assert.equal(original.get('simulado'), '42');
});

test('localização só reconhece a lista confirmada da turma e não transforma erro em ausência', async () => {
  const { locateClassAssessment } = await model;
  const assignments = Object.freeze([Object.freeze({ id: 'assessment-b', title: 'Atividade' })]);
  assert.deepEqual(locateClassAssessment('assessment-b', { assignments }), { status: 'found', id: 'assessment-b' });
  assert.deepEqual(locateClassAssessment('other-class-assessment', { assignments }), { status: 'missing', id: null });
  assert.deepEqual(locateClassAssessment('assessment-b', { assignments: [] }), { status: 'missing', id: null });
  assert.deepEqual(locateClassAssessment('assessment-b', { assignments, loading: true }), { status: 'loading', id: null });
  assert.deepEqual(locateClassAssessment('assessment-b', { assignments, error: 'Falha de consulta' }), { status: 'unavailable', id: null });
  for (const invalid of [null, '', 1, '../a', '<script>']) assert.deepEqual(locateClassAssessment(invalid, { assignments }), { status: 'idle', id: null });
});

test('início retoma a aplicação exata e omite identificadores inválidos', async () => {
  const { recentHomeWork } = await import('../../client/src/services/teacherHome.mjs');
  const item = { id: 'assessment-b', title: 'Atividade', status: 'open', class: { id: 'class-a', name: 'Turma A' } };
  const options = { activeClassIds: ['class-a'], assessmentsEnabled: true };
  assert.equal(recentHomeWork({ ...options, overview: { recentAssessments: [item] } })[0].to,
    '/turmas?turma=class-a&secao=avaliacoes&avaliacao=assessment-b');
  for (const id of [undefined, null, '', 1, '../a', '//external.test']) {
    assert.deepEqual(recentHomeWork({ ...options, overview: { recentAssessments: [{ ...item, id }] } }), []);
  }
});

test('componentes conectam retorno, foco e aviso sem iniciar escrita ou abrir modal', () => {
  const classes = read('pages/Classes.jsx');
  const assessments = read('components/ClassAssessments.jsx');
  const cycle = read('pages/PedagogicalCycle.jsx');
  assert.match(classes, /change\(classSearchChange\(query, search\)\)/);
  assert.match(classes, /requestedAssessmentId=\{query.assessment\}/);
  assert.match(classes, /Escolha a turma para preparar este simulado/);
  assert.match(classes, /encodeURIComponent\(pendingSource\)/);
  assert.match(cycle, /onClick=\{guard\} to=\{classAssessmentPath\(classId, assessmentId\)/);
  const focusEffect = assessments.slice(assessments.indexOf('if (!requestedAssessmentId)'), assessments.indexOf('const filteredSources'));
  assert.match(focusEffect, /location.status !== 'found'/);
  assert.match(focusEffect, /requestedCard.current.focus\(\{ preventScroll: true \}\)/);
  assert.match(focusEffect, /cancelAnimationFrame/);
  assert.doesNotMatch(focusEffect, /api\.|prepareSource\(|set\w*Dialog\(|setWizard\(/);
  assert.match(assessments, /location.status === 'missing'.*Não encontramos esta aplicação nesta turma/);
  assert.match(assessments, /location.id === assignment.id && existingNotice !== assignment.id.*Aplicação selecionada/);
  assert.match(assessments, /Aplicação selecionada · \{schoolClass.name\}/);
});

test('assistente mantém turma e instrumento visíveis também no atalho que começa pelos estudantes', () => {
  const source = read('components/ClassAssessments.jsx');
  const start = source.indexOf('<div data-assessment-context');
  const end = source.indexOf('<fieldset', start);
  assert.ok(start > source.indexOf('<AssessmentDialog title={wizardTitle}'));
  assert.ok(end > start && end < source.indexOf('<nav aria-label="Etapas da aplicação"'));
  const context = source.slice(start, end);
  assert.match(context, /<strong>Turma:<\/strong> \{schoolClass.name\}/);
  assert.match(context, /numericActivity \? 'Atividade:' : 'Simulado:'/);
  assert.match(context, /numericActivity \? form.numericTitle.trim\(\) \|\| wizard.title/);
  assert.match(context, /: selectedSource\?\.title \|\| wizard.title/);
  assert.match(context, /break-words/);
  assert.doesNotMatch(context, /step|api\.|onClick|onChange/);
});
