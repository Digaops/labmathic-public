const crypto = require('node:crypto');
const { cycleDetail, PedagogicalCycleError } = require('./pedagogicalCycle');
const { logActivityStrict } = require('../helpers/activity');
const { reportCsv } = require('./reportCsv');

const pick = (value, keys) => Object.fromEntries(keys.map(key => [key, value[key]]));
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const feedbackLabels = { objective: 'O que a turma precisa aprender?', observation: 'O que o professor observou?',
  action: 'Como ajudar a turma?', verification: 'Como conferir o avanço?' };
const statusLabels = { draft: 'Rascunho', scheduled: 'Agendada', open: 'Aberta', closed: 'Encerrada',
  cancelled: 'Cancelada', active: 'Em execução', completed: 'Concluída', archived: 'Arquivada',
  needs_application: 'Ainda não aplicada', evidence_ready: 'Com resultados', awaiting_results: 'Sem correções concluídas' };
const percent = value => value == null ? 'Sem resultado' : `${value.toLocaleString('pt-BR')}%`;

// Explicit projection: additions to the results service must not silently enter an export.
function comparisonSummary(value) {
  if (!value) return null;
  return { methodology: value.methodology, notice: value.notice, skills: value.skills.map(skill => ({
    ...pick(skill, ['code', 'description', 'diagnosticRate', 'monitoringRate', 'delta',
      'diagnosticQuestionCount', 'monitoringQuestionCount', 'diagnosticOpportunities', 'monitoringOpportunities']),
    cohort: pick(skill.cohort, ['status', 'studentCount', 'diagnosticStudentCount', 'monitoringStudentCount',
      'excludedDiagnosticCount', 'excludedMonitoringCount']),
    evidence: pick(skill.evidence, ['level', 'notice']),
  })) };
}

function buildReport(db, teacherId, classId, assessmentId, capabilities) {
  const detail = cycleDetail(db, teacherId, classId, assessmentId, capabilities);
  const evidence = detail.evidence;
  const report = {
    version: 'class-assessment-report-v1',
    class: { ...pick(detail.class, ['id', 'name', 'gradeName', 'academicYear', 'status']),
      institution: pick(detail.class.institution, ['status', 'municipality', 'school']) },
    assessment: pick(detail.assessment, ['id', 'title', 'status', 'isDiagnostic']),
    capabilities: pick(detail.capabilities, ['institutions', 'recovery']),
    questionCount: evidence?.assessment.questionCount ?? null,
    overview: evidence ? pick(evidence.overview, ['participantCount', 'exemptedCount', 'submittedCount', 'pendingCount', 'meanPercentage']) : null,
    skills: (evidence?.skills || []).map(skill => ({
      ...pick(skill, ['code', 'description', 'questionCount', 'opportunities', 'correctCount', 'successRate']),
      evidence: pick(skill.evidence, ['level', 'notice']),
    })),
    plans: detail.plans.map(plan => ({
      ...pick(plan, ['id', 'title', 'status', 'executionStatus', 'interventionCount', 'interventionHandled']),
      monitoring: plan.monitoring ? { state: plan.monitoring.state,
        application: plan.monitoring.application ? pick(plan.monitoring.application, ['title', 'status']) : null,
        comparison: comparisonSummary(plan.monitoring.comparison) } : null,
    })),
    morePlans: detail.morePlans,
    feedback: detail.feedback ? pick(detail.feedback, ['revision', 'createdAt', ...Object.keys(feedbackLabels)]) : null,
    feedbackStale: detail.feedbackStale,
    notice: detail.notice,
    privacyNotice: 'Uso pedagógico restrito. O arquivo não inclui uma lista de estudantes, mas os textos escritos pelo professor podem conter dados pessoais. Confira antes de compartilhar.',
  };
  // The source hash also detects changed corrections whose rounded totals stayed the same.
  return { ...report, revision: hash([report, detail.evidenceHash]), generatedAt: new Date().toISOString() };
}

function readReport(db, teacherId, classId, assessmentId, capabilities) {
  return db.transaction(() => buildReport(db, teacherId, classId, assessmentId, capabilities)).deferred();
}

function formatReportCsv(report) {
  const rows = [];
  const add = (section, reference, label, value) => rows.push([section, reference, label, value]);
  const context = (label, value) => add('Contexto', '', label, value);
  context('Relatório', 'Uma avaliação da turma; não é um relatório por período');
  context('Turma', report.class.name); context('Ano escolar', report.class.gradeName);
  context('Situação da turma', report.class.status === 'active' ? 'Ativa' : 'Arquivada');
  context('Ano letivo', report.class.academicYear);
  context('Escola', report.class.institution.school || 'Não informada ou consulta indisponível');
  context('Município', report.class.institution.municipality || 'Não informado ou consulta indisponível');
  context('Vínculo institucional', report.class.institution.status === 'verified' ? 'Confirmado'
    : report.class.institution.status === 'unavailable' ? 'Consulta indisponível' : 'A confirmar');
  context('Avaliação', report.assessment.title); context('Situação', statusLabels[report.assessment.status]);
  context('Tipo', report.assessment.isDiagnostic ? 'Diagnóstico' : 'Avaliação da turma');
  context('Gerado em (UTC)', report.generatedAt); context('Revisão conferida', report.revision);
  context('Cuidados', report.privacyNotice); context('Leitura dos resultados', report.notice);
  if (report.assessment.status === 'open') context('Resultados parciais', 'A avaliação ainda está aberta.');
  if (report.overview) {
    for (const [key, label] of Object.entries({ participantCount: 'Participantes (sem dispensados)',
      exemptedCount: 'Dispensados', submittedCount: 'Correções concluídas', pendingCount: 'Correções pendentes' }))
      add('Participação', '', label, report.overview[key]);
    add('Participação', '', 'Questões da avaliação', report.questionCount);
    add('Participação', '', 'Média apenas das correções concluídas', percent(report.overview.meanPercentage));
    add('Participação', '', 'Como ler', 'Pendências não são nota zero. Dispensados não entram nos participantes nem na média.');
  } else add('Participação', '', 'Disponibilidade', 'Resultados indisponíveis nesta etapa da aplicação.');
  for (const skill of report.skills) {
    const ref = skill.code || 'Sem habilidade informada';
    for (const [label, value] of [['Descrição', skill.description], ['Questões', skill.questionCount],
      ['Respostas corrigidas', skill.opportunities], ['Acertos', skill.correctCount], ['Percentual de acertos', percent(skill.successRate)],
      ['Cuidados', skill.evidence.notice]]) add('Habilidades', ref, label, value);
  }
  if (!report.capabilities.recovery) add('Apoio', '', 'Disponibilidade', 'Recomposição não habilitada para esta conta.');
  else if (!report.plans.length) add('Apoio', '', 'Disponibilidade', 'Nenhum plano associado a esta avaliação.');
  if (report.morePlans) add('Apoio', '', 'Recorte', 'Somente os 20 planos mais recentes; há outros planos fora deste relatório.');
  for (const [index, plan] of report.plans.entries()) {
    const ref = `${index + 1}. ${plan.title}`;
    add('Apoio', ref, 'Situação', statusLabels[plan.status]);
    add('Apoio', ref, 'Intervenções planejadas', plan.interventionCount);
    add('Apoio', ref, 'Intervenções com registro (ministradas ou dispensadas)', plan.interventionHandled);
    add('Apoio', ref, 'Execução', plan.executionStatus ? statusLabels[plan.executionStatus] || plan.executionStatus : 'Ainda não organizada');
    add('Verificação', ref, 'Situação', plan.monitoring ? statusLabels[plan.monitoring.state] : 'Ainda não preparada');
    if (plan.monitoring?.application) add('Verificação', ref, 'Avaliação', plan.monitoring.application.title);
    const comparison = plan.monitoring?.comparison;
    if (!comparison) continue;
    add('Verificação', ref, 'Cuidados', comparison.notice);
    for (const skill of comparison.skills) {
      const skillRef = `${ref} · ${skill.code}`;
      add('Comparação', skillRef, 'Descrição', skill.description);
      add('Comparação', skillRef, 'Estudantes comparados nas duas etapas', skill.cohort.studentCount);
      add('Comparação', skillRef, 'Disponibilidade', skill.cohort.status === 'matched' ? 'Mesmo grupo, por habilidade'
        : skill.cohort.status === 'no_common_results' ? 'Sem respostas completas nas duas etapas' : 'Não há duas avaliações encerradas disponíveis');
      for (const [stage, label] of [['diagnostic', 'Diagnóstico'], ['monitoring', 'Verificação']]) {
        add('Comparação', skillRef, `${label}: estudantes com respostas completas`, skill.cohort[`${stage}StudentCount`]);
        add('Comparação', skillRef, `${label}: estudantes fora da comparação`, skill.cohort[stage === 'diagnostic' ? 'excludedDiagnosticCount' : 'excludedMonitoringCount']);
        add('Comparação', skillRef, `${label}: questões`, skill[`${stage}QuestionCount`]);
        add('Comparação', skillRef, `${label}: respostas do grupo comparado`, skill[`${stage}Opportunities`]);
        add('Comparação', skillRef, `${label}: acertos do grupo comparado`, percent(skill[`${stage}Rate`]));
      }
      add('Comparação', skillRef, 'Diferença em pontos percentuais', skill.delta == null ? 'Sem comparação' : skill.delta);
      add('Comparação', skillRef, 'Limitação da evidência', skill.evidence.notice);
    }
  }
  if (!report.feedback) add('Registro docente', '', 'Disponibilidade', 'Nenhum registro salvo; rascunhos não entram no relatório.');
  else {
    add('Registro docente', '', 'Revisão salva', report.feedback.revision);
    add('Registro docente', '', 'Salvo em', report.feedback.createdAt);
    add('Registro docente', '', 'Conferência', report.feedbackStale ? 'A referência mudou desde este registro; revise antes de usar.' : 'Registro baseado na referência atual.');
    for (const [key, label] of Object.entries(feedbackLabels)) add('Registro docente', '', label, report.feedback[key]);
  }
  return reportCsv(['Seção', 'Referência', 'Informação', 'Valor'], rows);
}

function prepareExport(db, teacher, classId, assessmentId, body, req, capabilities, format) {
  if (!body || Object.keys(body).some(key => !['expectedRevision', 'privacyConfirmed'].includes(key))
    || typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision) || body.privacyConfirmed !== true)
    throw new PedagogicalCycleError(400, 'invalid_report_export', 'Confira o relatório e confirme o cuidado com o compartilhamento.');
  return db.transaction(() => {
    const report = buildReport(db, teacher.id, classId, assessmentId, capabilities);
    if (report.revision !== body.expectedRevision)
      throw new PedagogicalCycleError(409, 'report_changed', 'O relatório mudou. Atualize e confira antes de preparar uma cópia.');
    const result = format === 'csv' ? { csv: formatReportCsv(report), revision: report.revision } : report;
    logActivityStrict({ user: teacher, action: format === 'csv' ? 'pedagogical_report_exported' : 'pedagogical_report_print_prepared', module: 'planning',
      entityType: 'class_assessment', description: format === 'csv' ? 'Professor preparou o CSV do relatório pedagógico da turma.'
        : 'Professor preparou a prévia de impressão do relatório pedagógico da turma.',
      metadata: { classId, assessmentId, reportRevision: report.revision, format }, req }, db);
    return result;
  }).immediate();
}

const exportReport = (...args) => prepareExport(...args, 'csv');
const prepareReportPrint = (...args) => prepareExport(...args, 'print');
module.exports = { readReport, exportReport, prepareReportPrint, formatReportCsv };
