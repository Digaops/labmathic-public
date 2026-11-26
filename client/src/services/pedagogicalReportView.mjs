import { validateRecoveryComparison, matchedMethodology, quantity } from './recoveryComparisonView.mjs';

export const reportFeedbackLabels = { objective: 'O que a turma precisa aprender?', observation: 'O que você observou?',
  action: 'Como ajudar a turma?', verification: 'Como conferir o avanço?' };
export const reportStatusLabels = { draft: 'Rascunho', scheduled: 'Agendada', open: 'Aberta', closed: 'Encerrada',
  cancelled: 'Cancelada', active: 'Em execução', completed: 'Concluída', archived: 'Arquivada',
  needs_application: 'Ainda não aplicada', evidence_ready: 'Com resultados', awaiting_results: 'Sem correções concluídas' };
export const reportPercent = value => value === null ? 'Sem resultado' : `${value.toLocaleString('pt-BR')}%`;
export const reportSkillSummary = skill => `${quantity(skill.correctCount, 'acerto', 'acertos')} em ${quantity(skill.opportunities, 'resposta corrigida', 'respostas corrigidas')} · ${quantity(skill.questionCount, 'questão', 'questões')}.`;
export const reportInterventionSummary = plan => plan.executionStatus
  ? `${plan.interventionHandled} de ${quantity(plan.interventionCount, 'intervenção', 'intervenções')} com registro (${plan.interventionCount === 1 ? 'ministrada ou dispensada' : 'ministradas ou dispensadas'})`
  : 'Execução ainda não organizada';
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.trim().length > 0;

// Only local blob downloads stay in this document. A download attribute on an
// external URL is not enough: browsers may ignore it and navigate instead.
export function isLocalReportDownload(link, origin) {
  if (!link?.hasAttribute?.('download')) return false;
  try {
    const url = new URL(link.href);
    return url.protocol === 'blob:' && url.origin === origin && origin !== 'null';
  } catch { return false; }
}
const rate = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
const bool = value => typeof value === 'boolean';
const fail = () => { throw new Error('Não foi possível conferir o relatório. Tente atualizar.'); };
const evidence = value => value && ['insufficient', 'limited', 'moderate', 'broader'].includes(value.level) && text(value.notice);
const applicationStatus = value => ['draft', 'scheduled', 'open', 'closed', 'cancelled'].includes(value);
const optionalText = value => value === null || value === undefined || typeof value === 'string';
const planStatus = value => ['draft', 'active', 'completed', 'archived'].includes(value);

export function reportDate(value) {
  // SQLite CURRENT_TIMESTAMP is UTC; it must not be read as the device's local time.
  const timestamp = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + 'Z' : value;
  if (typeof timestamp !== 'string' || !/(Z|[+-]\d{2}:\d{2})$/.test(timestamp) || !Number.isFinite(Date.parse(timestamp)))
    return 'Data indisponível';
  return new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' })
    .format(new Date(timestamp)) + ' (Brasília)';
}

export function parsePedagogicalReport(value, classId, assessmentId) {
  if (!value || value.version !== 'class-assessment-report-v1' || !/^[a-f0-9]{64}$/.test(value.revision || '')
    || !text(value.generatedAt) || reportDate(value.generatedAt) === 'Data indisponível'
    || !value.class || value.class.id !== classId || !text(value.class.name) || !text(value.class.gradeName)
    || !count(value.class.academicYear) || !['active', 'archived'].includes(value.class.status)
    || !text(value.class.institution?.status) || !optionalText(value.class.institution.school) || !optionalText(value.class.institution.municipality)
    || !value.assessment || value.assessment.id !== assessmentId
    || !text(value.assessment.title) || !applicationStatus(value.assessment.status) || !bool(value.assessment.isDiagnostic)
    || !bool(value.capabilities?.institutions) || !bool(value.capabilities?.recovery)
    || !bool(value.morePlans) || !bool(value.feedbackStale) || !text(value.notice) || !text(value.privacyNotice)
    || !Array.isArray(value.skills) || !Array.isArray(value.plans) || value.plans.length > 20) fail();
  const overview = value.overview;
  if (overview === null) {
    if (value.questionCount !== null || value.skills.length || ['open', 'closed'].includes(value.assessment.status)) fail();
  } else {
    if (!overview || !['open', 'closed'].includes(value.assessment.status) || !count(value.questionCount)
      || !['participantCount', 'exemptedCount', 'submittedCount', 'pendingCount'].every(key => count(overview[key]))
      || overview.participantCount !== overview.submittedCount + overview.pendingCount || !rate(overview.meanPercentage)
      || (overview.submittedCount === 0) !== (overview.meanPercentage === null)) fail();
  }
  if (new Set(value.skills.map(skill => skill?.code)).size !== value.skills.length) fail();
  value.skills.forEach(skill => {
    if (!skill || !(skill.code === null || text(skill.code)) || !(skill.description === null || text(skill.description))
      || !['questionCount', 'opportunities', 'correctCount'].every(key => count(skill[key]))
      || !skill.questionCount || skill.correctCount > skill.opportunities || !rate(skill.successRate) || !evidence(skill.evidence)
      || skill.opportunities > overview.submittedCount * skill.questionCount
      || (skill.opportunities === 0 ? skill.successRate !== null
        : skill.successRate !== Number(((skill.correctCount * 100) / skill.opportunities).toFixed(2)))) fail();
  });
  if (overview && value.skills.reduce((sum, skill) => sum + skill.questionCount, 0) !== value.questionCount) fail();
  if (!value.capabilities.recovery && (value.plans.length || value.morePlans)) fail();
  if (!value.capabilities.institutions && (value.class.institution.school || value.class.institution.municipality)) fail();
  if (new Set(value.plans.map(plan => plan?.id)).size !== value.plans.length) fail();
  value.plans.forEach(plan => {
    if (!plan || !text(plan.id) || !text(plan.title) || !planStatus(plan.status)
      || !(plan.executionStatus === null || planStatus(plan.executionStatus))
      || !count(plan.interventionCount) || !count(plan.interventionHandled) || plan.interventionHandled > plan.interventionCount) fail();
    if (plan.monitoring !== null) {
      const monitoring = plan.monitoring;
      if (!monitoring || !['needs_application', 'draft', 'scheduled', 'open', 'evidence_ready', 'awaiting_results', 'cancelled'].includes(monitoring.state)) fail();
      if (monitoring.application !== null && (!monitoring.application || !text(monitoring.application.title)
        || !applicationStatus(monitoring.application.status))) fail();
      if (monitoring.comparison !== null) {
        if (monitoring.state !== 'evidence_ready' || monitoring.application?.status !== 'closed'
          || monitoring.comparison?.methodology !== matchedMethodology || !text(monitoring.comparison.notice)) fail();
        validateRecoveryComparison(monitoring.comparison);
        monitoring.comparison.skills.forEach(skill => {
          if (!optionalText(skill.description) || !evidence(skill.evidence)) fail();
        });
      }
    }
  });
  if (value.feedback !== null && (!value.feedback || !count(value.feedback.revision) || !value.feedback.revision
    || reportDate(value.feedback.createdAt) === 'Data indisponível'
    || !Object.keys(reportFeedbackLabels).every(key => text(value.feedback[key]) && value.feedback[key].length <= 2000))) fail();
  return value;
}

// Fail closed before making an object URL. An HTML/JSON error must never become a CSV download.
export function validReportDownload(response, revision) {
  return response?.status === 200 && response.headers?.['content-type']?.toLowerCase().startsWith('text/csv')
    && response.headers?.['x-report-revision'] === revision && response.data instanceof Blob && response.data.size > 0;
}
