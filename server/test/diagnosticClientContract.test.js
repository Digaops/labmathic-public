const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const clientRoot = path.resolve(__dirname, '../../client/src');

function source(relativePath) {
  return fs.readFileSync(path.join(clientRoot, relativePath), 'utf8');
}

test('gerador diagnóstico oferece filtro opcional por unidade temática', () => {
  const modal = source('components/DiagnosticGeneratorModal.jsx');

  assert.match(modal, /unitId/);
  assert.match(modal, /Unidade temática \(opcional\)/);
  assert.match(modal, /Todas as unidades/);
  assert.match(modal, /String\(s\.unitId\) === unitId/);
  assert.match(modal, /Etapa 2 de 3/);
  assert.match(modal, /disabled=\{!included && insufficient\}/);
  assert.match(modal, /Abrir e revisar/);
});

test('detalhe exige confirmação explícita antes de liberar o diagnóstico', () => {
  const detail = source('pages/QuestionSetView.jsx');
  const list = source('pages/QuestionSets.jsx');

  assert.match(detail, /window\.confirm/);
  assert.match(detail, /diagnostic-review/);
  assert.match(detail, /\{ confirmed: true \}/);
  assert.match(detail, /Confirmar revisão e liberar/);
  assert.match(detail, /diagnosticReviewed/);
  assert.match(list, /Revisão pendente/);
  assert.match(list, /Revisado/);
});
