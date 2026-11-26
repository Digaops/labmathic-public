import { useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import useHomeResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import useAccountLeave from '../hooks/useAccountLeave';
import api from '../services/api';
import ResourceState, { materialButton as button, materialSurface as surface } from '../components/MaterialResourceState';
import { issueActions, issueDate, issueReasons, issueStatuses, parseIssue, parseIssueList, parseIssueReceipt } from '../services/contentIssuesView.mjs';

export default function ContentIssues() {
  const { user, announcementAccessId } = useAuth();
  const identity = `${user.id}:${user.role}:${announcementAccessId}`;
  return <Workspace key={identity} identity={identity} admin={user.role === 'admin'} />;
}
function Workspace({ identity, admin }) {
  const [params, setParams] = useSearchParams();
  const filter = ['all', 'pending', ...Object.keys(issueStatuses)].includes(params.get('status')) ? params.get('status') : admin ? 'pending' : 'all';
  const page = /^[1-9]\d{0,3}$/.test(params.get('page')) ? Number(params.get('page')) : 1;
  const selected = params.get('relato');
  const list = useHomeResource(`/content-issues?status=${filter}&page=${page}`, identity, parseIssueList);
  function choose(values) { const next = new URLSearchParams(params); Object.entries(values).forEach(([key, value]) => value ? next.set(key, String(value)) : next.delete(key)); setParams(next); }
  return <div data-content-issues className="mx-auto max-w-5xl space-y-3 bg-slate-50 px-3 py-3 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:px-6">
    <header><h1 className="text-xl font-bold">{admin ? 'Revisar problemas no acervo' : 'Meus relatos sobre o acervo'}</h1><p className="mt-1 text-sm text-slate-600 dark:text-slate-300">{admin ? 'Assuma um relato, confira o conteúdo e responda ao professor.' : 'Acompanhe aqui os problemas que você informou e as respostas da administração.'}</p></header>
    {selected ? <><Link className={button} to={`/problemas-no-acervo?status=${filter}&page=${page}`}>Voltar à lista</Link><IssueDetail key={selected} id={selected} identity={identity} admin={admin} onChange={list.retry} /></> : <>
      <div className="flex flex-wrap items-end gap-2"><label className="min-w-0 flex-1 text-sm font-semibold">Situação<select className="input mt-1" value={filter} onChange={e => choose({ status: e.target.value, page: null })}><option value="all">Todas</option><option value="pending">Aguardando ou em revisão</option>{Object.entries(issueStatuses).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label><button className={button} onClick={list.retry} disabled={list.status === 'loading'}>Atualizar lista</button></div>
      <section className={`${surface} p-3`} aria-label="Relatos sobre o acervo"><ResourceState resource={list} label="os relatos" />
        {list.status === 'ready' && <>{list.data.items.length ? <ul className="divide-y divide-slate-200 dark:divide-white/10">{list.data.items.map(row => <li key={row.id}><Link className="block min-h-11 rounded-lg py-3 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-600" to={`/problemas-no-acervo?status=${filter}&page=${page}&relato=${row.id}`}>
          <span className="flex flex-wrap items-center justify-between gap-2"><strong className="min-w-0 break-words">{row.targetType === 'question' ? 'Questão' : 'Material'}: {row.targetLabel}</strong><span className="rounded-lg bg-slate-100 px-2 py-1 text-xs font-semibold dark:bg-white/10">{issueStatuses[row.status]}</span></span><span className="mt-1 block text-sm text-slate-600 dark:text-slate-300">{issueReasons[row.reason]} · {issueDate(row.createdAt)}</span><span className="mt-1 block text-sm font-semibold text-cyan-800 dark:text-cyan-200">Abrir acompanhamento</span>
        </Link></li>)}</ul> : <p className="py-3 text-sm">Nenhum relato nesta situação. Para informar um problema, abra o material ou os detalhes de uma questão e escolha “Informar problema”.</p>}
        <nav className="mt-2 flex flex-wrap items-center justify-between gap-2" aria-label="Páginas de relatos"><button className={button} disabled={page <= 1} onClick={() => choose({ page: page - 1 })}>Anterior</button><span className="text-sm">Página {page} · {list.data.total} relatos</span><button className={button} disabled={page * 20 >= list.data.total} onClick={() => choose({ page: page + 1 })}>Próxima</button></nav></>}
      </section>
      <nav className="flex flex-wrap gap-2" aria-label="Continuar no acervo"><Link to="/biblioteca" className={button}>Abrir biblioteca</Link><Link to="/banco-questoes" className={button}>Abrir banco de questões</Link><Link to="/fale-conosco" className={button}>Preciso de outra ajuda</Link></nav>
    </>}
  </div>;
}
function IssueDetail({ id, identity, admin, onChange }) {
  const resource = useHomeResource(`/content-issues/${encodeURIComponent(id)}`, identity, parseIssue);
  const action = useMaterialAction(), operation = useRef(null);
  const [reply, setReply] = useState(''), [decision, setDecision] = useState('not_changed'), [confirmed, setConfirmed] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false);
  useAccountLeave(Boolean(reply.trim()) || uncertain, () => action.busy, 'Sua resposta ainda não foi confirmada. Sair sem continuar a revisão?');
  function send(kind) {
    const body = { action: kind, expectedRevision: resource.data.revision, ...(kind !== 'claim' ? { reply: reply.trim(), confirmed } : {}) };
    const serialized = JSON.stringify(body);
    if (!operation.current || operation.current.serialized !== serialized) operation.current = { serialized, key: crypto.randomUUID() };
    setError('');
    action.run(async () => {
      try { parseIssueReceipt((await api.post(`/content-issues/${id}/reviews`, body, { timeout: 15000, headers: { 'Idempotency-Key': operation.current.key } })).data); setUncertain(false); }
      catch (e) { if (!e.response || e.response.status >= 500) setUncertain(true); throw e; }
    }, { message: kind === 'claim' ? 'Você assumiu a revisão.' : 'Resposta registrada para o professor.', onError: setError,
      onSuccess: () => { setReply(''); setConfirmed(false); }, refresh: () => { resource.retry(); onChange(); } });
  }
  const row = resource.data;
  return <section className={`${surface} space-y-3 p-3 sm:p-4`} aria-label="Acompanhamento do relato">
    <ResourceState resource={resource} label="o acompanhamento" />
    <button type="button" className={button} disabled={action.busy || resource.status === 'loading'} onClick={resource.retry}>Atualizar acompanhamento</button>
    {error && <p role="alert" className="text-sm text-amber-800 dark:text-amber-200">{error}</p>}
    {resource.status === 'ready' && <>
      <h2 className="break-words text-lg font-bold">{row.targetLabel}</h2><p className="text-sm font-semibold">{issueStatuses[row.status]} · {issueReasons[row.reason]}</p>
      <p className="whitespace-pre-wrap break-words text-sm leading-6">{row.description}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">Responsável: {row.assignee || 'aguardando alguém da administração assumir'}</p>
      {row.targetAvailable ? <Link className={button} to={row.targetPath}>Conferir conteúdo atual</Link> : <p className="text-sm">O conteúdo não está mais disponível para esta conta. O histórico do relato permanece aqui.</p>}
      <ol className="space-y-3 border-l-2 border-cyan-600/30 pl-3" aria-label="Histórico do relato">{row.events.map(e => <li key={e.revision}><p className="text-sm font-bold">{issueActions[e.action]}</p><p className="text-xs text-slate-600 dark:text-slate-300">{issueDate(e.createdAt)}</p>{e.reply && <p className="mt-1 whitespace-pre-wrap break-words text-sm leading-6">{e.reply}</p>}</li>)}</ol>
      {admin && row.canClaim && <button type="button" className="btn-primary" disabled={action.busy} onClick={() => send('claim')}>{action.busy ? 'Registrando…' : 'Assumir revisão'}</button>}
      {admin && row.canReview && <form className="space-y-3 border-t border-slate-200 pt-3 dark:border-white/10" onSubmit={e => { e.preventDefault(); send(decision); }}>
        <p className="text-sm text-slate-600 dark:text-slate-300">Se precisar corrigir algo, use o editor do material ou da questão. Concluir este relato apenas registra sua resposta: não altera conteúdo, notas ou avaliações anteriores.</p>
        <label className="block text-sm font-semibold">Resultado da revisão<select className="input mt-1" value={decision} disabled={action.busy || uncertain} onChange={e => setDecision(e.target.value)}><option value="not_changed">Sem alteração — explicar o motivo</option><option value="resolved">Ajustado — explicar o que foi feito</option></select></label>
        <label className="block text-sm font-semibold">Resposta ao professor<textarea className="input mt-1 min-h-28" minLength={10} maxLength={2000} required value={reply} disabled={action.busy || uncertain} onChange={e => setReply(e.target.value)} /></label>
        <p className="text-sm text-slate-600 dark:text-slate-300">Não inclua dados pessoais de estudantes. A resposta ficará visível ao autor do relato.</p>
        <label className="flex min-h-11 items-start gap-2 text-sm"><input className="mt-1" type="checkbox" checked={confirmed} disabled={action.busy || uncertain} onChange={e => setConfirmed(e.target.checked)} />Conferi o conteúdo e minha resposta descreve o que foi feito.</label>
        {uncertain && <p role="status" className="text-sm">Envio não confirmado. Atualize o acompanhamento ou repita o mesmo envio com segurança.</p>}
        <button className="btn-primary" disabled={action.busy || !confirmed || reply.trim().length < 10}>{action.busy ? 'Registrando…' : uncertain ? 'Conferir o mesmo envio' : 'Concluir revisão e responder'}</button>
      </form>}
      {!admin && ['resolved', 'not_changed'].includes(row.status) && <p className="text-sm text-slate-600 dark:text-slate-300">Ainda encontrou um problema? Confira o conteúdo atual e envie um novo relato, explicando o que permanece.</p>}
    </>}
  </section>;
}
