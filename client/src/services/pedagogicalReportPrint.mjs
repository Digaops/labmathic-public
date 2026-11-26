import { parsePedagogicalReport, reportDate, reportFeedbackLabels, reportInterventionSummary, reportPercent, reportSkillSummary, reportStatusLabels } from './pedagogicalReportView.mjs';
import { recoveryComparisonView, quantity } from './recoveryComparisonView.mjs';

const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const text = value => `<p>${escapeHtml(value)}</p>`;
const notice = value => `<p class="notice">${escapeHtml(value)}</p>`;
const row = (label, value) => `<div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`;
const styles = `
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; overflow-wrap: anywhere; }
  body { max-width: 190mm; margin: 0 auto; padding: 16px; color: #172033; background: #fff;
    font: 12pt/1.5 Arial, Helvetica, sans-serif; }
  body.large-text { font-size: 14pt; }
  h1 { margin: 0 0 6px; font-size: 1.6em; line-height: 1.2; }
  h2 { margin: 0 0 8px; font-size: 1.2em; }
  h3 { margin: 0 0 6px; font-size: 1.05em; }
  h1, h2, h3 { break-after: avoid; }
  p { margin: 6px 0; white-space: pre-wrap; orphans: 3; widows: 3; }
  header { border-bottom: 2px solid #334155; padding-bottom: 12px; }
  section { margin-top: 18px; }
  article { border-top: 1px solid #cbd5e1; padding-top: 10px; margin-top: 10px; }
  dl { margin: 10px 0; }
  dt { font-weight: 700; break-after: avoid; }
  dd { margin: 2px 0 10px; white-space: pre-wrap; orphans: 3; widows: 3; }
  .metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
  .metrics > div { break-inside: avoid; }
  .metrics dd { margin-bottom: 0; }
  .notice { border-left: 3px solid #64748b; padding: 4px 10px; }
  .print-tools { border: 1px solid #cbd5e1; padding: 12px; margin-bottom: 16px; }
  .actions { display: flex; flex-wrap: wrap; gap: 8px; }
  button, label { font: inherit; min-height: 44px; }
  button { border: 1px solid #475569; border-radius: 6px; padding: 8px 12px; background: #fff; color: #172033; cursor: pointer; }
  button:focus-visible, input:focus-visible { outline: 3px solid #0369a1; outline-offset: 3px; }
  button:disabled { color: #475569; cursor: wait; }
  label { display: flex; align-items: center; gap: 8px; padding: 8px 0; }
  input { width: 20px; height: 20px; }
  footer { margin-top: 18px; border-top: 1px solid #cbd5e1; padding-top: 10px; font-size: .85em; }
  @media (max-width: 480px) { body { padding: 12px; } .metrics { grid-template-columns: 1fr; } }
  @media print { body { max-width: none; padding: 0; } .print-tools { display: none !important; }
    .metrics { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
`;

function documentShell(content, ready = false) {
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; object-src 'none'">
    <meta name="referrer" content="no-referrer"><title>LabMathic — Relatório da turma</title><style>${styles}</style></head><body>
    <div class="print-tools" aria-label="Controles da impressão"><p id="report-print-status" role="status">${ready
      ? 'Confira esta cópia antes de imprimir. Para guardar um PDF, escolha Salvar como PDF na janela de impressão.'
      : 'Conferindo a versão do relatório…'}</p>
    <div class="actions"><button id="report-print-button"${ready ? '' : ' disabled'}>Imprimir / salvar PDF</button><button id="report-print-close">Fechar prévia</button></div>
    <label><input id="report-print-large" type="checkbox"${ready ? '' : ' disabled'}>Usar texto maior</label>
    <p>Esta prévia não se atualiza sozinha e será fechada quando você sair do relatório.</p></div>${content}</body></html>`;
}

function comparisonHtml(comparison) {
  const view = recoveryComparisonView(comparison);
  return notice(view.notice) + view.skills.map(skill => `<article><h3>${escapeHtml(skill.code)}</h3>
    ${text(skill.description)}${text(skill.groupLabel)}
    ${text(`Com respostas completas: diagnóstico ${skill.cohort.diagnosticStudentCount} · verificação ${skill.cohort.monitoringStudentCount}.`)}
    ${text(`Fora da comparação por não terem respostas completas nas duas etapas: diagnóstico ${skill.cohort.excludedDiagnosticCount} · verificação ${skill.cohort.excludedMonitoringCount}.`)}
    ${skill.comparable ? `<dl class="metrics">${['diagnostic', 'monitoring'].map(stage => row(stage === 'diagnostic' ? 'Diagnóstico' : 'Verificação',
      `${reportPercent(skill[`${stage}Rate`])} · ${quantity(skill[`${stage}QuestionCount`], 'questão', 'questões')} · ${quantity(skill[`${stage}Opportunities`], 'resposta corrigida', 'respostas corrigidas')}`)).join('')}</dl>
      ${text(`Diferença de acertos: ${skill.delta > 0 ? '+' : ''}${skill.delta.toLocaleString('pt-BR')} pontos percentuais.`)}${notice(skill.evidenceNotice)}`
      : text('Sem comparação disponível.')}</article>`).join('');
}

export function getPedagogicalReportPrintDocument(value, classId, assessmentId) {
  const report = parsePedagogicalReport(value, classId, assessmentId);
  const overview = report.overview;
  const content = `<header><p>LabMathic · Uso pedagógico restrito</p><h1>Relatório da turma</h1>
    <h2>${escapeHtml(report.class.name)} · ${report.class.academicYear}</h2>
    ${text(`${report.class.gradeName}${report.class.status === 'archived' ? ' · Turma arquivada' : ''}`)}
    ${text([report.class.institution.school || 'Escola não informada ou consulta indisponível', report.class.institution.municipality].filter(Boolean).join(' · '))}
    ${text(report.class.institution.status === 'verified' ? 'Vínculo institucional confirmado' : report.class.institution.status === 'unavailable' ? 'Consulta institucional indisponível' : 'Vínculo institucional a confirmar')}
    ${text(`${report.assessment.title} · ${reportStatusLabels[report.assessment.status]}`)}
    ${text(`${report.assessment.isDiagnostic ? 'Diagnóstico' : 'Avaliação da turma'} · Cópia de ${reportDate(report.generatedAt)}`)}
    ${text('Uma avaliação e o apoio associado a ela; não é um relatório por período.')}</header><main>
    ${report.assessment.status === 'open' ? notice('Resultados parciais: esta avaliação ainda está aberta.') : ''}
    <section><h2>Participação e resultados</h2>${overview ? `<dl class="metrics">${[
      ['Participantes (sem dispensados)', overview.participantCount], ['Correções concluídas', overview.submittedCount],
      ['Correções pendentes', overview.pendingCount], ['Dispensados', overview.exemptedCount], ['Questões', report.questionCount],
      ['Média apenas das correções concluídas', reportPercent(overview.meanPercentage)],
    ].map(([label, value]) => row(label, value)).join('')}</dl>
    ${text('Pendências não são nota zero. Dispensados não entram nos participantes nem na média.')}` : text('Resultados indisponíveis nesta etapa da aplicação.')}</section>
    <section><h2>O que as respostas mostram</h2>${report.skills.length ? report.skills.map(skill => `<article><h3>${escapeHtml(skill.code || 'Sem habilidade informada')} · ${escapeHtml(reportPercent(skill.successRate))}</h3>
      ${text(skill.description)}${text(reportSkillSummary(skill))}${notice(skill.evidence.notice)}</article>`).join('')
      : text('Ainda não há resultados por habilidade nesta etapa.')}</section>
    <section><h2>Apoio à turma e nova verificação</h2>
    ${!report.capabilities.recovery ? text('Recomposição não habilitada para esta conta.') : !report.plans.length ? text('Nenhum plano associado a esta avaliação.') : ''}
    ${report.morePlans ? notice('Somente os 20 planos mais recentes. Há outros planos fora deste relatório.') : ''}
    ${report.plans.map(plan => `<article><h3>${escapeHtml(plan.title)}</h3>${text(reportStatusLabels[plan.status])}
      ${text(reportInterventionSummary(plan))}
      ${text(`Verificação: ${plan.monitoring ? reportStatusLabels[plan.monitoring.state] : 'ainda não preparada'}.`)}
      ${plan.monitoring?.application ? text(plan.monitoring.application.title) : ''}
      ${plan.monitoring?.comparison ? comparisonHtml(plan.monitoring.comparison) : ''}</article>`).join('')}</section>
    <section><h2>Registro pedagógico salvo</h2>${report.feedback ? `${text(`Revisão ${report.feedback.revision} · Salva em ${reportDate(report.feedback.createdAt)}`)}
      ${report.feedbackStale ? notice('Os dados usados neste relatório mudaram desde que você salvou seu registro. Seu texto foi mantido; confira se ele ainda corresponde aos resultados atuais.') : ''}
      <dl>${Object.entries(reportFeedbackLabels).map(([key, label]) => row(label, report.feedback[key])).join('')}</dl>`
      : text('Nenhum registro salvo para esta avaliação.')}${text('Rascunhos ainda não salvos não entram neste relatório.')}</section>
    ${notice(report.notice)}</main><footer>${text(report.privacyNotice)}${text(`Revisão conferida: ${report.revision}`)}</footer>`;
  return documentShell(content, true);
}

// Reserve a blank window during the user's click; fill it only after server authorization/audit.
// No report, token, HTML or student information is passed through a URL or browser storage.
export function createPedagogicalReportPreview(openWindow = () => window.open('', '_blank'), lifecycleTarget = typeof window === 'undefined' ? null : window) {
  const preview = openWindow();
  if (!preview) throw new Error('report_popup_blocked');
  let active = true;
  const close = () => {
    active = false; lifecycleTarget?.removeEventListener('pagehide', close);
    try { if (!preview.closed) preview.close(); } catch { /* Already detached. */ }
  };
  function install(html, ready) {
    preview.document.open(); preview.document.write(html); preview.document.close();
    const doc = preview.document;
    doc.getElementById('report-print-close').addEventListener('click', close);
    if (ready) {
      doc.getElementById('report-print-large').addEventListener('change', event => doc.body.classList.toggle('large-text', event.target.checked));
      doc.getElementById('report-print-button').addEventListener('click', () => {
        if (!active || preview.closed) return;
        try { preview.focus(); preview.print(); }
        catch { doc.getElementById('report-print-status').textContent = 'Não foi possível abrir a impressão. Tente o comando Imprimir do navegador.'; }
      });
    }
  }
  try {
    lifecycleTarget?.addEventListener('pagehide', close);
    preview.opener = null; install(documentShell(''), false);
  }
  catch (error) { close(); throw error; }
  return { close, render(report, classId, assessmentId) {
    if (!active || preview.closed) throw new Error('report_preview_closed');
    try { install(getPedagogicalReportPrintDocument(report, classId, assessmentId), true); preview.focus(); }
    catch (error) { close(); throw error; }
  } };
}
