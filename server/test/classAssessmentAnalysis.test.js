const test = require('node:test');
const assert = require('node:assert/strict');

const {
  calculatePercentage,
  classifyEvidence,
  classifySkillLevel,
} = require('../src/services/classAssessmentAnalysis');
const {
  selectDiverseQuestions,
  splitQuestionPurpose,
} = require('../src/services/learningRecoveryPreview');

test('percentuais e níveis mantêm os limites pedagógicos versionados', () => {
  assert.equal(calculatePercentage(1, 3), 33.33);
  assert.equal(calculatePercentage(0, 0), null);
  assert.equal(classifySkillLevel(null), 'no_data');
  assert.equal(classifySkillLevel(49.99), 'below_expected');
  assert.equal(classifySkillLevel(50), 'developing');
  assert.equal(classifySkillLevel(69.99), 'developing');
  assert.equal(classifySkillLevel(70), 'consolidated');
});

test('nível de evidência é conservador e não se apresenta como TRI', () => {
  assert.equal(classifyEvidence({ submittedCount: 0, questionCount: 2, opportunityCount: 0 }).level, 'insufficient');
  assert.equal(classifyEvidence({ submittedCount: 4, questionCount: 3, opportunityCount: 12 }).level, 'limited');
  assert.equal(classifyEvidence({ submittedCount: 8, questionCount: 3, opportunityCount: 24 }).level, 'moderate');
  const broader = classifyEvidence({ submittedCount: 20, questionCount: 3, opportunityCount: 60 });
  assert.equal(broader.level, 'broader');
  assert.match(broader.notice, /não equivale à TRI/i);
});

test('seleção de reforço é determinística, diversa e não reutiliza questão no monitoramento', () => {
  const candidates = [
    { id: 1, difficulty: 'facil' },
    { id: 2, difficulty: 'facil' },
    { id: 3, difficulty: 'media' },
    { id: 4, difficulty: 'media' },
    { id: 5, difficulty: 'dificil' },
  ];
  const selected = selectDiverseQuestions(candidates);
  assert.deepEqual(selected.map(({ id }) => id), [1, 3, 5, 4, 2]);
  const purposes = splitQuestionPurpose(selected);
  assert.equal(purposes.reinforcement.length, 3);
  assert.equal(purposes.monitoring.length, 2);
  assert.deepEqual(
    purposes.reinforcement.map(({ id }) => id)
      .filter((id) => purposes.monitoring.some((question) => question.id === id)),
    []
  );
});
