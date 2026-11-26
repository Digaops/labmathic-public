import AssessmentDialog from './AssessmentDialog';
import { useEffect, useState } from 'react';
import useHomeResource from '../hooks/useHomeResource';
import { parseRosterReadiness, rosterIssue } from '../services/assessmentRoster.mjs';
import { formatCount } from '../utils/pluralize';
import {
  AlarmClock,
  ArrowRight,
  CalendarClock,
  CheckCircle2,
  Clock3,
  LockKeyhole,
  RefreshCw,
  Rocket,
  ShieldAlert,
  ShieldCheck,
  X,
} from 'lucide-react';
import { isoToLocalInput, localInputToIso } from '../utils/classAssessments';

const actionContent = {
  open_now: {
    title: 'Disponibilizar agora',
    description: 'A aplicação ficará disponível imediatamente para os estudantes selecionados.',
    consequence: 'O conteúdo e os participantes não poderão mais ser alterados. Depois disso, a aplicação só poderá ser encerrada ou cancelada.',
    button: 'Disponibilizar agora',
    tone: 'primary',
  },
  return_to_draft: {
    title: 'Voltar ao rascunho',
    description: 'O agendamento será retirado antes que a aplicação seja aberta.',
    consequence: 'O professor poderá voltar a editar período, regras e estudantes e fazer um novo agendamento depois.',
    button: 'Voltar ao rascunho',
    tone: 'neutral',
  },
  close: {
    title: 'Encerrar aplicação',
    description: 'Novos acessos serão interrompidos e o encerramento será registrado.',
    consequence: 'Esta ação é definitiva para esta aplicação. As respostas já registradas serão preservadas para consulta e correção.',
    button: 'Encerrar agora',
    tone: 'danger',
  },
  cancel: {
    title: 'Cancelar aplicação',
    description: 'A aplicação deixará de ficar disponível ou agendada.',
    consequence: 'O cancelamento é definitivo e fica registrado na auditoria. O conteúdo preservado não será apagado.',
    button: 'Cancelar aplicação',
    tone: 'danger',
  },
};

export default function ClassAssessmentDeliveryModal({ schoolClass, assignment, action, saving, requestError, onClose, onConfirm, onEditParticipants, onReadinessRetry }) {
  const hasFutureOpening = assignment.opensAt && Date.parse(assignment.opensAt) > Date.now();
  const [mode, setMode] = useState(hasFutureOpening ? 'scheduled' : 'now');
  const [opensAt, setOpensAt] = useState(isoToLocalInput(assignment.opensAt));
  const [closesAt, setClosesAt] = useState(isoToLocalInput(assignment.closesAt));
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const isPublish = action === 'publish';
  const needsRoster = isPublish || action === 'open_now';
  const readiness = useHomeResource(needsRoster ? `/classes/${schoolClass.id}/assessments/${assignment.id}/readiness` : null, schoolClass.id, parseRosterReadiness);
  const ineligible = readiness.data?.participants.filter(person => person.status !== 'exempted' && !person.eligible) || [];
  const stale = readiness.data && (readiness.data.assignment.revision !== assignment.revision || readiness.data.assignment.status !== assignment.status);
  const rosterBlocked = needsRoster && (readiness.status !== 'ready' || stale || !readiness.data.classActive || ineligible.length > 0 || !readiness.data.assignment.roster.eligibleCount);
  function refreshRoster() { setConfirmed(false); onReadinessRetry?.(); readiness.retry(); }
  useEffect(() => { if (requestError && needsRoster) { setConfirmed(false); readiness.retry(); } }, [requestError]);
  const content = isPublish ? {
    title: 'Disponibilizar simulado',
    description: 'Escolha quando a aplicação ficará disponível para a turma.',
    button: mode === 'scheduled' ? 'Confirmar agendamento' : 'Disponibilizar agora',
    tone: 'primary',
  } : actionContent[action];




  function submit(event) {
    event.preventDefault();
    setError('');
    if (saving || rosterBlocked) return;
    if (!confirmed) {
      setError('Confirme que revisou as informações antes de continuar.');
      return;
    }
    if (isPublish) {
      const normalizedOpening = mode === 'scheduled' ? localInputToIso(opensAt) : null;
      const normalizedClosing = localInputToIso(closesAt);
      if (mode === 'scheduled' && (!normalizedOpening || Date.parse(normalizedOpening) <= Date.now())) {
        setError('Escolha uma data futura para a abertura.');
        return;
      }
      if (closesAt && !normalizedClosing) {
        setError('Informe uma data válida para o encerramento.');
        return;
      }
      const comparisonOpening = normalizedOpening || new Date().toISOString();
      if (normalizedClosing && Date.parse(normalizedClosing) <= Date.parse(comparisonOpening)) {
        setError('O encerramento precisa acontecer depois da abertura.');
        return;
      }
      onConfirm({
        action: mode === 'scheduled' ? 'schedule' : 'open',
        ...(mode === 'scheduled' ? { opensAt: normalizedOpening } : {}),
        closesAt: normalizedClosing,
      });
      return;
    }
    onConfirm({ action: action === 'open_now' ? 'open' : action });
  }

  return (
    <AssessmentDialog title={content.title} onClose={onClose} closeDisabled={saving}>
      <form onSubmit={submit} data-delivery-dialog>
        <p className="px-4 pt-3 text-sm text-slate-600 dark:text-slate-300">{content.description}</p>
        <div className="p-4">
          <div className="rounded-2xl border border-neutral-200 bg-neutral-50/70 p-4 dark:border-white/10 dark:bg-white/[0.025]">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0"><p className="text-[10px] font-black uppercase tracking-wide text-neutral-400">Aplicação selecionada</p><h3 className="mt-1 break-words font-black text-neutral-900 dark:text-white">{assignment.title}</h3></div>
              <LockKeyhole className="shrink-0 text-cyan-500" size={20} />
            </div>
            <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-bold text-neutral-500 dark:text-neutral-400"><span>{formatCount(assignment.questionCount, 'questão', 'questões')}</span><span>{formatCount(assignment.participantCount - (assignment.roster?.exemptedCount || 0), 'participante', 'participantes')}</span>{assignment.timeLimitMinutes && <span>{assignment.timeLimitMinutes} minutos</span>}</div>
          </div>

          {needsRoster && <section aria-label="Conferência das matrículas" className="mt-3 rounded-xl border border-slate-200 p-3 text-sm dark:border-white/10">
            {readiness.status === 'loading' && <p role="status">Conferindo as matrículas dos estudantes…</p>}
            {readiness.status === 'error' && <p role="alert">Não foi possível conferir as matrículas. Tente novamente antes de disponibilizar.</p>}
            {readiness.status === 'ready' && <>
              {stale ? <p role="alert">A aplicação mudou em outro acesso. Volte à lista e confira os dados atuais.</p>
                : !readiness.data.classActive ? <p role="alert">A turma está arquivada. Restaure a turma antes de disponibilizar.</p>
                : !readiness.data.assignment.roster.eligibleCount ? <p role="alert">Selecione pelo menos um estudante antes de disponibilizar.</p>
                : ineligible.length ? <div role="alert">
                  <p className="font-bold text-amber-800 dark:text-amber-200">Revise as matrículas antes de continuar</p>
                  <ul className="mt-2 space-y-1">{ineligible.map(person => <li key={person.id} className="break-words">{person.displayName} · {rosterIssue(person)}</li>)}</ul>
                  <p className="mt-2 text-xs">{assignment.status === 'scheduled' ? 'Retire o agendamento para conferir a lista. A abertura automática ficará aguardando a regularização.' : 'Edite os participantes para conferir a seleção ou regularize a matrícula na turma.'} Nenhum estudante foi retirado automaticamente.</p>
                </div> : <p className="text-emerald-800 dark:text-emerald-200">Matrículas conferidas: {formatCount(readiness.data.assignment.roster.eligibleCount, 'estudante apto', 'estudantes aptos')} para participar.</p>}
            </>}
            <div className="mt-2 flex flex-wrap gap-2">
              <button type="button" disabled={saving || readiness.status === 'loading'} className="btn-outline" onClick={refreshRoster}>Conferir novamente</button>
              {assignment.status === 'draft' && ineligible.length > 0 && <button type="button" disabled={saving} className="btn-outline" onClick={onEditParticipants}>Editar participantes</button>}
            </div>
          </section>}

          {isPublish && !rosterBlocked && (
            <div className="mt-3">
              <p className="text-xs font-black uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Quando disponibilizar?</p>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <button type="button" disabled={saving} onClick={() => setMode('now')} className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${mode === 'now' ? 'border-cyan-400 bg-cyan-50 text-cyan-900 dark:bg-cyan-400/10 dark:text-cyan-100' : 'border-neutral-200 dark:border-white/10'}`} aria-pressed={mode === 'now'}>
                  <Rocket size={17} aria-hidden="true" />Agora
                </button>
                <button type="button" disabled={saving} onClick={() => setMode('scheduled')} className={`flex items-center justify-center gap-2 rounded-xl border p-3 text-sm font-bold disabled:cursor-not-allowed disabled:opacity-60 ${mode === 'scheduled' ? 'border-violet-400 bg-violet-50 text-violet-900 dark:bg-violet-400/10 dark:text-violet-100' : 'border-neutral-200 dark:border-white/10'}`} aria-pressed={mode === 'scheduled'}>
                  <CalendarClock size={17} aria-hidden="true" />Agendar
                </button>
              </div>
              <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{mode === 'now' ? 'Abertura imediata após sua confirmação.' : 'Abertura automática na data escolhida.'}</p>

              <div className="mt-3 grid gap-4 sm:grid-cols-2">
                {mode === 'scheduled' && <label><span className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"><AlarmClock size={14} /> Abertura</span><input type="datetime-local" className="input" value={opensAt} onChange={(event) => setOpensAt(event.target.value)} disabled={saving} required /></label>}
                <label className={mode === 'now' ? 'sm:col-span-2' : ''}><span className="mb-1.5 flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400"><Clock3 size={14} /> Encerramento opcional</span><input type="datetime-local" className="input" value={closesAt} onChange={(event) => setClosesAt(event.target.value)} disabled={saving} /></label>
              </div>
            </div>
          )}

          {!rosterBlocked && <><div className={`mt-3 rounded-2xl border p-4 ${content.tone === 'danger' ? 'border-rose-200 bg-rose-50 dark:border-rose-400/20 dark:bg-rose-400/5' : 'border-amber-200 bg-amber-50 dark:border-amber-400/20 dark:bg-amber-400/5'}`}>
            <div className="flex items-start gap-3"><ShieldAlert className={content.tone === 'danger' ? 'shrink-0 text-rose-500' : 'shrink-0 text-amber-500'} aria-hidden="true" size={20} /><div className="min-w-0"><p className="text-sm font-black text-neutral-900 dark:text-white">Antes de confirmar</p><p className="mt-1 text-xs leading-relaxed text-neutral-600 dark:text-neutral-300">{isPublish ? (mode === 'scheduled' ? 'Até a abertura automática, você poderá retirar o agendamento e voltar ao rascunho.' : 'Depois de abrir, não será possível alterar o conteúdo ou os estudantes. Você poderá encerrar ou cancelar a aplicação.') : content.consequence}</p></div></div>
          </div>

          <label className="mt-3 flex cursor-pointer items-start gap-3 rounded-2xl border border-neutral-200 p-4 dark:border-white/10">
            <input type="checkbox" className="mt-0.5 h-4 w-4 rounded border-neutral-300 text-cyan-500 focus:ring-cyan-400" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} disabled={saving || rosterBlocked} />
            <span className="text-sm font-semibold leading-relaxed text-neutral-700 dark:text-neutral-200">Conferi o simulado, os estudantes e as datas. Confirmo esta alteração.</span>
          </label></>}
          {(error || requestError) && <p role="alert" className="mt-3 text-sm font-bold text-rose-600 dark:text-rose-300">{error || requestError}</p>}
        </div>

        <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50/70 px-4 py-3 dark:border-white/10 dark:bg-white/[0.02] sm:px-4">
          <button type="button" className="btn-outline" disabled={saving} onClick={onClose}><X size={16} /> Voltar</button>
          <button type="submit" disabled={saving || !confirmed || rosterBlocked} className={content.tone === 'danger' ? 'inline-flex items-center justify-center gap-2 rounded-xl bg-rose-600 px-4 py-2.5 text-sm font-bold text-white transition hover:bg-rose-700 disabled:cursor-not-allowed disabled:opacity-50' : 'btn-primary'}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <CheckCircle2 size={16} />}{content.button}<ArrowRight size={15} /></button>
        </footer>
      </form>
    </AssessmentDialog>
  );
}
