const test = require('node:test');
const assert = require('node:assert/strict');
const printing = import('../../client/src/services/pedagogicalReportPrint.mjs');

function fixture() {
  return { version: 'class-assessment-report-v1', revision: 'a'.repeat(64), generatedAt: '2026-09-15T12:00:00Z',
    class: { id: 'class-1', name: '7º A', gradeName: '7º Ano', academicYear: 2026, status: 'active', institution: { status: 'verified', school: 'Escola de teste', municipality: 'Município de teste' } },
    assessment: { id: 'assessment-1', title: 'Números', status: 'closed', isDiagnostic: true },
    capabilities: { institutions: true, recovery: true }, questionCount: 2,
    overview: { participantCount: 12, exemptedCount: 1, submittedCount: 10, pendingCount: 2, meanPercentage: 75 },
    skills: [{ code: 'EF07MA01', description: 'Números inteiros', questionCount: 2, opportunities: 20, correctCount: 15, successRate: 75,
      evidence: { level: 'moderate', notice: 'Considere também as observações em sala.' } }],
    plans: [{ id: 'plan-1', title: 'Apoio em números', status: 'active', executionStatus: 'active', interventionCount: 4, interventionHandled: 2,
      monitoring: { state: 'evidence_ready', application: { title: 'Nova verificação', status: 'closed' }, comparison: {
        methodology: 'matched-students-v2', notice: 'Compare os mesmos estudantes.', skills: [{ code: 'EF07MA01', description: 'Números inteiros',
          diagnosticRate: 50, monitoringRate: 75, delta: 25, diagnosticQuestionCount: 2, monitoringQuestionCount: 2,
          diagnosticOpportunities: 8, monitoringOpportunities: 8,
          cohort: { status: 'matched', studentCount: 4, diagnosticStudentCount: 10, monitoringStudentCount: 4, excludedDiagnosticCount: 6, excludedMonitoringCount: 0 },
          evidence: { level: 'limited', notice: 'Poucos estudantes.' } }],
      } } }], morePlans: false,
    feedback: { revision: 1, createdAt: '2026-09-15 12:00:00', objective: 'Comparar números inteiros.', observation: 'Observar estratégias em sala.', action: 'Retomar em duplas.', verification: 'Propor uma nova atividade.' },
    feedbackStale: false, notice: 'Resultados descritivos, não TRI.', privacyNotice: 'Confira os textos antes de compartilhar com pessoas autorizadas.' };
}
const render = async value => (await printing).getPedagogicalReportPrintDocument(value, 'class-1', 'assessment-1');

test('impressão preserva 20 planos e os quatro textos no limite sem truncar conteúdo', async () => {
  const value = fixture();
  value.plans = Array.from({ length: 20 }, (_, i) => ({ ...structuredClone(value.plans[0]), id: `plan-${i}`, title: `Plano sintético ${i + 1}` }));
  value.morePlans = true;
  for (const key of ['objective', 'observation', 'action', 'verification']) value.feedback[key] = `${key}:` + 'á'.repeat(2000 - key.length - 1);
  const html = await render(value);
  for (const key of ['objective', 'observation', 'action', 'verification']) assert.ok(html.includes(value.feedback[key]));
  for (let i = 1; i <= 20; i++) assert.ok(html.includes(`<h3>Plano sintético ${i}</h3>`));
  assert.match(html, /Há outros planos fora deste relatório/);
  value.plans.push(structuredClone(value.plans[0]));
  await assert.rejects(render(value));
});

test('textos acima do limite são rejeitados em cada campo antes de produzir uma cópia', async () => {
  for (const key of ['objective', 'observation', 'action', 'verification']) {
    const value = fixture(); value.feedback[key] = 'a'.repeat(2001);
    await assert.rejects(render(value));
  }
});

test('impressão preserva participação, comparação do mesmo grupo e registro salvo', async () => {
  const html = await render(fixture());
  for (const content of ['7º A', 'Escola de teste', 'Município de teste', 'EF07MA01', '75%', '15 acertos em 20 respostas corrigidas',
    '4 estudantes comparados nas duas etapas', 'diagnóstico 10 · verificação 4', 'diagnóstico 6 · verificação 0',
    '+25 pontos percentuais', 'Leitura inicial', '2 de 4 intervenções', 'ministradas ou dispensadas',
    'Retomar em duplas.', 'Rascunhos ainda não salvos', '15/09/2026', '09:00 (Brasília)', 'a'.repeat(64)]) assert.ok(html.includes(content), content);
  assert.match(html, /@page \{ size: A4; margin: 14mm/);
  assert.match(html, /large-text \{ font-size: 14pt/);
  assert.match(html, /@media print/);
  assert.match(html, /overflow-wrap: anywhere/);
  assert.doesNotMatch(html, /position:\s*(fixed|sticky)|overflow:\s*hidden|max-height:/);
});

test('textos de professores e cadastros nunca viram HTML, links ou recursos externos', async () => {
  const value = fixture(); const attack = '<img src="https://invalid.example" onerror="alert(1)"><script>bad()</script>&\'';
  value.class.name = attack; value.class.institution.school = attack; value.assessment.title = attack;
  value.skills[0].description = attack; value.feedback.observation = attack; value.plans[0].title = attack;
  value.plans[0].monitoring.application.title = attack; value.plans[0].monitoring.comparison.skills[0].description = attack;
  const html = await render(value);
  assert.doesNotMatch(html, /<(?:script|img|iframe|a|link|object|embed)\b/i);
  assert.ok(html.includes('&lt;img src=&quot;https://invalid.example&quot;'));
  assert.ok(html.includes('&lt;script&gt;bad()&lt;/script&gt;&amp;&#39;'));
  assert.match(html, /default-src 'none'/);
  assert.match(html, /base-uri 'none'/);
  assert.match(html, /name="referrer" content="no-referrer"/);
});

test('sem comparação, dispensa, ausência e resultado parcial não viram avanço ou nota zero', async () => {
  const value = fixture(); value.assessment.status = 'open';
  Object.assign(value.overview, { submittedCount: 0, pendingCount: 12, meanPercentage: null });
  Object.assign(value.skills[0], { opportunities: 0, correctCount: 0, successRate: null });
  const skill = value.plans[0].monitoring.comparison.skills[0];
  Object.assign(skill, { diagnosticRate: null, monitoringRate: null, delta: null, diagnosticQuestionCount: 0, monitoringQuestionCount: 0, diagnosticOpportunities: 0, monitoringOpportunities: 0 });
  Object.assign(skill.cohort, { status: 'no_common_results', studentCount: 0, excludedDiagnosticCount: 10, excludedMonitoringCount: 4 });
  const html = await render(value);
  assert.match(html, /Resultados parciais/); assert.match(html, /Sem resultado/); assert.match(html, /Sem comparação disponível/);
  assert.match(html, /Pendências não são nota zero/); assert.match(html, /Dispensados não entram/);
  assert.doesNotMatch(html, /Diferença de acertos:|0%/);
});

test('avaliação em rascunho, flags indisponíveis, recorte e registro desatualizado ficam explícitos', async () => {
  const value = fixture(); value.assessment.status = 'draft'; value.overview = null; value.questionCount = null; value.skills = [];
  value.capabilities = { institutions: false, recovery: false }; value.class.institution = { status: 'unavailable' }; value.plans = [];
  let html = await render(value);
  assert.match(html, /Resultados indisponíveis nesta etapa/);
  assert.match(html, /Consulta institucional indisponível/);
  assert.match(html, /Recomposição não habilitada/);
  const many = fixture(); many.morePlans = true; many.feedbackStale = true;
  html = await render(many);
  assert.match(html, /Somente os 20 planos mais recentes/);
  assert.match(html, /Os dados usados neste relatório mudaram desde que você salvou seu registro/);
});

test('impressão rejeita contexto trocado, médias inválidas e comparação incoerente', async () => {
  const { getPedagogicalReportPrintDocument } = await printing;
  assert.throws(() => getPedagogicalReportPrintDocument(fixture(), 'another-class', 'assessment-1'));
  for (const mutate of [v => { v.overview.meanPercentage = 101; }, v => { v.plans[0].monitoring.comparison.skills[0].delta = 99; },
    v => { v.plans[0].monitoring.application.status = 'open'; }, v => { v.plans[0].executionStatus = 'unknown'; },
    v => { v.plans[0].monitoring.comparison.skills[0].evidence.notice = null; }]) {
    const value = fixture(); mutate(value);
    assert.throws(() => getPedagogicalReportPrintDocument(value, 'class-1', 'assessment-1'));
  }
});

// A DOM/window double checks lifecycle behavior without claiming real browser or layout QA.
function fakePreview() {
  const nodes = new Map(); const writes = []; const toggles = [];
  const doc = { open() { nodes.clear(); }, write(html) { writes.push(html); }, close() {},
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, { textContent: '', handlers: {}, addEventListener(type, fn) { this.handlers[type] = fn; } });
      return nodes.get(id);
    }, body: { classList: { toggle: (...args) => toggles.push(args) } } };
  const preview = { document: doc, closed: false, opener: {}, printCalls: 0, focusCalls: 0,
    close() { this.closed = true; }, print() { this.printCalls++; }, focus() { this.focusCalls++; } };
  return { preview, nodes, writes, toggles };
}

test('falha tardia ao renderizar fecha a janela e remove o observador da origem', async () => {
  const { createPedagogicalReportPreview } = await printing;
  const fake = fakePreview(); const listeners = new Map();
  const parent = { addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event) };
  const handle = createPedagogicalReportPreview(() => fake.preview, parent);
  fake.preview.document.write = () => { throw new Error('late write failed'); };
  assert.throws(() => handle.render(fixture(), 'class-1', 'assessment-1'), /late write failed/);
  assert.equal(fake.preview.closed, true);
  assert.equal(listeners.size, 0);
  assert.equal(fake.preview.printCalls, 0);
  assert.throws(() => handle.render(fixture(), 'class-1', 'assessment-1'), /report_preview_closed/);
});

test('fechar uma prévia não fecha outra e cada observador é removido independentemente', async () => {
  const { createPedagogicalReportPreview } = await printing;
  const listeners = new Set();
  const parent = { addEventListener: (_, fn) => listeners.add(fn), removeEventListener: (_, fn) => listeners.delete(fn) };
  const first = fakePreview(); const second = fakePreview();
  const firstHandle = createPedagogicalReportPreview(() => first.preview, parent);
  const secondHandle = createPedagogicalReportPreview(() => second.preview, parent);
  firstHandle.close(); firstHandle.close();
  assert.equal(first.preview.closed, true); assert.equal(second.preview.closed, false);
  assert.equal(listeners.size, 1);
  secondHandle.render(fixture(), 'class-1', 'assessment-1');
  for (const close of listeners) close();
  assert.equal(second.preview.closed, true); assert.equal(listeners.size, 0);
});

test('prévia começa vazia, sem opener, não imprime sozinha e libera texto maior após conferência', async () => {
  const { createPedagogicalReportPreview } = await printing;
  const fake = fakePreview(); const handle = createPedagogicalReportPreview(() => fake.preview);
  assert.equal(fake.preview.opener, null);
  assert.match(fake.writes[0], /id="report-print-button" disabled/);
  assert.doesNotMatch(fake.writes[0], /7º A|Retomar em duplas/);
  assert.equal(fake.preview.printCalls, 0);
  handle.render(fixture(), 'class-1', 'assessment-1');
  assert.equal(fake.preview.printCalls, 0);
  assert.match(fake.writes[1], /7º A/);
  fake.nodes.get('report-print-large').handlers.change({ target: { checked: true } });
  assert.deepEqual(fake.toggles, [['large-text', true]]);
  const print = fake.nodes.get('report-print-button').handlers.click;
  print(); assert.equal(fake.preview.printCalls, 1);
  fake.nodes.get('report-print-close').handlers.click();
  print(); assert.equal(fake.preview.printCalls, 1);
  assert.equal(fake.preview.closed, true);
});

test('pop-up bloqueado e prévia fechada durante a consulta não expõem conteúdo', async () => {
  const { createPedagogicalReportPreview } = await printing;
  assert.throws(() => createPedagogicalReportPreview(() => null), /report_popup_blocked/);
  const fake = fakePreview(); const handle = createPedagogicalReportPreview(() => fake.preview);
  handle.close(); handle.close();
  assert.throws(() => handle.render(fixture(), 'class-1', 'assessment-1'), /report_preview_closed/);
  assert.equal(fake.writes.length, 1);
  const invalid = fakePreview(); const second = createPedagogicalReportPreview(() => invalid.preview);
  assert.throws(() => second.render(fixture(), 'wrong-class', 'assessment-1'));
  assert.equal(invalid.preview.closed, true); assert.equal(invalid.writes.length, 1);
});

test('falha de escrita fecha a prévia e falha de impressão tem orientação recuperável', async () => {
  const { createPedagogicalReportPreview } = await printing;
  const broken = fakePreview(); broken.preview.document.write = () => { throw new Error('write failed'); };
  assert.throws(() => createPedagogicalReportPreview(() => broken.preview), /write failed/);
  assert.equal(broken.preview.closed, true);
  const fake = fakePreview(); const handle = createPedagogicalReportPreview(() => fake.preview);
  handle.render(fixture(), 'class-1', 'assessment-1');
  fake.preview.print = () => { throw new Error('print failed'); };
  fake.nodes.get('report-print-button').handlers.click();
  assert.match(fake.nodes.get('report-print-status').textContent, /comando Imprimir do navegador/);
});

test('sair ou recarregar a página de origem fecha a prévia e remove o observador', async () => {
  const { createPedagogicalReportPreview } = await printing;
  const fake = fakePreview(); const listeners = new Map();
  const parent = { addEventListener: (event, fn) => listeners.set(event, fn), removeEventListener: event => listeners.delete(event) };
  const handle = createPedagogicalReportPreview(() => fake.preview, parent);
  assert.equal(listeners.has('pagehide'), true);
  listeners.get('pagehide')();
  assert.equal(fake.preview.closed, true); assert.equal(listeners.size, 0);
  assert.throws(() => handle.render(fixture(), 'class-1', 'assessment-1'), /report_preview_closed/);
  assert.equal(fake.writes.length, 1);
});
