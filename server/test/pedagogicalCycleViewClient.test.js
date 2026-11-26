const test = require('node:test');
const assert = require('node:assert/strict');
const service = import('../../client/src/services/pedagogicalCycleView.mjs');
const schoolClass = { id:'class-1', name:'7º A', gradeName:'7º Ano', academicYear:2026, status:'active', institution:{status:'pending'} };
const assessment = { id:'assessment-1', title:'Diagnóstico', status:'closed', isDiagnostic:true };
const evidence = { overview:{submittedCount:2,participantCount:3,meanPercentage:50},skills:[{code:'EF07MA01',description:'Comparar números.',successRate:50}] };
const feedback = { revision:1,evidenceHash:'a'.repeat(64),evidence,createdAt:'2026-09-09',objective:'Objetivo da turma.',observation:'Observação da aula.',action:'Apoio ao estudante.',verification:'Verificar a aprendizagem.' };
const detail = () => ({class:structuredClone(schoolClass),assessment:structuredClone(assessment),capabilities:{recovery:true},evidence:structuredClone(evidence),evidenceHash:'a'.repeat(64),feedback:structuredClone(feedback),feedbackStale:false,canSaveFeedback:true,plans:[],morePlans:false,notice:'Considere participação e contexto.'});
test('ciclo valida listas e paginação sem transformar falha em vazio',async()=>{
  const {parseCycleClasses,parseCycleOverview}=await service;
  const pagination={page:1,limit:30,total:1,totalPages:1};
  assert.equal(parseCycleClasses({data:[schoolClass],pagination}).data.length,1);
  assert.equal(parseCycleOverview({class:schoolClass,assessments:[assessment],pagination}).class.id,schoolClass.id);
  for(const data of [{}, {data:[],pagination:{}}, {data:[{}],pagination}]) assert.throws(()=>parseCycleClasses(data));
});
test('ciclo aceita turma com e sem evidências e rejeita falso resultado salvável',async()=>{
  const {parseCycleDetail}=await service; assert.equal(parseCycleDetail(detail()).canSaveFeedback,true);
  const pending={...detail(),evidence:null,evidenceHash:null,feedback:null,canSaveFeedback:false}; assert.equal(parseCycleDetail(pending).evidence,null);
  assert.throws(()=>parseCycleDetail({...pending,canSaveFeedback:true}));
  assert.throws(()=>parseCycleDetail({...detail(),evidence:{}}));
  assert.throws(()=>parseCycleDetail({...detail(),plans:null}));
});
test('ciclo preserva ausência de percentual e valida comparação de habilidades',async()=>{
  const {parseCycleDetail}=await service; const d=detail(); d.evidence.overview.meanPercentage=null;
  d.plans=[{id:'plan-1',title:'Apoio',status:'completed',interventionCount:1,interventionHandled:1,monitoring:{state:'evidence_ready',application:assessment,comparison:{skills:[{code:'EF07MA01',diagnosticRate:50,monitoringRate:100,delta:50}]}}}];
  assert.equal(parseCycleDetail(d).plans[0].status,'completed');
  d.plans[0].monitoring.comparison.skills[0].delta=NaN; assert.throws(()=>parseCycleDetail(d));
});
test('confirmação de escrita exige conteúdo, referência e revisão correspondentes',async()=>{
  const {confirmedFeedback}=await service;
  const body={...feedback,expectedRevision:0}; assert.equal(confirmedFeedback({feedback},body).revision,1);
  for(const result of [{},{feedback:{...feedback,revision:2}},{feedback:{...feedback,action:'Outro texto'}},{feedback:{...feedback,evidenceHash:'b'.repeat(64)}}]) assert.throws(()=>confirmedFeedback(result,body));
});
test('histórico exige formato completo, cursor válido e revisões distintas',async()=>{
  const {parseFeedbackHistory}=await service;
  assert.equal(parseFeedbackHistory({data:[feedback],nextBefore:null}).data.length,1);
  assert.throws(()=>parseFeedbackHistory({data:[feedback,feedback],nextBefore:null}));
  assert.throws(()=>parseFeedbackHistory({data:[],nextBefore:-1}));
  assert.throws(()=>parseFeedbackHistory({data:[{...feedback,evidence:null}],nextBefore:null}));
});
