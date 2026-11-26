const catalog = require('../../../shared/teacherAccessCatalog.json');
const pilots = require('../../../shared/teacherPilotAccessCatalog.json');
const { evaluateFeatureFlag } = require('./featureFlags');
const { fail } = require('./userManagement');

// Configuration-only snapshot. Never impersonate the teacher or read their
// classes, students, assessment answers or pedagogical notes.
function teacherAccess(database, id) {
  const user = database.prepare('SELECT id,name,email,role FROM users WHERE id=?').get(id);
  if (!user) fail(404, 'USER_MISSING', 'Esta conta não está mais disponível. Atualize a lista.');
  if (user.role !== 'professor') fail(409, 'TEACHER_REQUIRED', 'Esta consulta é para contas de professor. Atualize a lista.');
  const decisions = new Map(Object.keys({ ...catalog.flags, ...pilots.flags }).map(key => {
    const { enabled, reason } = evaluateFeatureFlag(database, key, user);
    return [key, { key, enabled, reason }];
  }));
  return {
    version: catalog.version,
    checkedAt: new Date().toISOString(),
    user,
    features: catalog.features.map(feature => {
      const checks = feature.requires.map(key => decisions.get(key));
      return { id: feature.id, enabled: checks.every(check => check.enabled), checks };
    }),
    // Additive section: older clients keep their original, strictly validated catalog.
    pilots: { version: pilots.version, features: pilots.features.map(feature => {
      const checks = feature.requires.map(key => decisions.get(key));
      return { id: feature.id, enabled: checks.every(check => check.enabled), checks };
    }) },
  };
}

module.exports = { teacherAccess };
