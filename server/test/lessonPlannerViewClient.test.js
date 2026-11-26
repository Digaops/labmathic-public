const test=require('node:test'),assert=require('node:assert/strict');
let v;test.before(async()=>{v=await import('../../client/src/services/lessonPlannerView.mjs');});
const lesson=()=>({publicId:'l1',title:'Aula',objective:'Comparar estratégias.',teacherNotes:'Salva',plannedDate:'2026-09-14',durationMinutes:50,status:'planned',revision:1,skills:[{id:1,code:'EF01MA01',description:'Contar'}],resources:[]});
const plan=()=>({publicId:'p',title:'Plano',revision:1,status:'draft',class:{publicId:'c',name:'Turma'},discipline:{id:1,name:'Matemática'},periodType:'week',startsOn:'2026-09-14',endsOn:'2026-09-18',lessons:[lesson()]});
const classes=[{publicId:'c',name:'Turma',academicYear:2026,disciplines:[{id:1,name:'Matemática'}]}];
test('lista não interpreta contrato inválido como ausência de planos',()=>{
  const valid={plans:[{...plan(),lessonCount:1,taughtCount:0}]};assert.equal(v.parsePlannerList(valid),valid);
  for(const invalid of [null,{}, {plans:[{}]},{plans:[{...valid.plans[0],taughtCount:2}]}])assert.throws(()=>v.parsePlannerList(invalid));
  assert.deepEqual(v.parsePlannerList({plans:[]}),{plans:[]});
});
test('plano valida identidade e estrutura; habilidades removidas mantêm snapshot',()=>{
  assert.equal(v.parsePlanner({plan:plan()},'p').publicId,'p');
  assert.throws(()=>v.parsePlanner({plan:plan()},'outro'));
  for(const p of [{...plan(),lessons:[]},{...plan(),lessons:[{}]},{...plan(),lessons:[lesson(),lesson()]}])assert.throws(()=>v.parsePlanner({plan:p}));
  const historical=plan();historical.lessons[0].skills[0].id=null;assert.equal(v.parsePlanner({plan:historical}).lessons[0].skills[0].code,'EF01MA01');
  for(const patch of [{teacherNotes:{}},{durationMinutes:'50'},{plannedDate:'2026-02-30'},{resources:[{type:'activity',title:'Teste',notes:{}}]}])assert.throws(()=>v.parsePlanner({plan:{...plan(),lessons:[{...lesson(),...patch}]}}));
  assert.throws(()=>v.parsePlanner({plan:{...plan(),periodType:undefined}}));
});
test('bootstrap e catálogos exigem listas e identidades utilizáveis',()=>{
  assert.equal(v.parsePlannerBootstrap({classes,grades:[]}).classes.length,1);
  assert.throws(()=>v.parsePlannerBootstrap({classes:[{}],grades:[]}));
  assert.throws(()=>v.parsePlannerSkills({skills:null,units:[]}));
  assert.throws(()=>v.parsePlannerResources({materials:[],questions:[{}],questionSets:[]}));
  assert.equal(v.parsePlannerResources({materials:[],questions:[],questionSets:[]}).materials.length,0);
});
test('catálogo paginado confere categoria, página, contagens e identidade sem aceitar respostas antigas',()=>{
  const value={category:'materials',page:2,pageSize:20,total:21,totalPages:2,items:[{id:21,title:'Recurso além das sugestões'}]};
  assert.equal(v.parsePlannerResourcePage(value,{category:'materials',page:2}),value);
  assert.throws(()=>v.parsePlannerResourcePage(value,{category:'questions',page:2}));
  assert.throws(()=>v.parsePlannerResourcePage(value,{category:'materials',page:1}));
  for(const patch of [{category:'other'},{items:null},{total:-1},{total:1.5},{totalPages:3},{pageSize:30},{page:0},{page:1.2},{items:[]},{items:[{}]}]){
    assert.throws(()=>v.parsePlannerResourcePage({...value,...patch}));
  }
  assert.throws(()=>v.parsePlannerResourcePage({...value,total:22,items:[{id:21,title:'A'},{id:21,title:'B'}]}));
  for(const category of ['materials','questions','questionSets'])assert.deepEqual(v.parsePlannerResourcePage({category,page:1,pageSize:20,total:0,totalPages:0,items:[]}).items,[]);
  assert.deepEqual(v.parsePlannerResourcePage({...value,page:3,items:[]}).items,[]);
});
test('validação cobre período, contexto, título, habilidades, duração e recursos',()=>{
  const f=v.plannerForm(plan());assert.equal(v.plannerError(f,classes),'');
  for(const patch of [{classPublicId:'x'},{disciplineId:2},{title:''},{startsOn:'2026-02-30'},{endsOn:'2026-01-01'},{startsOn:'2025-09-14'}])assert.ok(v.plannerError({...f,...patch},classes));
  for(const patch of [{title:''},{objective:''},{skills:[]},{durationMinutes:0},{durationMinutes:10.5},{plannedDate:'2026-09-19'},{resources:Array(51).fill({})}])assert.ok(v.plannerError({...f,lessons:[{...f.lessons[0],...patch}]},classes));
  assert.equal(v.plannerError({...f,lessons:[{...f.lessons[0],durationMinutes:'',plannedDate:''}]},classes),'');
});
test('payload preserva campos vazios opcionais, sem inventar duração padrão',()=>{
  const f=v.plannerForm(plan());f.lessons[0].durationMinutes='';const payload=v.plannerPayload(f);
  assert.equal(payload.lessons[0].durationMinutes,null);assert.deepEqual(payload.lessons[0].skillIds,[1]);assert.equal(payload.lessons[0].publicId,undefined);
});
test('salvar uma aula não substitui a anotação de outra',()=>{
  const p=plan();p.lessons.push({...lesson(),publicId:'l2'});
  const baseline=v.plannerForm(p),local=v.plannerForm(p);local.lessons[0].teacherNotes='Enviada';local.lessons[1].teacherNotes='Ainda em edição';
  const next=structuredClone(p);next.lessons[0].teacherNotes='Enviada';next.lessons[0].status='taught';next.revision++;
  const merged=v.mergePlannerNotes(local,baseline,next,'l1');assert.equal(merged.lessons[1].teacherNotes,'Ainda em edição');assert.equal(merged.lessons[0].status,'taught');assert.notEqual(v.formFingerprint(merged),v.formFingerprint(v.plannerForm(next)));
});
test('notas locais podem ser copiadas após encerramento em outro acesso',()=>{
  const p=plan(),base=v.plannerForm(p),local=v.plannerForm(p);local.lessons[0].teacherNotes='Não salva';
  const next={...p,status:'completed',lessons:[{...lesson(),status:'taught'}]};
  assert.equal(v.mergePlannerNotes(local,base,next).lessons[0].teacherNotes,'Não salva');
});
test('filtros e datas são normalizados sem lançar exceção em histórico',()=>{
  assert.deepEqual(v.plannerQuery(new URLSearchParams('busca=  Aula  de  números &situacao=active&pagina=99')),{search:'Aula de números',status:'active',page:5});
  assert.equal(v.plannerDate('inválida'),'Sem data');assert.equal(v.validDate('2026-02-30'),false);assert.equal(v.validDate('2024-02-29'),true);
});
test('cópia manual reúne todas as aulas e orientações sem gravar nem mudar o rascunho',()=>{
  const f=v.plannerForm(plan());f.lessons.push({...f.lessons[0],title:'Segunda aula',teacherNotes:'Anotação ainda não enviada',resources:[{type:'activity',title:'Conversa',notes:'Orientação a preservar'}]});
  const before=v.formFingerprint(f),copy=v.plannerCopyText(f,'Turma de teste');
  for(const fragment of ['Turma de teste','Segunda aula','Anotação ainda não enviada','EF01MA01','Orientação a preservar'])assert.ok(copy.includes(fragment));
  assert.equal(v.formFingerprint(f),before);
});
