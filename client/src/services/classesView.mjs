const publicId = value => typeof value === 'string' && /^[\w-]{1,80}$/.test(value);
const integer = value => Number.isSafeInteger(value) && value >= 0;
const category = value => value && Number.isSafeInteger(value.id) && value.id > 0 && typeof value.name === 'string';

export function parseClassSummary(value) {
  if (!value || !publicId(value.id) || typeof value.name !== 'string' || !category(value.grade)
    || !integer(value.academicYear) || !integer(value.revision) || !integer(value.studentCount)
    || !['active', 'archived'].includes(value.status) || !Array.isArray(value.disciplines) || !value.disciplines.every(category)) throw new Error('Turma não confirmada.');
  return value;
}
export function parseClasses(value) {
  if (!Array.isArray(value)) throw new Error('Lista de turmas não confirmada.');
  return value.map(parseClassSummary);
}
export function parseClassDetail(value) {
  parseClassSummary(value);
  if (!Array.isArray(value.students) || value.students.some(s => !s || !publicId(s.id) || typeof s.displayName !== 'string'
    || (s.externalReference != null && typeof s.externalReference !== 'string') || !integer(s.revision) || !integer(s.enrollmentRevision)
    || !['active', 'withdrawn'].includes(s.enrollmentStatus))) throw new Error('Estudantes não confirmados.');
  return value;
}
export function parseClassesBootstrap(value) {
  if (!value || !Array.isArray(value.grades) || !value.grades.every(category) || !Array.isArray(value.disciplines) || !value.disciplines.every(category)
    || ['importStudents', 'entryCodes'].some(key => typeof value.capabilities?.[key] !== 'boolean')
    || ['activeClasses', 'activeStudents', 'activeEnrollments'].some(key => !integer(value.overview?.[key]))) throw new Error('Opções de turmas não confirmadas.');
  return value;
}
export function classesQuery(params) {
  const classId = params.get('turma') || '';
  const section = params.get('secao') === 'avaliacoes' ? 'avaliacoes' : 'estudantes';
  const assessment = params.get('avaliacao');
  return { status: params.get('situacao') === 'archived' ? 'archived' : 'active', search: (params.get('busca') || '').slice(0, 80),
    id: classId, section, assessment: publicId(classId) && section === 'avaliacoes' && publicId(assessment) ? assessment : null,
    // Returning to an existing application must never launch preparation instead.
    source: params.has('avaliacao') ? null : params.get('simulado') || null };
}
export function classAssessmentPath(classId, assessmentId = '') {
  if (!publicId(classId) || (assessmentId !== '' && !publicId(assessmentId))) return null;
  const params = new URLSearchParams({ turma: classId, secao: 'avaliacoes' });
  if (assessmentId) params.set('avaliacao', assessmentId);
  return '/turmas?' + params;
}
export function locateClassAssessment(assessmentId, { assignments = [], loading = false, error = '' } = {}) {
  if (!publicId(assessmentId)) return { status: 'idle', id: null };
  if (loading) return { status: 'loading', id: null };
  if (error) return { status: 'unavailable', id: null };
  return assignments.some(item => item.id === assessmentId)
    ? { status: 'found', id: assessmentId } : { status: 'missing', id: null };
}
export function classesRequest(status, search) {
  const params = new URLSearchParams({ status }); if (search.trim()) params.set('search', search.trim());
  return `/classes?${params}`;
}
export function classNavigation(params, changes) {
  const next = new URLSearchParams(params);
  if (['turma', 'secao', 'busca', 'situacao'].some(key => Object.hasOwn(changes, key))) next.delete('avaliacao');
  for (const [key, value] of Object.entries(changes)) { if (value) next.set(key, value); else next.delete(key); }
  // Discard a contradictory preparation intent, even after clearing the return.
  if (params.has('avaliacao')) next.delete('simulado');
  return next;
}
export function classSelectionChange(query, id) {
  const source = !query.id && /^\d+$/.test(String(query.source)) && Number.isSafeInteger(Number(query.source)) && Number(query.source) > 0 ? query.source : null;
  return { turma: id, secao: source ? 'avaliacoes' : null, simulado: source };
}
export function classSearchChange(query, search) {
  return { ...classSelectionChange(query, null), busca: search.trim() || null };
}
export const studentMatches = (student, query) => {
  const normalize = text => String(text || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');
  return normalize(`${student.displayName} ${student.externalReference || ''}`).includes(normalize(query.trim()));
};
