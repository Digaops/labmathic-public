import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import api from '../services/api';
import { useToast } from '../contexts/ToastContext';
import { usePlannerLeave } from '../contexts/PlannerNavigationContext';
import { lessonFields, mergeLessonDrafts, parseExecutionPlan, sameFields } from '../services/recoveryExecutionView.mjs';

export default function useRecoveryExecution(plan, basePath, onChanged, guardRef) {
  const toast=useToast(), pending=useRef(false), reading=useRef(false), alive=useRef(false), read=useRef(null), edits=useRef(new Map());
  const [drafts,setDrafts]=useState(()=>mergeLessonDrafts({},plan.execution));
  const [busy,setBusy]=useState(false),[checking,setChecking]=useState(false),[blocked,setBlocked]=useState(false),[error,setError]=useState('');
  const [,setEditRevision]=useState(0);
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;read.current?.abort();};},[]);
  useEffect(()=>setDrafts(current=>mergeLessonDrafts(current,plan.execution)),[plan.execution]);
  const register=useCallback((key,dirty)=>{if(Boolean(edits.current.get(key))!==Boolean(dirty)){if(dirty)edits.current.set(key,true);else edits.current.delete(key);setEditRevision(n=>n+1);}},[]);
  const dirty=Object.values(drafts).some(d=>!sameFields(d.fields,d.saved))||[...edits.current.values()].some(Boolean);
  usePlannerLeave(dirty || blocked, () => pending.current, 'recovery');
  const mayLeave=()=>{
    if(pending.current){toast.error('Aguarde a confirmação do envio antes de sair.');return false;}
    return (!dirty&&!blocked)||window.confirm(blocked?'Há um envio ou uma atualização pendente de conferência. Sair e conferir depois?':'Há alterações não salvas nas aulas ou seleções. Sair sem salvá-las?');
  };
  useLayoutEffect(()=>{if(guardRef)guardRef.current=mayLeave;return()=>{if(guardRef)guardRef.current=()=>true;};});
  function editLesson(id,patch){setDrafts(current=>({...current,[id]:{...current[id],fields:{...current[id].fields,...patch}}}));}
  function acceptLesson(lesson,keep=false){const fields=lessonFields(lesson);setDrafts(current=>({...current,[lesson.id]:{fields:keep?current[lesson.id].fields:fields,saved:fields,revision:lesson.revision}}));}
  async function refresh(){
    if(pending.current)return;
    read.current?.abort();const controller=new AbortController();read.current=controller;reading.current=true;setChecking(true);
    try {
      const response=await api.get(basePath,{signal:controller.signal,timeout:15000});
      if(!alive.current||controller.signal.aborted)return;
      const next=parseExecutionPlan(response.data?.plan,plan);onChanged(next);setBlocked(false);setError('');
      toast.success('Dados conferidos. Alterações não salvas continuam nos campos.');
    } catch(e){if(alive.current&&!controller.signal.aborted){setBlocked(true);setError('Não foi possível conferir o servidor. Seus textos continuam nesta tela.');}}
    finally{if(!controller.signal.aborted){reading.current=false;if(alive.current)setChecking(false);}}
  }
  async function run({method='post',path='',body,verify=()=>true,lessonId,message}){
    if(pending.current||reading.current||blocked)return false;
    pending.current=true;setBusy(true);setError('');
    try {
      const response=await api[method](basePath+path,body,{timeout:20000});
      if(!alive.current)return false;
      const next=parseExecutionPlan(response.data?.plan,plan);
      if(!next.execution || !verify(next))throw new Error('Resposta do envio não confirmada.');
      if(lessonId){const lesson=next.execution.lessons.find(l=>l.id===lessonId);if(!lesson)throw new Error('Etapa ausente.');acceptLesson(lesson);}
      onChanged(next);toast.success(message);return true;
    } catch(e){
      if(!alive.current)return false;
      const status=e.response?.status,code=e.response?.data?.code;
      const uncertain=!status||status>=500;
      const stale=code?.startsWith('stale_')||status===403||status===404||code?.includes('frozen');
      setBlocked(uncertain||stale);
      setError(uncertain?'Não foi possível confirmar o envio. Confira o servidor antes de tentar outra vez; não repetiremos a gravação automaticamente.':e.response?.data?.error||'Não foi possível salvar. Confira os dados.');return false;
    } finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  return {basePath,drafts,editLesson,acceptLesson,register,isEdited:key=>Boolean(edits.current.get(key)),dirty,mayLeave,busy,checking,blocked,error,setError,refresh,run,disabled:busy||checking||blocked};
}

export function useExecutionEdit(workspace,key,dirty){
  const register=workspace.register;
  useLayoutEffect(()=>{register(key,dirty);return()=>register(key,false);},[register,key,dirty]);
}
