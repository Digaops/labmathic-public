import { useState, useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useSearchParams } from 'react-router-dom';
import { Search, SlidersHorizontal, X, ChevronLeft, ChevronRight, BookOpen, RefreshCw } from 'lucide-react';
import MaterialCard from '../components/MaterialCard';
import { SkeletonGrid } from '../components/Skeleton';
import useModalLifecycle from '../hooks/useModalLifecycle';
import useReadOnlyResource from '../hooks/useHomeResource';
import { useAuth } from '../contexts/AuthContext';
import { formatCount } from '../utils/pluralize';
import { readLibraryQuery, librarySearchParams, libraryRequestPath, parseLibraryMaterials, parseLibraryCategories,
  libraryFilterKeys, libraryFormats, librarySorts, libraryFilterName } from '../services/libraryQuery.mjs';

const surface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300';
const button = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-cyan-800 hover:bg-cyan-50 disabled:opacity-40 disabled:cursor-not-allowed dark:text-cyan-200 dark:hover:bg-white/5 ${focus}`;
const field = `min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 [color-scheme:light] dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100 dark:[color-scheme:dark] ${focus}`;
const labels = { discipline_id: 'Disciplina', grade_id: 'Ano escolar', material_type_id: 'Tipo de material', topic_id: 'Assunto', file_format: 'Formato do arquivo' };

export default function Library() {
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  const isAdmin = user?.role === 'admin';
  const [searchParams, setSearchParams] = useSearchParams();
  const queryKey = searchParams.toString();
  const query = useMemo(() => readLibraryQuery(new URLSearchParams(queryKey)), [queryKey]);
  const [searchInput, setSearchInput] = useState(query.search);
  useEffect(() => setSearchInput(query.search), [query.search]);

  const materials = useReadOnlyResource(libraryRequestPath(query), identity, parseLibraryMaterials);
  const disciplines = useReadOnlyResource('/categories/disciplines', identity, parseLibraryCategories);
  const grades = useReadOnlyResource('/categories/grades', identity, parseLibraryCategories);
  const types = useReadOnlyResource('/categories/material-types', identity, parseLibraryCategories);
  const topics = useReadOnlyResource('/categories/topics', identity, parseLibraryCategories);
  const categories = { discipline_id: disciplines, grade_id: grades, material_type_id: types, topic_id: topics };

  const [showFilters, setShowFilters] = useState(false);
  const [mobile, setMobile] = useState(() => window.matchMedia('(max-width: 767px)').matches);
  useEffect(() => {
    const media = window.matchMedia('(max-width: 767px)');
    const onChange = () => { setMobile(media.matches); setShowFilters(false); };
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  const drawer = useRef(null);
  useModalLifecycle(drawer, { open: showFilters && mobile, onClose: () => setShowFilters(false) });

  const resultHeading = useRef(null);
  const focusAfterPage = useRef(false);
  useEffect(() => {
    if (!focusAfterPage.current || materials.status === 'loading') return;
    focusAfterPage.current = false;
    resultHeading.current?.focus({ preventScroll: true });
    resultHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [materials.status, queryKey]);

  function updateQuery(patch) {
    setSearchParams(librarySearchParams({ ...query, ...patch, page: patch.page ?? 1 }));
  }
  function changeFilter(key, value) { updateQuery({ filters: { ...query.filters, [key]: value } }); }
  function clearFilters() {
    setSearchInput('');
    updateQuery({ search: '', filters: Object.fromEntries(libraryFilterKeys.map(key => [key, ''])) });
  }
  function changePage(page) { focusAfterPage.current = true; updateQuery({ page }); }

  const activeFilters = libraryFilterKeys.filter(key => query.filters[key]);
  const hasFilters = !!query.search || activeFilters.length > 0;
  const ready = materials.status === 'ready';
  const result = ready ? materials.data : null;
  const resultLabel = ready ? formatCount(result.pagination.total, 'material encontrado', 'materiais encontrados')
    : materials.status === 'error' ? 'Não foi possível carregar os materiais' : 'Buscando materiais…';
  const filterProps = { query, categories, isAdmin, onChange: changeFilter, onClear: clearFilters, hasFilters };

  return (
    <div data-library className="mx-auto max-w-7xl space-y-3 bg-slate-50 px-4 py-4 dark:bg-transparent sm:px-6">
      <header className={`${surface} px-4 py-3 sm:grid sm:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] sm:gap-x-6`}>
        <div className="sm:row-span-2">
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">Biblioteca</h1>
        <p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">Encontre materiais para suas aulas.</p>
        </div>
        <form role="search" aria-label="Buscar na biblioteca" onSubmit={event => { event.preventDefault(); updateQuery({ search: searchInput.trim() }); }} className="mt-3 flex gap-2 sm:mt-0">
          <label htmlFor="library-search" className="sr-only">Buscar material</label>
          <input id="library-search" type="search" className={`${field} flex-1`} placeholder="O que procura?" value={searchInput} onChange={event => setSearchInput(event.target.value)} />
          <button type="submit" className={`inline-flex min-h-11 shrink-0 items-center justify-center gap-2 rounded-xl bg-blue-700 px-3 text-sm font-bold text-white hover:bg-blue-800 ${focus}`}><Search size={17} aria-hidden="true" /><span>Buscar</span></button>
        </form>
        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <button type="button" aria-expanded={showFilters} aria-controls={showFilters ? 'library-filters' : undefined} onClick={() => setShowFilters(value => !value)} className={`${button} relative`}>
            <SlidersHorizontal size={18} aria-hidden="true" />Filtros{activeFilters.length > 0 && <span className="absolute -right-1 top-0 flex h-5 min-w-5 items-center justify-center rounded-md bg-cyan-100 px-1 text-xs dark:bg-cyan-950">{activeFilters.length}</span>}
          </button>
          <div className="flex min-w-0 items-center gap-2">
            <label htmlFor="library-sort" className="sr-only">Ordenar materiais</label>
            <select id="library-sort" value={query.sort} onChange={event => updateQuery({ sort: event.target.value })} className={`${field} w-auto max-w-full`}>
              {librarySorts.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </div>
        </div>
      </header>

      {hasFilters && <nav aria-label="Busca e filtros ativos" className="flex flex-wrap items-center gap-2">
        {query.search && <FilterChip label={`Busca: ${query.search}`} onRemove={() => { setSearchInput(''); updateQuery({ search: '' }); }} />}
        {activeFilters.map(key => <FilterChip key={key} label={`${labels[key]}: ${libraryFilterName(key, query.filters[key], categories[key]?.data)}`} onRemove={() => changeFilter(key, '')} />)}
        <button type="button" className={button} onClick={clearFilters}>Limpar tudo</button>
      </nav>}

      <div className="flex items-start gap-5">
        {showFilters && !mobile && <aside id="library-filters" aria-label="Filtros da biblioteca" className={`${surface} w-64 shrink-0 p-4`}>
          <h2 className="font-bold text-slate-900 dark:text-white">Filtrar materiais</h2>
          <p className="mb-4 mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">A lista muda conforme você escolhe.</p>
          <FilterPanel {...filterProps} />
        </aside>}

        <section aria-label="Resultados da biblioteca" className="min-w-0 flex-1" aria-busy={materials.status === 'loading'}>
          <h2 ref={resultHeading} tabIndex={-1} className={`mb-3 scroll-mt-32 text-sm font-semibold text-slate-700 dark:text-slate-200 ${focus}`}><span role="status" aria-live="polite">{resultLabel}</span></h2>
          {materials.status === 'error' ? <div role="alert" className={`${surface} p-4`}>
            <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">Sua busca e seus filtros foram mantidos. Tente carregar novamente.</p>
            <button type="button" className={`${button} mt-2`} onClick={materials.retry}><RefreshCw size={16} aria-hidden="true" />Tentar novamente</button>
          </div> : !ready ? <SkeletonGrid count={4} /> : result.data.length ? <>
            <div data-library-materials className={`grid grid-cols-1 gap-3 sm:grid-cols-2 ${showFilters ? 'xl:grid-cols-3' : 'lg:grid-cols-3 xl:grid-cols-4'}`}>
              {result.data.map(material => <MaterialCard key={material.id} material={material} compactOnMobile fromLabel="Biblioteca" />)}
            </div>
            {result.pagination.totalPages > 1 && <nav aria-label="Páginas de materiais" className="mt-5 flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={() => changePage(query.page - 1)} disabled={query.page <= 1} className={button}><ChevronLeft size={17} aria-hidden="true" />Anterior</button>
              <span className="text-sm text-slate-600 dark:text-slate-300">Página {result.pagination.page} de {result.pagination.totalPages}</span>
              <button type="button" onClick={() => changePage(query.page + 1)} disabled={query.page >= result.pagination.totalPages} className={button}>Próxima<ChevronRight size={17} aria-hidden="true" /></button>
            </nav>}
          </> : <div className={`${surface} p-4`}>
            <h3 className="flex items-center gap-2 font-bold text-slate-900 dark:text-white"><BookOpen size={18} aria-hidden="true" />{result.pagination.total > 0 ? 'Esta página não tem materiais' : 'Nenhum material encontrado'}</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{query.page > 1 ? 'Volte à primeira página para conferir os resultados.' : hasFilters ? 'Tente outra palavra ou remova um filtro.' : 'Os materiais aparecerão aqui quando forem disponibilizados.'}</p>
            {query.page > 1 ? <button type="button" className={`${button} mt-2`} onClick={() => changePage(1)}>Ir à primeira página</button>
              : hasFilters && <button type="button" className={`${button} mt-2`} onClick={clearFilters}>Limpar busca e filtros</button>}
          </div>}
        </section>
      </div>

      {showFilters && mobile && createPortal(<div data-modal-layer className="fixed inset-0 z-[80]">
        <div className="absolute inset-0 bg-black/50" onClick={() => setShowFilters(false)} />
        <div ref={drawer} id="library-filters" data-library-drawer role="dialog" aria-modal="true" aria-labelledby="library-filter-title" tabIndex={-1}
          className="absolute inset-y-0 right-0 flex w-[min(24rem,calc(100vw-1rem))] flex-col bg-white text-slate-900 shadow-2xl outline-none dark:bg-[#111E31] dark:text-slate-100">
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 px-4 py-3 dark:border-white/10">
            <h2 id="library-filter-title" className="font-bold">Filtrar materiais</h2>
            <button type="button" aria-label="Fechar filtros" className={button} onClick={() => setShowFilters(false)}><X size={20} aria-hidden="true" /></button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 py-3">
            <p className="mb-3 text-sm leading-6 text-slate-600 dark:text-slate-300">A lista muda conforme você escolhe.</p>
            <FilterPanel {...filterProps} />
          </div>
          <div className="shrink-0 border-t border-slate-200 px-4 py-3 dark:border-white/10">
            <p role="status" className="mb-2 text-sm text-slate-600 dark:text-slate-300">{resultLabel}</p>
            <button type="button" className={`min-h-11 w-full rounded-xl bg-blue-700 px-3 py-2 text-sm font-bold text-white hover:bg-blue-800 ${focus}`} onClick={() => setShowFilters(false)}>Ver resultados</button>
          </div>
        </div>
      </div>, document.body)}
    </div>
  );
}

function FilterChip({ label, onRemove }) {
  return <button type="button" aria-label={`Remover ${label}`} onClick={onRemove} className={`${button} max-w-full border border-cyan-200 bg-cyan-50 text-left dark:border-cyan-300/20 dark:bg-cyan-300/10`}>
    <span className="min-w-0 break-words">{label}</span><X size={16} className="shrink-0" aria-hidden="true" />
  </button>;
}

// Keep a stable component identity so a selection never remounts the focused field.
function FilterPanel({ query, categories, isAdmin, onChange, onClear, hasFilters }) {
  return <div className="space-y-2 sm:space-y-4">{libraryFilterKeys.map(key => {
    const resource = categories[key];
    const value = query.filters[key];
    const options = key === 'file_format' ? libraryFormats.map(format => ({ id: format, name: format })) : resource.data || [];
    const missing = value && !options.some(item => String(item.id) === value) && !(key === 'grade_id' && value === 'mine' && !isAdmin);
    return <div key={key}>
      <label htmlFor={`library-${key}`} className="mb-1 block text-sm font-semibold text-slate-800 dark:text-slate-100">{labels[key]}</label>
      <select id={`library-${key}`} className={field} value={value} onChange={event => onChange(key, event.target.value)} disabled={resource && resource.status !== 'ready'} aria-describedby={key === 'grade_id' && value === 'mine' ? 'library-my-grades-help' : undefined}>
        <option value="">{resource?.status === 'loading' ? 'Carregando opções…' : resource?.status === 'error' ? 'Opções indisponíveis' : 'Todos'}</option>
        {key === 'grade_id' && !isAdmin && <option value="mine">Meus anos de ensino</option>}
        {missing && <option value={value}>{libraryFilterName(key, value, options)}</option>}
        {options.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
      {key === 'grade_id' && value === 'mine' && <p id="library-my-grades-help" className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">Usa os anos escolhidos no seu perfil. Sem essa escolha, mostra todos.</p>}
      {resource?.status === 'error' && <div role="alert" className="mt-1 text-sm text-amber-900 dark:text-amber-200"><p>Não foi possível carregar estas opções.</p><button type="button" className={button} aria-label={`Recarregar ${labels[key]}`} onClick={resource.retry}>Tentar novamente</button></div>}
    </div>;
  })}{hasFilters && <button type="button" className={`${button} w-full`} onClick={onClear}>Limpar busca e filtros</button>}</div>;
}
