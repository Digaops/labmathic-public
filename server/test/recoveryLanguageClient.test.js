const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../../client/src/services/recoveryLanguage.mjs');

test('resumo da recomposição mantém contagens e concorda com zero, um e vários', async () => {
  const { recoverySummary } = await load();
  for (const count of [0, 1, 2, 31]) {
    const data = Object.freeze({ priorityCount: count, groupCount: count, studentCount: count, plannedQuestionCount: count });
    const expected = count === 1 ? '1 prioridade · 1 grupo · 1 estudante · 1 questão prevista'
      : `${count} prioridades · ${count} grupos · ${count} estudantes · ${count} questões previstas`;
    assert.equal(recoverySummary(data), expected);
  }
});

test('orientação distingue questões salvas, rascunho, agendamento, aplicação e ausência de resultados', async () => {
  const { verificationNextStep } = await load();
  assert.match(verificationNextStep('needs_application')[0], /Questões.*salvas/);
  assert.match(verificationNextStep('needs_application')[1], /grupo de apoio, toda a turma ou nomes individualmente.*Confira quem participará/);
  for (const [state, word] of [['draft', 'rascunho'], ['scheduled', 'agendada'], ['open', 'andamento'], ['awaiting_results', 'sem resultados corrigidos'], ['cancelled', 'cancelada']]) {
    const [title, help] = verificationNextStep(state);
    assert.ok(title.includes(word)); assert.ok(help.length > 30);
  }
  for (const state of [null, undefined, 'unknown', 'constructor', '__proto__']) assert.match(verificationNextStep(state)[0], /Confira a situação/);
  const copy = verificationNextStep('draft'); copy[0] = 'alterada';
  assert.equal(verificationNextStep('draft')[0], 'Verificação em rascunho');
});

test('título legado recebe explicação, não uma renomeação por heurística', async () => {
  const { legacyVerificationNotice } = await load();
  const title = 'Monitoramento · Frações e estratégias da turma';
  assert.match(legacyVerificationNotice(title), /título foi preservado/);
  assert.equal(title, 'Monitoramento · Frações e estratégias da turma');
  for (const value of [null, undefined, {}, '', 'Verificação · Frações', 'Meu monitoramento de leitura']) assert.equal(legacyVerificationNotice(value), '');
});

test('lista e detalhe reutilizam o resumo; questões salvas não são apresentadas como aplicação liberada', () => {
  const read = file => fs.readFileSync(path.resolve(__dirname, '../../client/src', file), 'utf8');
  for (const file of ['pages/LearningRecoveryPlans.jsx', 'components/LearningRecoveryReview.jsx']) assert.match(read(file), /recoverySummary\(/);
  const monitoring = read('components/LearningRecoveryMonitoring.jsx');
  assert.match(monitoring, /verificationNextStep\(monitoring.state\)/);
  assert.match(monitoring, /Isso ainda não libera a aplicação para os estudantes/);
  assert.match(monitoring, /Simulado vinculado:/);
  assert.match(monitoring, /Salvar questões da verificação/);
  const applications = read('components/ClassAssessments.jsx');
  assert.match(applications, /formatCount\(assignment.questionCount, 'questão', 'questões'\)/);
  assert.ok(applications.includes("formatCount(assignment.participantCount - (assignment.roster?.exemptedCount || 0), 'participante', 'participantes')"));
  assert.match(applications, /'questão preservada', 'questões preservadas'/);
  assert.match(applications, /Estudantes selecionados:/);
});
