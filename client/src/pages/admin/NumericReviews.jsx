import { useEffect, useRef, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import useHomeResource from '../../hooks/useHomeResource';
import useAccountLeave from '../../hooks/useAccountLeave';
import api from '../../services/api';
import { numericStatusLabels as numericStatusLabel, parseNumericReview, parseNumericReviewPage } from '../../services/numericDraftView.mjs';
import AssessmentDialog from '../../components/AssessmentDialog';
import NumericDraftReview from '../../components/NumericDraftReview';

const base = '/question-bank/numeric-drafts/reviews';
const surface = 'rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31]';
export default function NumericReviews() {
  const { user, announcementAccessId } = useAuth();
  return user?.role === 'admin' ? <NumericReviewWorkspace key={`${user.id}:${announcementAccessId}`} identity={`${user.id}:${announcementAccessId}`} /> : <Navigate to="/" replace />;
}
export function NumericReviewWorkspace({ identity }) {
  const [status, setStatus] = useState('pending'), [page, setPage] = useState(1), [selected, setSelected] = useState(null);
  const queue = useHomeResource(`${base}/queue?status=${status}&page=${page}`, identity, parseNumericReviewPage);
  return <div className="mx-auto max-w-4xl space-y-3 bg-slate-50 p-3 text-slate-900 dark:bg-transparent dark:text-slate-100 sm:p-5">
    <header><h1 className="text-xl font-bold">Revisar questões numéricas</h1><p className="mt-1 text-sm">Confira os envios dos professores. A aprovação permite o uso em papel e, para professores do piloto liberado, a seleção nas aplicações da turma. Não publica no banco geral nem aplica automaticamente.</p></header>
    <div className="flex flex-wrap items-end gap-2"><label className="text-sm font-semibold">Situação<select className="input mt-1" value={status} onChange={e => { setStatus(e.target.value); setPage(1); }}>{['pending','approved','rejected','cancelled'].map(s => <option key={s} value={s}>{numericStatusLabel[s]}</option>)}</select></label><button className="btn-outline" onClick={queue.retry} disabled={queue.status==='loading'}>Atualizar lista</button></div>
    {queue.status==='loading' && <p role="status">Consultando envios…</p>}
    {queue.status==='error' && <p role="alert" className={surface}>Não foi possível consultar os envios. Tente atualizar a lista.</p>}
    {queue.status==='ready' && <><p className="text-sm" role="status">{queue.data.pagination.total} envio(s) · {numericStatusLabel[status]}</p><ul className="space-y-2" aria-label="Questões para revisão">{queue.data.data.map(r => <li key={r.publicId} className={surface+' flex flex-wrap items-center gap-3'}><div className="min-w-0 flex-1"><h2 className="line-clamp-2 break-words text-sm font-bold">{r.statement}</h2><p className="mt-1 break-words text-sm">{r.authorName} · {r.skillCode}</p></div><button className="btn-outline" onClick={() => setSelected(r.publicId)}>Conferir questão</button></li>)}</ul>
      {!queue.data.data.length && <p className={surface}>Nenhum envio nesta página e situação.</p>}
      {(page>1 || queue.data.pagination.totalPages>1) && <nav className="flex items-center justify-between" aria-label="Páginas dos envios"><button className="btn-outline" disabled={page<=1} onClick={() => setPage(p=>p-1)}>Anterior</button><span>Página {page}</span><button className="btn-outline" disabled={page>=queue.data.pagination.totalPages} onClick={() => setPage(p=>p+1)}>Próxima</button></nav>}</>}
    {selected && <Review key={selected} publicId={selected} identity={identity} onClose={() => { setSelected(null); queue.retry(); }} />}
  </div>;
}
function Review({ publicId, identity, onClose }) {
  const result=useHomeResource(`${base}/${publicId}`,identity,parseNumericReview);
  const [receipt,setReceipt]=useState(null), [reason,setReason]=useState(''), [confirmed,setConfirmed]=useState(false);
  const [busy,setBusy]=useState(false), [uncertain,setUncertain]=useState(false), [conflict,setConflict]=useState(false), [message,setMessage]=useState('');
  const pending=useRef(null), lock=useRef(false), notice=useRef(null), mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useAccountLeave(Boolean(reason)||uncertain,()=>lock.current);
  useEffect(()=>{ if(message){notice.current?.focus({preventScroll:true});notice.current?.scrollIntoView({block:'nearest'});} },[message]);
  const review=receipt || (result.status==='ready' ? result.data : null);
  const close=()=>{if(!lock.current && (!(reason||uncertain)||window.confirm(uncertain?'A decisão está sem confirmação. Sair mesmo assim?':'Sair sem enviar seu comentário?')))onClose();};
  async function decide(decision) {
    if(lock.current || conflict || !review)return;
    if(!pending.current){
      if(!confirmed || reason.trim().length<10)return;
      pending.current={key:crypto.randomUUID(),body:{expectedRevision:review.revision,decision,reason:reason.trim()}};
    }
    lock.current=true;setBusy(true);setMessage('');
    try{
      const response=await api.post(`${base}/${publicId}/decision`,pending.current.body,{headers:{'Idempotency-Key':pending.current.key},timeout:15000});
      const saved=parseNumericReview(response.data);if(!mounted.current)return;
      pending.current=null;setReceipt(saved);setReason('');setUncertain(false);setConfirmed(false);setMessage('Decisão registrada. O professor já pode consultar sua resposta.');
    }catch(e){if(!mounted.current)return;
      if(!e.response || e.response.status>=500){setUncertain(true);setMessage('Não recebemos a confirmação. Confira o mesmo pedido para não duplicar a decisão.');}
      else{pending.current=null;setUncertain(false);setConflict(e.response.status===409);setMessage(e.response.data?.error || 'Não foi possível registrar a decisão.');}
    }finally{lock.current=false;if(mounted.current)setBusy(false);}
  }
  return <AssessmentDialog title="Conferir envio do professor" closeDisabled={busy} onClose={close}><div className="space-y-4 p-3 sm:p-4">
    {result.status==='loading' && !receipt && <p role="status">Carregando questão…</p>}
    {result.status==='error' && !receipt && <div role="alert"><p>Não foi possível carregar este envio.</p><button className="btn-outline" onClick={result.retry}>Tentar novamente</button></div>}
    {review && <><p className="text-sm font-semibold">{review.authorName} · {numericStatusLabel[review.status]}</p><NumericDraftReview preview={{draft:review.draft}} reviewing decisionPending={review.status==='pending'} />
      {review.reason && <section className={surface}><h3 className="font-semibold">Resposta enviada ao professor</h3><p className="mt-2 whitespace-pre-wrap break-words text-sm">{review.reason}</p></section>}
      {review.status==='pending' && <fieldset disabled={busy||uncertain||conflict} className="space-y-3 border-t border-slate-200 pt-4 dark:border-white/10"><legend className="font-bold">Sua decisão</legend>
        <label className="block text-sm font-semibold">Comentário para o professor<textarea className="input mt-1 min-h-24" value={reason} maxLength={1000} onChange={e=>setReason(e.target.value)} placeholder="Explique o que está adequado ou o que precisa ser ajustado." /><span className="text-xs font-normal">De 10 a 1.000 caracteres. O professor receberá este comentário.</span></label>
        <label className="flex min-h-11 items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} onChange={e=>setConfirmed(e.target.checked)} />Conferi o enunciado, a habilidade BNCC, o gabarito e a resolução.</label>
        <p className="text-sm">A aprovação permite usar esta versão em papel e nas atividades on-line do professor com o piloto liberado. Não publica no banco geral nem abre uma atividade.</p>
        <div className="flex flex-wrap gap-2"><button className="btn-primary" disabled={!confirmed||reason.trim().length<10} onClick={()=>decide('approved')}>Aprovar questão</button><button className="btn-outline" disabled={!confirmed||reason.trim().length<10} onClick={()=>decide('rejected')}>Pedir ajustes</button></div>
      </fieldset>}</>}
    {message && <div ref={notice} tabIndex={-1} role={uncertain||conflict?'alert':'status'} className={surface+' space-y-2 text-sm outline-none'}><p>{message}</p>
      {uncertain && <button className="btn-outline" disabled={busy} onClick={()=>decide()}>Conferir pedido de decisão</button>}
      {conflict && <button className="btn-outline" onClick={()=>{setConflict(false);setReceipt(null);setConfirmed(false);setMessage('');result.retry();}}>Reabrir envio atualizado</button>}</div>}
  </div></AssessmentDialog>;
}
