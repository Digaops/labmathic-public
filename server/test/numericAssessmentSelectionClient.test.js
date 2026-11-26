const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let selection, view;
test.before(async () => {
  selection = await import('../../client/src/services/numericAssessmentSelection.mjs');
  view = await import('../../client/src/services/assessmentView.mjs');
});
const source = (id, questionCode = id, version = 1) => ({ id, questionCode, version,
  title: 'Qual é a medida?', skillCode: 'EF06MA11', gradeName: '6º Ano', unit: 'cm', supportText: '' });

test('troca de versão mantém somente uma versão e preserva ordem e seleção original', () => {
  const sources = [source('a1', 'NUM-A'), source('a2', 'NUM-A', 2), source('b'), source('c')];
  const selected = ['b', 'a1', 'c'];
  assert.deepEqual(selection.toggleNumericVersion(sources, selected, 'a2'), ['b', 'a2', 'c']);
  assert.deepEqual(selected, ['b', 'a1', 'c']);
  assert.deepEqual(selection.toggleNumericVersion(sources, ['b', 'a2', 'c'], 'a2'), ['b', 'c']);
  assert.deepEqual(selection.toggleNumericVersion(sources, ['a1'], 'b'), ['a1', 'b']);
  assert.deepEqual(selection.toggleNumericVersion(sources, selected, 'missing'), selected);
});

test('limite de 100 impede acréscimo, mas permite desmarcar e trocar a versão', () => {
  const sources = Array.from({ length: 101 }, (_, i) => source('q' + i));
  sources.push(source('q0-v2', 'q0', 2));
  const selected = sources.slice(0, 100).map(s => s.id);
  assert.equal(selection.canSelectNumericVersion(sources, selected, 'q100'), false);
  assert.deepEqual(selection.toggleNumericVersion(sources, selected, 'q100'), selected);
  assert.equal(selection.canSelectNumericVersion(sources, selected, 'q0-v2'), true);
  const replaced = selection.toggleNumericVersion(sources, selected, 'q0-v2');
  assert.equal(replaced.length, 100);
  assert.equal(replaced[0], 'q0-v2');
  assert.equal(replaced.includes('q0'), false);
  assert.equal(selection.toggleNumericVersion(sources, selected, 'q0').length, 99);
});

test('mesmo enunciado não agrupa questões distintas; servidor antigo continua compatível', () => {
  const a = source('a'), b = source('b');
  assert.deepEqual(selection.toggleNumericVersion([a, b], ['a'], 'b'), ['a', 'b']);
  delete a.questionCode; delete b.questionCode;
  assert.deepEqual(selection.parseNumericSources([a, b]), [a, b]);
  assert.deepEqual(selection.toggleNumericVersion([a, b], ['a'], 'b'), ['a', 'b']);
  assert.deepEqual(view.parseAssessmentBootstrap({ sources: [], participants: [] }), { sources: [], participants: [] });
});

test('opções inválidas são recusadas antes de renderizar a seleção numérica', () => {
  const base = { sources: [], participants: [], numericEnabled: true, numericSources: [source('a')] };
  assert.equal(view.parseAssessmentBootstrap(base), base);
  for (const patch of [{ numericEnabled: 'true' }, { numericSources: null }, { numericSources: {} },
    { numericSources: undefined }, { numericSources: [source('a'), source('a')] }]) {
    assert.throws(() => view.parseAssessmentBootstrap({ ...base, ...patch }));
  }
  for (const patch of [{ id: '' }, { version: 0 }, { title: null }, { title: ' ' },
    { gradeName: null }, { supportText: undefined }, { questionCode: '' }, { questionCode: {} }]) {
    assert.throws(() => selection.parseNumericSources([{ ...source('a'), ...patch }]));
  }
  assert.throws(() => selection.parseNumericSources(Array.from({ length: 201 }, (_, i) => source(String(i)))));
});

test('busca aceita ano, habilidade, código e acentos sem alterar as questões selecionadas', () => {
  const sources = [source('a')], selected = ['a'];
  const matches = query => sources.filter(s => view.matchesAssessmentText(`${s.title} ${s.skillCode} ${s.gradeName} ${s.questionCode}`, query));
  assert.equal(matches('MEDIDA').length, 1);
  assert.equal(matches('6º ano').length, 1);
  assert.equal(matches('EF06MA11').length, 1);
  assert.equal(view.matchesAssessmentText('Medição e área', 'medicao e area'), true);
  assert.equal(matches('inexistente').length, 0);
  assert.deepEqual(selected, ['a']);
});

test('telas orientam busca vazia, troca de versão e alcance real da aprovação', () => {
  const screen = fs.readFileSync(require.resolve('../../client/src/components/ClassAssessments.jsx'), 'utf8');
  const picker = fs.readFileSync(require.resolve('../../client/src/components/NumericAssessmentSourcePicker.jsx'), 'utf8');
  assert.match(picker, /toggleNumericVersion\(numericSources, selectedIds, q.id\)/);
  assert.match(picker, /As questões já selecionadas foram mantidas/);
  assert.match(picker, /Limpar busca/);
  assert.match(screen, /numericVersionIds: sources.map[^\n]+pedagogicalConfirmed: false/);
  const admin = fs.readFileSync(require.resolve('../../client/src/pages/admin/NumericReviews.jsx'), 'utf8');
  assert.match(admin, /Aprovar questão/);
  assert.match(admin, /em papel e nas atividades on-line/);
  assert.doesNotMatch(admin, /Aprovar para uso em papel/);
});

test('paginação confere contagens e não aceita páginas incompletas', () => {
  const valid={data:[source('a')],pagination:{page:2,pageSize:20,total:21,totalPages:2}};
  assert.equal(selection.parseNumericSourcePage(valid),valid);
  selection.parseNumericSourcePage({data:[],pagination:{page:1,pageSize:20,total:0,totalPages:0}});
  for(const patch of [{page:0},{page:'2'},{page:100001},{pageSize:200},{total:-1},{total:1.5},{totalPages:3}]){
    assert.throws(()=>selection.parseNumericSourcePage({...valid,pagination:{...valid.pagination,...patch}}));
  }
  assert.throws(()=>selection.parseNumericSourcePage({...valid,data:[]}));
  assert.throws(()=>view.parseAssessmentBootstrap({sources:[],participants:[],numericSourceSearch:'true'}));
});

test('seleção sobrevive à busca e troca de página sem acumular o acervo inteiro', () => {
  const chosen=[source('a1','NUM-A'),source('b')];
  const nextPage=[source('a2','NUM-A',2),source('c')];
  const merged=selection.mergeNumericSourceSelection(chosen,nextPage);
  const ids=selection.toggleNumericVersion(merged,chosen.map(q=>q.id),'a2');
  assert.deepEqual(ids,['a2','b']);
  const retained=ids.map(id=>merged.find(q=>q.id===id));
  assert.deepEqual(selection.mergeNumericSourceSelection(retained,[]),retained);
  assert.deepEqual(selection.mergeNumericSourceSelection(retained,[source('d')]).map(q=>q.id),['a2','b','d']);
  assert.deepEqual(chosen.map(q=>q.id),['a1','b']);
});

test('busca remota cancela leituras antigas, trata falha sem recorte silencioso e mantém compatibilidade', () => {
  const picker=fs.readFileSync(require.resolve('../../client/src/components/NumericAssessmentSourcePicker.jsx'),'utf8');
  assert.match(picker,/search !== settledSearch/);assert.match(picker,/encodeURIComponent\(settledSearch.trim\(\)\)/);
  assert.match(picker,/setPage\(1\)/);assert.match(picker,/Tentar busca novamente/);
  assert.match(picker,/Conferir selecionadas/);assert.match(picker,/até 200 versões mais recentes/);
  const hook=fs.readFileSync(require.resolve('../../client/src/hooks/useHomeResource.js'),'utf8');
  assert.match(hook,/snapshot.key === key/);assert.match(hook,/controller.abort\(\)/);assert.match(hook,/!controller.signal.aborted/);
});
