const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readClientFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../../client/src', relativePath), 'utf8');
}

const review = readClientFile('components/LearningRecoveryReview.jsx');
const results = readClientFile('components/ClassAssessmentResults.jsx');
const assessments = readClientFile('components/ClassAssessments.jsx');
const classes = readClientFile('pages/Classes.jsx');
const featureFlags = readClientFile('contexts/FeatureFlagsContext.jsx');

test('capacidade de recomposição é conhecida e propagada até os resultados', () => {
  assert.match(featureFlags, /'classes\.learning_recovery'/);
  assert.match(classes, /recoveryEnabled=\{isEnabled\('classes\.learning_recovery'\)\}/);
  assert.match(assessments, /recoveryEnabled=\{recoveryEnabled\}/);
  assert.match(results, /recoveryEnabled && assignment\.isDiagnostic/);
  assert.match(results, /summary\.overview\.submittedCount > 0/);
});

test('revisão permite escolher prioridades e ajustar grupos temporários', () => {
  assert.match(review, /Selecionar \$\{priority\.skill\.code\}/);
  assert.match(review, /studentCandidates/);
  assert.match(review, /Composição do grupo/);
  assert.match(review, /Criar grupo temporário de apoio/);
  assert.match(review, /não altera matrículas nem rotula o estudante permanentemente/);
  assert.match(review, /Conferi as prioridades e os grupos/);
});

test('confirmação envia revisões e idempotência sem criar automaticamente', () => {
  assert.match(review, /\/recovery-preview/);
  assert.match(review, /\/recovery-plans/);
  assert.match(review, /expectedAssessmentRevision/);
  assert.match(review, /expectedResultRevision/);
  assert.match(review, /methodologyVersion/);
  assert.match(review, /acceptedPriorities/);
  assert.match(review, /'Idempotency-Key'/);
  assert.match(review, /window\.crypto\.getRandomValues/);
  assert.match(review, /Nada foi aplicado aos estudantes automaticamente/);
});

test('rascunho pode ser reaberto, salvo com revisão otimista e ativado explicitamente', () => {
  assert.match(review, /reviewFromPlan/);
  assert.match(review, /expectedPlanRevision/);
  assert.match(review, /api\.put/);
  assert.match(review, /\/activate/);
  assert.match(review, /reviewConfirmed: true/);
  assert.match(review, /Salvar rascunho/);
  assert.match(review, /Concluir revisão/);
  assert.match(review, /Conferi o plano e confirmo esta revisão/);
  assert.match(review, /prioridades e os grupos ficarão fixos para preservar o histórico/);
});

test('prévia desatualizada e conexão incerta recebem recuperação segura e amigável', () => {
  for (const code of [
    'stale_preview',
    'stale_results',
    'methodology_changed',
    'priority_not_actionable',
    'preview_not_actionable',
    'recovery_source_changed',
    'stale_plan',
  ]) {
    assert.match(review, new RegExp(`'${code}'`));
  }
  assert.match(review, /A prévia precisa ser refeita/);
  assert.match(review, /Recarregar prévia/);
  assert.match(review, /Verificar confirmação/);
  assert.match(review, /submitConfirmation\(uncertain\.payload, uncertain\.idempotencyKey\)/);
});

test('interface comunica limites da análise descritiva', () => {
  assert.match(review, /não representam proficiência TRI/);
  assert.match(review, /Decisão do professor, sem automatismos/);
  assert.match(review, /Conferi o plano e confirmo esta revisão/);
  assert.match(results, /closeGuardRef=\{recoveryCloseGuard\}/);
  assert.match(results, /AssessmentDialog/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../client/src/components/AssessmentDialog.jsx'), 'utf8'), /createPortal/);
  assert.match(fs.readFileSync(path.resolve(__dirname, '../../client/src/components/AssessmentDialog.jsx'), 'utf8'), /document\.body/);
});
