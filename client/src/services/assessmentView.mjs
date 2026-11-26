import { parseStudentFeedback } from './studentFeedbackView.mjs';
import {responseValue,isNumeric,validNumericInput} from './numericResponse.mjs';
import { parseNumericSources } from './numericAssessmentSelection.mjs';

const id = value => (typeof value === 'string' && value.length > 0) || Number.isSafeInteger(value);
const count = value => Number.isSafeInteger(value) && value >= 0;
const person = value => value && id(value.id) && typeof value.displayName === 'string';
const percentage = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
const date = value => value == null || Number.isFinite(Date.parse(value));
export function parseAssignments(value) {
  if (!Array.isArray(value) || value.some(a => !a || !id(a.id) || typeof a.title !== 'string' || !count(a.revision)
    || !count(a.questionCount) || !count(a.participantCount) || !date(a.opensAt) || !date(a.closesAt)
    || !['draft', 'scheduled', 'open', 'closed', 'cancelled'].includes(a.status))) throw new Error('Aplicações não confirmadas.');
  return value;
}
export function parseAssessmentBootstrap(value) {
  if (!value || !Array.isArray(value.sources) || value.sources.some(s => !s || !id(s.id) || typeof s.title !== 'string' || !count(s.questionCount))
    || !Array.isArray(value.participants) || !value.participants.every(person)) throw new Error('Opções de aplicação não confirmadas.');
  if (value.numericEnabled !== undefined && typeof value.numericEnabled !== 'boolean') throw new Error('Opções numéricas não confirmadas.');
  if (value.numericSourceSearch !== undefined && typeof value.numericSourceSearch !== 'boolean') throw new Error('Busca numérica não confirmada.');
  if (value.numericEnabled === true || value.numericSources !== undefined) parseNumericSources(value.numericSources);
  return value;
}
export function parseResults(value) {
  if (!value || !count(value.assessment?.questionCount) || !value.overview || !percentage(value.overview.meanPercentage)
    || ['participantCount', 'submittedCount', 'pendingCount'].some(key => !count(value.overview[key]))
    || !Array.isArray(value.participants) || !value.participants.every(person)
    || !Array.isArray(value.hardestQuestions) || value.hardestQuestions.some(q => !q || !id(q.id) || typeof q.statement !== 'string' || !percentage(q.successRate) || !percentage(q.errorRate))
    || !Array.isArray(value.skills) || value.skills.some(s => !s || !percentage(s.successRate))
    || !Array.isArray(value.studentsNeedingFollowUp) || !value.studentsNeedingFollowUp.every(person)
    || ['followUpBelow', 'consolidatedMin', 'developingMin'].some(key => !Number.isFinite(value.thresholds?.[key]))) throw new Error('Resultados não confirmados.');
  if (value.feedbackProgress !== undefined) {
    const progress = value.feedbackProgress;
    const pending = value.participants.filter(p => p.feedbackStatus === 'pending').length;
    const released = value.participants.filter(p => p.feedbackStatus === 'released').length;
    if (!progress || value.assessment.status !== 'closed'
      || ['eligibleCount', 'pendingCount', 'releasedCount'].some(key => !count(progress[key]))
      || progress.pendingCount !== pending || progress.releasedCount !== released
      || progress.eligibleCount !== pending + released || progress.eligibleCount !== value.overview.submittedCount
      || new Set(value.participants.map(p => p.id)).size !== value.participants.length
      || value.participants.some(p => !['pending', 'released', 'unavailable'].includes(p.feedbackStatus)
        || ((p.feedbackStatus !== 'unavailable') !== (p.participationStatus !== 'exempted' && p.attemptStatus === 'submitted')))) {
      throw new Error('Situação das orientações não confirmada. Atualize os resultados.');
    }
  }
  return value;
}
export function parseCorrection(value) {
  if(value?.items?.some(item=>isNumeric(item) && (!validNumericInput(item.numericValue)
    || !validNumericInput(item.correctNumericValue) || typeof item.unit!=='string' || item.options?.length!==0)))
    throw new Error('Resposta numérica não confirmada. Atualize a correção.');
  if (value?.feedback != null) parseStudentFeedback(value.feedback);
  if (!value || !person(value.participant) || typeof value.assessment?.title !== 'string' || !count(value.assessment.questionCount)
    || (value.attempt && (!count(value.attempt.revision) || !['draft', 'submitted'].includes(value.attempt.status)))
    || !Array.isArray(value.items) || value.items.some(item => !item || !id(item.id) || typeof item.statement !== 'string'
      || !Array.isArray(item.options) || item.options.some(option => !option || !id(option.id) || typeof option.text !== 'string'))) throw new Error('Correção não confirmada.');
  return value;
}
export const correctionSelections = entry => Object.fromEntries(entry.items.map(item => [item.id, responseValue(item)]));
export const hasUnsavedResponses = (entry, selections) => Boolean(entry && entry.attempt?.status !== 'submitted'
  && entry.items.some(item => responseValue(item) !== (selections[item.id] ?? null)));
export const matchesAssessmentText = (text, query) => {
  const normalize = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  return normalize(text).includes(normalize(query.trim()));
};

export function filterResultParticipants(summary, search, feedbackFilter, feedbackEnabled) {
  const activeFilter = feedbackEnabled && summary?.feedbackProgress
    && ['pending', 'released'].includes(feedbackFilter) ? feedbackFilter : 'all';
  return (summary?.participants || []).filter(p => matchesAssessmentText(p.displayName, search)
    && (activeFilter === 'all' || p.feedbackStatus === activeFilter));
}
