import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertTriangle,
  ArrowRight,
  BarChart3,
  CheckCircle2,
  ClipboardCheck,
  FileQuestion,
  RefreshCw,
  UsersRound,
} from 'lucide-react';
import api from '../services/api';
import RecoveryComparison from './RecoveryComparison';
import { useExecutionEdit } from '../hooks/useRecoveryExecution';
import { canPrepareMonitoring, monitoringOptions } from '../services/recoveryExecutionView.mjs';
import { legacyVerificationNotice, verificationNextStep } from '../services/recoveryLanguage.mjs';

function VerificationSource({ questionSet }) {
  const notice = legacyVerificationNotice(questionSet?.title);
  return typeof questionSet?.title === 'string' ? <div className="mt-2 break-words text-sm text-neutral-600 dark:text-neutral-300">
    <p>Simulado vinculado: <strong>{questionSet.title}</strong></p>
    {notice && <p className="mt-1">{notice}</p>}
  </div> : null;
}

function applicationLink(monitoring) {
  const params = new URLSearchParams({ turma: monitoring.class.id, secao: 'avaliacoes' });
  // Resolve both new and already-saved applications in the class workspace.
  params.set('simulado', monitoring.questionSet.id);
  return `/turmas?${params.toString()}`;
}

export default function LearningRecoveryMonitoring({ execution, active, workspace }) {
  const monitoring = execution.monitoring;
  const [options,setOptions]=useState(null),[selected,setSelected]=useState([]),[loading,setLoading]=useState(false),[error,setError]=useState('');
  const request=useRef(null),alive=useRef(false),errorRef=useRef(null),saved=useRef('');
  const dirty=!monitoring&&options&&JSON.stringify([...selected].sort((a,b)=>a-b))!==saved.current;
  useExecutionEdit(workspace,'monitoring-selection',Boolean(dirty));
  useEffect(()=>{alive.current=true;return()=>{alive.current=false;request.current?.abort();};},[]);
  useEffect(()=>{if(error){errorRef.current?.focus({preventScroll:true});errorRef.current?.scrollIntoView({block:'center'});}},[error]);
  const pendingInterventions=execution.lessons.filter(l=>l.phase==='intervention'&&l.status==='planned').length;
  const stale=options&&!options.existing&&options.executionRevision!==execution.revision;
  async function loadOptions(){
    if(workspace.disabled)return;
    if(dirty&&!window.confirm('Atualizar descartará a seleção não salva da verificação. Continuar?'))return;
    request.current?.abort();const controller=new AbortController();request.current=controller;setLoading(true);setError('');
    try{
      const response=await api.get(workspace.basePath+'/execution/monitoring/options',{signal:controller.signal,timeout:15000});
      if(!alive.current||controller.signal.aborted)return;
      const value=monitoringOptions(response.data);
      if(value.existing){await workspace.refresh();return;}
      const ids=value.skills.flatMap(s=>s.questions.map(q=>q.id));
      saved.current=JSON.stringify([...ids].sort((a,b)=>a-b));setOptions(value);setSelected(ids);
    }catch(e){if(alive.current&&!controller.signal.aborted){setOptions(null);setError(e.response?.data?.error || 'Não foi possível carregar a verificação. Tente novamente.');}}
    finally{if(alive.current&&!controller.signal.aborted)setLoading(false);}
  }
  async function createMonitoring(){
    if(stale||!canPrepareMonitoring(options,selected))return;
    const byId=new Map(options.skills.flatMap(s=>s.questions.map(q=>[q.id,q])));
    await workspace.run({path:'/execution/monitoring',body:{expectedExecutionRevision:options.executionRevision,questions:selected.map(id=>({id,showImage:byId.get(id)?.hasImage!==false}))},
      verify:p=>Boolean(p.execution.monitoring),message:'Questões da verificação salvas. Abra as aplicações da turma para conferir os estudantes e continuar.'});
  }
  const leave = e => {if(!workspace.mayLeave())e.preventDefault();};
  if (!monitoring) {
    if (!active) {
      return (
        <section className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3 dark:border-white/10 dark:bg-white/[0.025] sm:p-3">
          <p className="text-sm font-black uppercase tracking-[0.14em] text-neutral-400">Registro da verificação</p>
          <h6 className="mt-1 font-black text-neutral-900 dark:text-white">{execution.lessons.some(l=>l.phase==='monitoring'&&l.status==='skipped')?'Verificação não realizada':'Verificação não preparada'}</h6>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">Consulte as anotações desta etapa. Não há uma comparação de resultados disponível.</p>
        </section>
      );
    }
    if (pendingInterventions > 0) {
      return (
        <section className="rounded-2xl border border-neutral-200 bg-neutral-50 p-3 dark:border-white/10 dark:bg-white/[0.025] sm:p-3">
          <p className="text-sm font-black uppercase tracking-[0.14em] text-neutral-400">Etapa final</p>
          <h6 className="mt-1 font-black text-neutral-900 dark:text-white">Registre as aulas de apoio antes da verificação</h6>
          <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">Ainda há {pendingInterventions} {pendingInterventions === 1 ? 'intervenção pendente' : 'intervenções pendentes'}. Marque cada aula como realizada ou não realizada antes de preparar a verificação.</p>
        </section>
      );
    }
    return (
      <section className="rounded-2xl border border-cyan-200 bg-gradient-to-br from-cyan-50 to-blue-50 p-3 dark:border-cyan-400/20 dark:from-cyan-400/10 dark:to-blue-500/5 sm:p-3">
        <div className="flex items-start gap-3"><span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-cyan-500 text-white"><ClipboardCheck size={19} /></span><div><h6 className="font-black text-neutral-900 dark:text-white">Verificação da aprendizagem</h6><p className="mt-1 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">Use questões diferentes das usadas no diagnóstico e no apoio. Considere o que observou em aula.</p></div></div>
        {!options ? (
          <button type="button" className="btn-primary mt-4 justify-center" disabled={loading || workspace.disabled} onClick={loadOptions}>{loading ? <RefreshCw className="animate-spin" size={15} /> : <FileQuestion size={15} />} Escolher questões da verificação</button>
        ) : (
          <div className="mt-3 space-y-3">
            <p className="text-sm font-semibold">{selected.length} {selected.length === 1 ? 'questão selecionada' : 'questões selecionadas'} · máximo de 50. Selecione ao menos uma por habilidade.</p>
            {options.selectionMethodology === 'unused-questions-v2' && <p className="text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">Até duas sugestões por habilidade, sem repetir o diagnóstico nem as questões escolhidas para o apoio.</p>}
            {stale && <p className="text-sm text-amber-800 dark:text-amber-300">O acompanhamento mudou em outro acesso. Atualize as opções para continuar.</p>}
            <div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={workspace.disabled || loading} onClick={loadOptions}>Atualizar opções da verificação</button>
            <button type="button" className="btn-outline" disabled={workspace.busy} onClick={()=>{if(!dirty||window.confirm('Cancelar a seleção não salva da verificação?')){request.current?.abort();setLoading(false);setOptions(null);setSelected([]);setError('');}}}>Cancelar seleção</button></div>
            {options.skills.map(({ skill, questions, availability }) => (
              <div key={skill.code} className="rounded-xl border border-white/80 bg-white/80 p-3 dark:border-white/10 dark:bg-white/5">
                <div className="flex flex-wrap items-center justify-between gap-2"><p className="text-sm font-black text-neutral-800 dark:text-white">{skill.code}</p><span className="text-sm font-semibold text-neutral-600 dark:text-neutral-300">{questions.length} {questions.length === 1 ? 'opção' : 'opções'} · mínimo 1</span></div>
                <p className="mt-1 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{skill.description}</p>
                {!questions.length && <p className="mt-2 text-sm font-semibold text-amber-800 dark:text-amber-200">{availability === 'skill_unavailable' ? 'Peça à administração para conferir o cadastro desta habilidade.' : 'Nenhuma questão disponível. Cadastre uma no Banco de questões, com quatro alternativas e uma resposta correta. Depois, atualize as opções aqui.'}</p>}
                <div className="mt-2 space-y-2">{questions.map((question) => {
                  const checked = selected.includes(question.id);
                  return <label key={question.id} className="flex cursor-pointer items-start gap-2 rounded-lg border border-neutral-200 bg-white p-2.5 dark:border-white/10 dark:bg-white/5"><input type="checkbox" disabled={workspace.disabled || loading || stale} className="mt-1 h-4 w-4" checked={checked} onChange={() => setSelected((current) => checked ? current.filter((id) => id !== question.id) : [...current, question.id])} /><span><strong className="block text-sm text-neutral-800 dark:text-white">{question.code}</strong><span className="mt-0.5 block text-sm text-neutral-500 dark:text-neutral-400">{question.statement}</span></span></label>;
                })}</div>
                {questions.length > 0 && questions.filter(question => selected.includes(question.id)).length === 1 && <p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">Uma questão permite continuar, mas oferece apenas um indício. Quando possível, use duas e considere também as atividades da turma.</p>}
              </div>
            ))}
            {(options.selectionMethodology !== 'unused-questions-v2' || !options.skills.length) && options.warnings?.map((warning) => <p key={warning} className="flex items-start gap-2 text-sm font-semibold text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 shrink-0" size={14} /> {warning}</p>)}
            <p className="text-sm text-neutral-600 dark:text-neutral-300">Ao salvar, as questões ficarão fixas para preservar o histórico. Isso ainda não libera a aplicação para os estudantes.</p>
            <button type="button" className="btn-primary justify-center" disabled={workspace.disabled || loading || stale || !canPrepareMonitoring(options,selected)} onClick={createMonitoring}>{workspace.busy ? <RefreshCw className="animate-spin" size={15} /> : <CheckCircle2 size={15} />} Salvar questões da verificação</button>
          </div>
        )}
        {error && <p ref={errorRef} tabIndex={-1} role="alert" className="mt-3 flex items-start gap-2 text-sm font-semibold text-rose-600 dark:text-rose-300"><AlertTriangle className="mt-0.5 shrink-0" size={14} /> {error}</p>}
      </section>
    );
  }

  if (monitoring.state !== 'evidence_ready') {
    const copy = verificationNextStep(monitoring.state);
    return (
      <section className="rounded-2xl border border-cyan-200 bg-cyan-50/70 p-3 dark:border-cyan-400/20 dark:bg-cyan-400/5 sm:p-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div><p className="text-sm font-black uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-300">Próxima ação</p><h6 className="mt-1 font-black text-neutral-900 dark:text-white">{copy[0]}</h6><p className="mt-1 max-w-2xl text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{copy[1]}</p>{monitoring.application && <p className="mt-2 text-sm font-bold text-neutral-500 dark:text-neutral-400">Resultados corrigidos: {monitoring.application.submittedCount} de {monitoring.application.participantCount}.</p>}</div>
          <Link onClick={leave} to={applicationLink(monitoring)} className="btn-primary shrink-0 justify-center">Abrir aplicações da turma <ArrowRight size={15} /></Link>
        </div>
        <VerificationSource questionSet={monitoring.questionSet} />
      </section>
    );
  }

  return (
    <section className="rounded-2xl border border-emerald-200 bg-emerald-50/60 p-3 dark:border-emerald-400/20 dark:bg-emerald-400/5 sm:p-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between"><div><p className="flex items-center gap-2 text-sm font-black uppercase tracking-[0.14em] text-emerald-700 dark:text-emerald-300"><BarChart3 size={15} /> Evidências disponíveis</p><h6 className="mt-2 font-black text-neutral-900 dark:text-white">Resultados da verificação</h6><p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">Comparação descritiva com o diagnóstico de origem, baseada nas respostas registradas.</p></div><Link onClick={leave} to={applicationLink(monitoring)} className="btn-outline shrink-0 justify-center">Ver aplicação <ArrowRight size={15} /></Link></div>
      <VerificationSource questionSet={monitoring.questionSet} />
      <div className="mt-4"><RecoveryComparison comparison={monitoring.comparison} /></div>
      {monitoring.comparison.studentsNeedingFollowUp.length > 0 && <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 p-3 dark:border-amber-400/20 dark:bg-amber-400/5"><p className="flex items-center gap-2 text-sm font-black text-amber-800 dark:text-amber-200"><UsersRound size={15} /> Acompanhamento sugerido</p><div className="mt-2 flex flex-wrap gap-2">{monitoring.comparison.studentsNeedingFollowUp.map((student) => <span key={student.id} className="rounded-lg bg-white px-2.5 py-1.5 text-sm font-bold text-neutral-700 dark:bg-white/10 dark:text-neutral-200">{student.displayName} · {Math.round(student.percentage)}%</span>)}</div></div>}
    </section>
  );
}
