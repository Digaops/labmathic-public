import { parseAssignments } from './assessmentView.mjs';

export function parseAssessmentPreparation(value, sourceId) {
  const source = value?.source;
  if (!source || !Number.isSafeInteger(source.id) || source.id < 1 || String(source.id) !== String(sourceId)
    || typeof source.title !== 'string' || !Number.isSafeInteger(source.questionCount) || source.questionCount < 1 || source.questionCount > 100
    || !Object.hasOwn(value, 'recovery') || !Object.hasOwn(value, 'existingAssignment')) throw new Error('Preparação não confirmada.');
  if (value.recovery !== null) {
    const { participantIds, unavailableCount } = value.recovery || {};
    if (!Array.isArray(participantIds) || participantIds.some(id => typeof id !== 'string' || !id)
      || new Set(participantIds).size !== participantIds.length || !Number.isSafeInteger(unavailableCount) || unavailableCount < 0) throw new Error('Grupo de apoio não confirmado.');
  }
  if (value.existingAssignment !== null) {
    parseAssignments([value.existingAssignment]);
    if (!value.recovery || value.existingAssignment.sourceQuestionSetId !== source.id) throw new Error('Aplicação vinculada não confirmada.');
  }
  return value;
}

// Only eligible students from the current class can be suggested; never mutate the saved group.
export function supportParticipants(recovery, participants) {
  const active = new Set(participants.map(person => person.id));
  return [...new Set(recovery?.participantIds || [])].filter(id => active.has(id));
}

export function existingVerification(assignments, wizard, sourceId) {
  return wizard?.mode === 'create' && wizard.recovery && String(wizard.source?.id) === String(sourceId)
    ? assignments.find(item => String(item.sourceQuestionSetId) === String(sourceId)) || null : null;
}
