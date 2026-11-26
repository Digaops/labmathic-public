import { useEffect, useRef, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, CheckCircle, Eye, EyeOff, Printer } from 'lucide-react';
import api from '../services/api';
import { eventDay } from '../services/eventDates.mjs';
import { useAuth } from '../contexts/AuthContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import CycleBankContext from '../components/CycleBankContext';
import AssessmentDialog from '../components/AssessmentDialog';
import AuthoringWriteAlert from '../components/AuthoringWriteAlert';
import useReadOnlyResource from '../hooks/useHomeResource';
import useMaterialAction from '../hooks/useMaterialAction';
import { parseSetDetail, setNavigationUrl, setPermissions, setApplication, setApplicationUrl, predominantDifficulty, confirmedImage, confirmedReview } from '../services/questionSetsView.mjs';
import { openQuestionSetPrint, printImageUrl } from '../services/questionSetPrint.mjs';
import { formatCount } from '../utils/pluralize';

const difficulty = { facil: 'Fácil', media: 'Média', dificil: 'Difícil' };
const surface = 'rounded-xl border border-slate-200 bg-white p-3 dark:border-white/10 dark:bg-[#111E31]';

export default function QuestionSetView() {
  const { id } = useParams(), { user } = useAuth();
  return <SetWorkspace key={String(user?.id) + ':' + id} id={id} />;
}

function QuestionVisual({ question }) {
  const [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  let src;
  try { src = printImageUrl(question.image_path, window.location.origin); } catch { return <p role="alert">O caminho desta imagem não pôde ser confirmado.</p>; }
  return <div className="space-y-2">
    <img key={attempt} src={src + (attempt ? '?retry=' + attempt : '')} alt={'Imagem da questão ' + question.question_code} loading="lazy" onError={() => setFailed(true)} onLoad={() => setFailed(false)} className={'mx-auto h-auto max-h-80 max-w-full rounded-lg object-contain ' + (failed ? 'hidden' : '')} />
    {failed && <div role="alert" className="text-sm text-amber-900 dark:text-amber-200"><p>A imagem não carregou. Confira antes de usar esta questão.</p><button type="button" className="btn-outline" onClick={() => { setFailed(false); setAttempt(n => n + 1); }}>Recarregar imagem</button></div>}
  </div>;
}

function SetWorkspace({ id }) {
  const { user } = useAuth(), { isEnabled } = useFeatureFlags();
  const [params] = useSearchParams();
  const resource = useReadOnlyResource('/question-bank/question-sets/' + encodeURIComponent(id), user?.id, parseSetDetail);
  const [patch, setPatch] = useState({}), [error, setError] = useState(''), [blocked, setBlocked] = useState(false);
  const [printing, setPrinting] = useState(false), [printError, setPrintError] = useState('');
  const action = useMaterialAction(), firstQuestion = useRef(null), reviewHeading = useRef(null), lastAction = useRef(null), reconcile = useRef(false);
  const questionSet = resource.data ? { ...resource.data, ...patch } : null;
  useEffect(() => {
    if (resource.status === 'ready' && reconcile.current) {
      reconcile.current = false; setBlocked(false); setError('');
      requestAnimationFrame(() => firstQuestion.current?.focus({ preventScroll: true }));
    }
  }, [resource.status, resource.data]);
  function reload() {
    reconcile.current = true; setBlocked(true); setPatch({}); resource.retry();
  }
  const locked = action.busy || blocked || resource.status !== 'ready';
  function fail(message) { setBlocked(true); setError(message); }
  function toggleQuestionImage(question, button) {
    if (locked) return;
    lastAction.current = button; setError('');
    const desired = Number(question.show_image) === 0 ? 1 : 0;
    action.run(async () => {
      const response = await api.patch('/question-bank/question-sets/' + questionSet.id + '/items/' + question.id + '/image-visibility', { show_image: Boolean(desired) }, { timeout: 15000 });
      confirmedImage(response.data, questionSet.id, question.id, desired);
    }, { onError: fail, onSuccess: () => {
      setPatch(current => ({ ...current, questions: questionSet.questions.map(q => q.id === question.id ? { ...q, show_image: desired } : q) }));
      requestAnimationFrame(() => lastAction.current?.focus({ preventScroll: true }));
    }, message: desired ? 'Imagem incluída neste simulado.' : 'Imagem ocultada neste simulado.' });
  }
  function confirmDiagnosticReview() {
    if (locked || !setPermissions(questionSet, user).canReview) return;
    if (!window.confirm('Confirma que você revisou todas as questões, imagens e alternativas do gabarito? Após confirmar, o diagnóstico poderá ser aplicado às turmas.')) return;
    setError(''); let review;
    action.run(async () => {
      const response = await api.post('/question-bank/question-sets/' + questionSet.id + '/diagnostic-review', { confirmed: true }, { timeout: 15000 });
      review = confirmedReview(response.data, questionSet.id, user.id);
    }, { onError: fail, onSuccess: () => {
      setPatch(current => ({ ...current, diagnostic_reviewed: 1, diagnostic_reviewed_at: review.reviewedAt, diagnostic_reviewed_by: review.reviewedBy, diagnostic_review_confirmation_version: review.confirmationVersion }));
      requestAnimationFrame(() => reviewHeading.current?.focus({ preventScroll: true }));
    }, message: 'Revisão confirmada. Você já pode preparar a aplicação.' });
  }
  function openPrint(showAnswers) {
    if (locked || (!showAnswers && questionSet.is_diagnostic && !questionSet.diagnostic_reviewed)) return;
    setPrintError('');
    try { openQuestionSetPrint(questionSet, showAnswers); } catch (failure) { setPrintError(failure.message || 'Não foi possível preparar a impressão.'); }
  }
  const back = setNavigationUrl('/simulados', params);
  if (resource.status !== 'ready' || !questionSet) return <div data-question-set-detail className="editorial-workspace bank-form mx-auto max-w-5xl space-y-3 px-3 py-3 sm:px-6">
    <Link className="btn-outline" aria-label="Voltar aos simulados" to={back}><ArrowLeft aria-hidden="true" size={16} /> Voltar<span className="hidden sm:inline"> aos simulados</span></Link>
    {resource.status === 'error' ? <section role="alert" className={surface}><h1 className="text-xl font-bold">Não foi possível abrir o simulado</h1><p className="my-2 text-sm">Confira sua conexão e seu acesso. Nenhuma alteração foi feita por esta consulta.</p><button type="button" className="btn-outline" onClick={reload}>Tentar novamente</button></section> : <p role="status">Carregando simulado…</p>}
  </div>;
  const questions = questionSet.questions, permissions = setPermissions(questionSet, user);
  const isDiagnostic = Boolean(questionSet.is_diagnostic), diagnosticReviewed = Boolean(questionSet.diagnostic_reviewed);
  const readyToApply = !isDiagnostic || diagnosticReviewed;
  const application = setApplication(questionSet, user, {
    classesEnabled: isEnabled('classes.core'), assignmentsEnabled: isEnabled('classes.assessment_assignments'), locked,
  });
  const applicationUrl = setApplicationUrl(questionSet.id, params.get('turma'));
  const applicationLabel = new URLSearchParams(applicationUrl.split('?')[1]).has('turma') ? 'Preparar aplicação nesta turma' : 'Aplicar em uma turma';
  const predominant = predominantDifficulty(questions), authors = questions.filter(q => q.source === 'teacher').length;
  return <div data-question-set-detail className="editorial-workspace bank-form mx-auto max-w-5xl space-y-3 px-3 py-3 sm:px-6 sm:py-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <Link className="btn-outline" aria-label="Voltar aos simulados" to={back}><ArrowLeft aria-hidden="true" size={16} /> Voltar<span className="hidden sm:inline"> aos simulados</span></Link>
      <button type="button" className="btn-outline" disabled={locked || !questions.length} onClick={() => { setPrintError(''); setPrinting(true); }}><Printer aria-hidden="true" size={16} /> Imprimir</button>
    </div>
    <header className="space-y-1">
      <h1 className="break-words text-xl font-bold leading-snug sm:text-2xl">{questionSet.title}</h1>
      <p className="text-sm text-slate-600 dark:text-slate-300">{formatCount(questions.length, 'questão', 'questões')} · {questionSet.is_public ? 'Compartilhado' : 'Privado'}{isDiagnostic ? ' · Diagnóstico' : ''}</p>
      {isDiagnostic && <p className={'text-sm font-semibold ' + (diagnosticReviewed ? 'text-emerald-800 dark:text-emerald-200' : 'text-amber-900 dark:text-amber-200')}>{diagnosticReviewed ? 'Revisão confirmada' : 'Revisão pendente — confira as questões e o gabarito abaixo.'}</p>}
    </header>
    {application.visible && <div data-set-application className="flex flex-wrap items-center gap-2 sm:gap-3">
      {application.ready
        ? <Link className="btn-primary" to={applicationUrl} aria-describedby="set-application-help">{applicationLabel}</Link>
        : <button type="button" className="btn-primary" disabled aria-describedby="set-application-help">{applicationLabel}</button>}
      <p id="set-application-help" className="max-w-xl text-sm text-slate-600 dark:text-slate-300">{application.reason || 'Confira a turma e escolha os estudantes. Nada será aplicado agora.'}</p>
    </div>}
    {params.get('atividade') === 'rapida' && user?.role === 'professor' && isEnabled('pedagogy.operational_cycle') && <section className={surface + ' text-sm'} aria-label="Como usar a atividade rápida">
      <h2 className="font-bold">Atividade salva. Agora confira as questões e as respostas.</h2>
      <p className="mt-1">Ela fica em Meus simulados. Para usar em papel, escolha Imprimir e depois a versão do aluno. Para registrar e acompanhar resultados, prepare a aplicação na turma. Salvar a atividade não a aplica automaticamente.</p>
      <details className="mt-2"><summary className="cursor-pointer font-semibold">Depois da aplicação</summary><p className="mt-1">Abra a turma e a avaliação para registrar as respostas do papel ou acompanhar as respostas on-line. Consulte os resultados em Devolutivas da turma. Poucas questões dão pistas sobre a aprendizagem, não um diagnóstico completo.</p></details>
    </section>}
    <details className={surface + ' text-sm !py-0'}><summary className="cursor-pointer font-semibold">Sobre o simulado</summary><div className="space-y-2 pb-3">
      {questionSet.description && <p className="whitespace-pre-wrap">{questionSet.description}</p>}
      <p>{questionSet.user_name ? 'Criado por ' + questionSet.user_name : 'Autoria não informada'}{questionSet.created_at ? ' · ' + (eventDay(questionSet.created_at) || 'Data não informada') : ''}</p>
      {questionSet.diagnostic_grade_name && <p>Ano do diagnóstico: {questionSet.diagnostic_grade_name}.</p>}
      {predominant && <p>Dificuldade mais frequente: {difficulty[predominant]}. Não é uma nota da turma.</p>}
      {authors > 0 && <p>{formatCount(authors, 'questão criada por professor', 'questões criadas por professores')}.</p>}
      {questionSet.answer_key?.balanced && <p><strong>Gabarito equilibrado.</strong> As respostas corretas foram distribuídas da forma mais equilibrada possível entre A, B, C e D.</p>}
      {diagnosticReviewed && questionSet.diagnostic_reviewed_at && <p>Revisão confirmada em {eventDay(questionSet.diagnostic_reviewed_at) || 'data não informada'}.</p>}
      <Link className="btn-outline" to={setNavigationUrl('/banco-questoes', params)}>Montar outro simulado</Link>
    </div></details>
    {user?.role === 'professor' && isEnabled('pedagogy.operational_cycle') && params.get('turma') && <CycleBankContext compact classId={params.get('turma')} />}
    {error && <section className="space-y-2"><AuthoringWriteAlert message={error} /><button type="button" className="btn-outline" onClick={reload}>Conferir situação salva</button><p className="text-sm">Impressão e alterações ficam bloqueadas até confirmar os dados do servidor.</p></section>}
    <section aria-label="Questões e gabarito" className="space-y-3">
      <h2 ref={firstQuestion} tabIndex={-1} className="text-base font-bold outline-none">Questões e gabarito</h2>
      {!questions.length && <p className={surface}>Este simulado não tem questões. Volte à lista ou monte outro simulado no banco.</p>}
      {questions.map((question, index) => <article key={question.id} data-set-question={question.id} className={surface + ' space-y-3'}>
        <h3 className="text-sm font-bold text-cyan-800 dark:text-cyan-200">Questão {index + 1}</h3>
        <p data-set-statement className="whitespace-pre-wrap text-[15px] font-medium leading-relaxed">{question.statement}</p>
        {question.support_text && <p className="whitespace-pre-wrap rounded-lg bg-slate-100 p-3 text-sm leading-relaxed dark:bg-white/5">{question.support_text}</p>}
        {question.image_path && <div className="space-y-2">
          {Number(question.show_image) !== 0 ? <QuestionVisual question={question} /> : <p className="text-sm text-slate-600 dark:text-slate-300">Imagem não incluída neste simulado.</p>}
          {permissions.canEdit && <button type="button" className="btn-outline" disabled={locked} aria-pressed={Number(question.show_image) !== 0} onClick={event => toggleQuestionImage(question, event.currentTarget)}>{Number(question.show_image) === 0 ? <Eye aria-hidden="true" size={16} /> : <EyeOff aria-hidden="true" size={16} />}{Number(question.show_image) === 0 ? 'Incluir imagem' : 'Ocultar imagem'}</button>}
          {permissions.canEdit && isDiagnostic && diagnosticReviewed && <p className="text-xs text-slate-600 dark:text-slate-300">Após ajustar uma imagem, confira a prévia novamente. A revisão já confirmada não é reiniciada automaticamente.</p>}
        </div>}
        <div className="grid gap-2 md:grid-cols-2">{question.options.map(option => <div key={option.option_label} className={'rounded-lg border p-3 text-sm leading-relaxed ' + (Number(option.is_correct) === 1 ? 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-400/30 dark:bg-emerald-400/10 dark:text-emerald-100' : 'border-slate-200 dark:border-white/10')}>
          <p className="whitespace-pre-wrap"><strong>{option.option_label})</strong> {option.option_text}</p>
          {Number(option.is_correct) === 1 && <p className="mt-1 flex items-center gap-1 text-xs font-semibold"><CheckCircle aria-hidden="true" size={14} /> Alternativa correta</p>}
        </div>)}</div>
        {question.official_explanation && <div className="rounded-lg bg-slate-100 p-3 text-sm dark:bg-white/5"><h4 className="mb-1 font-semibold">Comentário da questão</h4><p className="whitespace-pre-wrap leading-relaxed">{question.official_explanation}</p></div>}
        <details className="text-sm"><summary className="cursor-pointer text-slate-600 dark:text-slate-300">Habilidade e detalhes da questão</summary><div className="space-y-2 pt-2">
          <p><strong>{question.skill_code}</strong> — {question.skill_description}</p>
          <p>{question.grade_name} · {question.unit_name}</p>
          <p>{question.question_code} · {difficulty[question.difficulty]} · {question.source === 'teacher' ? 'Criada por professor' : 'Questão do banco'}</p>
          <p>Espaço para resolução na versão do aluno: {({ none: 'sem espaço extra', small: 'pequeno', medium: 'médio', large: 'grande' })[question.development_space] || 'sem espaço extra'}.</p>
        </div></details>
      </article>)}
    </section>
    {isDiagnostic && <section data-set-review className={surface + ' space-y-2'}>
      <h2 ref={reviewHeading} tabIndex={-1} className="font-bold outline-none">{diagnosticReviewed ? 'Revisão confirmada' : 'Terminou de conferir?'}</h2>
      <p className="text-sm">{diagnosticReviewed ? 'Este diagnóstico já pode ser impresso para os alunos e usado para preparar uma aplicação.' : 'Confira enunciados, imagens, alternativas e respostas antes de liberar o diagnóstico. Nada será aplicado automaticamente.'}</p>
      {permissions.canReview && <button type="button" className="btn-primary" disabled={locked || !questions.length} onClick={confirmDiagnosticReview}>{action.busy ? 'Aguarde…' : 'Confirmar revisão e liberar'}</button>}
      {!diagnosticReviewed && !permissions.canReview && <p className="text-sm">A confirmação cabe ao professor responsável pelo diagnóstico.</p>}
      {diagnosticReviewed && <button type="button" className="btn-outline" disabled={locked} onClick={() => { setPrintError(''); setPrinting(true); }}>Abrir opções de impressão</button>}
    </section>}
    {printing && <AssessmentDialog title="Imprimir simulado" onClose={() => setPrinting(false)}>
      <div className="bank-form space-y-3 p-3 text-sm">
        <p>A prévia abre em outra aba. Confira antes de imprimir ou salvar em PDF.</p>
        <AuthoringWriteAlert message={printError} />
        {isDiagnostic && !diagnosticReviewed && <p className="rounded-lg bg-amber-50 p-3 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">A versão do aluno fica disponível após a confirmação da revisão. Use a versão do professor para conferir o gabarito.</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          <div className={surface + ' space-y-2'}><h3 className="font-bold">Para os alunos</h3><p>Sem respostas marcadas ou comentários. Inclui nome, turma, data e espaço para resolução.</p><button type="button" className="btn-primary" disabled={locked || !readyToApply} onClick={() => openPrint(false)}>Gerar versão do aluno</button></div>
          <div className={surface + ' space-y-2'}><h3 className="font-bold">Para o professor</h3><p>Com respostas corretas, comentários e gabarito ao final. Não entregue esta versão aos alunos.</p><button type="button" className="btn-outline" disabled={locked} onClick={() => openPrint(true)}>Gerar versão do professor</button></div>
        </div>
      </div>
    </AssessmentDialog>}
  </div>;
}
