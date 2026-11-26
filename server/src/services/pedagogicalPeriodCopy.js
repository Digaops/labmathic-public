const { readPeriodCopy, PedagogicalCycleError } = require('./pedagogicalCycle');
const { logActivityStrict } = require('../helpers/activity');
const { reportCsv } = require('./reportCsv');

const date = value => value.split('-').reverse().join('/');
const opened = value => new Date(value).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
function formatPeriodCsv(copy) {
  // Rectangular CSV: one row per assessment, with context on every row for filtering.
  return reportCsv(['Turma', 'Ano escolar', 'Ano letivo', 'Escola', 'Município', 'De', 'Até',
    'Avaliação', 'Código da avaliação', 'Abertura (Brasília)', 'Situação', 'Questões',
    'Participantes (sem dispensados)', 'Dispensados', 'Correções concluídas', 'Correções pendentes',
    'Média das correções concluídas (%)', 'Gerado em (UTC)', 'Revisão conferida', 'Como interpretar', 'Cuidados ao compartilhar'],
  copy.assessments.map(item => [copy.class.name, copy.class.gradeName, copy.class.academicYear,
    copy.class.institution.school || 'Não informada ou consulta indisponível',
    copy.class.institution.municipality || 'Não informado ou consulta indisponível', date(copy.period.start), date(copy.period.end),
    item.title, item.id, opened(item.openedAt), item.status === 'open' ? 'Aberta — resultado parcial' : 'Encerrada', item.questionCount,
    item.overview.participantCount, item.overview.exemptedCount, item.overview.submittedCount, item.overview.pendingCount,
    item.overview.meanPercentage === null ? 'Sem correções concluídas' : item.overview.meanPercentage.toLocaleString('pt-BR'),
    copy.generatedAt, copy.revision, `${copy.notice} Pendentes não são nota zero. Dispensados não entram nos participantes nem na média.`, copy.privacyNotice]));
}

function exportPeriodCopy(db, teacher, classId, body, req, capabilities) {
  if (!body || Object.keys(body).some(key => !['start', 'end', 'expectedRevision', 'privacyConfirmed'].includes(key))
    || typeof body.expectedRevision !== 'string' || !/^[a-f0-9]{64}$/.test(body.expectedRevision) || body.privacyConfirmed !== true)
    throw new PedagogicalCycleError(400, 'invalid_period_export', 'Confira a planilha e confirme o cuidado com o compartilhamento.');
  return db.transaction(() => {
    const copy = readPeriodCopy(db, teacher.id, classId, body, capabilities);
    if (copy.revision !== body.expectedRevision)
      throw new PedagogicalCycleError(409, 'period_changed', 'Os dados do período mudaram. Atualize e confira antes de baixar.');
    const csv = formatPeriodCsv(copy);
    logActivityStrict({ user: teacher, action: 'pedagogical_period_exported', module: 'planning', entityType: 'school_class',
      description: 'Professor preparou a planilha de avaliações por período.',
      metadata: { classId, start: copy.period.start, end: copy.period.end, assessmentCount: copy.total, reportRevision: copy.revision, format: 'csv' }, req }, db);
    return { csv, revision: copy.revision };
  }).immediate();
}
module.exports = { formatPeriodCsv, exportPeriodCopy };
