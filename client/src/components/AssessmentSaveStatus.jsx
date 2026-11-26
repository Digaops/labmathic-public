import { AlertTriangle, CheckCircle2, CloudUpload, LoaderCircle, RefreshCw } from 'lucide-react';
import {hasResponse,isNumeric,responseValue} from '../services/numericResponse.mjs';

export default function AssessmentSaveStatus({ state, controller }) {
  const pending = state?.pendingIds.length || 0;
  const submitted = state?.portal?.attempt?.status === 'submitted';
  const busy = !state || state.busy;
  const warning = pending > 0 || state?.phase === 'offline' || state?.phase === 'blocked'
    || (!submitted && state?.expired) || state?.uncertain || !state?.storageAvailable;
  const title = state?.uncertain ? 'Verificando a entrega'
    : state?.phase === 'blocked' ? 'Este acesso precisa de atenção'
      : submitted ? (pending ? 'Confira a entrega com o professor' : 'Entrega confirmada')
        : state?.expired ? 'Prazo encerrado · conferindo a entrega'
          : state?.conflicts.length ? 'Há respostas diferentes em outro acesso'
            : busy ? (state?.phase === 'saving' ? 'Salvando suas respostas' : 'Conferindo suas respostas')
              : pending ? pending + (pending === 1 ? ' resposta aguardando confirmação' : ' respostas aguardando confirmação')
                : state?.phase === 'offline' ? 'Sem conexão para confirmar as respostas'
                  : state?.portal?.items.some(hasResponse) ? 'Respostas salvas' : 'Pronto para responder';
  const Icon = busy ? LoaderCircle : warning ? CloudUpload : CheckCircle2;
  return (
    <div data-assessment-save-status className={'rounded-xl border p-3 text-sm ' + (warning
      ? 'border-amber-200 bg-amber-50 text-amber-950 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-100'
      : 'border-emerald-200 bg-emerald-50 text-emerald-950 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-100')}>
      <div role="status" aria-live="polite" className="flex items-start gap-3">
        <Icon size={19} className={'mt-0.5 shrink-0 ' + (busy ? 'animate-spin' : '')} />
        <div className="min-w-0"><p className="font-bold">{title}</p>
          {state?.message && <p className="mt-1 text-xs leading-relaxed">{state.message}</p>}
          {!submitted && pending > 0 && !state?.expired && !state?.conflicts.length && <p className="mt-1 text-xs leading-relaxed">Você pode continuar respondendo. Aguarde a confirmação antes de entregar e mantenha esta aba aberta.</p>}
          {!state?.storageAvailable && state && <p className="mt-2 flex gap-2 text-xs font-bold"><AlertTriangle size={16} className="shrink-0" /> O navegador não conseguiu guardar a cópia de recuperação. Não recarregue nem feche esta aba; avise o professor.</p>}
          {!submitted && state?.expired && <p className="mt-1 text-xs leading-relaxed">Somente as respostas recebidas dentro do prazo entram na entrega. As respostas pendentes nesta aba não ampliam o tempo da avaliação.</p>}
        </div>
      </div>
      {!submitted && !busy && state?.phase !== 'blocked' && !state?.conflicts.length && (pending > 0 || state?.phase === 'offline' || state?.expired || state?.uncertain) && <button type="button" className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-xl border border-current px-3 py-2 text-xs font-bold" onClick={() => controller.current?.retry()}><RefreshCw size={14} /> {state?.uncertain || state?.expired ? 'Conferir entrega' : 'Conferir conexão e salvar'}</button>}
      {!submitted && state?.conflicts.map((id) => {
        const item = state.portal.items.find((entry) => entry.id === id);
        if (!item) return null;
        const label = (value) => isNumeric(item) ? value===null || value==='' ? 'sem resposta' : String(value).replace('.',',')
          : item.options.find((option) => option.id === value)?.label || 'sem resposta';
        return <div key={id} className="mt-3 border-t border-current/20 pt-3"><p className="text-xs leading-relaxed">Questão {item.number}: nesta aba, <strong>{label(responseValue(item))}</strong>; já salva em outro acesso, <strong>{label(state.serverSelections[id])}</strong>. Escolha qual manter.</p><div className="mt-2 flex flex-wrap gap-2"><button type="button" disabled={busy || state.expired} onClick={() => controller.current?.resolve(id, false)} className="min-h-11 rounded-lg border border-current px-3 py-2 text-xs font-bold">Usar resposta já salva · {item.number}</button><button type="button" disabled={busy || state.expired} onClick={() => controller.current?.resolve(id, true)} className="min-h-11 rounded-lg border border-current px-3 py-2 text-xs font-bold">Manter minha escolha · {item.number}</button></div></div>;
      })}
    </div>
  );
}
