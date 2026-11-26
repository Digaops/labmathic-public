import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import api from '../services/api';
import { useAuth } from '../contexts/AuthContext';
import { AccountNotice, AccountSelect, accountPanel } from '../components/AccountWorkspace';
import useAccountLeave from '../hooks/useAccountLeave';
import useSupportRead from '../hooks/useSupportRead';
import { confirmSupportSend, parseSupportDetail, parseSupportList, requestError, supportDate, supportDraftKey, supportSubjects, uncertainWrite } from '../services/accountSupportView.mjs';

export default function SupportChat() {
  const { user } = useAuth();
  return <SupportWorkspace key={user.id} user={user} />;
}
function SupportWorkspace({ user }) {
  const flags = useFeatureFlags();
  const admin = user.role === 'admin', base = admin ? '/support/admin/threads' : '/support/threads';
  const [params, setParams] = useSearchParams(), [search, setSearch] = useState(params.get('search') || '');
  const [drafts, setDrafts] = useState({}), [notices, setNotices] = useState({}), [uncertain, setUncertain] = useState({});
  const [busy, setBusy] = useState(false), [readError, setReadError] = useState(null), [recent, setRecent] = useState(false);
  const pending = useRef(false), alive = useRef(true), messagesRef = useRef(null), headingRef = useRef(null), inputRef = useRef(null), returnTo = useRef(null), nearBottom = useRef(true), readKeys = useRef(new Set());
  const rawId = params.get('thread'), requestedId = rawId && /^[1-9]\d*$/.test(rawId) && Number.isSafeInteger(Number(rawId)) ? Number(rawId) : null;
  const filter = params.get('filter') === 'unread' ? 'unread' : '', subjectFilter = params.get('subject') || '', query = (params.get('search') || '').slice(0, 120);
  const listParams = new URLSearchParams(); if (admin) { if (filter) listParams.set('filter', filter); if (supportSubjects.includes(subjectFilter)) listParams.set('subject', subjectFilter); if (query) listParams.set('search', query); }
  const listParser = useCallback(data => parseSupportList(data, user), [user.id, user.role]);
  const list = useSupportRead(base + (listParams.size ? '?' + listParams : ''), listParser, busy);
  const threads = list.data?.threads || [];
  const selectedFromList = threads.find(t => t.id === requestedId);
  const subject = admin ? '' : (params.get('assunto') || selectedFromList?.subject || (!rawId ? supportSubjects[0] : ''));
  const subjectThread = !admin && threads.find(t => t.subject === subject);
  const selectedId = requestedId || subjectThread?.id || null;
  const key = supportDraftKey(user, selectedId, subject);
  const selection = useRef(key), focusComposer = useRef(null);
  selection.current = key;
  const selected = admin ? Boolean(rawId) : Boolean(subject);
  const validSubject = supportSubjects.includes(subject);
  const parser = useCallback(data => parseSupportDetail(data, user, selectedId, admin ? null : subject || null), [user.id, user.role, selectedId, subject, admin]);
  const detail = useSupportRead(selectedId ? base + '/' + selectedId : null, parser, busy, 10000);
  const thread = detail.data?.thread, messages = detail.data?.messages || [], draft = drafts[key] || '';
  const unknownLink = Boolean(rawId) && !requestedId;
  const canCompose = !unknownLink && selected && (admin ? Boolean(thread) : validSubject && Boolean(list.data) && (!selectedId || Boolean(thread))) && !list.error && !detail.error && !busy && !uncertain[key];
  useEffect(() => {
    if (canCompose && focusComposer.current === key) { inputRef.current?.focus({ preventScroll: true }); focusComposer.current = null; }
  }, [canCompose, key]);
  useAccountLeave(Object.values(drafts).some(Boolean), () => pending.current);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => setSearch(query), [query]);
  // Old links only carry an id. Read its owner/subject before enabling the composer.
  useEffect(() => {
    if (!admin && thread && !subject && !pending.current) { const next = new URLSearchParams(params); next.set('assunto', thread.subject); setParams(next, { replace: true }); }
  }, [admin, thread, subject]);
  useEffect(() => {
    nearBottom.current = true; setRecent(false);
    if (selected) headingRef.current?.focus({ preventScroll: true });
    else if (returnTo.current) { document.querySelector('[data-support-row="' + returnTo.current + '"]')?.focus(); returnTo.current = null; }
  }, [admin ? rawId : subject]);
  const lastMessageId = messages.at(-1)?.id;
  useEffect(() => {
    if (nearBottom.current && messagesRef.current) { messagesRef.current.scrollTop = messagesRef.current.scrollHeight; setRecent(false); }
    else if (lastMessageId) setRecent(true);
  }, [lastMessageId, key]);
  // Only mark the conversation actually opened, after an identity-checked read.
  useEffect(() => {
    if (!thread || detail.error || detail.loading || busy || document.visibilityState !== 'visible') return;
    const unread = messages.filter(m => !m.read_at && m.sender_role !== user.role);
    if (!unread.length) return;
    const readKey = thread.id + ':' + unread.at(-1).id;
    if (readKeys.current.has(readKey)) return;
    readKeys.current.add(readKey);
    api.put(base + '/' + thread.id + '/read', {}, { timeout: 15000 }).then(() => {
      if (!alive.current) return;
      setReadError(current => current?.id === thread.id ? null : current);
      window.dispatchEvent(new Event('notifications:refresh')); list.refresh();
    }).catch(() => { if (alive.current) setReadError({ id: thread.id, readKey }); });
  }, [thread, messages, detail.error, detail.loading, busy, base, user.role]);
  function choose(changes) {
    if (pending.current) return;
    const next = new URLSearchParams(params);
    Object.entries(changes).forEach(([k, v]) => v ? next.set(k, String(v)) : next.delete(k));
    setParams(next);
  }
  const tell = (text, kind = 'error', target = key) => setNotices(n => ({ ...n, [target]: { text, kind } }));
  async function send(e) {
    e.preventDefault(); if (pending.current || !canCompose || !draft.trim()) return;
    const body = draft.trim(), target = key, previousIds = messages.map(m => m.id);
    if (body.length > 4000) return tell('Use no máximo 4.000 caracteres.');
    pending.current = true; list.cancel(); detail.cancel(); setBusy(true); tell('');
    try {
      const { data } = await api.post(admin ? base + '/' + selectedId + '/messages' : '/support/thread/messages', { body, ...(!admin ? { subject } : {}) }, { timeout: 20000 });
      const next = confirmSupportSend(data, user, selectedId, admin ? null : subject, body, previousIds);
      if (!alive.current) return;
      setDrafts(d => ({ ...d, [target]: '' }));
      tell('Mensagem enviada.', 'success', target);
      if (selection.current === target) {
        detail.adopt(next); nearBottom.current = true; focusComposer.current = target;
        const nextParams = new URLSearchParams(params); nextParams.set('thread', String(next.thread.id)); if (!admin) nextParams.set('assunto', next.thread.subject); setParams(nextParams, { replace: true });
      }
      list.refresh();
    } catch (e) {
      if (!alive.current) return;
      if (uncertainWrite(e)) setUncertain(u => ({ ...u, [target]: { kind: 'message', checked: false } }));
      tell(uncertainWrite(e) ? 'O envio ficou sem confirmação. O texto foi mantido. Confira o histórico antes de tentar novamente para evitar mensagem duplicada.' : requestError(e, 'Não foi possível enviar. Seu texto foi mantido.'), 'error', target);
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function status() {
    if (!admin || !thread || pending.current || detail.error || detail.loading || uncertain[key]) return;
    const status = thread.status === 'closed' ? 'open' : 'closed';
    if (!window.confirm(status === 'closed' ? 'Marcar este atendimento como concluído? O histórico será preservado.' : 'Reabrir este atendimento?')) return;
    pending.current = true; list.cancel(); detail.cancel(); setBusy(true); const target = key;
    try {
      const { data } = await api.put(base + '/' + thread.id + '/status', { status }, { timeout: 15000 });
      const next = parseSupportDetail({ thread: data, messages }, user, thread.id);
      if (next.thread.status !== status) throw Error('Situação não confirmada.');
      if (!alive.current) return;
      if (selection.current === target) detail.adopt(next);
      tell(status === 'closed' ? 'Atendimento concluído.' : 'Atendimento reaberto.', 'success', target); list.refresh();
    } catch (e) {
      if (!alive.current) return;
      if (uncertainWrite(e)) setUncertain(u => ({ ...u, [target]: { kind: 'status', checked: false } }));
      tell(requestError(e, 'Não foi possível confirmar a situação. Confira a conversa antes de alterar novamente.'), 'error', target);
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function checkConversation() {
    if (pending.current) return; pending.current = true; list.cancel(); detail.cancel(); setBusy(true); const target = key;
    try {
      let id = selectedId;
      if (!id) { const { data } = await api.get(base, { timeout: 15000 }); const next = parseSupportList(data, user); list.adopt(next); id = next.threads.find(t => t.subject === subject)?.id; }
      if (id) {
        const { data } = await api.get(base + '/' + id, { timeout: 15000 }); const next = parseSupportDetail(data, user, id, admin ? null : subject);
        if (!alive.current) return;
        if (selection.current === target) { detail.adopt(next); const nextParams = new URLSearchParams(params); nextParams.set('thread', String(id)); setParams(nextParams, { replace: true }); }
      }
      if (!alive.current) return;
      setUncertain(u => ({ ...u, [target]: { ...u[target], checked: true } })); tell('Conversa conferida. Leia as últimas mensagens antes de liberar o campo.', 'success', target); if (selection.current === target) { nearBottom.current = true; setRecent(false); }
    } catch { if (alive.current) tell('Não foi possível conferir o histórico. O envio continua bloqueado e seu texto foi mantido.', 'error', target); }
    finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  function resolveSend(clear) {
    if (pending.current || !uncertain[key]?.checked) return;
    if (!window.confirm(clear ? 'Você conferiu que a mensagem já aparece no histórico? Limpar apenas o texto local?' : 'Você conferiu o histórico? Manter o texto para um novo envio pode duplicar uma mensagem já recebida. Nada será enviado agora.')) return;
    if (clear) setDrafts(d => ({ ...d, [key]: '' }));
    setUncertain(u => ({ ...u, [key]: null })); tell('Campo liberado. Nenhuma mensagem foi enviada nesta conferência.', 'success');
  }
  const totals = list.data?.totals;
  const subjectOptions = [...new Set([...supportSubjects, ...(!admin ? threads.map(t => t.subject) : [])])];
  const invalidSubject = !admin && subject && !subjectOptions.includes(subject);
  return <div data-support-workspace className="account-workspace mx-auto max-w-6xl space-y-3 px-3 pb-6 pt-3">
    <header><h1 className="text-xl font-bold">{admin ? 'Atendimento aos professores' : 'Fale Conosco'}</h1></header>
    {flags.isEnabled('content.issue_review') && <Link to="/problemas-no-acervo" className="btn-outline">{admin ? 'Revisar problemas no acervo' : 'Acompanhar problemas no acervo'}</Link>}
    {!admin && <AccountSelect label="Assunto da conversa" value={subject} disabled={busy} onChange={value => choose({ assunto: value, thread: threads.find(t => t.subject === value)?.id || '' })} options={[...(!subject || invalidSubject ? [{ value: subject, label: 'Escolha um assunto' }] : []), ...subjectOptions.map(s => ({ value: s, label: s + (threads.find(t => t.subject === s)?.unread_count ? ' · nova resposta' : '') }))]} />}
    {list.error && <div className="space-y-2"><AccountNotice value={{ kind: 'error', text: list.error + (list.data ? ' A lista anterior permanece para consulta.' : '') }} /><button className="btn-outline" type="button" disabled={busy} onClick={list.refresh}>Atualizar lista</button></div>}
    {unknownLink && <AccountNotice value={{ kind: 'error', text: 'Endereço de conversa inválido. Escolha uma conversa disponível.' }} />}
    <div className={'grid min-w-0 gap-3 ' + (admin ? 'lg:grid-cols-[minmax(250px,0.8fr)_minmax(0,1.5fr)]' : '')}>
      {admin && <aside className={accountPanel + (selected ? ' hidden lg:block' : '')}>
        <form className="space-y-2" onSubmit={e => { e.preventDefault(); choose({ search: search.trim(), thread: '' }); }}>
          <label className="block text-sm font-semibold">Buscar professor ou assunto<input className="input mt-1" maxLength={120} value={search} onChange={e => setSearch(e.target.value)} disabled={busy} /></label>
          <div className="flex flex-wrap gap-2"><button type="submit" className="btn-primary" disabled={busy}>Buscar</button><button type="button" className="btn-outline" disabled={busy} onClick={() => choose({ search: '', filter: '', subject: '', thread: '' })}>Limpar filtros</button></div>
          <details><summary className="cursor-pointer text-sm font-semibold">Filtros da lista</summary><div className="mt-2 grid gap-2">
            <AccountSelect label="Mensagens" value={filter} disabled={busy} onChange={value => choose({ filter: value, thread: '' })} options={[{ value: '', label: 'Todas' }, { value: 'unread', label: 'Não lidas' }]} />
            <AccountSelect label="Filtrar por assunto" value={subjectFilter} disabled={busy} onChange={value => choose({ subject: value, thread: '' })} options={[{ value: '', label: 'Todos os assuntos' }, ...supportSubjects.map(s => ({ value: s, label: s }))]} />
          </div></details>
        </form>
        {list.loading && !list.data && <p role="status" className="mt-3 text-sm">Carregando conversas...</p>}
        {list.data && <div className="mt-3 max-h-[55dvh] overflow-y-auto"><ul className="divide-y divide-slate-200 dark:divide-white/10">{threads.map(t => <li key={t.id}><button type="button" disabled={busy} data-support-row={t.id} className="w-full rounded-lg py-3 text-left hover:bg-slate-100 dark:hover:bg-white/5" aria-pressed={selectedId === t.id} onClick={() => choose({ thread: t.id })}><strong className="block text-sm">{t.professor_name}</strong><span className="mt-1 block text-sm">{t.subject} · {t.status === 'closed' ? 'Concluído' : 'Em andamento'}</span><span className="mt-1 block text-xs">{t.unread_count ? t.unread_count + ' mensagem(ns) não lida(s)' : 'Sem mensagens novas'}</span><span className="mt-1 block text-xs">{supportDate(t.last_message_at)}</span></button></li>)}</ul>
          {!threads.length && !list.error && <p role="status" className="py-3 text-sm">Nenhuma conversa nestes filtros.</p>}
        </div>}
      </aside>}
      {(!admin || selected) ? <div className="min-w-0 space-y-2">
        {admin && <button type="button" className="btn-outline" disabled={busy} onClick={() => { returnTo.current = requestedId; choose({ thread: '' }); }}>Voltar às conversas</button>}
        <section className={accountPanel + ' support-conversation flex min-w-0 flex-col gap-2'}>
          <p role="status" className="sr-only">{thread ? 'Histórico carregado. ' + messages.length + ' mensagem(ns).' : ''}</p>
          <header className="shrink-0"><h2 ref={headingRef} tabIndex={-1} className="text-sm font-bold">{admin ? thread?.professor_name || 'Conversa selecionada' : 'Administração LabMathic'}</h2>
            {admin && <p className="text-sm">{thread?.subject}</p>}
            {thread?.status === 'closed' && <p className="text-xs">Atendimento concluído</p>}
          </header>
          <div ref={messagesRef} data-support-messages tabIndex={0} role="region" aria-label="Histórico da conversa" className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain rounded-lg bg-slate-50 p-2 dark:bg-[#081426]" onScroll={e => { const el = e.currentTarget; nearBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48; if (nearBottom.current) setRecent(false); }}>
            {detail.loading && !thread && <p role="status" className="text-sm">Carregando conversa...</p>}
            {detail.error && <div className="space-y-2"><AccountNotice value={{ kind: 'error', text: detail.error + (thread ? ' O histórico anterior está apenas para consulta.' : '') }} /><button type="button" className="btn-outline" disabled={busy} onClick={detail.refresh}>Tentar abrir novamente</button></div>}
            {messages.map(m => <article data-support-message key={m.id} className={'rounded-lg border p-3 text-sm ' + (m.sender_id === user.id ? 'ml-3 border-cyan-200 bg-cyan-50 text-cyan-950 dark:border-cyan-400/20 dark:bg-cyan-400/10 dark:text-cyan-50' : 'mr-3 border-slate-200 bg-white text-slate-900 dark:border-white/10 dark:bg-[#111e31] dark:text-slate-100')}><p className="font-semibold">{m.sender_role === 'admin' ? 'Administração' : m.sender_name}</p><p className="my-1 whitespace-pre-wrap">{m.body}</p><p className="text-xs">{supportDate(m.created_at)}{m.sender_id === user.id && m.read_at ? ' · Lida' : ''}</p></article>)}
            {!messages.length && !detail.loading && !detail.error && !list.error && list.data && !unknownLink && <p className="text-sm">{selectedId ? 'Nenhuma mensagem nesta conversa.' : 'Escreva abaixo para iniciar a conversa sobre este assunto.'}</p>}
            {readError?.id === selectedId && <div className="text-sm"><p>Não foi possível atualizar o aviso de leitura.</p><button type="button" className="btn-outline" disabled={busy} onClick={() => { readKeys.current.delete(readError.readKey); setReadError(null); detail.refresh(); }}>Atualizar leitura</button></div>}
          </div>
          {recent && <button type="button" className="btn-outline shrink-0" onClick={() => { nearBottom.current = true; messagesRef.current.scrollTop = messagesRef.current.scrollHeight; setRecent(false); }}>Ver mensagens recentes</button>}
          {!admin && !validSubject ? <p className="text-sm">Este assunto antigo está disponível para consulta. Escolha “Outro assunto” para iniciar uma nova conversa.</p> : <form onSubmit={send} className="shrink-0 space-y-2">
            <div className="flex items-center justify-between gap-2"><label htmlFor="support-message" className="text-sm font-semibold">{admin ? 'Resposta ao professor' : 'Sua mensagem'}</label><span id="support-length" className="shrink-0 text-xs">{draft.length}/4.000</span></div>
            <div className="flex items-end gap-2"><textarea ref={inputRef} id="support-message" aria-describedby="support-length" className="input min-h-11 max-h-24 min-w-0 flex-1 resize-y" rows={2} maxLength={4000} disabled={!canCompose} value={draft} onChange={e => setDrafts(d => ({ ...d, [key]: e.target.value }))} onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && !e.nativeEvent.isComposing) { e.preventDefault(); e.currentTarget.form.requestSubmit(); } }} /><button type="submit" className="btn-primary shrink-0 px-3" aria-label="Enviar mensagem" disabled={!canCompose || !draft.trim()}>{busy ? '...' : 'Enviar'}</button></div>
          </form>}
        </section>
        {thread && <details className={accountPanel}><summary className="cursor-pointer text-sm">Sobre esta conversa</summary><p className="mt-2 text-sm">{thread.professor_name} · {thread.professor_email}</p><p className="text-sm">{thread.subject} · {thread.status === 'closed' ? 'Concluído' : 'Em andamento'}</p><p className="text-sm">Iniciada em {supportDate(thread.created_at)}</p>{admin && <button type="button" className="btn-outline mt-2" disabled={busy || Boolean(uncertain[key]) || Boolean(detail.error) || detail.loading} onClick={status}>{thread.status === 'closed' ? 'Reabrir atendimento' : 'Concluir atendimento'}</button>}</details>}
        <AccountNotice value={notices[key]} focus />
        {uncertain[key] && <div className={accountPanel + ' space-y-2'}><button type="button" className="btn-outline" disabled={busy} onClick={checkConversation}>Conferir conversa</button>{uncertain[key].checked && <div className="flex flex-wrap gap-2">{uncertain[key].kind === 'message' ? <><button type="button" className="btn-outline" disabled={busy} onClick={() => resolveSend(true)}>Já recebi confirmação; limpar texto</button><button type="button" className="btn-outline" disabled={busy} onClick={() => resolveSend(false)}>Manter texto para revisar</button></> : <button type="button" className="btn-outline" disabled={busy} onClick={() => { setUncertain(u => ({ ...u, [key]: null })); tell('Situação conferida. Nenhuma alteração foi repetida.', 'success'); }}>Situação conferida</button>}</div>}</div>}
      </div> : <section className={accountPanel + ' hidden lg:block'}><h2 className="font-bold">Escolha uma conversa</h2><p className="mt-2 text-sm">As mensagens só serão marcadas como lidas ao abrir o histórico.</p></section>}
    </div>
    <details className={accountPanel}><summary className="cursor-pointer text-sm font-semibold">Como funciona o atendimento</summary><p className="mt-2 text-sm">As conversas ficam disponíveis para o professor e os administradores. Não envie senhas nem dados desnecessários de estudantes. Informe a tela utilizada e o que você precisa fazer.</p><p className="mt-2 text-sm">Cada assunto tem seu histórico. Enviar uma mensagem reabre um atendimento concluído. Enter cria uma linha; Ctrl + Enter envia. O texto ainda não enviado é mantido ao trocar de conversa, mas não ao sair ou recarregar.</p></details>
    {admin && totals && <details className={accountPanel}><summary className="cursor-pointer text-sm font-semibold">Resumo dos atendimentos</summary><p className="my-2 text-sm">{totals.total_threads} conversa(s) · {totals.open_threads || 0} em andamento · {totals.unread_messages} mensagem(ns) não lida(s). Totais gerais, sem aplicar os filtros.</p><ul className="divide-y divide-slate-200 dark:divide-white/10">{totals.by_subject.map(s => <li key={s.subject} className="py-2 text-sm">{s.subject}: {s.total_threads} conversa(s), {s.open_threads} em andamento e {s.unread_messages} mensagem(ns) não lida(s).</li>)}</ul></details>}
  </div>;
}
