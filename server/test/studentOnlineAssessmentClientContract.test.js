const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const clientRoot = path.resolve(__dirname, '../../client/src');
const serverRoot = path.resolve(__dirname, '../src');

function source(relativePath, root = clientRoot) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

test('portal do estudante possui rota pública, sessão efêmera e autosave versionado', () => {
  const app = source('App.jsx');
  const portal = source('pages/StudentAssessment.jsx');
  const api = source('services/api.js');
  const recovery = source('services/assessmentRecovery.mjs');
  const hook = source('hooks/useAssessmentRecovery.js');

  assert.match(app, /path="\/responder"/);
  assert.match(app, /StudentAssessment/);
  assert.match(portal, /sessionStorage\.setItem/);
  assert.match(portal, /sessionStorage\.removeItem/);
  assert.doesNotMatch(portal, /localStorage/);
  assert.match(portal, /\/student-assessments\/session/);
  assert.match(hook, /\/student-assessments/);
  assert.match(recovery, /'\/responses'/);
  assert.match(recovery, /'\/submit'/);
  assert.match(recovery, /expectedRevision/);
  assert.doesNotMatch(recovery, /localStorage/);
  assert.match(hook, /beforeunload/);
  assert.match(portal, /Código individual de acesso/);
  assert.match(portal, /não compartilhe o seu código/);
  assert.match(portal, /não representa proficiência TRI/);
  assert.match(api, /isStudentAssessmentRoute/);
  assert.match(api, /!isStudentAssessmentRoute/);
  assert.match(api, /!config\.headers\.Authorization/);
});

test('professor recebe códigos uma única vez e a impressão não injeta HTML', () => {
  const modal = source('components/StudentAssessmentAccessModal.jsx');
  const assessments = source('components/ClassAssessments.jsx');

  assert.match(assessments, /classes\.student_assessment_portal|studentPortalEnabled/);
  assert.match(assessments, /Acessos dos estudantes/);
  assert.match(modal, /mostrados uma única vez|mostrados somente agora|armazena somente o hash/);
  assert.match(modal, /textContent/);
  assert.doesNotMatch(modal, /innerHTML/);
  assert.match(modal, /window\.open/);
  assert.match(modal, /printWindow\.opener = null/);
  assert.match(modal, /GERAR_ACESSOS/);
  assert.match(modal, /aria-label="Códigos de acesso gerados"/);
  assert.match(modal, /scrollIntoView/);
  assert.match(modal, /Código completo de/);
  assert.match(assessments, /async \(\{ showLoading = true \} = \{\}\)/);
  assert.match(assessments, /onChanged=\{\(\) => load\(\{ showLoading: false \}\)\}/);
  assert.doesNotMatch(assessments, /onChanged=\{load\}/);
});

test('entrada pública é protegida por limites por IP e por código', () => {
  const index = source('index.js', serverRoot);

  assert.match(index, /studentAssessmentEntryLimiter/);
  assert.match(index, /studentAssessmentCodeLimiter/);
  assert.match(index, /\/api\/student-assessments\/session/);
  const limits = fs.readFileSync(path.join(__dirname, '../src/middleware/schoolRateLimits.js'), 'utf8');
  assert.match(limits, /createHash\('sha256'\)/);
});
