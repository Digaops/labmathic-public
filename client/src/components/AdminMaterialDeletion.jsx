import { useState } from 'react';
import AssessmentDialog from './AssessmentDialog';

const button = 'inline-flex min-h-11 items-center justify-center rounded-xl border border-slate-300 px-3 py-2 text-sm font-semibold disabled:opacity-40 dark:border-white/20';
export default function AdminMaterialDeletion({ action }) {
  const { review, busy } = action;
  const [confirmed, setConfirmed] = useState(false);
  const title = review.bulk ? 'Excluir materiais selecionados' : 'Excluir material';
  const readyToDelete = review.state === 'ready' && !review.uncertain && !review.missingIds.length && review.materials.length > 0;
  return <AssessmentDialog title={title} onClose={action.close} closeDisabled={busy}>
    <div data-admin-material-delete className="space-y-3 p-3 sm:p-4">
      <p className="text-sm leading-6">A exclusão tira os materiais da biblioteca e dos laboratórios e revoga seus links compartilhados. Registros de recuperação ficam reservados à administração técnica; não há botão de desfazer aqui.</p>
      {review.state === 'loading' && <p role="status">Conferindo a seleção atual…</p>}
      {review.error && <p role="alert" className="rounded-xl bg-amber-50 p-3 text-sm leading-6 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">{review.error}</p>}
      {review.materials.length > 0 && <><p className="text-sm font-semibold">{review.materials.length} {review.materials.length === 1 ? 'material conferido' : 'materiais conferidos'}</p><ul className="divide-y divide-slate-200 rounded-xl border border-slate-200 px-3 dark:divide-white/10 dark:border-white/10">{review.materials.map(m => <li key={m.id} className="py-2 text-sm"><strong className="block break-words">{m.title}</strong><span className="text-slate-600 dark:text-slate-300">Código {m.id}</span></li>)}</ul></>}
      {review.state === 'ready' && review.missingIds.length > 0 && <p role="status" className="text-sm leading-6">{review.missingIds.length} {review.missingIds.length === 1 ? 'material não consta mais' : 'materiais não constam mais'} no acervo. {review.materials.length ? 'Revise os que permanecem antes de enviar qualquer nova exclusão.' : 'Não é necessário enviar outra exclusão.'}</p>}
      {review.state === 'ready' && review.uncertain && !review.missingIds.length && <p role="status" className="text-sm leading-6">Os materiais ainda constam no acervo. A consulta não prova que o pedido anterior terminou. Aguarde e confira novamente antes de iniciar uma nova revisão.</p>}
      {readyToDelete && <label className="flex min-h-11 items-center gap-3 text-sm leading-6"><input type="checkbox" disabled={busy} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} />Conferi os nomes e quero excluir estes materiais.</label>}
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={busy} onClick={action.close}>Cancelar</button>
        {readyToDelete && <button type="button" className={button + ' bg-red-700 text-white'} disabled={busy || !confirmed} onClick={() => { action.remove(confirmed); setConfirmed(false); }}>{busy ? 'Excluindo…' : review.bulk ? 'Excluir seleção conferida' : 'Confirmar exclusão'}</button>}
        {!busy && review.state !== 'loading' && !readyToDelete && <button type="button" className={button} onClick={() => { setConfirmed(false); action.check(review.ids, { uncertain: review.uncertain, bulk: review.bulk }); }}>Conferir no acervo</button>}
        {!busy && review.state === 'ready' && review.materials.length > 0 && (review.uncertain || review.missingIds.length > 0) && <button type="button" className={button} onClick={() => { setConfirmed(false); action.restart(); }}>Iniciar nova revisão</button>}
        {!busy && review.state === 'ready' && !review.materials.length && <button type="button" className={button} onClick={action.acknowledgeGone}>Concluir conferência</button>}
      </div>
    </div>
  </AssessmentDialog>;
}
