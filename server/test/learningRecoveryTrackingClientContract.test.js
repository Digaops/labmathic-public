const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function readClientFile(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '../../client/src', relativePath), 'utf8');
}

const app = readClientFile('App.jsx');
const header = readClientFile('components/Header.jsx');
const dashboard = readClientFile('components/TeacherHome.jsx') + readClientFile('services/teacherHome.mjs');
const tracking = readClientFile('pages/LearningRecoveryPlans.jsx') + readClientFile('services/recoveryPlansView.mjs');
const review = readClientFile('components/LearningRecoveryReview.jsx');
const execution = readClientFile('components/LearningRecoveryExecution.jsx');
const executionWrites = readClientFile('hooks/useRecoveryExecution.js');
const monitoring = readClientFile('components/LearningRecoveryMonitoring.jsx');
const comparison = readClientFile('components/RecoveryComparison.jsx');
const comparisonView = readClientFile('services/recoveryComparisonView.mjs');
const resourcePicker = readClientFile('components/LearningRecoveryResourcePicker.jsx');
const classes = readClientFile('pages/Classes.jsx');
const classAssessments = readClientFile('components/ClassAssessments.jsx');

test('acompanhamento possui rota protegida, navegação e descoberta na página inicial', () => {
  assert.match(app, /path="recomposicao"[^\n]+<LearningRecoveryPlans /);
  assert.match(tracking, /recoveryWorkspaceState\(user\?\.role, flags\)/);
  assert.match(header, /to="\/recomposicao"/);
  assert.match(header, /Planos de recomposição/);
  assert.match(dashboard, /to: '\/recomposicao'/);
  assert.match(dashboard, /Retome seu trabalho/);
});

test('tela lista planos por situação e permite retomar rascunhos', () => {
  assert.match(tracking, /\/classes\/recovery-plans/);
  assert.match(tracking, /Aguardando revisão/);
  assert.match(tracking, /Em acompanhamento/);
  assert.match(tracking, /Continuar revisão/);
  assert.match(tracking, /Organizar aulas/);
  assert.match(tracking, /Acompanhar aulas/);
  assert.match(tracking, /Etapas registradas/);
  assert.match(tracking, /plan\.execution\.percentage/);
  assert.match(tracking, /initialPlanId=\{plan\.id\}/);
  assert.match(tracking, /Buscar por plano, turma ou avaliação/);
});

test('revisão e execução participam do bloqueio de navegação da conta', () => {
  assert.match(review, /usePlannerLeave\(dirty \|\| needsVerification, \(\) => writePending\.current, 'recovery'\)/);
  assert.match(executionWrites, /usePlannerLeave\(dirty \|\| blocked, \(\) => pending\.current, 'recovery'\)/);
  assert.doesNotMatch(review + executionWrites, /addEventListener\('beforeunload'/);
});

test('consulta de plano ativo preserva contexto, prioridades e grupos sem recalcular a origem', () => {
  assert.match(review, /if \(initialPlanId\)/);
  assert.match(review, /requestedPlan\.status !== 'draft'/);
  assert.match(review, /Prioridades pedagógicas/);
  assert.match(review, /Grupos temporários de apoio/);
  assert.match(review, /não representam proficiência TRI/);
});

test('plano ativo orienta a execução pedagógica até a verificação final', () => {
  assert.match(review, /LearningRecoveryExecution/);
  assert.match(execution, /Organizar as aulas de apoio/);
  assert.match(execution, /Organizar aulas/);
  assert.match(execution, /Registrar realizada/);
  assert.match(execution, /Não realizada/);
  assert.match(execution, /Concluir ciclo/);
  assert.match(execution, /LearningRecoveryResourcePicker/);
  assert.match(execution, /LearningRecoveryMonitoring/);
  assert.match(execution, /será liberado após a aplicação ter ao menos um resultado/);
});

test('execução mostra cronograma, progresso, grupos, recursos e revisão otimista', () => {
  assert.match(execution, /Data planejada/);
  assert.match(execution, /Registro do professor/);
  assert.match(execution, /Grupos relacionados/);
  assert.match(execution, /Material do acervo associado à habilidade/);
  assert.match(execution, /execution\.progress\.percentage/);
  assert.match(execution, /expectedRevision:\s*draft\.revision/);
  assert.match(execution, /expectedExecutionRevision:\s*execution\.revision/);
  assert.match(executionWrites, /startsWith\('stale_'\)/);
  assert.match(executionWrites, /mergeLessonDrafts/);
  assert.match(executionWrites, /pending\.current\|\|reading\.current\|\|blocked/);
  assert.match(review, /guardRef=\{executionGuard\}/);
  assert.match(resourcePicker, /Revisar recursos/);
  assert.match(resourcePicker, /expectedExecutionRevision/);
  assert.match(resourcePicker, /Questões de reforço/);
  assert.match(resourcePicker, /Materiais do acervo/);
});

test('monitoramento conduz à aplicação, compara evidências e não se apresenta como TRI', () => {
  assert.match(monitoring, /Escolher questões da verificação/);
  assert.match(monitoring, /questões diferentes das usadas no diagnóstico e no apoio/i);
  assert.match(monitoring, /Abrir aplicações da turma/);
  assert.match(monitoring, /<RecoveryComparison comparison=\{monitoring\.comparison\}/);
  assert.match(comparison, /Diagnóstico/);
  assert.match(monitoring, /Resultados da verificação/);
  assert.match(comparison, /view\.notice/);
  assert.match(comparisonView, /mesmos estudantes/);
  assert.match(comparisonView, /não prova o efeito/);
  assert.match(classes, /classesQuery\(params\)/);
  assert.match(readClientFile('services/classesView.mjs'), /params\.get\('simulado'\)/);
  assert.match(classes, /initialAssessmentSourceId/);
  assert.match(classAssessments, /launchSourceQuestionSetId/);
  assert.match(classAssessments, /supportParticipants/);
  assert.match(classAssessments, /existingVerification/);
  assert.match(monitoring, /params\.set\('simulado', monitoring\.questionSet\.id\)/);
  assert.doesNotMatch(monitoring, /if \(!monitoring\.application\) params\.set/);
});

test('execução, ciclo e histórico compartilham leitura com grupo e limites da evidência', () => {
  const cycle = readClientFile('pages/PedagogicalCycle.jsx');
  assert.match(cycle, /<RecoveryComparison comparison=\{p\.monitoring\.comparison\}/);
  assert.match(cycle, /<RecoveryComparison comparison=\{item\.comparison\}/);
  assert.match(comparison, /skill\.comparable &&/);
  assert.match(comparison, /skill\.evidenceNotice/);
  assert.match(comparisonView, /Registro antigo/);
  assert.match(comparisonView, /não confirma o domínio/);
  assert.doesNotMatch(comparison + monitoring, /Situação atual:|Consolidada|TrendingUp|TrendingDown/);
});

test('confirmação do rascunho deixa explícita a revisão final antes da intervenção', () => {
  assert.match(review, /Agora revise e ative o plano/);
  assert.match(review, /aguardando revisão final/);
  assert.match(review, /Revisar rascunho agora/);
  assert.match(review, /marque a confirmação pedagógica/);
});

test('home diferencia a jornada do professor e do administrador sem busca N mais um', () => {
  assert.match(dashboard, /Minhas turmas/);
  assert.match(readClientFile('pages/Dashboard.jsx'), /isAdmin \? <AdministrativeHome \/> : <TeacherHome \/>/);
  assert.match(readClientFile('components/AdministrativeHome.jsx'), /Início da administração/);
  assert.match(dashboard, /\/classes\/home-overview/);
  assert.doesNotMatch(dashboard, /setsWithDifficulty/);
  assert.doesNotMatch(dashboard, /question-bank\/question-sets\/\$\{set\.id\}/);
});
