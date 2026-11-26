import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import useAccountLeave from '../../hooks/useAccountLeave';
import ModalLayer from '../../components/ModalLayer';
import TeacherAccessDialog from '../../components/admin/TeacherAccessDialog';
import api from '../../services/api';
import { userRoles, userItem, userList, userDetail, filterUsers, userDraft, userIssue, userPayload } from '../../services/adminUsersView.mjs';

const panel = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
const primary = button + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white';
const field = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100';

export default function AdminUsers() {
  const { user, announcementAccessId } = useAuth();
  const identity = user?.id + ':' + announcementAccessId;
  return user?.role === 'admin' ? <UsersWorkspace key={identity} identity={identity} actorId={user.id} /> : null;
}
function UsersWorkspace({ identity, actorId }) {
  const list = useHomeResource('/users', identity, userList);
  const [search, setSearch] = useState(''), [role, setRole] = useState(''), [limit, setLimit] = useState(20), [target, setTarget] = useState(null);
  const title = useRef(null), locked = Boolean(target);
  const accessTrigger = useRef(null);
  function closeAccess() { setTarget(null); requestAnimationFrame(() => accessTrigger.current?.focus({ preventScroll: true })); }
  const results = list.status === 'ready' ? filterUsers(list.data, search, role) : [];
  function close() { setTarget(null); requestAnimationFrame(() => title.current?.focus({ preventScroll: true })); }
  function clear() { setSearch(''); setRole(''); setLimit(20); }
  return <div data-admin-users style={{ maxWidth: '64rem' }} className="mx-auto space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex items-center justify-between gap-3"><h1 ref={title} tabIndex={-1} className="text-xl font-bold sm:text-2xl">Usuários e acessos</h1><button type="button" className={primary + ' shrink-0'} disabled={locked || list.status !== 'ready'} onClick={() => setTarget({ mode: 'create' })}>Criar conta</button></header>
    <p className="text-sm">Encontre uma pessoa para revisar seu acesso.</p>
    {target?.mode === 'access' ? <TeacherAccessDialog key={target.id} id={target.id} identity={identity} onClose={closeAccess} /> : target && <UserDialog key={target.revision || 0} identity={identity} target={target} onClose={close} onChanged={list.retry} onReload={() => setTarget(t => ({ ...t, revision: (t.revision || 0) + 1 }))} />}
    <div className="grid gap-2 sm:grid-cols-[1fr_12rem_auto]">
      <label className="sr-only" htmlFor="users-search">Buscar por nome ou e-mail</label><input id="users-search" type="search" className={field} placeholder="Buscar por nome ou e-mail" value={search} disabled={locked || list.status !== 'ready'} onChange={e => { setSearch(e.target.value); setLimit(20); }} />
      <div className="flex gap-2 sm:contents"><label className="sr-only" htmlFor="users-role">Filtrar por perfil</label><select id="users-role" className={field} value={role} disabled={locked || list.status !== 'ready'} onChange={e => { setRole(e.target.value); setLimit(20); }}><option value="">Todos os perfis</option>{Object.entries(userRoles).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select><button type="button" className={button + ' shrink-0 whitespace-nowrap'} disabled={locked || list.status === 'loading'} onClick={list.retry}>Atualizar</button></div>
    </div>
    {list.status === 'loading' && <p role="status" className="text-sm">Carregando contas…</p>}
    {list.status === 'error' && <section role="alert" className={panel + ' p-3 text-sm'}><p>Não foi possível consultar as contas. A lista não está disponível agora.</p><button type="button" className={button} onClick={list.retry}>Tentar novamente</button></section>}
    {list.status === 'ready' && <>
      <p role="status" className="text-xs text-slate-600 dark:text-slate-300">{results.length} de {list.data.length} contas{(search || role) && <button type="button" className={button + ' ml-1'} disabled={locked} onClick={clear}>Limpar filtros</button>}</p>
      {!results.length ? <p className={panel + ' p-4 text-sm'}>{list.data.length ? 'Nenhuma conta corresponde aos filtros.' : 'Nenhuma conta encontrada nesta consulta.'}</p> : <ul aria-label="Contas cadastradas" className={panel + ' divide-y divide-slate-200 dark:divide-white/10'}>{results.slice(0, limit).map(item => <li key={item.id} className="flex flex-col gap-1 p-3 sm:flex-row sm:items-center sm:gap-3">
        <div className="min-w-0 flex-1"><h2 className="text-sm font-bold leading-6">{item.name}{item.id === actorId ? ' (você)' : ''}</h2><p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{item.email}</p><p className="text-xs leading-5 text-slate-600 dark:text-slate-300">{userRoles[item.role]}</p></div>
        <div className="flex shrink-0 flex-wrap gap-1">{item.id === actorId ? <Link className={button} to="/perfil">Minha conta</Link> : <>
          {item.role === 'professor' && <button type="button" className={button} disabled={locked} aria-label={'Conferir acesso de ' + item.name} onClick={event => { accessTrigger.current = event.currentTarget; setTarget({ mode: 'access', id: item.id }); }}>Conferir acesso</button>}
          <button type="button" className={button} disabled={locked} aria-label={'Editar ' + item.name} onClick={() => setTarget({ mode: 'edit', id: item.id })}>Editar</button>
          <button type="button" className={button} disabled={locked} aria-label={'Redefinir senha de ' + item.name} onClick={() => setTarget({ mode: 'reset', id: item.id })}>Senha</button>
          <button type="button" className={button + ' text-red-700 dark:text-red-300'} disabled={locked} aria-label={'Excluir ' + item.name} onClick={() => setTarget({ mode: 'delete', id: item.id })}>Excluir</button>
        </>}</div>
      </li>)}</ul>}
      {results.length > limit && <button type="button" className={button} disabled={locked} onClick={() => setLimit(n => n + 20)}>Mostrar mais ({results.length - limit})</button>}
    </>}
  </div>;
}

function UserDialog({ identity, target, onClose, onChanged, onReload }) {
  const { mode, id } = target, creating = mode === 'create', deleting = mode === 'delete', resetting = mode === 'reset';
  const title = { create: 'Criar conta', edit: 'Editar conta', reset: 'Redefinir senha', delete: 'Excluir conta' }[mode];
  const parse = useMemo(() => data => userDetail(data, id), [id]);
  const resource = useHomeResource(creating ? null : '/users/' + id, identity, parse);
  const item = creating ? null : resource.data, ready = creating || resource.status === 'ready';
  const [form, setForm] = useState(creating ? userDraft(null) : null), [consent, setConsent] = useState(false), [showPassword, setShowPassword] = useState(false);
  const [status, setStatus] = useState('idle'), [message, setMessage] = useState(''), [hidden, setHidden] = useState(false), [checked, setChecked] = useState(false);
  const pending = useRef(false), alive = useRef(false), reading = useRef(null), alert = useRef(null), formRef = useRef(null), first = useRef(null), invalid = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reading.current?.abort(); }; }, []);
  useEffect(() => { if (!creating && resource.status === 'ready' && !form) setForm(userDraft(resource.data)); }, [creating, resource.status, resource.data, form]);
  useEffect(() => { if (form) first.current?.focus(); }, [Boolean(form)]);
  useEffect(() => { if (message) { if (invalid.current) formRef.current?.elements.namedItem(invalid.current)?.focus(); else { alert.current?.focus({ preventScroll: true }); alert.current?.scrollIntoView({ block: 'nearest' }); } } }, [message, hidden]);
  const busy = status === 'saving', uncertain = ['uncertain', 'checking'].includes(status), terminal = ['success', 'conflict'].includes(status);
  const dirty = status !== 'success' && Boolean(form) && !deleting && JSON.stringify(form) !== JSON.stringify(userDraft(item));
  const needsConsent = deleting || resetting || (form && form.role !== item?.role && (form.role === 'admin' || !creating));
  useAccountLeave(dirty || uncertain, () => pending.current);
  function close() {
    if (pending.current) return;
    if (uncertain) { setHidden(true); return; }
    if (dirty && !window.confirm('Há alterações não salvas. Fechar sem salvá-las?')) return;
    onClose();
  }
  function reload() { if (form && !window.confirm('Carregar os dados atuais descarta o formulário. Continuar?')) return; onReload(); }
  function change(name, value) { setForm(f => ({ ...f, [name]: value })); if (name === 'role') setConsent(false); }
  async function save(event) {
    event.preventDefault();
    if (pending.current || uncertain || terminal || !ready || !form || (deleting && item.deletion_block)) return;
    const issue = deleting ? null : userIssue(form, mode);
    if (issue) { invalid.current = issue[0]; setMessage(issue[1]); formRef.current.elements.namedItem(issue[0])?.focus(); return; }
    if (needsConsent && !consent) { invalid.current = 'consent'; setMessage('Confirme que deseja fazer esta alteração.'); formRef.current.elements.namedItem('consent')?.focus(); return; }
    const payload = userPayload(form, mode, item);
    pending.current = true; invalid.current = null; setStatus('saving'); setMessage('Conferindo e salvando…');
    try {
      const response = await api.request({ method: deleting ? 'DELETE' : creating ? 'POST' : 'PUT', url: '/users' + (creating ? '' : '/' + id) + (resetting ? '/reset-password' : ''), data: payload, timeout: 20000 });
      if (deleting) { if (response.data?.deleted !== id) throw Error('Exclusão não confirmada'); }
      else {
        const saved = userItem(resetting ? response.data?.user : response.data);
        if ((!creating && saved.id !== id) || (!resetting && ['name', 'email', 'role'].some(k => saved[k] !== payload[k]))) throw Error('Resultado não confirmado');
      }
      if (!alive.current) return;
      setStatus('success'); setMessage(deleting ? 'Conta excluída. Nenhum dado vinculado foi removido.' : resetting ? 'Senha redefinida. Os acessos anteriores dessa conta foram encerrados.' : 'Conta salva.'); onChanged();
    } catch (error) {
      if (!alive.current) return;
      const http = error.response?.status, conflict = ['USER_CHANGED', 'USER_MISSING', 'USER_LINKED', 'ROLE_LINKED', 'ACCOUNT_CHANGED'].includes(error.response?.data?.code);
      setStatus(!http || http >= 500 ? 'uncertain' : conflict ? 'conflict' : 'error');
      setMessage(!http || http >= 500 ? 'Não foi possível confirmar o resultado. Não repita o envio. Confira a conta antes de continuar.' : error.response?.data?.error || 'Não foi possível salvar. Confira os dados e seu acesso.');
    } finally {
      // Passwords live only in this form/request; clear on every attempted submission.
      if (alive.current) { setForm(f => ({ ...f, password: '' })); setShowPassword(false); }
      pending.current = false;
    }
  }
  async function check() {
    if (pending.current || !uncertain) return;
    pending.current = true; setStatus('checking'); reading.current = new AbortController();
    try {
      const data = userList((await api.get('/users', { signal: reading.current.signal, timeout: 15000 })).data);
      const current = data.find(u => creating ? u.email === form.email.trim().toLowerCase() : u.id === id);
      if (!alive.current) return;
      setChecked(true); setMessage((current ? 'A conta aparece na consulta atual.' : 'A conta não aparece na consulta atual.') + ' Isso não confirma o resultado do envio nem uma troca de senha. Uma solicitação ainda em andamento pode terminar depois. Não repita a operação sem verificar.');
    } catch { if (alive.current) { setChecked(false); setMessage('Não foi possível conferir a conta. Tente apenas a consulta novamente; o envio não será repetido.'); } }
    finally { if (alive.current) setStatus('uncertain'); pending.current = false; }
  }
  if (hidden) return <section ref={alert} tabIndex={-1} role="alert" className={panel + ' p-3 text-sm'}><p>Há uma alteração de conta com resultado não confirmado.</p><button type="button" className={button} onClick={() => setHidden(false)}>Reabrir conferência</button></section>;
  return <ModalLayer label={title} closeDisabled={busy || status === 'checking'} onClose={close} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm">
    <section data-admin-users className={panel + ' w-full max-w-lg p-4 text-slate-900 dark:text-slate-100'}>
      <header className="mb-3 flex items-center justify-between gap-2"><h2 className="text-lg font-bold">{title}</h2><button type="button" className={button} disabled={busy || status === 'checking'} onClick={close}>Fechar</button></header>
      {!creating && !ready && <div className="text-sm leading-6"><p role={resource.status === 'error' ? 'alert' : 'status'}>{resource.status === 'error' ? 'Não foi possível conferir esta conta. O formulário não foi liberado.' : 'Conferindo os dados atuais…'}</p>{resource.status === 'error' && <button type="button" className={button} onClick={resource.retry}>Tentar carregar novamente</button>}</div>}
      {item && <div className="mb-3 text-sm leading-6"><p className="font-semibold">{item.name}</p><p className="text-slate-600 dark:text-slate-300">{item.email}</p></div>}
      {message && <p ref={alert} tabIndex={-1} role={status === 'success' || busy ? 'status' : 'alert'} className="mb-3 rounded-xl bg-slate-100 p-3 text-sm leading-6 dark:bg-white/5">{message}</p>}
      {uncertain && <div className="flex flex-wrap gap-2"><button type="button" className={button} disabled={status === 'checking'} onClick={check}>{status === 'checking' ? 'Conferindo…' : 'Consultar conta'}</button>{checked && <button type="button" className={button} onClick={() => { onChanged(); onClose(); }}>Entendi, voltar à lista</button>}</div>}
      {status === 'success' && <button type="button" className={primary} onClick={onClose}>Voltar à lista</button>}
      {status === 'conflict' && <button type="button" className={button} onClick={reload}>Conferir dados atuais</button>}
      {ready && form && !uncertain && !terminal && <form ref={formRef} noValidate onSubmit={save} className="space-y-3">
        {deleting ? <p className="text-sm leading-6">{item.deletion_block || 'Esta ação apaga a conta e remove seu acesso. Não há vínculos que impeçam a exclusão nesta consulta; o sistema conferirá novamente antes de excluir.'}</p> : <>
          {!resetting && <>
            <div><label htmlFor="user-name" className="mb-1 block text-sm font-semibold">Nome completo</label><input ref={first} id="user-name" name="name" className={field} value={form.name} maxLength={100} disabled={busy} autoComplete="off" onChange={e => change('name', e.target.value)} /></div>
            <div><label htmlFor="user-email" className="mb-1 block text-sm font-semibold">E-mail de acesso</label><input id="user-email" name="email" type="email" className={field} value={form.email} maxLength={254} disabled={busy} autoComplete="off" onChange={e => change('email', e.target.value)} /></div>
            <div><label htmlFor="user-role" className="mb-1 block text-sm font-semibold">Perfil de acesso</label><select id="user-role" name="role" className={field} value={form.role} disabled={busy || Boolean(item?.role_change_block)} onChange={e => change('role', e.target.value)}>{Object.entries(userRoles).map(([key, text]) => <option key={key} value={key}>{text}</option>)}</select><p className="mt-1 text-xs leading-5">{item?.role_change_block || (form.role === 'admin' ? 'Administrador(a) gerencia contas, materiais e configurações. Conceda esse acesso apenas a quem precisa.' : 'Professor(a) usa os materiais e as ferramentas de ensino. O vínculo com escola e turma é organizado na área Instituições.')}</p></div>
            {!creating && (form.email.trim().toLowerCase() !== item.email || form.role !== item.role) && <p className="text-sm leading-6">Alterar e-mail ou perfil encerra os acessos atuais dessa pessoa. Ela precisará entrar novamente.</p>}
          </>}
          {(creating || resetting) && <>
            {resetting && <p className="text-sm leading-6">A nova senha substitui a anterior e encerra os acessos atuais desta conta. Combine a entrega da senha com a pessoa, por um canal seguro.</p>}
            <div><label htmlFor="user-password" className="mb-1 block text-sm font-semibold">{resetting ? 'Nova senha' : 'Senha inicial'}</label><div className="flex gap-1"><input ref={resetting ? first : undefined} id="user-password" name="password" type={showPassword ? 'text' : 'password'} className={field} value={form.password} maxLength={1024} disabled={busy} autoComplete="new-password" onChange={e => change('password', e.target.value)} /><button type="button" className={button + ' shrink-0'} disabled={busy} aria-label={showPassword ? 'Ocultar senha' : 'Mostrar senha'} aria-pressed={showPassword} onClick={() => setShowPassword(s => !s)}>{showPassword ? 'Ocultar' : 'Mostrar'}</button></div><p className="mt-1 text-xs">Use pelo menos 8 caracteres. A senha não é enviada por e-mail.</p></div>
          </>}
        </>}
        {needsConsent && !(deleting && item.deletion_block) && <label className="flex min-h-11 items-start gap-2 py-2 text-sm leading-6"><input name="consent" type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={consent} disabled={busy} onChange={e => setConsent(e.target.checked)} />{deleting ? 'Entendo que esta conta será excluída.' : resetting ? 'Confirmo a troca de senha desta pessoa.' : 'Confirmo este perfil de acesso para a pessoa.'}</label>}
        <footer className="flex flex-wrap justify-end gap-2 border-t border-slate-200 pt-3 dark:border-white/10"><button type="button" className={button} disabled={busy} onClick={close}>Cancelar</button>{!(deleting && item.deletion_block) && <button type="submit" className={primary} disabled={busy || (needsConsent && !consent)}>{busy ? 'Salvando…' : deleting ? 'Excluir conta' : resetting ? 'Salvar nova senha' : 'Salvar conta'}</button>}</footer>
      </form>}
    </section>
  </ModalLayer>;
}
