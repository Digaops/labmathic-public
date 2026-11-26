// Ensaio sintético de atualização de schemas anteriores e restauração isolada.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Database = require('better-sqlite3');
const { createBaselineDatabase } = require('./migrationRehearsal');
const { runMigrations, inspectMigrations } = require('../../src/migrations');
const { createHomologationPreMigrationSnapshot } = require('../../src/homologationMigrationSnapshot');
const { finalizeStudentOnlineAttempt } = require('../../src/services/studentAssessmentSubmission');
const currentSchemaVersion = 43;
const silentLogger = { info() {} };
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const quote = (name) => '"' + name.replaceAll('"', '""') + '"';

function oldTableSnapshot(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migrations' ORDER BY name")
    .all().map(({ name }) => {
      const columns = db.pragma('table_info(' + quote(name) + ')').map((column) => column.name);
      const rows = db.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(name)).all()
        .map((row) => JSON.stringify(row)).sort();
      return { name, columns, rows };
    });
}

function seed(db) {
  db.exec(`
    INSERT INTO materials (file_path, thumbnail_path) VALUES ('synthetic.pdf', 'synthetic.png');
    INSERT INTO bncc_skills(code,description,grade_id) VALUES ('QA-LEGACY','Associação anterior preservada',1);
    INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (1,1,2);
    INSERT INTO collections (image_path) VALUES ('synthetic.png');
    INSERT INTO questions (question_code, statement, source, created_by, image_path)
      VALUES ('QA-001', 'Enunciado sintético', 'teacher', 1, 'synthetic.png');
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
      VALUES ('synthetic-municipality-001', 'Município sintético', '3550308', 2);
    INSERT INTO schools (public_id, municipality_id, name, census_code, created_by)
      VALUES ('synthetic-school-0000001', 1, 'Escola sintética', '12345678', 2);
    INSERT INTO institutional_memberships (public_id, user_id, role, municipality_id, school_id, created_by)
      VALUES ('synthetic-membership-001', 1, 'teacher', 1, 1, 2);
    INSERT INTO school_classes (public_id, owner_teacher_id, name, grade_id, academic_year, created_by)
      VALUES ('synthetic-class-00000001', 1, 'Turma sintética', 1, 2026, 1);
    INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by) VALUES (1,1,1,1);
    INSERT INTO students (public_id, owner_teacher_id, display_name, created_by)
      VALUES ('synthetic-student-000001', 1, 'Estudante sintético', 1);
    INSERT INTO school_class_enrollments (class_id, student_id, owner_teacher_id, created_by) VALUES (1,1,1,1);
    INSERT INTO class_assessment_assignments (public_id, class_id, owner_teacher_id, title_snapshot,
      snapshot_hash, question_count, created_by)
      VALUES ('synthetic-assessment-001',1,1,'Avaliação sintética','${'a'.repeat(64)}',1,1);
    INSERT INTO class_assessment_items (assignment_id, class_id, owner_teacher_id, question_code_snapshot,
      statement_snapshot, difficulty_snapshot, sort_order, image_path_snapshot, show_image)
      VALUES (1,1,1,'QA-001','Quanto é 2 + 2?','media',0,'synthetic.png',1);
    INSERT INTO class_assessment_item_options (assessment_item_id, assignment_id, class_id, owner_teacher_id,
      option_label, option_text_snapshot, is_correct, sort_order) VALUES
      (1,1,1,1,'A','4',1,0), (1,1,1,1,'B','5',0,1), (1,1,1,1,'C','6',0,2), (1,1,1,1,'D','7',0,3);
    INSERT INTO class_assessment_participants (assignment_id, class_id, student_id, enrollment_id,
      owner_teacher_id, created_by) VALUES (1,1,1,1,1,1);
    UPDATE class_assessment_assignments SET status='open', opened_at=CURRENT_TIMESTAMP WHERE id=1;
    INSERT INTO class_assessment_attempts (public_id, participant_id, assignment_id, class_id, student_id,
      owner_teacher_id, submission_channel, question_count)
      VALUES ('synthetic-attempt-000001',1,1,1,1,1,'student_online',1);
    INSERT INTO class_assessment_responses (attempt_id, assessment_item_id, selected_option_id, assignment_id,
      class_id, owner_teacher_id, is_correct, answered_at) VALUES (1,1,1,1,1,1,1,CURRENT_TIMESTAMP);
    CREATE TABLE homologation_snapshot_metadata (id INTEGER PRIMARY KEY, sanitized INTEGER NOT NULL);
    INSERT INTO homologation_snapshot_metadata VALUES (1,1);
  `);
  db.transaction(() => finalizeStudentOnlineAttempt(db,
    db.prepare('SELECT * FROM class_assessment_attempts WHERE id=1').get()))();
}

async function runSecurityUpgradeRehearsal({ fromSchemaVersion = 24 } = {}) {
  assert.ok(Number.isInteger(fromSchemaVersion) && fromSchemaVersion >= 24 && fromSchemaVersion < currentSchemaVersion);
  assert.notEqual(process.env.NODE_ENV, 'production', 'Ensaio recusado em produção.');
  // Nenhum DB_PATH/UPLOAD_DIR recebido do ambiente é usado.
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-homologation-upgrade-'));
  const file = path.join(temporary, 'homologation.sqlite');
  const restored = path.join(temporary, 'restored.sqlite');
  let db;
  try {
    db = createBaselineDatabase(file);
    const migrationsPath = path.resolve(__dirname, '../../src/migrations');
    const history = fs.readdirSync(migrationsPath).filter((name) => /^\d{3}_.*\.js$/.test(name))
      .sort().map((name) => require(path.join(migrationsPath, name))).filter(({ version }) => version <= fromSchemaVersion);
    assert.equal(history.length, fromSchemaVersion);
    runMigrations(db, { migrations: history, logger: silentLogger });
    seed(db);
    if (fromSchemaVersion >= 37) {
      const { compileTypedQuestionDefinition } = require('../../src/services/typedQuestionEngine');
      const definition = compileTypedQuestionDefinition({ interactionType:'numeric', content:{stem:'Quanto é a metade de cinco?',unit:'litros'},
        scoring:{strategy:'numeric_exact',partialCredit:false},answerKey:{value:2.5},
        accessibility:{responseLabel:'Resposta numérica',instructions:'Escreva apenas o número.'},
        print:{supported:true,layout:'answer_box',instructions:'Escreva o número.',answerSpaceLines:2},
        feedback:{releasePolicy:'teacher_only',general:'Divida cinco por dois.',correct:null,incorrect:null,choiceFeedback:{}} });
      const q=db.prepare("INSERT INTO questions(question_code,skill_id,statement,status,source,created_by,question_type) VALUES('LEGACY-NUM',1,'Quanto é a metade de cinco?','inactive','teacher',1,'numeric_draft')").run().lastInsertRowid;
      const item=db.prepare('INSERT INTO typed_question_items(public_id,question_id,created_by,updated_by) VALUES(?,?,1,1)').run(crypto.randomUUID(),q).lastInsertRowid;
      db.prepare("INSERT INTO typed_question_item_versions(public_id,item_id,version,interaction_type,scoring_strategy,definition_json,definition_hash,created_by,updated_by) VALUES(?,?,1,'numeric','numeric_exact',?,?,1,1)")
        .run(crypto.randomUUID(),item,definition.definitionJson,definition.definitionHash);
    }
    if (fromSchemaVersion >= 32) db.exec(`INSERT INTO ai_authoring_requests(public_id,teacher_id,idempotency_key,request_hash,brief_json,model,prompt_version,status,reserved_tokens,created_at)
      VALUES('legacy-ai-sentinel',1,'legacy-key','legacy-hash','{"teacherText":"histórico sintético preservado"}','legacy-fixture','v1','failed',1000,1);`);
    db.pragma('journal_mode = WAL');
    const original = oldTableSnapshot(db);
    const historyBefore = db.prepare('SELECT * FROM schema_migrations ORDER BY version').all();
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    const snapshot = createHomologationPreMigrationSnapshot({ appEnvironment: 'homologation',
      databasePath: file, sourceSha: 'b'.repeat(40) });
    assert.equal(snapshot.schemaVersion, fromSchemaVersion);
    assert.equal(snapshot.toSchemaVersion, currentSchemaVersion);
    const result = runMigrations(db, { logger: silentLogger });
    assert.deepEqual(result.appliedNow.map(({ version }) => version),
      Array.from({ length: currentSchemaVersion - fromSchemaVersion }, (_, index) => fromSchemaVersion + index + 1));
    for (const { name, columns, rows } of original) {
      const after = db.prepare('SELECT ' + columns.map(quote).join(',') + ' FROM ' + quote(name)
        + (name === 'feature_flags' ? " WHERE 1=1" + (fromSchemaVersion < 42 ? " AND flag_key <> 'question_bank.editorial_pilot'" : '') + (fromSchemaVersion < 39 ? " AND flag_key <> 'classes.numeric_assessments'" : '') + (fromSchemaVersion < 37 ? " AND flag_key <> 'question_bank.numeric_drafts'" : '') + (fromSchemaVersion < 35 ? " AND flag_key <> 'institutions.school_coordination'" : '') + (fromSchemaVersion < 36 ? " AND flag_key <> 'classes.student_feedback_release'" : '') + (fromSchemaVersion < 34 ? " AND flag_key <> 'content.issue_review'" : '') + (fromSchemaVersion < 33 ? " AND flag_key <> 'ai.questions_generation'" : '') + (fromSchemaVersion < 32 ? " AND flag_key <> 'question_bank.ai_assistant'" : '') + (fromSchemaVersion < 31 ? " AND flag_key <> 'institutions.network_portrait'" : '') + (fromSchemaVersion < 30 ? " AND flag_key <> 'classes.assessment_exemptions'" : '') + (fromSchemaVersion < 29 ? " AND flag_key <> 'materials.bncc_curation'" : '') + (fromSchemaVersion < 28 ? " AND flag_key <> 'materials.draft_publication'" : '') + (fromSchemaVersion < 26 ? " AND flag_key <> 'pedagogy.operational_cycle'" : '') : '')).all()
        .map((row) => JSON.stringify(row)).sort();
      assert.deepEqual(after, rows, 'Dados alterados na tabela ' + name);
    }
    assert.deepEqual(db.prepare('SELECT * FROM schema_migrations WHERE version<=? ORDER BY version').all(fromSchemaVersion), historyBefore);
    assert.equal(db.prepare('SELECT COUNT(*) FROM pedagogical_feedback_versions').pluck().get(), 0);
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='pedagogy.operational_cycle'").get(),
      { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.equal(db.prepare('SELECT score_percentage FROM class_assessment_attempts WHERE id=1').pluck().get(), 100);
    assert.equal(db.prepare('SELECT SUM(auth_version) FROM users').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM revoked_auth_tokens').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM material_file_retirements').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM material_management_operations').pluck().get(), 0);
    assert.equal(db.prepare('SELECT COUNT(*) FROM question_set_creation_receipts').pluck().get(), 0);
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='classes.assessment_exemptions'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='institutions.network_portrait'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='question_bank.ai_assistant'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.equal(db.prepare('SELECT COUNT(*) FROM ai_authoring_requests').pluck().get(), fromSchemaVersion >= 32 ? 1 : 0);
    for (const table of ['ai_usage_events','ai_budget_months']) assert.equal(db.prepare('SELECT COUNT(*) FROM ' + table).pluck().get(), 0);
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='ai.questions_generation'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.equal(db.prepare('SELECT batch_id FROM municipal_indicator_publication WHERE id=1').pluck().get(), null);
    for (const table of ['material_drafts', 'material_draft_files', 'material_draft_operations', 'material_bncc_reviews', 'material_bncc_review_state', 'material_bncc_operations']) assert.equal(db.prepare('SELECT COUNT(*) FROM ' + table).pluck().get(), 0);
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='materials.draft_publication'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(runMigrations(db, { logger: silentLogger }).appliedNow.length, 0);
    assert.equal(inspectMigrations(db).pending.length, 0);
    assert.deepEqual(db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='question_bank.numeric_drafts'").get(), { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
    assert.ok(inspectMigrations(db, history).unknown.some(({ version }) => version === currentSchemaVersion));
    // Código antigo deve recusar schema desconhecido, não tentar repará-lo.
    assert.throws(() => runMigrations(db, { migrations: history, logger: silentLogger }), /desconhecidas/);
    db.close(); db = null;
    fs.copyFileSync(snapshot.snapshotPath, restored);
    assert.equal(digest(restored), snapshot.sha256);
    db = new Database(restored, { readonly: true, fileMustExist: true });
    assert.deepEqual(oldTableSnapshot(db), original);
    assert.equal(db.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), fromSchemaVersion);
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
    assert.deepEqual(db.pragma('foreign_key_check'), []);
    assert.equal(db.prepare("SELECT master_enabled FROM feature_flags WHERE flag_key='question_bank.numeric_drafts'").pluck().get(), fromSchemaVersion < 37 ? undefined : 0);
    return { status: 'passed', fromSchemaVersion, toSchemaVersion: currentSchemaVersion,
      tablesCompared: original.length, populatedTables: original.filter(({ rows }) => rows.length).length,
      legacyRowsPreserved: true, usersAndPasswordsPreserved: true, featureFlagsPreserved: true,
      submittedScorePreserved: true, migrationHistoryPreserved: true, exactSnapshotRestored: true,
      snapshotSha256: snapshot.sha256, oldCodeRejectsNewSchema: true,
      realDatabaseTouched: false, realUploadsTouched: false };
  } finally {
    if (db?.open) db.close();
    const relative = path.relative(fs.realpathSync(os.tmpdir()), fs.realpathSync(temporary));
    assert.ok(relative && !relative.startsWith('..') && !path.isAbsolute(relative));
    fs.rmSync(temporary, { recursive: true, force: true });
  }
}
if (require.main === module) runSecurityUpgradeRehearsal()
  .then((result) => console.log(JSON.stringify(result, null, 2)))
  .catch((error) => { console.error(error.message); process.exitCode = 1; });
module.exports = { runSecurityUpgradeRehearsal };
