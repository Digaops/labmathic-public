const integer = value => Number.isSafeInteger(value) && value >= 0;
const text = value => typeof value === 'string' && value.length > 0;
function timestamp(value) { return value.replace(' ', 'T') + (/(Z|[+-]\d{2}:\d{2})$/i.test(value) ? '' : 'Z'); }
export function coordinationCount(value, singular, plural) { return `${value} ${value === 1 ? singular : plural}`; }
function check(condition) { if (!condition) throw new Error('Consulta escolar inválida. Atualize a página.'); }
function school(value) { check(value && text(value.id) && text(value.name) && text(value.municipality)); }
function list(value) {
  check(value && Array.isArray(value.items) && value.items.length <= 20 && value.limit === 20
    && integer(value.page) && value.page > 0 && integer(value.total));
}
export function parseCoordinationSchools(value) { list(value); value.items.forEach(school); return value; }
export function parseCoordinationClasses(value) {
  list(value); school(value.school); check(value.minimumGroup === 5 && (value.year === null || integer(value.year)));
  value.items.forEach(row => {
    check(text(row.id) && text(row.name) && text(row.gradeName) && integer(row.academicYear)
      && integer(row.openCount) && integer(row.closedCount));
    const result = row.result;
    if (result === null) { check(row.closedCount === 0); return; }
    check(row.closedCount > 0 && text(result.closedAt) && Number.isFinite(Date.parse(timestamp(result.closedAt)))
      && integer(result.questionCount) && result.questionCount > 0);
    if (result.status === 'protected') check(!('meanPercentage' in result) && !('correctedCount' in result));
    else check(result.status === 'available' && integer(result.correctedCount) && result.correctedCount >= value.minimumGroup
      && Number.isFinite(result.meanPercentage) && result.meanPercentage >= 0 && result.meanPercentage <= 100);
  });
  return value;
}
export function coordinationResultText(result) {
  if (!result) return 'Ainda não há avaliação encerrada.';
  if (result.status === 'protected') return 'Resultado não exibido: são necessárias pelo menos 5 correções concluídas, sem contar dispensas.';
  return `${result.meanPercentage.toLocaleString('pt-BR', { maximumFractionDigits: 2 })}% de acertos em média · ${result.correctedCount} correções concluídas · ${result.questionCount} ${result.questionCount === 1 ? 'questão' : 'questões'}`;
}
export function coordinationDate(value) {
  return new Date(timestamp(value)).toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
}

export function parseCoordinationSkills(value, schoolId, classId) {
  check(value && value.school?.id === schoolId && value.class?.id === classId);
  school(value.school);
  const row = value.class, result = value.result;
  // Share the established class-result contract, including protection of small groups.
  parseCoordinationClasses({ school: value.school, minimumGroup: value.minimumGroup,
    year: null, page: 1, limit: 20, total: 1,
    items: [{ ...row, openCount: 0, closedCount: result === null ? 0 : 1, result }] });
  if (result === null) return value;
  if (result.status === 'protected') { check(!('skills' in result)); return value; }
  check(Array.isArray(result.skills) && result.skills.length > 0 && result.skills.length <= result.questionCount);
  const codes = new Set();
  result.skills.forEach(skill => {
    check(skill && (skill.code === null || text(skill.code))
      && (skill.description === null || text(skill.description))
      && integer(skill.questionCount) && skill.questionCount > 0 && !codes.has(skill.code));
    codes.add(skill.code);
    if (skill.status === 'unavailable') check(!('successRate' in skill));
    else check(skill.status === 'available' && Number.isFinite(skill.successRate)
      && skill.successRate >= 0 && skill.successRate <= 100);
  });
  check(result.skills.reduce((sum, skill) => sum + skill.questionCount, 0) === result.questionCount);
  return value;
}
