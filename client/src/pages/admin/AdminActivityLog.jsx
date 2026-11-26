import { useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import { userList } from '../../services/adminUsersView.mjs';
import { activityActions, activityModules, periods, emptyActivityFilters, activityFilterIssue, activityParams, activityList, activityTime } from '../../services/adminActivityView.mjs';
import { readPanel, readButton, readPrimary, readField, ReadState } from '../../components/admin/AdminReadParts';

export default function AdminActivityLog() {
  const { user, announcementAccessId } = useAuth(), identity = user?.id + ':' + announcementAccessId;
  return user?.role === 'admin' ? <HistoryWorkspace key={identity} identity={identity} /> : null;
}
function HistoryWorkspace({ identity }) {
  const [draft, setDraft] = useState(emptyActivityFilters), [applied, setApplied] = useState(() => ({ filters: emptyActivityFilters(), query: activityParams(emptyActivityFilters()), revision: 0 }));
  const [more, setMore] = useState(false), [error, setError] = useState(''), [location, setLocation] = useState({ page: 1, snapshot: null });
  const form = useRef(null), heading = useRef(null), shouldFocus = useRef(false);
  const users = useHomeResource(more ? '/users' : null, identity, userList);
  const parse = useMemo(() => data => activityList(data, location.page, location.snapshot), [location.page, location.snapshot]);
  const resource = useHomeResource('/activity/timeline?' + applied.query + '&page=' + location.page + (location.snapshot === null ? '' : '&snapshot_id=' + location.snapshot), identity + ':' + applied.revision, parse);
  const pendingChanges = JSON.stringify(draft) !== JSON.stringify(applied.filters);
  const rows = resource.status === 'ready' ? resource.data : null;
  useEffect(() => { if (shouldFocus.current && resource.status === 'ready') { shouldFocus.current = false; heading.current?.focus({ preventScroll: true }); heading.current?.scrollIntoView({ block: 'nearest' }); } }, [resource.status, resource.data]);
  function change(name, value) { setDraft(current => ({ ...current, [name]: value })); setError(''); if (name === 'period' && value === 'custom') setMore(true); }
  function apply(event) {
    event?.preventDefault(); const issue = activityFilterIssue(draft);
    if (issue) { setError(issue[1]); setMore(true); requestAnimationFrame(() => form.current?.elements.namedItem(issue[0])?.focus()); return; }
    setApplied(old => ({ filters: { ...draft }, query: activityParams(draft), revision: old.revision + 1 })); setLocation({ page: 1, snapshot: null }); setMore(false); shouldFocus.current = true; setError('');
  }
  function reset() { const filters = emptyActivityFilters(); setDraft(filters); setApplied(old => ({ filters, query: activityParams(filters), revision: old.revision + 1 })); setLocation({ page: 1, snapshot: null }); setMore(false); setError(''); shouldFocus.current = true; }
  function refresh() { setApplied(old => ({ ...old, query: activityParams(old.filters), revision: old.revision + 1 })); setLocation({ page: 1, snapshot: null }); shouldFocus.current = true; }
  function page(value) { if (!rows) return; setLocation({ page: value, snapshot: rows.snapshot_id }); shouldFocus.current = true; }
  return <div data-admin-read style={{ maxWidth: '64rem' }} className="mx-auto space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-2"><h1 className="text-xl font-bold sm:text-2xl">Histórico de ações</h1><button type="button" className={readButton + ' shrink-0'} disabled={resource.status === 'loading'} onClick={refresh}>Atualizar</button></header>
    <p className="text-sm leading-6">Veja quem fez cada ação e quando.</p>
    <form ref={form} onSubmit={apply} noValidate className="space-y-2">
      <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
        <label className="sr-only" htmlFor="history-search">Buscar pessoa ou registro</label><input id="history-search" name="search" className={readField} value={draft.search} maxLength={200} placeholder="Buscar pessoa ou registro" onChange={e => change('search', e.target.value)} />
        <div className="flex gap-2 sm:contents"><label className="sr-only" htmlFor="history-period">Período</label><select id="history-period" name="period" className={readField} value={draft.period} onChange={e => change('period', e.target.value)}>{Object.entries(periods).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select><button type="submit" className={readPrimary + ' shrink-0'}>Buscar</button></div>
      </div>
      <div className="flex flex-wrap items-center gap-1"><button type="button" className={readButton} aria-expanded={more} aria-controls="history-filters" onClick={() => setMore(s => !s)}>{more ? 'Ocultar filtros' : 'Mais filtros'}</button><button type="button" className={readButton} onClick={reset}>Limpar filtros</button></div>
      {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800 dark:bg-red-500/10 dark:text-red-200">{error}</p>}
      {more && <div id="history-filters" className={readPanel + ' grid gap-3 p-3 sm:grid-cols-2 lg:grid-cols-3'}>
        {draft.period === 'custom' && <><Filter label="Data inicial" name="date_from" type="date" value={draft.date_from} onChange={change} /><Filter label="Data final" name="date_to" type="date" value={draft.date_to} onChange={change} /></>}
        <Filter label="Área do sistema" name="module" options={activityModules} value={draft.module} onChange={change} />
        <Filter label="Ação registrada" name="action" options={activityActions} value={draft.action} onChange={change} />
        <Filter label="Perfil na época da ação" name="user_role" options={{ professor: 'Professor(a)', admin: 'Administrador(a)' }} value={draft.user_role} onChange={change} />
        <div><Filter label="Pessoa" name="user_id" options={users.status === 'ready' ? Object.fromEntries(users.data.map(u => [u.id, u.name + ' · ' + u.email])) : { ...(draft.user_id ? { [draft.user_id]: 'Pessoa selecionada' } : {}) }} value={draft.user_id} onChange={change} disabled={users.status !== 'ready'} />{users.status === 'loading' && <p role="status" className="text-xs">Carregando pessoas…</p>}{users.status === 'error' && <div role="alert" className="text-xs leading-5">Não foi possível listar as pessoas. Os outros filtros continuam disponíveis.<button type="button" className={readButton} onClick={users.retry}>Recarregar pessoas</button></div>}</div>
        <label className="flex min-h-11 items-center gap-2 text-sm leading-6"><input name="critical_only" type="checkbox" className="h-5 w-5 shrink-0" checked={draft.critical_only} onChange={e => change('critical_only', e.target.checked)} />Somente ações marcadas como sensíveis</label>
        <p className="text-xs leading-5 text-slate-600 dark:text-slate-300 sm:col-span-2 lg:col-span-3">“Sensível” é uma marca do registro, como exclusão ou troca de senha; não significa que houve um problema. Para pessoas removidas, busque pelo nome registrado.</p>
      </div>}
      {pendingChanges && <p role="status" className="text-xs leading-5">Filtros alterados. Use Buscar para aplicá-los à lista.</p>}
    </form>
    <section aria-label="Registros encontrados" className="space-y-2">
      <h2 ref={heading} tabIndex={-1} className="text-sm font-semibold">{rows ? rows.pagination.total.toLocaleString('pt-BR') + ' registros · ' : 'Registros · '}{periods[applied.filters.period]}</h2>
      {(applied.filters.search || applied.filters.module || applied.filters.action || applied.filters.user_id || applied.filters.user_role || applied.filters.critical_only || applied.filters.period === 'custom') && <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Filtros aplicados: {[applied.filters.search && '“' + applied.filters.search + '”', applied.filters.module && (activityModules[applied.filters.module] || 'Área selecionada'), applied.filters.action && (activityActions[applied.filters.action] || 'Ação selecionada'), applied.filters.user_id && 'Pessoa selecionada', applied.filters.user_role && (applied.filters.user_role === 'admin' ? 'Administrador(a)' : 'Professor(a)'), applied.filters.critical_only && 'Sensíveis', applied.filters.period === 'custom' && applied.filters.date_from.split('-').reverse().join('/') + ' a ' + applied.filters.date_to.split('-').reverse().join('/')].filter(Boolean).join(' · ')}</p>}
      <ReadState resource={resource}>{data => <>
        {!data.data.length ? <p className={readPanel + ' p-3 text-sm leading-6'}>Nenhum registro nesta consulta. Você pode mudar o período ou limpar os filtros.</p> : <ol aria-label="Histórico" className={readPanel + ' divide-y divide-slate-200 dark:divide-white/10'}>{data.data.map(item => <HistoryItem key={item.id} item={item} />)}</ol>}
        <nav aria-label="Páginas do histórico" className="flex flex-wrap items-center justify-between gap-1"><button type="button" className={readButton} disabled={location.page <= 1} onClick={() => page(location.page - 1)}>Anterior</button><p className="text-xs">Página {data.pagination.page} de {data.pagination.totalPages}</p><button type="button" className={readButton} disabled={location.page >= data.pagination.totalPages} onClick={() => page(location.page + 1)}>Próxima</button></nav>
        <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Mais recentes primeiro. Novos registros aparecem ao atualizar. Horários neste dispositivo.</p>
      </>}</ReadState>
    </section>
  </div>;
}
function Filter({ label, name, value, options, type, onChange, disabled }) {
  return <div><label htmlFor={'history-' + name} className="mb-1 block text-sm font-semibold">{label}</label>{options ? <select id={'history-' + name} name={name} className={readField} value={value} disabled={disabled} onChange={e => onChange(name, e.target.value)}><option value="">Todas as opções</option>{Object.entries(options).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select> : <input id={'history-' + name} name={name} type={type} className={readField} value={value} onChange={e => onChange(name, e.target.value)} />}</div>;
}
function HistoryItem({ item }) {
  const [details, setDetails] = useState(false);
  return <li className="space-y-1 p-3">
    <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs leading-5 text-slate-600 dark:text-slate-300"><p>{activityActions[item.action] || 'Ação registrada'}{Boolean(item.is_critical) && <span className="ml-2 rounded bg-amber-100 px-2 py-1 font-semibold text-amber-900 dark:bg-amber-500/15 dark:text-amber-200">Sensível</span>}</p><time>{activityTime(item.created_at)}</time></div>
    <h3 className="text-sm font-semibold leading-6">{item.description || item.entity_title || 'Registro sem descrição detalhada.'}</h3>
    <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">{item.user_name || 'Pessoa não identificada'} · {activityModules[item.module] || 'Outra área do sistema'}</p>
    <button type="button" className={readButton} aria-expanded={details} aria-controls={'history-item-' + item.id} onClick={() => setDetails(s => !s)}>{details ? 'Ocultar detalhes' : 'Ver detalhes'}</button>
    {details && <div id={'history-item-' + item.id} className="space-y-2 rounded-xl bg-slate-50 p-3 text-sm leading-6 dark:bg-white/5"><dl className="space-y-2"><div><dt className="font-semibold">Item relacionado</dt><dd>{item.entity_title || 'Não informado'}</dd></div><div><dt className="font-semibold">Perfil registrado</dt><dd>{item.user_role === 'admin' ? 'Administrador(a)' : item.user_role === 'professor' ? 'Professor(a)' : 'Não informado'}</dd></div>{item.user_email && <div><dt className="font-semibold">E-mail atual da conta</dt><dd>{item.user_email}</dd></div>}</dl><details><summary className="min-h-11 cursor-pointer py-3 font-semibold text-blue-700 dark:text-cyan-200">Informações para suporte</summary><p className="text-xs">Registro {item.id} · Código da ação: {item.action}</p>{item.metadata && <pre className="mt-2 whitespace-pre-wrap break-words text-xs leading-5">{JSON.stringify(item.metadata, null, 2)}</pre>}</details></div>}
  </li>;
}
