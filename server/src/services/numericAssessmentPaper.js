const { createHash } = require('node:crypto');
const { evaluateFeatureFlag } = require('./featureFlags');
const { fail } = require('./numericQuestionDrafts');

function readPaper(db, { actor, classPublicId, assessmentPublicId }) {
  const principal = db.prepare('SELECT id, role, email FROM users WHERE id=?').get(actor?.id ?? -1);
  if (!principal || principal.role !== 'professor') fail(403, 'professor_required', 'Esta cópia é reservada ao professor da turma.');
  for (const flag of ['classes.core', 'classes.assessment_assignments', 'classes.numeric_assessments']) {
    if (!evaluateFeatureFlag(db, flag, principal).enabled) fail(404, 'numeric_paper_unavailable', 'A impressão numérica não está disponível para esta conta.');
  }
  const assignment = db.prepare(`SELECT a.*, c.name AS class_name, c.public_id AS class_public_id
    FROM class_assessment_assignments a JOIN school_classes c ON c.id=a.class_id
    JOIN class_assessment_numeric_origins n ON n.assignment_id=a.id AND n.owner_teacher_id=a.owner_teacher_id
    WHERE a.public_id=? AND c.public_id=? AND a.owner_teacher_id=? AND c.owner_teacher_id=?`)
    .get(assessmentPublicId, classPublicId, principal.id, principal.id);
  if (!assignment) fail(404, 'numeric_paper_not_found', 'Atividade numérica não encontrada nesta turma.');
  if (assignment.status === 'cancelled') fail(409, 'cancelled_numeric_paper', 'Esta atividade foi cancelada. Escolha outra aplicação.');
  // Read only the frozen application, never the editable question bank or student attempts.
  const rows = db.prepare(`SELECT i.*, s.definition_json, s.interaction_type, s.scoring_strategy
    FROM class_assessment_items i LEFT JOIN class_assessment_typed_item_snapshots s ON s.assessment_item_id=i.id
    WHERE i.assignment_id=? ORDER BY i.sort_order, i.id`).all(assignment.id);
  if (rows.length !== assignment.question_count || rows.length < 1 || rows.length > 100) {
    fail(409, 'incomplete_numeric_paper', 'Não foi possível conferir todas as questões. Atualize a atividade.');
  }
  const items = rows.map((row, index) => {
    const definition = JSON.parse(row.definition_json || 'null');
    if (row.interaction_type !== 'numeric' || row.scoring_strategy !== 'numeric_exact'
      || definition?.interactionType !== 'numeric' || definition.scoring?.strategy !== 'numeric_exact'
      || !Number.isFinite(definition.answerKey?.value) || !row.statement_snapshot) {
      fail(409, 'incomplete_numeric_paper', 'Uma questão não está pronta para impressão. Atualize a atividade.');
    }
    return { number: index + 1, code: row.question_code_snapshot, skillCode: row.skill_code_snapshot || '',
      statement: row.statement_snapshot, supportText: row.support_text_snapshot || '', unit: definition.content.unit || '',
      answer: String(definition.answerKey.value).replace('.', ','), explanation: row.explanation_snapshot || '' };
  });
  const paper = { kind: 'numeric-assessment-paper-v1', assessment: { id: assignment.public_id, revision: assignment.revision,
    title: assignment.title_snapshot, instructions: assignment.instructions || '', status: assignment.status,
    questionCount: assignment.question_count, randomizeQuestions: assignment.randomize_questions === 1 },
    schoolClass: { id: assignment.class_public_id, name: assignment.class_name }, items };
  return { assignment, principal, paper, fingerprint: createHash('sha256').update(JSON.stringify(paper)).digest('hex') };
}

function projectPaper({ paper, fingerprint }, audience) {
  return { ...paper, fingerprint, audience, items: paper.items.map(item => {
    const { answer, explanation, ...studentItem } = item;
    return audience === 'teacher' ? { ...studentItem, answer, explanation } : studentItem;
  }) };
}

function previewNumericAssessmentPaper(db, input) {
  return db.transaction(() => projectPaper(readPaper(db, input), 'student'))();
}

function prepareNumericAssessmentPaper(db, input, audit) {
  if (!['student', 'teacher'].includes(input.audience) || input.confirmed !== true
    || !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1
    || typeof input.expectedFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(input.expectedFingerprint)) {
    fail(400, 'invalid_numeric_paper', 'Confira a prévia e confirme o cuidado com o gabarito antes de imprimir.');
  }
  return db.transaction(() => {
    const current = readPaper(db, input);
    if (current.assignment.revision !== input.expectedRevision || current.fingerprint !== input.expectedFingerprint) {
      fail(409, 'stale_numeric_paper', 'A atividade mudou. Atualize a prévia e confira novamente antes de imprimir.');
    }
    if (typeof audit !== 'function') throw new Error('numeric_paper_audit_required');
    audit({ user: current.principal, action: 'numeric_assessment_print_prepared', module: 'classes',
      entityType: 'class_assessment', entityId: current.assignment.id,
      description: input.audience === 'student' ? 'Preparou atividade em papel sem gabarito.' : 'Preparou gabarito separado para conferência docente.',
      metadata: { assessmentId: current.assignment.public_id, classId: current.paper.schoolClass.id,
        revision: current.assignment.revision, fingerprint: current.fingerprint, audience: input.audience,
        questionCount: current.paper.items.length } }, db);
    return projectPaper(current, input.audience);
  }).immediate();
}

module.exports = { previewNumericAssessmentPaper, prepareNumericAssessmentPaper };
