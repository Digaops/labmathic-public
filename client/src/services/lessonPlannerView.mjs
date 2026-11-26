export const planStatuses={draft:'Rascunho',active:'Em andamento',completed:'Concluído',archived:'Arquivado'};
const text=v=>typeof v==='string'&&v.length>0;
const integer=v=>Number.isSafeInteger(v)&&v>0;
const fail=()=>{throw new Error('Não foi possível conferir os dados do planejamento.');};
export const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
export const newLesson=()=>({title:'',objective:'',teacherNotes:'',plannedDate:'',durationMinutes:50,skills:[],resources:[]});
export const newPlanForm=()=>({title:'',classPublicId:'',disciplineId:'',periodType:'week',startsOn:'',endsOn:'',lessons:[newLesson()]});
export function planIdentity(p){if(!p||!text(p.publicId)||!text(p.title)||!integer(p.revision)||!Object.hasOwn(planStatuses,p.status))fail();}
export function parsePlannerList(value){
  if(!Array.isArray(value?.plans))fail();
  value.plans.forEach(p=>{planIdentity(p);if(!Number.isSafeInteger(p.lessonCount)||p.lessonCount<0||!Number.isSafeInteger(p.taughtCount)||p.taughtCount<0||p.taughtCount>p.lessonCount)fail();});return value;
}
export function parsePlanner(value,expectedId){
  const p=value?.plan;planIdentity(p);if(expectedId&&p.publicId!==expectedId)fail();
  if(!Array.isArray(p.lessons)||!p.lessons.length||!validDate(p.startsOn)||!validDate(p.endsOn)||p.endsOn<p.startsOn||!['week','bimester','custom'].includes(p.periodType))fail();
  if(p.class!==null&&(!text(p.class?.publicId)||!text(p.class?.name)))fail();
  if(p.discipline!==null&&(!integer(p.discipline?.id)||!text(p.discipline?.name)))fail();
  if(new Set(p.lessons.map(l=>l.publicId)).size!==p.lessons.length)fail();
  p.lessons.forEach(l=>{
    if(!text(l.publicId)||!text(l.title)||!text(l.objective)||!integer(l.revision)||!['planned','taught','skipped'].includes(l.status)||!Array.isArray(l.skills)||!Array.isArray(l.resources))fail();
    if(l.teacherNotes!==null&&typeof l.teacherNotes!=='string')fail();
    if(l.plannedDate!==null&&!validDate(l.plannedDate))fail();
    if(l.durationMinutes!==null&&(!integer(l.durationMinutes)||l.durationMinutes<10||l.durationMinutes>600))fail();
    l.skills.forEach(s=>{if(!text(s.code)||!text(s.description)||(s.id!==null&&!integer(s.id)))fail();});
    l.resources.forEach(r=>{if(!['activity','material','question','question_set'].includes(r.type)||!text(r.title)||(r.notes!==null&&typeof r.notes!=='string'))fail();});
  });return p;
}
export function parsePlannerBootstrap(value){
  if(!Array.isArray(value?.classes)||!Array.isArray(value?.grades))fail();
  value.classes.forEach(c=>{if(!text(c.publicId)||!text(c.name)||!integer(c.academicYear)||!Array.isArray(c.disciplines))fail();c.disciplines.forEach(d=>{if(!integer(d.id)||!text(d.name))fail();});});
  value.grades.forEach(g=>{if(!integer(g.id)||!text(g.name))fail();});return value;
}
export function parsePlannerSkills(value){
  if(!Array.isArray(value?.skills)||!Array.isArray(value?.units))fail();
  value.skills.forEach(s=>{if(!integer(s.id)||!text(s.code)||!text(s.description))fail();});
  value.units.forEach(u=>{if(!integer(u.id)||!text(u.name))fail();});return value;
}
export function parsePlannerResources(value){
  for(const key of ['materials','questions','questionSets']){if(!Array.isArray(value?.[key]))fail();value[key].forEach(r=>{if(!integer(r.id)||!text(r.title))fail();});}return value;
}
export function parsePlannerResourcePage(value,expected={}){
  if(!['materials','questions','questionSets'].includes(value?.category)||!Array.isArray(value.items))fail();
  if(!Number.isSafeInteger(value.total)||value.total<0||!integer(value.page)||value.pageSize!==20||value.totalPages!==Math.ceil(value.total/20))fail();
  if((expected.category&&value.category!==expected.category)||(expected.page&&value.page!==expected.page))fail();
  const remaining=Math.max(0,value.total-(value.page-1)*value.pageSize);
  if(value.items.length!==Math.min(value.pageSize,remaining)||new Set(value.items.map(item=>item?.id)).size!==value.items.length)fail();
  value.items.forEach(item=>{if(!integer(item?.id)||!text(item.title))fail();});
  return value;
}
export function plannerForm(p){return {
  title:p.title,classPublicId:p.class?.publicId||'',disciplineId:p.discipline?.id||'',periodType:p.periodType,startsOn:p.startsOn,endsOn:p.endsOn,
  lessons:p.lessons.map(l=>({...l,teacherNotes:l.teacherNotes||'',plannedDate:l.plannedDate||'',durationMinutes:l.durationMinutes??'',resources:l.resources.map(r=>({type:r.type,id:r.materialId||r.questionId||r.questionSetId||null,title:r.title,notes:r.notes||''}))})),
};}
export function plannerPayload(f){return {...f,disciplineId:Number(f.disciplineId),lessons:f.lessons.map(l=>({title:l.title,objective:l.objective,teacherNotes:l.teacherNotes||null,plannedDate:l.plannedDate||null,durationMinutes:l.durationMinutes===''?null:Number(l.durationMinutes),skillIds:l.skills.map(s=>s.id),resources:l.resources.map(r=>({type:r.type,id:r.id||null,title:r.title,notes:r.notes||null}))}))};}
export const formFingerprint=f=>JSON.stringify(plannerPayload(f));
// Plain text, only in memory: the teacher can copy pending work if the server stays unavailable.
export function plannerCopyText(f,className=''){
  return [f.title,className,`Período: ${plannerDate(f.startsOn)} a ${plannerDate(f.endsOn)}`,
    ...f.lessons.map((l,i)=>[`${i+1}. ${l.title}`,`Objetivo: ${l.objective}`,`Data: ${plannerDate(l.plannedDate)} · Duração: ${l.durationMinutes||'Não informada'}`,
      `Anotações: ${l.teacherNotes||''}`,`Habilidades: ${l.skills.map(s=>s.code+' — '+s.description).join('; ')}`,
      'Recursos:',...l.resources.map(r=>r.title+(r.notes?'\n'+r.notes:''))].join('\n'))].join('\n\n');
}
export function mergePlannerNotes(local,baseline,next,savedId){
  const form=plannerForm(next);
  form.lessons=form.lessons.map(l=>{
    const old=local.lessons.find(x=>x.publicId===l.publicId),saved=baseline.lessons.find(x=>x.publicId===l.publicId);
    return old&&saved&&l.publicId!==savedId&&old.teacherNotes!==saved.teacherNotes?{...l,teacherNotes:old.teacherNotes}:l;
  });return form;
}
export function validDate(v){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v+'T12:00:00Z'))&&new Date(v+'T12:00:00Z').toISOString().slice(0,10)===v;}
export function plannerError(f,classes){
  const c=classes.find(c=>c.publicId===f.classPublicId);
  if(!c)return 'Escolha uma turma ativa.';
  if(!c.disciplines.some(d=>d.id===Number(f.disciplineId)))return 'Escolha um componente curricular da turma.';
  if(!f.title.trim())return 'Dê um título ao planejamento.';
  if(!validDate(f.startsOn)||!validDate(f.endsOn)||f.endsOn<f.startsOn)return 'Confira as datas de início e término.';
  if([f.startsOn,f.endsOn].some(d=>Number(d.slice(0,4))!==c.academicYear))return 'As datas devem estar no ano letivo da turma.';
  if(f.lessons.length<1||f.lessons.length>100)return 'Organize de 1 a 100 aulas.';
  for(const [i,l] of f.lessons.entries()){
    const prefix=`Aula ${i+1}: `;
    if(!l.title.trim()||!l.objective.trim())return prefix+'preencha título e objetivo.';
    if(l.skills.length<1||l.skills.length>10||l.skills.some(s=>!integer(s.id)))return prefix+'selecione de 1 a 10 habilidades válidas.';
    if(l.plannedDate&&(!validDate(l.plannedDate)||l.plannedDate<f.startsOn||l.plannedDate>f.endsOn))return prefix+'a data deve estar dentro do período.';
    if(l.durationMinutes!==''&&(!Number.isInteger(Number(l.durationMinutes))||Number(l.durationMinutes)<10||Number(l.durationMinutes)>600))return prefix+'use duração de 10 a 600 minutos.';
    if(l.resources.length>50)return prefix+'selecione no máximo 50 recursos.';
  }return '';
}
export function plannerQuery(params){return {search:(params.get('busca')||'').replace(/\s+/g,' ').trim().slice(0,100),status:Object.hasOwn(planStatuses,params.get('situacao'))?params.get('situacao'):'',page:Math.max(1,Math.min(5,parseInt(params.get('pagina'),10)||1))};}
export function plannerDate(value){return validDate(value)?new Date(value+'T12:00:00Z').toLocaleDateString('pt-BR',{timeZone:'UTC'}):'Sem data';}
