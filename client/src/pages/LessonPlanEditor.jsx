import {useEffect,useRef,useState} from 'react';
import {useLocation,useNavigate,useParams} from 'react-router-dom';
import AssessmentDialog from '../components/AssessmentDialog';
import PlannerResourceButton from '../components/PlannerResourceButton';
import {PlannerField as Field,PlannerSkillPicker,PlannerResourcePicker} from '../components/PlannerPickers';
import usePlannerSession,{usePlannerLeave} from '../hooks/usePlannerSession';
import {newLesson,parsePlanner,plannerCopyText,plannerDate,planStatuses,validDate} from '../services/lessonPlannerView.mjs';
import api from '../services/api';

const panel='rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.025] sm:p-4';
const labels={planned:'Planejada',taught:'Realizada',skipped:'Não realizada'};
export default function LessonPlanEditor(){
  const {planPublicId}=useParams();
  return <PlannerEditor key={planPublicId||'novo'} planId={planPublicId}/>;
}
function PlannerEditor({planId}){
  const s=usePlannerSession(planId),navigate=useNavigate(),location=useLocation();
  const [area,setArea]=useState(!planId||planId==='novo'?'context':'lessons'),[selection,setIndex]=useState(0),[picker,setPicker]=useState(null),[duplicate,setDuplicate]=useState(false);
  const index=Math.min(selection,s.form.lessons.length-1);
  const alert=useRef(null),selector=useRef(null);
  useEffect(()=>{if(s.error){alert.current?.focus({preventScroll:true});alert.current?.scrollIntoView({block:'center'});}},[s.error]);
  const back=()=>navigate('/planejamento'+location.search);
  const updateLesson=patch=>s.edit(f=>({...f,lessons:f.lessons.map((l,i)=>i===index?{...l,...patch}:l)}));
  if(s.loading)return <div className="editorial-workspace bank-form mx-auto max-w-6xl p-4"><p role="status">Abrindo planejamento…</p></div>;
  if(!s.bootstrap||(!s.isNew&&!s.plan))return <div className="editorial-workspace bank-form mx-auto max-w-6xl space-y-3 p-4"><button className="btn-outline" onClick={back}>Voltar aos planejamentos</button><div role="alert"><p>{s.error||'Não foi possível abrir o planejamento.'}</p><button className="btn-outline mt-3" onClick={s.retry}>Tentar novamente</button></div></div>;
  const {form,plan}=s,lesson=form.lessons[index]||form.lessons[0],editable=s.isNew||plan.status==='draft';
  const selectedClass=s.bootstrap.classes.find(c=>c.publicId===form.classPublicId),pending=form.lessons.filter(l=>l.status==='planned').length;
  function chooseClass(id){
    const c=s.bootstrap.classes.find(c=>c.publicId===id);
    s.edit({...form,classPublicId:id,disciplineId:c?.disciplines?.[0]?.id||''});
  }
  function addLesson(){if(form.lessons.length>=100)return;s.edit(f=>({...f,lessons:[...f.lessons,newLesson()]}));setIndex(form.lessons.length);selector.current?.focus();}
  function removeLesson(){if(!window.confirm('Remover esta aula do rascunho, com suas habilidades, recursos e anotações?'))return;s.edit(f=>({...f,lessons:f.lessons.filter((_,i)=>i!==index)}));setIndex(Math.max(0,index-1));selector.current?.focus();}
  const canKeep=s.remote&&((plan?.status==='draft'&&s.remote.status==='draft')||plan?.status==='active');
  return <div data-planner-editor className="editorial-workspace bank-form mx-auto max-w-6xl space-y-3 px-3 pt-3 pb-8 sm:px-6 sm:pt-4">
    <header className="flex flex-wrap items-center justify-between gap-2"><div><h1 className="text-2xl font-bold">{s.isNew?'Novo planejamento':editable?'Editar planejamento':'Acompanhar aulas'}</h1><p className="mt-1 text-sm">{plan?planStatuses[plan.status]:'Rascunho'}{s.dirty?' · Alterações não salvas':''}{s.busy?' · Enviando…':''}</p></div><button type="button" className="btn-outline" disabled={s.busy} onClick={back}>Voltar aos planejamentos</button></header>
    {(s.error||s.success)&&<div ref={alert} tabIndex={-1} role={s.error?'alert':'status'} className={'rounded-xl border p-3 text-sm '+(s.error?'border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100':'border-emerald-300 bg-emerald-50 text-emerald-950 dark:bg-emerald-400/10 dark:text-emerald-100')}>
      <p>{s.error||s.success}</p>{s.blocked&&<button type="button" className="btn-outline mt-2" disabled={s.busy} onClick={s.checkServer}>{s.uncertain?'Conferir envio':'Conferir versão salva'}</button>}
    </div>}
    {s.blocked&&s.dirty&&<details className={panel}><summary className="cursor-pointer text-sm font-semibold">Copiar minha edição</summary><p className="my-2 text-sm">Se a conexão não voltar, copie este texto para um local seguro antes de sair. Ele inclui todas as aulas e ainda não confirma um salvamento.</p><Field label="Texto da minha edição"><textarea className="input min-h-40 w-full" readOnly value={plannerCopyText(form,selectedClass?.name||plan?.class?.name)} onFocus={e=>e.currentTarget.select()}/></Field></details>}
    {s.remote&&<section aria-label="Versão salva no servidor" className={panel}><h2 className="font-bold">Versão salva no servidor</h2><PlannerSnapshot plan={s.remote}/><div className="mt-3 flex flex-wrap gap-2"><button type="button" className="btn-outline" onClick={()=>s.useRemote(false)}>Usar versão salva</button>{canKeep&&<button type="button" className="btn-outline" onClick={()=>s.useRemote(true)}>Conferi; manter minha edição</button>}</div></section>}
    {editable?<>
      <div className="flex flex-wrap gap-2"><button type="button" className={area==='context'?'btn-primary':'btn-outline'} aria-pressed={area==='context'} onClick={()=>setArea('context')}>Turma e período</button><button type="button" className={area==='lessons'?'btn-primary':'btn-outline'} aria-pressed={area==='lessons'} onClick={()=>setArea('lessons')}>Aulas ({form.lessons.length})</button></div>
      <fieldset disabled={s.disabled} className="min-w-0 space-y-3">
        {area==='context'?<section className={panel}><h2 className="mb-3 font-bold">Turma e período</h2><div className="grid gap-3 sm:grid-cols-2">
          <Field label="Título do planejamento"><input className="input w-full" maxLength={160} value={form.title} onChange={e=>s.edit({title:e.target.value})} placeholder="Ex.: Frações no cotidiano"/></Field>
          <Field label="Turma"><select className="input w-full" value={form.classPublicId} onChange={e=>chooseClass(e.target.value)}><option value="">Selecione</option>{s.bootstrap.classes.map(c=><option key={c.publicId} value={c.publicId}>{c.name} · {c.academicYear}</option>)}</select></Field>
          <Field label="Componente curricular"><select className="input w-full" disabled={!selectedClass} value={form.disciplineId} onChange={e=>s.edit({disciplineId:e.target.value})}><option value="">Selecione</option>{selectedClass?.disciplines.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
          <Field label="Organização"><select className="input w-full" value={form.periodType} onChange={e=>s.edit({periodType:e.target.value})}><option value="week">Semana</option><option value="bimester">Bimestre</option><option value="custom">Período personalizado</option></select></Field>
          <Field label="Início"><input type="date" className="input w-full" value={form.startsOn} onChange={e=>s.edit({startsOn:e.target.value})}/></Field>
          <Field label="Término"><input type="date" className="input w-full" value={form.endsOn} onChange={e=>s.edit({endsOn:e.target.value})}/></Field>
        </div>{!s.bootstrap.classes.length&&<p className="mt-3 text-sm">Você precisa de uma turma ativa para criar um planejamento. Acesse Turmas para organizá-la.</p>}
          <button type="button" className="btn-primary mt-3" onClick={()=>setArea('lessons')}>Continuar para as aulas</button></section>:<>
          <section className={panel}><div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end"><div className="min-w-0 flex-1"><Field label="Aula do planejamento"><select ref={selector} className="input w-full" value={index} onChange={e=>setIndex(Number(e.target.value))}>{form.lessons.map((l,i)=><option key={i} value={i}>{i+1}. {l.title||'Nova aula'}</option>)}</select></Field></div><button type="button" className="btn-outline" disabled={form.lessons.length>=100} onClick={addLesson}>Adicionar aula</button></div></section>
          <article data-planner-lesson className={panel}><div className="mb-3 flex items-center justify-between gap-2"><h2 className="font-bold">Aula {index+1}</h2>{form.lessons.length>1&&<button type="button" className="btn-outline" onClick={removeLesson}>Remover aula</button>}</div>
            <div className="space-y-3"><Field label="Título da aula"><input className="input w-full" maxLength={160} value={lesson.title} onChange={e=>updateLesson({title:e.target.value})}/></Field>
            <Field label="Objetivo de aprendizagem"><textarea className="input min-h-24 w-full" maxLength={2000} value={lesson.objective} onChange={e=>updateLesson({objective:e.target.value})} placeholder="O que os estudantes deverão aprender nesta aula?"/></Field>
            <div className="grid gap-3 sm:grid-cols-2"><Field label="Data prevista"><input type="date" className="input w-full" value={lesson.plannedDate} onChange={e=>updateLesson({plannedDate:e.target.value})}/></Field><Field label="Duração (minutos)"><input type="number" className="input w-full" min={10} max={600} value={lesson.durationMinutes} onChange={e=>updateLesson({durationMinutes:e.target.value})}/></Field></div>
            <Field label="Observações do professor"><textarea className="input min-h-20 w-full" maxLength={5000} value={lesson.teacherNotes} onChange={e=>updateLesson({teacherNotes:e.target.value})} placeholder="Adaptações, estratégias ou lembretes para esta turma"/></Field>
            <LinkBox title="Habilidades BNCC" items={lesson.skills.map(x=>({title:x.code,notes:x.description}))} onAdd={()=>setPicker('skills')} onRemove={i=>updateLesson({skills:lesson.skills.filter((_,j)=>i!==j)})}/>
            <LinkBox title="Recursos da aula" items={lesson.resources} preview onAdd={()=>lesson.skills.length?setPicker('resources'):s.setError('Selecione uma habilidade BNCC antes de escolher recursos.')} onRemove={i=>updateLesson({resources:lesson.resources.filter((_,j)=>i!==j)})}/>
            </div>
          </article>
        </>}
      </fieldset>
      <section className={panel}><div className="flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={s.disabled} onClick={s.save}>Salvar rascunho</button>{!s.isNew&&<button type="button" className="btn-outline" disabled={s.disabled||s.dirty} onClick={()=>s.transition('archive')}>Arquivar rascunho</button>}</div>
        <p className="my-3 text-sm">O rascunho só é salvo ao confirmar. Depois de salvar e conferir, você poderá iniciar o acompanhamento das aulas.</p>
        {!s.isNew&&<><label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" disabled={s.disabled||s.dirty} checked={s.reviewed} onChange={e=>s.setReviewed(e.target.checked)}/><span>Revisei objetivos, habilidades, recursos e datas</span></label><button type="button" className="btn-primary mt-3" disabled={s.disabled||s.dirty||!s.reviewed} onClick={()=>s.transition('activate')}>Revisar e iniciar</button>{s.dirty&&<p className="mt-2 text-sm">Salve as alterações antes de confirmar a revisão.</p>}</>}
      </section>
    </>:<>
      <details className={panel}><summary className="cursor-pointer text-sm font-semibold">{plan.title} · {plan.class?.name||'Turma indisponível'}</summary><p className="text-sm">{plannerDate(plan.startsOn)} a {plannerDate(plan.endsOn)} · {plan.grade?.name} · {plan.discipline?.name}</p></details>
      <section className={panel}><Field label="Aula do planejamento"><select ref={selector} className="input w-full" value={index} onChange={e=>setIndex(Number(e.target.value))}>{form.lessons.map((l,i)=><option key={l.publicId} value={i}>{i+1}. {l.title} · {labels[l.status]}</option>)}</select></Field><p className="mt-2 text-sm">{form.lessons.filter(l=>l.status==='taught').length}/{form.lessons.length} realizadas · {pending} pendentes</p></section>
      <article data-planner-lesson className={panel}><h2 className="font-bold">{lesson.title}</h2><p className="mt-1 text-sm">{labels[lesson.status]} · {plannerDate(lesson.plannedDate)} · {lesson.durationMinutes||'—'} min</p>
        <fieldset disabled={s.disabled} className="mt-3 space-y-3">
          {plan.status==='active'?<><Field label="Registro da aula"><textarea className="input min-h-24 w-full" maxLength={5000} value={lesson.teacherNotes} onChange={e=>updateLesson({teacherNotes:e.target.value})} placeholder="Avanços, dificuldades ou motivo de não realização"/></Field><div className="flex flex-wrap gap-2">{lesson.status==='planned'?<><button type="button" className="btn-primary" onClick={()=>s.registerLesson(index,'taught')}>Marcar como realizada</button><button type="button" className="btn-outline" onClick={()=>s.registerLesson(index,'skipped')}>Não realizada</button></>:<button type="button" className="btn-primary" onClick={()=>s.registerLesson(index,lesson.status)}>Salvar registro</button>}</div></>:<div><strong className="text-sm">Registro da aula</strong><p className="whitespace-pre-wrap text-sm">{lesson.teacherNotes||'Nenhuma anotação registrada.'}</p>{lesson.teacherNotes!==s.baseline.lessons[index]?.teacherNotes&&<p className="mt-2 text-sm text-amber-700 dark:text-amber-300">Este texto é sua edição local, não salva. Copie-o antes de sair; o histórico foi encerrado.</p>}</div>}
        </fieldset>
        <details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Objetivo, habilidades e recursos</summary><p className="whitespace-pre-wrap text-sm">{lesson.objective}</p><ul className="my-2 text-sm">{lesson.skills.map(x=><li key={x.code}>{x.code} · {x.description}</li>)}</ul><ul className="divide-y divide-slate-200 dark:divide-white/10">{lesson.resources.map((r,i)=><li className="space-y-2 py-2 text-sm" key={i}><strong className="break-words">{r.title}</strong><p className="whitespace-pre-wrap break-words">{r.notes}</p><PlannerResourceButton resource={r}/></li>)}</ul></details>
      </article>
      <section className={panel}><div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={s.disabled||s.dirty} onClick={()=>setDuplicate(true)}>Reutilizar em outra turma</button>{plan.status!=='archived'&&<button type="button" className="btn-outline" disabled={s.disabled||s.dirty} onClick={()=>s.transition('archive')}>Arquivar</button>}{plan.status==='active'&&<button type="button" className="btn-primary" disabled={s.disabled||s.dirty||pending>0} onClick={()=>s.transition('complete')}>Concluir ciclo</button>}</div><p className="mt-2 text-sm">{s.dirty?'Há registros não salvos. Salve-os antes de concluir, arquivar ou copiar.':plan.status==='active'?'Registre todas as aulas antes de concluir.':'Histórico disponível para consulta.'}</p></section>
    </>}
    {!s.isNew&&<button type="button" className="btn-outline" disabled={s.busy} onClick={s.checkServer}>Conferir versão salva</button>}
    {picker==='skills'&&<PlannerSkillPicker grades={s.bootstrap.grades} selected={lesson.skills} defaultGradeId={selectedClass?.gradeId} onClose={()=>setPicker(null)} onConfirm={skills=>{updateLesson({skills});setPicker(null);}}/>}
    {picker==='resources'&&<PlannerResourcePicker lesson={lesson} gradeId={selectedClass?.gradeId} disciplineId={form.disciplineId} onClose={()=>setPicker(null)} onConfirm={resources=>{updateLesson({resources});setPicker(null);}}/>}
    {duplicate&&<DuplicateDialog plan={plan} classes={s.bootstrap.classes.filter(c=>c.publicId!==plan.class?.publicId)} onClose={()=>setDuplicate(false)} onCreated={created=>navigate('/planejamento/'+created.publicId+location.search)}/>}
  </div>;
}
function LinkBox({title,items,onAdd,onRemove,preview=false}){return <section className="rounded-xl border border-slate-200 p-3 dark:border-white/10"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-semibold">{title} · {items.length}</h3><button type="button" className="btn-outline" onClick={onAdd}>Escolher {title.toLocaleLowerCase('pt-BR')}</button></div>{items.length?<ul className="mt-2 divide-y divide-slate-200 dark:divide-white/10">{items.map((item,i)=><li className="flex flex-wrap items-start justify-between gap-2 py-2 text-sm" key={i}><div className="min-w-0 flex-1 basis-48 break-words"><strong>{item.title}</strong><p className="whitespace-pre-wrap">{item.notes}</p></div><div className="flex flex-wrap gap-2">{preview&&<PlannerResourceButton resource={item}/>}<button type="button" className="btn-outline shrink-0" aria-label={'Remover '+title.toLocaleLowerCase('pt-BR')+' '+(i+1)} onClick={()=>onRemove(i)}>Remover</button></div></li>)}</ul>:<p className="mt-2 text-sm">Nenhum item selecionado.</p>}</section>;}
function PlannerSnapshot({plan}){return <details><summary className="cursor-pointer text-sm font-semibold">{plan.title} · {planStatuses[plan.status]}</summary><p className="text-sm">{plan.class?.name} · {plannerDate(plan.startsOn)} a {plannerDate(plan.endsOn)}</p><ol>{plan.lessons.map(l=><li key={l.publicId} className="my-3 text-sm"><strong>{l.title} · {labels[l.status]}</strong><p>{l.objective}</p><p>{plannerDate(l.plannedDate)} · {l.durationMinutes||'—'} min</p><p className="whitespace-pre-wrap">{l.teacherNotes||'Sem anotação'}</p><p>{l.skills.map(s=>s.code).join(' · ')}</p>{l.resources.map((r,i)=><p key={i}>{r.title} · {r.notes}</p>)}</li>)}</ol></details>;}
function DuplicateDialog({plan,classes,onClose,onCreated}){
  const [form,setForm]=useState({title:('Cópia de '+plan.title).slice(0,160),classPublicId:'',disciplineId:'',startsOn:''}),[busy,setBusy]=useState(false),[error,setError]=useState(''),[uncertain,setUncertain]=useState(null);
  const operationKey=useRef(crypto.randomUUID()),pending=useRef(false),alive=useRef(false),initial=useRef(form);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;};},[]);
  const leave=usePlannerLeave(!sameForm(form,initial.current)||Boolean(uncertain),()=>pending.current);
  const close=()=>{if(leave(onClose))onClose();};
  async function submit(){
    if(pending.current)return;
    const body=uncertain||{...form,disciplineId:Number(form.disciplineId),periodType:plan.periodType};
    pending.current=true;setBusy(true);setError('');
    try{const response=await api.post('/lesson-plans/'+plan.publicId+'/duplicate',body,{timeout:20000,headers:{'Idempotency-Key':operationKey.current}});const created=parsePlanner(response.data);if(created.class?.publicId!==body.classPublicId)throw Error('Destino não confirmado.');if(alive.current){pending.current=false;setBusy(false);leave.afterSave(()=>onCreated(created));}}
    catch(e){if(alive.current){if(!e.response?.status||e.response.status>=500)setUncertain(body);setError(e.response?.data?.error||'Envio não confirmado. Confira antes de tentar criar outra cópia.');}}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  const selectedClass=classes.find(c=>c.publicId===form.classPublicId);
  return <AssessmentDialog title="Reutilizar planejamento" closeDisabled={busy} onClose={close}><div className="bank-form space-y-3 p-3">
    <p className="text-sm">A cópia será um rascunho. Registros das aulas não são copiados. As orientações dos recursos permanecem: confira-as para a nova turma.</p>
    {error&&<p role="alert" className="rounded-xl border border-amber-300 p-3 text-sm">{error}</p>}
    <fieldset disabled={busy||Boolean(uncertain)} className="grid gap-3 sm:grid-cols-2">
      <Field label="Turma de destino"><select className="input w-full" value={form.classPublicId} onChange={e=>{const c=classes.find(c=>c.publicId===e.target.value);setForm({...form,classPublicId:e.target.value,disciplineId:c?.disciplines.some(d=>d.id===plan.discipline?.id)?plan.discipline.id:c?.disciplines[0]?.id||''});}}><option value="">Selecione</option>{classes.map(c=><option key={c.publicId} value={c.publicId}>{c.name} · {c.academicYear}</option>)}</select></Field>
      <Field label="Componente curricular"><select className="input w-full" disabled={!selectedClass} value={form.disciplineId} onChange={e=>setForm({...form,disciplineId:e.target.value})}><option value="">Selecione</option>{selectedClass?.disciplines.map(d=><option key={d.id} value={d.id}>{d.name}</option>)}</select></Field>
      <Field label="Novo início"><input type="date" className="input w-full" value={form.startsOn} onChange={e=>setForm({...form,startsOn:e.target.value})}/></Field>
      <Field label="Título da cópia"><input className="input w-full" maxLength={160} value={form.title} onChange={e=>setForm({...form,title:e.target.value})}/></Field>
    </fieldset>
    {!classes.length&&<p className="text-sm">Você ainda não possui outra turma ativa para receber esta cópia.</p>}
    {uncertain&&<p className="text-sm">O conteúdo enviado fica preservado. A conferência usa a mesma chave para não criar outra cópia.</p>}
    <div className="flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={busy||(!uncertain&&(!form.classPublicId||!form.disciplineId||!validDate(form.startsOn)||!form.title.trim()))} onClick={submit}>{uncertain?'Conferir envio':'Criar cópia'}</button><button type="button" className="btn-outline" disabled={busy} onClick={close}>Cancelar</button></div>
  </div></AssessmentDialog>;
}
const sameForm=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
