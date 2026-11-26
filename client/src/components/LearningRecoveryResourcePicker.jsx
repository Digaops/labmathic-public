import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { useExecutionEdit } from '../hooks/useRecoveryExecution';
import { resourceOptions } from '../services/recoveryExecutionView.mjs';

export default function LearningRecoveryResourcePicker({lesson,canEdit,executionRevision,workspace}){
  const [open,setOpen]=useState(false),[loading,setLoading]=useState(false),[options,setOptions]=useState(null);
  const [questionIds,setQuestionIds]=useState([]),[materialIds,setMaterialIds]=useState([]),[error,setError]=useState(''),[search,setSearch]=useState('');
  const request=useRef(null),alive=useRef(false),trigger=useRef(null),heading=useRef(null),errorRef=useRef(null),saved=useRef('');
  const selection=JSON.stringify({questionIds:[...questionIds].sort((a,b)=>a-b),materialIds:[...materialIds].sort((a,b)=>a-b)});
  const dirty=open&&Boolean(options)&&selection!==saved.current;
  useExecutionEdit(workspace,'resources-'+lesson.id,dirty);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
  useEffect(()=>{if(open&&!loading&&options)heading.current?.focus();},[open,loading]);
  useEffect(()=>{if(error){errorRef.current?.focus({preventScroll:true});errorRef.current?.scrollIntoView({block:'center'});}},[error]);
  async function loadOptions(){
    if(workspace.disabled||!canEdit)return;
    if(dirty&&!window.confirm('Atualizar opções descartará a seleção não salva. Continuar?'))return;
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setOpen(true);setError('');
    try{
      const response=await api.get(workspace.basePath+'/execution/lessons/'+lesson.id+'/resources/options',{signal:controller.signal,timeout:15000});
      if(!alive.current||controller.signal.aborted)return;
      const value=resourceOptions(response.data,lesson.id);
      const questions=value.questions.filter(q=>q.selected).map(q=>q.id),materials=value.materials.filter(m=>m.selected).map(m=>m.id);
      saved.current=JSON.stringify({questionIds:[...questions].sort((a,b)=>a-b),materialIds:[...materials].sort((a,b)=>a-b)});
      setQuestionIds(questions);setMaterialIds(materials);setOptions(value);
    }catch(e){if(alive.current&&!controller.signal.aborted){setOptions(null);setError('Não foi possível carregar os recursos. Tente novamente.');}}
    finally{if(alive.current&&!controller.signal.aborted)setLoading(false);}
  }
  function close(){
    if(workspace.busy || (dirty&&!window.confirm('Sair sem salvar a seleção de recursos?')))return;
    request.current?.abort();setOpen(false);setLoading(false);setOptions(null);setError('');trigger.current?.focus();
  }
  function toggle(ids,setIds,id,limit){
    if(ids.includes(id)){setIds(ids.filter(value=>value!==id));setError('');return;}
    if(ids.length>=limit){setError('Selecione no máximo '+limit+' itens nesta categoria.');return;}
    setIds([...ids,id]);setError('');
  }
  async function save(){
    if(!canEdit||!options?.editable || options.executionRevision!==executionRevision)return;
    const ok=await workspace.run({method:'put',path:'/execution/lessons/'+lesson.id+'/resources',
      body:{expectedExecutionRevision:options.executionRevision,questionIds,materialIds},verify:p=>p.execution.revision>options.executionRevision,message:'Recursos da aula salvos.'});
    if(ok){saved.current=selection;setOpen(false);setOptions(null);trigger.current?.focus();}
  }
  const matches=value=>value.toLocaleLowerCase('pt-BR').includes(search.trim().toLocaleLowerCase('pt-BR'));
  return <div className="mt-3">
    {canEdit&&<button ref={trigger} type="button" className="btn-outline" disabled={workspace.disabled||loading} onClick={loadOptions} aria-expanded={open}>Revisar recursos</button>}
    {open&&<section data-execution-resources className="mt-3 space-y-3 rounded-xl border border-cyan-200 p-3 dark:border-cyan-400/20" aria-label={'Recursos de '+lesson.title}>
      <div className="flex items-start justify-between gap-2"><h6 ref={heading} tabIndex={-1} className="font-bold">Recursos desta aula</h6><button type="button" className="btn-outline" aria-label="Fechar seleção de recursos" disabled={workspace.busy} onClick={close}>Fechar</button></div>
      <p className="text-sm">Escolha o que será usado. As questões do diagnóstico não entram nesta seleção.</p>
      {loading&&<p role="status" className="text-sm">Carregando recursos…</p>}
      {error&&<p ref={errorRef} tabIndex={-1} role="alert" className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
      {!loading&&!options&&<button type="button" className="btn-outline" onClick={loadOptions} disabled={workspace.disabled}>Tentar novamente</button>}
      {!loading&&options&&<>
        {(!canEdit||!options.editable||options.executionRevision!==executionRevision)&&<p className="text-sm text-amber-800 dark:text-amber-300">A execução mudou. Use “Atualizar acompanhamento” e confira a etapa. Sua seleção permanece visível; atualizar as opções pede confirmação para descartá-la.</p>}
        <label className="block text-sm font-semibold">Buscar recurso<input type="search" className="input mt-1" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Nome, código ou trecho da questão"/></label>
        <fieldset disabled={!canEdit||workspace.disabled||!options.editable||options.executionRevision!==executionRevision} className="grid gap-4 lg:grid-cols-2">
          <div><h6 className="text-sm font-bold">Questões de reforço · {questionIds.length}/{options.limits.maxQuestions}</h6><div className="mt-2 space-y-2">{options.questions.filter(q=>matches(q.code+' '+q.statement)).map(q=>
            <label key={q.id} className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-white/10">
              <input type="checkbox" className="mt-1" checked={questionIds.includes(q.id)} onChange={()=>toggle(questionIds,setQuestionIds,q.id,options.limits.maxQuestions)}/>
              <span className="min-w-0"><strong>{q.code}</strong><span className="mt-1 block">{q.statement}</span>{q.source==='teacher'&&<span className="mt-1 block text-violet-700 dark:text-violet-300">Questão autoral: confira antes de usar.</span>}</span>
            </label>)}</div>{!options.questions.length&&<p className="mt-2 text-sm">Nenhuma questão válida e inédita está disponível para esta habilidade.</p>}</div>
          <div><h6 className="text-sm font-bold">Materiais do acervo · {materialIds.length}/{options.limits.maxMaterials}</h6><div className="mt-2 space-y-2">{options.materials.filter(m=>matches(m.title)).map(m=>
            <label key={m.id} className="flex items-start gap-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-white/10"><input type="checkbox" className="mt-1" checked={materialIds.includes(m.id)} onChange={()=>toggle(materialIds,setMaterialIds,m.id,options.limits.maxMaterials)}/><span className="min-w-0"><strong>{m.title}</strong>{m.description&&<span className="mt-1 block">{m.description}</span>}{m.needsReview&&<span className="mt-1 block text-amber-800 dark:text-amber-200">Já estava nesta aula. O vínculo mudou; confira antes de reutilizar.</span>}</span></label>)}</div>
            {!options.materials.length&&<p className="mt-2 text-sm">Ainda não há material associado a esta habilidade disponível para seleção.</p>}</div>
        </fieldset>
        {search&&<p role="status" className="text-sm">{!options.questions.some(q=>matches(q.code+' '+q.statement))&&!options.materials.some(m=>matches(m.title))?'Nenhum recurso nesta busca. ':''}A busca não altera os itens selecionados.</p>}
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-primary" disabled={!canEdit||workspace.disabled||!options.editable||options.executionRevision!==executionRevision} onClick={save}>Salvar recursos</button><button type="button" className="btn-outline" disabled={workspace.busy} onClick={close}>Cancelar</button><button type="button" className="btn-outline" disabled={!canEdit||workspace.disabled} onClick={loadOptions}>Atualizar opções</button></div>
      </>}
    </section>}
  </div>;
}
