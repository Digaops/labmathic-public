const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const componentPath = path.resolve(
  __dirname,
  '../../client/src/components/ClassAssessmentResults.jsx'
);

test('interface não permite reabrir ou alterar uma correção concluída', () => {
  const component = fs.readFileSync(componentPath, 'utf8');

  assert.doesNotMatch(component, /Revisar correção/);
  assert.doesNotMatch(component, /handleRevise/);
  assert.doesNotMatch(component, /\/revise/);
  assert.match(component, /Correção concluída — respostas não podem ser alteradas/);
  assert.match(component, /disabled=\{submitted \|\| saving\}/);
});

test('correção individual apresenta todas as questões antes da orientação ao estudante', () => {
  const component = fs.readFileSync(componentPath, 'utf8');

  assert.match(
    component,
    /\{entry\.items\.map\(\(item\) => \([\s\S]*?<article data-correction-question[\s\S]*?<\/article>\s*\)\)\}\s*\{submitted && feedbackEnabled && <StudentFeedbackRelease\b/,
    'A orientação deve ser renderizada após o fechamento da lista completa de questões.'
  );
});

test('resultados priorizam estudantes, resumo opcional e janela com rolagem única', () => {
  const component = fs.readFileSync(componentPath, 'utf8');
  const stylesheet = fs.readFileSync(
    path.resolve(__dirname, '../../client/src/index.css'),
    'utf8'
  );

  const dialog = fs.readFileSync(path.resolve(__dirname, '../../client/src/components/AssessmentDialog.jsx'), 'utf8');
  assert.match(dialog, /overflow-y-auto overscroll-contain/);
  assert.match(component, /data-results-summary/);
  assert.match(component, /results-tabs-shell sticky top-0/);
  assert.match(component, /results-metric-card__helper/);
  assert.match(component, /selectResultsTab/);
  assert.match(component, /role="tabpanel"/);
  assert.match(component, /Resumo e como interpretar/);
  assert.match(stylesheet, /\.assessment-workspace[\s\S]*?min-height: 44px/);
  assert.match(component, /hasUnsavedResponses/);
  assert.match(component, /tabIndex=\{tab === key \? 0 : -1\}/);
  assert.match(component, /xl:grid-cols-4/);
});
