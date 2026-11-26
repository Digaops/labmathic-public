import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import useHomeResource from '../../hooks/useHomeResource';
import useMaterialEditor from '../../hooks/useMaterialEditor';
import useAccountLeave from '../../hooks/useAccountLeave';
import MaterialResourceState, { materialButton as button, materialSurface as surface } from '../../components/MaterialResourceState';
import { associationLabel, curationDate, curationSnapshot, curationSearch, curationHistory } from '../../services/materialCurationView.mjs';

const panel = surface + ' p-3 sm:p-4';
export default function MaterialCuration() {
  const { id } = useParams(), { user, announcementAccessId } = useAuth(), [revision, setRevision] = useState(0);
  const identity = `${user?.id}:${announcementAccessId}`;
  return <Workspace key={`${identity}:${id}:${revision}`} id={id} identity={identity} reload={() => setRevision(n => n + 1)} />;
}
function Workspace({ id, identity, reload }) {
  const parse = useMemo(() => value => curationSnapshot(value, id), [id]);
  const result = useHomeResource('/materials/curation/materials/' + id, identity, parse);
  const flags = useFeatureFlags(), action = useMaterialEditor(identity, id, 'curation');
  const [selected, setSelected] = useState(null), [decision, setDecision] = useState('confirm'), [reason, setReason] = useState(''), [location, setLocation] = useState(''), [confirmed, setConfirmed] = useState(false);
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [page, setPage] = useState(1), [historyOpen, setHistoryOpen] = useState(false);
  const formHeading = useRef(null), message = useRef(null);
  const busy = ['busy', 'checking'].includes(action.status), uncertain = ['uncertain', 'checking'].includes(action.status);
  const locked = busy || uncertain || action.status === 'conflict' || !flags.isEnabled('materials.bncc_curation');
  const dirty = Boolean(selected && (reason || location || confirmed)) && action.status !== 'success';
  useAccountLeave(dirty || uncertain, () => action.pending.current, 'Há uma revisão não concluída. Sair desta tela?');
  const searchResult = useHomeResource(search ? `/materials/curation/skills?q=${encodeURIComponent(search)}&page=${page}` : null, identity, curationSearch);
  useEffect(() => { if (selected) { formHeading.current?.focus({ preventScroll: true }); formHeading.current?.scrollIntoView({ block: 'start' }); } }, [selected, decision]);
  useEffect(() => { if (action.message) { message.current?.focus({ preventScroll: true }); message.current?.scrollIntoView({ block: 'center' }); } }, [action.message, action.status]);
  function choose(skill, nextDecision = 'confirm') {
    if (locked || (dirty && !window.confirm('Descartar a revisão ainda não enviada?'))) return;
    setSelected(skill); setDecision(nextDecision); setReason(''); setLocation(''); setConfirmed(false);
  }
  const saved = result.status === 'ready' ? result.data : null;
  return <div data-material-curation className="mx-auto max-w-5xl space-y-3 bg-slate-50 px-3 py-3 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100">
    <header className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><h1 className="text-xl font-bold">Habilidades deste material</h1>{saved && <p className="mt-1 break-words text-sm">{saved.material.title}</p>}</div><Link className={button} to="/admin/materiais">Voltar ao acervo</Link></header>
    <p className="text-sm leading-6">Associe uma habilidade somente depois de conferir o conteúdo. O professor continua escolhendo o que faz sentido para sua turma.</p>
    <Link className={button} to={`/material/${id}`}>Abrir material para conferir</Link>
    <MaterialResourceState resource={result} label="as associações deste material" />
    {action.status === 'success' ? <section className={panel}><h2 ref={message} tabIndex={-1} className="font-bold">Revisão registrada</h2><p role="status" className="mt-2 text-sm">A decisão foi salva com histórico. Os planos já criados pelos professores não foram alterados.</p><button className={button} onClick={reload}>Conferir associações atualizadas</button></section> : <>
      {saved && <>
        <section className={panel}><h2 className="font-bold">Associações atuais · {saved.associations.length}</h2>
          {!saved.associations.length && <p className="mt-2 text-sm">Nenhuma habilidade associada. Busque abaixo para fazer a primeira revisão.</p>}
          <ul className="divide-y divide-slate-200 dark:divide-white/10">{saved.associations.map(s => <li key={s.id} className="py-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">{s.code} · {s.gradeName}</h3><span className={s.status === 'needs_review' ? 'text-amber-800 dark:text-amber-200' : 'text-slate-600 dark:text-slate-300'}>{associationLabel[s.status]}</span></div><p className="mt-1 leading-6">{s.description}</p>
            {s.status === 'legacy' && <p className="mt-1 text-slate-600 dark:text-slate-300">Vínculo preservado, sem registro de conferência neste fluxo.</p>}
            {s.status === 'needs_review' && <p className="mt-1">O conteúdo, a habilidade ou o histórico mudou. Não orienta novas sugestões até ser conferido.</p>}
            {s.reason && <details className="mt-1"><summary className={button + ' cursor-pointer'}>Ver última conferência</summary><p className="whitespace-pre-wrap break-words leading-6">{s.location} · {s.reason}</p><p className="mt-1 text-slate-600 dark:text-slate-300">{s.reviewer} · {curationDate(s.reviewedAt)}</p></details>}
            <div className="flex flex-wrap gap-1"><button className={button} disabled={locked} onClick={() => choose(s)}>Conferir {s.code}</button><button className={button + ' text-rose-700 dark:text-rose-200'} disabled={locked} onClick={() => choose(s, 'remove')}>Retirar associação {s.code}</button></div>
          </li>)}</ul>
        </section>
        {!flags.isEnabled('materials.bncc_curation') && <p role="status" className={panel + ' text-sm'}>Novas revisões estão pausadas ou ainda não foram liberadas para sua conta. Você pode consultar o que já foi registrado.</p>}
        <section className={panel}><h2 className="font-bold">Buscar habilidade</h2><form className="mt-2 flex gap-2" onSubmit={e => { e.preventDefault(); setSearch(query.trim()); setPage(1); }}><label className="min-w-0 flex-1 text-sm font-semibold">Código ou descrição<input type="search" className="input mt-1" minLength={2} maxLength={80} required value={query} onChange={e => setQuery(e.target.value)} placeholder="Ex.: EF07MA02 ou porcentagem" /></label><button className={button + ' self-end'} disabled={query.trim().length < 2}>Buscar</button></form>
          <MaterialResourceState resource={searchResult} label="as habilidades" />
          {searchResult.status === 'ready' && <><p role="status" className="mt-3 text-sm">{searchResult.data.total} habilidades encontradas. A quantidade de materiais não indica qualidade ou cobertura completa.</p><ul className="mt-2 divide-y divide-slate-200 dark:divide-white/10">{searchResult.data.skills.map(s => <li key={s.id} className="py-3 text-sm"><h3 className="font-bold">{s.code} · {s.gradeName}</h3><p className="mt-1 leading-6">{s.description}</p><p className="mt-1 text-slate-600 dark:text-slate-300">{s.unitName} · {s.coverage} materiais associados · {s.pending} aguardando conferência</p><button className={button} disabled={locked} onClick={() => choose(s)}>Escolher {s.code}</button></li>)}</ul>
            {searchResult.data.totalPages > 1 && <nav className="flex items-center justify-between" aria-label="Páginas das habilidades"><button className={button} disabled={page <= 1} onClick={() => setPage(n => n - 1)}>Anterior</button><span className="text-sm">Página {page}</span><button className={button} disabled={page >= searchResult.data.totalPages} onClick={() => setPage(n => n + 1)}>Próxima</button></nav>}</>}
        </section>
        {selected && <form aria-label="Registrar revisão" className={panel + ' space-y-3'} onSubmit={e => { e.preventDefault(); action.save({ skillId: selected.id, skillVersion: selected.version, expectedVersion: saved.version, decision, reason, location, confirmed }); }}>
          <h2 ref={formHeading} tabIndex={-1} className="scroll-mt-32 font-bold">{decision === 'remove' ? 'Retirar associação' : 'Conferir associação'} · {selected.code}</h2><p className="text-sm leading-6">{selected.description}</p>
          {saved.material.gradeId && saved.material.gradeId !== selected.gradeId && <p className="text-sm text-amber-800 dark:text-amber-200">O ano da habilidade difere do ano do material. Isso pode fazer sentido na recomposição; explique a escolha.</p>}
          {decision === 'remove' ? <p className="text-sm">A associação deixará de orientar novas sugestões. O material, o histórico e os planos dos professores serão preservados.</p> : <label className="block text-sm font-semibold">Onde a habilidade é trabalhada?<input className="input mt-1" required minLength={3} maxLength={160} disabled={locked} value={location} onChange={e => setLocation(e.target.value)} placeholder="Ex.: atividade 2, páginas 4–5 ou vídeo 02:10" /></label>}
          <label className="block text-sm font-semibold">{decision === 'remove' ? 'Por que retirar esta associação?' : 'Como o material trabalha esta habilidade?'}<textarea className="input mt-1 min-h-24" required minLength={20} maxLength={1000} disabled={locked} value={reason} onChange={e => setReason(e.target.value)} /><span className="mt-1 block font-normal">De 20 a 1.000 caracteres. {decision === 'remove' ? 'A justificativa fica no histórico administrativo.' : 'A justificativa da associação será visível aos professores.'} Não inclua dados pessoais.</span></label>
          <label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input type="checkbox" className="mt-1.5" required disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />{decision === 'remove' ? 'Conferi e quero retirar somente esta associação.' : 'Conferi o conteúdo e a habilidade; quero registrar esta associação.'}</label>
          <button className={button + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white'} disabled={locked || !confirmed || reason.trim().length < 20 || (decision === 'confirm' && location.trim().length < 3)}>{busy ? 'Conferindo pedido…' : decision === 'remove' ? 'Confirmar retirada' : 'Salvar associação'}</button>
        </form>}
      </>}
      {action.message && <section ref={message} tabIndex={-1} role={busy ? 'status' : 'alert'} className={panel + ' scroll-mt-32 text-sm leading-6'}><p>{action.message}</p>{uncertain && <div className="flex flex-wrap gap-1"><button className={button} disabled={busy} onClick={action.check}>Conferir pedido</button>{action.retryAvailable ? <button className={button} disabled={busy} onClick={action.retry}>Reenviar o mesmo pedido</button> : <button className={button} disabled={busy} onClick={action.prepareAgain}>Preparar novamente</button>}</div>}{action.status === 'conflict' && <button className={button} onClick={reload}>Carregar versão atual</button>}</section>}
    </>}
    <details className={panel} onToggle={e => setHistoryOpen(e.currentTarget.open)}><summary className={button + ' cursor-pointer'}>Histórico de revisões</summary>{historyOpen && <History key={action.receipt?.reviewId || 0} id={id} identity={identity} />}</details>
  </div>;
}
function History({ id, identity }) {
  const [before, setBefore] = useState(null);
  const result = useHomeResource(`/materials/curation/materials/${id}/history${before ? '?before=' + before : ''}`, identity, curationHistory);
  return <><MaterialResourceState resource={result} label="o histórico" />{result.status === 'ready' && <><ul className="divide-y divide-slate-200 dark:divide-white/10">{result.data.events.map(e => <li key={e.id} className="py-3 text-sm"><strong>{e.skill.code} · {e.decision === 'confirm' ? 'Associação conferida' : 'Associação retirada'}</strong><p className="mt-1 whitespace-pre-wrap break-words leading-6">{e.location} {e.reason}</p><p className="mt-1 text-slate-600 dark:text-slate-300">{e.reviewer} · {curationDate(e.createdAt)}</p></li>)}</ul>{!result.data.events.length && <p className="text-sm">Nenhuma revisão registrada neste fluxo.</p>}<div className="flex flex-wrap gap-1">{before && <button className={button} onClick={() => setBefore(null)}>Voltar às mais recentes</button>}{result.data.nextBefore && <button className={button} onClick={() => setBefore(result.data.nextBefore)}>Ver mais antigas</button>}</div></>}</>;
}
