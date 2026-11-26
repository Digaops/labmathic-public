const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.resolve(__dirname, '../../client/src/App.jsx'), 'utf8');
const list = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/LessonPlans.jsx'), 'utf8');
const editor = ['pages/LessonPlanEditor.jsx','components/PlannerPickers.jsx','hooks/usePlannerSession.js'].map(file=>fs.readFileSync(path.resolve(__dirname,'../../client/src',file),'utf8')).join('\n');

test('planejador é carregado sob feature flag e em chunks próprios', () => {
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/LessonPlans'\)\)/);
  assert.match(app, /lazy\(\(\) => import\('\.\/pages\/LessonPlanEditor'\)\)/);
  assert.match(app, /flag="planning\.lesson_planner"/);
  assert.match(app, /path="planejamento\/novo"/);
});

test('jornada separa rascunho, revisão explícita, execução e reutilização', () => {
  assert.match(list, /Planejamento de aulas/);
  assert.match(list, /Nenhum planejamento arquivado/);
  assert.doesNotMatch(list, /Criar primeira turma/);
  assert.match(editor, /Revisei objetivos, habilidades, recursos e datas/);
  assert.match(editor, /Revisar e iniciar/);
  assert.match(editor, /Marcar como realizada/);
  assert.match(editor, /Reutilizar em outra turma/);
  assert.match(editor, /Registros das aulas não são copiados/);
  assert.match(editor, /As orientações dos recursos permanecem/);
});

test('editor oferece os vínculos pedagógicos pedidos e feedback de concorrência', () => {
  for (const text of [
    'Habilidades BNCC',
    'Objetivo de aprendizagem',
    'Recursos da aula',
    'Materiais',
    'Questões',
    'Simulados',
    'Atividade própria',
    'Observações do professor',
  ]) assert.match(editor, new RegExp(text));
  assert.match(editor, /expectedRevision/);
  assert.match(editor, /Idempotency-Key/);
  assert.match(editor, /createOperationKey\.current/);
  assert.match(editor, /operationKey\.current/);
});
