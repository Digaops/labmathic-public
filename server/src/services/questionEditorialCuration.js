const { evaluateFeatureFlag } = require('./featureFlags');

const EDITORIAL_PILOT_FLAG = 'question_bank.editorial_pilot';
const STAGES_BY_PURPOSE = {
  diagnosis: "'prerequisite', 'application', 'reasoning'",
  practice: "'practice'",
  verification: "'verification'",
};

function isEditorialPilotEnabled(database, user) {
  return user?.role === 'professor' && evaluateFeatureFlag(database, EDITORIAL_PILOT_FLAG, user).enabled;
}

function editorialEligibleSql(alias, { pilotEnabled = false, purpose = 'catalog' } = {}) {
  if (purpose !== 'catalog' && !Object.hasOwn(STAGES_BY_PURPOSE, purpose)) {
    throw new Error('Finalidade editorial desconhecida.');
  }
  const stageCondition = purpose === 'catalog' ? '' : ` AND entry.stage IN (${STAGES_BY_PURPOSE[purpose]})`;
  const approvedPilot = pilotEnabled
    ? ` AND NOT (entry.state = 'pilot' AND ${alias}.reviewed = 1${stageCondition})`
    : '';
  return `NOT EXISTS (SELECT 1 FROM question_editorial_curation entry
    WHERE entry.question_id = ${alias}.id${approvedPilot})`;
}

module.exports = { EDITORIAL_PILOT_FLAG, isEditorialPilotEnabled, editorialEligibleSql };
