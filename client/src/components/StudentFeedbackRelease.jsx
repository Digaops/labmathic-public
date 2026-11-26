import { useRef, useState } from 'react';
import { RefreshCw, Send } from 'lucide-react';
import api from '../services/api';
import { sendStudentFeedback } from '../services/studentFeedbackView.mjs';

export default function StudentFeedbackRelease({ basePath, participant, attempt, assessmentStatus, existing,
  draft, onDraftChange, onBusyChange, onReleased }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const sending = useRef(false);
  const operation = useRef(null);
  const { message, confirmed } = draft;
  const panel = 'rounded-2xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-400/20 dark:bg-violet-400/5';

  if (existing) return <aside data-student-feedback role="status" className={panel}>
    <h3 className="text-sm font-bold text-violet-800 dark:text-violet-200">Orientação enviada para {participant.displayName}</h3>
    <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">{existing.message}</p>
    <p className="mt-3 text-xs text-slate-600 dark:text-slate-300">O estudante pode ler a orientação ao entrar com seu código. Depois de enviada, ela não pode ser alterada.</p>
  </aside>;

  if (assessmentStatus !== 'closed') return <aside data-student-feedback className={panel}>
    <h3 className="text-sm font-bold text-violet-800 dark:text-violet-200">Orientação para o estudante</h3>
    <p className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">Encerre a aplicação para enviar uma orientação individual. Assim, todos terminam a avaliação antes de receber ajuda.</p>
  </aside>;

  async function release() {
    if (sending.current || !confirmed || message.trim().length < 10) return;
    const body = { message: message.trim(), confirmed: true, expectedRevision: attempt.revision };
    const signature = JSON.stringify(body);
    if (operation.current?.signature !== signature) {
      operation.current = { signature, body, key: crypto.randomUUID() };
    }
    sending.current = true; setBusy(true); onBusyChange(true); setError('');
    try {
      const feedback = await sendStudentFeedback(api, `${basePath}/participants/${participant.id}`, operation.current);
      onReleased(feedback);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Não conseguimos confirmar o envio. Seu texto continua aqui; tente enviar novamente. A mensagem não será duplicada.');
    } finally { sending.current = false; setBusy(false); onBusyChange(false); }
  }

  return <aside data-student-feedback className={panel} aria-busy={busy}>
    <h3 className="text-sm font-bold text-violet-800 dark:text-violet-200">Orientação para {participant.displayName}</h3>
    <p id="feedback-help" className="mt-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200">Indique o que o estudante pode revisar ou tentar agora. Ele verá a mensagem ao entrar novamente com seu código.</p>
    <label htmlFor="student-feedback-message" className="mt-3 block text-sm font-semibold text-slate-800 dark:text-slate-200">Sua orientação</label>
    <textarea id="student-feedback-message" aria-describedby="feedback-help feedback-count" value={message} onChange={event => onDraftChange({ message: event.target.value, confirmed: false })} rows={4} maxLength={2000} className="input mt-2 min-h-28 w-full resize-y" placeholder="Ex.: Compare 1/2 e 1/4 desenhando duas figuras do mesmo tamanho. O que você percebe?" disabled={busy} />
    <p id="feedback-count" className="mt-1 text-xs text-slate-600 dark:text-slate-300">{message.length}/2.000 caracteres · mínimo de 10</p>
    <label className="mt-3 flex min-h-11 cursor-pointer items-start gap-3 py-2 text-sm leading-relaxed text-slate-700 dark:text-slate-200"><input type="checkbox" checked={confirmed} onChange={event => onDraftChange({ ...draft, confirmed: event.target.checked })} disabled={busy} className="mt-1 h-4 w-4 shrink-0" /> Revisei o texto e confirmei que é somente para este estudante.</label>
    {error && <p role="alert" className="mt-2 text-sm text-rose-700 dark:text-rose-300">{error}</p>}
    <div className="mt-3 flex flex-wrap items-center justify-between gap-3"><span className="text-xs text-slate-600 dark:text-slate-300">Depois de enviar, não será possível editar.</span><button type="button" className="btn-primary min-h-11" disabled={busy || !confirmed || message.trim().length < 10} onClick={release}>{busy ? <RefreshCw aria-hidden="true" className="animate-spin" size={16} /> : <Send aria-hidden="true" size={16} />} {busy ? 'Confirmando envio…' : 'Enviar orientação'}</button></div>
  </aside>;
}
