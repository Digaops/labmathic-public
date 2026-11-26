import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import useAccountLeave from '../../hooks/useAccountLeave';
import useMaterialDeletion from '../../hooks/useMaterialDeletion';
import AssessmentDialog from '../../components/AssessmentDialog';
import AdminMaterialDeletion from '../../components/AdminMaterialDeletion';
import { parseLibraryCategories } from '../../services/libraryQuery.mjs';
import { adminMaterialsQuery, adminMaterialsParams, adminMaterialsPath, adminMaterialsPage, materialFilterKeys } from '../../services/adminMaterialsView.mjs';

const surface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const button = 'inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100';
const labels = { discipline_id: 'Disciplina', grade_id: 'Ano escolar', material_type_id: 'Tipo de material' };

export default function AdminMaterials() {
  const { user, announcementAccessId } = useAuth();
  return user?.role === 'admin' ? <MaterialList key={`${user.id}:${announcementAccessId}`} identity={`${user.id}:${announcementAccessId}`} /> : null;
}
function MaterialList({ identity }) {
  const [params, setParams] = useSearchParams();
  const queryKey = params.toString(), query = useMemo(() => adminMaterialsQuery(new URLSearchParams(queryKey)), [queryKey]);
  const [search, setSearch] = useState(query.search), searchFor = useRef(queryKey);
  const browserQueryKey = () => new URLSearchParams(window.location.search).toString();
  // BrowserRouter can commit after input events. Keep text already typed for the new URL.
  function editSearch(value) { searchFor.current = browserQueryKey(); setSearch(value); }
  useLayoutEffect(() => {
    if (queryKey === browserQueryKey() && searchFor.current !== queryKey) { searchFor.current = queryKey; setSearch(query.search); }
  }, [queryKey]);
  const [filtersOpen, setFiltersOpen] = useState(false), [selecting, setSelecting] = useState(false), [selection, setSelection] = useState({ key: '', ids: [] });
  const parsePage = useMemo(() => payload => { const data = adminMaterialsPage(payload); if (data.pagination.page !== query.page) throw Error('Página diferente da solicitada.'); return data; }, [query.page]);
  const result = useHomeResource(adminMaterialsPath(query), identity, parsePage);
  const ready = result.status === 'ready', page = ready ? result.data.pagination : null, rows = ready ? result.data.data : [];
  const selected = selection.key === queryKey ? selection.ids.filter(id => rows.some(m => m.id === id)) : [];
  const heading = useRef(null), focusResult = useRef(false);
  const action = useMaterialDeletion((focus = false) => { setSelection({ key: '', ids: [] }); if (focus) focusResult.current = true; result.retry(); });
  useAccountLeave(Boolean(action.review?.uncertain), () => action.pending.current,
    'Há uma exclusão sem confirmação. Ao sair, você perderá esta conferência; o pedido enviado pode ter sido concluído. Sair mesmo assim?');
  useEffect(() => { setSelection({ key: '', ids: [] }); }, [queryKey]);
  useEffect(() => {
    if (ready && page.totalPages > 0 && query.page > page.totalPages) { setSelection({ key: '', ids: [] }); setParams(adminMaterialsParams({ ...query, page: page.totalPages }), { replace: true }); }
    else if (ready && !page.total && query.page > 1) setParams(adminMaterialsParams({ ...query, page: 1 }), { replace: true });
    if (focusResult.current && result.status !== 'loading') { focusResult.current = false; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); }
  }, [result.status, result.data, queryKey]);
  function update(patch, focus = false) {
    if (action.pending.current) return;
    const next = { ...query, ...patch, page: patch.page ?? 1 }, nextParams = adminMaterialsParams(next);
    searchFor.current = nextParams.toString(); setSearch(next.search); setSelection({ key: '', ids: [] }); focusResult.current = focus; setParams(nextParams);
  }
  function refresh() { if (action.pending.current) return; setSelection({ key: '', ids: [] }); result.retry(); }
  function toggle(id) { setSelection({ key: queryKey, ids: selected.includes(id) ? selected.filter(n => n !== id) : [...selected, id] }); }
  const active = materialFilterKeys.filter(key => query.filters[key]), filtered = Boolean(query.search || active.length);
  const locked = action.busy || Boolean(action.review?.uncertain);
  return <div data-admin-materials className="mx-auto max-w-6xl space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-2"><h1 className="text-xl font-bold tracking-tight sm:text-2xl">Gerenciar materiais</h1><Link to="/admin/materiais/novo" className={button + ' shrink-0 bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white'}><Plus size={17} aria-hidden="true" />Novo material</Link></header>
    <Link to="/admin/materiais/rascunhos" className={button}>Meus rascunhos</Link>
    <form role="search" aria-label="Buscar materiais do acervo" className="flex gap-2" onSubmit={e => { e.preventDefault(); update({ search: search.trim() }); }}><label htmlFor="admin-material-search" className="sr-only">Buscar por título ou descrição</label><input id="admin-material-search" type="search" maxLength={200} className={field} placeholder="Título ou descrição" value={search} disabled={action.busy} onChange={e => editSearch(e.target.value)} /><button type="submit" disabled={action.busy} className={button + ' shrink-0 whitespace-nowrap'}><Search size={17} aria-hidden="true" />Buscar</button></form>
    <div className="flex flex-wrap items-center gap-1"><button type="button" className={button} disabled={action.busy} onClick={() => setFiltersOpen(true)}><SlidersHorizontal size={17} aria-hidden="true" />Filtros{active.length ? ` (${active.length})` : ''}</button><button type="button" className={button} disabled={action.busy || !ready} aria-pressed={selecting} onClick={() => { setSelecting(v => !v); setSelection({ key: '', ids: [] }); }}>{selecting ? 'Sair da seleção' : 'Selecionar'}</button><button type="button" className={button} disabled={action.busy || result.status === 'loading'} onClick={refresh}>Atualizar</button></div>
    {filtered && <div className="flex flex-wrap items-center gap-2 text-sm"><span>{query.search ? `Busca: ${query.search}. ` : ''}{active.length ? `${active.length} ${active.length === 1 ? 'filtro aplicado' : 'filtros aplicados'}.` : ''}</span><button type="button" className={button} disabled={action.busy} onClick={() => { setSearch(''); update({ search: '', filters: Object.fromEntries(materialFilterKeys.map(key => [key, ''])) }); }}>Limpar busca e filtros</button></div>}
    {action.message && <p role="status" className="rounded-xl bg-emerald-50 p-3 text-sm text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-100">{action.message}</p>}
    {action.review?.uncertain && action.review.hidden && <div role="alert" className={surface + ' p-3'}><p className="text-sm">Há uma exclusão sem confirmação. Confira o resultado antes de excluir outros materiais.</p><button type="button" className={button} onClick={action.show}>Conferir exclusão</button></div>}
    <h2 ref={heading} tabIndex={-1} className="scroll-mt-32 text-sm font-semibold"><span role="status">{ready ? `${page.total.toLocaleString('pt-BR')} ${page.total === 1 ? 'material encontrado' : 'materiais encontrados'}${page.total ? ` · Página ${page.page} de ${page.totalPages}` : ''}` : result.status === 'error' ? 'Não foi possível consultar o acervo' : 'Buscando materiais…'}</span></h2>
    {result.status === 'error' && <div role="alert" className={surface + ' p-3'}><p className="text-sm leading-6">Sua busca foi mantida. Atualize a lista para tentar novamente; nenhum material foi removido por esta consulta.</p><button type="button" className={button} onClick={refresh}>Tentar novamente</button></div>}
    {ready && !rows.length && <section className={surface + ' p-4'}><p className="font-semibold">{filtered ? 'Nenhum material corresponde à busca.' : 'O acervo ainda não tem materiais.'}</p><p className="mt-1 text-sm leading-6">{filtered ? 'Ajuste ou limpe os filtros para consultar o restante do acervo.' : 'Use Novo material para começar o cadastro.'}</p></section>}
    {ready && rows.length > 0 && <>
      {selecting && <section aria-label="Seleção da página" className={surface + ' flex flex-wrap items-center gap-2 p-2'}><label className="flex min-h-11 items-center gap-2 px-2 text-sm"><input type="checkbox" disabled={locked} checked={selected.length === rows.length} onChange={() => setSelection({ key: queryKey, ids: selected.length === rows.length ? [] : rows.map(m => m.id) })} />Selecionar esta página</label><span className="text-sm">{selected.length} selecionado(s)</span><button type="button" className={button} disabled={!selected.length || locked} onClick={() => setSelection({ key: '', ids: [] })}>Limpar seleção</button><button type="button" className={button + ' text-red-700 dark:text-red-300'} disabled={!selected.length || locked} onClick={() => action.check([...selected], { bulk: true })}>Excluir seleção</button><p className="w-full px-2 text-xs leading-5 text-slate-600 dark:text-slate-300">A seleção vale só para esta página e é limpa ao buscar, filtrar ou atualizar.</p></section>}
      <ul aria-label="Materiais encontrados" className={surface + ' divide-y divide-slate-200 dark:divide-white/10'}>{rows.map(m => <li key={m.id} data-admin-material-row className="flex flex-col gap-2 p-3 sm:p-4 md:flex-row md:items-center md:gap-4">
        {selecting && <label className="flex min-h-11 items-center gap-2 text-sm"><input type="checkbox" checked={selected.includes(m.id)} disabled={locked} onChange={() => toggle(m.id)} aria-label={`Selecionar material ${m.title}`} /><span className="md:sr-only">Selecionar material</span></label>}
        <div className="min-w-0 flex-1"><h3 className="text-sm font-bold leading-6">{m.title}</h3><p className="mt-1 text-sm leading-5 text-slate-600 dark:text-slate-300">{[m.discipline_name, m.grade_name, m.material_type_name].filter(Boolean).join(' · ') || 'Sem classificação informada'}</p><p className="mt-1 text-xs leading-5 text-slate-500 dark:text-slate-400">Código {m.id}</p></div>
        <div className="flex shrink-0 flex-wrap gap-1"><Link to={`/material/${m.id}`} className={button} aria-label={`Visualizar material ${m.title}`}>Ver</Link><Link to={`/admin/materiais/${m.id}/habilidades`} className={button} aria-label={`Habilidades do material ${m.title}`}>Habilidades</Link><Link to={`/admin/materiais/${m.id}/editar`} className={button} aria-label={`Editar material ${m.title}`}>Editar</Link><button type="button" className={button + ' text-red-700 dark:text-red-300'} disabled={locked} onClick={() => action.check([m.id])} aria-label={`Excluir material ${m.title}`}>Excluir</button></div>
      </li>)}</ul>
      {page.totalPages > 1 && <nav aria-label="Páginas dos materiais" className="flex flex-wrap items-center justify-between gap-2"><button type="button" disabled={action.busy || query.page <= 1} className={button} onClick={() => update({ page: query.page - 1 }, true)}>Anterior</button><span className="text-sm">Página {page.page} de {page.totalPages}</span><button type="button" disabled={action.busy || query.page >= page.totalPages} className={button} onClick={() => update({ page: query.page + 1 }, true)}>Próxima</button></nav>}
    </>}
    {filtersOpen && <Filters identity={identity} current={query.filters} onClose={() => setFiltersOpen(false)} onApply={filters => { update({ filters }); setFiltersOpen(false); }} />}
    {action.review && !action.review.hidden && <AdminMaterialDeletion action={action} />}
  </div>;
}
function Filters({ identity, current, onClose, onApply }) {
  const [draft, setDraft] = useState(current);
  const disciplines = useHomeResource('/categories/disciplines', identity, parseLibraryCategories), grades = useHomeResource('/categories/grades', identity, parseLibraryCategories), types = useHomeResource('/categories/material-types', identity, parseLibraryCategories);
  const resources = { discipline_id: disciplines, grade_id: grades, material_type_id: types };
  return <AssessmentDialog title="Filtrar materiais" onClose={onClose}><form data-admin-material-filters className="space-y-3 p-3 sm:p-4" onSubmit={e => { e.preventDefault(); if (Object.values(resources).every(r => r.status === 'ready')) onApply(draft); }}>
    <p className="text-sm leading-6">Escolha os filtros e aplique à lista. Isso limpa a seleção de materiais.</p>
    {materialFilterKeys.map(key => <div key={key}><label htmlFor={'filter-' + key} className="mb-1 block text-sm font-semibold">{labels[key]}</label><select id={'filter-' + key} className={field} disabled={resources[key].status !== 'ready'} value={draft[key]} onChange={e => setDraft(v => ({ ...v, [key]: e.target.value }))}><option value="">Todos</option>{draft[key] && !resources[key].data?.some(item => String(item.id) === draft[key]) && <option value={draft[key]}>Opção atual ({draft[key]})</option>}{resources[key].data?.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select>{resources[key].status === 'loading' && <p role="status" className="text-sm">Carregando opções…</p>}{resources[key].status === 'error' && <div role="alert" className="text-sm"><p>Não foi possível consultar estas opções.</p><button type="button" className={button} onClick={resources[key].retry}>Recarregar {labels[key].toLowerCase()}</button></div>}</div>)}
    <div className="flex flex-wrap gap-2"><button type="button" className={button} onClick={onClose}>Cancelar</button><button type="button" className={button} onClick={() => setDraft(Object.fromEntries(materialFilterKeys.map(key => [key, ''])))}>Limpar filtros</button><button type="submit" className={button + ' bg-blue-700 text-white dark:text-white'} disabled={Object.values(resources).some(r => r.status !== 'ready')}>Aplicar filtros</button></div>
  </form></AssessmentDialog>;
}
