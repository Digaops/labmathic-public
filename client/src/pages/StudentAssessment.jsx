import { useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  CheckCircle2,
  Clock3,
  KeyRound,
  LoaderCircle,
  LockKeyhole,
  LogOut,
  Save,
  Send,
  ShieldCheck,
} from 'lucide-react';
import api from '../services/api';
import useAssessmentRecovery from '../hooks/useAssessmentRecovery';
import AssessmentSaveStatus from '../components/AssessmentSaveStatus';
import {hasResponse,isNumeric,validNumericInput} from '../services/numericResponse.mjs';
import { parseStudentPortal } from '../services/studentAssessmentView.mjs';
import { preferredScrollBehavior } from '../services/motionPreference.mjs';

const sessionKey = 'labmathic.studentAssessmentSession';

function formatCode(value) {
  const normalized = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 16);
  return normalized.match(/.{1,4}/g)?.join('-') || '';
}

function formatRemaining(milliseconds) {
  const totalSeconds = Math.max(0, Math.ceil(milliseconds / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

export default function StudentAssessment() {
  const [code, setCode] = useState('');
  const [token, setToken] = useState(() => {
    try { return sessionStorage.getItem(sessionKey) || ''; } catch { return ''; }
  });
  const [initialPortal, setInitialPortal] = useState(null);
  const { state: recovery, controller } = useAssessmentRecovery(token, initialPortal);
  const portal = recovery?.portal;
  const saving = Boolean(recovery?.busy);
  const [loading, setLoading] = useState(false);
  const entering = useRef(false);
  const [error, setError] = useState('');
  const [currentIndex, setCurrentIndex] = useState(0);
  const [remaining, setRemaining] = useState(null);
  const [showQuestions, setShowQuestions] = useState(false);
  const questionRef = useRef(null);
  function goToQuestion(index) {
    setCurrentIndex(index); setShowQuestions(false);
    window.requestAnimationFrame(() => {
      questionRef.current?.focus({ preventScroll: true });
      questionRef.current?.scrollIntoView({ block: 'start' });
    });
  }
  function optionKey(event) {
    if (!['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    const options = [...event.currentTarget.querySelectorAll('[role="radio"]:not(:disabled)')];
    const current = options.indexOf(document.activeElement);
    if (current < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1
      : (current + (['ArrowDown', 'ArrowRight'].includes(event.key) ? 1 : -1) + options.length) % options.length;
    options[next].focus(); options[next].click();
  }

  useEffect(() => {
    const deadline = portal?.attempt?.deadline;
    if (!deadline || portal?.attempt?.status !== 'draft') {
      setRemaining(null);
      return undefined;
    }
    const serverOffset = Date.parse(portal.serverTime) - Date.now();
    const update = () => {
      const next = Date.parse(deadline) - (Date.now() + serverOffset);
      setRemaining(Math.max(0, next));
      if (next <= 0) controller.current?.expire();
    };
    update();
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [portal?.attempt?.deadline, portal?.attempt?.status, portal?.serverTime, controller]);

  async function enterAssessment(event) {
    event.preventDefault();
    if (entering.current) return;
    if (code.replaceAll('-', '').length !== 16) {
      setError('Confira o código de 16 caracteres entregue pelo professor.');
      return;
    }
    entering.current = true;
    try {
      setLoading(true);
      setError('');
      const response = await api.post('/student-assessments/session', { code }, { timeout: 15000 });
      const confirmedPortal = parseStudentPortal(response.data.portal);
      if (typeof response.data.token !== 'string' || !response.data.token) throw new Error('Sessão não confirmada.');
      // Sem sessão recuperável, não prometa retomada após recarregar.
      try { sessionStorage.setItem(sessionKey, response.data.token); }
      catch {
        await api.post('/student-assessments/logout', {}, {
          headers: { Authorization: 'Bearer ' + response.data.token }, timeout: 15000,
        }).catch(() => {});
        setError('O navegador bloqueou a sessão desta aba. Permita o armazenamento desta aba e tente novamente. Se precisar, peça ajuda ao professor.');
        return;
      }
      setInitialPortal(confirmedPortal);
      setToken(response.data.token);
      setCurrentIndex(0);
    } catch (requestError) {
      setError(requestError.response?.data?.error || 'Não foi possível abrir a avaliação. Verifique a conexão e tente novamente.');
    } finally {
      entering.current = false;
      setLoading(false);
    }
  }

  async function leave() {
    if (saving || loading) return;
    const hasPending = recovery?.pendingIds.length || recovery?.uncertain || recovery?.hasRecoveryCopy;
    if ((hasPending || portal?.attempt?.status === 'draft') && !window.confirm(hasPending
      ? 'Há respostas ou uma entrega sem confirmação. Sair apagará a cópia desta aba; somente as respostas já salvas serão mantidas. Deseja sair?'
      : 'Sair deste dispositivo? As respostas já salvas serão mantidas.')) return;
    setLoading(true);
    try {
      await api.post('/student-assessments/logout', {}, {
        headers: { Authorization: 'Bearer ' + token }, timeout: 15000,
      });
    } catch (requestError) {
      if (![401, 410, 423].includes(requestError.response?.status)) {
        setError('Não foi possível confirmar a saída. Verifique sua conexão e tente novamente.');
        setLoading(false);
        return;
      }
    }
    controller.current?.forget();
    controller.current?.dispose();
    try { sessionStorage.removeItem(sessionKey); } catch { /* Sessão pode estar bloqueada pelo navegador. */ }
    setToken('');
    setInitialPortal(null);
    setCode('');
    setError('');
    setLoading(false);
  }

  function chooseOption(itemId, optionId) {
    setError('');
    controller.current?.choose(itemId, optionId);
  }

  async function submitAssessment() {
    if (!recovery?.canSubmit) return;
    const unanswered = portal.items.filter(item => !hasResponse(item)).length;
    const message = unanswered
      ? 'Ainda há ' + unanswered + ' questão(ões) sem resposta. Deseja enviar mesmo assim?'
      : 'Depois de enviar, as respostas não poderão ser alteradas. Deseja concluir?';
    if (!window.confirm(message)) return;
    setError('');
    await controller.current?.submit();
    if (controller.current?.snapshot().portal?.attempt?.status === 'submitted') window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
  }

  const answeredCount = useMemo(() => portal?.items?.filter(item => hasResponse(item)
    && (!isNumeric(item) || validNumericInput(item.numericValue))).length || 0, [portal?.items]);
  const currentItem = portal?.items?.[currentIndex];
  const incomplete = portal?.items.filter(item => recovery?.invalidNumericIds.includes(item.id)) || [];

  if (token && !portal) {
    return <main data-student-assessment className="student-assessment-workspace flex min-h-dvh items-center justify-center bg-slate-50 p-4 dark:bg-[#061225]"><section className="w-full max-w-lg rounded-3xl border border-slate-200 bg-white p-6 dark:border-white/10 dark:bg-[#0D192B]"><h1 className="text-xl font-black text-slate-900 dark:text-white">Retomar sua avaliação</h1><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">Vamos conferir suas respostas salvas antes de recuperar as escolhas desta aba. É preciso conexão para abrir as questões novamente.</p><div className="mt-4"><AssessmentSaveStatus state={recovery} controller={controller} /></div>{error && <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">{error}</p>}<button type="button" className="btn-outline mt-4" disabled={saving || loading} onClick={leave}>Sair deste dispositivo</button></section></main>;
  }

  if (!portal) {
    return (
      <main data-student-assessment className="student-assessment-workspace flex min-h-dvh items-center justify-center bg-[radial-gradient(circle_at_top,#dff8ff_0,transparent_42%)] px-3 py-4 dark:bg-[#061225] dark:bg-none">
        <section className="w-full max-w-md rounded-3xl border border-slate-200 bg-white p-4 shadow-xl shadow-slate-200/60 dark:border-white/10 dark:bg-[#0D192B] dark:shadow-none sm:p-6">
          <div className="mx-auto flex h-14 w-14 items-center justify-center rounded-2xl bg-cyan-50 text-cyan-600 dark:bg-cyan-400/10 dark:text-cyan-300"><KeyRound size={27} /></div>
          <h1 className="mt-3 text-center text-2xl font-black text-slate-900 dark:text-white">Responder avaliação</h1>
          <p className="mt-2 text-center text-sm leading-relaxed text-slate-500 dark:text-slate-400">Digite o código individual entregue pelo professor. Você não precisa criar uma conta.</p>
          <form className="mt-4" onSubmit={enterAssessment}>
            <label htmlFor="assessment-code" className="mb-2 block text-xs font-black uppercase tracking-[0.12em] text-slate-500 dark:text-slate-400">Código individual de acesso</label>
            <input id="assessment-code" autoComplete="one-time-code" autoCapitalize="characters" spellCheck={false} inputMode="text" value={code} onChange={(event) => setCode(formatCode(event.target.value))} className="w-full rounded-2xl border border-slate-300 bg-white px-2 py-3 text-center font-mono text-base font-bold uppercase tracking-[0.03em] text-slate-900 outline-none transition focus:border-cyan-400 focus:ring-4 focus:ring-cyan-100 dark:border-white/15 dark:bg-[#071427] dark:text-white dark:focus:ring-cyan-400/10" placeholder="XXXX-XXXX-XXXX-XXXX" />
            {error && <div role="alert" className="mt-3 flex gap-2 rounded-xl bg-rose-50 p-3 text-sm text-rose-700 dark:bg-rose-400/10 dark:text-rose-200"><AlertTriangle className="mt-0.5 shrink-0" size={17} /> {error}</div>}
            <button type="submit" disabled={loading} className="btn-primary mt-5 w-full justify-center py-3.5">{loading ? <LoaderCircle className="animate-spin" size={18} /> : <ShieldCheck size={18} />} Entrar na avaliação</button>
          </form>
          <div className="mt-4 rounded-xl bg-slate-50 p-3 text-xs leading-relaxed text-slate-500 dark:bg-white/5 dark:text-slate-400"><strong className="text-slate-700 dark:text-slate-200">Importante:</strong> não compartilhe o seu código. Se houver tempo limite, ele começa ao entrar na avaliação. Só entre quando estiver pronto para responder.</div>
        </section>
      </main>
    );
  }

  if (portal.attempt?.status === 'submitted') {
    return (
      <main data-student-assessment className="student-assessment-workspace min-h-dvh bg-slate-50 px-3 py-4 dark:bg-[#061225]">
        <section className="mx-auto max-w-2xl rounded-3xl border border-slate-200 bg-white p-4 shadow-sm dark:border-white/10 dark:bg-[#0D192B] sm:p-6">
          <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-full bg-emerald-50 text-emerald-600 dark:bg-emerald-400/10 dark:text-emerald-300"><CheckCircle2 size={26} /></div>
          <h1 className="mt-3 text-center text-2xl font-black text-slate-900 dark:text-white">Avaliação entregue</h1>
          <p className="mt-2 text-center text-sm text-slate-500 dark:text-slate-400">{portal.assessment.title} · {portal.student.displayName}</p>
          {portal.result ? (
            <div className="mt-4 rounded-3xl border border-cyan-200 bg-cyan-50/70 p-4 text-center dark:border-cyan-400/20 dark:bg-cyan-400/5"><p className="text-xs font-black uppercase tracking-[0.14em] text-cyan-700 dark:text-cyan-300">Seu resultado</p><p className="mt-2 text-4xl font-black text-slate-900 dark:text-white">{Number(portal.result.percentage).toLocaleString('pt-BR')}%</p><p className="mt-2 text-sm text-slate-600 dark:text-slate-300">{portal.result.correctCount} acerto(s) em {portal.result.questionCount} questão(ões)</p><p className="mt-3 text-sm leading-relaxed text-slate-600 dark:text-slate-300">Este resultado mostra seus acertos nesta avaliação. Converse com o professor sobre o que aprender a seguir.</p><details className="mt-2 text-xs text-slate-500 dark:text-slate-400"><summary className="cursor-pointer">Como o resultado é calculado</summary><p>Percentual de acertos; não representa proficiência TRI.</p></details></div>
          ) : (
            <div className="mt-4 rounded-2xl bg-slate-50 p-5 text-center text-sm leading-relaxed text-slate-600 dark:bg-white/5 dark:text-slate-300">{portal.resultAvailableAfterClose ? 'Seu resultado ficará disponível aqui depois que o professor encerrar a aplicação.' : 'A entrega foi registrada. O resultado ficará disponível para o professor.'}</div>
          )}
          {portal.feedback && (
            <aside data-student-feedback className="mt-4 rounded-2xl border border-violet-200 bg-violet-50/70 p-4 dark:border-violet-400/20 dark:bg-violet-400/5">
              <p className="text-xs font-black uppercase tracking-[0.14em] text-violet-700 dark:text-violet-300">Orientação do professor</p>
              <p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed text-slate-700 dark:text-slate-200">{portal.feedback.message}</p>
              <p className="mt-3 text-xs text-slate-500 dark:text-slate-400">Liberada após o encerramento da avaliação.</p>
            </aside>
          )}
          <div className="mt-3"><AssessmentSaveStatus state={recovery} controller={controller} /></div>
          {error && <p role="alert" className="mt-3 text-sm text-rose-600 dark:text-rose-300">{error}</p>}
          <div className="mt-4 flex flex-wrap justify-center gap-2">
            <button type="button" className="btn-outline" disabled={saving || loading || recovery?.phase === 'blocked'} onClick={() => controller.current?.retry()}>
              {saving ? <LoaderCircle size={16} className="animate-spin" aria-hidden="true" /> : null}
              {saving ? 'Atualizando…' : 'Atualizar resultado e orientação'}
            </button>
            <button type="button" className="btn-outline" disabled={saving || loading} onClick={leave}><LogOut size={16} aria-hidden="true" /> Sair deste dispositivo</button>
          </div>
        </section>
      </main>
    );
  }

  return (
    <main data-student-assessment className="student-assessment-workspace min-h-dvh bg-slate-50 dark:bg-[#061225]">
      <header className="border-b border-slate-200 bg-white/95 backdrop-blur dark:border-white/10 dark:bg-[#0D192B]/95">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-3 py-3 sm:px-6">
          <div className="min-w-0 flex-1 basis-44"><h1 className="break-words text-sm font-bold text-slate-900 dark:text-white">{portal.assessment.title}</h1><p className="break-words text-xs text-slate-500 dark:text-slate-400">{portal.student.displayName} · {portal.assessment.className}</p></div>
        </div>
      </header>
      <div data-student-toolbar className="sticky top-0 z-30 border-b border-slate-200 bg-white dark:border-white/10 dark:bg-[#0D192B]">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-2 px-3 py-1 sm:px-6">
          <span className="text-sm font-bold">Questão {currentIndex + 1} de {portal.items.length}</span>
          <div className="flex shrink-0 items-center gap-2">
            {remaining !== null && <span className={`inline-flex items-center gap-1.5 rounded-xl px-3 py-2 font-mono text-sm font-black ${remaining <= 5 * 60_000 ? 'bg-rose-50 text-rose-700 dark:bg-rose-400/10 dark:text-rose-300' : 'bg-cyan-50 text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300'}`}><Clock3 size={15} aria-hidden="true" /><span className="sr-only">Tempo restante: </span> {formatRemaining(remaining)}</span>}
            <button type="button" className="rounded-xl p-2 text-slate-500 hover:bg-slate-100 dark:text-slate-300 dark:hover:bg-white/10" disabled={saving || loading} onClick={leave} aria-label="Sair"><LogOut size={18} /></button>
          </div>
        </div>
        <div className="h-1 bg-slate-100 dark:bg-white/5"><div className="h-full bg-cyan-500 transition-all" style={{ width: `${portal.items.length ? (answeredCount * 100) / portal.items.length : 0}%` }} /></div>
      </div>

      <div className="mx-auto grid max-w-6xl gap-3 px-3 py-3 sm:px-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <button type="button" className="btn-outline justify-between lg:hidden" aria-expanded={showQuestions} aria-controls="student-question-map" onClick={() => setShowQuestions(value => !value)}>{showQuestions ? 'Fechar lista de questões' : 'Ver todas as questões'}<span>{answeredCount}/{portal.items.length} respondidas</span></button>
        <aside id="student-question-map" className={`${showQuestions ? 'block' : 'hidden'} lg:block`}>
          <div className="rounded-2xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#0D192B] lg:sticky lg:top-20">
            <div className="flex items-center justify-between"><span className="text-xs font-black uppercase tracking-wide text-slate-500 dark:text-slate-400">Questões</span><span className="text-xs font-bold text-cyan-600 dark:text-cyan-300">{answeredCount}/{portal.items.length}</span></div>
            <div className="mt-3 grid grid-cols-[repeat(auto-fit,minmax(44px,1fr))] gap-2">
              {portal.items.map((item, index) => <button key={item.id} type="button" onClick={() => goToQuestion(index)} className={`flex min-h-11 items-center justify-center rounded-lg text-xs font-black transition ${index === currentIndex ? 'bg-cyan-500 text-white ring-4 ring-cyan-100 dark:ring-cyan-400/10' : recovery?.pendingIds.includes(item.id) ? 'bg-amber-50 text-amber-800 dark:bg-amber-400/15 dark:text-amber-200' : hasResponse(item) ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-400/10 dark:text-emerald-300' : 'bg-slate-100 text-slate-500 dark:bg-white/5 dark:text-slate-400'}`} aria-current={index === currentIndex ? "step" : undefined} aria-label={`Ir para questão ${index + 1}`}>{index + 1}</button>)}
            </div>
            <button type="button" className="btn-primary mt-5 w-full justify-center" disabled={!recovery?.canSubmit} onClick={submitAssessment}><Send size={16} /> Entregar avaliação</button>
            {!recovery?.canSubmit && <p className="mt-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300">Confira o aviso acima da questão antes de entregar. Aguarde a confirmação do salvamento antes de entregar.</p>}
          </div>
        </aside>

        <section ref={questionRef} tabIndex={-1} aria-label="Questão atual e salvamento" className="min-w-0 scroll-mt-20 outline-none">
          <AssessmentSaveStatus state={recovery} controller={controller} />
          {incomplete.length > 0 && !recovery.expired && <div className="mt-2 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950 dark:border-amber-500/40 dark:bg-amber-400/10 dark:text-amber-100">
            <p role="status">Complete ou apague {incomplete.length === 1 ? 'a resposta numérica na questão' : 'as respostas numéricas nas questões'} {incomplete.map(item => item.number).join(', ')}.</p>
            <button type="button" className="btn-outline" onClick={() => goToQuestion(portal.items.findIndex(item => item.id === incomplete[0].id))}>Ir à questão {incomplete[0].number}</button>
          </div>}
          {error && <div role="alert" className="mb-4 flex gap-2 rounded-2xl border border-rose-200 bg-rose-50 p-4 text-sm text-rose-700 dark:border-rose-400/20 dark:bg-rose-400/10 dark:text-rose-200"><AlertTriangle className="mt-0.5 shrink-0" size={18} /> {error}</div>}
          {portal.assessment.instructions && <details className="mt-3 rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#0D192B]"><summary className="cursor-pointer font-bold">Orientações do professor</summary><p className="mt-2 whitespace-pre-wrap break-words text-sm leading-relaxed">{portal.assessment.instructions}</p></details>}
          {currentItem && (
            <article className="mt-3 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm dark:border-white/10 dark:bg-[#0D192B] sm:p-5">
              <div className="flex flex-wrap items-center justify-between gap-2"><span className="rounded-full bg-cyan-50 px-3 py-1 text-xs font-black uppercase tracking-wide text-cyan-700 dark:bg-cyan-400/10 dark:text-cyan-300">Questão {currentIndex + 1} de {portal.items.length}</span><span className="inline-flex items-center gap-1 text-xs font-bold text-slate-400">{recovery?.pendingIds.includes(currentItem.id) ? <><Clock3 size={14} /> Pendente</> : hasResponse(currentItem) ? <><Save size={14} /> Salva</> : 'Sem resposta'}</span></div>
              {currentItem.supportText && <div className="mt-5 whitespace-pre-line break-words rounded-2xl bg-slate-50 p-4 text-sm leading-relaxed text-slate-700 dark:bg-white/5 dark:text-slate-200">{currentItem.supportText}</div>}
              {currentItem.imagePath && <img src={currentItem.imagePath} alt={`Imagem de apoio da questão ${currentIndex + 1}`} className="mx-auto mt-5 max-h-[360px] max-w-full rounded-2xl object-contain" />}
              <h2 className="mt-3 break-words text-base font-bold leading-relaxed text-slate-900 dark:text-white sm:text-xl">{currentItem.statement}</h2>
              {isNumeric(currentItem) ? <div className="mt-4 max-w-md">
                <label className="block text-sm font-bold" htmlFor={'numeric-'+currentItem.id}>Sua resposta{currentItem.unit ? ' (em '+currentItem.unit+')' : ''}</label>
                <input id={'numeric-'+currentItem.id} className="input mt-2" type="text" inputMode="decimal" autoComplete="off" maxLength={20}
                  value={currentItem.numericValue ?? ''} disabled={!recovery?.canEdit || recovery?.conflicts.includes(currentItem.id)}
                  aria-invalid={!validNumericInput(currentItem.numericValue)} aria-describedby={'numeric-help-'+currentItem.id}
                  onChange={event=>chooseOption(currentItem.id,event.target.value)} placeholder="Ex.: 2,5" />
                <p id={'numeric-help-'+currentItem.id} className="mt-2 text-xs text-slate-600 dark:text-slate-300">Digite somente o número. Pode usar vírgula ou ponto decimal; não use separador de milhar. Deixe vazio se não souber responder.</p>
                {!validNumericInput(currentItem.numericValue) && <p role="status" className="mt-2 text-sm text-amber-700 dark:text-amber-300">Complete o número para salvar esta resposta.</p>}
              </div> : <div className="mt-4 space-y-2" onKeyDown={optionKey} role="radiogroup" aria-label={`Alternativas da questão ${currentIndex + 1}`}>
                {currentItem.options.map((option) => {
                  const selected = currentItem.selectedOptionId === option.id;
                  return <button key={option.id} type="button" role="radio" aria-checked={selected} tabIndex={selected || (!currentItem.selectedOptionId && option.id === currentItem.options[0]?.id) ? 0 : -1} disabled={!recovery?.canEdit || recovery?.conflicts.includes(currentItem.id)} onClick={() => chooseOption(currentItem.id, option.id)} className={`flex w-full items-start gap-3 rounded-xl border p-3 text-left transition ${selected ? 'border-cyan-400 bg-cyan-50 ring-2 ring-cyan-400/15 dark:bg-cyan-400/10' : 'border-slate-200 hover:border-cyan-200 hover:bg-slate-50 dark:border-white/10 dark:hover:border-cyan-400/25 dark:hover:bg-white/[0.03]'}`}><span className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-xl font-black ${selected ? 'bg-cyan-500 text-white' : 'bg-slate-100 text-slate-600 dark:bg-white/10 dark:text-slate-300'}`}>{selected ? <Check size={17} /> : option.label}</span><span className="min-w-0 break-words pt-1 text-sm leading-relaxed text-slate-800 dark:text-slate-100">{option.text}</span></button>;
                })}
              </div>}
            </article>
          )}

          <div className="mt-4 flex items-center justify-between gap-3">
            <button type="button" className="btn-outline" disabled={currentIndex === 0} onClick={() => goToQuestion(Math.max(0, currentIndex - 1))}><ArrowLeft size={16} /> Anterior</button>
            {currentIndex < portal.items.length - 1 ? <button type="button" className="btn-primary" onClick={() => goToQuestion(Math.min(portal.items.length - 1, currentIndex + 1))}>Próxima <ArrowRight size={16} /></button> : <button type="button" className="btn-primary" disabled={!recovery?.canSubmit} onClick={submitAssessment}><Send size={16} /> Concluir e entregar</button>}
          </div>
          <div className="mt-4 flex items-start gap-2 text-xs leading-relaxed text-slate-600 dark:text-slate-300"><LockKeyhole className="shrink-0" size={14} /> Suas respostas são salvas automaticamente. Confira o aviso de salvamento antes de sair.</div>
        </section>
      </div>
    </main>
  );
}
