const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const view = import('../../client/src/services/pedagogicalReportView.mjs');
const fixture = () => ({ version: 'class-assessment-report-v1', revision: 'a'.repeat(64), generatedAt: '2026-09-15T12:00:00Z',
  class: { id: 'class-1', name: '7º A', gradeName: '7º Ano', academicYear: 2026, status: 'active', institution: { status: 'pending' } },
  assessment: { id: 'assessment-1', title: 'Números', status: 'open', isDiagnostic: true },
  capabilities: { institutions: true, recovery: true }, questionCount: 2,
  overview: { participantCount: 12, exemptedCount: 1, submittedCount: 10, pendingCount: 2, meanPercentage: 75 },
  skills: [{ code: 'EF07MA01', description: 'Números inteiros', questionCount: 2, opportunities: 20, correctCount: 15, successRate: 75,
    evidence: { level: 'moderate', notice: 'Considere também as observações em sala.' } }],
  plans: [], morePlans: false, feedback: null, feedbackStale: false, notice: 'Resultados descritivos.', privacyNotice: 'Uso restrito.' });

test('download blob local não abandona rascunho; links externos e navegação continuam protegidos', async () => {
  const { isLocalReportDownload } = await view;
  const origin = 'http://127.0.0.1:5187';
  const link = (href, download = true) => ({ href, hasAttribute: name => name === 'download' && download });
  assert.equal(isLocalReportDownload(link(`blob:${origin}/abc`), origin), true);
  for (const value of [null, link(`blob:${origin}/abc`, false), link('blob:https://external.example/abc'),
    link(`${origin}/outra-tela`), link('https://external.example/export'), link('data:text/csv,a,b'),
    link('javascript:alert(1)'), link('invalid'), link('blob:null/abc')]) {
    assert.equal(isLocalReportDownload(value, origin), false);
  }
  assert.equal(isLocalReportDownload(link('blob:null/abc'), 'null'), false);
  const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/PedagogicalCycle.jsx'), 'utf8');
  assert.match(page, /isLocalReportDownload\(link, window\.location\.origin\)/);
  assert.match(page, /window\.confirm\('Há alterações não salvas na devolutiva/);
});

test('relatório valida contexto e distingue nenhum resultado de zero acertos', async () => {
  const { parsePedagogicalReport, reportPercent } = await view;
  assert.equal(parsePedagogicalReport(fixture(), 'class-1', 'assessment-1').overview.pendingCount, 2);
  for (const [classId, assessmentId] of [['another', 'assessment-1'], ['class-1', 'another']])
    assert.throws(() => parsePedagogicalReport(fixture(), classId, assessmentId));
  const noResults = fixture();
  Object.assign(noResults.overview, { submittedCount: 0, pendingCount: 12, meanPercentage: null });
  Object.assign(noResults.skills[0], { opportunities: 0, correctCount: 0, successRate: null });
  parsePedagogicalReport(noResults, 'class-1', 'assessment-1');
  assert.equal(reportPercent(null), 'Sem resultado'); assert.equal(reportPercent(0), '0%');
  noResults.overview.meanPercentage = 0;
  assert.throws(() => parsePedagogicalReport(noResults, 'class-1', 'assessment-1'));
});

test('relatório rejeita denominadores incoerentes, percentuais inválidos e dados de flags desabilitadas', async () => {
  const { parsePedagogicalReport } = await view;
  const mutations = [v => { v.revision = 'invalid'; }, v => { v.overview.pendingCount = 99; },
    v => { v.skills[0].successRate = 80; }, v => { v.skills[0].correctCount = 21; },
    v => { v.skills[0].opportunities = 21; }, v => { v.skills.push(v.skills[0]); },
    v => { v.overview.meanPercentage = 101; }, v => { v.skills[0].questionCount = 3; },
    v => { v.capabilities.institutions = false; v.class.institution.school = 'Must not leak'; },
    v => { v.capabilities.recovery = false; v.morePlans = true; }];
  for (const mutate of mutations) {
    const value = fixture(); mutate(value);
    assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
  }
});

test('avaliação ainda em rascunho é legível sem inventar participação', async () => {
  const { parsePedagogicalReport } = await view;
  const value = fixture(); value.assessment.status = 'draft'; value.overview = null; value.questionCount = null; value.skills = [];
  parsePedagogicalReport(value, 'class-1', 'assessment-1');
  value.assessment.status = 'closed';
  assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
});

test('download exige CSV, corpo não vazio, sucesso e a mesma revisão', async () => {
  const { validReportDownload } = await view;
  const revision = 'a'.repeat(64);
  const response = { status: 200, data: new Blob(['data']), headers: { 'content-type': 'text/csv; charset=utf-8', 'x-report-revision': revision } };
  assert.ok(validReportDownload(response, revision));
  assert.ok(!validReportDownload(response, 'b'.repeat(64)));
  assert.ok(!validReportDownload({ ...response, status: 500 }, revision));
  assert.ok(!validReportDownload({ ...response, data: new Blob([]) }, revision));
  assert.ok(!validReportDownload({ ...response, data: { error: 'no' } }, revision));
  assert.ok(!validReportDownload({ ...response, headers: { ...response.headers, 'content-type': 'text/html' } }, revision));
});

test('datas do SQLite e ISO são legíveis, com o fuso explícito de Brasília', async () => {
  const { reportDate, parsePedagogicalReport } = await view;
  assert.equal(reportDate('2026-09-15 12:00:00'), reportDate('2026-09-15T12:00:00Z'));
  assert.match(reportDate('2026-09-15 12:00:00'), /15\/09\/2026.*09:00.*Brasília/);
  assert.match(reportDate('2026-09-15T02:00:00Z'), /14\/09\/2026.*23:00/);
  assert.equal(reportDate('invalid'), 'Data indisponível');
  assert.equal(reportDate(null), 'Data indisponível');
  assert.equal(reportDate('2026-09-15T12:00:00'), 'Data indisponível');
  const value = fixture(); value.generatedAt = '2026-09-15';
  assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
});

test('linguagem compartilhada entre tela e impressão respeita singular e plural', async () => {
  const { reportSkillSummary, reportInterventionSummary } = await view;
  assert.equal(reportSkillSummary({ correctCount: 1, opportunities: 1, questionCount: 1 }), '1 acerto em 1 resposta corrigida · 1 questão.');
  assert.equal(reportInterventionSummary({ executionStatus: 'active', interventionHandled: 1, interventionCount: 1 }),
    '1 de 1 intervenção com registro (ministrada ou dispensada)');
  assert.equal(reportInterventionSummary({ executionStatus: null }), 'Execução ainda não organizada');
});

test('contrato não aceita contexto/registro malformado para a impressão', async () => {
  const { parsePedagogicalReport } = await view;
  const value = fixture(); value.class.institution.school = { name: 'invalid' };
  assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
  value.class.institution.school = null;
  value.feedback = { revision: 1, createdAt: 'invalid', objective: 'Texto', observation: 'Texto', action: 'Texto', verification: 'Texto' };
  assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
  value.feedback.createdAt = '2026-09-15 12:00:00'; value.feedback.action = 'a'.repeat(2001);
  assert.throws(() => parsePedagogicalReport(value, 'class-1', 'assessment-1'));
});

test('modal reutiliza foco e rolagem, cancela consultas e preserva rascunho do editor ao fechar', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../client/src/components/PedagogicalReport.jsx'), 'utf8');
  const page = fs.readFileSync(path.join(__dirname, '../../client/src/pages/PedagogicalCycle.jsx'), 'utf8');
  assert.match(source, /<AssessmentDialog/);
  assert.match(source, /new AbortController/);
  assert.match(source, /controller\.abort\(\)/);
  assert.match(source, /URL\.revokeObjectURL/);
  assert.match(source, /validReportDownload\(response, report\.revision\)/);
  assert.match(source, /pending\.current \|\| download\.stale/);
  assert.match(page, /<PedagogicalReport[^\n]+onClose=\{\(\) => setReportOpen\(false\)\}/);
  assert.doesNotMatch(source, /dangerouslySetInnerHTML|window\.open\(/);
  assert.match(source, /printPreview\.current\?\.close\(\)/);
  assert.match(source, /copy\.revision !== report\.revision/);
});
