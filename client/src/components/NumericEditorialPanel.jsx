import { useState } from 'react';
import { numericStatusLabels } from '../services/numericDraftView.mjs';

export default function NumericEditorialPanel({ draft, dirty, busy, uncertain, conflict, onAction, onRetry, onOpen }) {
  const [confirmed,setConfirmed]=useState(false);
  const status=draft.status==='approved'?'approved':draft.review?.status || 'draft';
  const blocked=busy||uncertain||conflict||dirty;
  const submitReady=draft.explanation.trim().length>=10;
  return <section aria-label="Revisão da questão" className="space-y-2 rounded-xl border border-slate-200 p-3 text-sm dark:border-white/15">
    <div className="flex flex-wrap items-center justify-between gap-2"><h3 className="font-bold">Versão {draft.version || 1} · {numericStatusLabels[status]}</h3>
      {draft.versions?.length>1 && <label>Versão <select aria-label="Consultar versão da questão" className="input w-auto" value={draft.publicId} disabled={busy||uncertain} onChange={e=>onOpen(e.target.value)}>{draft.versions.map(v=><option key={v.publicId} value={v.publicId}>{v.version} · {numericStatusLabels[v.status]}</option>)}</select></label>}
    </div>
    {draft.review?.reason && <p className="whitespace-pre-wrap break-words"><strong>Retorno da revisão: </strong>{draft.review.reason}</p>}
    {uncertain ? <><p>O pedido pode ter sido concluído. Confira o mesmo envio antes de fazer outro.</p><button className="btn-outline" disabled={busy} onClick={onRetry}>Conferir pedido de revisão</button></>
      : status==='pending' ? <><p>A administração está com a versão enviada. Para editar, retire o envio primeiro.</p><button className="btn-outline" disabled={blocked} onClick={()=>onAction(`/reviews/${draft.review.publicId}/withdraw`,{expectedRevision:draft.review.revision})}>Retirar envio para ajustar</button></>
      : status==='approved' ? <><p>Versão preservada. Imprima sem gabarito pela prévia ou selecione esta versão nas aplicações da turma, quando o piloto numérico estiver liberado.</p>
        {draft.versions?.[0]?.publicId===draft.publicId && <button className="btn-outline" disabled={blocked} onClick={()=>onAction(`/${draft.publicId}/versions`,{expectedRevision:draft.revision})}>Criar nova versão para editar</button>}</>
      : <>
        {dirty ? <p>Salve suas alterações antes de enviar.</p> : !submitReady ? <p>Antes de enviar, registre como chegar à resposta no campo de resolução.</p> : <label className="flex min-h-11 items-start gap-2 py-2"><input className="mt-1 h-5 w-5 shrink-0" type="checkbox" checked={confirmed} disabled={blocked} onChange={e=>setConfirmed(e.target.checked)} /><span>Conferi o enunciado, a habilidade BNCC e a resposta esperada.</span></label>}
        <button className="btn-primary" disabled={blocked||!confirmed||!submitReady} onClick={()=>onAction(`/${draft.publicId}/submit-review`,{expectedRevision:draft.revision,confirmed:true})}>{status==='rejected'?'Reenviar para revisão':'Enviar para revisão'}</button>
      </>}
    {draft.reviews?.length>0 && <details><summary className="cursor-pointer py-2 font-semibold">Histórico dos envios ({draft.reviews.length})</summary><ol className="space-y-2">{draft.reviews.map(r=><li key={r.publicId} className="border-t border-slate-200 pt-2 dark:border-white/10"><strong>{numericStatusLabels[r.status]}</strong>{r.reason && <p className="whitespace-pre-wrap break-words">{r.reason}</p>}</li>)}</ol></details>}
  </section>;
}
