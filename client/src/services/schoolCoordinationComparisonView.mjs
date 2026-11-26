import { parseCoordinationClasses } from './schoolCoordinationView.mjs';

const check = condition => { if (!condition) throw new Error('Comparação escolar inválida. Atualize a consulta.'); };
const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value.replace(' ', 'T')));
const keys = (value, allowed) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).length === allowed.length && allowed.every(key => key in value));

export function parseSchoolComparison(value, schoolId, classId, planId) {
  keys(value, ['school', 'class', 'plan', 'minimumGroup', 'comparison']);
  check(value.school?.id === schoolId && value.class?.id === classId && value.plan?.id === planId);
  parseCoordinationClasses({ school: value.school, minimumGroup: value.minimumGroup, year: null,
    page: 1, limit: 20, total: 1, items: [{ ...value.class, openCount: 0, closedCount: 0, result: null }] });
  keys(value.plan, ['id', 'status', 'activatedAt']);
  check(['active', 'completed'].includes(value.plan.status) && date(value.plan.activatedAt));
  const c = value.comparison;
  if (c?.status !== 'available') {
    keys(c, ['status', 'sourceClosedAt', 'verificationClosedAt']);
    check(date(c.sourceClosedAt) && (c.status === 'protected' ? date(c.verificationClosedAt)
      : c.status === 'awaiting_verification' && c.verificationClosedAt === null));
    return value;
  }
  keys(c, ['status', 'sourceClosedAt', 'verificationClosedAt', 'methodology', 'hasProtectedSkills', 'skills']);
  check(date(c.sourceClosedAt) && date(c.verificationClosedAt) && c.methodology === 'matched-students-v2'
    && typeof c.hasProtectedSkills === 'boolean' && Array.isArray(c.skills) && c.skills.length > 0 && c.skills.length <= 50);
  const codes = new Set();
  c.skills.forEach(skill => {
    keys(skill, ['code', 'description', 'studentCount', 'diagnostic', 'verification', 'difference']);
    check(typeof skill.code === 'string' && skill.code.trim().length > 0 && !codes.has(skill.code)
      && typeof skill.description === 'string' && skill.description.trim().length > 0
      && integer(skill.studentCount) && skill.studentCount >= value.minimumGroup);
    codes.add(skill.code);
    for (const result of [skill.diagnostic, skill.verification]) {
      keys(result, ['questionCount', 'opportunities', 'successRate']);
      check(integer(result.questionCount) && result.questionCount > 0 && result.questionCount <= 100
        && integer(result.opportunities) && result.opportunities === skill.studentCount * result.questionCount
        && Number.isFinite(result.successRate) && result.successRate >= 0 && result.successRate <= 100);
    }
    check(Number.isFinite(skill.difference)
      && skill.difference === Number((skill.verification.successRate - skill.diagnostic.successRate).toFixed(2)));
  });
  return value;
}

export function schoolComparisonDifference(value) {
  if (value === 0) return 'Mesmo percentual de acertos';
  return `${Math.abs(value).toLocaleString('pt-BR', { maximumFractionDigits: 2 })} ${Math.abs(value) === 1 ? 'ponto percentual' : 'pontos percentuais'} ${value > 0 ? 'a mais' : 'a menos'}`;
}
