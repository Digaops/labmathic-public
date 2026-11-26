import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, BookOpenCheck, CheckCircle2, RefreshCw, Save, Search, ShieldCheck } from 'lucide-react';
import api from '../services/api';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { useAuth } from '../contexts/AuthContext';
import { confirmedFeedback, parseCycleClasses, parseCycleOverview, parseCycleDetail, parseFeedbackHistory } from '../services/pedagogicalCycleView.mjs';
import { classAssessmentPath } from '../services/classesView.mjs';
import ClassAssessmentResults from '../components/ClassAssessmentResults';
import RecoveryComparison from '../components/RecoveryComparison';
import PedagogicalReport from '../components/PedagogicalReport';
import PedagogicalPeriod from '../components/PedagogicalPeriod';
import { isLocalReportDownload } from '../services/pedagogicalReportView.mjs';
import { PlanDialog } from './LearningRecoveryPlans';

const base = '/pedagogical-cycle/classes';
const surface = 'rounded-2xl border border-neutral-200 bg-white p-3 sm:p-4 dark:border-white/10 dark:bg-[#111E31]';
const percent = value => value == null ? 'Sem resultado' : `${Number(value).toLocaleString('pt-BR')}%`;
const statuses = { draft: 'Rascunho', scheduled: 'Agendada', open: 'Aberta', closed: 'Encerrada', cancelled: 'Cancelada', active: 'Em execução', completed: 'Concluída', archived: 'Arquivada' };
const fieldLabels = {
  objective: ['O que a turma precisa aprender?', 'Descreva o que os estudantes devem conseguir fazer.'],
  observation: ['O que você observou?', 'Considere os resultados, a participação e o que viu em sala.'],
  action: ['Como você vai ajudar a turma?', 'Conte o que fará e como os estudantes vão tentar novamente.'],
  verification: ['Como saber se a turma avançou?', 'Defina quando e como vai conferir. Depois, registre se vai avançar, retomar ou investigar.'],
};

function useRemote(path, revision = 0, parse, expectedClassId = '', expectedAssessmentId = '') {
  const [state, setState] = useState({ path: null, data: null, error: '', loading: true });
  useEffect(() => {
    if (!path) return;
    const controller = new AbortController();
    setState({ path, revision, data: null, loading: true, error: '' });
    api.get(path, { signal: controller.signal, timeout: 15000 }).then(response => {
      const data = parse(response.data);
      if ((expectedClassId && data.class?.id !== expectedClassId) || (expectedAssessmentId && data.assessment?.id !== expectedAssessmentId)) throw new Error('Contexto diferente do solicitado.');
      if (!controller.signal.aborted) setState({ path, revision, data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, revision, data: null, loading: false, status: error.response?.status, error: error.response?.data?.error || 'Não foi possível carregar. Tente novamente.' });
    });
    return () => controller.abort();
  }, [path, revision, parse, expectedClassId, expectedAssessmentId]);
  return state.path === path && state.revision === revision ? state : { data: null, error: '', loading: true };
}
function PageButtons({ pagination, onPage }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  return <div className="mt-4 flex flex-wrap items-center gap-3 text-sm">
    <button className="btn-outline" disabled={pagination.page <= 1} onClick={() => onPage(pagination.page - 1)}>Anterior</button>
    <span>Página {pagination.page} de {pagination.totalPages}</span>
    <button className="btn-outline" disabled={pagination.page >= pagination.totalPages} onClick={() => onPage(pagination.page + 1)}>Próxima</button>
  </div>;
}
function Institution({ value }) {
  const verified = value.status === 'verified';
  return <p className={`text-sm ${verified ? 'text-emerald-700 dark:text-emerald-300' : 'text-amber-800 dark:text-amber-200'}`}>
    {verified ? 'Vínculo confirmado' : value.status === 'unavailable' ? 'Consulta institucional indisponível' : 'Vínculo institucional a confirmar'}
    {value.municipality && ` · ${value.municipality} → ${value.school}`}
    {!verified && value.status !== 'unavailable' && ' · Ainda não entra nos resumos da rede.'}
  </p>;
}
export default function PedagogicalCycle() {
  const { user } = useAuth();
  return <CycleWorkspace key={user?.id || 'signed-out'} />;
}
function CycleWorkspace() {
  const [params, setParams] = useSearchParams();
  const classId = params.get('turma') || '';
  const assessmentId = params.get('avaliacao') || '';
  const [search, setSearch] = useState(''); const [query, setQuery] = useState(''); const [page, setPage] = useState(1);
  const [retry, setRetry] = useState(0);
  const dirty = useRef(false);
  const mayLeave = useCallback(() => !dirty.current || window.confirm('Há alterações não salvas na devolutiva. Deseja sair sem salvá-las?'), []);
  useEffect(() => {
    const timer = setTimeout(() => { setQuery(search); setPage(1); }, 250);
    return () => clearTimeout(timer);
  }, [search]);
  const classes = useRemote(classId ? null : `${base}?search=${encodeURIComponent(query)}&page=${page}`, retry, parseCycleClasses);
  function select(nextClass, nextAssessment = '') {
    if (nextClass === classId && nextAssessment === assessmentId) return true;
    if (!mayLeave()) return false;
    dirty.current = false;
    setParams(nextClass ? { turma: nextClass, ...(nextAssessment ? { avaliacao: nextAssessment } : {}) } : {});
    return true;
  }
  return <div data-pedagogical-cycle className="bank-form mx-auto max-w-6xl space-y-3 bg-slate-50 px-4 py-4 text-neutral-800 dark:bg-transparent dark:text-neutral-100 sm:px-6">
    <header>
      <h1 className="text-xl font-black sm:text-2xl">Devolutivas da turma</h1>
      <p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">Veja os resultados e registre como ajudar a turma. As devolutivas que você salvar ficam no histórico da turma.</p>
    </header>
    {!classId ? <section className={surface} aria-label="Selecionar turma">
      <h2 className="text-lg font-bold">Comece pela turma</h2>
      <p className="mb-3 mt-1 text-sm">Escolha uma das suas turmas.</p>
      <label className="mb-4 block"><span className="mb-1 flex items-center gap-2 text-sm font-semibold"><Search size={16} /> Buscar turma</span>
        <input className="input w-full" type="search" value={search} onChange={e => setSearch(e.target.value)} maxLength={100} /></label>
      {classes.loading && <p role="status">Carregando turmas…</p>}
      {classes.error && <p role="alert">{classes.error} <button className="btn-outline" onClick={() => setRetry(n => n + 1)}>Tentar novamente</button></p>}
      <div className="divide-y divide-neutral-200 dark:divide-white/10">{classes.data?.data.map(item => <button key={item.id} onClick={() => select(item.id)} className="block w-full rounded-lg py-3 text-left hover:bg-cyan-50 dark:hover:bg-cyan-400/10">
        <span className="font-bold">{item.name} · {item.academicYear}</span><span className="block text-sm">{item.gradeName}{item.status !== 'active' ? ' · Arquivada' : ''}</span><span className="block text-sm text-neutral-600 dark:text-neutral-300">{item.institution.school || 'Escola ainda não informada'}{item.institution.municipality && ` · ${item.institution.municipality}`}</span>
      </button>)}</div>
      {classes.data?.pagination.total === 0 && <div className="py-3"><p>{query ? 'Nenhuma turma encontrada para essa busca.' : 'Você ainda não tem turmas cadastradas.'}</p>{query ? <button className="btn-outline mt-2" onClick={() => setSearch('')}>Limpar busca</button> : <Link className="btn-outline mt-2" to="/turmas">Cadastrar ou revisar turmas</Link>}</div>}
      <PageButtons pagination={classes.data?.pagination} onPage={setPage} />
    </section> : <ClassCycle key={classId} classId={classId} assessmentId={assessmentId} select={select} dirty={dirty} mayLeave={mayLeave} />}
  </div>;
}
function ClassCycle({ classId, assessmentId, select, dirty, mayLeave }) {
  const [page, setPage] = useState(1); const [retry, setRetry] = useState(0);
  const state = useRemote(`${base}/${encodeURIComponent(classId)}?page=${page}`, retry, parseCycleOverview, classId);
  const item = state.data?.class;
  const newAssessmentUrl = `/banco-questoes/revisao?turma=${encodeURIComponent(classId)}`;
  const guard = e => { if (!mayLeave()) e.preventDefault(); };
  return <>
    <section className={surface} aria-label="Turma e aplicação selecionadas">
      {state.loading && <p role="status">Carregando contexto…</p>}
      {state.error && <p role="alert">{state.error} <button onClick={() => setRetry(n => n + 1)} className="btn-outline">Tentar novamente</button></p>}
      {item && <details open={!assessmentId}>
        <summary className="cursor-pointer text-sm"><span className="font-bold">{item.name}</span><span className="text-cyan-700 dark:text-cyan-300"> · Alterar</span><span className="mt-1 block text-neutral-600 dark:text-neutral-300">{state.data.assessments.find(a => a.id === assessmentId)?.title || (assessmentId ? 'Aplicação selecionada em outra página' : 'Escolha uma avaliação')}</span></summary>
        <div className="my-2 flex flex-wrap items-center justify-between gap-2"><p className="text-sm">{item.gradeName} · {item.academicYear}{item.status !== 'active' ? ' · Turma arquivada' : ''}</p><button className="btn-outline" onClick={() => select('')}>Trocar turma</button></div>
        <Institution value={item.institution} />
        <div className="mt-1 flex flex-wrap items-end gap-3">
          <label className="min-w-0 w-full sm:w-auto sm:flex-1"><span className="mb-1 block text-sm font-semibold">Aplicação da turma</span>
            <select aria-label="Aplicação da turma" className="input w-full min-w-0" value={assessmentId} onChange={e => { if (select(classId, e.target.value) !== false && e.target.value) { const context = e.target.closest('details'); context.open = false; context.querySelector('summary').focus(); } }}>
              <option value="">Selecione uma aplicação</option>
              {assessmentId && !state.data.assessments.some(a => a.id === assessmentId) && <option value={assessmentId}>Aplicação selecionada em outra página</option>}
              {state.data.assessments.map(a => <option key={a.id} value={a.id}>{a.title} · {statuses[a.status]}{a.verificationPlanId ? ' · Verificação' : a.isDiagnostic ? ' · Diagnóstico' : ''}</option>)}
            </select></label>
        </div><PageButtons pagination={state.data.pagination} onPage={next => { if (mayLeave()) setPage(next); }} />
          <div className="mt-2 flex flex-wrap gap-2"><Link onClick={guard} to={classAssessmentPath(classId, assessmentId) || '/turmas'} className="btn-outline">Gerenciar aplicação</Link>
          {item.status === 'active' && <Link onClick={guard} to={newAssessmentUrl} className="btn-outline">Preparar diagnóstico <ArrowRight size={16} /></Link>}
          <Link onClick={guard} to={newAssessmentUrl} className="btn-outline"><BookOpenCheck size={16} /> Abrir Banco 2.0</Link></div>
        {item.status === 'active' && <Link onClick={guard} to={`${newAssessmentUrl}&atividade=rapida&grade_id=${item.gradeId}`} className="btn-outline mt-2">Preparar atividade rápida · 1 a 5 questões</Link>}
        {state.data.pagination.total === 0 && <p className="mt-4 text-sm">A turma ainda não tem aplicações. Escolha questões no banco, revise o diagnóstico e aplique à turma.</p>}</details>}
      {!item && <button className="btn-outline mt-2" onClick={() => select('')}>Trocar turma</button>}
      {item && <PedagogicalPeriod key={classId} classId={classId} onSelect={id => {
        const accepted = select(classId, id);
        if (accepted) requestAnimationFrame(() => { const title = document.getElementById('cycle-assessment-title'); title?.focus({ preventScroll: true }); title?.scrollIntoView({ block: 'start' }); });
        return accepted;
      }} />}
    </section>
    {item && assessmentId && <AssessmentCycle key={`${classId}:${assessmentId}`} classId={classId} assessmentId={assessmentId} dirty={dirty} />}
  </>;
}
function AssessmentCycle({ classId, assessmentId, dirty }) {
  const { isEnabled } = useFeatureFlags();
  const path = `${base}/${encodeURIComponent(classId)}/assessments/${encodeURIComponent(assessmentId)}`;
  const [retry, setRetry] = useState(0); const state = useRemote(path, retry, parseCycleDetail, classId, assessmentId);
  const [area, setArea] = useState('results'); const [hasDraft, setHasDraft] = useState(false);
  const changeArea = next => { setArea(next); document.getElementById(`cycle-area-${next}`)?.focus(); };
  const [results, setResults] = useState(null); const [plan, setPlan] = useState(null);
  const [reportOpen, setReportOpen] = useState(false);
  const assessmentHeading = useRef(null), focusInitialResult = useRef(true);
  useEffect(() => {
    if (state.data && focusInitialResult.current && assessmentHeading.current) {
      focusInitialResult.current = false;
      assessmentHeading.current.focus({ preventScroll: true }); assessmentHeading.current.scrollIntoView({ block: 'start' });
    }
  }, [state.data]);
  const dialogTrigger = useRef(null); const focusAfterRefresh = useRef(null);
  const refresh = () => setRetry(n => n + 1);
  const openDialog = (setter, value, event) => { dialogTrigger.current = event.currentTarget; setter(value); };
  const closeDialog = setter => { focusAfterRefresh.current = dialogTrigger.current; setter(null); refresh(); };
  useEffect(() => {
    if (state.loading || results || plan || !focusAfterRefresh.current) return;
    const trigger = focusAfterRefresh.current; focusAfterRefresh.current = null;
    if (trigger.isConnected && !trigger.disabled) trigger.focus();
    else document.querySelector('[data-pedagogical-cycle] nav button[aria-pressed="true"], [data-pedagogical-cycle] [role="alert"] button')?.focus();
  }, [state.loading, results, plan]);
  // Keep the editor mounted across refreshes; an explicit rebase preserves the teacher's unsaved text.
  const [lastData, setLastData] = useState(null);
  useEffect(() => { if (state.data) setLastData(state.data); }, [state.data]);
  const data = state.data || lastData;
  const accessDenied = state.error && !state.loading;
  if ([401, 403, 404].includes(state.status)) return <section className={surface} role="alert">{state.error} <button className="btn-outline" onClick={refresh}>Tentar novamente</button></section>;
  if (!data) return <section className={surface}>{state.loading ? <p role="status">Carregando evidências…</p> : <p role="alert">{state.error} <button className="btn-outline" onClick={refresh}>Tentar novamente</button></p>}</section>;
  const current = data.evidence;
  const verificationReady = data.plans.some(p => p.monitoring?.state === 'evidence_ready');
  const stageLabels = [
    ['Instituição', data.class.institution.status === 'verified' ? 'Confirmada' : 'A confirmar'],
    ['Turma', data.class.status === 'active' ? 'Ativa' : 'Arquivada'],
    ['Diagnóstico', !data.assessment.isDiagnostic ? 'Avaliação não diagnóstica' : data.assessment.status === 'closed' && current?.overview.submittedCount > 0 ? 'Com evidências' : 'Em preparação'],
    ['Intervenção', data.plans.some(p => p.interventionHandled > 0) ? 'Com aulas registradas' : data.plans.some(p => p.executionStatus) ? 'Execução preparada' : data.plans.length ? 'Revisar plano' : 'A planejar'],
    ['Verificação', verificationReady ? 'Comparação disponível' : 'A acompanhar'],
  ];
  return <>
    <nav aria-label="Áreas da devolutiva" className="grid grid-cols-3 gap-1 rounded-xl border border-neutral-200 bg-white p-1 dark:border-white/10 dark:bg-[#111E31]">
      {[['results', 'Resultados'], ['feedback', 'Meu registro'], ['plans', 'Plano de apoio']].map(([key, label]) => <button key={key} id={`cycle-area-${key}`} type="button" aria-pressed={area === key} aria-controls={`cycle-${key}`} onClick={() => changeArea(key)} className={`rounded-lg px-1 py-2 text-sm font-bold ${area === key ? 'bg-cyan-700 text-white dark:bg-cyan-300 dark:text-slate-950' : 'text-neutral-600 hover:bg-neutral-100 dark:text-neutral-300 dark:hover:bg-white/5'}`}>{label}{key === 'feedback' && hasDraft && <span className="block text-xs font-normal">Não salvo</span>}</button>)}
    </nav>
    {state.loading && <p role="status">Atualizando referência…</p>}
    {state.error && <p role="alert" className={surface}>{state.error} O salvamento está bloqueado até uma nova consulta. <button className="btn-outline" onClick={refresh}>Tentar novamente</button></p>}
    <section id="cycle-results" hidden={area !== 'results'} className={surface} aria-label="Resultados da avaliação">
      <div className="flex items-center justify-between gap-2"><h2 id="cycle-assessment-title" ref={assessmentHeading} tabIndex={-1} className="min-w-0 scroll-mt-32 text-base font-bold">{data.assessment.title}</h2><button className="btn-outline shrink-0" aria-label="Atualizar resultados" title="Atualizar resultados" disabled={state.loading} onClick={refresh}><RefreshCw size={16} /><span className="sr-only sm:not-sr-only">Atualizar resultados</span></button></div>
      <p className="mt-1 text-sm">{statuses[data.assessment.status]} · {data.assessment.isDiagnostic ? 'Diagnóstico' : 'Avaliação da turma'}</p>
      <button type="button" disabled={Boolean(accessDenied || state.loading)} className="btn-outline my-2" onClick={() => setReportOpen(true)}>Ver relatório da turma</button>
      {current ? <>
        <p data-cycle-overview className="my-2 text-sm"><strong>{current.overview.submittedCount}</strong> correções de {current.overview.participantCount} participantes · Média: <strong>{percent(current.overview.meanPercentage)}</strong></p>
        <div className="mb-3 flex flex-wrap gap-2"><button disabled={Boolean(accessDenied || state.loading)} className="btn-primary" onClick={e => openDialog(setResults, data.assessment, e)}>Ver correções</button><button className="btn-outline" onClick={() => changeArea('feedback')}>Escrever meu registro</button></div>
        <h3 className="mb-2 text-sm font-bold">Resultados por habilidade</h3>
        {!current.skills.length && <p className="text-sm">Esta avaliação não tem resultados por habilidade.</p>}
        <ul className="divide-y divide-neutral-200 dark:divide-white/10">{current.skills.map(skill => <li key={skill.code} className="py-3"><div className="flex flex-wrap justify-between gap-2 font-bold"><span>{skill.code}</span><span>{percent(skill.successRate)}</span></div><p className="mt-1 text-sm">{skill.description}</p><p className="mt-2 text-xs text-neutral-600 dark:text-neutral-300">{skill.evidence?.notice}</p></li>)}</ul>
      </> : <p className="my-3">Os resultados aparecerão após abrir a aplicação e registrar as correções. Use “Gerenciar aplicação” nas ações da turma.</p>}
      {!data.assessment.isDiagnostic && <p className="mt-3 text-sm">Você pode registrar a devolutiva desta avaliação. A criação guiada da recomposição exige um diagnóstico revisado.</p>}
    </section>
    <div id="cycle-feedback" hidden={area !== 'feedback'}><FeedbackEditor path={path} data={data} blocked={Boolean(accessDenied || state.loading)} onSaved={refresh} dirtyRef={dirty} onDirty={setHasDraft} /></div>
    <section id="cycle-plans" hidden={area !== 'plans'} className={surface} aria-label="Intervenção e verificação">
      <h2 className="text-lg font-bold">Plano de apoio e verificação</h2>
      <p className="mb-3 mt-1 text-sm">Retome o plano, registre as aulas e confira o que a turma aprendeu.</p>
      {!data.capabilities.recovery && <p>A recomposição não está habilitada para esta conta.</p>}
      {data.capabilities.recovery && !data.plans.length && <div><p className="text-sm">Ainda não há plano para esta avaliação. Para criar um, encerre um diagnóstico com resultados e revise as prioridades nas correções.</p>{current && data.assessment.isDiagnostic && <button disabled={Boolean(accessDenied || state.loading)} className="btn-primary mt-3" onClick={e => openDialog(setResults, data.assessment, e)}>Ver correções e planejar apoio</button>}</div>}
      <div className="space-y-4">{data.plans.map(p => <article key={p.id} className="rounded-xl border border-neutral-200 p-4 dark:border-white/10">
        <h3 className="font-bold">{p.title}</h3><p className="mt-1 text-sm">{statuses[p.status]}{p.executionStatus ? ` · ${p.interventionHandled}/${p.interventionCount} intervenções com registro (ministradas ou dispensadas)` : ' · Execução a organizar'}</p>
        <button disabled={Boolean(accessDenied || state.loading)} className="btn-outline mt-3" onClick={e => openDialog(setPlan, { ...p, class: data.class, sourceAssessment: data.assessment }, e)}>Abrir plano e execução <ArrowRight size={16} /></button>
        {p.monitoring && <div className="mt-4 space-y-3 border-t border-neutral-200 pt-4 dark:border-white/10">
          <h4 className="font-semibold">{p.monitoring.state === 'evidence_ready' ? 'Verificação com evidências' : 'Verificação em andamento'}</h4>
          {p.monitoring.application && <p className="text-sm">{p.monitoring.application.title} · {statuses[p.monitoring.application.status]}</p>}
          {p.monitoring.comparison && <RecoveryComparison comparison={p.monitoring.comparison} />}
          {p.monitoring.application && ['open', 'closed'].includes(p.monitoring.application.status) && <button disabled={Boolean(accessDenied || state.loading)} className="btn-outline" onClick={e => openDialog(setResults, p.monitoring.application, e)}>Revisar resultados da verificação</button>}
          {p.monitoring.comparison && <div><p className="text-sm">Considere também o que observou em sala. A diferença entre as porcentagens, sozinha, não prova que o apoio causou a mudança.</p><button className="btn-outline mt-2" onClick={() => changeArea('feedback')}>Registrar próximo passo</button></div>}
        </div>}
      </article>)}</div>
      {data.morePlans && <Link className="mt-4 inline-block underline" onClick={e => { if (dirty.current && !window.confirm('Há alterações não salvas. Sair sem salvar?')) e.preventDefault(); }} to="/recomposicao">Ver todos os planos da conta</Link>}
    </section>
    <details className={`${surface} !py-1`}><summary className="cursor-pointer text-sm font-semibold">Etapas e cuidados com a leitura dos resultados</summary><ol aria-label="Etapas do ciclo" className="mb-3 grid gap-2 sm:grid-cols-5">{stageLabels.map(([label, status], index) => <li key={label}><p className="text-xs font-bold text-cyan-700 dark:text-cyan-300">{index + 1}. {label}</p><p className="mt-1 text-sm">{status}</p></li>)}</ol><p className="mb-3 flex items-start gap-2 text-xs text-neutral-600 dark:text-neutral-300"><ShieldCheck className="shrink-0" size={16} />{data.notice}</p></details>
    {results && <ClassAssessmentResults schoolClass={data.class} assignment={results} recoveryEnabled={data.capabilities.recovery && isEnabled('classes.learning_recovery')} feedbackEnabled={isEnabled('classes.student_feedback_release')} onClose={() => closeDialog(setResults)} />}
    {plan && <PlanDialog plan={plan} onClose={() => closeDialog(setPlan)} onChanged={refresh} />}
    {reportOpen && <PedagogicalReport classId={classId} assessmentId={assessmentId} onClose={() => setReportOpen(false)} />}
  </>;
}
function FeedbackEditor({ path, data, blocked, onSaved, dirtyRef, onDirty }) {
  const initial = () => Object.fromEntries(Object.keys(fieldLabels).map(key => [key, data.feedback?.[key] || '']));
  const [form, setForm] = useState(initial); const [saved, setSaved] = useState(initial);
  const [basis, setBasis] = useState({ revision: data.feedback?.revision || 0, hash: data.evidenceHash });
  const [saving, setSaving] = useState(false); const [message, setMessage] = useState('');
  const [history, setHistory] = useState(null); const [historyError, setHistoryError] = useState('');
  const historyLoading = useRef(false); const [loadingHistory, setLoadingHistory] = useState(false);
  const historyRequest = useRef(null); const historyCursor = useRef(null); const writePending = useRef(false); const historyDetails = useRef(null);
  const conflictAlert = useRef(null); const historyAlert = useRef(null);
  const requestRef = useRef(null); const live = useRef(true);
  const dirty = JSON.stringify(form) !== JSON.stringify(saved);
  const changed = basis.hash !== data.evidenceHash || basis.revision !== (data.feedback?.revision || 0);
  useEffect(() => {
    if (changed && !blocked && conflictAlert.current?.getClientRects().length) {
      conflictAlert.current.focus({ preventScroll: true }); conflictAlert.current.scrollIntoView({ block: 'center' });
    }
  }, [changed, blocked]);
  useEffect(() => {
    if (historyError && historyAlert.current?.getClientRects().length) {
      historyAlert.current.focus({ preventScroll: true }); historyAlert.current.scrollIntoView({ block: 'center' });
    }
  }, [historyError]);
  useEffect(() => { dirtyRef.current = dirty; onDirty(dirty); return () => { dirtyRef.current = false; }; }, [dirty, dirtyRef, onDirty]);
  useEffect(() => {
    live.current = true;
    const warn = e => { if (dirtyRef.current) { e.preventDefault(); e.returnValue = ''; } };
    const guardNavigation = e => {
      const link = e.target.closest?.('a[href]');
      if (!dirtyRef.current || !link || isLocalReportDownload(link, window.location.origin) || link.closest('[data-pedagogical-cycle]') || link.target === '_blank'
        || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
      if (!window.confirm('Há alterações não salvas na devolutiva. Deseja sair sem salvá-las?')) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', warn);
    document.addEventListener('click', guardNavigation, true);
    return () => { live.current = false; historyRequest.current?.abort(); window.removeEventListener('beforeunload', warn); document.removeEventListener('click', guardNavigation, true); };
  }, [dirtyRef]);
  async function save(e) {
    e.preventDefault(); if (writePending.current || blocked || changed || !data.canSaveFeedback || !dirty) return;
    writePending.current = true;
    const body = { ...form, expectedRevision: basis.revision, evidenceHash: basis.hash };
    const fingerprint = JSON.stringify(body);
    if (requestRef.current?.fingerprint !== fingerprint) requestRef.current = { fingerprint, key: crypto.randomUUID() };
    setSaving(true); setMessage('');
    try {
      const response = await api.post(`${path}/feedback`, body, { headers: { 'Idempotency-Key': requestRef.current.key }, timeout: 20000 });
      if (!live.current) return;
      const confirmed = confirmedFeedback(response.data, body);
      const next = Object.fromEntries(Object.keys(fieldLabels).map(key => [key, confirmed[key]]));
      setForm(next); setSaved(next); setBasis({ revision: confirmed.revision, hash: confirmed.evidenceHash });
      historyRequest.current?.abort(); historyLoading.current = false; setLoadingHistory(false);
      setMessage(`Revisão ${confirmed.revision} salva. Registro privado do professor.`); setHistory(null); setHistoryError(''); onSaved();
      if (historyDetails.current?.open) loadHistory();
    } catch (error) {
      if (!live.current) return;
      setMessage(error.response?.data?.error || 'Não foi possível confirmar o salvamento. Tente novamente: a repetição não duplica a revisão.');
      if (error.response?.status === 409) onSaved();
    } finally { writePending.current = false; if (live.current) setSaving(false); }
  }
  async function loadHistory(before) {
    if (historyLoading.current) return;
    historyLoading.current = true; setLoadingHistory(true); historyCursor.current = before;
    const controller = new AbortController(); historyRequest.current = controller;
    setHistoryError('');
    try {
      const response = await api.get(`${path}/feedback${before ? `?before=${before}` : ''}`, { signal: controller.signal, timeout: 15000 });
      const result = parseFeedbackHistory(response.data);
      if (live.current && !controller.signal.aborted) setHistory(previous => ({ ...result, data: before ? [...(previous?.data || []), ...result.data].filter((r, i, rows) => rows.findIndex(x => x.revision === r.revision) === i) : result.data }));
    } catch { if (live.current && !controller.signal.aborted) setHistoryError('Não foi possível consultar o histórico. Tente novamente.'); }
    finally { if (historyRequest.current === controller) { historyLoading.current = false; if (live.current) setLoadingHistory(false); } }
  }
  return <section className={surface} aria-label="Devolutiva docente">
    <h2 className="text-lg font-bold">Meu registro sobre a turma</h2>
    <p className="mb-3 mt-1 text-sm">Só você vê este registro. Ele não é enviado aos estudantes. Descreva a aprendizagem, sem nomes ou dados pessoais.</p>
    {data.feedback && <p className="mb-3 text-sm"><CheckCircle2 className="mr-1 inline" size={16} /> Última revisão salva: {data.feedback.revision}</p>}
    {data.feedbackStale && <p role="status" className="mb-3 text-sm text-amber-800 dark:text-amber-200">A devolutiva salva usa resultados anteriores. O histórico foi preservado; revise o texto à luz da referência atual.</p>}
    {!data.canSaveFeedback && <p className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">Para salvar, a turma deve estar ativa e a aplicação encerrada com ao menos uma correção.</p>}
    {changed && <div ref={conflictAlert} tabIndex={-1} role="alert" className="mb-4 rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200"><p>Os resultados ou o registro salvo mudaram. Seu texto foi mantido. Confira os resultados e o histórico antes de continuar.</p><button type="button" disabled={blocked || saving} className="btn-outline mt-2" onClick={() => { setBasis({ revision: data.feedback?.revision || 0, hash: data.evidenceHash }); requestRef.current = null; }}>Revisei; usar referência atual sem apagar meu texto</button></div>}
    <form onSubmit={save} className="space-y-3">
      {Object.entries(fieldLabels).map(([key, [label, helper]]) => <label key={key} className="block"><span className="block text-sm font-bold">{label}</span><span className="mb-2 mt-1 block text-xs text-neutral-600 dark:text-neutral-300">{helper}</span>
        <textarea aria-label={label} className="input w-full" value={form[key]} required minLength={10} maxLength={2000} disabled={saving || blocked} onChange={e => setForm(previous => ({ ...previous, [key]: e.target.value }))} rows={3} />
        <span className="block text-xs text-neutral-600 dark:text-neutral-300">{form[key].length}/2.000 caracteres · mínimo de 10</span>
      </label>)}
      <div className="flex flex-wrap items-center gap-3"><button className="btn-primary" disabled={saving || blocked || changed || !data.canSaveFeedback || !dirty}><Save size={16} /> {saving ? 'Salvando…' : 'Salvar nova revisão'}</button>
        <span className="text-xs">{dirty ? 'Alterações ainda não salvas. Salve antes de sair.' : 'Nenhuma alteração pendente.'}</span></div>
      {message && <p role="status" className="text-sm">{message}</p>}
    </form>
    <details ref={historyDetails} className="mt-5 border-t border-neutral-200 pt-4 dark:border-white/10" onToggle={e => { if (e.currentTarget.open && !history) loadHistory(); }}>
      <summary className="cursor-pointer text-sm font-bold">Consultar histórico de revisões</summary>
      {history?.data.length === 0 && <p className="mt-3 text-sm">Nenhuma revisão salva.</p>}
      {history?.data.map(revision => <article key={revision.revision} className="mt-3 rounded-xl bg-neutral-50 p-4 text-sm dark:bg-white/5"><h3 className="font-bold">Revisão {revision.revision} · {revision.createdAt}</h3><p className="mt-1 text-xs">Referência preservada: {revision.evidence.overview.submittedCount} correções · Média {percent(revision.evidence.overview.meanPercentage)}</p>
        {revision.evidence.verifications?.filter(item => item.comparison).map(item => <div key={item.id} className="mt-3 space-y-2 rounded-lg border border-neutral-200 p-3 dark:border-white/10"><p className="font-bold">Verificação preservada nesta revisão: {item.application.title}</p><RecoveryComparison comparison={item.comparison} /></div>)}
        {Object.entries(fieldLabels).map(([key, [label]]) => <p key={key} className="mt-3 whitespace-pre-wrap break-words"><strong>{label}: </strong>{revision[key]}</p>)}</article>)}
      {loadingHistory && <p role="status">Carregando revisões…</p>}
      {historyError && <p ref={historyAlert} tabIndex={-1} role="alert">{historyError} <button disabled={loadingHistory} className="btn-outline" onClick={() => loadHistory(historyCursor.current)}>Tentar novamente</button></p>}
      {history?.nextBefore && <button disabled={loadingHistory} className="btn-outline mt-3" onClick={() => loadHistory(history.nextBefore)}>Carregar revisões anteriores</button>}
    </details>
  </section>;
}
