import { bankAccessState } from './bankExperiences.mjs';

export function recoveryWorkspaceState(role, { loading, unavailable, isEnabled }) {
  return bankAccessState({
    role, loading, unavailable, enabled: isEnabled('classes.learning_recovery'),
    dependenciesReady: ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results'].every(isEnabled),
  });
}

export const recoveryStatuses = { draft: 'Aguardando revisão', active: 'Em acompanhamento', completed: 'Concluído', archived: 'Arquivado' };
export function recoveryAction(plan) {
  return plan.status === 'draft' ? 'Continuar revisão' : plan.status !== 'active' ? 'Ver histórico'
    : plan.execution ? 'Acompanhar aulas' : 'Organizar aulas';
}
const fail = () => { throw new Error('Resposta de recomposição incompleta.'); };
const obj = v => v && typeof v === 'object' && !Array.isArray(v);
const text = v => typeof v === 'string' && v.length > 0;
const count = v => Number.isSafeInteger(v) && v >= 0;
const publicId = value => typeof value === 'string' && /^[a-z\d_-]{1,80}$/i.test(value);
function identity(plan) {
  if (!obj(plan) || !publicId(plan.id) || !text(plan.title) || !Object.hasOwn(recoveryStatuses, plan.status)
    || !count(plan.revision) || !plan.revision || !publicId(plan.class?.id) || !text(plan.class?.name)
    || !publicId(plan.sourceAssessment?.id) || !text(plan.sourceAssessment?.title)) fail();
}
export function parseRecoveryList(value) {
  if (!obj(value) || !Array.isArray(value.data) || !obj(value.counts)
    || new Set(value.data.map(plan => plan?.id)).size !== value.data.length
    || !['total',...Object.keys(recoveryStatuses)].every(k => count(value.counts[k]))) fail();
  value.data.forEach(plan => {
    identity(plan);
    if (!['priorityCount','plannedQuestionCount','groupCount','studentCount'].every(k => count(plan[k]))) fail();
    if (plan.execution && (!count(plan.execution.total) || !count(plan.execution.handled)
      || !count(plan.execution.percentage) || plan.execution.percentage > 100)) fail();
  });
  return value;
}
export function parseRecoveryPlan(value) {
  identity(value);
  if (!Array.isArray(value.skills) || !Array.isArray(value.groups)) fail();
  // The source skill can be deleted; its historical code/description remain valid snapshots.
  value.skills.forEach(s => { if ((s.skillId !== null && !count(s.skillId)) || !text(s.code) || !text(s.description) || !count(s.suggestedQuestionCount)) fail(); });
  value.groups.forEach(g => { if (!text(g.id) || !text(g.title) || !text(g.objective) || !Array.isArray(g.students)) fail(); g.students.forEach(s => { if (!text(s.id) || !text(s.displayName)) fail(); }); });
  if (value.execution && (!Array.isArray(value.execution.lessons) || !obj(value.execution.progress))) fail();
  return value;
}
export function recoveryReviewFingerprint(review) {
  if (!review) return '';
  return JSON.stringify({ title:review.title, priorities:Object.fromEntries(Object.entries(review.priorities).map(([id,{expanded,...data}])=>[id,data])) });
}
export function parseRecoveryPreview(value) {
  if (!obj(value) || !Array.isArray(value.priorities) || !Array.isArray(value.warnings)
    || typeof value.isActionable !== 'boolean' || !text(value.source?.assessment?.id)
    || !count(value.source.assessment.revision) || !count(value.source?.overview?.submittedCount)
    || !text(value.source.assessment.title) || !text(value.source.resultRevision) || !text(value.methodology?.version)
    || !value.warnings.every(w => typeof w === 'string')) fail();
  value.priorities.forEach(p => {
    if (!count(p.skill?.id) || !text(p.skill?.code) || !text(p.skill?.description) || !obj(p.result?.evidence)
      || !Array.isArray(p.reinforcementQuestions) || !Array.isArray(p.monitoringQuestions) || !Array.isArray(p.materials)) fail();
    if (p.suggestedGroup && (!Array.isArray(p.suggestedGroup.students) || !text(p.suggestedGroup.title) || !text(p.suggestedGroup.objective))) fail();
    if (p.studentCandidates && !Array.isArray(p.studentCandidates)) fail();
    for (const students of [p.suggestedGroup?.students || [], p.studentCandidates || []]) students.forEach(s => { if (!text(s?.id) || !text(s?.displayName)) fail(); });
  });
  return value;
}
export function readRecoveryQuery(params) {
  const ids = params.getAll('plano');
  return {
    search: (params.get('busca') || '').replace(/\s+/g, ' ').trim().slice(0, 80),
    status: Object.hasOwn(recoveryStatuses, params.get('situacao')) ? params.get('situacao') : 'all',
    planId: ids.length === 1 && publicId(ids[0]) ? ids[0] : null,
  };
}
export function recoveryPlanPath(planId) {
  return publicId(planId) ? '/recomposicao?' + new URLSearchParams({ plano: planId }) : null;
}
export function recoveryListPath({search,status}) {
  const params = new URLSearchParams({limit:'100'});
  if(search) params.set('search',search);
  if(status !== 'all') params.set('status',status);
  return '/classes/recovery-plans?' + params;
}
