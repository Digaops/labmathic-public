import {isNumeric,validNumericInput} from './numericResponse.mjs';
const count = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string';
const modes = ['hidden', 'score_after_submit', 'score_after_close'];
export function parseStudentAccess(value) {
  if (!value || !text(value.assessment?.id) || !text(value.assessment.title) || !text(value.assessment.className)
    || !count(value.assessment.revision) || !modes.includes(value.assessment.studentResultMode)
    || typeof value.assessment.studentAccessEnabled !== 'boolean'
    || !['draft', 'scheduled', 'open', 'closed', 'cancelled'].includes(value.assessment.status)
    || ['participantCount', 'activeCredentialCount', 'accessedCount', 'submittedCount'].some(key => !count(value.summary?.[key]))
    || !Array.isArray(value.participants) || value.participants.some(p => !p || !text(p.id) || !text(p.displayName)
      || (p.credential && (!text(p.credential.id) || !text(p.credential.hint) || !count(p.credential.revision)
        || !['active', 'used', 'expired'].includes(p.credential.status))))) throw new Error('Acessos não confirmados.');
  return value;
}
export const canIssueStudentCode = p => p.participantStatus !== 'exempted' && p.attemptStatus !== 'submitted'
  && !(p.attemptStatus === 'draft' && p.submissionChannel === 'teacher_entry');

// Keep a one-time code only while its exact credential still exists and is active.
export function retainActiveCodes(codes, access) {
  return codes.filter(code => access.participants.some(p => p.id === code.id
    && p.credential?.id === code.credentialId && p.credential.status === 'active'));
}
export function mergeIssuedCodes(previous, response) {
  const access = parseStudentAccess(response?.access);
  if (!Array.isArray(response.generated) || response.generated.some(c => !c || !text(c.id) || !text(c.displayName)
    || !text(c.code) || !/^[A-Z0-9]{4}(?:-[A-Z0-9]{4}){3}$/.test(c.code)
    || !access.participants.some(p => p.id === c.id && p.credential?.status === 'active'
      && p.credential.hint === c.code.slice(-4)))) throw new Error('Códigos não confirmados.');
  const added = response.generated.map(c => ({ ...c, credentialId: access.participants.find(p => p.id === c.id).credential.id }));
  const ids = new Set(added.map(c => c.id));
  return [...retainActiveCodes(previous, access).filter(c => !ids.has(c.id)), ...added];
}

export function parseStudentPortal(value) {
  if (!value || !text(value.student?.displayName) || !text(value.assessment?.title) || !text(value.assessment.className)
    || (value.assessment.instructions != null && !text(value.assessment.instructions))
    || !count(value.assessment.questionCount) || !['open', 'closed', 'scheduled', 'cancelled'].includes(value.assessment.status)
    || !value.attempt || !['draft', 'submitted', 'voided'].includes(value.attempt.status) || !count(value.attempt.revision)
    || !Number.isFinite(Date.parse(value.serverTime))
    || (value.attempt.deadline != null && !Number.isFinite(Date.parse(value.attempt.deadline)))
    || !Array.isArray(value.items) || value.items.length === 0 || value.items.length !== value.assessment.questionCount
    || value.items.some(item => !item || !text(item.id) || !text(item.statement) || !count(item.number)
      || (item.supportText != null && !text(item.supportText)) || (item.imagePath != null && !text(item.imagePath))
      || !Array.isArray(item.options) || (!isNumeric(item) && item.options.length === 0)
      || (isNumeric(item) && (item.options.length!==0 || !text(item.unit) || !validNumericInput(item.numericValue)
        || item.selectedOptionId!==null || 'answerKey' in item || 'correctNumericValue' in item))
      || item.options.some(option => !option || !text(option.id) || !text(option.label) || !text(option.text))
      || (item.selectedOptionId != null && !item.options.some(option => option.id === item.selectedOptionId)))
    || (value.result && (!count(value.result.correctCount) || !count(value.result.questionCount)
      || !Number.isFinite(value.result.percentage) || value.result.percentage < 0 || value.result.percentage > 100))
    || (value.feedback && (typeof value.feedback.message !== 'string'
      || value.feedback.message.trim().length < 10 || value.feedback.message.length > 2000
      || !Number.isFinite(Date.parse(value.feedback.releasedAt))))
    )
    throw new Error('Não foi possível conferir os dados da avaliação.');
  return value;
}
