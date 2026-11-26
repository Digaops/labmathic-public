import AssessmentDialog from './AssessmentDialog';
import { formatCount } from '../utils/pluralize';
import useMaterialAction from '../hooks/useMaterialAction';
import useAccountLeave from '../hooks/useAccountLeave';
import { parseAssignments, parseAssessmentBootstrap, matchesAssessmentText } from '../services/assessmentView.mjs';
import NumericAssessmentSourcePicker from './NumericAssessmentSourcePicker';
import { createNumericSubmission, numericSubmissionLeaveMessage } from '../services/numericAssessmentSubmission.mjs';
import { parseAssessmentPreparation, supportParticipants, existingVerification } from '../services/assessmentPreparation.mjs';
import { bankAccessState } from '../services/bankExperiences.mjs';
import { locateClassAssessment } from '../services/classesView.mjs';
import { mergeAssessmentRoster, parseSavedRoster, rosterIssue } from '../services/assessmentRoster.mjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import {
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Ban,
  BookOpenCheck,
  CalendarCheck2,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  CircleStop,
  FileQuestion,
  LockKeyhole,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Rocket,
  Search,
  ShieldCheck,
  Shuffle,
  Sparkles,
  UserRoundCheck,
  Undo2,
  UsersRound,
  X,
} from 'lucide-react';
import api from '../services/api';
import ClassAssessmentDeliveryModal from './ClassAssessmentDeliveryModal';
import AssessmentExemptionDialog from './AssessmentExemptionDialog';
import ClassAssessmentResults from './ClassAssessmentResults';
import StudentAssessmentAccessModal from './StudentAssessmentAccessModal';
import NumericAssessmentPaper from './NumericAssessmentPaper';
import {
  formatAssessmentWindow,
  isoToLocalInput,
  localInputToIso,
  nextAssessmentTransition,
  sameIdSet,
} from '../utils/classAssessments';

const steps = ['Atividade', 'Estudantes', 'Configuração', 'Revisão'];
const emptyForm = {
  sourceQuestionSetId: '',
  sourceKind:'choice', numericVersionIds:[], numericTitle:'', requestKey:'', pedagogicalConfirmed:false,
  participantIds: [],
  instructions: '',
  opensAt: '',
  closesAt: '',
  timeLimitMinutes: '',
  randomizeQuestions: false,
  randomizeOptions: false,
};

const statusMeta = {
  draft: {
    label: 'Rascunho',
    icon: LockKeyhole,
    className: 'bg-amber-50 text-amber-700 dark:bg-amber-400/10 dark:text-amber-300',
  },
  scheduled: {
    label: 'Agendado',
    icon: CalendarCheck2,
    className: 'bg-violet-50 text-violet-700 dark:bg-violet-400/10 dark:text-violet-300',
  },
  open: {
    label: 'Disponível',
    icon: Rocket,
    className: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300',
  },
  closed: {
    label: 'Encerrado',
    icon: CheckCircle2,
    className: 'bg-neutral-100 text-neutral-600 dark:bg-white/10 dark:text-neutral-300',
  },
  cancelled: {
    label: 'Cancelado',
    icon: Ban,
    className: 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300',
  },
};

function SourceBadge({ source }) {
  if (source.ownership === 'own') {
    return <span className="rounded-full bg-violet-50 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-violet-700 dark:bg-violet-400/10 dark:text-violet-300">Meu simulado</span>;
  }
  return <span className="rounded-full bg-cyan-50 px-2 py-1 text-[10px] font-black uppercase tracking-wide text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300">Banco LabMathic</span>;
}

export default function ClassAssessments({
  schoolClass,
  launchRequest = 0,
  launchSourceQuestionSetId = null,
  requestedAssessmentId = null,
  onLaunchHandled,
  deliveryEnabled = false,
  resultsEnabled = false,
  studentPortalEnabled = false,
  recoveryEnabled = false,
}) {
  const { user } = useAuth();
  const { isEnabled, loading: flagsLoading, unavailable: flagsUnavailable } = useFeatureFlags();
  const feedbackAvailable = bankAccessState({
    role: user?.role, loading: flagsLoading, unavailable: flagsUnavailable,
    enabled: isEnabled('pedagogy.operational_cycle'),
    dependenciesReady: ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results'].every(isEnabled),
  }) === 'operational';
  const [bootstrap, setBootstrap] = useState(null);
  const [assignments, setAssignments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [wizard, setWizard] = useState(null);
  const [exemptionDialog, setExemptionDialog] = useState(null);
  const [step, setStep] = useState(0);
  const [form, setForm] = useState(emptyForm);
  const numericActivity=form.sourceKind==='numeric' || wizard?.numeric===true;
  const [sourceSearch, setSourceSearch] = useState('');
  const [selectedNumericSources, setSelectedNumericSources] = useState([]);
  const [studentSearch, setStudentSearch] = useState('');
  const draftAction = useMaterialAction();
  const deliveryAction = useMaterialAction();
  const saving = draftAction.busy;
  const numericSubmission = useRef(createNumericSubmission());
  const [numericUncertain, setNumericUncertain] = useState(false);
  const submissionNotice = useRef(null);
  useAccountLeave(numericUncertain, () => saving && numericActivity, numericSubmissionLeaveMessage);
  const [writeError, setWriteError] = useState('');
  const [deliveryError, setDeliveryError] = useState('');
  const [opening, setOpening] = useState(false);
  const reads = useRef(null);
  const editRead = useRef(null);
  const stepRef = useRef(null);
  const [deliveryDialog, setDeliveryDialog] = useState(null);
  const [resultsDialog, setResultsDialog] = useState(null);
  const [studentAccessDialog, setStudentAccessDialog] = useState(null);
  const [paperDialog, setPaperDialog] = useState(null);
  const deliverySaving = deliveryAction.busy;
  const lastLaunch = useRef(0);
  const preparationRead = useRef(null);
  const launchHandled = useRef(onLaunchHandled);
  launchHandled.current = onLaunchHandled;
  const [preparing, setPreparing] = useState(false);
  const [existingNotice, setExistingNotice] = useState(null);
  const existingCard = useRef(null);
  const requestedCard = useRef(null);
  const lastLocated = useRef(null);
  const location = locateClassAssessment(requestedAssessmentId, { assignments, loading, error });

  const load = useCallback(async ({ showLoading = true } = {}) => {
    reads.current?.abort();
    const controller = new AbortController(); reads.current = controller;
    try {
      if (showLoading) {
        setLoading(true);
        setError('');
      }
      const [bootstrapResponse, assignmentsResponse] = await Promise.all([
        api.get(`/classes/${schoolClass.id}/assessments/bootstrap`, { signal: controller.signal, timeout: 15000 }),
        api.get(`/classes/${schoolClass.id}/assessments`, { signal: controller.signal, timeout: 15000 }),
      ]);
      if (controller.signal.aborted) return;
      const options = parseAssessmentBootstrap(bootstrapResponse.data);
      const items = parseAssignments(assignmentsResponse.data);
      setBootstrap(options); setAssignments(items); setError('');
    } catch (requestError) {
      if (!controller.signal.aborted) setError('Não foi possível atualizar as aplicações desta turma. Tente novamente antes de continuar.');
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [schoolClass.id]);

  useEffect(() => {
    numericSubmission.current = createNumericSubmission();
    setNumericUncertain(false);
    setBootstrap(null);
    setAssignments([]);
    setWizard(null);
    setDeliveryDialog(null);
    setResultsDialog(null);
    setStudentAccessDialog(null);
    setPaperDialog(null);
    setExistingNotice(null);
    lastLocated.current = null;
    lastLaunch.current = 0;
    load();
    return () => { reads.current?.abort(); editRead.current?.abort(); preparationRead.current?.abort(); };
  }, [load]);

  useEffect(() => {
    if (!wizard) return;
    const section = stepRef.current;
    section?.focus({ preventScroll: true });
    section?.closest('[data-assessment-dialog]')?.scrollTo({ top: 0 });
  }, [step, wizard]);

  useEffect(() => {
    if (!numericUncertain) return;
    submissionNotice.current?.focus({ preventScroll: true });
    submissionNotice.current?.closest('[data-assessment-dialog]')?.scrollTo({ top: 0 });
  }, [numericUncertain]);

  useEffect(() => {
    if (!deliveryEnabled || assignments.length === 0) return undefined;
    const now = Date.now();
    const nextTransition = nextAssessmentTransition(assignments, now);
    if (!nextTransition) return undefined;

    const timeout = window.setTimeout(
      () => load({ showLoading: false }),
      Math.min(Math.max(nextTransition - now + 1_000, 1_000), 2_147_000_000)
    );
    return () => window.clearTimeout(timeout);
  }, [assignments, deliveryEnabled, load]);

  function closeWizard() {
    if (saving || preparing) return;
    if (numericSubmission.current.uncertain && !window.confirm(numericSubmissionLeaveMessage)) return;
    numericSubmission.current = createNumericSubmission();
    setNumericUncertain(false);
    setWizard(null);
    launchHandled.current?.(launchSourceQuestionSetId);
  }

  const showExisting = useCallback((assignment, sourceId) => {
    setWizard(null); setWriteError(''); setExistingNotice(assignment.id);
    setAssignments(current => [assignment, ...current.filter(item => item.id !== assignment.id)]);
    launchHandled.current?.(sourceId);
  }, []);

  const openCreate = useCallback(() => {
    numericSubmission.current = createNumericSubmission();
    setNumericUncertain(false);
    setExistingNotice(null);
    setSelectedNumericSources([]);
    setWriteError('');
    setWizard({
      mode: 'create',
      originalParticipantIds: [],
      lockedSource: false,
    });
    setForm({
      ...emptyForm, requestKey:crypto.randomUUID(),
    });
    setSourceSearch('');
    setStudentSearch('');
    setStep(0);
  }, []);

  const prepareSource = useCallback(async (sourceId, fromShortcut = false) => {
    preparationRead.current?.abort();
    const controller = new AbortController(); preparationRead.current = controller;
    setPreparing(true); setWriteError(''); setExistingNotice(null);
    try {
      const response = await api.get(`/classes/${schoolClass.id}/assessments/sources/${encodeURIComponent(sourceId)}/preparation`, { signal: controller.signal, timeout: 15000 });
      if (controller.signal.aborted) return;
      const context = parseAssessmentPreparation(response.data, sourceId);
      if (context.existingAssignment) return showExisting(context.existingAssignment, sourceId);
      if (schoolClass.status !== 'active') throw new Error('Turma arquivada.');
      setWizard({ mode: 'create', originalParticipantIds: [], lockedSource: fromShortcut,
        source: context.source, title: context.source.title, recovery: context.recovery });
      setForm(current => ({ ...(fromShortcut ? emptyForm : current), sourceQuestionSetId: String(sourceId), participantIds: [] }));
      setStudentSearch(''); setStep(1);
    } catch {
      if (!controller.signal.aborted) setWriteError('Não foi possível conferir este simulado e sua aplicação. Tente abrir novamente. Nenhum rascunho foi criado.');
    } finally { if (!controller.signal.aborted) setPreparing(false); }
  }, [schoolClass.id, schoolClass.status, showExisting]);

  useEffect(() => {
    if (!launchRequest) { lastLaunch.current = null; return; }
    const key = `${launchRequest}:${launchSourceQuestionSetId}`;
    if (!bootstrap || loading || error || key === lastLaunch.current) return;
    lastLaunch.current = key;
    prepareSource(launchSourceQuestionSetId, true);
  }, [bootstrap, loading, error, launchRequest, launchSourceQuestionSetId, prepareSource]);

  // Reconcile a lost POST response or concurrent save with a GET, never a repeated write.
  useEffect(() => {
    const saved = existingVerification(assignments, wizard, form.sourceQuestionSetId);
    if (saved) showExisting(saved, form.sourceQuestionSetId);
  }, [assignments, wizard, form.sourceQuestionSetId, showExisting]);
  useEffect(() => {
    if (!existingNotice || loading || wizard) return;
    const frame = window.requestAnimationFrame(() => {
      existingCard.current?.focus({ preventScroll: true });
      existingCard.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [existingNotice, loading, wizard]);

  useEffect(() => {
    if (!requestedAssessmentId) { lastLocated.current = null; return; }
    if (location.status !== 'found' || lastLocated.current === location.id || wizard || deliveryDialog || resultsDialog || studentAccessDialog || paperDialog || exemptionDialog) return;
    const frame = window.requestAnimationFrame(() => {
      if (!requestedCard.current) return;
      requestedCard.current.focus({ preventScroll: true });
      requestedCard.current.scrollIntoView({ block: 'start', behavior: 'instant' });
      lastLocated.current = location.id;
    });
    return () => window.cancelAnimationFrame(frame);
  }, [requestedAssessmentId, location.status, location.id, wizard, deliveryDialog, resultsDialog, studentAccessDialog, paperDialog, exemptionDialog]);

  const filteredSources = useMemo(() => {
    return (bootstrap?.sources || []).filter(source => matchesAssessmentText(`${source.title} ${source.description || ''}`, sourceSearch));
  }, [bootstrap?.sources, sourceSearch]);

  const roster = useMemo(() => mergeAssessmentRoster(bootstrap?.participants || [], wizard?.savedParticipants), [bootstrap?.participants, wizard?.savedParticipants]);
  const filteredParticipants = useMemo(() => roster.filter(participant => matchesAssessmentText(participant.displayName, studentSearch)), [roster, studentSearch]);
  const editableVisible = filteredParticipants.filter(person => person.canRemove);
  const selectedIneligible = roster.filter(person => !person.eligible && form.participantIds.includes(person.id));

  const selectedSource = useMemo(() => (
    (String(wizard?.source?.id) === String(form.sourceQuestionSetId) ? wizard.source : null)
      || (bootstrap?.sources || []).find((source) => String(source.id) === String(form.sourceQuestionSetId))
  ), [bootstrap?.sources, form.sourceQuestionSetId, wizard]);

  async function openEdit(assignment) {
    if (opening) return;
    editRead.current?.abort(); const controller = new AbortController(); editRead.current = controller;
    setOpening(true); setWriteError('');
    try {
      const [response, options] = await Promise.all([
        api.get(`/classes/${schoolClass.id}/assessments/${assignment.id}`, { signal: controller.signal, timeout: 15000 }),
        api.get(`/classes/${schoolClass.id}/assessments/bootstrap`, { signal: controller.signal, timeout: 15000 }),
      ]);
      if (controller.signal.aborted) return;
      const detail = response.data;
      parseAssignments([detail]);
      parseSavedRoster(detail.participants);
      setBootstrap(parseAssessmentBootstrap(options.data));
      const participantIds = detail.participants.filter(participant => participant.status !== 'exempted').map((participant) => participant.id);
      setWizard({
        mode: 'edit', numeric:detail.items?.some(item=>item.questionType==='numeric'),
        id: detail.id,
        revision: detail.revision,
        title: detail.title,
        originalParticipantIds: participantIds,
        savedParticipants: detail.participants,
      });
      setForm({
        ...emptyForm,
        sourceQuestionSetId: String(detail.sourceQuestionSetId),
        participantIds,
        instructions: detail.instructions || '',
        opensAt: isoToLocalInput(detail.opensAt),
        closesAt: isoToLocalInput(detail.closesAt),
        timeLimitMinutes: detail.timeLimitMinutes ? String(detail.timeLimitMinutes) : '',
        randomizeQuestions: detail.randomizeQuestions,
        randomizeOptions: detail.randomizeOptions,
      });
      setSourceSearch('');
      setStudentSearch('');
      setStep(1);
    } catch (requestError) {
      if (!controller.signal.aborted) setWriteError('Não foi possível abrir este rascunho. Tente novamente.');
    } finally { if (!controller.signal.aborted) setOpening(false); }
  }

  function toggleParticipant(id) {
    if (roster.find(person => person.id === id)?.canRemove === false) return;
    setForm((current) => ({
      ...current,
      participantIds: current.participantIds.includes(id)
        ? current.participantIds.filter((participantId) => participantId !== id)
        : [...current.participantIds, id],
    }));
  }

  function selectVisibleParticipants() {
    const visibleIds = filteredParticipants.filter(person => person.canRemove).map((participant) => participant.id);
    const allVisibleSelected = visibleIds.length > 0 && visibleIds.every((id) => form.participantIds.includes(id));
    setForm((current) => ({
      ...current,
      participantIds: allVisibleSelected
        ? current.participantIds.filter((id) => !visibleIds.includes(id))
        : [...new Set([...current.participantIds, ...visibleIds])],
    }));
  }

  function validate(currentStep = step) {
    if(currentStep===0 && wizard.mode==='create' && form.sourceKind==='numeric') {
      if(!form.numericTitle.trim() || form.numericTitle.trim().length>200)return 'Dê um título curto à atividade.';
      if(!form.numericVersionIds.length || form.numericVersionIds.length>100)return 'Selecione de 1 a 100 questões aprovadas.';
      return '';
    }
    if (currentStep === 0 && !form.sourceQuestionSetId) return 'Escolha o simulado que será preservado neste rascunho.';
    if (currentStep === 1 && form.participantIds.length === 0) return bootstrap.participants.length === 0
      ? 'Cadastre os estudantes na turma antes de continuar.'
      : 'Selecione ao menos um estudante.';
    if (currentStep === 2) {
      const opensAt = localInputToIso(form.opensAt);
      const closesAt = localInputToIso(form.closesAt);
      if (form.opensAt && !opensAt) return 'Informe uma data de abertura válida.';
      if (form.closesAt && !closesAt) return 'Informe uma data de encerramento válida.';
      if (opensAt && closesAt && Date.parse(closesAt) <= Date.parse(opensAt)) return 'O encerramento deve acontecer depois da abertura.';
      if (form.timeLimitMinutes) {
        const minutes = Number(form.timeLimitMinutes);
        if (!Number.isInteger(minutes) || minutes < 5 || minutes > 300) return 'O tempo deve ficar entre 5 e 300 minutos.';
      }
    }
    return '';
  }

  function advance() {
    if (saving || preparing) return;
    const message = validate();
    if (message) return setWriteError(message);
    if (step === 0 && wizard.mode === 'create' && form.sourceKind!=='numeric' && String(wizard.source?.id) !== String(form.sourceQuestionSetId)) return prepareSource(form.sourceQuestionSetId);
    setWriteError('');
    setStep((current) => Math.min(current + 1, steps.length - 1));
  }

  async function saveDraft() {
    if (saving || preparing) return;
    const submission = numericSubmission.current;
    const retry = submission.uncertain ? submission.request : null;
    const message = !retry && [0, 1, 2].map((index) => validate(index)).find(Boolean);
    if (message) return setWriteError(message);
    if(!retry && wizard.mode==='create' && form.sourceKind==='numeric' && !form.pedagogicalConfirmed)return setWriteError('Confirme que as questões e habilidades fazem sentido para esta turma.');
    setWriteError('');
    const payload = {
      instructions: form.instructions.trim() || null,
      opensAt: localInputToIso(form.opensAt),
      closesAt: localInputToIso(form.closesAt),
      timeLimitMinutes: form.timeLimitMinutes ? Number(form.timeLimitMinutes) : null,
      randomizeQuestions: form.randomizeQuestions,
      randomizeOptions: form.randomizeOptions,
    };
    draftAction.run(async () => {
      if (wizard.mode === 'create') {
        if (retry || form.sourceKind === 'numeric') {
          const request = retry || submission.begin({ ...payload, numericVersionIds: form.numericVersionIds,
            title: form.numericTitle.trim(), randomizeOptions: false, pedagogicalConfirmed: form.pedagogicalConfirmed,
            participantIds: form.participantIds }, form.requestKey);
          try {
            const response = await api.post(`/classes/${schoolClass.id}/assessments`, request.body,
              { timeout: 15000, headers: { 'Idempotency-Key': request.key } });
            parseAssignments([response.data]);
            submission.confirmed();
            if (numericSubmission.current === submission) setNumericUncertain(false);
          } catch (requestError) {
            const uncertain = submission.failed(requestError);
            if (numericSubmission.current === submission) setNumericUncertain(uncertain);
            throw requestError;
          }
        } else {
          await api.post(`/classes/${schoolClass.id}/assessments`, {
            ...payload, sourceQuestionSetId: Number(form.sourceQuestionSetId), participantIds: form.participantIds,
          }, { timeout: 15000 });
        }
      } else {
        if (!sameIdSet(form.participantIds, wizard.originalParticipantIds)) payload.participantIds = form.participantIds;
        await api.patch(`/classes/${schoolClass.id}/assessments/${wizard.id}`, { ...payload, expectedRevision: wizard.revision }, { timeout: 15000 });
      }
    }, { onSuccess: () => { setWizard(null); launchHandled.current?.(launchSourceQuestionSetId); }, onError: setWriteError, refresh: () => load({ showLoading: false }),
      message: wizard.mode === 'create' ? 'Rascunho criado. Os estudantes ainda não têm acesso.' : 'Rascunho atualizado.' });
  }

  function confirmDelivery(payload) {
    if (!deliveryDialog?.assignment) return;
    setDeliveryError('');
    deliveryAction.run(() => api.patch(`/classes/${schoolClass.id}/assessments/${deliveryDialog.assignment.id}/delivery`,
      { ...payload, expectedRevision: deliveryDialog.assignment.revision }, { timeout: 15000 }),
      { onSuccess: () => setDeliveryDialog(null), onError: setDeliveryError, refresh: () => load({ showLoading: false }), message: 'Situação da aplicação atualizada. Confira a lista.' });
  }
  const showDelivery = config => { setDeliveryError(''); setDeliveryDialog(config); };

  if (loading && !wizard && !deliveryDialog) return <p role="status" className="py-3 text-sm">Carregando aplicações…</p>;

  if (error && !bootstrap && !wizard && !deliveryDialog) {
    return (
      <div data-class-assessments className="assessment-workspace rounded-xl border border-rose-200 bg-rose-50 p-4 dark:border-rose-400/20 dark:bg-rose-400/5">
        <p role="alert" className="text-sm font-bold text-rose-700 dark:text-rose-300">{error}</p>
        <button type="button" className="btn-outline mt-4" onClick={load}><RefreshCw size={16} /> Tentar novamente</button>
      </div>
    );
  }

  const wizardTitle = wizard?.mode === 'edit' ? `Editar rascunho: ${wizard.title}` : 'Nova aplicação';
  const selectedNames = roster.filter((participant) => form.participantIds.includes(participant.id));
  const supportIds = supportParticipants(wizard?.recovery, bootstrap?.participants || []);
  const unavailableSupportCount = (wizard?.recovery?.unavailableCount || 0) + (wizard?.recovery?.participantIds.length || 0) - supportIds.length;

  return (
    <div data-class-assessments className="assessment-workspace">
      {error && <div role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{error}<button type="button" className="btn-outline ml-2" onClick={() => load({ showLoading: false })}>Tentar novamente</button></div>}
      {!wizard && writeError && <p role="alert" className="mb-3 text-sm text-rose-700 dark:text-rose-300">{writeError}</p>}
      {!wizard && writeError && launchSourceQuestionSetId && <button type="button" className="btn-outline mb-3" disabled={preparing} onClick={() => prepareSource(launchSourceQuestionSetId, true)}>Conferir aplicação novamente</button>}
      {preparing && <p role="status" className="mb-3 text-sm">Conferindo simulado e aplicação…</p>}
      {location.status === 'missing' && <p role="status" className="mb-3 text-sm text-slate-700 dark:text-slate-200">Não encontramos esta aplicação nesta turma. Confira as aplicações abaixo.</p>}
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-2"><BookOpenCheck className="text-cyan-500" size={20} /><h3 className="font-black text-neutral-900 dark:text-white">Aplicações da turma</h3></div>
          <p className="mt-1 text-xs text-slate-600 dark:text-slate-300">{deliveryEnabled ? 'Atividades preparadas para esta turma.' : 'Nesta fase, apenas rascunhos.'}</p>
        </div>
        {schoolClass.status === 'active' && <button type="button" className="btn-primary justify-center" disabled={preparing || opening || Boolean(error)} onClick={() => openCreate()}><Plus size={17} /> Nova aplicação</button>}
      </div>

      {assignments.length > 0 ? (
        <div className="space-y-3">
          {assignments.map((assignment) => {
            const meta = statusMeta[assignment.status] || statusMeta.draft;
            const StatusIcon = meta.icon;
            return (
            <article data-assessment-id={assignment.id} data-assessment-located={location.id === assignment.id || undefined} key={assignment.id} tabIndex={existingNotice === assignment.id || location.id === assignment.id ? -1 : undefined} ref={existingNotice === assignment.id ? existingCard : location.id === assignment.id ? requestedCard : undefined} className="scroll-mt-32 rounded-2xl border border-neutral-200 bg-neutral-50/50 p-4 transition hover:border-cyan-200 hover:shadow-sm focus-visible:outline-cyan-500 dark:border-white/10 dark:bg-white/[0.025] dark:hover:border-cyan-400/25">
              {existingNotice === assignment.id && <p role="status" className="mb-3 text-sm text-cyan-800 dark:text-cyan-200">Esta verificação já tem uma aplicação salva. Confira abaixo os participantes e a situação. Nenhuma nova aplicação foi criada ao retornar, e a seleção salva não foi substituída.</p>}
              {location.id === assignment.id && existingNotice !== assignment.id && <p role="status" className="mb-2 break-words text-sm font-semibold text-cyan-800 dark:text-cyan-200">Aplicação selecionada · {schoolClass.name}</p>}
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-1 text-[10px] font-black uppercase tracking-wide ${meta.className}`}><StatusIcon size={11} /> {meta.label}</span>
                  <h4 className="mt-2 break-words text-base font-black text-neutral-900 dark:text-white">{assignment.title}</h4>
                </div>
                {schoolClass.status === 'active' && assignment.status === 'draft' && <button type="button" disabled={opening || preparing || Boolean(error)} onClick={() => openEdit(assignment)} className="rounded-xl border border-neutral-200 p-2 text-neutral-500 hover:bg-white hover:text-cyan-600 dark:border-white/10 dark:hover:bg-white/10 dark:hover:text-cyan-300" aria-label={`Editar ${assignment.title}`}><Pencil size={16} /></button>}
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs font-semibold text-neutral-600 dark:text-neutral-300">
                <span className="flex items-center gap-1.5"><FileQuestion size={14} className="text-cyan-500" /> {formatCount(assignment.questionCount, 'questão', 'questões')}</span>
                <span className="flex items-center gap-1.5"><UsersRound size={14} className="text-violet-500" /> {formatCount(assignment.participantCount - (assignment.roster?.exemptedCount || 0), 'participante', 'participantes')}{assignment.roster?.exemptedCount > 0 && ` · ${formatCount(assignment.roster.exemptedCount, 'dispensado', 'dispensados')}`}</span>
                <span className="col-span-2 flex items-start gap-1.5"><CalendarClock size={14} className="mt-0.5 shrink-0 text-emerald-500" /> {formatAssessmentWindow(assignment.opensAt, assignment.closesAt)}</span>
              </div>
              {assignment.timeLimitMinutes && <p className="mt-2 text-xs text-slate-600 dark:text-slate-300">{assignment.timeLimitMinutes} minutos por estudante</p>}
              {['draft', 'scheduled'].includes(assignment.status) && assignment.roster?.ineligibleCount > 0 && <p className="mt-2 text-sm text-amber-800 dark:text-amber-200">Matrículas para revisar: {assignment.roster.ineligibleCount}. {assignment.status === 'scheduled' ? 'A abertura automática aguardará a regularização. Retire o agendamento para revisar.' : 'Confira os participantes antes de disponibilizar.'}</p>}
              {deliveryEnabled && (
                <div className="mt-3 flex flex-wrap gap-2 border-t border-neutral-200 pt-3 dark:border-white/10">
                  {assignment.status === 'draft' && schoolClass.status === 'active' && isEnabled('classes.assessment_exemptions') && <button type="button" className="btn-outline" disabled={Boolean(error)} onClick={() => setExemptionDialog(assignment)}>Dispensar da avaliação</button>}
                  {assignment.status === 'draft' && schoolClass.status === 'active' && <button type="button" className="btn-primary flex-1 justify-center" onClick={() => showDelivery({ action: 'publish', assignment })}><Rocket size={15} /> Disponibilizar</button>}
                  {assignment.status === 'scheduled' && <>
                    {schoolClass.status === 'active' && <button type="button" className="btn-primary flex-1 justify-center" onClick={() => showDelivery({ action: 'open_now', assignment })}><Rocket size={15} /> Abrir agora</button>}
                    {schoolClass.status === 'active' && <button type="button" className="btn-outline flex-1 justify-center" onClick={() => showDelivery({ action: 'return_to_draft', assignment })}><Undo2 size={15} /> Retirar agendamento</button>}
                    <button type="button" className="inline-flex items-center justify-center gap-1.5 rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300 dark:hover:bg-rose-400/5" onClick={() => showDelivery({ action: 'cancel', assignment })}><Ban size={15} /> Cancelar</button>
                  </>}
                  {assignment.status === 'open' && <>
                    <button type="button" className="btn-primary flex-1 justify-center" onClick={() => showDelivery({ action: 'close', assignment })}><CircleStop size={15} /> Encerrar</button>
                    <button type="button" className="rounded-xl border border-rose-200 px-3 py-2 text-xs font-bold text-rose-600 transition hover:bg-rose-50 dark:border-rose-400/20 dark:text-rose-300 dark:hover:bg-rose-400/5" onClick={() => showDelivery({ action: 'cancel', assignment })}><Ban size={15} /> Cancelar</button>
                  </>}
                </div>
              )}
              {assignment.responseFormat === 'numeric' && assignment.status !== 'cancelled' && isEnabled('classes.numeric_assessments') && (
                <button type="button" className="btn-outline mt-2 w-full justify-center" onClick={() => setPaperDialog(assignment)}>Imprimir atividade em papel</button>
              )}
              {resultsEnabled && ['open', 'closed'].includes(assignment.status) && (
                <button type="button" className="btn-outline mt-3 w-full justify-center" onClick={() => setResultsDialog(assignment)}>
                  <BarChart3 size={16} /> Corrigir e analisar resultados
                </button>
              )}
              {studentPortalEnabled && ['scheduled', 'open', 'closed'].includes(assignment.status) && (
                <button type="button" className="btn-outline mt-2 w-full justify-center" onClick={() => setStudentAccessDialog(assignment)}>
                  <KeyRound size={16} /> Acessos dos estudantes
                </button>
              )}
              {feedbackAvailable && (
                <Link className="btn-outline mt-2 w-full justify-center" to={`/banco-questoes/devolutivas?turma=${encodeURIComponent(schoolClass.id)}&avaliacao=${encodeURIComponent(assignment.id)}`}>
                  <BookOpenCheck size={16} /> Devolutivas da turma
                </Link>
              )}
            </article>
            );
          })}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-slate-200 p-4 dark:border-white/10">
          <h4 className="text-base font-bold text-neutral-900 dark:text-white">{schoolClass.status === 'active' ? 'Prepare a primeira aplicação' : 'Nenhuma aplicação nesta turma'}</h4>
          <p className="mx-auto mt-2 max-w-md text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{schoolClass.status === 'active' ? 'Escolha um simulado e os estudantes. Salvar um rascunho não libera acesso para a turma.' : 'A turma está arquivada. Para preparar novas aplicações, restaure a turma primeiro.'}</p>
          {schoolClass.status === 'active' && <button type="button" className="btn-primary mt-3" disabled={preparing || opening || Boolean(error)} onClick={() => openCreate()}><Plus size={17} /> Criar rascunho</button>}
        </div>
      )}

      {wizard && (
        <AssessmentDialog title={wizardTitle} closeDisabled={saving || preparing} onClose={closeWizard}>
          {numericUncertain && <div ref={submissionNotice} tabIndex={-1} role="alert" className="m-3 space-y-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 outline-none dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-100">
            <h3 className="font-bold">Vamos conferir se o rascunho foi salvo</h3>
            <p>Não recebemos a confirmação. Suas escolhas estão preservadas e ficam bloqueadas até conferir o mesmo envio, sem criar uma cópia duplicada.</p>
            <button type="button" className="btn-outline" disabled={saving || preparing} onClick={saveDraft}>{saving ? 'Conferindo…' : 'Conferir salvamento'}</button>
            <p>Se precisar sair, confira a lista de aplicações antes de criar outra.</p>
          </div>}
          <div data-assessment-context className="space-y-1 border-b border-slate-200 px-4 py-2 text-sm text-slate-700 dark:border-white/10 dark:text-slate-200">
            <p className="break-words"><strong>Turma:</strong> {schoolClass.name}</p>
            <p className="break-words"><strong>{numericActivity ? 'Atividade:' : 'Simulado:'}</strong> {numericActivity ? form.numericTitle.trim() || wizard.title || 'Defina o título da atividade' : selectedSource?.title || wizard.title || 'Escolha o simulado'}</p>
          </div>
          <fieldset disabled={saving || preparing || numericUncertain} className="min-w-0">
          <nav aria-label="Etapas da aplicação" className="border-b border-slate-200 px-4 py-2 text-sm dark:border-white/10">
            <span aria-current="step">Etapa {step + 1} de {steps.length} · <strong>{steps[step]}</strong></span>
          </nav>

          <div ref={stepRef} tabIndex={-1} aria-label={steps[step]} className="p-4 outline-none">
            {step === 0 && (
              <div>
                <h3 className="text-lg font-black text-neutral-900 dark:text-white">O que a turma vai responder?</h3>
                {bootstrap?.numericEnabled && wizard.mode==='create' && !wizard.lockedSource && <div className="mt-3 flex flex-wrap gap-2" aria-label="Tipo de atividade">
                  <button type="button" className="btn-outline" aria-pressed={form.sourceKind!=='numeric'} onClick={()=>{setSourceSearch('');setForm(f=>({...f,sourceKind:'choice',pedagogicalConfirmed:false}));}}>Simulado com alternativas</button>
                  <button type="button" className="btn-outline" aria-pressed={form.sourceKind==='numeric'} onClick={()=>{setSourceSearch('');setForm(f=>({...f,sourceKind:'numeric',pedagogicalConfirmed:false}));}}>Respostas numéricas</button>
                </div>}
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Ao salvar, uma cópia segura do conteúdo será preservada no rascunho.</p>
                {form.sourceKind==='numeric' && wizard.mode==='create' ? <div className="mt-3 space-y-3">
                  <label className="block text-sm font-bold">Título da atividade<input className="input mt-1" maxLength={200} value={form.numericTitle} onChange={e=>setForm(f=>({...f,numericTitle:e.target.value,pedagogicalConfirmed:false}))} placeholder="Ex.: Frações e medidas · 6º ano" /></label>
                  <p className="text-sm text-slate-600 dark:text-slate-300">Escolha questões aprovadas. A versão selecionada fica preservada, mesmo se você editar a questão depois. A correção aceita vírgula ou ponto e exige o valor exato.</p>
                  <NumericAssessmentSourcePicker classId={schoolClass.id} remoteSearch={bootstrap.numericSourceSearch === true}
                    initialSources={bootstrap.numericSources || []} selected={selectedNumericSources}
                    onChange={sources => { setSelectedNumericSources(sources); setForm(f => ({ ...f, numericVersionIds: sources.map(q => q.id), pedagogicalConfirmed: false })); }} />
                </div> : wizard.mode === 'edit' || wizard.lockedSource ? (
                  <div className="mt-3 rounded-2xl border border-cyan-200 bg-cyan-50 p-4 dark:border-cyan-400/20 dark:bg-cyan-400/5">
                    <div className="flex items-center gap-2 text-sm font-black text-neutral-900 dark:text-white"><LockKeyhole size={17} className="text-cyan-500" /> {wizard.title}</div>
                    <p className="mt-2 text-xs text-neutral-500 dark:text-neutral-400">{numericActivity ? 'As questões desta atividade ficam preservadas. Para usar outras questões, crie uma nova aplicação.' : 'O simulado de origem fica bloqueado na edição para manter a integridade do rascunho.'}</p>
                  </div>
                ) : (
                  <>
                    <div className="relative mt-3">
                      <Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={17} />
                      <input className="input pl-10" value={sourceSearch} onChange={(event) => setSourceSearch(event.target.value)} placeholder="Buscar pelo título do simulado" aria-label="Buscar simulado" />
                    </div>
                    <div className="mt-3 grid gap-2">
                      {filteredSources.map((source) => {
                        const selected = String(form.sourceQuestionSetId) === String(source.id);
                        return (
                          <button key={source.id} type="button" onClick={() => setForm((current) => ({ ...current, sourceQuestionSetId: String(source.id) }))} className={`rounded-2xl border p-4 text-left transition ${selected ? 'border-cyan-400 bg-cyan-50 ring-2 ring-cyan-400/15 dark:bg-cyan-400/10' : 'border-neutral-200 hover:border-cyan-200 dark:border-white/10 dark:hover:border-cyan-400/25'}`} aria-pressed={selected}>
                            <div className="flex items-start justify-between gap-2"><SourceBadge source={source} />{selected && <CheckCircle2 className="shrink-0 text-cyan-500" size={18} />}</div>
                            <strong className="mt-3 block text-sm text-neutral-900 dark:text-white">{source.title}</strong>
                            {source.description && <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-neutral-500 dark:text-neutral-400">{source.description}</p>}
                            <div className="mt-3 flex flex-wrap gap-2 text-[11px] font-bold text-neutral-500 dark:text-neutral-400">
                              <span>{formatCount(source.questionCount, 'questão', 'questões')}</span>
                              {source.containsAuthorQuestions && <span className="text-violet-600 dark:text-violet-300">Questões autorais</span>}
                            </div>
                          </button>
                        );
                      })}
                    </div>
                    {filteredSources.length === 0 && <p className="mt-3 text-center text-sm text-neutral-400">Nenhum simulado disponível para esta busca.</p>}
                  </>
                )}
              </div>
            )}

            {step === 1 && (
              <div>
                {selectedIneligible.length > 0 && <p role="status" className="mb-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 dark:border-amber-400/20 dark:bg-amber-400/5 dark:text-amber-200">Há {formatCount(selectedIneligible.length, 'estudante selecionado sem matrícula ou cadastro ativo', 'estudantes selecionados sem matrícula ou cadastro ativo')}. Os nomes salvos continuam abaixo. Você pode guardar o rascunho, mas precisa conferir a seleção antes de disponibilizar. Desmarcar retira somente desta aplicação ao salvar; não apaga o cadastro nem o histórico da turma.</p>}
                {wizard.mode === 'create' && wizard.recovery && <div className="mb-3 rounded-xl border border-cyan-200 bg-cyan-50 p-3 text-sm dark:border-cyan-400/20 dark:bg-cyan-400/5">
                  <p className="text-slate-700 dark:text-slate-200">Escolha quem fará a verificação. Você pode ajustar os nomes abaixo.</p>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button type="button" className="btn-outline min-h-11 justify-center" disabled={!supportIds.length} onClick={() => setForm(current => ({ ...current, participantIds: supportIds }))}>Usar grupo de apoio ({supportIds.length})</button>
                    <button type="button" className="btn-outline min-h-11 justify-center" disabled={!bootstrap.participants.length} onClick={() => setForm(current => ({ ...current, participantIds: bootstrap.participants.map(person => person.id) }))}>Usar toda a turma ({bootstrap.participants.length})</button>
                  </div>
                  <details className="mt-2 text-xs text-slate-600 dark:text-slate-300"><summary className="w-fit cursor-pointer rounded py-1 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-500">Como funciona a seleção</summary><p className="mt-1">As opções acima substituem as marcações, inclusive fora da busca. O grupo reúne os estudantes dos grupos de apoio do plano, sem repetir nomes. Nada vem marcado automaticamente ao abrir.</p></details>
                  {unavailableSupportCount > 0 && <p className="mt-2 text-xs text-amber-800 dark:text-amber-200">Fora da seleção: {formatCount(unavailableSupportCount, 'estudante do apoio sem matrícula ativa', 'estudantes do apoio sem matrícula ativa')} nesta turma. O histórico está preservado.</p>}
                  {!supportIds.length && <p className="mt-2 text-xs">Não há estudantes do apoio disponíveis para selecionar. Confira os nomes da turma antes de continuar.</p>}
                </div>}
                <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
                  <div><h3 className="text-lg font-black text-neutral-900 dark:text-white">Quem participará?</h3><p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Estudantes selecionados: {form.participantIds.length} de {roster.length}.</p></div>
                  {roster.length > 0 && <button type="button" className="btn-outline justify-center" disabled={editableVisible.length === 0} onClick={selectVisibleParticipants}>{editableVisible.length > 0 && editableVisible.every((item) => form.participantIds.includes(item.id)) ? 'Desmarcar visíveis' : 'Selecionar visíveis'}</button>}
                </div>
                {roster.length > 0 && <div className="relative mt-3"><Search className="absolute left-3 top-1/2 -translate-y-1/2 text-neutral-400" size={17} /><input className="input pl-10" value={studentSearch} onChange={(event) => setStudentSearch(event.target.value)} placeholder="Buscar estudante" aria-label="Buscar estudante" /></div>}
                <div className="mt-3 rounded-2xl border border-neutral-200 dark:border-white/10">
                  {filteredParticipants.map((participant, index) => {
                    const selected = form.participantIds.includes(participant.id);
                    return (
                      <label key={participant.id} className={`flex cursor-pointer items-center gap-3 p-3.5 transition hover:bg-neutral-50 dark:hover:bg-white/[0.03] ${index ? 'border-t border-neutral-100 dark:border-white/5' : ''}`}>
                        <input type="checkbox" className="h-4 w-4 rounded border-neutral-300 text-cyan-500 focus:ring-cyan-400" checked={selected} disabled={!participant.canRemove} onChange={() => toggleParticipant(participant.id)} />
                        <span aria-hidden="true" className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-sm font-black ${selected ? 'bg-cyan-500 text-white' : 'bg-neutral-100 text-neutral-500 dark:bg-white/10 dark:text-neutral-300'}`}>{participant.displayName.charAt(0).toUpperCase()}</span>
                        <span className="min-w-0 break-words text-sm font-bold text-neutral-800 dark:text-white">{participant.displayName}{!participant.eligible && <span className="mt-1 block text-xs font-medium text-amber-800 dark:text-amber-200">{rosterIssue(participant)} · registro salvo preservado</span>}{!participant.canRemove && <span className="mt-1 block text-xs font-normal text-slate-600 dark:text-slate-300">{participant.status === 'exempted' ? 'Dispensa registrada; matrícula e histórico preservados.' : 'Acessos ou respostas anteriores: retirada protegida.'}</span>}</span>
                      </label>
                    );
                  })}
                  {filteredParticipants.length === 0 && <p className="p-4 text-sm leading-relaxed text-neutral-500 dark:text-neutral-400">{bootstrap.participants.length === 0 ? 'Esta turma ainda não tem estudantes. Feche esta janela e cadastre-os na aba Estudantes. Depois, volte para preparar a aplicação.' : 'Nenhum estudante encontrado para esta busca.'}</p>}
                </div>
              </div>
            )}

            {step === 2 && (
              <div>
                <h3 className="text-lg font-black text-neutral-900 dark:text-white">Como será a aplicação?</h3>
                <p className="mt-1 text-sm text-neutral-500 dark:text-neutral-400">Defina somente o necessário. Período e tempo são opcionais.</p>
                <div className="mt-3 grid gap-5 sm:grid-cols-2">
                  <label className="sm:col-span-2"><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Orientações aos estudantes</span><textarea className="input min-h-24 resize-y" maxLength={2000} value={form.instructions} onChange={(event) => setForm((current) => ({ ...current, instructions: event.target.value }))} placeholder="Ex.: Leia cada questão com atenção e revise antes de concluir." /><span className="mt-1 block text-right text-[11px] text-neutral-400">{form.instructions.length}/2000</span></label>
                  <label><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Abertura</span><input type="datetime-local" className="input" value={form.opensAt} onChange={(event) => setForm((current) => ({ ...current, opensAt: event.target.value }))} /></label>
                  <label><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Encerramento</span><input type="datetime-local" className="input" value={form.closesAt} onChange={(event) => setForm((current) => ({ ...current, closesAt: event.target.value }))} /></label>
                  <label><span className="mb-1.5 block text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Tempo limite (minutos)</span><input type="number" min="5" max="300" className="input" value={form.timeLimitMinutes} onChange={(event) => setForm((current) => ({ ...current, timeLimitMinutes: event.target.value }))} placeholder="Sem limite" /></label>
                  <div className="rounded-2xl border border-neutral-200 p-3 dark:border-white/10"><p className="text-xs font-bold uppercase tracking-wide text-neutral-500 dark:text-neutral-400">Embaralhamento</p><label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200"><input type="checkbox" checked={form.randomizeQuestions} onChange={(event) => setForm((current) => ({ ...current, randomizeQuestions: event.target.checked }))} /> Questões</label><label className="mt-2 flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200"><input type="checkbox" disabled={numericActivity} checked={!numericActivity && form.randomizeOptions} onChange={(event) => setForm((current) => ({ ...current, randomizeOptions: event.target.checked }))} /> Alternativas</label><p className="mt-2 text-[11px] leading-relaxed text-neutral-400">{numericActivity ? 'A ordem das questões pode mudar. Cada estudante digita o número; não há alternativas.' : 'O gabarito permanece equilibrado; ao embaralhar, cada estudante recebe uma versão individual sem concentração de letras.'}</p></div>
                </div>
              </div>
            )}

            {step === 3 && (
              <div>
                {selectedIneligible.length > 0 && <p role="status" className="mb-3 text-sm font-semibold text-amber-800 dark:text-amber-200">Este rascunho ainda tem matrículas para revisar. Salvar não libera a aplicação.</p>}
                <div className="rounded-xl border border-emerald-200 bg-emerald-50 p-3 dark:border-emerald-400/20 dark:bg-emerald-400/5">
                  <h3 className="text-base font-bold text-neutral-900 dark:text-white">Revise antes de salvar</h3><p className="mt-1 text-sm text-neutral-600 dark:text-neutral-300">Salvar mantém a aplicação como rascunho. O acesso dos estudantes só é liberado em Disponibilizar.</p>
                </div>
                {wizard.mode==='create' && numericActivity && <label className="mt-3 flex min-h-11 cursor-pointer gap-3 rounded-xl border border-cyan-200 p-3 text-sm dark:border-cyan-400/20">
                  <input className="mt-1 h-5 w-5 shrink-0" type="checkbox" checked={form.pedagogicalConfirmed} onChange={e=>setForm(f=>({...f,pedagogicalConfirmed:e.target.checked}))} />
                  Conferi os enunciados e as habilidades. Estas questões fazem sentido para a turma e os resultados serão indícios para planejar meu trabalho, não um diagnóstico definitivo.
                </label>}
                <div className="mt-3 grid gap-3 sm:grid-cols-2">
                  <div className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-400"><FileQuestion size={15} /> {numericActivity ? 'Atividade numérica' : 'Simulado'}</div><p className="mt-2 font-black text-neutral-900 dark:text-white">{form.sourceKind==='numeric' ? form.numericTitle : selectedSource?.title || wizard.title}</p><p className="mt-1 text-xs text-neutral-500">{formatCount(form.sourceKind==='numeric' ? form.numericVersionIds.length : selectedSource?.questionCount || assignments.find((item) => item.id === wizard.id)?.questionCount, 'questão preservada', 'questões preservadas')}</p></div>
                  <div className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-400"><UserRoundCheck size={15} /> Participantes</div><p className="mt-2 text-2xl font-black text-neutral-900 dark:text-white">{selectedNames.length}</p><p className="mt-1 break-words text-xs text-neutral-500">{selectedNames.map((item) => `${item.displayName}${!item.eligible ? ` (${rosterIssue(item)})` : ''}`).join(', ')}</p></div>
                  <div className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-400"><CalendarClock size={15} /> Período</div><p className="mt-2 text-sm font-bold text-neutral-900 dark:text-white">{formatAssessmentWindow(localInputToIso(form.opensAt), localInputToIso(form.closesAt))}</p></div>
                  <div className="rounded-2xl border border-neutral-200 p-4 dark:border-white/10"><div className="flex items-center gap-2 text-xs font-bold uppercase tracking-wide text-neutral-400"><Clock3 size={15} /> Regras</div><p className="mt-2 text-sm font-bold text-neutral-900 dark:text-white">{form.timeLimitMinutes ? `${form.timeLimitMinutes} minutos` : 'Sem tempo limite'}</p><p className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">{form.randomizeQuestions || form.randomizeOptions ? <><Shuffle size={13} /> Embaralhamento ativado</> : 'Ordem original preservada'}</p></div>
                </div>
              </div>
            )}
          </div>

          </fieldset>
          {writeError && <p role="alert" className="px-4 py-2 text-sm text-rose-700 dark:text-rose-300">{writeError}</p>}
          <footer className="flex flex-wrap items-center justify-between gap-2 border-t border-neutral-200 bg-neutral-50/70 px-5 py-4 dark:border-white/10 dark:bg-white/[0.02] sm:px-7">
            <button type="button" className="btn-outline" disabled={saving || preparing || numericUncertain} onClick={() => step === 0 ? closeWizard() : setStep((current) => current - 1)}>{step === 0 ? <X size={16} /> : <ArrowLeft size={16} />}{step === 0 ? 'Cancelar' : 'Voltar'}</button>
            {step < steps.length - 1 ? <button type="button" className="btn-primary" disabled={saving || preparing || numericUncertain} onClick={advance}>Continuar <ArrowRight size={16} /></button> : <button type="button" className="btn-primary" disabled={saving || preparing || numericUncertain} onClick={saveDraft}>{saving ? <RefreshCw className="animate-spin" size={16} /> : <ShieldCheck size={16} />} Salvar rascunho</button>}
          </footer>
        </AssessmentDialog>
      )}
      {deliveryDialog && (
        <ClassAssessmentDeliveryModal
          schoolClass={schoolClass}
          assignment={deliveryDialog.assignment}
          action={deliveryDialog.action}
          saving={deliverySaving}
          requestError={deliveryError}
          onClose={() => !deliverySaving && setDeliveryDialog(null)}
          onConfirm={confirmDelivery}
          onReadinessRetry={() => setDeliveryError('')}
          onEditParticipants={() => { const assignment = deliveryDialog.assignment; setDeliveryDialog(null); openEdit(assignment); }}
        />
      )}
      {exemptionDialog && <AssessmentExemptionDialog schoolClass={schoolClass} assignment={exemptionDialog} onClose={() => setExemptionDialog(null)} onChanged={() => load({ showLoading: false })} />}
      {paperDialog && <NumericAssessmentPaper key={`${schoolClass.id}:${paperDialog.id}`} schoolClass={schoolClass} assignment={paperDialog} onClose={() => setPaperDialog(null)} />}
      {resultsDialog && (
        <ClassAssessmentResults
          schoolClass={schoolClass}
          assignment={resultsDialog}
          recoveryEnabled={recoveryEnabled}
          feedbackEnabled={isEnabled('classes.student_feedback_release')}
          onClose={() => setResultsDialog(null)}
        />
      )}
      {studentAccessDialog && (
        <StudentAssessmentAccessModal
          schoolClass={schoolClass}
          assignment={studentAccessDialog}
          onClose={() => setStudentAccessDialog(null)}
          onChanged={() => load({ showLoading: false })}
        />
      )}
    </div>
  );
}
