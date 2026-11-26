import { useEffect, useRef, useState } from 'react';
import { formatCount } from '../utils/pluralize';
import { Link } from 'react-router-dom';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import useRecoveryExecution, { useExecutionEdit } from '../hooks/useRecoveryExecution';
import { lessonError, lessonFields, lessonLabels, parseExecutionPlan, sameFields } from '../services/recoveryExecutionView.mjs';
import LearningRecoveryMonitoring from './LearningRecoveryMonitoring';
import LearningRecoveryResourcePicker from './LearningRecoveryResourcePicker';

const panel='rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-white/[0.025]';
function today(){const d=new Date();return new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,10);}
function formatDate(value){const d=new Date(value+'T12:00:00');return Number.isNaN(d.getTime())?'Sem data':d.toLocaleDateString('pt-BR');}
function Resource({resource,workspace}){
  return <li className="py-2 text-sm">
    {resource.type==='material' && resource.materialId
      ? <Link onClick={e=>{if(!workspace.mayLeave())e.preventDefault();}} className="inline-flex items-center font-semibold text-cyan-700 dark:text-cyan-300" to={'/material/'+resource.materialId}>{resource.title}</Link>
      : <strong>{resource.title}</strong>}
    <p className="mt-1 text-slate-600 dark:text-slate-300">{resource.teacherNotes || (resource.type==='material'?'Material do acervo associado à habilidade':'Recurso selecionado para esta aula.')}</p>
  </li>;
}
function ExecutionLesson({lesson,plan,workspace,selected}){
  const [localError,setLocalError]=useState(''),[skipOpen,setSkipOpen]=useState(false);
  const heading=useRef(null),errorRef=useRef(null);
  const draft=workspace.drafts[lesson.id] || {fields:lessonFields(lesson),saved:lessonFields(lesson),revision:lesson.revision};
  const dirty=!sameFields(draft.fields,draft.saved),conflict=draft.revision!==lesson.revision;
  const active=plan.status==='active'&&plan.execution.status==='active';
  const monitoring=lesson.phase==='monitoring',evidence=plan.execution.monitoring?.state==='evidence_ready';
  const selectionDirty=workspace.isEdited(monitoring?'monitoring-selection':'resources-'+lesson.id);
  const groups=plan.groups.filter(g=>lesson.skills.some(s=>s.code===g.focusSkillCode || (s.skillId&&s.skillId===g.focusSkillId)));
  useEffect(()=>{if(localError){errorRef.current?.focus();}},[localError]);
  async function save(status=lesson.status){
    if(conflict || (status!==lesson.status&&selectionDirty)){setLocalError('Salve ou cancele a seleção antes de registrar esta etapa.');return;}
    const validation=lessonError(draft.fields,lesson.phase,status);
    if(validation){setLocalError(validation);return;}
    setLocalError('');
    const ok=await workspace.run({method:'put',path:'/execution/lessons/'+lesson.id,
      body:{expectedRevision:draft.revision,...draft.fields,durationMinutes:Number(draft.fields.durationMinutes),status},
      lessonId:lesson.id,verify:p=>p.execution.lessons.some(l=>l.id===lesson.id&&l.status===status&&l.revision>draft.revision),
      message:status==='taught'?'Aula registrada como realizada.':status==='skipped'?'Etapa registrada como não realizada.':'Registro da etapa salvo.'});
    if(ok)setSkipOpen(false);
  }
  return <article data-execution-lesson={lesson.id} hidden={!selected} className={panel}>
    <div className="flex flex-wrap items-start justify-between gap-2">
      <div className="min-w-0"><h5 ref={heading} tabIndex={-1} className="text-base font-bold">{lesson.title}</h5><p className="mt-1 text-sm">{lessonLabels[lesson.status]} · {formatDate(lesson.plannedDate)} · {lesson.durationMinutes ?? 50} min</p></div>
      {dirty&&<span role="status" className="text-sm font-semibold text-amber-700 dark:text-amber-300">Não salvo</span>}
    </div>
    {monitoring&&<LearningRecoveryMonitoring execution={plan.execution} active={active} workspace={workspace}/>}
    {active?<fieldset disabled={workspace.disabled} className="mt-3 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="block text-sm font-semibold">Data planejada<input type="date" className="input mt-1" value={draft.fields.plannedDate} onChange={e=>workspace.editLesson(lesson.id,{plannedDate:e.target.value})}/></label>
        <label className="block text-sm font-semibold">Duração (min)<input type="number" className="input mt-1" min="10" max="600" value={draft.fields.durationMinutes} onChange={e=>workspace.editLesson(lesson.id,{durationMinutes:e.target.value})}/></label>
      </div>
      <label className="block text-sm font-semibold">Registro do professor<textarea className="input mt-1 min-h-24 resize-y" maxLength={5000} value={draft.fields.teacherNotes} onChange={e=>workspace.editLesson(lesson.id,{teacherNotes:e.target.value})} placeholder="Como foi a aula? O que funcionou e o que precisa ser retomado?"/></label>
      {conflict&&<div className="rounded-xl border border-amber-300 p-3 text-sm"><strong>Esta etapa mudou em outro acesso.</strong><p>Seu texto foi mantido. Confira o que está salvo antes de decidir.</p>
        <details><summary className="cursor-pointer font-semibold">Conferir registro salvo</summary><p>{formatDate(lesson.plannedDate)} · {lesson.durationMinutes} min · {lessonLabels[lesson.status]}</p><p className="whitespace-pre-wrap">{lesson.teacherNotes || 'Sem anotação.'}</p></details>
        <div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-outline" onClick={()=>workspace.acceptLesson(lesson)}>Descartar minha edição</button><button type="button" className="btn-outline" onClick={()=>workspace.acceptLesson(lesson,true)}>Conferi; manter meu texto</button></div>
      </div>}
      {localError&&<p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-rose-700 dark:text-rose-300">{localError}</p>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className="btn-outline" disabled={conflict} onClick={()=>save()}>Salvar ajustes</button>
        {lesson.status==='planned'&&(!monitoring||evidence)&&<button type="button" className="btn-primary" disabled={conflict||selectionDirty} onClick={()=>save('taught')}>Registrar realizada</button>}
        {lesson.status==='planned'&&<button type="button" className="btn-outline" disabled={conflict||selectionDirty} onClick={()=>setSkipOpen(!skipOpen)} aria-expanded={skipOpen}>Não realizada</button>}
      </div>
      {selectionDirty&&<p className="text-sm">Salve ou cancele a seleção antes de registrar esta etapa como realizada ou não realizada.</p>}
      {skipOpen&&<div className="rounded-xl border border-amber-300 p-3 text-sm"><p>{monitoring?'Explique no registro acima por que a verificação não aconteceu. O motivo ficará no histórico.':'Confirme que esta aula não foi realizada. Suas anotações serão salvas junto com essa situação.'}</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-outline" onClick={()=>setSkipOpen(false)}>Voltar</button><button type="button" className="btn-primary" onClick={()=>save('skipped')}>Confirmar não realizada</button></div></div>}
      {monitoring&&lesson.status==='planned'&&!evidence&&<p className="text-sm">“Registrar realizada” será liberado após a aplicação ter ao menos um resultado e ser encerrada.</p>}
    </fieldset>:<div className="mt-3"><p className="text-sm font-semibold">Registro do professor</p><p className="mt-1 whitespace-pre-wrap text-sm">{lesson.teacherNotes||'Nenhuma anotação registrada.'}</p></div>}
    <details className="mt-1"><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Objetivo, habilidades e grupos</summary>
      <p className="my-2 text-sm">{lesson.objective}</p><p className="text-sm">{lesson.skills.map(s=>s.code).join(' · ')}</p>
      {groups.length>0&&<div className="my-2 text-sm"><strong>Grupos relacionados</strong><ul>{groups.map(g=><li key={g.id}>{g.title} · {g.students.map(s=>s.displayName).join(', ')}</li>)}</ul></div>}
    </details>
    {!monitoring&&<details className="mt-3"><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Recursos da aula · {formatCount(lesson.resources.filter(r=>r.type!=='activity').length, 'selecionado', 'selecionados')}</summary><ul className="divide-y divide-slate-200 dark:divide-white/10">{lesson.resources.map(r=><Resource key={r.id} resource={r} workspace={workspace}/>)}</ul></details>}
    {!active&&dirty&&<div className="mt-3 rounded-xl border border-amber-300 p-3 text-sm"><strong>Seu texto local não foi salvo.</strong><p>O plano foi encerrado em outro acesso. Copie suas anotações antes de sair.</p><label className="block">Anotações locais<textarea readOnly className="input mt-1" value={draft.fields.teacherNotes}/></label><p>Data local: {draft.fields.plannedDate} · {draft.fields.durationMinutes} min</p><button type="button" className="btn-outline mt-2" onClick={()=>{if(window.confirm('Descartar sua edição local desta etapa?'))workspace.acceptLesson(lesson);}}>Descartar minha edição</button></div>}
    {!monitoring&&<LearningRecoveryResourcePicker lesson={lesson} canEdit={active&&lesson.status==='planned'} executionRevision={plan.execution.revision} workspace={workspace}/>}
  </article>;
}
export default function LearningRecoveryExecution(props){
  try {parseExecutionPlan(props.plan,props.plan);}catch{return <div role="alert" className={panel}>Não foi possível conferir o acompanhamento. Feche o plano e tente novamente.</div>;}
  return <ExecutionWorkspace key={props.plan.id} {...props}/>;
}
function ExecutionWorkspace({plan,basePath,onPlanChange,guardRef}){
  const workspace=useRecoveryExecution(plan,basePath,onPlanChange,guardRef),execution=plan.execution;
  const [startDate,setStartDate]=useState(today),[cadenceDays,setCadenceDays]=useState(2);
  const initialStart=useRef(startDate),[selectedId,setSelectedId]=useState(()=>execution?.lessons.find(l=>l.status==='planned')?.id||execution?.lessons[0]?.id||'');
  const [completeOpen,setCompleteOpen]=useState(false),errorRef=useRef(null),selector=useRef(null);
  useExecutionEdit(workspace,'schedule',!execution&&(startDate!==initialStart.current||cadenceDays!==2));
  useEffect(()=>{if(workspace.error){errorRef.current?.focus({preventScroll:true});errorRef.current?.scrollIntoView({block:'center'});}},[workspace.error]);
  useEffect(()=>{if(execution&&!execution.lessons.some(l=>l.id===selectedId))setSelectedId(execution.lessons.find(l=>l.status==='planned')?.id||execution.lessons[0]?.id||'');},[execution,selectedId]);
  const active=plan.status==='active'&&execution?.status==='active';
  return <section data-recovery-execution className="bank-form space-y-3">
    {workspace.error&&<div ref={errorRef} tabIndex={-1} role="alert" className="rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100"><p className="flex items-start gap-2"><AlertTriangle size={18}/>{workspace.error}</p>{workspace.blocked&&<button type="button" className="btn-outline mt-2" disabled={workspace.busy||workspace.checking} onClick={workspace.refresh}>Conferir servidor</button>}</div>}
    {!execution ? <div className={panel}>
      <h4 className="font-bold">Organizar as aulas de apoio</h4><p className="mt-1 text-sm">Escolha o início e o intervalo. Será criada uma aula por habilidade e uma verificação final; você poderá ajustar cada data.</p>
      <fieldset disabled={workspace.disabled||plan.status!=='active'} className="mt-3 grid gap-3 sm:grid-cols-2">
        <label className="text-sm font-semibold">Início da intervenção<input type="date" className="input mt-1" value={startDate} onChange={e=>setStartDate(e.target.value)}/></label>
        <label className="text-sm font-semibold">Intervalo entre etapas<select aria-label="Intervalo entre etapas" className="input mt-1" value={cadenceDays} onChange={e=>setCadenceDays(Number(e.target.value))}>{[1,2,3,5,7].map(n=><option key={n} value={n}>{n===1?'Todos os dias':`A cada ${n} dias`}</option>)}</select></label>
        <p className="text-sm sm:col-span-2">Dias corridos, incluindo fins de semana. Revise as datas conforme o calendário da escola.</p>
        <button type="button" className="btn-primary sm:col-span-2" disabled={!startDate} onClick={()=>workspace.run({path:'/execution',body:{startDate,cadenceDays:Number(cadenceDays)},verify:p=>p.execution.status==='active',message:'Aulas organizadas. Confira as datas antes de começar.'})}>{workspace.busy&&<RefreshCw className="animate-spin" size={16}/>}Organizar aulas</button>
      </fieldset>
      {plan.status!=='active'&&<p className="mt-2 text-sm">Este plano está disponível apenas para consulta.</p>}
    </div>:<>
      <div className={panel}>
        <div className="flex flex-wrap items-center justify-between gap-2"><div><h4 className="font-bold">{execution.status==='completed'?'Ciclo concluído':'Aulas e verificação'}</h4><p className="text-sm">Etapas registradas: {execution.progress.handled} de {execution.progress.total} · {execution.progress.percentage}%</p></div><button type="button" className="btn-outline min-w-11 shrink-0" title="Atualizar acompanhamento" disabled={workspace.busy||workspace.checking} onClick={workspace.refresh}><RefreshCw size={16} aria-hidden="true" className={workspace.checking?'animate-spin':''} /><span className="sr-only sm:not-sr-only">{workspace.checking?'Conferindo…':'Atualizar acompanhamento'}</span></button></div>
        <label className="mt-2 block text-sm font-semibold">Etapa do plano<select ref={selector} aria-label="Etapa do plano" className="input mt-1" value={selectedId} onChange={e=>setSelectedId(e.target.value)}>{execution.lessons.map(l=><option key={l.id} value={l.id}>{l.sequence}. {l.title} · {lessonLabels[l.status]}</option>)}</select></label>
        <details className="mt-1"><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Ver cronograma completo</summary><p className="py-2 text-sm">{formatDate(execution.startsOn)} a {formatDate(execution.endsOn)} · {execution.progress.planned} pendentes</p><ul className="divide-y divide-slate-200 dark:divide-white/10">{execution.lessons.map(l=><li key={l.id}><button type="button" className="w-full py-2 text-left text-sm" onClick={()=>{setSelectedId(l.id);selector.current?.focus();}}>{formatDate(l.plannedDate)} · {l.title} · {lessonLabels[l.status]}{workspace.drafts[l.id]&&!sameFields(workspace.drafts[l.id].fields,workspace.drafts[l.id].saved)?' · Não salvo':''}</button></li>)}</ul></details>
      </div>
      {execution.lessons.map(l=><ExecutionLesson key={l.id} lesson={l} plan={plan} workspace={workspace} selected={l.id===selectedId}/>)}
      <div className={panel}>
        <p className="text-sm">{active?'Registre as aulas e a verificação antes de encerrar. O histórico permanecerá disponível.':'Histórico preservado para consulta. Nenhuma alteração será aplicada.'}</p>
        {active&&execution.progress.planned===0&&<><button type="button" className="btn-primary mt-2" disabled={workspace.disabled||workspace.dirty} onClick={()=>setCompleteOpen(true)}>Concluir ciclo</button>{workspace.dirty&&<p className="mt-2 text-sm">Salve ou descarte as alterações pendentes antes de concluir.</p>}</>}
        {completeOpen&&active&&<div className="mt-3 border-t border-slate-200 pt-3 text-sm dark:border-white/10"><p>Concluir encerra este plano e preserva aulas, recursos e registros para consulta. Confirma?</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={workspace.busy} onClick={()=>setCompleteOpen(false)}>Continuar trabalhando</button><button type="button" className="btn-primary" disabled={workspace.disabled||workspace.dirty} onClick={()=>workspace.run({path:'/execution/complete',body:{expectedExecutionRevision:execution.revision},verify:p=>p.status==='completed'&&p.execution.status==='completed',message:'Ciclo concluído. Histórico preservado.'})}>Confirmar conclusão</button></div></div>}
      </div>
    </>}
  </section>;
}
