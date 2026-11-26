import { useState } from 'react';
import AssessmentDialog from './AssessmentDialog';
import useHomeResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { parseRosterReadiness, rosterIssue } from '../services/assessmentRoster.mjs';
import api from '../services/api';
import { formatCount } from '../utils/pluralize';

export default function AssessmentExemptionDialog({ schoolClass, assignment, onClose, onChanged }) {
  const base = `/classes/${schoolClass.id}/assessments/${assignment.id}`;
  const resource = useHomeResource(`${base}/readiness`, schoolClass.id, parseRosterReadiness);
  const action = useMaterialAction();
  const [selected, setSelected] = useState(null);
  const [reason, setReason] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const data = resource.data;
  const remaining = data?.participants.filter(p => p.status !== 'exempted').length || 0;
  const canEdit = resource.status === 'ready' && data.classActive && data.assignment.status === 'draft';
  function refresh() { setSelected(null); setReason(''); setConfirmed(false); resource.retry(); }
  function submit(event) {
    event.preventDefault();
    if (!canEdit || !confirmed || !reason || !selected || action.busy) return;
    setError('');
    action.run(() => api.post(`${base}/participants/${selected.id}/exemption`, {
      expectedRevision: data.assignment.revision, reason, confirmation: 'DISPENSAR_ESTUDANTE',
    }, { timeout: 15000 }), {
      message: 'Dispensa registrada. O histórico foi preservado.',
      refresh: () => { refresh(); onChanged(); }, onError: setError,
    });
  }
  return <AssessmentDialog title="Dispensar da avaliação" onClose={onClose} closeDisabled={action.busy}>
    <div className="space-y-3 p-4">
      <p className="break-words font-bold">{assignment.title}</p>
      <p className="text-sm text-slate-600 dark:text-slate-300">Use antes da abertura, para quem não fará esta avaliação. A matrícula na turma não muda.</p>
      {error && <p role="alert" className="text-sm text-rose-700 dark:text-rose-300">{error}</p>}
      {resource.status === 'loading' && <p role="status">Conferindo os participantes…</p>}
      {resource.status === 'error' && <p role="alert">Não foi possível conferir os participantes. Atualize antes de continuar.</p>}
      {resource.status === 'ready' && !canEdit && <p role="alert">A aplicação mudou. A dispensa exige turma ativa e rascunho. Se estiver agendada, retire o agendamento primeiro.</p>}
      {resource.status === 'ready' && !selected && <>
        <p className="text-sm font-semibold">{formatCount(remaining, 'participante', 'participantes')} · {formatCount(data.assignment.roster.exemptedCount || 0, 'dispensado', 'dispensados')}</p>
        <ul className="divide-y divide-slate-200 dark:divide-white/10">{data.participants.map(p => <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 py-3">
          <div className="min-w-0 flex-1 basis-40"><p className="break-words font-semibold">{p.displayName}</p><p className="text-xs text-slate-600 dark:text-slate-300">{rosterIssue(p) || 'Matriculado'}{p.status !== 'exempted' && !p.canExempt ? ' · Possui tentativa de resposta; dispensa indisponível.' : ''}</p></div>
          {p.status !== 'exempted' && <button type="button" className="btn-outline" disabled={action.busy || !canEdit || !p.canExempt || remaining <= 1} onClick={() => { setSelected(p); setError(''); }} aria-label={`Dispensar ${p.displayName}`}>Dispensar</button>}
        </li>)}</ul>
        {remaining <= 1 && <p className="text-sm">Mantenha pelo menos um participante. Se ninguém for realizar a avaliação, mantenha o rascunho sem disponibilizar.</p>}
      </>}
      {selected && canEdit && <form onSubmit={submit} className="space-y-3">
        <p className="break-words font-semibold">Dispensar {selected.displayName}?</p>
        <p className="rounded-xl bg-amber-50 p-3 text-sm text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">O código deixará de funcionar. O registro continuará no histórico, sem contar como falta ou nota zero. Esta dispensa não poderá ser desfeita nesta aplicação.</p>
        <label className="block text-sm font-semibold">Motivo<select aria-label="Motivo" className="input mt-1" value={reason} required disabled={action.busy} onChange={e => { setReason(e.target.value); setConfirmed(false); }}><option value="">Selecione</option><option value="enrollment_changed">Mudança na matrícula</option><option value="selection_correction">Correção da seleção desta avaliação</option></select></label>
        <label className="flex items-start gap-2 text-sm"><input type="checkbox" className="mt-1" checked={confirmed} disabled={action.busy} onChange={e => setConfirmed(e.target.checked)} />Conferi o estudante e quero registrar a dispensa.</label>
        <div className="flex flex-wrap gap-2"><button type="button" className="btn-outline" disabled={action.busy} onClick={() => { setSelected(null); setReason(''); setConfirmed(false); }}>Voltar à lista</button><button type="submit" className="btn-primary" disabled={action.busy || !confirmed || !reason}>{action.busy ? 'Registrando…' : 'Confirmar dispensa'}</button></div>
      </form>}
      {!selected && <button type="button" className="btn-outline" disabled={action.busy || resource.status === 'loading'} onClick={() => { setError(''); refresh(); }}>Atualizar participantes</button>}
    </div>
  </AssessmentDialog>;
}
