// Opt-in interactive host. No production entrypoint, real DB or real SMTP.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
async function holdIsolatedFixture({ baseUrl, db, teacher, admin, manager, previewUser, tokenFor, report, ...seed }) {
  assert.equal(process.env.SCREEN_LAYOUT_AUDIT, '1');
  assert.equal(process.env.PLATFORM_JOURNEY_AUDIT, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const config = require('../../src/config');
  assert.equal(path.dirname(config.uploadDir), path.dirname(db.name));
  assert.equal(config.smtp.user, '');
  const output = path.join(root, process.env.EXEMPTIONS_AUDIT === '1' ? 'tmp/exemptions-audit' : process.env.ASSESSMENT_ROSTER_AUDIT === '1' ? 'tmp/assessment-roster-audit' : process.env.RECOVERY_PARTICIPANTS_AUDIT === '1' ? 'tmp/recovery-participants-audit' : process.env.RECOVERY_LANGUAGE_AUDIT === '1' ? 'tmp/recovery-language-audit' : process.env.ACCESSIBILITY_DATES_AUDIT === '1' ? 'tmp/accessibility-dates-audit' : process.env.MATERIAL_BNCC_AUDIT === '1' ? 'tmp/material-bncc-audit' : process.env.MATERIAL_PUBLICATION_AUDIT === '1' ? 'tmp/material-publication-audit' : process.env.MATERIAL_FORMATS_AUDIT === '1' ? 'tmp/material-formats-audit' : process.env.TEACHER_ACCESS_AUDIT === '1' ? 'tmp/teacher-access-audit' : process.env.BANK_ACCESS_AUDIT === '1' ? 'tmp/bank-access-audit' : process.env.RECOVERY_QUESTIONS_AUDIT === '1' ? 'tmp/recovery-questions-audit' : process.env.RECOVERY_COMPARISON_AUDIT === '1'
    ? 'tmp/recovery-comparison-audit' : 'tmp/platform-journey-audit');
  fs.mkdirSync(output, { recursive: true });
  const connection = path.join(output, 'connection.json');
  const stop = path.join(output, 'stop');
  assert.ok(!fs.existsSync(connection) && !fs.existsSync(stop), 'Do not overlap or reuse a running fixture');
  const password = 'Jornada-Sintetica-2026!';
  for (const user of [teacher, admin, manager, previewUser]) db.prepare('UPDATE users SET password=? WHERE id=?').run(require('bcryptjs').hashSync(password, 10), user.id);
  const accounts = Object.fromEntries(Object.entries({ teacher, admin, manager, previewUser }).map(([key, user]) => [key, { ...user, token: tokenFor(user) }]));
  if (process.env.RECOVERY_QUESTIONS_AUDIT === '1') seed.questions = await require('./recoveryQuestionsFixture.cjs').seedRecoveryQuestions({ baseUrl, db, teacher, tokenFor, ...seed });
  if (process.env.MATERIAL_FORMATS_AUDIT === '1') seed.formats = require('./materialFormatsFixture.cjs').seedMaterialFormats({ db, admin, uploadDir: config.uploadDir });
  if (process.env.ACCESSIBILITY_DATES_AUDIT === '1') {
    // This database was created by the isolated test above; never patch live dates.
    const timestamp = '2026-09-12 01:48:33';
    db.prepare('UPDATE materials SET created_at=? WHERE id=?').run(timestamp, seed.materialId);
    const entry = require('../../src/helpers/activity').logActivityStrict({ user: admin, action: 'create_material', module: 'materials', entityType: 'material', entityId: seed.materialId, entityTitle: 'Problemas para conversar em sala', description: 'Cadastro sintético para conferir a data do material.' }, db);
    db.prepare('UPDATE activity_log SET created_at=? WHERE id=?').run(timestamp, entry.lastInsertRowid);
    seed.eventDate = { timestamp, activityId: Number(entry.lastInsertRowid) };
  }
  fs.writeFileSync(connection, JSON.stringify({ baseUrl, password, accounts, seed, uploadDir: config.uploadDir, inventory: report.inventory, routeCoverage: report.routeCoverage }, null, 2));
  fs.writeFileSync(path.join(output, 'inventory.json'), JSON.stringify({ inventory: report.inventory, routeCoverage: report.routeCoverage }, null, 2));
  console.log('Isolated journey fixture ready:', baseUrl);
  const started = Date.now();
  try {
    while (!fs.existsSync(stop) && Date.now() - started < 10800000) await new Promise(resolve => setTimeout(resolve, 250));
    const counts = {};
    for (const table of ['users', 'municipalities', 'schools', 'school_classes', 'materials', 'collections', 'questions', 'question_sets', 'class_assessment_assignments', 'institutional_write_operations']) counts[table] = db.prepare(`SELECT COUNT(*) FROM ${table}`).pluck().get();
    fs.writeFileSync(path.join(output, 'fixture-close.json'), JSON.stringify({ syntheticDataOnly: true, counts, stoppedAt: new Date().toISOString() }, null, 2));
  } finally {
    fs.unlinkSync(connection);
    if (fs.existsSync(stop)) fs.unlinkSync(stop);
  }
  return { status: 'captured', inventory: [], cases: [], internal: [], pageErrors: [] };
}
module.exports = { holdIsolatedFixture };
