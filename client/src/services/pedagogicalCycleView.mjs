import { validateRecoveryComparison } from './recoveryComparisonView.mjs';
const fail = () => { throw new Error('Resposta do ciclo incompleta.'); };
const object = value => value && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.length > 0;
const count = value => Number.isSafeInteger(value) && value >= 0;
const rate = value => value === null || (typeof value === 'number' && Number.isFinite(value));
const flag = value => [true, false, 0, 1].includes(value);
const hash = value => /^[a-f0-9]{64}$/.test(value || '');
export const feedbackFields = ['objective', 'observation', 'action', 'verification'];
export function parseCycleClass(value) {
  if (!object(value) || !text(value.id) || !text(value.name) || !text(value.gradeName)
    || !count(value.academicYear) || !text(value.status) || !object(value.institution)
    || !text(value.institution.status)) fail();
  return value;
}
function pagination(value) {
  if (!object(value) || !['page', 'limit', 'total', 'totalPages'].every(key => count(value[key]))
    || !value.page || !value.limit) fail();
}
function assessment(value) {
  if (!object(value) || !text(value.id) || !text(value.title) || !text(value.status)) fail();
}
function comparison(value) {
  if (value == null) return;
  validateRecoveryComparison(value);
}
function evidence(value) {
  if (!object(value) || !object(value.overview) || !count(value.overview.submittedCount)
    || !count(value.overview.participantCount) || !rate(value.overview.meanPercentage) || !Array.isArray(value.skills)) fail();
  value.skills.forEach(s => { if (!text(s.code) || typeof s.description !== 'string' || !rate(s.successRate)) fail(); });
  if (value.verifications != null) {
    if (!Array.isArray(value.verifications)) fail();
    value.verifications.forEach(v => { comparison(v.comparison); if (v.comparison) assessment(v.application); });
  }
}
export function parseFeedback(value) {
  if (!object(value) || !count(value.revision) || !value.revision || !hash(value.evidenceHash)
    || !text(value.createdAt) || !feedbackFields.every(key => typeof value[key] === 'string')) fail();
  evidence(value.evidence);
  return value;
}
export function parseCycleClasses(value) {
  if (!object(value) || !Array.isArray(value.data)) fail();
  value.data.forEach(parseCycleClass); pagination(value.pagination); return value;
}
export function parseCycleOverview(value) {
  if (!object(value) || !Array.isArray(value.assessments)) fail();
  parseCycleClass(value.class); value.assessments.forEach(assessment); pagination(value.pagination); return value;
}
export function parseCycleDetail(value) {
  if (!object(value) || !object(value.capabilities) || !flag(value.capabilities.recovery)
    || !Array.isArray(value.plans) || !flag(value.feedbackStale) || !flag(value.morePlans)
    || !text(value.notice) || (value.canSaveFeedback != null && !flag(value.canSaveFeedback))) fail();
  parseCycleClass(value.class); assessment(value.assessment);
  if (!flag(value.assessment.isDiagnostic)) fail();
  if (value.evidence != null) { evidence(value.evidence); if (!hash(value.evidenceHash)) fail(); }
  if (value.canSaveFeedback && (!value.evidence || !value.evidence.overview.submittedCount)) fail();
  if (value.feedback != null) parseFeedback(value.feedback);
  value.plans.forEach(p => {
    if (!text(p.id) || !text(p.title) || !text(p.status) || !count(p.interventionCount) || !count(p.interventionHandled)) fail();
    if (p.monitoring) {
      if (!text(p.monitoring.state)) fail();
      if (p.monitoring.application) assessment(p.monitoring.application);
      comparison(p.monitoring.comparison);
    }
  });
  return value;
}
export function parseFeedbackHistory(value) {
  if (!object(value) || !Array.isArray(value.data) || (value.nextBefore !== null && (!count(value.nextBefore) || !value.nextBefore))) fail();
  value.data.forEach(parseFeedback);
  if (new Set(value.data.map(r => r.revision)).size !== value.data.length) fail();
  return value;
}
export function confirmedFeedback(value, body) {
  const result = parseFeedback(value?.feedback);
  if (result.revision !== body.expectedRevision + 1 || result.evidenceHash !== body.evidenceHash
    || !feedbackFields.every(key => result[key] === body[key].trim())) fail();
  return result;
}
