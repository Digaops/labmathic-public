const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const bcrypt = require('bcryptjs');
const Database = require('better-sqlite3');
const {
  CONFIRMATION,
  createSanitizedDatabase,
} = require('../scripts/homologation/sanitizeDatabase');
const { compileTypedQuestionDefinition } = require('../src/services/typedQuestionEngine');
const { inspectHomologationDatabase } = require('../src/services/bundledSchoolDirectory');

const serverRoot = path.resolve(__dirname, '..');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-homologation-test-'));
const sourcePath = path.join(tempRoot, 'source.sqlite');
const outputPath = path.join(tempRoot, 'homologation.sqlite');
const manifestPath = `${outputPath}.manifest.json`;
const uploadsPath = path.join(tempRoot, 'homologation-uploads');
const adminPassword = 'Admin-Homologacao-2026!';
const professorPassword = 'Professor-Homologacao-2026!';

function fileHash(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function runDatabaseProcess({
  databasePath,
  appEnvironment = 'development',
  studentAccessSecret = 'student-access-homologation-test-secret-only',
}) {
  const script = `
    const db = require(${JSON.stringify(path.join(serverRoot, 'src', 'database.js'))});
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
  `;
  return spawnSync(process.execPath, ['-e', script], {
    cwd: serverRoot,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: appEnvironment === 'homologation' ? 'production' : 'test',
      APP_ENV: appEnvironment,
      DB_PATH: databasePath,
      UPLOAD_DIR: uploadsPath,
      JWT_SECRET: 'homologation-test-secret-that-is-not-used-outside-tests',
      CLASS_ENTRY_CODE_SECRET: '',
      STUDENT_ASSESSMENT_ACCESS_SECRET: studentAccessSecret,
      SMTP_USER: '',
      SMTP_PASS: '',
    },
  });
}

function createCurrentSchema() {
  fs.mkdirSync(uploadsPath, { recursive: true });
  const result = runDatabaseProcess({ databasePath: sourcePath });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function seedSensitiveFixtures() {
  const db = new Database(sourcePath);
  db.pragma('foreign_keys = ON');

  db.transaction(() => {
    const adminId = db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Administradora Real', 'admin.real@escola.com.br', ?, 'admin')
    `).run(bcrypt.hashSync('senha-real-nao-exportar', 4)).lastInsertRowid;
    const professorId = db.prepare(`
      INSERT INTO users (name, email, password, role)
      VALUES ('Professora Real', 'professora.real@escola.com.br', ?, 'professor')
    `).run(bcrypt.hashSync('outra-senha-real-nao-exportar', 4)).lastInsertRowid;

    // Migration 040 only transforms receipt data, so omitting its ledger row
    // yields a pre-040 copy with a professional receipt still in the old format.
    db.exec(`
      DROP TABLE question_editorial_curation;
      DELETE FROM feature_flags WHERE flag_key = 'question_bank.editorial_pilot';
      DROP TABLE question_set_creation_receipts;
      DELETE FROM schema_migrations WHERE version >= 40;
    `);
    db.prepare(`INSERT INTO institutional_write_operations (
      public_id, operation_type, actor_user_id, entity_type, entity_key,
      idempotency_key_hash, request_fingerprint, result_json
    ) VALUES ('legacy-professional-receipt-0001', 'create_professional', ?, 'membership',
      'legacy-membership-0001', ?, ?, '{}')`).run(adminId, 'a'.repeat(64), 'b'.repeat(64));

    db.prepare(`INSERT INTO ai_authoring_requests(public_id,teacher_id,idempotency_key,request_hash,brief_json,model,prompt_version,status,reserved_tokens,created_at)
      VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',?,'synthetic-key','synthetic-hash',?,'fixture','test','failed',1000,1)`)
      .run(professorId, JSON.stringify({ teacherText: 'Texto privado professora.real@escola.com.br' }));
    db.prepare("INSERT INTO ai_authoring_events(request_id,action,created_at) VALUES('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa','reserved',1)").run();
    db.prepare(`INSERT INTO ai_usage_events(id,user_id,model,operation,pricing_version,questions_requested,status,reserved_cost_nanos,created_at)
      VALUES('synthetic-usage',?,'gpt-5.6-luna','questions.generate','test',1,'reserved',1000,1)`).run(professorId);
    db.exec("INSERT INTO ai_budget_months VALUES('2026-09',70,1000,2000,1)");
    const contentIssue = db.prepare(`INSERT INTO content_issues(public_id,reporter_id,target_type,target_id,target_label,reason,description)
      VALUES('synthetic-private-content-issue',?,'material',1,'Conteúdo privado','content','Relato privado com informação de estudante não exportar.')`).run(professorId).lastInsertRowid;
    db.prepare("INSERT INTO content_issue_events(issue_id,actor_id,action,reply,revision) VALUES (?,?,'created','Resposta privada não exportar.',1)").run(contentIssue, professorId);
    db.prepare('INSERT INTO content_issue_operations(actor_id,key_hash,request_hash,receipt_json) VALUES (?,?,?,?)').run(professorId, 'a'.repeat(64), 'b'.repeat(64), '{}');

    db.prepare(`
      INSERT INTO password_reset_tokens (user_id, token, expires_at)
      VALUES (?, 'token-secreto-producao', '2099-01-01T00:00:00.000Z')
    `).run(professorId);
    db.prepare(`
      INSERT INTO revoked_auth_tokens (token_digest, user_id, expires_at) VALUES (?, ?, ?)
    `).run('f'.repeat(64), professorId, 4102444800);
    db.prepare(`INSERT INTO material_management_operations
      (actor_user_id, key_hash, request_hash, operation, material_id, receipt_json) VALUES (?, ?, ?, 'create', ?, ?)`)
      .run(adminId, 'e'.repeat(64), 'd'.repeat(64), 99999,
        JSON.stringify({ title: 'Recibo privado: professora.real@escola.com.br' }));
    db.prepare(`INSERT INTO material_file_retirements
      (file_path, material_id, reason, recovery_json, retired_by) VALUES (?, ?, ?, ?, ?)`)
      .run('retired-private.pdf', 99999, 'deleted', JSON.stringify({ private: 'professora.real@escola.com.br' }), adminId);
    const supportThreadId = db.prepare(`
      INSERT INTO support_threads (professor_id, subject)
      VALUES (?, 'Problema técnico')
    `).run(professorId).lastInsertRowid;
    db.prepare(`
      INSERT INTO support_messages (thread_id, sender_id, body)
      VALUES (?, ?, 'Meu telefone é (11) 99999-9999 e meu CPF é 123.456.789-00')
    `).run(supportThreadId, professorId);
    db.prepare(`
      INSERT INTO notifications (user_id, type, title, message)
      VALUES (?, 'support', 'Mensagem privada', 'Responder professora.real@escola.com.br')
    `).run(adminId);
    db.prepare(`
      INSERT INTO activity_log (user_id, action, entity_type, metadata, description, ip_address)
      VALUES (?, 'login', 'user', '{"email":"professora.real@escola.com.br"}', 'Dado real', '203.0.113.50')
    `).run(professorId);
    db.prepare(`
      INSERT INTO collections (user_id, name, description, is_public)
      VALUES (?, 'Planejamento particular', 'Notas privadas', 1)
    `).run(professorId);
    const questionSetId = db.prepare(`
      INSERT INTO question_sets (user_id, title, description, is_public)
      VALUES (?, 'Prova da turma real', 'Anotações da turma', 1)
    `).run(professorId).lastInsertRowid;
    const diagnosticQuestionSetId = db.prepare(`
      INSERT INTO question_sets (user_id, title, description, is_public)
      VALUES (?, 'Diagnóstico privado real', 'Composição já conferida', 0)
    `).run(professorId).lastInsertRowid;
    db.prepare(`
      UPDATE announcements
      SET payload_json = '{"contato":"coordenacao.real@escola.com.br"}'
      WHERE announcement_key = 'author_questions_and_support_launch_2026_08'
    `).run();
    db.prepare(`
      INSERT INTO feature_flags (
        flag_key, name, master_enabled, default_enabled,
        rollout_percentage, kill_switch_active
      ) VALUES ('teste.perigoso', 'Flag ligada', 1, 1, 100, 0)
    `).run();
    db.prepare(`
      INSERT INTO pilot_groups (group_key, name, active)
      VALUES ('escola_real', 'Escola real', 1)
    `).run();
    db.prepare(`
      INSERT INTO governance_audit_log (
        actor_id, action, entity_type, reason, ip_address, user_agent
      ) VALUES (?, 'created', 'feature_flag', 'Registro sensível de auditoria', '203.0.113.50', 'Navegador real')
    `).run(adminId);

    db.prepare("INSERT OR IGNORE INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)").run();
    db.prepare("INSERT OR IGNORE INTO disciplines (name) VALUES ('Matemática')").run();
    const gradeId = db.prepare("SELECT id FROM grades WHERE name = '7º Ano - EF'").pluck().get();
    const disciplineId = db.prepare("SELECT id FROM disciplines WHERE name = 'Matemática'").pluck().get();
    db.prepare(`
      INSERT OR IGNORE INTO bncc_units (name, sort_order)
      VALUES ('Unidade para sanitização', 999)
    `).run();
    const unitId = db.prepare(`
      SELECT id FROM bncc_units WHERE name = 'Unidade para sanitização'
    `).pluck().get();
    const skillId = db.prepare(`
      INSERT INTO bncc_skills (code, description, grade_id, unit_id)
      VALUES ('EF07MA99', 'Habilidade sintética para sanitização.', ?, ?)
    `).run(gradeId, unitId).lastInsertRowid;
    const curatedMaterial = Number(db.prepare("INSERT INTO materials(title,created_by) VALUES ('Material sintético para revisão',?)").run(adminId).lastInsertRowid);
    db.prepare('INSERT INTO material_bncc_skills(material_id,skill_id,linked_by) VALUES (?,?,?)').run(curatedMaterial, skillId, adminId);
    const curatedReview = Number(db.prepare(`INSERT INTO material_bncc_reviews(material_id,skill_id,decision,reason,location,actor_id,actor_name,evidence_json)
      VALUES (?,?,'confirm','Contato privado professora.real@escola.com.br','Atividade 1',?,'Administrador real','{}')`).run(curatedMaterial, skillId, adminId).lastInsertRowid);
    db.prepare('INSERT INTO material_bncc_review_state(material_id,skill_id,review_id) VALUES (?,?,?)').run(curatedMaterial, skillId, curatedReview);
    const questionId = db.prepare(`
      INSERT INTO questions (
        question_code, skill_id, statement, difficulty, question_type,
        status, source, reviewed, created_by
      ) VALUES (
        'EF07MA99-TYPED', ?, 'Questão tipada para sanitização.',
        'media', 'multiple_choice', 'active', 'teacher', 1, ?
      )
    `).run(skillId, professorId).lastInsertRowid;
    const typedDefinition = compileTypedQuestionDefinition({
      interactionType: 'numeric',
      content: {
        stem: 'Contato contextual professora.real@escola.com.br: calcule 2 + 2.',
        supportText: 'Referência no texto 12345678-1234-4234-8234-123456789012; telefone (11) 99999-9999; CPF 123.456.789-00.',
        unit: null,
      },
      scoring: { strategy: 'numeric_exact', partialCredit: false },
      answerKey: { value: 4 },
      accessibility: {
        responseLabel: 'Resposta numérica',
        instructions: 'Digite um número.',
      },
      print: {
        supported: true,
        layout: 'answer_box',
        instructions: 'Escreva o número.',
        answerSpaceLines: 2,
      },
      feedback: {
        releasePolicy: 'teacher_only',
        general: null,
        correct: null,
        incorrect: null,
        choiceFeedback: {},
      },
    });
    const typedItemId = db.prepare(`
      INSERT INTO typed_question_items (
        public_id, question_id, created_by, updated_by
      ) VALUES ('12345678-1234-4234-8234-123456789013', ?, ?, ?)
    `).run(questionId, professorId, professorId).lastInsertRowid;
    const typedVersionId = db.prepare(`
      INSERT INTO typed_question_item_versions (
        public_id, item_id, version, engine_version, format_version,
        interaction_type, correction_mode, scoring_strategy, partial_credit,
        accessibility_ready, print_supported, definition_json, definition_hash,
        created_by, updated_by
      ) VALUES (
        '12345678-1234-4234-8234-123456789012', ?, 1, 1, 1,
        'numeric', 'automatic', 'numeric_exact', 0,
        1, 1, ?, ?, ?, ?
      )
    `).run(
      typedItemId,
      typedDefinition.definitionJson,
      typedDefinition.definitionHash,
      professorId,
      professorId,
    ).lastInsertRowid;
    const typedReviewId = db.prepare(`
      INSERT INTO typed_question_review_cycles (
        public_id, item_id, version_id, review_round,
        version_revision, definition_hash, submitted_by
      ) VALUES ('real-typed-review-0001', ?, ?, 1, 1, ?, ?)
    `).run(
      typedItemId,
      typedVersionId,
      typedDefinition.definitionHash,
      professorId,
    ).lastInsertRowid;
    db.prepare(`
      UPDATE typed_question_review_cycles
      SET status = 'approved', decided_by = ?, decided_at = CURRENT_TIMESTAMP,
          decision_reason = 'Revisão editorial sintética aprovada.',
          revision = 2, updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(adminId, typedReviewId);
    db.prepare('INSERT INTO numeric_question_review_snapshots(review_id,payload_json) VALUES(?,?)')
      .run(typedReviewId, JSON.stringify({ statement: 'Anotação privada professora.real@escola.com.br' }));
    db.prepare(`
      INSERT INTO typed_question_write_operations (
        public_id, operation_type, actor_id, item_id, version_id, review_id,
        idempotency_key_hash, request_fingerprint, result_json
      ) VALUES (
        'real-typed-operation-0001', 'approve_review', ?, ?, ?, ?,
        ?, ?, ?
      )
    `).run(
      adminId,
      typedItemId,
      typedVersionId,
      typedReviewId,
      'a'.repeat(64),
      'b'.repeat(64),
      JSON.stringify({ reviewerEmail: 'admin.real@escola.com.br' }),
    );
    db.prepare(`
      UPDATE typed_question_item_versions
      SET status = 'published', revision = 2,
          updated_by = ?, published_by = ?, published_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(adminId, adminId, typedVersionId);
    db.prepare(`
      INSERT INTO typed_question_current_versions (
        item_id, version_id, activated_by
      ) VALUES (?, ?, ?)
    `).run(typedItemId, typedVersionId, adminId);
    db.prepare(`
      UPDATE typed_question_items
      SET status = 'active', revision = 2, updated_by = ?
      WHERE id = ?
    `).run(adminId, typedItemId);
    db.prepare(`
      INSERT INTO diagnostic_question_sets (
        question_set_id, owner_teacher_id, grade_id,
        questions_per_skill, total_questions
      ) VALUES (?, ?, ?, 2, 2)
    `).run(diagnosticQuestionSetId, professorId, gradeId);
    db.prepare(`
      INSERT INTO diagnostic_question_set_skills (
        question_set_id, owner_teacher_id, grade_id, skill_id,
        requested_count, selected_count, easy_count, medium_count,
        difficult_count, candidate_count
      ) VALUES (?, ?, ?, ?, 2, 2, 1, 1, 0, 2)
    `).run(diagnosticQuestionSetId, professorId, gradeId, skillId);
    db.prepare(`
      INSERT INTO diagnostic_question_set_reviews (
        question_set_id, owner_teacher_id, reviewed_by
      ) VALUES (?, ?, ?)
    `).run(diagnosticQuestionSetId, professorId, professorId);
    const classId = db.prepare(`
      INSERT INTO school_classes (
        public_id, owner_teacher_id, name, grade_id, academic_year, created_by
      ) VALUES ('real-class-public-id-001', ?, 'Turma real identificável', ?, 2026, ?)
    `).run(professorId, gradeId, professorId).lastInsertRowid;
    const municipalityId = db.prepare(`
      INSERT INTO municipalities (public_id, name, ibge_code, created_by)
      VALUES ('real-municipality-id-001', 'Município Real Identificável', '3550308', ?)
    `).run(adminId).lastInsertRowid;
    const schoolId = db.prepare(`
      INSERT INTO schools (
        public_id, municipality_id, name, census_code, created_by
      ) VALUES (
        'real-school-public-id-001', ?, 'Escola Real Identificável', 'INEP-REAL-001', ?
      )
    `).run(municipalityId, adminId).lastInsertRowid;
    db.prepare(`
      INSERT INTO institutional_memberships (
        public_id, user_id, role, municipality_id, school_id, created_by
      ) VALUES ('real-membership-id-0001', ?, 'teacher', ?, ?, ?)
    `).run(professorId, municipalityId, schoolId, adminId);
    db.prepare(`
      UPDATE school_class_institution_contexts
      SET municipality_id = ?, school_id = ?, migration_status = 'linked',
        linked_by = ?, linked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE class_id = ?
    `).run(municipalityId, schoolId, adminId, classId);
    db.prepare(`
      UPDATE school_class_institution_contexts
      SET migration_status = 'verified', verified_by = ?,
        verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE class_id = ?
    `).run(adminId, classId);
    db.prepare(`
      INSERT INTO institutional_audit_log (
        actor_user_id, actor_name_snapshot,
        responsible_user_id, responsible_name_snapshot,
        action, entity_type, entity_key, municipality_id, school_id, reason
      ) VALUES (
        ?, 'Administradora Real', ?, 'Professora Real',
        'verify_class_context', 'school_class_context',
        'real-class-public-id-001', ?, ?,
        'Contexto real confirmado antes da sanitização de homologação.'
      )
    `).run(adminId, professorId, municipalityId, schoolId);
    db.prepare(`
      INSERT INTO school_class_disciplines (
        class_id, owner_teacher_id, discipline_id, added_by
      ) VALUES (?, ?, ?, ?)
    `).run(classId, professorId, disciplineId, professorId);
    const studentId = db.prepare(`
      INSERT INTO students (
        public_id, owner_teacher_id, display_name, external_reference, created_by
      ) VALUES ('real-student-public-id-1', ?, 'Estudante Real Identificável', 'MATRICULA-REAL-001', ?)
    `).run(professorId, professorId).lastInsertRowid;
    const enrollmentId = db.prepare(`
      INSERT INTO school_class_enrollments (
        class_id, student_id, owner_teacher_id, created_by
      ) VALUES (?, ?, ?, ?)
    `).run(classId, studentId, professorId, professorId).lastInsertRowid;
    const entryCodeId = db.prepare(`
      INSERT INTO school_class_entry_codes (
        public_id, class_id, owner_teacher_id, code_digest,
        max_uses, expires_at, created_by
      ) VALUES ('real-entry-code-public-1', ?, ?, ?, 1, '2099-01-01T00:00:00.000Z', ?)
    `).run(classId, professorId, 'e'.repeat(64), professorId).lastInsertRowid;
    db.prepare(`
      INSERT INTO school_class_entry_code_redemptions (
        entry_code_id, class_id, student_id, enrollment_id, owner_teacher_id,
        request_digest
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(entryCodeId, classId, studentId, enrollmentId, professorId, 'f'.repeat(64));

    const assignmentId = db.prepare(`
      INSERT INTO class_assessment_assignments (
        public_id, class_id, owner_teacher_id, source_question_set_id,
        title_snapshot, description_snapshot, snapshot_hash,
        question_count, created_by, updated_by
      ) VALUES (
        'real-assessment-public-01', ?, ?, ?,
        'Prova identificavel da turma real', 'Observacao privada', ?,
        1, ?, ?
      )
    `).run(
      classId,
      professorId,
      diagnosticQuestionSetId,
      'a'.repeat(64),
      professorId,
      professorId
    ).lastInsertRowid;
    const assessmentItemId = db.prepare(`
      INSERT INTO class_assessment_items (
        assignment_id, class_id, owner_teacher_id, source_question_id, source_skill_id,
        question_code_snapshot, skill_code_snapshot, skill_description_snapshot,
        statement_snapshot, difficulty_snapshot, sort_order
      ) VALUES (?, ?, ?, ?, ?, 'REAL-Q001', 'EF07MA99',
        'Habilidade sintética para sanitização.',
        'Questao real identificavel', 'media', 0)
    `).run(
      assignmentId,
      classId,
      professorId,
      questionId,
      skillId,
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO class_assessment_typed_item_snapshots (
        assessment_item_id, typed_item_id, typed_version_id,
        engine_version, format_version, interaction_type, correction_mode,
        scoring_strategy, partial_credit, definition_json, definition_hash
      ) VALUES (?, ?, ?, 1, 1, 'numeric', 'automatic', 'numeric_exact', 0, ?, ?)
    `).run(
      assessmentItemId,
      typedItemId,
      typedVersionId,
      typedDefinition.definitionJson,
      typedDefinition.definitionHash,
    );
    const insertAssessmentOption = db.prepare(`
      INSERT INTO class_assessment_item_options (
        assessment_item_id, assignment_id, class_id, owner_teacher_id,
        option_label, option_text_snapshot, is_correct, sort_order
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    let correctOptionId = null;
    [
      ['A', 'Resposta real A', 1, 0],
      ['B', 'Resposta real B', 0, 1],
      ['C', 'Resposta real C', 0, 2],
      ['D', 'Resposta real D', 0, 3],
    ].forEach(([label, text, correct, order]) => {
      const inserted = insertAssessmentOption.run(
        assessmentItemId,
        assignmentId,
        classId,
        professorId,
        label,
        text,
        correct,
        order
      );
      if (correct) correctOptionId = Number(inserted.lastInsertRowid);
    });
    const participantId = db.prepare(`
      INSERT INTO class_assessment_participants (
        assignment_id, class_id, student_id, enrollment_id,
        owner_teacher_id, created_by
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      assignmentId,
      classId,
      studentId,
      enrollmentId,
      professorId,
      professorId
    ).lastInsertRowid;
    db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'open', opened_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(assignmentId);
    db.prepare(`
      INSERT INTO class_assessment_access_credentials (
        public_id, participant_id, assignment_id, class_id, student_id,
        owner_teacher_id, code_digest, code_hint, issued_at, expires_at,
        created_by, updated_by
      ) VALUES (
        'real-assessment-access-01', ?, ?, ?, ?,
        ?, ?, 'REAL', CURRENT_TIMESTAMP, '2099-01-01T00:00:00.000Z',
        ?, ?
      )
    `).run(
      participantId,
      assignmentId,
      classId,
      studentId,
      professorId,
      'd'.repeat(64),
      professorId,
      professorId
    );

    const attemptId = db.prepare(`
      INSERT INTO class_assessment_attempts (
        public_id, participant_id, assignment_id, class_id, student_id,
        owner_teacher_id, question_count, created_by, updated_by
      ) VALUES ('real-attempt-public-id-01', ?, ?, ?, ?, ?, 1, ?, ?)
    `).run(
      participantId,
      assignmentId,
      classId,
      studentId,
      professorId,
      professorId,
      professorId
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO class_assessment_responses (
        attempt_id, assessment_item_id, selected_option_id,
        assignment_id, class_id, owner_teacher_id, is_correct, answered_at
      ) VALUES (?, ?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
    `).run(
      attemptId,
      assessmentItemId,
      correctOptionId,
      assignmentId,
      classId,
      professorId
    );
    db.prepare(`
      UPDATE class_assessment_attempts
      SET status = 'submitted', answered_count = 1, correct_count = 1,
          score_percentage = 100, submitted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(attemptId);
    db.prepare(`
      UPDATE class_assessment_participants
      SET status = 'submitted', submitted_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(participantId);
    db.prepare(`
      UPDATE class_assessment_assignments
      SET status = 'closed', closed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(assignmentId);
    const feedbackId = db.prepare(`
      INSERT INTO student_assessment_feedback(
        public_id, assignment_id, participant_id, class_id, student_id,
        owner_teacher_id, message, created_by
      ) VALUES ('real-student-feedback-01', ?, ?, ?, ?, ?,
        'Orientação privada com nome de estudante real.', ?)
    `).run(assignmentId, participantId, classId, studentId, professorId, professorId).lastInsertRowid;
    db.prepare(`
      INSERT INTO student_assessment_feedback_events(feedback_id,actor_id,action,revision)
      VALUES (?, ?, 'released', 1)
    `).run(feedbackId, professorId);
    db.prepare(`
      INSERT INTO student_assessment_feedback_operations(actor_id,key_hash,request_hash,feedback_id,receipt_json)
      VALUES (?, ?, ?, ?, ?)
    `).run(professorId, '1'.repeat(64), '2'.repeat(64), feedbackId, JSON.stringify({ feedback: { id: 'real-student-feedback-01' } }));

    db.prepare(`
      INSERT INTO pedagogical_feedback_versions
        (assignment_id,class_id,owner_teacher_id,revision,request_key,request_hash,evidence_hash,evidence_json,objective,observation,action,verification)
      VALUES (?,?,?,1,?,?,?,'{}','Objetivo privado da turma','Observação privada da turma','Intervenção privada da turma','Verificação privada da turma')
    `).run(assignmentId,classId,professorId,'a'.repeat(64),'b'.repeat(64),'c'.repeat(64));
    const recoveryPlanId = db.prepare(`
      INSERT INTO learning_recovery_plans (
        public_id, owner_teacher_id, class_id, source_assignment_id,
        title, idempotency_key_hash, request_fingerprint,
        source_assessment_revision, source_results_revision_hash,
        diagnostic_algorithm_version_snapshot,
        diagnostic_confirmation_version_snapshot, created_by, updated_by
      ) VALUES ('real-recovery-plan-id-01', ?, ?, ?,
        'Plano com agrupamento identificável', ?, ?, 1, ?,
        'balanced-v1', 'teacher-review-v1', ?, ?)
    `).run(
      professorId,
      classId,
      assignmentId,
      'a'.repeat(64),
      'b'.repeat(64),
      'c'.repeat(64),
      professorId,
      professorId
    ).lastInsertRowid;
    db.prepare(`
      INSERT INTO learning_recovery_plan_skills (
        plan_id, owner_teacher_id, class_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot,
        success_rate_snapshot, opportunity_count, diagnostic_level, priority
      ) VALUES (?, ?, ?, ?, 'EF07MA99',
        'Habilidade sintética para sanitização.', 45, 4, 'below_expected', 1)
    `).run(recoveryPlanId, professorId, classId, skillId);
    const recoveryGroupId = db.prepare(`
      INSERT INTO learning_recovery_student_groups (
        public_id, plan_id, owner_teacher_id, class_id, focus_skill_id,
        focus_skill_code_snapshot, title, objective, sort_order
      ) VALUES ('real-recovery-group-id-01', ?, ?, ?, ?, 'EF07MA99',
        'Grupo identificável', 'Intervenção com estudante real.', 1)
    `).run(recoveryPlanId, professorId, classId, skillId).lastInsertRowid;
    db.prepare(`
      INSERT INTO learning_recovery_student_group_members (
        group_id, plan_id, student_id, owner_teacher_id, class_id,
        success_rate_snapshot, opportunity_count
      ) VALUES (?, ?, ?, ?, ?, 45, 4)
    `).run(recoveryGroupId, recoveryPlanId, studentId, professorId, classId);
    db.prepare(`
      UPDATE learning_recovery_plans
      SET status = 'active', activated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(recoveryPlanId);

    const teachingPlanId = db.prepare(`
      INSERT INTO teaching_plans (
        public_id, owner_teacher_id, class_id, grade_id, discipline_id,
        source_recovery_plan_id, title, period_type, academic_year,
        starts_on, ends_on, created_by, updated_by
      ) VALUES ('real-teaching-plan-id-001', ?, ?, ?, ?, ?,
        'Planejamento privado identificável', 'week', 2026,
        '2026-08-17', '2026-08-21', ?, ?)
    `).run(
      professorId,
      classId,
      gradeId,
      disciplineId,
      recoveryPlanId,
      professorId,
      professorId
    ).lastInsertRowid;
    const lessonId = db.prepare(`
      INSERT INTO teaching_plan_lessons (
        public_id, plan_id, owner_teacher_id, title, objective,
        teacher_notes, sequence_order, planned_date, lesson_phase
      ) VALUES ('real-teaching-lesson-id-01', ?, ?, 'Aula identificável',
        'Intervir na habilidade prioritária.', 'Observação sobre estudante real.',
        1, '2026-08-18', 'monitoring')
    `).run(teachingPlanId, professorId).lastInsertRowid;
    db.prepare(`
      INSERT INTO teaching_plan_lesson_skills (
        lesson_id, plan_id, owner_teacher_id, source_skill_id,
        skill_code_snapshot, skill_description_snapshot
      ) VALUES (?, ?, ?, ?, 'EF07MA99', 'Habilidade sintética para sanitização.')
    `).run(lessonId, teachingPlanId, professorId, skillId);
    db.prepare(`
      INSERT INTO teaching_plan_lesson_resources (
        lesson_id, plan_id, owner_teacher_id, resource_type,
        title_snapshot, teacher_notes, sort_order
      ) VALUES (?, ?, ?, 'activity', 'Atividade privada',
        'Registro livre potencialmente sensível.', 1)
    `).run(lessonId, teachingPlanId, professorId);
    db.prepare(`
      UPDATE teaching_plans
      SET status = 'active', activated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(teachingPlanId);
    db.prepare(`
      UPDATE teaching_plan_lessons
      SET status = 'skipped',
          teacher_notes = 'Verificação não realizada neste cenário de sanitização.'
      WHERE id = ?
    `).run(lessonId);
    db.prepare(`
      UPDATE teaching_plans
      SET status = 'completed', completed_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(teachingPlanId);
  })();

  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
}

function sanitizerOptions(overrides = {}) {
  return {
    sourcePath,
    outputPath,
    manifestPath,
    confirmation: CONFIRMATION,
    adminEmail: 'smoke.admin@homologacao.invalid',
    adminPassword,
    professorEmail: 'smoke.professor@homologacao.invalid',
    professorPassword,
    ...overrides,
  };
}

test.before(() => {
  createCurrentSchema();
  seedSensitiveFixtures();
});

test.after(() => {
  fs.rmSync(tempRoot, { recursive: true, force: true });
});

test('gera cópia sanitizada sem alterar um byte do banco de origem', async () => {
  const sourceHashBefore = fileHash(sourcePath);
  const report = await createSanitizedDatabase(sanitizerOptions());
  const sourceHashAfter = fileHash(sourcePath);

  assert.equal(report.status, 'sanitized');
  assert.equal(report.verification.integrityCheck, 'ok');
  assert.equal(report.verification.foreignKeyViolations, 0);
  assert.equal(sourceHashAfter, sourceHashBefore);

  const sourceDb = new Database(sourcePath, { readonly: true });
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM content_issues').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM content_issue_events').pluck().get(), 1);
  assert.equal(
    sourceDb.prepare("SELECT COUNT(*) FROM users WHERE email LIKE '%@escola.com.br'").pluck().get(),
    2
  );
  assert.equal(
    sourceDb.prepare("SELECT COUNT(*) FROM password_reset_tokens WHERE token = 'token-secreto-producao'").pluck().get(),
    1
  );
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM students').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM school_classes').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM schools').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM institutional_memberships').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 39);
  assert.equal(sourceDb.prepare("SELECT request_fingerprint FROM institutional_write_operations WHERE operation_type = 'create_professional'").pluck().get(), 'b'.repeat(64));
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM class_assessment_assignments').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM pedagogical_feedback_versions').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM class_assessment_access_credentials').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM learning_recovery_plans').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM learning_recovery_student_group_members').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM teaching_plans').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM teaching_plan_lessons').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM typed_question_items').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM typed_question_item_versions').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM typed_question_review_cycles').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM numeric_question_review_snapshots').pluck().get(), 1);
  assert.equal(sourceDb.prepare('SELECT COUNT(*) FROM typed_question_write_operations').pluck().get(), 1);
  assert.equal(
    sourceDb.prepare('SELECT COUNT(*) FROM class_assessment_typed_item_snapshots').pluck().get(),
    1,
  );
  const sourceTypedRevision = sourceDb.prepare('SELECT revision FROM typed_question_item_versions').pluck().get();
  sourceDb.close();

  const outputDb = new Database(outputPath, { readonly: true });
  assert.equal(outputDb.prepare('SELECT MAX(version) FROM schema_migrations').pluck().get(), 43);
  assert.equal(outputDb.prepare('SELECT COUNT(*) FROM institutional_write_operations').pluck().get(), 0);
  assert.equal(outputDb.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='numeric_review_snapshot_no_delete'").pluck().get(), 1);
  for (const table of ['content_issues', 'content_issue_events', 'content_issue_operations']) assert.equal(outputDb.prepare('SELECT COUNT(*) FROM ' + table).pluck().get(), 0);
  assert.equal(outputDb.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='content_issue_events_no_delete'").pluck().get(), 1);
  assert.equal(outputDb.prepare('SELECT COUNT(*) FROM material_bncc_reviews').pluck().get(), 0);
  assert.equal(outputDb.prepare('SELECT COUNT(*) FROM material_bncc_operations').pluck().get(), 0);
  assert.deepEqual(outputDb.prepare('SELECT needs_review,review_id FROM material_bncc_review_state').all(), [{ needs_review: 1, review_id: null }]);
  assert.equal(outputDb.prepare('SELECT COUNT(*) FROM material_bncc_skills').pluck().get(), 1);
  assert.equal(outputDb.prepare("SELECT COUNT(*) FROM sqlite_master WHERE type='trigger' AND name='material_bncc_reviews_no_delete'").pluck().get(), 1);
  assert.deepEqual(outputDb.pragma('foreign_key_check'), []);
  assert.equal(outputDb.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(
    outputDb.prepare("SELECT COUNT(*) FROM users WHERE email NOT LIKE '%@homologacao.invalid'").pluck().get(),
    0
  );
  for (const tableName of [
    'numeric_question_review_snapshots',
    'pedagogical_feedback_versions',
    'typed_question_write_operations',
    'typed_question_review_cycles',
    'institutional_audit_log',
    'school_class_institution_contexts',
    'institutional_memberships',
    'learning_recovery_monitoring_cycles',
    'teaching_plan_lesson_resources',
    'teaching_plan_lesson_skills',
    'teaching_plan_lessons',
    'teaching_plans',
    'learning_recovery_student_group_members',
    'learning_recovery_student_groups',
    'learning_recovery_plan_skills',
    'learning_recovery_plans',
    'ai_usage_events', 'ai_budget_months', 'ai_authoring_question_links', 'ai_authoring_events', 'ai_authoring_requests',
    'password_reset_tokens',
    'material_management_operations',
    'revoked_auth_tokens',
    'material_file_retirements',
    'support_messages',
    'support_threads',
    'notifications',
    'activity_log',
    'governance_audit_log',
    'class_assessment_access_credentials',
    'class_assessment_item_options',
    'class_assessment_participants',
    'class_assessment_typed_item_snapshots',
    'class_assessment_items',
    'class_assessment_assignments',
    'school_class_entry_code_redemptions',
    'school_class_entry_codes',
    'school_class_enrollments',
    'school_class_disciplines',
    'students',
    'school_classes',
    'schools',
    'municipalities',
  ]) {
    assert.equal(outputDb.prepare(`SELECT COUNT(*) FROM ${tableName}`).pluck().get(), 0);
  }
  assert.equal(
    outputDb.prepare('SELECT COUNT(*) FROM feature_flags WHERE kill_switch_active = 1').pluck().get(),
    outputDb.prepare('SELECT COUNT(*) FROM feature_flags').pluck().get()
  );
  assert.equal(outputDb.prepare('SELECT COUNT(*) FROM pilot_groups WHERE active = 1').pluck().get(), 0);
  const sanitizedTypedVersion = outputDb.prepare(`
    SELECT public_id, revision, definition_json, definition_hash
    FROM typed_question_item_versions
  `).get();
  assert.match(sanitizedTypedVersion.definition_json, /EMAIL_REMOVIDO/);
  assert.match(sanitizedTypedVersion.definition_json, /TELEFONE_REMOVIDO/);
  assert.match(sanitizedTypedVersion.definition_json, /CPF_REMOVIDO/);
  assert.equal(sanitizedTypedVersion.public_id, '12345678-1234-4234-8234-123456789012');
  assert.equal(outputDb.prepare('SELECT public_id FROM typed_question_items').pluck().get(), '12345678-1234-4234-8234-123456789013');
  assert.equal(sanitizedTypedVersion.revision, sourceTypedRevision + 1);
  assert.equal(sanitizedTypedVersion.definition_json.includes(sanitizedTypedVersion.public_id), false, 'a exceção não vale para o UUID dentro de texto livre');
  for (const trigger of ['typed_question_items_identity_is_immutable', 'typed_question_versions_identity_is_immutable', 'typed_question_versions_revision_must_increment']) {
    assert.ok(outputDb.prepare("SELECT 1 FROM sqlite_master WHERE type='trigger' AND name=?").get(trigger));
  }
  assert.equal(
    crypto.createHash('sha256').update(sanitizedTypedVersion.definition_json).digest('hex'),
    sanitizedTypedVersion.definition_hash,
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'institutional_audit_log_prevent_update',
          'institutional_audit_log_prevent_delete',
          'school_class_contexts_prevent_delete'
        )
    `).pluck().get(),
    3
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'school_class_entry_code_redemptions_prevent_update',
          'school_class_entry_code_redemptions_prevent_delete'
        )
    `).pluck().get(),
    2
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'class_assessment_items_prevent_delete',
          'class_assessment_options_prevent_delete',
          'class_assessment_participants_prevent_delete',
          'class_assessment_responses_validate_delete',
          'typed_question_snapshot_prevent_delete'
        )
    `).pluck().get(),
    5
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'typed_question_versions_published_content_is_immutable',
          'typed_question_reviews_prevent_delete',
          'typed_question_operations_prevent_update',
          'typed_question_operations_prevent_delete'
        )
    `).pluck().get(),
    4,
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'assessment_access_prevent_delete'
    `).pluck().get(),
    1
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name = 'diagnostic_reviews_prevent_delete'
    `).pluck().get(),
    1
  );
  assert.equal(
    outputDb.prepare(`
      SELECT COUNT(*)
      FROM sqlite_master
      WHERE type = 'trigger'
        AND name IN (
          'learning_recovery_plans_prevent_delete',
          'learning_recovery_content_requires_draft_skill_delete',
          'learning_recovery_group_requires_draft_delete',
          'learning_recovery_group_member_requires_draft_delete',
          'teaching_plans_prevent_delete',
          'teaching_plan_lessons_prevent_delete',
          'teaching_plan_lesson_skills_validate_delete',
          'teaching_plan_resources_validate_delete',
          'recovery_monitoring_cycle_prevent_delete',
          'teaching_plan_operations_prevent_update',
          'teaching_plan_operations_prevent_delete'
        )
    `).pluck().get(),
    11
  );
  assert.match(
    outputDb.prepare(`
      SELECT payload_json FROM announcements
      WHERE announcement_key = 'author_questions_and_support_launch_2026_08'
    `).pluck().get(),
    /EMAIL_REMOVIDO/
  );

  const adminHash = outputDb.prepare('SELECT password FROM users WHERE email = ?')
    .pluck().get('smoke.admin@homologacao.invalid');
  const professorHash = outputDb.prepare('SELECT password FROM users WHERE email = ?')
    .pluck().get('smoke.professor@homologacao.invalid');
  assert.equal(bcrypt.compareSync(adminPassword, adminHash), true);
  assert.equal(bcrypt.compareSync(professorPassword, professorHash), true);
  outputDb.close();

  const manifest = fs.readFileSync(manifestPath, 'utf8');
  assert.equal(JSON.parse(manifest).sanitizerVersion, '27');
  assert.doesNotMatch(manifest, /admin\.real@escola\.com\.br/);
  assert.doesNotMatch(manifest, new RegExp(sourcePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('sanitização remove recibos de criação ativos e marcas de exclusão', async () => {
  const receiptSource = path.join(tempRoot, 'source-with-receipts.sqlite');
  const receiptCopy = path.join(tempRoot, 'homologation-without-receipts.sqlite');
  const setup = runDatabaseProcess({ databasePath: receiptSource });
  assert.equal(setup.status, 0, setup.stderr || setup.stdout);
  const source = new Database(receiptSource);
  try {
    const userId = source.prepare("INSERT INTO users(name,email,password,role) VALUES('Conta sintética','receipt@example.invalid','hash','professor')").run().lastInsertRowid;
    const setId = source.prepare("INSERT INTO question_sets(user_id,title) VALUES(?, 'Simulado sintético')").run(userId).lastInsertRowid;
    const receipt = source.prepare('INSERT INTO question_set_creation_receipts VALUES(?, ?, ?, ?)');
    receipt.run(userId, 'a'.repeat(64), 'b'.repeat(64), setId);
    receipt.run(userId, 'c'.repeat(64), 'd'.repeat(64), null);
    source.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    source.close();
  }
  const original = fileHash(receiptSource);
  await createSanitizedDatabase(sanitizerOptions({
    sourcePath: receiptSource, outputPath: receiptCopy, manifestPath: `${receiptCopy}.manifest.json`,
  }));
  assert.equal(fileHash(receiptSource), original);
  const copy = new Database(receiptCopy, { readonly: true });
  try {
    assert.equal(copy.prepare('SELECT COUNT(*) FROM question_set_creation_receipts').pluck().get(), 0);
    assert.deepEqual(inspectHomologationDatabase(copy), {
      schemaVersion: 43, sanitizerVersion: 27, sourceSchemaVersion: 43, sanitizerCompatibility: 'current',
    });
  } finally {
    copy.close();
  }
});

test('inicialização da homologação aceita somente a cópia marcada', () => {
  const sanitizedResult = runDatabaseProcess({
    databasePath: outputPath,
    appEnvironment: 'homologation',
  });
  assert.equal(sanitizedResult.status, 0, sanitizedResult.stderr || sanitizedResult.stdout);

  // A primeira inicialização muda o banco para WAL. O snapshot marcado deve
  // continuar aceito depois de um restart real do processo.
  const restartedResult = runDatabaseProcess({
    databasePath: outputPath,
    appEnvironment: 'homologation',
  });
  assert.equal(restartedResult.status, 0, restartedResult.stderr || restartedResult.stdout);

  const unsafePath = path.join(tempRoot, 'homologation-unsanitized.sqlite');
  fs.copyFileSync(sourcePath, unsafePath);
  const unsafeHashBefore = fileHash(unsafePath);
  const unsafeResult = runDatabaseProcess({
    databasePath: unsafePath,
    appEnvironment: 'homologation',
  });

  assert.notEqual(unsafeResult.status, 0);
  assert.match(
    `${unsafeResult.stderr}\n${unsafeResult.stdout}`,
    /não possui marca válida de sanitização|journal SQLite inválida/i
  );
  assert.equal(fileHash(unsafePath), unsafeHashBefore);
  assert.equal(fs.existsSync(`${unsafePath}-wal`), false);
  assert.equal(fs.existsSync(`${unsafePath}-shm`), false);
});

test('homologação recusa iniciar sem segredo para os acessos de avaliação', () => {
  const result = runDatabaseProcess({
    databasePath: outputPath,
    appEnvironment: 'homologation',
    studentAccessSecret: '',
  });

  assert.notEqual(result.status, 0);
  assert.match(
    `${result.stderr}\n${result.stdout}`,
    /STUDENT_ASSESSMENT_ACCESS_SECRET ou CLASS_ENTRY_CODE_SECRET/i,
  );
});

test('recusa esquema futuro sem política explícita de sanitização', async () => {
  const sourceDb = new Database(sourcePath);
  sourceDb.exec('CREATE TABLE future_sensitive_data (id INTEGER PRIMARY KEY, secret TEXT NOT NULL)');
  sourceDb.prepare("INSERT INTO future_sensitive_data (secret) VALUES ('novo dado pessoal')").run();
  sourceDb.close();

  const futureOutput = path.join(tempRoot, 'homologation-future.sqlite');
  await assert.rejects(
    createSanitizedDatabase(sanitizerOptions({
      outputPath: futureOutput,
      manifestPath: `${futureOutput}.manifest.json`,
    })),
    /tabelas sem política definida: future_sensitive_data/i
  );
  assert.equal(fs.existsSync(futureOutput), false);
});

test('recusa confirmação ausente e destino fora da área de homologação', async () => {
  await assert.rejects(
    createSanitizedDatabase(sanitizerOptions({ confirmation: undefined })),
    /confirmação explícita/i
  );
  await assert.rejects(
    createSanitizedDatabase(sanitizerOptions({
      outputPath: path.join(os.tmpdir(), 'unsafe-copy.sqlite'),
    })),
    /destino deve conter homolog ou staging/i
  );
});
