import { useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import useAccountLeave from '../../hooks/useAccountLeave';
import ModalLayer from '../../components/ModalLayer';
import api from '../../services/api';
import { categoryAreas, categoryIcons, categoryArea, categoryItem, categoryList, categoryDetail, categorySearch, categoryDraft, categoryIssue, categoryPayload } from '../../services/adminCategoriesView.mjs';

const panel = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
const primary = button + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100';

export default function AdminCategories() {
  const { user, announcementAccessId } = useAuth(), [params, setParams] = useSearchParams();
  const kind = categoryArea(params.get('area')), identity = user?.id + ':' + announcementAccessId;
  return user?.role === 'admin' ? <CategoryWorkspace key={identity + ':' + kind} identity={identity} kind={kind} onArea={area => setParams({ area })} /> : null;
}
function CategoryWorkspace({ identity, kind, onArea }) {
  const parse = useMemo(() => data => categoryList(data, kind), [kind]);
  const list = useHomeResource('/categories/management/' + kind, identity, parse);
  const [search, setSearch] = useState(''), [limit, setLimit] = useState(20), [target, setTarget] = useState(null);
  const title = useRef(null), locked = Boolean(target);
  const results = list.status === 'ready' ? categorySearch(list.data, search) : [];
  function close() { setTarget(null); requestAnimationFrame(() => title.current?.focus({ preventScroll: true })); }
  return <div data-admin-categories className="mx-auto max-w-4xl space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-3"><h1 ref={title} tabIndex={-1} className="text-xl font-bold sm:text-2xl">Categorias</h1><button type="button" className={primary} disabled={locked || list.status !== 'ready'} onClick={() => setTarget({ mode: 'create' })}>Adicionar</button></header>
    <p className="text-sm leading-6">Organize os nomes usados nos materiais e nas turmas.</p>
    <div className="grid gap-3 sm:grid-cols-2 sm:items-end"><div><label className="mb-1 block text-sm font-semibold" htmlFor="category-area">Organizar</label><select id="category-area" className={field} value={kind} disabled={locked} onChange={e => onArea(e.target.value)}>{Object.entries(categoryAreas).map(([key, area]) => <option key={key} value={key}>{area.label}</option>)}</select></div>
    <div className="flex gap-2"><label className="sr-only" htmlFor="category-search">Buscar pelo nome</label><input id="category-search" type="search" className={field} placeholder="Buscar pelo nome" value={search} disabled={locked || list.status !== 'ready'} onChange={e => { setSearch(e.target.value); setLimit(20); }} /><button type="button" className={button + ' shrink-0 whitespace-nowrap'} disabled={locked || list.status === 'loading'} onClick={list.retry}>Atualizar</button></div>
    </div>
    {list.status === 'loading' && <p role="status" className="text-sm">Carregando {categoryAreas[kind].label.toLocaleLowerCase('pt-BR')}…</p>}
    {list.status === 'error' && <section role="alert" className={panel + ' p-3 text-sm leading-6'}><p>Não foi possível consultar esta lista. Nenhuma categoria foi removida.</p><button type="button" className={button} onClick={list.retry}>Tentar novamente</button></section>}
    {list.status === 'ready' && <>
      <p role="status" className="text-xs text-slate-600 dark:text-slate-300">{results.length} de {list.data.length} {categoryAreas[kind].label.toLocaleLowerCase('pt-BR')}{search && <button type="button" className={button + ' ml-1'} disabled={locked} onClick={() => { setSearch(''); setLimit(20); }}>Limpar busca</button>}</p>
      {!results.length ? <p className={panel + ' p-4 text-sm leading-6'}>{list.data.length ? 'Nenhum nome corresponde à busca.' : 'Nenhum cadastro nesta área. Use Adicionar para começar.'}</p> :
        <ul aria-label={categoryAreas[kind].label} className={panel + ' divide-y divide-slate-200 dark:divide-white/10'}>{results.slice(0, limit).map(item => <li key={item.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:gap-3">
          <div className="min-w-0 flex-1"><h2 className="text-sm font-bold leading-6">{item.name}</h2><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">{item.material_count} {item.material_count === 1 ? 'material' : 'materiais'}{item.other_usage_count > 0 ? ' · Usada em outras partes do sistema' : ''}{kind === 'grades' ? ' · Ordem ' + (item.sort_order ?? 0) : ''}</p></div>
          <div className="flex shrink-0 gap-1"><button type="button" className={button} disabled={locked} aria-label={'Editar ' + item.name} onClick={() => setTarget({ mode: 'edit', id: item.id })}>Editar</button><button type="button" className={button + ' text-red-700 dark:text-red-300'} disabled={locked} aria-label={'Excluir ' + item.name} onClick={() => setTarget({ mode: 'delete', id: item.id })}>Excluir</button></div>
        </li>)}</ul>}
      {results.length > limit && <button type="button" className={button} disabled={locked} onClick={() => setLimit(n => n + 20)}>Mostrar mais ({results.length - limit})</button>}
    </>}
    {target && <CategoryDialog key={target.revision || 0} identity={identity} kind={kind} target={target} onClose={close} onChanged={list.retry} onReload={() => setTarget(current => ({ ...current, revision: (current.revision || 0) + 1 }))} />}
  </div>;
}
function CategoryDialog({ identity, kind, target, onClose, onChanged, onReload }) {
  const { mode, id } = target, area = categoryAreas[kind], creating = mode === 'create', deleting = mode === 'delete';
  const title = (creating ? 'Adicionar ' : deleting ? 'Excluir ' : 'Editar ') + area.singular;
  const parse = useMemo(() => data => categoryDetail(data, kind, id), [kind, id]);
  const resource = useHomeResource(creating ? null : '/categories/management/' + kind + '/' + id, identity, parse);
  const item = creating ? null : resource.data, ready = creating || resource.status === 'ready';
  const [form, setForm] = useState(creating ? categoryDraft(null) : null), [consent, setConsent] = useState(false);
  const [status, setStatus] = useState('idle'), [message, setMessage] = useState(''), [hidden, setHidden] = useState(false), [checked, setChecked] = useState(false);
  const pending = useRef(false), alive = useRef(false), reading = useRef(null), alert = useRef(null), name = useRef(null), dialogForm = useRef(null), sent = useRef(null), invalid = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reading.current?.abort(); }; }, []);
  useEffect(() => { if (!creating && resource.status === 'ready' && !form) setForm(categoryDraft(resource.data)); }, [creating, resource.status, resource.data, form]);
  useEffect(() => { if (form && !deleting) name.current?.focus(); }, [Boolean(form), deleting]);
  useEffect(() => { if (message) { if (invalid.current) dialogForm.current?.elements.namedItem(invalid.current)?.focus(); else { alert.current?.focus({ preventScroll: true }); alert.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }); } } }, [message, hidden]);
  const busy = status === 'saving', uncertain = ['uncertain', 'checking'].includes(status), frozen = busy || uncertain || status === 'conflict';
  const dirty = status !== 'success' && Boolean(form) && !deleting && JSON.stringify(form) !== JSON.stringify(categoryDraft(item));
  useAccountLeave(dirty || uncertain, () => pending.current);
  function close() {
    if (pending.current) return;
    if (uncertain) { setHidden(true); return; }
    if (dirty && !window.confirm('Há alterações não salvas. Fechar sem salvá-las?')) return;
    onClose();
  }
  function reload() {
    if (dirty && !window.confirm('Carregar a versão atual descarta as alterações deste formulário. Continuar?')) return;
    onReload();
  }
  async function save(event) {
    event.preventDefault(); if (pending.current || frozen || !ready || !form || (deleting && (!consent || item.material_count || item.other_usage_count))) return;
    if (!deleting) {
      const issue = categoryIssue(form, kind);
      if (issue) { invalid.current = issue[0]; setMessage(issue[1]); dialogForm.current.elements.namedItem(issue[0])?.focus(); return; }
    }
    const payload = deleting ? { expectedVersion: item.version } : categoryPayload(form, kind, item);
    invalid.current = null; pending.current = true; sent.current = { ...payload }; setStatus('saving'); setMessage('Conferindo e salvando…');
    try {
      const response = await api.request({ method: deleting ? 'DELETE' : creating ? 'POST' : 'PUT', url: '/categories/' + kind + (creating ? '' : '/' + id), data: payload, timeout: 20000 });
      if (deleting) { if (response.data?.deleted !== id) throw Error('Exclusão não confirmada.'); }
      else { const saved = categoryItem(response.data, kind); if ((!creating && saved.id !== id) || saved.name !== payload.name || (kind === 'grades' && saved.sort_order !== payload.sort_order) || (kind === 'material-types' && saved.icon !== payload.icon)) throw Error('Gravação não confirmada.'); }
      if (!alive.current) return;
      setStatus('success'); setMessage(deleting ? 'Categoria excluída. Nenhum vínculo foi removido.' : 'Categoria salva.'); onChanged();
    } catch (error) {
      if (!alive.current) return;
      const code = error.response?.data?.code, http = error.response?.status;
      setStatus(!http || http >= 500 ? 'uncertain' : ['category_changed', 'category_missing', 'category_in_use'].includes(code) ? 'conflict' : 'error');
      setMessage(!http || http >= 500 ? 'Não foi possível confirmar o resultado. Não repita o envio; confira a lista atual.' : error.response?.data?.error || 'Não foi possível salvar. Confira os dados e seu acesso.');
    } finally { pending.current = false; }
  }
  async function check() {
    if (pending.current || !uncertain) return;
    reading.current?.abort(); const controller = new AbortController(); reading.current = controller; setStatus('checking');
    try {
      const response = await api.get('/categories/management/' + kind, { signal: controller.signal, timeout: 15000 });
      const rows = categoryList(response.data, kind);
      if (!alive.current || controller.signal.aborted) return;
      const current = creating ? rows.find(row => row.name === sent.current?.name) : rows.find(row => row.id === id);
      setMessage((current ? 'A categoria está na lista atual: ' + current.name + '.' : 'A categoria não consta na lista atual.') + ' Esta consulta não confirma quem fez a alteração nem se o envio terminou. Antes de outra operação, confira a lista.');
      setChecked(true); setStatus('uncertain'); onChanged();
    } catch { if (alive.current && !controller.signal.aborted) { setStatus('uncertain'); setMessage('Não foi possível consultar a lista. Nenhum novo envio foi feito. Tente conferir novamente.'); } }
  }
  if (hidden) return <section role="alert" className={panel + ' p-3 text-sm leading-6'}><p>Há uma operação sem confirmação. Confira antes de continuar.</p><button type="button" className={button} onClick={() => setHidden(false)}>Conferir operação</button></section>;
  return <ModalLayer label={title} closeDisabled={busy} onClose={close} onClick={close} className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-3">
    <section data-admin-categories className={panel + ' w-full max-w-lg space-y-3 p-3 text-slate-900 sm:p-4 dark:text-slate-100'}>
      <header className="flex items-start justify-between gap-2"><h2 className="pt-2 text-lg font-bold">{title}</h2><button type="button" className={button + ' shrink-0'} disabled={busy} onClick={close}>Fechar</button></header>
      {message && <div ref={alert} tabIndex={-1} role={busy || status === 'checking' || status === 'success' ? 'status' : 'alert'} className="rounded-xl border border-slate-200 p-3 text-sm leading-6 dark:border-white/20">{message}</div>}
      {status === 'success' ? <button type="button" className={primary} onClick={onClose}>Voltar à lista</button> : uncertain ? <>
        <p className="text-sm leading-6">O rascunho fica somente nesta página. Recarregar ou sair pode perder estas informações.</p>
        <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={status === 'checking'} onClick={check}>Conferir lista atual</button>{checked && <button type="button" className={button} onClick={onClose}>Entendi, voltar à lista</button>}</div>
      </> : !ready || !form ? <div className="text-sm leading-6">{resource.status === 'error' ? <div role="alert"><p>Não foi possível conferir esta categoria. Nenhuma alteração será enviada.</p><button type="button" className={button} onClick={resource.retry}>Tentar carregar novamente</button></div> : <p role="status">Carregando a categoria atual…</p>}</div> :
        <form ref={dialogForm} noValidate onSubmit={save} className="space-y-3" aria-label="Dados da categoria">
          <fieldset disabled={frozen} className="min-w-0 space-y-3">
            {deleting ? <>
              <p className="break-words text-sm font-bold">{item.name}</p>
              {item.material_count || item.other_usage_count ? <div className="text-sm leading-6"><p>Esta categoria está em uso e será mantida.</p><p>Materiais: {item.material_count} · Outros usos: {item.other_usage_count}.</p><p>Isso pode incluir turmas, preferências, habilidades BNCC ou planos de aula. Nenhum desses vínculos será apagado.</p></div> :
                <><p className="text-sm leading-6">Não encontramos vínculos com esta categoria no banco atual. A exclusão será conferida novamente ao enviar.</p><label className="flex min-h-11 items-center gap-3 text-sm leading-6"><input type="checkbox" checked={consent} onChange={e => setConsent(e.target.checked)} />Quero excluir esta categoria.</label></>}
            </> : <>
              <div><label htmlFor="category-name" className="mb-1 block text-sm font-semibold">Nome</label><input ref={name} id="category-name" name="category-name" className={field} maxLength={200} value={form.name} placeholder={area.example} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} /></div>
              {kind === 'grades' && <div><label htmlFor="category-order" className="mb-1 block text-sm font-semibold">Ordem na lista</label><input id="category-order" name="category-order" type="number" min="0" max="9999" step="1" className={field} value={form.sort_order} onChange={e => setForm(f => ({ ...f, sort_order: e.target.value }))} /><p className="mt-1 text-xs leading-5">Números menores aparecem primeiro. Ex.: 6 antes de 7.</p></div>}
              {kind === 'material-types' && <div><label htmlFor="category-icon" className="mb-1 block text-sm font-semibold">Ícone</label><select id="category-icon" className={field} value={form.icon} onChange={e => setForm(f => ({ ...f, icon: e.target.value }))}>{!Object.hasOwn(categoryIcons, form.icon) && <option value={form.icon}>Ícone atual ({form.icon})</option>}{Object.entries(categoryIcons).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select><p className="mt-1 text-xs leading-5">Muda apenas a identificação visual, não o arquivo do material.</p></div>}
              {!creating && <p className="text-sm leading-6">Mudar o nome também muda como esta categoria aparece onde já é usada. Os vínculos serão mantidos.</p>}
            </>}
          </fieldset>
          <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={busy} onClick={close}>Cancelar</button>{status === 'conflict' ? <button type="button" className={button} onClick={reload}>Carregar versão atual</button> : (!deleting || (!item.material_count && !item.other_usage_count)) && <button type="submit" className={deleting ? primary + ' bg-red-700 hover:bg-red-800 dark:bg-red-700' : primary} disabled={frozen || (deleting && !consent)}>{busy ? 'Salvando…' : deleting ? 'Excluir categoria' : 'Salvar categoria'}</button>}</div>
        </form>}
    </section>
  </ModalLayer>;
}
