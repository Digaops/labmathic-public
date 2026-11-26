const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const classes = fs.readFileSync(
  path.resolve(__dirname, '../../client/src/pages/Classes.jsx'),
  'utf8'
);

test('estado vazio de arquivadas explica o histórico e retorna para turmas ativas', () => {
  assert.match(classes, /Nenhuma turma arquivada/);
  assert.match(classes, /As turmas arquivadas ficarão guardadas aqui para consulta/);
  assert.match(classes, /Ver turmas ativas/);
  assert.match(classes, /setStatus\('active'\)/);
});

test('busca vazia não é confundida com primeiro acesso às turmas', () => {
  assert.match(classes, /Nenhuma turma encontrada/);
  assert.match(classes, /Limpar busca/);
  assert.match(classes, /Não encontramos turmas nesta situação com o termo informado/);
});
