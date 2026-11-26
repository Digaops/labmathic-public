import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { ArrowRight, RefreshCw, Search } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { eventDay } from '../services/eventDates.mjs';
import { recoverySummary } from '../services/recoveryLanguage.mjs';
import useReadOnlyResource from '../hooks/useHomeResource';
import AssessmentDialog from '../components/AssessmentDialog';
import LearningRecoveryReview from '../components/LearningRecoveryReview';
import { parseRecoveryList, readRecoveryQuery, recoveryAction, recoveryListPath, recoveryStatuses, recoveryWorkspaceState } from '../services/recoveryPlansView.mjs';

const surface = 'rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31] sm:p-4';
const plansPerPage = 20;
function formatDate(value) {
  return eventDay(value) || 'Não informada';
}
export function PlanDialog({ plan, onClose, onChanged, closeGuardRef }) {
  const localGuard = useRef(() => true);
  const guard = closeGuardRef || localGuard;
  return <AssessmentDialog title="Plano de recomposição" wide onClose={() => { if (guard.current()) onClose(); }}>
    <LearningRecoveryReview schoolClass={{id:plan.class.id,name:plan.class.name}}
      assignment={{id:plan.sourceAssessment.id,title:plan.sourceAssessment.title}} initialPlanId={plan.id}
      onBack={onClose} backLabel="Voltar aos planos" onPlanChange={onChanged} closeGuardRef={guard} />
  </AssessmentDialog>;
}
export default function LearningRecoveryPlans() {
  const { user, announcementAccessId } = useAuth();
  const flags = useFeatureFlags();
  const access = recoveryWorkspaceState(user?.role, flags);
  if (access !== 'operational') return <section className="mx-auto max-w-6xl space-y-3 px-4 py-4 sm:px-6" data-recovery-access={access}>
    <h1 className="text-xl font-bold sm:text-2xl">Planos de recomposição</h1>
    <div className={surface}>
      {access === 'loading' ? <p role="status">Conferindo seu acesso…</p> : <>
        <p role={access === 'unavailable' ? 'alert' : undefined}>{access === 'unavailable' ? 'Não foi possível conferir seu acesso. Verifique a conexão e tente novamente.'
          : access === 'role_restricted' ? 'Acesse com a conta do professor responsável pelos planos.'
            : 'Os planos de recomposição ainda não estão disponíveis para sua conta.'}</p>
        <div className="mt-2 flex flex-wrap gap-2">
          {access !== 'role_restricted' && <button type="button" className="btn-outline" onClick={flags.refresh}>Conferir acesso novamente</button>}
          <Link className="btn-outline" to="/">Voltar ao início</Link>
        </div>
      </>}
    </div>
  </section>;
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  return <PlansWorkspace key={identity || 'signed-out'} identity={identity} />;
}
function PlansWorkspace({ identity }) {
  const [params,setParams] = useSearchParams();
  const query = readRecoveryQuery(params);
  const [search,setSearch] = useState(query.search);
  const [selectedPlan,setSelectedPlan] = useState(null);
  const [page,setPage] = useState(1);
  const heading = useRef(null), returnTo = useRef(null), restoreFocus = useRef(false), refreshStarted = useRef(false);
  const handledPlanId = useRef(null);
  const closeGuard = useRef(() => true);
  const declinedParams = useRef(null);
  const resource = useReadOnlyResource(recoveryListPath(query), identity, parseRecoveryList);
  const listedPlan = query.planId ? resource.data?.data.find(plan => plan.id === query.planId) : null;
  const lookupOutsideFilter = query.planId && !listedPlan && (query.search || query.status !== 'all') && resource.status === 'ready';
  const planQuery = lookupOutsideFilter ? recoveryListPath({ search: '', status: 'all' }) : null;
  const unfiltered = useReadOnlyResource(planQuery, identity, parseRecoveryList);
  const lookup = planQuery ? unfiltered : resource;
  const requestedPlan = listedPlan || (planQuery ? unfiltered.data?.data.find(plan => plan.id === query.planId) : null);
  const plans = resource.data?.data || [], counts = resource.data?.counts;
  const totalPages = Math.max(1, Math.ceil(plans.length / plansPerPage));
  const currentPage = Math.min(page, totalPages);
  const visible = plans.slice((currentPage - 1) * plansPerPage, currentPage * plansPerPage);

  useEffect(()=>{setSearch(query.search);setPage(1);},[query.search,query.status]);
  useEffect(() => {
    if (selectedPlan) {
      if (query.planId === handledPlanId.current) {
        declinedParams.current = null;
        return;
      }
      if (declinedParams.current === params) return;
      if (!closeGuard.current()) {
        declinedParams.current = params;
        const next = new URLSearchParams(params);
        next.set('plano', handledPlanId.current);
        setParams(next, { replace: true, preventScrollReset: true });
        return;
      }
      handledPlanId.current = null;
      restoreFocus.current = true;
      refreshStarted.current = true;
      setSelectedPlan(null);
      return;
    }
    if (!query.planId) {
      handledPlanId.current = null;
      return;
    }
    if (!requestedPlan || handledPlanId.current === query.planId) return;
    handledPlanId.current = query.planId;
    returnTo.current = requestedPlan.id;
    restoreFocus.current = false;
    refreshStarted.current = false;
    setSelectedPlan(requestedPlan);
  }, [params, query.planId, requestedPlan, selectedPlan, setParams]);
  useEffect(() => {
    if (!restoreFocus.current || selectedPlan) return;
    if (resource.status === 'loading') { refreshStarted.current = true; return; }
    if (!refreshStarted.current) return;
    const index = resource.data?.data.findIndex(plan => plan.id === returnTo.current) ?? -1;
    const targetPage = Math.floor(index / plansPerPage) + 1;
    if (index >= 0 && targetPage !== currentPage) {
      setPage(targetPage);
      return;
    }
    restoreFocus.current = false;
    refreshStarted.current = false;
    const target = index >= 0 ? document.getElementById('recovery-open-' + returnTo.current) : null;
    (target || heading.current)?.focus();
  }, [resource.status, resource.data, selectedPlan, currentPage]);
  function clearPlanLink() {
    if (!params.has('plano')) return;
    const next = new URLSearchParams(params);
    next.delete('plano');
    setParams(next, { replace: true, preventScrollReset: true });
  }
  function closePlan() {
    restoreFocus.current = true;
    setSelectedPlan(null);
    if (query.planId === handledPlanId.current) clearPlanLink();
    resource.retry();
  }
  function openPlan(id) {
    const next = new URLSearchParams(params);
    next.set('plano', id);
    setParams(next, { replace: true, preventScrollReset: true });
  }
  const update = (search,status) => {
    const next = new URLSearchParams(params); next.delete('busca'); next.delete('situacao'); next.delete('plano');
    if(search.trim()) next.set('busca',search.replace(/\s+/g,' ').trim().slice(0,80));
    if(status !== 'all') next.set('situacao',status);
    setPage(1); setParams(next);
  };
  const changed = updated => {
    if(updated) setSelectedPlan(current => current?.id === updated.id ? {...current,status:updated.status,title:updated.title} : current);
    resource.retry();
  };
  return <div data-recovery-plans className="bank-form mx-auto max-w-6xl space-y-3 bg-slate-50 px-4 py-4 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <header className="flex items-start justify-between gap-3"><div className="min-w-0"><h1 ref={heading} tabIndex={-1} className="text-xl font-bold sm:text-2xl">Planos de recomposição</h1><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">Retome o plano de apoio da sua turma.</p></div><Link className="btn-outline shrink-0" to="/turmas">Turmas</Link></header>
    <form className={surface} role="search" aria-label="Buscar planos" onSubmit={e=>{e.preventDefault();update(search,query.status);}}>
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_220px]">
        <label className="block"><span className="mb-1 block text-sm font-semibold">Buscar plano</span><span className="flex gap-2"><input className="input min-w-0 flex-1" type="search" aria-label="Buscar plano" maxLength={80} value={search} onChange={e=>setSearch(e.target.value)} placeholder="Buscar por plano, turma ou avaliação"/><button className="btn-primary" aria-label="Buscar"><Search size={17}/></button></span></label>
        <label className="block"><span className="mb-1 block text-sm font-semibold">Situação</span><select aria-label="Situação" className="input" value={query.status} onChange={e=>update(search,e.target.value)}><option value="all">Todas as situações</option>{Object.entries(recoveryStatuses).map(([key,label])=><option key={key} value={key}>{label}</option>)}</select></label>
      </div>
    </form>
    {resource.status === 'loading' && <p className={surface} role="status">Carregando planos…</p>}
    {resource.status === 'error' && <div className={surface} role="alert"><p>Não foi possível carregar os planos. Seus registros não foram alterados.</p><button className="btn-outline mt-2" onClick={resource.retry}><RefreshCw size={16}/> Tentar novamente</button></div>}
    {!selectedPlan && params.has('plano') && (!query.planId || (lookup.status === 'ready' && !requestedPlan)) && <div className={surface}>
      <p role="status">{query.planId ? 'O plano do link não apareceu nesta consulta. Busque pelo nome, pela turma ou pela avaliação de origem.' : 'O link do plano está incompleto. Use a busca para localizar o plano.'}</p>
      <button type="button" className="btn-outline mt-2" onClick={() => { clearPlanLink(); heading.current?.focus(); }}>Continuar na lista</button>
    </div>}
    {!selectedPlan && planQuery && lookup.status === 'loading' && resource.status !== 'loading' && <p className={surface} role="status">Localizando o plano do link…</p>}
    {!selectedPlan && planQuery && lookup.status === 'error' && <div className={surface} role="alert">
      <p>Não foi possível localizar o plano do link agora.</p>
      <button type="button" className="btn-outline mt-2" onClick={lookup.retry}><RefreshCw size={16}/> Tentar novamente</button>
    </div>}
    {resource.status === 'ready' && <>
      {!plans.length ? <section className={surface}><h2 className="font-bold">{query.search || query.status !== 'all' ? 'Nenhum plano neste filtro' : 'Nenhum plano criado ainda'}</h2><p className="mt-1 text-sm">{query.search || query.status !== 'all' ? 'Experimente outro nome ou outra situação.' : 'Após encerrar um diagnóstico com correções, abra os resultados da turma e revise as prioridades.'}</p>{query.search || query.status !== 'all' ? <button className="btn-outline mt-2" onClick={()=>update('','all')}>Limpar filtros</button> : <Link className="btn-outline mt-2" to="/turmas">Ir para turmas</Link>}</section> : <section aria-label="Meus planos" className="divide-y divide-slate-200 overflow-hidden rounded-2xl border border-slate-200 bg-white dark:divide-white/10 dark:border-white/10 dark:bg-[#111E31]">
        {visible.map(plan=><article key={plan.id} data-recovery-plan={plan.id} className="p-3 sm:p-4">
          <div className="flex flex-col items-start justify-between gap-2 sm:flex-row"><div className="min-w-0 flex-1"><h2 className="break-words text-base font-bold">{plan.title}</h2><p className="mt-1 text-sm">{plan.class.name} · {plan.class.academicYear}</p><p className="mt-1 text-sm font-semibold text-violet-700 dark:text-violet-300">{recoveryStatuses[plan.status]}</p></div>
            <button id={'recovery-open-'+plan.id} className="btn-outline" onClick={() => openPlan(plan.id)}>{recoveryAction(plan)}<ArrowRight size={16}/></button></div>
          {plan.execution && <p className="mt-2 text-sm">Etapas registradas: {plan.execution.handled} de {plan.execution.total} · {plan.execution.percentage}%</p>}
          <details className="mt-1"><summary className="cursor-pointer text-sm font-semibold text-cyan-700 dark:text-cyan-300">Detalhes do plano</summary><div className="space-y-1 pb-2 text-sm"><p>{plan.class.gradeName} · Origem: {plan.sourceAssessment.title}</p><p>{recoverySummary(plan)}</p><p>Atualizado em {formatDate(plan.updatedAt)}</p></div></details>
        </article>)}
      </section>}
      {totalPages > 1 && <nav aria-label="Páginas dos planos" className="flex flex-wrap items-center justify-between gap-2"><button className="btn-outline" disabled={currentPage<=1} onClick={()=>{setPage(currentPage-1);heading.current?.focus();}}>Anterior</button><span className="text-sm">Página {currentPage} de {totalPages}</span><button className="btn-outline" disabled={currentPage>=totalPages} onClick={()=>{setPage(currentPage+1);heading.current?.focus();}}>Próxima</button></nav>}
      {plans.length===100 && <p role="status" className="text-sm">Esta consulta trouxe o limite de 100 planos. Use a busca e a situação para localizar os demais.</p>}
      <details className={surface}><summary className="cursor-pointer text-sm font-semibold">Resumo dos meus planos · {counts.total}</summary><p className="mt-2 text-sm">Totais da conta, sem os filtros desta busca.</p><ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-sm">{Object.entries(recoveryStatuses).map(([key,label])=><li key={key}>{label}: <strong>{counts[key]}</strong></li>)}</ul></details>
    </>}
    {selectedPlan && <PlanDialog plan={selectedPlan} onClose={closePlan} onChanged={changed} closeGuardRef={closeGuard}/>}
  </div>;
}
