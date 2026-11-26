import { useEffect, useRef, useState } from 'react';
import { Download, Printer, RefreshCw } from 'lucide-react';
import api from '../services/api';
import AssessmentDialog from './AssessmentDialog';
import RecoveryComparison from './RecoveryComparison';
import { parsePedagogicalReport, reportDate, reportFeedbackLabels, reportInterventionSummary, reportPercent, reportSkillSummary, reportStatusLabels, validReportDownload } from '../services/pedagogicalReportView.mjs';
import { createPedagogicalReportPreview } from '../services/pedagogicalReportPrint.mjs';

const section = 'border-t border-neutral-200 pt-4 dark:border-white/10';

export default function PedagogicalReport({ classId, assessmentId, onClose }) {
  const path = `/pedagogical-cycle/classes/${encodeURIComponent(classId)}/assessments/${encodeURIComponent(assessmentId)}/report`;
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const [consent, setConsent] = useState(false);
  const [download, setDownload] = useState({ busy: false, message: '', failed: false, stale: false });
  const pending = useRef(null); const urls = useRef(new Map()); const live = useRef(false); const messageRef = useRef(null);
  const printPreview = useRef(null);
  useEffect(() => {
    live.current = true;
    const ownedUrls = urls.current;
    return () => {
      live.current = false; pending.current?.abort();
      printPreview.current?.close(); printPreview.current = null;
      for (const [url, timer] of ownedUrls) { clearTimeout(timer); URL.revokeObjectURL(url); }
      ownedUrls.clear();
    };
  }, []);
  useEffect(() => {
    const controller = new AbortController();
    pending.current?.abort(); pending.current = null;
    printPreview.current?.close(); printPreview.current = null;
    setConsent(false); setDownload({ busy: false, message: '', failed: false, stale: false });
    setState({ path, data: null, loading: true, error: '' });
    api.get(path, { signal: controller.signal, timeout: 15000 }).then(response => {
      const data = parsePedagogicalReport(response.data, classId, assessmentId);
      if (!controller.signal.aborted) setState({ path, data, loading: false, error: '' });
    }).catch(error => {
      if (!controller.signal.aborted) setState({ path, data: null, loading: false,
        error: [401, 403, 404].includes(error.response?.status) ? 'Este relatório não está disponível para esta conta.' : 'Não foi possível conferir o relatório. Tente atualizar.' });
    });
    return () => { controller.abort(); pending.current?.abort(); };
  }, [path, retry, classId, assessmentId]);
  useEffect(() => {
    if (download.failed) { messageRef.current?.focus({ preventScroll: true }); messageRef.current?.scrollIntoView({ block: 'nearest' }); }
  }, [download]);
  const report = state.path === path && !state.loading ? state.data : null;
  async function prepareCopy(format) {
    if (!report || !consent || pending.current || download.stale) return;
    const controller = new AbortController(); pending.current = controller;
    setDownload({ busy: true, failed: false, stale: false, message: '' });
    let preview = null;
    try {
      // A new copy (including CSV) invalidates any previously prepared print window.
      printPreview.current?.close(); printPreview.current = null;
      if (format === 'print') {
        preview = createPedagogicalReportPreview(); printPreview.current = preview;
      }
      const response = await api.post(`${path}/${format === 'print' ? 'print' : 'export'}`, { expectedRevision: report.revision, privacyConfirmed: true },
        { signal: controller.signal, timeout: 20000, responseType: format === 'print' ? 'json' : 'blob' });
      if (controller.signal.aborted || !live.current) return;
      if (format === 'print') {
        const copy = parsePedagogicalReport(response.data, classId, assessmentId);
        if (response.status !== 200 || copy.revision !== report.revision || response.headers['x-report-revision'] !== report.revision)
          throw new Error('invalid_print_response');
        preview.render(copy, classId, assessmentId);
        setDownload({ busy: false, failed: false, stale: false, message: 'Prévia pronta em outra aba. Confira o conteúdo e escolha Imprimir / salvar PDF. Ela será fechada ao sair deste relatório.' });
        return;
      }
      if (!validReportDownload(response, report.revision)) throw new Error('invalid_download');
      const url = URL.createObjectURL(response.data);
      urls.current.set(url, setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 30000));
      const link = document.createElement('a'); link.href = url; link.download = 'relatorio-da-turma.csv';
      document.body.appendChild(link);
      try { link.click(); } finally { link.remove(); }
      setDownload({ busy: false, failed: false, stale: false, message: 'Arquivo preparado. Confira o download no seu navegador.' });
    } catch (error) {
      preview?.close();
      if (printPreview.current === preview) printPreview.current = null;
      if (!controller.signal.aborted && live.current) {
        const status = error.response?.status;
        const stale = [401, 403, 404, 409].includes(status);
        setConsent(false);
        if ([401, 403, 404].includes(status)) setState({ path, data: null, loading: false, error: 'Este relatório não está mais disponível para esta conta.' });
        setDownload({ busy: false, failed: true, stale, message: status === 409
          ? 'Os dados mudaram. Atualize o relatório e confira antes de preparar uma cópia.'
          : stale ? 'O acesso ao relatório mudou. Atualize para conferir.'
            : error.message === 'report_popup_blocked' ? 'A prévia não abriu. Permita pop-ups deste site e tente novamente.'
              : error.message === 'report_preview_closed' ? 'A prévia foi fechada. Você pode abri-la novamente.'
                : 'Não foi possível preparar a cópia. Tente novamente.' });
      }
    } finally { if (pending.current === controller) pending.current = null; }
  }
  return <AssessmentDialog title="Relatório da turma" onClose={onClose}>
    <div data-pedagogical-report className="space-y-4 p-3 text-sm sm:p-4 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p>Uma avaliação e o apoio associado a ela.</p>
        <button type="button" className="btn-outline min-h-11" disabled={state.loading || download.busy} onClick={() => setRetry(n => n + 1)}><RefreshCw size={16} aria-hidden="true" /> Atualizar relatório</button>
      </div>
      {state.loading && <p role="status">Reunindo resultados e registros salvos…</p>}
      {state.error && <p role="alert">{state.error}</p>}
      {report && <>
        <header>
          <h3 className="text-lg font-bold">{report.class.name} · {report.class.academicYear}</h3>
          <p>{report.class.gradeName}{report.class.status === 'archived' && ' · Turma arquivada'}</p>
          <p className="mt-1 text-neutral-600 dark:text-neutral-300">{report.class.institution.school || 'Escola não informada ou consulta indisponível'}{report.class.institution.municipality && ` · ${report.class.institution.municipality}`}</p>
          <p>{report.class.institution.status === 'verified' ? 'Vínculo institucional confirmado' : report.class.institution.status === 'unavailable' ? 'Consulta institucional indisponível' : 'Vínculo institucional a confirmar'}</p>
          <p className="mt-2 font-semibold">{report.assessment.title} · {reportStatusLabels[report.assessment.status]}</p>
          <p>{report.assessment.isDiagnostic ? 'Diagnóstico' : 'Avaliação da turma'} · Consulta de {reportDate(report.generatedAt)}</p>
        </header>
        {report.assessment.status === 'open' && <p className="rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">Resultados parciais: esta avaliação ainda está aberta.</p>}
        <section className={section} aria-label="Participação e média">
          <h3 className="mb-2 font-bold">Participação e resultados</h3>
          {report.overview ? <>
            <dl className="grid grid-cols-2 gap-3 rounded-xl bg-slate-50 p-3 dark:bg-white/5 sm:grid-cols-3">
              {[[report.overview.participantCount, 'Participantes'], [report.overview.submittedCount, 'Correções concluídas'],
                [report.overview.pendingCount, 'Correções pendentes'], [report.overview.exemptedCount, 'Dispensados'],
                [report.questionCount, 'Questões'], [reportPercent(report.overview.meanPercentage), 'Média das correções']].map(([value, label]) =>
                <div key={label}><dt className="text-neutral-600 dark:text-neutral-300">{label}</dt><dd className="mt-1 text-lg font-bold">{value}</dd></div>)}
            </dl>
            <p className="mt-2 text-neutral-600 dark:text-neutral-300">A média considera apenas correções concluídas. Pendências não são nota zero. Dispensados não entram nos participantes nem na média.</p>
          </> : <p>Os resultados ficam disponíveis quando a aplicação é aberta. Nesta etapa, não há resumo de correções.</p>}
        </section>
        <section className={section} aria-label="Habilidades no relatório">
          <h3 className="font-bold">O que as respostas mostram</h3>
          {!report.skills.length && <p className="mt-2">Ainda não há resultados por habilidade nesta etapa.</p>}
          <ul className="divide-y divide-neutral-200 dark:divide-white/10">{report.skills.map(skill => <li key={skill.code || 'unassigned'} className="py-3">
            <div className="flex flex-wrap justify-between gap-2 font-bold"><span>{skill.code || 'Sem habilidade informada'}</span><span>{reportPercent(skill.successRate)}</span></div>
            <p className="mt-1">{skill.description}</p>
            <p className="mt-1">{reportSkillSummary(skill)}</p>
            <p className="mt-1 text-neutral-600 dark:text-neutral-300">{skill.evidence.notice}</p>
          </li>)}</ul>
        </section>
        <section className={section} aria-label="Apoio e verificação no relatório">
          <h3 className="font-bold">Apoio à turma e nova verificação</h3>
          {!report.capabilities.recovery ? <p className="mt-2">Recomposição não habilitada para esta conta.</p>
            : !report.plans.length && <p className="mt-2">Nenhum plano associado a esta avaliação.</p>}
          {report.morePlans && <p className="mt-2 font-semibold">Este relatório inclui somente os 20 planos mais recentes. Há outros planos fora deste recorte.</p>}
          {report.plans.map(plan => <article key={plan.id} className="mt-3 space-y-2 rounded-xl border border-neutral-200 p-3 dark:border-white/10">
            <h4 className="font-bold">{plan.title}</h4>
            <p>{reportStatusLabels[plan.status]} · {reportInterventionSummary(plan)}</p>
            <p>Verificação: {plan.monitoring ? reportStatusLabels[plan.monitoring.state] : 'ainda não preparada'}.</p>
            {plan.monitoring?.application && <p>{plan.monitoring.application.title}</p>}
            {plan.monitoring?.comparison && <RecoveryComparison comparison={plan.monitoring.comparison} />}
          </article>)}
        </section>
        <section className={section} aria-label="Registro salvo no relatório">
          <h3 className="font-bold">Seu registro pedagógico salvo</h3>
          <p className="mt-1 text-neutral-600 dark:text-neutral-300">Rascunhos ainda não salvos não entram neste relatório. Fechar esta consulta não altera o que você está escrevendo.</p>
          {!report.feedback ? <p className="mt-2">Nenhum registro salvo para esta avaliação.</p> : <>
            <p className="mt-2">Revisão {report.feedback.revision} · Salva em {reportDate(report.feedback.createdAt)}</p>
            {report.feedbackStale && <p className="mt-2 rounded-lg bg-amber-50 p-3 text-amber-900 dark:bg-amber-400/10 dark:text-amber-200">Os dados usados neste relatório mudaram desde que você salvou seu registro. Seu texto foi mantido; confira se ele ainda corresponde aos resultados atuais.</p>}
            <dl className="mt-3 space-y-3">{Object.entries(reportFeedbackLabels).map(([key, label]) => <div key={key}><dt className="font-semibold">{label}</dt><dd className="mt-1 whitespace-pre-wrap">{report.feedback[key]}</dd></div>)}</dl>
          </>}
        </section>
        <p className="text-neutral-600 dark:text-neutral-300">{report.notice}</p>
        <section className={section} aria-label="Baixar relatório">
          <h3 className="font-bold">Guardar uma cópia</h3>
          <p className="mt-1">CSV é um arquivo de planilha que pode ser aberto no Excel ou LibreOffice.</p>
          <p className="mt-1">Para imprimir ou guardar um PDF, abra a prévia. Você pode escolher um texto maior antes de imprimir.</p>
          <p className="mt-2 text-neutral-600 dark:text-neutral-300">{report.privacyNotice}</p>
          <label className="my-3 flex min-h-11 cursor-pointer items-start gap-2 py-2"><input type="checkbox" className="mt-0.5 h-5 w-5 shrink-0" checked={consent} disabled={download.busy || download.stale} onChange={e => setConsent(e.target.checked)} /><span>Vou conferir os textos e compartilhar apenas com pessoas autorizadas.</span></label>
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn-primary min-h-11" disabled={!consent || download.busy || download.stale} onClick={() => prepareCopy('print')}><Printer size={16} aria-hidden="true" />Imprimir / salvar PDF</button>
            <button type="button" className="btn-outline min-h-11" disabled={!consent || download.busy || download.stale} onClick={() => prepareCopy('csv')}><Download size={16} aria-hidden="true" />Baixar relatório CSV</button>
          </div>
          {download.busy && <p className="mt-2" role="status">Conferindo dados e preparando a cópia…</p>}
        </section>
      </>}
      {download.message && <p ref={messageRef} tabIndex={-1} role={download.failed ? 'alert' : 'status'} className="rounded-lg border border-neutral-200 p-3 dark:border-white/10">{download.message}</p>}
    </div>
  </AssessmentDialog>;
}
