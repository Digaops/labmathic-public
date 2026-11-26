import { useEffect, useRef, useState } from 'react';
import useHomeResource from '../hooks/useHomeResource';
import { matchesAssessmentText } from '../services/assessmentView.mjs';
import { MAX_NUMERIC_QUESTIONS, canSelectNumericVersion, toggleNumericVersion,
  mergeNumericSourceSelection, parseNumericSourcePage } from '../services/numericAssessmentSelection.mjs';
import { formatCount } from '../utils/pluralize';

export default function NumericAssessmentSourcePicker({ classId, remoteSearch, initialSources, selected, onChange }) {
  const [search, setSearch] = useState('');
  const [settledSearch, setSettledSearch] = useState('');
  const [page, setPage] = useState(1);
  const resultsHeading = useRef(null);
  const focusPage = useRef(false);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettledSearch(search), 300);
    return () => window.clearTimeout(timer);
  }, [search]);
  const waiting = search !== settledSearch;
  const url = remoteSearch && !waiting
    ? `/classes/${classId}/assessments/numeric-sources?search=${encodeURIComponent(settledSearch.trim())}&page=${page}` : null;
  const resource = useHomeResource(url, classId, parseNumericSourcePage);
  const ready = !remoteSearch || (!waiting && resource.status === 'ready');
  const visible = remoteSearch ? (ready ? resource.data.data : [])
    : initialSources.filter(q => matchesAssessmentText(`${q.title} ${q.skillCode} ${q.gradeName} ${q.questionCode || ''}`, search));
  const pagination = ready && remoteSearch ? resource.data.pagination : null;
  const numericSources = mergeNumericSourceSelection(selected, visible);
  const selectedIds = selected.map(q => q.id);

  useEffect(() => {
    if (ready && focusPage.current) {
      focusPage.current = false;
      resultsHeading.current?.focus({ preventScroll: true });
      resultsHeading.current?.scrollIntoView({ block: 'nearest' });
    }
  }, [ready]);
  function changeSearch(value) { setSearch(value); setPage(1); focusPage.current = false; }
  function changePage(value) { focusPage.current = true; setPage(value); }
  function toggle(q) {
    const ids = toggleNumericVersion(numericSources, selectedIds, q.id);
    onChange(ids.map(id => numericSources.find(source => source.id === id)));
  }
  return <section aria-label="Escolher questões numéricas" className="space-y-3">
    <label className="block text-sm font-bold">Buscar questão numérica aprovada
      <input className="input mt-1" maxLength={100} placeholder="Enunciado, habilidade, ano ou código" value={search} onChange={e => changeSearch(e.target.value)} />
    </label>
    {!remoteSearch && <p role="status" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">Busca nas até 200 versões mais recentes. Atualize a página após a atualização do servidor para pesquisar todo o seu acervo aprovado.</p>}
    <p id="numeric-selection-help" className="text-sm text-slate-600 dark:text-slate-300">Escolha uma versão por questão. Ao escolher outra versão da mesma questão, a anterior é substituída. Suas escolhas são mantidas ao buscar ou mudar de página.</p>
    <p role="status" className="text-sm font-bold">{formatCount(selected.length, 'questão selecionada', 'questões selecionadas')} · até {MAX_NUMERIC_QUESTIONS}</p>
    {selected.length > 0 && <details className="rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <summary className="min-h-11 cursor-pointer py-2 text-sm font-bold">Conferir selecionadas ({selected.length})</summary>
      <ol className="mt-2 space-y-2">{selected.map((q, index) => <li key={q.id} className="flex items-start gap-2 border-t border-slate-200 pt-2 dark:border-white/10">
        <span className="min-w-0 flex-1 break-words text-sm">{index + 1}. {q.title}<span className="block text-xs text-slate-600 dark:text-slate-300">{q.skillCode} · Versão {q.version}</span></span>
        <button type="button" className="btn-outline min-h-11 shrink-0" aria-label={`Remover questão ${index + 1}`} onClick={() => onChange(selected.filter(item => item.id !== q.id))}>Remover</button>
      </li>)}</ol>
    </details>}
    {selected.length >= MAX_NUMERIC_QUESTIONS && <p className="text-sm">Limite atingido. Desmarque uma questão para incluir outra; você ainda pode trocar a versão.</p>}
    <h4 ref={resultsHeading} tabIndex={-1} className="text-sm font-bold outline-none">{pagination
      ? `${pagination.total} ${pagination.total === 1 ? 'versão encontrada' : 'versões encontradas'}${pagination.total ? ` · página ${pagination.page} de ${pagination.totalPages}` : ''}` : 'Questões aprovadas'}</h4>
    {!ready && (waiting || resource.status !== 'error') && <p role="status" className="text-sm">Buscando questões aprovadas…</p>}
    {!waiting && resource.status === 'error' && <div role="alert" className="rounded-xl bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">
      <p>Não foi possível buscar as questões. Suas escolhas foram mantidas.</p>
      <button type="button" className="btn-outline mt-2 min-h-11" onClick={resource.retry}>Tentar busca novamente</button>
    </div>}
    {visible.map(q => <label key={q.id} className="flex min-h-11 cursor-pointer gap-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
      <input type="checkbox" className="mt-1 h-5 w-5 shrink-0" aria-describedby="numeric-selection-help" checked={selectedIds.includes(q.id)}
        disabled={!canSelectNumericVersion(numericSources, selectedIds, q.id)} onChange={() => toggle(q)} />
      <span className="min-w-0 break-words text-sm"><strong>{q.title}</strong><span className="mt-1 block text-xs text-slate-600 dark:text-slate-300">{q.gradeName} · {q.skillCode} · Versão {q.version}</span>{q.supportText && <span className="mt-1 block">{q.supportText}</span>}</span>
    </label>)}
    {ready && !visible.length && <div role="status" className="rounded-xl bg-slate-100 p-3 text-sm dark:bg-white/5">
      <p>{search.trim() ? 'Nenhuma questão corresponde à busca. As questões já selecionadas foram mantidas.'
        : page > 1 ? 'Esta página não tem mais questões. Volte à primeira página.'
          : 'Nenhuma questão aprovada disponível. Em Banco de questões → Minhas questões → Questões numéricas · piloto, crie a questão e envie para revisão.'}</p>
      {search && <button type="button" className="btn-outline mt-2 min-h-11" onClick={() => changeSearch('')}>Limpar busca</button>}
      {page > 1 && <button type="button" className="btn-outline mt-2 min-h-11" onClick={() => changePage(1)}>Primeira página</button>}
    </div>}
    {pagination && (pagination.totalPages > 1 || page > 1) && <nav aria-label="Páginas de questões numéricas" className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" className="btn-outline min-h-11" disabled={page <= 1} onClick={() => changePage(page - 1)}>Página anterior</button>
      <button type="button" className="btn-outline min-h-11" disabled={page >= pagination.totalPages} onClick={() => changePage(page + 1)}>Próxima página</button>
    </nav>}
  </section>;
}
