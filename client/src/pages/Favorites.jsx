import { useEffect, useRef } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Heart, Library, ChevronLeft, ChevronRight, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import useReadOnlyResource from '../hooks/useHomeResource';
import MaterialCard from '../components/MaterialCard';
import { formatCount } from '../utils/pluralize';
import { favoritesPage, favoritesParams, favoritesRequest, parseFavorites, favoritesPages } from '../services/favoritesView.mjs';

const surface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const focus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300';
const button = `inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-cyan-800 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5 ${focus}`;

export default function Favorites() {
  const { user, announcementAccessId } = useAuth();
  const identity = user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  const [params, setParams] = useSearchParams();
  const page = favoritesPage(params);
  const resource = useReadOnlyResource(favoritesRequest(page), identity, parseFavorites);
  const ready = resource.status === 'ready';
  const result = ready ? resource.data : null;
  const resultHeading = useRef(null);
  const pendingFocus = useRef(false);

  function changePage(nextPage) {
    pendingFocus.current = true;
    setParams(favoritesParams(nextPage));
  }
  useEffect(() => {
    if (!pendingFocus.current) return;
    pendingFocus.current = false;
    resultHeading.current?.focus({ preventScroll: true });
    resultHeading.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }, [page]);

  const label = ready ? formatCount(result.pagination.total, 'material salvo', 'materiais salvos')
    : resource.status === 'error' ? 'Não foi possível carregar seus favoritos' : 'Carregando seus favoritos…';

  return <div data-favorites className="mx-auto max-w-7xl space-y-3 bg-slate-50 px-4 py-4 dark:bg-transparent sm:px-6">
    <header className={`${surface} grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2 gap-y-1 px-4 py-3 sm:gap-x-4`}>
        <h1 className="text-xl font-bold tracking-tight text-slate-900 dark:text-white sm:text-2xl">Favoritos</h1>
      <Link to="/biblioteca" className={`${button} sm:row-span-2`}><Library size={18} aria-hidden="true" />Buscar materiais</Link>
      <p className="col-span-2 text-sm leading-6 text-slate-600 dark:text-slate-300 sm:col-span-1 sm:row-start-2">Materiais que você salvou para usar nas aulas.</p>
    </header>

    <section aria-label="Seus favoritos" aria-busy={resource.status === 'loading'}>
      <h2 ref={resultHeading} tabIndex={-1} className={`mb-3 scroll-mt-32 text-sm font-semibold text-slate-700 dark:text-slate-200 ${focus}`}>
        <span role="status" aria-live="polite">{label}</span>
      </h2>
      {resource.status === 'error' ? <div role="alert" className={`${surface} p-4`}>
        <p className="text-sm leading-6 text-amber-900 dark:text-amber-200">Não conseguimos consultar sua lista agora. Isso não significa que seus materiais foram removidos.</p>
        <button type="button" className={`${button} mt-2`} onClick={resource.retry}><RefreshCw size={17} aria-hidden="true" />Tentar novamente</button>
      </div> : !ready ? <div aria-hidden="true" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {Array.from({ length: 4 }, (_, index) => <div key={index} className={`${surface} space-y-3 p-3 motion-safe:animate-pulse sm:p-4`}>
          <div className="h-4 w-28 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-4 w-3/4 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-4 w-1/2 rounded bg-slate-200 dark:bg-slate-700" />
          <div className="h-px bg-slate-200 dark:bg-slate-700" />
          <div className="h-4 w-28 rounded bg-slate-200 dark:bg-slate-700" />
        </div>)}
      </div> : result.data.length ? <>
        <div data-favorites-materials className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {result.data.map(material => <MaterialCard key={material.id} material={material} compactOnMobile fromLabel="Favoritos" />)}
        </div>
        {result.pagination.totalPages > 1 && <nav aria-label="Páginas de favoritos" className="mt-5 space-y-2">
          <div className="mx-auto grid max-w-md grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2">
            <button type="button" className={`${button} justify-self-start`} disabled={page <= 1} onClick={() => changePage(page - 1)}><ChevronLeft size={17} aria-hidden="true" /><span className="sr-only sm:not-sr-only">Anterior</span></button>
            <span className="text-sm text-slate-600 dark:text-slate-300">Página {result.pagination.page} de {result.pagination.totalPages}</span>
            <button type="button" className={`${button} justify-self-end`} disabled={page >= result.pagination.totalPages} onClick={() => changePage(page + 1)}><span className="sr-only sm:not-sr-only">Próxima</span><ChevronRight size={17} aria-hidden="true" /></button>
          </div>
          <div className="flex flex-wrap items-center justify-center gap-1">{favoritesPages(page, result.pagination.totalPages).map((value, index, pages) => <div key={value} className="flex items-center gap-1">
            {index > 0 && pages[index - 1] !== value - 1 && <span aria-hidden="true" className="px-1 text-slate-500 dark:text-slate-400">…</span>}
            <button type="button" aria-label={`Ir à página ${value}`} aria-current={value === page ? 'page' : undefined} disabled={value === page} onClick={() => changePage(value)}
              className={value === page ? `inline-flex min-h-11 min-w-11 items-center justify-center rounded-xl bg-blue-700 px-3 text-sm font-bold text-white ${focus}` : button}>{value}</button>
          </div>)}</div>
        </nav>}
      </> : <div className={`${surface} p-4`}>
        <h3 className="flex items-center gap-2 font-bold text-slate-900 dark:text-white"><Heart size={18} aria-hidden="true" className="shrink-0" />{result.pagination.total ? 'Esta página não tem materiais' : 'Você ainda não tem favoritos'}</h3>
        <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{result.pagination.total
          ? 'Sua lista mudou ou esta página não existe. Seus outros favoritos continuam disponíveis.'
          : 'Na Biblioteca, abra um material e toque no coração para salvá-lo aqui.'}</p>
        {page > 1 && <button type="button" className={`${button} mt-2`} onClick={() => changePage(result.pagination.totalPages || 1)}>{result.pagination.totalPages > 1 ? 'Ir à última página disponível' : 'Ir à primeira página'}</button>}
      </div>}
    </section>
  </div>;
}
