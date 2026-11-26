import {useEffect,useRef,useState} from 'react';
import {useLocation,useNavigate} from 'react-router-dom';
import api from '../services/api';
import {usePlannerLeave} from '../contexts/PlannerNavigationContext';
import {formFingerprint,mergePlannerNotes,newPlanForm,parsePlanner,parsePlannerBootstrap,plannerError,plannerForm,plannerPayload} from '../services/lessonPlannerView.mjs';

export {usePlannerLeave};
export default function usePlannerSession(planId){
  const navigate=useNavigate(),location=useLocation(),isNew=!planId||planId==='novo';
  const [plan,setPlan]=useState(null),[form,setForm]=useState(newPlanForm),[bootstrap,setBootstrap]=useState(null);
  const [loading,setLoading]=useState(true),[busy,setBusy]=useState(false),[error,setError]=useState(''),[success,setSuccess]=useState('');
  const [blocked,setBlocked]=useState(false),[remote,setRemote]=useState(null),[uncertain,setUncertain]=useState(null),[attempt,setAttempt]=useState(0),[reviewed,setReviewed]=useState(false);
  const baseline=useRef(newPlanForm()),pending=useRef(false),alive=useRef(false),request=useRef(null),createOperationKey=useRef(crypto.randomUUID());
  const dirty=formFingerprint(form)!==formFingerprint(baseline.current);
  const mayLeave=usePlannerLeave(dirty||blocked,()=>pending.current);
  function adopt(next,{preserve=false,savedId}={}){
    const oldBaseline=baseline.current;baseline.current=plannerForm(next);setPlan(next);
    setForm(current=>preserve?mergePlannerNotes(current,oldBaseline,next,savedId):plannerForm(next));
    setReviewed(false);setRemote(null);setBlocked(false);setUncertain(null);
  }
  useEffect(()=>{
    alive.current=true;const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    Promise.all([api.get('/lesson-plans/bootstrap',{signal:controller.signal,timeout:15000}),isNew?null:api.get('/lesson-plans/'+planId,{signal:controller.signal,timeout:15000})]).then(([b,p])=>{
      const boot=parsePlannerBootstrap(b.data),next=p?parsePlanner(p.data,planId):null;
      if(controller.signal.aborted)return;setBootstrap(boot);if(next)adopt(next);
    }).catch(e=>{if(!controller.signal.aborted)setError(e.response?.data?.error||'Não foi possível abrir o planejamento. Tente novamente.');})
      .finally(()=>{if(!controller.signal.aborted)setLoading(false);});
    return()=>{alive.current=false;controller.abort();};
  },[planId,isNew,attempt]);
  function edit(change){if(pending.current||blocked)return;setForm(current=>typeof change==='function'?change(current):{...current,...change});setReviewed(false);setSuccess('');}
  async function write(operation,retry=false){
    if(pending.current||(blocked&&!retry))return false;
    pending.current=true;setBusy(true);setError('');setSuccess('');
    try{
      const response=await api[operation.method](operation.url,operation.body,{timeout:20000,headers:operation.key?{'Idempotency-Key':operation.key}:undefined});
      if(!alive.current)return false;
      const next=parsePlanner(response.data,operation.expectedId);
      if(operation.expectedClass&&next.class?.publicId!==operation.expectedClass)throw Error('Contexto não confirmado.');
      if(operation.expectedStatus&&next.status!==operation.expectedStatus)throw Error('Situação não confirmada.');
      if(operation.lessonId&&!next.lessons.some(l=>l.publicId===operation.lessonId&&l.status===operation.body.status&&l.revision>operation.body.expectedLessonRevision))throw Error('Registro não confirmado.');
      adopt(next,{preserve:operation.preserve,savedId:operation.lessonId});setSuccess(operation.message);
      pending.current=false;setBusy(false);
      if(isNew)mayLeave.afterSave(()=>navigate('/planejamento/'+next.publicId+location.search,{replace:true}));return true;
    }catch(e){
      if(!alive.current)return false;
      const status=e.response?.status,unclear=!status||status>=500,conflict=status===409||status===403||status===404;
      // A replay keeps its original content frozen even if the catalogue now rejects it.
      setBlocked(unclear||conflict||(retry&&Boolean(operation.key)));if(unclear&&operation.key)setUncertain(operation);
      setError(unclear?'Não foi possível confirmar o envio. Seus dados continuam aqui. Confira antes de tentar novamente.':e.response?.data?.error||'Não foi possível salvar. Confira os campos.');return false;
    }finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  async function save(){
    const validation=plannerError(form,bootstrap.classes);if(validation){setError(validation);return;}
    return write({method:isNew?'post':'put',url:isNew?'/lesson-plans':'/lesson-plans/'+planId,body:{...plannerPayload(form),...(!isNew?{expectedRevision:plan.revision}:{})},key:isNew?createOperationKey.current:null,expectedId:isNew?null:planId,expectedClass:form.classPublicId,expectedStatus:'draft',message:'Rascunho salvo. Revise antes de iniciar.'});
  }
  function transition(action){
    if(dirty){setError('Salve ou descarte suas alterações antes de mudar a situação do plano.');return;}
    if(action==='activate'&&!reviewed)return;
    if(action!=='activate'&&!window.confirm(action==='archive'?'Arquivar este planejamento? Os registros serão preservados para consulta.':'Concluir este planejamento e preservar o histórico?'))return;
    return write({method:'post',url:'/lesson-plans/'+planId+'/'+action,body:{expectedRevision:plan.revision,...(action==='activate'?{reviewConfirmed:true}:{})},expectedId:planId,expectedStatus:{activate:'active',complete:'completed',archive:'archived'}[action],message:action==='activate'?'Planejamento iniciado. Registre as aulas conforme acontecerem.':action==='complete'?'Planejamento concluído. Histórico preservado.':'Planejamento arquivado.'});
  }
  function registerLesson(index,status){
    const lesson=form.lessons[index];
    if(status==='skipped'&&lesson.teacherNotes.trim().length<10){setError('Explique em pelo menos 10 caracteres por que a aula não foi realizada.');return;}
    return write({method:'patch',url:'/lesson-plans/'+planId+'/lessons/'+lesson.publicId,body:{expectedPlanRevision:plan.revision,expectedLessonRevision:lesson.revision,status,teacherNotes:lesson.teacherNotes},expectedId:planId,lessonId:lesson.publicId,preserve:true,message:'Registro da aula salvo.'});
  }
  async function checkServer(){
    if(pending.current)return;
    if(uncertain)return write(uncertain,true);
    if(isNew)return;
    pending.current=true;setBusy(true);
    try{const response=await api.get('/lesson-plans/'+planId,{signal:request.current?.signal,timeout:15000});if(!alive.current)return;setRemote(parsePlanner(response.data,planId));setBlocked(true);setError('Dados conferidos. Compare com sua edição antes de continuar.');}
    catch(e){if(alive.current)setError('Não foi possível conferir o servidor. Sua edição foi mantida.');}
    finally{pending.current=false;if(alive.current)setBusy(false);}
  }
  function useRemote(keep){
    if(!remote||!window.confirm(keep?'Continuar com sua edição sobre a versão conferida? Nada será salvo até você confirmar o envio.':'Descartar a edição local e usar o que está salvo?'))return;
    const local=form;if(keep&&plan?.status==='draft'&&remote.status==='draft'){baseline.current=plannerForm(remote);setPlan(remote);setForm(local);setBlocked(false);setRemote(null);setReviewed(false);setError('');}
    else{adopt(remote,{preserve:keep});setError('');}
  }
  return {plan,form,bootstrap,loading,busy,error,success,dirty,blocked,remote,uncertain,reviewed,setReviewed,edit,save,transition,registerLesson,checkServer,useRemote,setError,mayLeave,retry:()=>setAttempt(n=>n+1),isNew,baseline:baseline.current,disabled:busy||blocked};
}
