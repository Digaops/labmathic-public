import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import api from '../services/api';
import { eventDay } from '../services/eventDates.mjs';
import { useAuth } from '../contexts/AuthContext';
import TeacherQuestionManager from '../components/TeacherQuestionManager';
import AuthoringWriteAlert from '../components/AuthoringWriteAlert';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { readSetQuery, setSearchParams, setRequestPath, setNavigationUrl, parseSetPage } from '../services/questionSetsView.mjs';
import { questionSetDraftStore } from '../services/questionSetDraft.mjs';
import { quickActivityQuestion } from '../services/quickActivityView.mjs';
import { formatCount } from '../utils/pluralize';

export default function QuestionSets() {
  const { user } = useAuth();
  return <SetsWorkspace key={user?.id} />;
}

function SetsWorkspace() {
  const { user, isAdmin } = useAuth();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const activeTab = params.get('tab') === 'questions' ? 'questions' : 'sets';
  const query = readSetQuery(params);
  const [search, setSearch] = useState(query.search), [error, setError] = useState('');
  const [preparationError, setPreparationError] = useState('');
  const action = useMaterialAction(), heading = useRef(null), focusPage = useRef(false);
  const resource = useReadOnlyResource(activeTab === 'sets' ? setRequestPath(query) : null, user?.id, parseSetPage);
  const pagination = resource.data?.pagination;
  useEffect(() => setSearch(query.search), [query.search]);
  useEffect(() => {
    if (resource.status === 'ready' && query.page > Math.max(1, pagination.totalPages)) {
      setParams(setSearchParams(params, { ...query, page: Math.max(1, pagination.totalPages) }), { replace: true });
    } else if (focusPage.current && resource.status !== 'loading') {
      focusPage.current = false; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start' });
    }
  }, [resource.status, query.page, pagination?.totalPages, params]);
  function changeTab(tab) {
    const next = new URLSearchParams(params); tab === 'sets' ? next.delete('tab') : next.set('tab', 'questions'); setParams(next);
  }
  function changeQuery(patch) { setParams(setSearchParams(params, { ...query, page: 1, ...patch })); }
  function prepareAuthorSet(questions) {
    setPreparationError('');
    const store = questionSetDraftStore(user.id);
    const inspection = store.inspect();
    if (['invalid', 'unavailable'].includes(inspection.status)) {
      setPreparationError('Não foi possível recuperar o rascunho anterior. Abra o Banco de questões e confira o aviso antes de preparar outro.');
      return;
    }
    const existing = inspection.draft;
    if (existing?.pending) {
      setPreparationError('Há um simulado aguardando confirmação. Abra o Banco de questões e retome aquele salvamento primeiro.');
      return;
    }
    if (existing && !window.confirm('Substituir o rascunho atual do Banco de questões por esta seleção?')) return;
    const prepared = store.write({
      selectedIds: questions.map(question => question.id),
      selected: Object.fromEntries(questions.map(question => [question.id, { ...question, ...quickActivityQuestion(question) }])),
      form: { title: '', description: '', is_public: false },
      context: { classId: params.get('turma') || '', quick: false },
      pending: null,
    });
    if (!prepared) {
      setPreparationError('O navegador não conseguiu guardar a seleção. Mantenha esta aba aberta e tente novamente.');
      return;
    }
    navigate('/banco-questoes?revisar=1');
  }
  function removeSet(set) {
    if (action.busy || !window.confirm('Excluir o simulado “' + set.title + '”? Esta ação não pode ser desfeita. Avaliações já aplicadas não serão editadas.')) return;
    setError('');
    action.run(() => api.delete('/question-bank/question-sets/' + set.id, { timeout: 15000 }), {
      refresh: resource.retry, onSuccess: () => { focusPage.current = true; }, onError: setError, message: 'Simulado excluído.',
    });
  }
  return <div data-question-sets className="editorial-workspace bank-form mx-auto max-w-5xl space-y-3 px-3 py-3 sm:px-6 sm:py-4">
    <header className="flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-xl font-bold sm:text-2xl">Simulados</h1>
      <Link className="btn-primary" to={setNavigationUrl('/banco-questoes', params)}><Plus aria-hidden="true" size={17} /> Montar simulado</Link>
    </header>
    <nav aria-label="Áreas de simulados" className="grid grid-cols-2 gap-1 rounded-xl border border-slate-200 bg-white p-1 dark:border-white/10 dark:bg-[#111E31]">
      {[['sets', 'Simulados'], ['questions', isAdmin ? 'Questões autorais' : 'Minhas questões']].map(([tab, label]) => <button key={tab} type="button" aria-current={activeTab === tab ? 'page' : undefined} onClick={() => changeTab(tab)} className={'min-h-11 rounded-lg px-3 py-2 text-sm font-semibold ' + (activeTab === tab ? 'bg-blue-600 text-white' : 'text-slate-600 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10')}>{label}</button>)}
    </nav>
    {activeTab === 'questions' ? <>
      <AuthoringWriteAlert message={preparationError} />
      <TeacherQuestionManager isAdmin={isAdmin} onPrepareSet={prepareAuthorSet} />
    </> : <>
      <form role="search" aria-label="Buscar simulados" className="flex gap-2" onSubmit={event => { event.preventDefault(); changeQuery({ search: search.trim() }); }}>
        <input type="search" aria-label="Buscar simulado" className="input min-w-0 flex-1" value={search} onChange={e => setSearch(e.target.value)} placeholder="Título ou descrição" />
        <button type="submit" className="btn-outline shrink-0"><Search aria-hidden="true" size={16} /> Buscar</button>
      </form>
      {query.search && <div className="flex flex-wrap items-center justify-between gap-2 text-sm"><p>Busca: <strong>{query.search}</strong></p><button type="button" className="btn-outline" onClick={() => changeQuery({ search: '' })}>Limpar busca</button></div>}
      <AuthoringWriteAlert message={error} />
      {resource.status === 'loading' && <p role="status" className="rounded-xl border border-slate-200 p-4 dark:border-white/10">Carregando simulados…</p>}
      {resource.status === 'error' && <section role="alert" className="space-y-2 rounded-xl border border-amber-300 p-3 dark:border-amber-400/30"><h2 ref={heading} tabIndex={-1} className="font-bold outline-none">Não foi possível carregar os simulados</h2><p className="text-sm">A consulta falhou. Isso não significa que seus simulados foram apagados.</p><button type="button" className="btn-outline" onClick={resource.retry}>Tentar novamente</button></section>}
      {resource.status === 'ready' && <section aria-label="Simulados encontrados" className="overflow-hidden rounded-xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]">
        <h2 ref={heading} tabIndex={-1} className="border-b border-slate-200 px-3 py-2 text-sm font-semibold outline-none dark:border-white/10">{formatCount(pagination.total, 'simulado encontrado', 'simulados encontrados')}</h2>
        <div className="divide-y divide-slate-200 dark:divide-white/10">{resource.data.data.map(set => <article key={set.id} data-question-set={set.id} className="space-y-2 p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <h3 className="min-w-0 flex-1 text-base font-bold"><Link className="block min-h-11 underline decoration-transparent underline-offset-4 hover:decoration-current" to={setNavigationUrl('/simulados/' + set.id, params)}>{set.title}</Link></h3>
            <Link className="btn-primary shrink-0" aria-label={'Abrir ' + set.title} to={setNavigationUrl('/simulados/' + set.id, params)}>Abrir</Link>
          </div>
          <p className="text-sm text-slate-600 dark:text-slate-300">{formatCount(set.question_count, 'questão', 'questões')} · {set.is_public ? 'Compartilhado' : 'Privado'}{set.user_id === user?.id ? ' · Criado por você' : set.user_name ? ' · ' + set.user_name : ''}</p>
          {Boolean(set.is_diagnostic) && <p className={'text-sm font-semibold ' + (set.diagnostic_reviewed ? 'text-emerald-800 dark:text-emerald-200' : 'text-amber-900 dark:text-amber-200')}>Diagnóstico{set.diagnostic_grade_name ? ' · ' + set.diagnostic_grade_name : ''} · {set.diagnostic_reviewed ? 'Revisado' : 'Revisão pendente'}</p>}
          <details className="text-sm"><summary className="cursor-pointer text-slate-600 dark:text-slate-300">Detalhes e opções</summary><div className="space-y-2 pb-1 pt-2">
            {set.description && <p className="whitespace-pre-wrap">{set.description}</p>}
            {set.created_at && <p>Criado em {eventDay(set.created_at) || 'data não informada'}</p>}
            {set.author_question_count > 0 && <p>{formatCount(set.author_question_count, 'questão criada por professor', 'questões criadas por professores')}.</p>}
            {(isAdmin || set.user_id === user?.id) && <button type="button" className="btn-outline text-red-700 dark:text-red-300" disabled={action.busy} onClick={() => removeSet(set)}><Trash2 aria-hidden="true" size={16} /> Excluir simulado</button>}
          </div></details>
        </article>)}</div>
        {!resource.data.data.length && <div className="space-y-2 p-3"><h3 className="font-bold">{query.search ? 'Nenhum simulado corresponde à busca' : 'Você ainda não tem simulados disponíveis'}</h3><p className="text-sm">{query.search ? 'Tente outro título ou limpe a busca.' : 'Use Montar simulado para escolher questões. Depois, revise e prepare a aplicação em uma turma.'}</p></div>}
      </section>}
      {resource.status === 'ready' && pagination.totalPages > 1 && <nav aria-label="Páginas de simulados" className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="btn-outline" disabled={query.page <= 1} onClick={() => { focusPage.current = true; changeQuery({ page: query.page - 1 }); }}><ChevronLeft aria-hidden="true" size={16} /> Anterior</button>
        <span className="text-xs">{query.page} de {pagination.totalPages}</span>
        <button type="button" className="btn-outline" disabled={query.page >= pagination.totalPages} onClick={() => { focusPage.current = true; changeQuery({ page: query.page + 1 }); }}>Próxima <ChevronRight aria-hidden="true" size={16} /></button>
      </nav>}
    </>}
  </div>;
}
