import { parseAssignments } from './assessmentView.mjs';

export function parseSavedRoster(value) {
  if (!Array.isArray(value) || value.some(person => !person || typeof person.id !== 'string' || !person.id
    || typeof person.displayName !== 'string' || typeof person.eligible !== 'boolean' || typeof person.canRemove !== 'boolean'
    || !['active', 'withdrawn'].includes(person.enrollmentStatus) || !['active', 'archived'].includes(person.studentStatus)
    || person.eligible !== (person.status !== 'exempted' && person.enrollmentStatus === 'active' && person.studentStatus === 'active'))
    || new Set(value.map(person => person.id)).size !== value.length) throw new Error('Lista salva não confirmada.');
  return value;
}

export function parseRosterReadiness(value) {
  if (!value || typeof value.classActive !== 'boolean') throw new Error('Turma não confirmada.');
  parseAssignments([value.assignment]);
  const people = parseSavedRoster(value.participants);
  const count = people.filter(person => person.status !== 'exempted' && !person.eligible).length;
  const exempted = people.filter(person => person.status === 'exempted').length;
  if (value.assignment.participantCount !== people.length || value.assignment.roster?.ineligibleCount !== count
    || (value.assignment.roster?.exemptedCount ?? 0) !== exempted
    || value.assignment.roster?.eligibleCount !== people.length - count - exempted) throw new Error('Matrículas não confirmadas.');
  return value;
}

export function mergeAssessmentRoster(active, saved = []) {
  const people = new Map(active.map(person => [person.id, { ...person, eligible: true, canRemove: true }]));
  for (const person of saved) people.set(person.id, person);
  return [...people.values()].sort((a, b) => a.displayName.localeCompare(b.displayName, 'pt-BR'));
}

export function rosterIssue(person) {
  return person.status === 'exempted' ? 'Dispensado desta avaliação' : person.studentStatus === 'archived' ? 'Cadastro arquivado'
    : person.enrollmentStatus === 'withdrawn' ? 'Retirado da turma' : '';
}
