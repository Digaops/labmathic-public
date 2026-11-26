const test=require('node:test');
const assert=require('node:assert/strict');
let view;
test.before(async()=>{view=await import('../../client/src/services/recoveryExecutionView.mjs');});
const lesson=()=>({id:'lesson',title:'Apoio',revision:1,status:'planned',phase:'intervention',plannedDate:'2026-09-09',durationMinutes:50,teacherNotes:'Anotação salva',skills:[],resources:[]});
const execution=()=>({id:'execution',revision:2,status:'active',progress:{total:1,handled:0,planned:1,taught:0,skipped:0,percentage:0},lessons:[lesson()]});
const plan=()=>({id:'plan',title:'Plano',status:'active',revision:2,class:{id:'class',name:'Turma'},sourceAssessment:{id:'assessment',title:'Diagnóstico'},skills:[],groups:[],execution:execution()});
test('execução rejeita contexto diferente, etapas incompletas e desaparecimento após envio',()=>{
  const p=plan();assert.equal(view.parseExecutionPlan(p,p),p);
  for(const change of [{id:'other'},{execution:null},{execution:{...execution(),lessons:[]}},{execution:{...execution(),progress:{...execution().progress,percentage:101}}}])assert.throws(()=>view.parseExecutionPlan({...p,...change},p));
  assert.throws(()=>view.parseExecutionPlan({...p,execution:{...execution(),lessons:[{...lesson(),id:'other'}]}},p));
  assert.equal(view.parseExecutionPlan({...p,execution:null},{...p,execution:null}).execution,null);
});
test('data real, intervalo de duração e motivo da verificação são validados',()=>{
  const f=view.lessonFields(lesson());assert.equal(view.lessonError(f,'intervention','taught'),'');
  for(const plannedDate of ['', '2026-02-30','2026-13-01'])assert.ok(view.lessonError({...f,plannedDate},'intervention','taught'));
  for(const durationMinutes of ['','9','601','10.5'])assert.ok(view.lessonError({...f,durationMinutes},'intervention','taught'));
  assert.ok(view.lessonError({...f,teacherNotes:'motivo'},'monitoring','skipped'));
  assert.equal(view.lessonError({...f,teacherNotes:'A turma não compareceu.'},'monitoring','skipped'),'');
});
test('recarregar recursos ou outra aula preserva anotações ainda não salvas',()=>{
  const initial=view.mergeLessonDrafts({},execution());
  initial.lesson.fields={...initial.lesson.fields,teacherNotes:'Edição local'};
  const next=view.mergeLessonDrafts(initial,{...execution(),revision:3});
  assert.equal(next.lesson.fields.teacherNotes,'Edição local');assert.equal(next.lesson.saved.teacherNotes,'Anotação salva');assert.equal(next.lesson.revision,1);
});
test('mudança remota em campos editados mantém revisão original até conferência humana',()=>{
  const initial=view.mergeLessonDrafts({},execution());initial.lesson.fields={...initial.lesson.fields,teacherNotes:'Meu texto'};
  const remote={...execution(),lessons:[{...lesson(),revision:2,teacherNotes:'Texto remoto'}]};
  const next=view.mergeLessonDrafts(initial,remote);
  assert.equal(next.lesson.fields.teacherNotes,'Meu texto');assert.equal(next.lesson.revision,1);
  assert.equal(view.mergeLessonDrafts({},remote).lesson.revision,2);
});
test('sem edição local a atualização mostra o que está salvo; revisão sem mudança de campos é segura',()=>{
  const initial=view.mergeLessonDrafts({},execution());
  assert.equal(view.mergeLessonDrafts(initial,{...execution(),lessons:[{...lesson(),revision:2,teacherNotes:'Novo'}]}).lesson.fields.teacherNotes,'Novo');
  initial.lesson.fields={...initial.lesson.fields,teacherNotes:'Local'};
  assert.equal(view.mergeLessonDrafts(initial,{...execution(),lessons:[{...lesson(),revision:2}]}).lesson.revision,2);
});
test('opções de recursos exigem a etapa, revisão, limites e seleção explícitos',()=>{
  const options={lesson:{id:'lesson'},executionRevision:2,editable:true,limits:{maxQuestions:10,maxMaterials:5},questions:[{id:1,code:'Q1',statement:'Questão',selected:false}],materials:[]};
  assert.equal(view.resourceOptions(options,'lesson'),options);
  for(const value of [null,{}, {...options,executionRevision:null},{...options,questions:[{id:1}]}])assert.throws(()=>view.resourceOptions(value,'lesson'));
  assert.throws(()=>view.resourceOptions(options,'other'));
});
test('verificação exige seleção única e conhecida, uma por habilidade e até 50',()=>{
  const options={ready:true,executionRevision:2,warnings:[],skills:[{skill:{code:'A'},questions:[{id:1,code:'Q1',statement:'Uma'}]},{skill:{code:'B'},questions:[{id:2,code:'Q2',statement:'Duas'}]}]};
  assert.equal(view.monitoringOptions(options),options);assert.equal(view.canPrepareMonitoring(options,[1,2]),true);
  for(const selected of [[],[1],[1,1,2],[1,2,3],Array.from({length:51},(_,i)=>i)])assert.equal(view.canPrepareMonitoring(options,selected),false);
  assert.equal(view.canPrepareMonitoring({...options,ready:false},[1,2]),false);
  assert.throws(()=>view.monitoringOptions({...options,skills:[{}]}));
});

const newMonitoringOptions=()=>({selectionMethodology:'unused-questions-v2',ready:true,executionRevision:2,questionCount:1,warnings:[],skills:[
  {skill:{id:7,code:'EF07MA01'},minimum:1,recommended:2,availability:'available',questions:[{id:1,code:'Q1',statement:'Uma questão válida.',selected:true}]}]});
test('uma questão por habilidade habilita a nova seleção e remover a única bloqueia',()=>{
  const value=view.monitoringOptions(newMonitoringOptions());
  assert.equal(view.canPrepareMonitoring(value,[1]),true);
  assert.equal(view.canPrepareMonitoring(value,[]),false);
});
test('nova seleção recusa falso pronto, contagem divergente e questão repetida',()=>{
  for(const mutate of [v=>{v.ready=false;},v=>{v.questionCount=2;},v=>{v.skills[0].minimum=2;},
    v=>{v.skills[0].availability='no_questions';},v=>{v.skills.push(structuredClone(v.skills[0]));},
    v=>{v.skills[0].questions[0].selected=undefined;}]){
    const value=newMonitoringOptions();mutate(value);assert.throws(()=>view.monitoringOptions(value));
  }
});
test('falta de questão em uma das habilidades mantém criação bloqueada e preserva a outra',()=>{
  const value=newMonitoringOptions();value.ready=false;
  value.skills.push({skill:{id:8,code:'EF07MA02'},minimum:1,recommended:2,availability:'no_questions',questions:[]});
  assert.equal(view.monitoringOptions(value).skills[0].questions.length,1);
  assert.equal(view.canPrepareMonitoring(value,[1]),false);
  value.skills[1].availability='skill_unavailable';value.skills[1].skill.id=null;
  assert.equal(view.monitoringOptions(value).ready,false);
});
