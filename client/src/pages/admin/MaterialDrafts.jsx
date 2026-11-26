import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { useFeatureFlags } from '../../contexts/FeatureFlagsContext';
import useHomeResource from '../../hooks/useHomeResource';
import useMaterialEditor from '../../hooks/useMaterialEditor';
import useAccountLeave from '../../hooks/useAccountLeave';
import MaterialPreview from '../../components/MaterialPreview';
import { draftList, draftSnapshot } from '../../services/materialDraftView.mjs';
import { materialFileUrl, externalMaterialUrl } from '../../services/materialView.mjs';

const shell = 'mx-auto max-w-4xl space-y-3 rounded-2xl bg-slate-50 px-3 py-4 text-slate-900 sm:px-6 dark:bg-transparent dark:text-slate-100';
const panel = 'rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 dark:border-white/10 dark:bg-[#111E31]';
const button = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
function useIdentity() { const { user, announcementAccessId } = useAuth(); return `${user?.id}:${announcementAccessId}`; }

export default function MaterialDrafts() {
  const identity = useIdentity(), [params, setParams] = useSearchParams();
  const page = /^[1-9]\d{0,5}$/.test(params.get('page') || '') ? Number(params.get('page')) : 1;
  const result = useHomeResource('/materials/management/drafts?page=' + page, identity, draftList);
  return <div className={shell} data-material-drafts><header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-bold">Meus rascunhos</h1><Link className={button} to="/admin/materiais">Voltar ao acervo</Link></header>
    <p className="text-sm leading-6">Materiais em preparação nesta conta. Eles ainda não aparecem para os professores.</p><Link className={button} to="/admin/materiais/novo">Novo material</Link>
    {result.status === 'loading' && <p role="status">Carregando rascunhos…</p>}
    {result.status === 'error' && <div role="alert" className={panel}><p>Não foi possível consultar seus rascunhos. Nada foi apagado.</p><button className={button} onClick={result.retry}>Tentar novamente</button></div>}
    {result.status === 'ready' && <><p role="status" className="text-sm">{result.data.total} {result.data.total === 1 ? 'rascunho salvo' : 'rascunhos salvos'}</p><ul className="space-y-2" aria-label="Rascunhos salvos">{result.data.drafts.map(d => <li key={d.id} className={panel + ' flex flex-wrap items-center justify-between gap-2'}><h2 className="min-w-0 break-words text-sm font-bold">{d.title}</h2><div className="flex flex-wrap gap-1"><Link className={button} to={`/admin/materiais/rascunhos/${d.id}/editar`}>Continuar<span className="sr-only"> {d.title}</span></Link><Link className={button} to={`/admin/materiais/rascunhos/${d.id}`}>Conferir<span className="sr-only"> {d.title}</span></Link></div></li>)}</ul>
      {!result.data.drafts.length && <p className={panel}>Nenhum rascunho nesta página. Os materiais publicados ficam no acervo.</p>}
      {(page > 1 || result.data.totalPages > 1) && <nav aria-label="Páginas dos rascunhos" className="flex flex-wrap items-center justify-between"><button className={button} disabled={page <= 1} onClick={() => setParams({ page: String(page - 1) })}>Anterior</button><span className="text-sm">Página {page}</span><button className={button} disabled={page >= result.data.totalPages} onClick={() => setParams({ page: String(page + 1) })}>Próxima</button></nav>}</>}
  </div>;
}

export function MaterialDraftReview() {
  const { draftId } = useParams(), identity = useIdentity(), [revision, setRevision] = useState(0);
  return <Review key={`${identity}:${draftId}:${revision}`} draftId={draftId} identity={identity} reload={() => setRevision(n => n + 1)} />;
}
function Review({ draftId, identity, reload }) {
  const parse = useMemo(() => value => draftSnapshot(value, draftId), [draftId]);
  const result = useHomeResource('/materials/management/drafts/' + draftId, identity, parse), action = useMaterialEditor(identity, draftId, 'publish');
  const flags = useFeatureFlags(), [confirmed, setConfirmed] = useState(false), [previewOpen, setPreviewOpen] = useState(false);
  const alertRef = useRef(null);
  useEffect(() => { if (['error', 'conflict', 'uncertain'].includes(action.status)) { alertRef.current?.focus({ preventScroll: true }); alertRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' }); } }, [action.status, action.message]);
  const busy = ['busy', 'checking'].includes(action.status), uncertain = ['uncertain', 'checking'].includes(action.status);
  useAccountLeave(uncertain, () => action.pending.current, 'A publicação está sem confirmação. O código do pedido fica nesta aba. Sair mesmo assim?');
  const saved = result.status === 'ready' ? result.data : null, material = saved?.material;
  const publishedId = action.receipt?.materialId || (!uncertain && saved?.publishedMaterialId);
  return <div data-material-draft-review className={shell}><header className="flex flex-wrap items-center justify-between gap-2"><h1 className="text-xl font-bold">Conferir material</h1><Link className={button} to="/admin/materiais/rascunhos">Meus rascunhos</Link></header>
    {publishedId ? <section className={panel}><h2 tabIndex={-1} ref={node => node?.focus()} className="font-bold">Material publicado</h2><p role="status" className="mt-2 text-sm">A publicação foi confirmada. Para conferir a disponibilidade atual, abra o material no acervo.</p><Link className={button} to={`/material/${publishedId}`}>Ver material no acervo</Link></section> : <>
      {result.status === 'loading' && <p role="status">Carregando o rascunho salvo…</p>}
      {result.status === 'error' && <section role="alert" className={panel}><p>Não foi possível carregar o rascunho. Nenhuma publicação foi iniciada por esta consulta.</p><button className={button} onClick={result.retry}>Tentar carregar novamente</button></section>}
      {saved?.publishedMaterialId && uncertain && <p className={panel + ' text-sm'}>Este rascunho já tem uma publicação registrada. Confira o pedido abaixo para recuperar o recibo.</p>}
      {saved && !saved.publishedMaterialId && <section className={panel + ' space-y-3'}><h2 className="break-words text-lg font-bold">{material.title}</h2><p className="text-sm">Rascunho privado · ainda não aparece na biblioteca</p>
        <p className="break-words text-sm">{material.file_path ? `Arquivo salvo: ${material.file_format || 'formato não informado'}` : material.external_url ? 'Conteúdo por link externo' : 'Falta adicionar um arquivo ou um link.'}</p>
        {material.description && <details><summary className={button + ' cursor-pointer'}>Ler descrição</summary><p className="whitespace-pre-wrap break-words text-sm">{material.description}</p></details>}
        {saved.plannedCollections.length > 0 && <details><summary className={button + ' cursor-pointer'}>Laboratórios selecionados ({saved.plannedCollections.length})</summary><ul className="space-y-1 text-sm">{saved.plannedCollections.map(c => <li key={c.id}>{c.name}</li>)}</ul></details>}
        {externalMaterialUrl(material.external_url) && <a className={button + ' break-all'} href={externalMaterialUrl(material.external_url)} target="_blank" rel="noopener noreferrer">Abrir link para conferir</a>}
        {material.file_path && <><div className="flex flex-wrap gap-2"><button className={button} aria-expanded={previewOpen} onClick={() => setPreviewOpen(v => !v)}>{previewOpen ? 'Fechar prévia' : 'Ver prévia do arquivo'}</button><a className={button} href={materialFileUrl(material.file_path)} target="_blank" rel="noopener noreferrer">Abrir em outra aba</a></div>{previewOpen && <MaterialPreview draft material={material} fileUrl={materialFileUrl(material.file_path)} userRole="admin" onRetry={() => { setConfirmed(false); result.retry(); }} />}</>}
        <p className="text-sm leading-6">Ao publicar, o material fica disponível na biblioteca e nos laboratórios selecionados. Os professores recebem um aviso.</p>
        <label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input className="mt-1.5" type="checkbox" checked={confirmed} disabled={busy || uncertain} onChange={e => setConfirmed(e.target.checked)} />Conferi o conteúdo e quero disponibilizá-lo aos professores.</label>
        <div className="flex flex-wrap gap-2"><Link onClick={e => { if (busy) e.preventDefault(); }} className={button} to={`/admin/materiais/rascunhos/${draftId}/editar`}>Editar rascunho</Link><button type="button" className={button + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white'} disabled={!confirmed || (!material.file_path && !material.external_url) || busy || uncertain || action.status === 'conflict' || !flags.isEnabled('materials.draft_publication')} onClick={() => action.save({ expectedVersion: saved.version })}>{busy ? 'Conferindo publicação…' : 'Publicar para os professores'}</button></div>
        {!flags.isEnabled('materials.draft_publication') && <p role="status" className="text-sm">A publicação está pausada ou seu acesso ainda não foi confirmado. O rascunho foi preservado.</p>}
      </section>}
      {action.message && <section role={busy ? 'status' : 'alert'} tabIndex={-1} ref={alertRef} className={panel + ' scroll-mt-32 text-sm leading-6'}><p>{action.message}</p>
        {uncertain && <div className="flex flex-wrap gap-2"><button className={button} disabled={busy} onClick={action.check}>Conferir pedido</button>{action.retryAvailable ? <button className={button} disabled={busy} onClick={action.retry}>Reenviar o mesmo pedido</button> : <button className={button} disabled={busy || !saved} onClick={() => { setConfirmed(false); action.prepareAgain(); }}>Preparar novamente</button>}</div>}
        {action.status === 'conflict' && <button className={button} onClick={reload}>Carregar versão atual</button>}
      </section>}
    </>}
  </div>;
}
