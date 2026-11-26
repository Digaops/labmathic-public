import {isNumeric,answerPayload} from '../services/numericResponse.mjs';
import AssessmentDialog from './AssessmentDialog';
import { formatCount } from '../utils/pluralize';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { parseResults, parseCorrection, correctionSelections, hasUnsavedResponses, filterResultParticipants } from '../services/assessmentView.mjs';
import { useEffect, useMemo, useRef, useState } from 'react';

import {
  AlertTriangle,
  ArrowLeft,
  BarChart3,
  BookOpenCheck,
  Check,
  CheckCircle2,
  CircleDashed,
  ClipboardCheck,
  RefreshCw,
  Save,
  ShieldCheck,
  Sparkles,
  Target,
  UserRoundCheck,
  UsersRound,
  X,
} from 'lucide-react';
import api from '../services/api';
import LearningRecoveryReview from './LearningRecoveryReview';
import StudentFeedbackRelease from './StudentFeedbackRelease';

const levelMeta = {
  consolidated: {
    label: 'Consolidada',
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  },
  developing: {
    label: 'Em desenvolvimento',
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  },
  below_expected: {
    label: 'Abaixo do esperado',
    className: 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
  },
  no_data: {
    label: 'Sem dados',
    className: 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
  },
};

function formatPercentage(value) {
  return value === null || value === undefined ? '—' : `${Number(value).toLocaleString('pt-BR', { maximumFractionDigits: 1 })}%`;
}

function ResultsModal({ title, onClose, closeDisabled, children }) {
  return <AssessmentDialog title={title} onClose={onClose} closeDisabled={closeDisabled} wide>{children}</AssessmentDialog>;
}

function MetricCard({ icon: Icon, label, value, helper, tone }) {
  return (
    <div className="results-metric-card rounded-2xl border border-neutral-200 bg-white p-4 dark:border-white/10 dark:bg-white/[0.035]">
      <div className="flex items-center gap-3">
        <span className={`results-metric-card__icon flex h-10 w-10 shrink-0 items-center justify-center rounded-xl ${tone}`}><Icon size={19} /></span>
        <div>
          <p className="results-metric-card__value text-2xl font-black text-neutral-900 dark:text-white">{value}</p>
          <p className="text-xs font-bold text-neutral-600 dark:text-neutral-300">{label}</p>
        </div>
      </div>
      <p className="results-metric-card__helper mt-3 text-xs leading-relaxed text-neutral-400">{helper}</p>
    </div>
  );
}

function ParticipantStatus({ participant }) {
  if (participant.participationStatus === 'exempted') {
    return <span className="rounded-full bg-neutral-100 px-2 py-1 text-[10px] font-black uppercase text-neutral-500 dark:bg-white/10 dark:text-neutral-300">Dispensado</span>;
  }
  if (participant.attemptStatus === 'submitted') {
    return <span className="rounded-full bg-emerald-50 px-2 py-1 text-[10px] font-black uppercase text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">Corrigido</span>;
  }
  if (participant.attemptStatus === 'draft') {
    return <span className="rounded-full bg-amber-50 px-2 py-1 text-[10px] font-black uppercase text-amber-700 dark:bg-amber-400/10 dark:text-amber-300">Em lançamento</span>;
  }
  return <span className="rounded-full bg-blue-50 px-2 py-1 text-[10px] font-black uppercase text-blue-700 dark:bg-blue-400/10 dark:text-blue-300">Pendente</span>;
}

export default function ClassAssessmentResults(props) {
  return <ResultsWorkspace key={`${props.schoolClass.id}:${props.assignment.id}`} {...props} />;
}

function ResultsWorkspace({ schoolClass, assignment, recoveryEnabled = false, feedbackEnabled = false, onClose }) {

  const [entry, setEntry] = useState(null);
  const [feedbackDraft, setFeedbackDraft] = useState({ message: '', confirmed: false });
  const [feedbackBusy, setFeedbackBusy] = useState(false);
  const [selections, setSelections] = useState({});
  const [tab, setTab] = useState('students');
  const action = useMaterialAction();
  const [opening, setOpening] = useState(false);
  const [writeError, setWriteError] = useState('');
  const [studentSearch, setStudentSearch] = useState('');
  const [feedbackFilter, setFeedbackFilter] = useState('all');
  const lastParticipantId = useRef(null);
  const restoreListFocus = useRef(false);
  const studentListHeading = useRef(null);
  const resultsErrorRef = useRef(null);
  const participantRequest = useRef(null);
  const saving = action.busy || opening || feedbackBusy;
  const [recoveryOpen, setRecoveryOpen] = useState(false);
  const recoveryCloseGuard = useRef(() => true);
  const resultsViewportRef = useRef(null);
  const resultsTabsRef = useRef(null);
  const basePath = `/classes/${schoolClass.id}/assessments/${assignment.id}/results`;

  const resource = useReadOnlyResource(basePath, schoolClass.id, parseResults);
  const summary = resource.data;
  const loading = resource.status === 'loading';
  const error = resource.status === 'error';
  const loadSummary = resource.retry;
  const progress = feedbackEnabled ? summary?.feedbackProgress : null;
  const visibleParticipants = filterResultParticipants(summary, studentSearch, feedbackFilter, feedbackEnabled);
  useEffect(() => () => participantRequest.current?.abort(), []);
  useEffect(() => {
    if (entry || loading || !restoreListFocus.current) return;
    restoreListFocus.current = false;
    const row = [...(resultsViewportRef.current?.querySelectorAll('[data-student-id]') || [])]
      .find(element => element.dataset.studentId === String(lastParticipantId.current));
    const target = row?.querySelector('button') || studentListHeading.current || resultsErrorRef.current;
    target?.focus({ preventScroll: true });
    target?.scrollIntoView({ block: 'nearest' });
  }, [entry, loading, summary]);
  const selectResultsTab = nextTab => {
    setTab(nextTab);
    resultsTabsRef.current?.scrollIntoView({ block: 'nearest' });
  };
  function tabKey(event) {
    const tabs = [...event.currentTarget.querySelectorAll('[role="tab"]')], index = tabs.indexOf(document.activeElement);
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].click(); tabs[next].focus();
  }
  function acceptEntry(value) {
    const next = parseCorrection(value); setEntry(next); setSelections(correctionSelections(next));
  }
  async function openParticipant(participant) {
    if (participant.participationStatus === 'exempted' || saving) return;
    lastParticipantId.current = participant.id;
    participantRequest.current?.abort(); const controller = new AbortController(); participantRequest.current = controller;
    setOpening(true); setWriteError('');
    try {
      const response = await api.get(`${basePath}/participants/${participant.id}`, { signal: controller.signal, timeout: 15000 });
      if (!controller.signal.aborted) acceptEntry(response.data);
    } catch {
      if (!controller.signal.aborted) setWriteError('Não foi possível abrir a correção. Tente novamente.');
    } finally { if (!controller.signal.aborted) setOpening(false); }
  }
  const responsePayload = useMemo(() => entry?.items.map(item => answerPayload(item,selections[item.id])) || [], [entry?.items, selections]);
  const dirty = hasUnsavedResponses(entry, selections);
  function leaveEntry() {
    if (saving || ((dirty || (!entry?.feedback && feedbackDraft.message.trim())) && !window.confirm('Há alterações ainda não enviadas. Sair sem salvar essas alterações?'))) return;
    setFeedbackDraft({ message: '', confirmed: false });
    restoreListFocus.current = true;
    setEntry(null); setWriteError('');
  }
  function reloadEntry() {
    if (dirty && !window.confirm('Recarregar descarta as alterações ainda não salvas desta tela. Continuar?')) return;
    openParticipant(entry.participant);
  }
  async function saveDraft() {
    const response = await api.put(`${basePath}/participants/${entry.participant.id}`, {
      expectedRevision: entry.attempt?.revision || 0, responses: responsePayload,
    }, { timeout: 15000 });
    acceptEntry(response.data); return response.data;
  }
  function handleSave() {
    if (!entry || entry.attempt?.status === 'submitted') return;
    setWriteError('');
    action.run(saveDraft, { onError: setWriteError, refresh: loadSummary, message: 'Respostas salvas como rascunho.' });
  }
  function handleSubmit() {
    if (!entry || saving || entry.attempt?.status === 'submitted' || !window.confirm(`Corrigir agora as respostas de ${entry.participant.displayName}? O resultado ficará registrado e não poderá ser alterado.`)) return;
    setWriteError('');
    action.run(async () => {
      const saved = await saveDraft();
      const response = await api.post(`${basePath}/participants/${entry.participant.id}/submit`, { expectedRevision: saved.attempt.revision }, { timeout: 15000 });
      acceptEntry(response.data);
    }, { onError: setWriteError, refresh: loadSummary, message: 'Correção concluída pelo gabarito preservado no simulado.' });
  }

  if (entry) {
    const submitted = entry.attempt?.status === 'submitted';
    return (
      <ResultsModal key={`entry-${entry.participant.id}`} title={`Respostas · ${entry.participant.displayName}`} onClose={leaveEntry} closeDisabled={saving}>
        <div data-correction-entry>
          <div className="flex flex-col gap-2 border-b border-neutral-200 px-4 py-3 dark:border-white/10 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <div className="flex items-center gap-3">
              <button type="button" onClick={leaveEntry} disabled={saving} className="rounded-xl border border-neutral-200 p-2 text-neutral-500 hover:bg-neutral-50 dark:border-white/10 dark:text-neutral-300 dark:hover:bg-white/5" aria-label="Voltar aos resultados"><ArrowLeft size={18} /></button>
              <div>
                <p className="break-words text-sm font-semibold text-neutral-900 dark:text-white">{entry.assessment.title}</p>
                <p className="text-xs text-neutral-500 dark:text-neutral-400">{submitted ? `Resultado: ${formatPercentage(entry.attempt.percentage)} · ${entry.attempt.correctCount} de ${entry.assessment.questionCount}` : 'Lance uma alternativa ou mantenha a questão em branco.'}</p>
              </div>
            </div>
            {submitted && <span className="inline-flex items-center justify-center gap-2 rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm font-black text-emerald-700 dark:border-emerald-400/20 dark:bg-emerald-400/10 dark:text-emerald-200"><ShieldCheck className="shrink-0" aria-hidden="true" size={16} /> Correção concluída — respostas não podem ser alteradas</span>}
          </div>

          <div className="bg-slate-50 p-3 dark:bg-black/10 sm:p-4">
            <div className="mx-auto max-w-4xl space-y-4">
              {entry.items.map((item) => (
                <article data-correction-question key={item.id} className={`rounded-2xl border bg-white p-4 shadow-sm dark:bg-white/[0.035] sm:p-5 ${submitted ? item.isCorrect ? 'border-emerald-200 dark:border-emerald-400/25' : 'border-rose-200 dark:border-rose-400/25' : 'border-neutral-200 dark:border-white/10'}`}>
                  <div className="flex items-start gap-3">
                    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-cyan-50 text-xs font-black text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300">{item.number}</span>
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-[10px] font-black uppercase tracking-wide text-neutral-400">{item.code}</span>
                        {item.skillCode && <span className="rounded-full bg-violet-50 px-2 py-0.5 text-[10px] font-black text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{item.skillCode}</span>}
                        {submitted && (item.isCorrect
                          ? <span className="inline-flex items-center gap-1 text-xs font-black text-emerald-600 dark:text-emerald-300"><CheckCircle2 size={14} /> Acerto</span>
                          : <span className="inline-flex items-center gap-1 text-xs font-black text-rose-600 dark:text-rose-300"><AlertTriangle size={14} /> Erro ou branco</span>)}
                      </div>
                      <p className="mt-2 text-sm font-semibold leading-relaxed text-neutral-800 dark:text-neutral-100">{item.statement}</p>
                    </div>
                  </div>
                  {isNumeric(item) ? <div className="mt-4">
                    <label htmlFor={'correction-numeric-'+item.id} className="text-sm font-bold">Resposta do estudante{item.unit ? ' (em '+item.unit+')' : ''}</label>
                    <input id={'correction-numeric-'+item.id} className="input mt-2 max-w-sm" type="text" inputMode="decimal" maxLength={20}
                      value={selections[item.id] ?? ''} disabled={submitted || saving}
                      onChange={event=>setSelections(current=>({...current,[item.id]:event.target.value}))} />
                    <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{submitted ? 'Resposta esperada: '+String(item.correctNumericValue).replace('.',',') : 'Use vírgula ou ponto decimal, sem separador de milhar. Vazio significa sem resposta.'}</p>
                  </div> : <fieldset className="mt-4 grid gap-2 sm:grid-cols-2" disabled={submitted || saving}>
                    <legend className="sr-only">Resposta da questão {item.number}</legend>
                    {item.options.map((option) => {
                      const selected = selections[item.id] === option.id;
                      const correct = submitted && item.correctOptionId === option.id;
                      const incorrectSelection = submitted && selected && !correct;
                      return (
                        <label key={option.id} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${correct ? 'border-emerald-400 bg-emerald-50 text-emerald-900 ring-2 ring-emerald-400/10 dark:bg-emerald-400/10 dark:text-emerald-100' : incorrectSelection ? 'border-rose-400 bg-rose-50 text-rose-900 dark:bg-rose-400/10 dark:text-rose-100' : selected ? 'border-cyan-400 bg-cyan-50 text-cyan-900 ring-2 ring-cyan-400/10 dark:bg-cyan-400/10 dark:text-cyan-100' : 'border-neutral-200 text-neutral-700 hover:border-cyan-200 dark:border-white/10 dark:text-neutral-200 dark:hover:border-cyan-400/25'} ${submitted ? 'cursor-default' : ''}`}>
                          <input type="radio" name={`item-${item.id}`} checked={selected} onChange={() => setSelections((current) => ({ ...current, [item.id]: option.id }))} className="mt-0.5 h-4 w-4 border-neutral-300 text-cyan-500 focus:ring-cyan-400" />
                          <span><strong>{option.label}.</strong> {option.text}{correct && <span className="ml-2 text-xs font-black text-emerald-700 dark:text-emerald-300">Gabarito</span>}</span>
                        </label>
                      );
                    })}
                    <label className={`flex cursor-pointer items-center gap-3 rounded-xl border border-dashed p-3 text-sm transition ${selections[item.id] == null ? 'border-neutral-400 bg-neutral-100 text-neutral-700 dark:bg-white/10 dark:text-neutral-200' : 'border-neutral-200 text-neutral-500 dark:border-white/10 dark:text-neutral-400'} ${submitted ? 'cursor-default' : ''}`}>
                      <input type="radio" name={`item-${item.id}`} checked={selections[item.id] == null} onChange={() => setSelections((current) => ({ ...current, [item.id]: null }))} className="h-4 w-4 border-neutral-300 text-neutral-500 focus:ring-neutral-400" />
                      Em branco
                    </label>
                  </fieldset>}
                </article>
              ))}
              {submitted && feedbackEnabled && <StudentFeedbackRelease basePath={basePath} participant={entry.participant} attempt={entry.attempt} assessmentStatus={entry.assessment.status} existing={entry.feedback} draft={feedbackDraft} onDraftChange={setFeedbackDraft} onBusyChange={setFeedbackBusy} onReleased={feedback => { setEntry(current => ({ ...current, feedback })); setFeedbackDraft({ message: '', confirmed: false }); loadSummary(); }} />}
            </div>
          </div>

          {writeError && <div role="alert" className="px-4 py-3 text-sm text-rose-700 dark:text-rose-300"><p>{writeError}</p><button type="button" className="btn-outline mt-2" disabled={saving} onClick={reloadEntry}>Recarregar correção</button></div>}
          {!submitted && (
            <footer className="flex flex-col gap-2 border-t border-neutral-200 bg-white px-4 py-3 dark:border-white/10 dark:bg-[#0D192B] sm:flex-row sm:items-center sm:justify-between sm:px-4">
              <p role="status" className="text-xs text-slate-600 dark:text-slate-300">{dirty ? 'Há respostas ainda não salvas.' : 'Rascunho salvo ou sem alterações.'} A correção usa o gabarito preservado.</p>
              <div className="flex flex-wrap gap-2">
                <button type="button" className="btn-outline flex-1 justify-center sm:flex-none" onClick={handleSave} disabled={saving}><Save size={16} /> Salvar rascunho</button>
                <button type="button" className="btn-primary flex-1 justify-center sm:flex-none" onClick={handleSubmit} disabled={saving}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <ClipboardCheck size={16} />} Salvar e corrigir</button>
              </div>
            </footer>
          )}
        </div>
      </ResultsModal>
    );
  }

  if (recoveryOpen) {
    return (
      <ResultsModal key="recovery" title="Plano de recomposição" onClose={() => { if (recoveryCloseGuard.current()) onClose(); }}>
        <LearningRecoveryReview
          schoolClass={schoolClass}
          assignment={assignment}
          onBack={() => setRecoveryOpen(false)}
          closeGuardRef={recoveryCloseGuard}
        />
      </ResultsModal>
    );
  }

  return (
    <ResultsModal key="summary" title={`Resultados · ${assignment.title}`} onClose={onClose}>
      {loading ? (
        <p role="status" className="p-4 text-sm">Carregando resultados…</p>
      ) : error ? (
        <div ref={resultsErrorRef} role="alert" tabIndex={-1} className="p-4">
          <AlertTriangle className="text-rose-500" size={32} />
          <p className="mt-4 max-w-md text-sm font-bold text-rose-700 dark:text-rose-300">Não foi possível carregar os resultados desta aplicação.</p>
          <button type="button" className="btn-outline mt-5" onClick={loadSummary}><RefreshCw size={16} /> Tentar novamente</button>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div ref={resultsViewportRef} data-results-summary className="results-viewport">
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
              <p>{formatCount(summary.overview.submittedCount, 'corrigido', 'corrigidos')} · {formatCount(summary.overview.pendingCount, 'pendente', 'pendentes')}</p>
              <button type="button" className="btn-outline" onClick={() => { lastParticipantId.current = null; restoreListFocus.current = true; loadSummary(); }} disabled={saving}><RefreshCw size={16} aria-hidden="true" /> Atualizar resultados</button>
              {recoveryEnabled && assignment.isDiagnostic && assignment.status === 'closed' && summary.overview.submittedCount > 0 && <button type="button" className="btn-outline" onClick={() => setRecoveryOpen(true)}>Revisar recomposição</button>}
            </div>
            {writeError && <p role="alert" className="px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{writeError}</p>}
            <div ref={resultsTabsRef} className="results-tabs-shell sticky top-0 z-20 border-b border-neutral-200 bg-white/95 px-4 py-3 backdrop-blur dark:border-white/10 dark:bg-[#0D192B]/95 sm:px-6">
              <div className="grid grid-cols-3 gap-1 rounded-xl bg-slate-100 p-1 dark:bg-white/5" role="tablist" aria-label="Análises dos resultados" onKeyDown={tabKey}>
                {[
                  ['students', 'Estudantes'],
                  ['questions', 'Questões'],
                  ['skills', 'Habilidades BNCC'],
                ].map(([key, label]) => (
                  <button key={key} id={`results-${key}-tab`} type="button" role="tab" aria-selected={tab === key} tabIndex={tab === key ? 0 : -1} aria-controls={`results-${key}-panel`} onClick={() => selectResultsTab(key)} className={`results-tab min-w-0 rounded-xl px-2 py-2.5 text-xs sm:text-sm font-black transition ${tab === key ? 'bg-white text-cyan-700 shadow-sm dark:bg-white/10 dark:text-cyan-300' : 'text-neutral-500 dark:text-neutral-400'}`}>{label}</button>
                ))}
              </div>
            </div>

            <div id={`results-${tab}-panel`} role="tabpanel" aria-labelledby={`results-${tab}-tab`} tabIndex={0} className="results-body p-4 outline-none sm:p-4">
            {tab === 'students' && (
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_280px]">
                <div className="min-w-0">
                  <h3 ref={studentListHeading} tabIndex={-1} className="sr-only focus:not-sr-only focus:mb-2 focus:text-sm focus:font-bold">Estudantes desta avaliação</h3>
                  {progress && <section data-feedback-progress aria-label="Orientações individuais" className="mb-2">
                    <p className="text-sm text-slate-700 dark:text-slate-200">Orientações: <strong>{formatCount(progress.releasedCount, 'enviada', 'enviadas')}</strong> · <strong>{progress.pendingCount} sem orientação</strong></p>
                  </section>}
                  <div className={`mb-2 grid gap-2 ${progress ? 'sm:grid-cols-2' : ''}`}>
                    {progress && <label className="block"><span className="label">Mostrar estudantes</span><select className="input w-full" value={feedbackFilter} onChange={event => setFeedbackFilter(event.target.value)}>
                      <option value="all">Todos os estudantes</option>
                      <option value="pending">Sem orientação ({progress.pendingCount})</option>
                      <option value="released">Orientação enviada ({progress.releasedCount})</option>
                    </select></label>}
                    {(summary.participants.length > 5 || progress || studentSearch) && <label className="block"><span className="label">Buscar estudante</span><input aria-label="Buscar estudante nos resultados" placeholder="Digite o nome" className="input w-full" value={studentSearch} onChange={event => setStudentSearch(event.target.value)} /></label>}
                  </div>
                  {(progress || studentSearch) && <p role="status" className="mb-2 text-xs text-slate-600 dark:text-slate-300">{formatCount(visibleParticipants.length, 'estudante nesta lista', 'estudantes nesta lista')}{studentSearch && ' · busca por nome aplicada'}</p>}
                <div className="overflow-hidden rounded-2xl border border-neutral-200 dark:border-white/10">
                  {visibleParticipants.map((participant, index) => (
                    <div data-result-participant data-student-id={participant.id} key={participant.id} className={`flex flex-col gap-3 p-4 sm:flex-row sm:items-center ${index ? 'border-t border-neutral-100 dark:border-white/5' : ''}`}>
                      <div className="flex min-w-0 flex-1 items-center gap-3">
                        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-neutral-100 text-sm font-black text-neutral-500 dark:bg-white/10 dark:text-neutral-300">{participant.displayName.charAt(0).toUpperCase()}</span>
                        <div className="min-w-0">
                          <p className="break-words text-sm font-black text-neutral-900 dark:text-white">{participant.displayName}</p>
                          <div className="mt-1 flex flex-wrap items-center gap-2"><ParticipantStatus participant={participant} />{participant.attemptStatus === 'submitted' && <span className="text-xs font-bold text-neutral-500 dark:text-neutral-400">{participant.correctCount}/{participant.questionCount} acertos</span>}</div>
                          {progress && participant.feedbackStatus !== 'unavailable' && <p className="mt-1 text-xs font-semibold text-violet-700 dark:text-violet-300">{participant.feedbackStatus === 'released' ? 'Orientação enviada' : 'Sem orientação'}</p>}
                        </div>
                      </div>
                      <div className="flex items-center justify-between gap-3 sm:justify-end">
                        <strong className={`text-lg ${participant.attemptStatus === 'submitted' ? 'text-neutral-900 dark:text-white' : 'text-neutral-300 dark:text-neutral-600'}`}>{formatPercentage(participant.percentage)}</strong>
                        <button type="button" className="btn-outline justify-center" onClick={() => openParticipant(participant)} disabled={saving || participant.participationStatus === 'exempted'}>{participant.attemptStatus === 'submitted' ? 'Ver correção' : 'Lançar respostas'}</button>
                      </div>
                    </div>
                  ))}
                </div>
                  {visibleParticipants.length === 0 && <div className="py-3 text-sm">
                    <p>{studentSearch ? 'Nenhum estudante corresponde à busca e ao filtro atual.' : progress && feedbackFilter === 'pending' ? (progress.eligibleCount ? 'Todos os estudantes com avaliação entregue já receberam orientação.' : 'Ainda não há avaliação entregue para orientar.') : progress && feedbackFilter === 'released' ? 'Nenhuma orientação enviada nesta avaliação.' : 'Não há participantes nesta aplicação.'}</p>
                    {(studentSearch || (progress && feedbackFilter !== 'all')) && <button type="button" className="btn-outline mt-2" onClick={() => { setStudentSearch(''); setFeedbackFilter('all'); studentListHeading.current?.focus(); }}>Mostrar todos os estudantes</button>}
                  </div>}
                  {progress && <details className="mt-2 text-xs text-slate-600 dark:text-slate-300"><summary className="flex min-h-11 cursor-pointer items-center font-semibold">Sobre o envio das orientações</summary><p className="pb-2 leading-relaxed">Contamos apenas as avaliações entregues, sem dispensados. Você decide quem precisa de orientação; envio não confirma leitura. A busca filtra os nomes, mas não altera os totais da avaliação.</p></details>}
                </div>
                <aside className="h-fit rounded-2xl border border-rose-200 bg-rose-50/60 p-5 dark:border-rose-400/20 dark:bg-rose-400/5">
                  <div className="flex items-center gap-2 font-black text-rose-800 dark:text-rose-200"><UserRoundCheck size={18} /> Acompanhamento sugerido</div>
                  <p className="mt-2 text-xs leading-relaxed text-rose-700/75 dark:text-rose-200/70">Lista inicial baseada no corte de {summary.thresholds.followUpBelow}%. Use também observações pedagógicas e o contexto de cada estudante.</p>
                  <div className="mt-4 space-y-2">
                    {summary.studentsNeedingFollowUp.map((student) => <div key={student.id} className="flex items-center justify-between gap-2 rounded-xl bg-white/80 px-3 py-2 text-sm dark:bg-white/5"><span className="min-w-0 break-words font-bold text-neutral-800 dark:text-white">{student.displayName}</span><strong className="shrink-0 text-rose-600 dark:text-rose-300">{formatPercentage(student.percentage)}</strong></div>)}
                    {summary.studentsNeedingFollowUp.length === 0 && <p className="rounded-xl border border-dashed border-rose-200 p-4 text-center text-xs text-rose-600 dark:border-rose-400/20 dark:text-rose-300">Nenhum estudante abaixo do corte entre as correções concluídas.</p>}
                  </div>
                </aside>
              </div>
            )}

            {tab === 'questions' && (
              <div className="space-y-3">
                <div className="rounded-2xl border border-cyan-200 bg-cyan-50/60 p-4 text-sm text-cyan-900 dark:border-cyan-400/20 dark:bg-cyan-400/5 dark:text-cyan-100">
                  <strong>Questões com mais erros.</strong> Da maior para a menor taxa de erro nas correções concluídas.
                </div>
                {summary.hardestQuestions.map((question) => (
                  <article key={question.id} className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10 dark:bg-white/[0.025]">
                    <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2"><span className="font-black text-cyan-600 dark:text-cyan-300">Questão {question.number}</span><span className="text-xs font-bold text-neutral-400">{question.code}</span>{question.skillCode && <span className="rounded-full bg-violet-50 px-2 py-1 text-[10px] font-black text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">{question.skillCode}</span>}</div>
                        <p className="mt-2 break-words text-sm leading-relaxed text-neutral-700 dark:text-neutral-200">{question.statement}</p>
                      </div>
                      <div className="flex shrink-0 gap-2">
                        <span className="rounded-xl bg-emerald-50 px-3 py-2 text-xs font-black text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300">{formatPercentage(question.successRate)} acertos</span>
                        <span className="rounded-xl bg-rose-50 px-3 py-2 text-xs font-black text-rose-700 dark:bg-rose-400/10 dark:text-rose-300">{formatPercentage(question.errorRate)} erros</span>
                      </div>
                    </div>
                    <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100 dark:bg-white/10"><div className="h-full rounded-full bg-emerald-500 transition-all" style={{ width: `${question.successRate || 0}%` }} /></div>
                    <p className="mt-2 text-right text-[11px] text-neutral-400">{question.responseCount} correções consideradas</p>
                  </article>
                ))}
                {summary.hardestQuestions.length === 0 && <p className="rounded-2xl border border-dashed border-neutral-300 p-8 text-center text-sm text-neutral-400 dark:border-white/15">Conclua ao menos uma correção para ver esta análise.</p>}
              </div>
            )}

            {tab === 'skills' && (
              <div className="grid gap-3 lg:grid-cols-2">
                <p className="text-sm text-slate-600 dark:text-slate-300 lg:col-span-2">As faixas descrevem esta atividade. Use também outras avaliações e suas observações para acompanhar a aprendizagem.</p>
                {summary.skills.map((skill) => {
                  const meta = levelMeta[skill.level] || levelMeta.no_data;
                  return (
                    <article key={skill.code || 'sem-habilidade'} className="rounded-2xl border border-neutral-200 p-5 dark:border-white/10 dark:bg-white/[0.025]">
                      <div className="flex items-start justify-between gap-3">
                        <div><span className="font-black text-violet-700 dark:text-violet-300">{skill.code || 'Sem habilidade vinculada'}</span><p className="mt-2 text-sm leading-relaxed text-neutral-600 dark:text-neutral-300">{skill.description || 'Questões que ainda precisam de classificação pedagógica.'}</p></div>
                        <strong className="text-xl text-neutral-900 dark:text-white">{formatPercentage(skill.successRate)}</strong>
                      </div>
                      <div className="mt-4 flex flex-wrap items-center justify-between gap-2"><span className={`rounded-full px-2.5 py-1 text-[10px] font-black uppercase tracking-wide ${meta.className}`}>{meta.label}</span><span className="text-xs text-neutral-400">{skill.questionCount} {skill.questionCount === 1 ? 'questão' : 'questões'} · {skill.opportunities} respostas consideradas</span></div>
                    </article>
                  );
                })}
              </div>
            )}
          </div>

          </div>

          <details className="mx-4 mb-3 rounded-xl border border-slate-200 p-3 dark:border-white/10">
            <summary className="flex min-h-11 cursor-pointer items-center text-sm font-bold">Resumo e como interpretar</summary>
            <div className="pt-3">            <div className="results-metrics grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
              <MetricCard icon={UsersRound} label="Participantes" value={summary.overview.participantCount} helper={`${formatCount(summary.overview.submittedCount, 'corrigido', 'corrigidos')} · ${formatCount(summary.overview.pendingCount, 'pendente', 'pendentes')}`} tone="bg-cyan-50 text-cyan-600 dark:bg-cyan-400/10 dark:text-cyan-300" />
              <MetricCard icon={Target} label="Média da turma" value={formatPercentage(summary.overview.meanPercentage)} helper="Média das correções já concluídas" tone="bg-violet-50 text-violet-600 dark:bg-violet-400/10 dark:text-violet-300" />
              <MetricCard icon={BookOpenCheck} label="Questões" value={summary.assessment.questionCount} helper={`${summary.hardestQuestions.length} com dados de erro disponíveis`} tone="bg-amber-50 text-amber-600 dark:bg-amber-400/10 dark:text-amber-300" />
              <MetricCard icon={UserRoundCheck} label="Acompanhamento" value={summary.studentsNeedingFollowUp.length} helper={`Resultado abaixo de ${summary.thresholds.followUpBelow}%`} tone="bg-rose-50 text-rose-600 dark:bg-rose-400/10 dark:text-rose-300" />
            </div>
</div>
            <p className="mt-3 text-sm text-slate-600 dark:text-slate-300">Percentuais das respostas corrigidas; não é cálculo TRI. Faixas: ≥ {summary.thresholds.consolidatedMin}% consolidada; ≥ {summary.thresholds.developingMin}% em desenvolvimento. Considere também o contexto e suas observações sobre cada estudante.</p>
          </details>
          <footer className="results-footer flex flex-col gap-2 border-t border-neutral-200 bg-neutral-50/80 px-5 py-3 text-xs text-neutral-500 dark:border-white/10 dark:bg-white/[0.02] dark:text-neutral-400 sm:flex-row sm:items-center sm:justify-between sm:px-4">
            <span className="flex items-center gap-1.5"><BarChart3 size={14} /> Percentuais das respostas corrigidas; não é cálculo TRI.</span>
            <span className="results-footer__thresholds flex items-center gap-1.5"><CircleDashed size={14} /> Faixas: ≥ {summary.thresholds.consolidatedMin}% consolidada · ≥ {summary.thresholds.developingMin}% em desenvolvimento</span>
          </footer>
        </div>
      )}
    </ResultsModal>
  );
}
