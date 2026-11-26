const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

function read(relativePath) {
  return fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf8');
}

const questionSetView = read('../client/src/pages/QuestionSetView.jsx');
const classAssessments = read('../client/src/components/ClassAssessments.jsx');
const portal = read('src/routes/studentAssessmentPortal.js');

test('simulado comunica ao professor que o gabarito foi equilibrado', () => {
  assert.match(questionSetView, /answer_key\?\.balanced/);
  assert.match(questionSetView, /Gabarito equilibrado/);
  assert.match(questionSetView, /distribuídas da forma mais equilibrada possível entre A, B, C e D/);
});

test('embaralhamento do estudante equilibra a prova inteira, não cada questão isoladamente', () => {
  assert.match(portal, /createBalancedOptionOrders\(items\.filter\(item=>!numeric\.has\(item\.id\)\)\.map/);
  assert.match(portal, /portal:\$\{context\.assignment_id\}:\$\{context\.participant_id\}/);
  assert.match(portal, /balancedOptionOrders\.get\(item\.id\)/);
  assert.match(classAssessments, /cada estudante recebe uma versão individual sem concentração de letras/);
});
