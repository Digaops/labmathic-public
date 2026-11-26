const test = require('node:test');
const assert = require('node:assert/strict');
let view;
test.before(async()=>{view=await import('../../client/src/services/recoveryPlansView.mjs');});
const plan = () => ({id:'plan-1',title:'Apoio',status:'draft',revision:1,class:{id:'class-1',name:'Turma'},sourceAssessment:{id:'a-1',title:'Diagnóstico'},priorityCount:1,plannedQuestionCount:3,groupCount:0,studentCount:0,skills:[{skillId:1,code:'EF01MA01',description:'Contar',suggestedQuestionCount:3}],groups:[]});
const list = () => ({data:[plan()],counts:{total:1,draft:1,active:0,completed:0,archived:0}});
test('lista exige estados e contagens válidos, sem transformar erro em vazio',()=>{
  assert.deepEqual(view.parseRecoveryList(list()),list());
  for(const invalid of [null,{},[],{data:[]},{...list(),counts:{total:1}}, {...list(),data:[{...plan(),status:'unknown'}]}, {...list(),data:[{...plan(),revision:0}]}, {...list(),data:[{...plan(),groupCount:-1}]}, {...list(),data:[plan(), plan()]}, {...list(),data:[{...plan(),class:{id:'../outra',name:'Turma'}}]}]) assert.throws(()=>view.parseRecoveryList(invalid));
});
test('lista distingue ausência real de resposta incompleta e valida execução',()=>{
  assert.equal(view.parseRecoveryList({...list(),data:[]}).data.length,0);
  assert.throws(()=>view.parseRecoveryList({...list(),data:[{...plan(),execution:{total:2,handled:2,percentage:101}}]}));
  assert.equal(view.parseRecoveryList({...list(),data:[{...plan(),execution:{total:2,handled:1,percentage:50}}]}).data[0].execution.percentage,50);
});
test('consulta do plano valida prioridades, participantes e contexto',()=>{
  assert.equal(view.parseRecoveryPlan(plan()).id,'plan-1');
  for(const invalid of [{...plan(),class:null},{...plan(),skills:null},{...plan(),groups:[{id:'g',title:'Grupo',objective:'Contar',students:[{}]}]}, {...plan(),execution:{}}, {...plan(),skills:[{}]}]) assert.throws(()=>view.parseRecoveryPlan(invalid));
});
test('prévia incompleta não habilita a composição do plano',()=>{
  const valid={priorities:[],warnings:[],isActionable:false,source:{assessment:{id:'a-1',title:'Diagnóstico',revision:2},overview:{submittedCount:1},resultRevision:'hash'},methodology:{version:'v1'}};
  assert.equal(view.parseRecoveryPreview(valid),valid);
  for(const invalid of [{},null,{...valid,source:{}},{...valid,priorities:[{skill:{id:1}}]},{...valid,warnings:null}]) assert.throws(()=>view.parseRecoveryPreview(invalid));
});
test('situação determina a próxima ação sem confundir rascunho e histórico',()=>{
  assert.equal(view.recoveryAction(plan()),'Continuar revisão');
  assert.equal(view.recoveryAction({...plan(),status:'active'}),'Organizar aulas');
  assert.equal(view.recoveryAction({...plan(),status:'active',execution:{}}),'Acompanhar aulas');
  for(const status of ['completed','archived']) assert.equal(view.recoveryAction({...plan(),status}),'Ver histórico');
});
test('consulta mantém o histórico quando a habilidade de origem foi removida',()=>{
  const historical={...plan(),status:'completed',skills:[{skillId:null,code:'EF01MA01',description:'Contar',suggestedQuestionCount:3}]};
  assert.equal(view.parseRecoveryPlan(historical).skills[0].code,'EF01MA01');
});
test('filtros normalizados permanecem na URL, incluindo nomes acentuados',()=>{
  assert.deepEqual(view.readRecoveryQuery(new URLSearchParams('busca=  Números  e  operações &situacao=draft')),{search:'Números e operações',status:'draft',planId:null});
  assert.equal(view.readRecoveryQuery(new URLSearchParams('situacao=invalida')).status,'all');
  assert.equal(view.readRecoveryQuery(new URLSearchParams({busca:'x'.repeat(100)})).search.length,80);
  assert.equal(view.recoveryListPath({search:'A & B',status:'draft'}),'/classes/recovery-plans?limit=100&search=A+%26+B&status=draft');
});
test('atalho para plano aceita um identificador público e mantém a consulta da lista independente', () => {
  assert.equal(view.recoveryPlanPath('legacy_plano-1'), '/recomposicao?plano=legacy_plano-1');
  const query = view.readRecoveryQuery(new URLSearchParams('plano=legacy_plano-1&busca=frações&situacao=active'));
  assert.deepEqual(query, { search: 'frações', status: 'active', planId: 'legacy_plano-1' });
  assert.equal(view.recoveryListPath(query), '/classes/recovery-plans?limit=100&search=fra%C3%A7%C3%B5es&status=active');
  assert.equal(view.recoveryPlanPath(null), null);
  for (const id of ['', '../outro', '//exemplo.invalid', 'plano&busca=outro', 'x'.repeat(81), ' plano-1 ']) {
    assert.equal(view.recoveryPlanPath(id), null);
    assert.equal(view.readRecoveryQuery(new URLSearchParams({ plano: id })).planId, null);
  }
  assert.equal(view.readRecoveryQuery(new URLSearchParams('plano=um&plano=outro')).planId, null);
});
test('abrir detalhes e marcar confirmação não são alterações de conteúdo',()=>{
  const review={title:'Apoio',reviewed:false,priorities:{1:{expanded:true,selected:true,studentIds:['s']}}};
  assert.equal(view.recoveryReviewFingerprint(review),view.recoveryReviewFingerprint({...review,reviewed:true,priorities:{1:{...review.priorities[1],expanded:false}}}));
  assert.notEqual(view.recoveryReviewFingerprint(review),view.recoveryReviewFingerprint({...review,title:'Novo'}));
  assert.notEqual(view.recoveryReviewFingerprint(review),view.recoveryReviewFingerprint({...review,priorities:{1:{...review.priorities[1],studentIds:[]}}}));
  assert.equal(view.recoveryReviewFingerprint(null),'');
});
