const { evaluateFeatureFlag } = require('./featureFlags');
const { authorizeSchoolAggregate } = require('./institutionalAccess');
const { logActivityStrict } = require('../helpers/activity');
const { scoredResponses } = require('./numericAssessments');
const { buildMatchedRecoveryComparison } = require('./learningRecoveryComparison');

const FLAGS = ['institutions.school_coordination', 'institutions.read_model', 'classes.core',
  'classes.assessment_assignments', 'classes.assessment_results'];
const MIN_GROUP = 5;
const LIMIT = 20;
const SUPPORT_FLAGS = ['classes.learning_recovery', 'planning.lesson_planner'];
const searchDatabases = new WeakSet();
const normalizeSearch = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
function classSearch(db, value) {
  if (value !== undefined && (typeof value !== 'string' || value.length > 100))
    fail(400, 'invalid_search', 'Use até 100 caracteres na busca de turmas.');
  if (!searchDatabases.has(db)) {
    db.function('coordination_search_text', { deterministic: true }, normalizeSearch);
    searchDatabases.add(db);
  }
  return normalizeSearch((value || '').trim());
}
function fail(status, code, message) { throw Object.assign(new Error(message), { status, code }); }
function principal(db, actor) {
  const user = db.prepare('SELECT id,name,role FROM users WHERE id=?').get(actor?.id || 0);
  if (!user || !['admin', 'professor'].includes(user.role)) fail(403, 'access_denied', 'Acesso não disponível nesta conta.');
  if (!FLAGS.every(key => evaluateFeatureFlag(db, key, user).enabled))
    fail(404, 'feature_disabled', 'O acompanhamento da escola não está liberado nesta conta.');
  return user;
}
function supportPrincipal(db, actor) {
  const user = principal(db, actor);
  if (!SUPPORT_FLAGS.every(key => evaluateFeatureFlag(db, key, user).enabled))
    fail(404, 'feature_disabled', 'O acompanhamento dos planos não está liberado nesta conta.');
  return user;
}
function queryValues(query, allowed) {
  if (Object.keys(query).some(key => !allowed.includes(key))) fail(400, 'invalid_query', 'Confira os filtros da consulta.');
  const page = query.page === undefined ? 1 : query.page;
  if (!/^[1-9]\d{0,3}$/.test(String(page)) || !['string', 'number'].includes(typeof page))
    fail(400, 'invalid_page', 'Informe uma página válida.');
  return Number(page);
}
function audit(db, user, action, metadata, req) {
  logActivityStrict({ user, action, module: 'classes', entityType: 'school',
    description: 'Consulta pedagógica escolar autorizada.', metadata, req }, db);
}
const schoolFields = 's.public_id AS id,s.name,m.name AS municipality';
function authorizedSchool(db, user, publicId) {
  const school = db.prepare(`SELECT s.id AS internal_id,s.municipality_id,${schoolFields}
    FROM schools s JOIN municipalities m ON m.id=s.municipality_id WHERE s.public_id=?`).get(String(publicId));
  if (!school || !authorizeSchoolAggregate(db, user.id, school.municipality_id, school.internal_id).allowed)
    fail(404, 'school_unavailable', 'Escola indisponível para esta conta. Peça à administração para conferir seu vínculo.');
  return school;
}
// List and detail must use exactly the same verified, currently authorized teaching context.
const eligibleClasses = `FROM school_classes c JOIN school_class_institution_contexts context
  ON context.class_id=c.id AND context.owner_teacher_id=c.owner_teacher_id
  JOIN users teacher ON teacher.id=c.owner_teacher_id AND teacher.role='professor'
  JOIN grades g ON g.id=c.grade_id
  WHERE context.school_id=? AND context.municipality_id=? AND context.migration_status='verified'
    AND c.status='active'
    AND EXISTS (SELECT 1 FROM institutional_memberships member WHERE member.user_id=c.owner_teacher_id
      AND member.role='teacher' AND member.status='active' AND member.school_id=context.school_id
      AND member.municipality_id=context.municipality_id)`;
// An ordinary teacher membership never grants access to a school's teaching results.
const scope = `s.status='active' AND m.status='active' AND (?='admin' OR EXISTS (
  SELECT 1 FROM institutional_memberships member WHERE member.user_id=? AND member.status='active'
    AND member.municipality_id=s.municipality_id AND (
      (member.role='municipal_manager' AND member.school_id IS NULL) OR
      (member.role IN ('school_manager','school_coordinator') AND member.school_id=s.id))))`;
function listSchools(db, actor, query = {}, req) {
  return db.transaction(() => {
    const user = principal(db, actor), page = queryValues(query, ['page', 'search']);
    if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 100))
      fail(400, 'invalid_search', 'Use até 100 caracteres na busca.');
    const search = (query.search || '').trim();
    const from = `FROM schools s JOIN municipalities m ON m.id=s.municipality_id WHERE ${scope}
      AND (?='' OR instr(lower(s.name || ' ' || m.name),lower(?))>0)`;
    const args = [user.role, user.id, search, search];
    const total = db.prepare(`SELECT COUNT(*) ${from}`).pluck().get(...args);
    const items = db.prepare(`SELECT ${schoolFields} ${from} ORDER BY m.name,s.name,s.id LIMIT ? OFFSET ?`)
      .all(...args, LIMIT, (page - 1) * LIMIT);
    audit(db, user, 'school_coordination_schools_read', { page, returned: items.length }, req);
    return { items, page, limit: LIMIT, total };
  })();
}

function schoolClasses(db, actor, schoolPublicId, query = {}, req) {
  return db.transaction(() => {
    const user = principal(db, actor), page = queryValues(query, ['page', 'year', 'search']);
    if (query.year !== undefined && (typeof query.year !== 'string' || !/^(20\d\d|2100)$/.test(query.year)))
      fail(400, 'invalid_year', 'Informe um ano letivo entre 2000 e 2100.');
    const school = authorizedSchool(db, user, schoolPublicId);
    const search = classSearch(db, query.search);
    const from = `${eligibleClasses} AND (? IS NULL OR c.academic_year=?)
      AND (?='' OR instr(coordination_search_text(c.name || ' ' || g.name),?)>0)`;
    const year = query.year === undefined ? null : Number(query.year);
    const args = [school.internal_id, school.municipality_id, year, year, search, search];
    const total = db.prepare(`SELECT COUNT(*) ${from}`).pluck().get(...args);
    const rows = db.prepare(`SELECT c.id AS internal_id,c.public_id AS id,c.name,c.academic_year AS academicYear,
      g.name AS gradeName,
      (SELECT COUNT(*) FROM class_assessment_assignments a WHERE a.class_id=c.id AND a.owner_teacher_id=c.owner_teacher_id AND a.status='open') AS openCount,
      (SELECT COUNT(*) FROM class_assessment_assignments a WHERE a.class_id=c.id AND a.owner_teacher_id=c.owner_teacher_id AND a.status='closed') AS closedCount,
      (SELECT a.id FROM class_assessment_assignments a WHERE a.class_id=c.id AND a.owner_teacher_id=c.owner_teacher_id AND a.status='closed'
        ORDER BY julianday(a.closed_at) DESC,a.id DESC LIMIT 1) AS latest_id
      ${from} ORDER BY c.academic_year DESC,c.name,c.id LIMIT ? OFFSET ?`).all(...args, LIMIT, (page - 1) * LIMIT);
    const ids = rows.map(row => row.latest_id).filter(Boolean);
    // Only the current page's latest closed applications are aggregated. No names, answers, or free text are loaded.
    const results = ids.length ? db.prepare(`SELECT a.id,a.closed_at,a.question_count,
      COUNT(attempt.id) AS corrected,AVG(attempt.score_percentage) AS mean
      FROM class_assessment_assignments a
      LEFT JOIN class_assessment_participants participant ON participant.assignment_id=a.id AND participant.status<>'exempted'
      LEFT JOIN class_assessment_attempts attempt ON attempt.participant_id=participant.id AND attempt.status='submitted'
      WHERE a.id IN (${ids.map(() => '?').join(',')}) GROUP BY a.id`).all(...ids) : [];
    const byId = new Map(results.map(row => [row.id, row]));
    const items = rows.map(({ internal_id, latest_id, ...row }) => {
      const result = byId.get(latest_id);
      return { ...row, result: !result ? null : {
        closedAt: result.closed_at, questionCount: result.question_count,
        ...(result.corrected < MIN_GROUP ? { status: 'protected' }
          : { status: 'available', correctedCount: result.corrected, meanPercentage: Number(result.mean.toFixed(2)) }),
      } };
    });
    audit(db, user, 'school_coordination_classes_read', { schoolId: school.id, year, page, returned: items.length }, req);
    return { school: { id: school.id, name: school.name, municipality: school.municipality }, items,
      page, limit: LIMIT, total, year, minimumGroup: MIN_GROUP };
  })();
}
function authorizedClass(db, school, classPublicId) {
  const row = db.prepare(`SELECT c.id AS internal_id,c.owner_teacher_id,c.public_id AS id,c.name,
    c.academic_year AS academicYear,g.name AS gradeName ${eligibleClasses} AND c.public_id=?`)
    .get(school.internal_id, school.municipality_id, String(classPublicId));
  if (!row) fail(404, 'class_unavailable', 'Turma indisponível nesta escola. Confira o vínculo e a confirmação da turma.');
  return row;
}
function classSkills(db, actor, schoolPublicId, classPublicId, query = {}, req) {
  return db.transaction(() => {
    const user = principal(db, actor);
    queryValues(query, []);
    const school = authorizedSchool(db, user, schoolPublicId);
    const row = authorizedClass(db, school, classPublicId);
    const assignment = db.prepare(`SELECT id,closed_at,question_count FROM class_assessment_assignments
      WHERE class_id=? AND owner_teacher_id=? AND status='closed'
      ORDER BY julianday(closed_at) DESC,id DESC LIMIT 1`).get(row.internal_id, row.owner_teacher_id);
    let result = null;
    if (assignment) {
      const group = db.prepare(`SELECT COUNT(a.id) AS corrected,AVG(a.score_percentage) AS mean
        FROM class_assessment_attempts a JOIN class_assessment_participants p ON p.id=a.participant_id
        WHERE a.assignment_id=? AND a.status='submitted' AND p.status<>'exempted'`).get(assignment.id);
      result = { closedAt: assignment.closed_at, questionCount: assignment.question_count, status: 'protected' };
      // Do not even load skill snapshots for a small group. No student-level content is selected.
      if (group.corrected >= MIN_GROUP) {
        const skills = db.prepare(`WITH scoped_responses AS (
          SELECT attempt_id,assessment_item_id,is_correct FROM ${scoredResponses(db)} WHERE assignment_id=?
        ), item_totals AS (
          SELECT item.id,NULLIF(trim(item.skill_code_snapshot),'') AS code,NULLIF(trim(item.skill_description_snapshot),'') AS description,
            COUNT(response.attempt_id) AS responses,
            COUNT(DISTINCT response.attempt_id) AS contributors,
            COALESCE(SUM(response.is_correct),0) AS correct
          FROM class_assessment_items item
          LEFT JOIN scoped_responses response ON response.assessment_item_id=item.id AND EXISTS (
              SELECT 1 FROM class_assessment_attempts a JOIN class_assessment_participants p ON p.id=a.participant_id
              WHERE a.id=response.attempt_id AND a.assignment_id=item.assignment_id
                AND a.status='submitted' AND p.status<>'exempted')
          WHERE item.assignment_id=? GROUP BY item.id
        ) SELECT code,MIN(description) AS description,COUNT(*) AS questionCount,SUM(correct) AS correct,
          MIN(contributors) AS minimumContributors,MIN(responses) AS minimumResponses,MAX(responses) AS maximumResponses
          FROM item_totals GROUP BY code`).all(assignment.id, assignment.id).map(skill => {
          const complete = skill.minimumContributors === group.corrected
            && skill.minimumResponses === group.corrected && skill.maximumResponses === group.corrected;
          return { code: skill.code, description: skill.code ? skill.description : null, questionCount: skill.questionCount,
            ...(complete ? { status: 'available', successRate: Number((100 * skill.correct / (group.corrected * skill.questionCount)).toFixed(2)) }
              : { status: 'unavailable' }) };
        }).sort((a, b) => Number(a.code === null) - Number(b.code === null)
          || (a.successRate ?? Infinity) - (b.successRate ?? Infinity) || String(a.code || '').localeCompare(String(b.code || '')));
        result = { ...result, status: 'available', correctedCount: group.corrected,
          meanPercentage: Number(group.mean.toFixed(2)), skills };
      }
    }
    audit(db, user, 'school_coordination_skills_read', { schoolId: school.id, classId: row.id,
      resultStatus: result?.status || 'empty' }, req);
    return { school: { id: school.id, name: school.name, municipality: school.municipality },
      class: { id: row.id, name: row.name, academicYear: row.academicYear, gradeName: row.gradeName },
      minimumGroup: MIN_GROUP, result };
  })();
}
function classSupport(db, actor, schoolPublicId, classPublicId, query = {}, req) {
  return db.transaction(() => {
    const user = supportPrincipal(db, actor), page = queryValues(query, ['page']);
    const school = authorizedSchool(db, user, schoolPublicId);
    const row = authorizedClass(db, school, classPublicId);
    const from = `FROM learning_recovery_plans r
      JOIN class_assessment_assignments source ON source.id=r.source_assignment_id
        AND source.class_id=r.class_id AND source.owner_teacher_id=r.owner_teacher_id AND source.status='closed'
      WHERE r.class_id=? AND r.owner_teacher_id=? AND r.status IN ('active','completed')`;
    const args = [row.internal_id, row.owner_teacher_id];
    const total = db.prepare(`SELECT COUNT(*) ${from}`).pluck().get(...args);
    // Select only authorized progress, never titles, notes, resources, student groups or answers.
    const plans = db.prepare(`SELECT r.id AS internal_id,r.public_id AS id,r.status,r.activated_at AS activatedAt,
      source.closed_at AS sourceClosedAt ${from}
      ORDER BY CASE r.status WHEN 'active' THEN 0 ELSE 1 END,julianday(r.activated_at) DESC,r.id DESC
      LIMIT ? OFFSET ?`).all(...args, LIMIT, (page - 1) * LIMIT);
    const executionQuery = db.prepare(`SELECT p.id,p.status,
      COUNT(CASE WHEN l.lesson_phase='intervention' THEN 1 END) AS total,
      COUNT(CASE WHEN l.lesson_phase='intervention' AND l.status='taught' THEN 1 END) AS taught,
      COUNT(CASE WHEN l.lesson_phase='intervention' AND l.status='skipped' THEN 1 END) AS skipped,
      COUNT(CASE WHEN l.lesson_phase='intervention' AND l.status='planned' THEN 1 END) AS planned
      FROM teaching_plans p LEFT JOIN teaching_plan_lessons l ON l.plan_id=p.id AND l.owner_teacher_id=p.owner_teacher_id
      WHERE p.source_recovery_plan_id=? AND p.owner_teacher_id=? AND p.class_id=? AND p.status IN ('active','completed','archived')
      GROUP BY p.id`);
    const monitoringQuery = db.prepare(`SELECT a.status,a.closed_at AS closedAt,
      CASE WHEN a.status='closed' THEN (
        SELECT COUNT(*) FROM class_assessment_attempts attempt
        JOIN class_assessment_participants participant ON participant.id=attempt.participant_id
          AND participant.assignment_id=attempt.assignment_id AND participant.status<>'exempted'
        WHERE attempt.assignment_id=a.id AND attempt.status='submitted'
      ) >= ? ELSE NULL END AS sufficient
      FROM learning_recovery_monitoring_cycles cycle
      LEFT JOIN class_assessment_assignments a ON a.id=cycle.assignment_id
        AND a.class_id=cycle.class_id AND a.owner_teacher_id=cycle.owner_teacher_id
      WHERE cycle.recovery_plan_id=? AND cycle.execution_plan_id=? AND cycle.owner_teacher_id=? AND cycle.class_id=?`);
    const items = plans.map(({ internal_id, ...plan }) => {
      const execution = executionQuery.get(internal_id, row.owner_teacher_id, row.internal_id);
      if (!execution) return { ...plan, execution: null, verification: { status: 'not_created', closedAt: null, results: null } };
      const monitoring = monitoringQuery.get(MIN_GROUP, internal_id, execution.id, row.owner_teacher_id, row.internal_id);
      const { id, ...progress } = execution;
      return { ...plan, execution: progress, verification: {
        status: monitoring?.status || 'not_created', closedAt: monitoring?.closedAt || null,
        results: monitoring?.status === 'closed' ? (monitoring.sufficient ? 'available' : 'protected') : null,
      } };
    });
    audit(db, user, 'school_coordination_support_read', { schoolId: school.id, classId: row.id, page, returned: items.length }, req);
    return { school: { id: school.id, name: school.name, municipality: school.municipality },
      class: { id: row.id, name: row.name, academicYear: row.academicYear, gradeName: row.gradeName },
      items, page, limit: LIMIT, total, minimumGroup: MIN_GROUP };
  })();
}
function supportComparison(db, actor, schoolPublicId, classPublicId, planPublicId, query = {}, req) {
  return db.transaction(() => {
    const user = supportPrincipal(db, actor);
    queryValues(query, []);
    const school = authorizedSchool(db, user, schoolPublicId);
    const row = authorizedClass(db, school, classPublicId);
    const plan = db.prepare(`SELECT r.id AS internal_id,r.public_id AS id,r.status,r.activated_at AS activatedAt,
      source.id AS source_id,source.closed_at AS sourceClosedAt,
      verification.id AS verification_id,verification.status AS verification_status,verification.closed_at AS verificationClosedAt
      FROM learning_recovery_plans r
      JOIN class_assessment_assignments source ON source.id=r.source_assignment_id
        AND source.class_id=r.class_id AND source.owner_teacher_id=r.owner_teacher_id AND source.status='closed'
      LEFT JOIN teaching_plans execution ON execution.source_recovery_plan_id=r.id
        AND execution.owner_teacher_id=r.owner_teacher_id AND execution.class_id=r.class_id
        AND execution.status IN ('active','completed','archived')
      LEFT JOIN learning_recovery_monitoring_cycles cycle ON cycle.recovery_plan_id=r.id
        AND cycle.execution_plan_id=execution.id AND cycle.owner_teacher_id=r.owner_teacher_id AND cycle.class_id=r.class_id
      LEFT JOIN class_assessment_assignments verification ON verification.id=cycle.assignment_id
        AND verification.class_id=r.class_id AND verification.owner_teacher_id=r.owner_teacher_id
      WHERE r.public_id=? AND r.class_id=? AND r.owner_teacher_id=? AND r.status IN ('active','completed')`)
      .get(String(planPublicId), row.internal_id, row.owner_teacher_id);
    if (!plan) fail(404, 'plan_unavailable', 'Plano indisponível nesta turma. Atualize o acompanhamento.');
    let comparison = { status: 'awaiting_verification', sourceClosedAt: plan.sourceClosedAt, verificationClosedAt: null };
    if (plan.verification_status === 'closed') {
      comparison = { status: 'protected', sourceClosedAt: plan.sourceClosedAt, verificationClosedAt: plan.verificationClosedAt };
      const count = db.prepare(`SELECT COUNT(*) FROM class_assessment_attempts a
        JOIN class_assessment_participants p ON p.id=a.participant_id AND p.assignment_id=a.assignment_id
        WHERE a.assignment_id=? AND a.class_id=? AND a.owner_teacher_id=? AND a.status='submitted' AND p.status<>'exempted'`).pluck();
      // Avoid loading skill snapshots or student-level pairing for a small source group.
      if (count.get(plan.source_id, row.internal_id, row.owner_teacher_id) >= MIN_GROUP
        && count.get(plan.verification_id, row.internal_id, row.owner_teacher_id) >= MIN_GROUP) {
        const baselineSkills = db.prepare(`SELECT skill_code_snapshot,skill_description_snapshot
          FROM learning_recovery_plan_skills WHERE plan_id=? AND owner_teacher_id=? AND class_id=? ORDER BY priority`)
          .all(plan.internal_id, row.owner_teacher_id, row.internal_id);
        const matched = buildMatchedRecoveryComparison(db, { teacherId: row.owner_teacher_id,
          classId: row.internal_id, sourceAssignmentId: plan.source_id, monitoringAssignmentId: plan.verification_id, baselineSkills });
        // Explicit projection: never serialize cohort exclusions, historical scores or private group information.
        const skills = matched.skills.filter(skill => skill.cohort.status === 'matched' && skill.cohort.studentCount >= MIN_GROUP)
          .map(skill => ({ code: skill.code, description: skill.description, studentCount: skill.cohort.studentCount,
            diagnostic: { questionCount: skill.diagnosticQuestionCount, opportunities: skill.diagnosticOpportunities, successRate: skill.diagnosticRate },
            verification: { questionCount: skill.monitoringQuestionCount, opportunities: skill.monitoringOpportunities, successRate: skill.monitoringRate },
            difference: skill.delta }));
        if (skills.length) comparison = { ...comparison, status: 'available', methodology: matched.methodology,
          hasProtectedSkills: skills.length !== matched.skills.length, skills };
      }
    }
    audit(db, user, 'school_coordination_comparison_read', { schoolId: school.id, classId: row.id,
      planId: plan.id, resultStatus: comparison.status }, req);
    return { school: { id: school.id, name: school.name, municipality: school.municipality },
      class: { id: row.id, name: row.name, academicYear: row.academicYear, gradeName: row.gradeName },
      plan: { id: plan.id, status: plan.status, activatedAt: plan.activatedAt }, minimumGroup: MIN_GROUP, comparison };
  })();
}
module.exports = { listSchools, schoolClasses, classSkills, classSupport, supportComparison, FLAGS, SUPPORT_FLAGS, MIN_GROUP };
