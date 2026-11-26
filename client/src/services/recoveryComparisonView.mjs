const count = value => Number.isSafeInteger(value) && value >= 0;
const rate = value => value === null || (Number.isFinite(value) && value >= 0 && value <= 100);
const difference = value => value === null || (Number.isFinite(value) && value >= -100 && value <= 100);
const fail = () => { throw new Error('Não foi possível conferir os dados da comparação. Atualize a página.'); };
export const matchedMethodology = 'matched-students-v2';

export function validateRecoveryComparison(value) {
  if (!value || !Array.isArray(value.skills)) fail();
  if (new Set(value.skills.map(skill => skill?.code)).size !== value.skills.length) fail();
  value.skills.forEach(skill => {
    if (!skill || typeof skill.code !== 'string' || !skill.code || !rate(skill.diagnosticRate)
      || !rate(skill.monitoringRate) || !difference(skill.delta)) fail();
    // Old revisions stay readable, but their populations cannot be inferred.
    if (value.methodology !== matchedMethodology) return;
    const cohort = skill.cohort;
    if (!cohort || !['matched', 'no_common_results', 'source_unavailable'].includes(cohort.status)
      || !['studentCount', 'diagnosticStudentCount', 'monitoringStudentCount', 'excludedDiagnosticCount', 'excludedMonitoringCount'].every(key => count(cohort[key]))
      || cohort.diagnosticStudentCount !== cohort.studentCount + cohort.excludedDiagnosticCount
      || cohort.monitoringStudentCount !== cohort.studentCount + cohort.excludedMonitoringCount
      || !['diagnosticQuestionCount', 'monitoringQuestionCount', 'diagnosticOpportunities', 'monitoringOpportunities'].every(key => count(skill[key]))) fail();
    if (cohort.status === 'matched') {
      if (!cohort.studentCount || !skill.diagnosticQuestionCount || !skill.monitoringQuestionCount
        || skill.diagnosticRate === null || skill.monitoringRate === null
        || skill.diagnosticOpportunities !== cohort.studentCount * skill.diagnosticQuestionCount
        || skill.monitoringOpportunities !== cohort.studentCount * skill.monitoringQuestionCount
        || skill.delta !== Number((skill.monitoringRate - skill.diagnosticRate).toFixed(2))) fail();
    } else if (cohort.studentCount || skill.diagnosticRate !== null || skill.monitoringRate !== null || skill.delta !== null) fail();
    if (!skill.evidence || !['insufficient', 'limited', 'moderate', 'broader'].includes(skill.evidence.level)) fail();
  });
  return value;
}

export const comparisonPercent = value => value == null ? 'Sem comparação' : `${value.toLocaleString('pt-BR')}%`;
export const quantity = (value, singular, plural) => `${value} ${value === 1 ? singular : plural}`;

export function recoveryComparisonView(value) {
  validateRecoveryComparison(value);
  const legacy = value.methodology !== matchedMethodology;
  return {
    legacy,
    notice: legacy
      ? 'Registro antigo: não é possível conferir se os percentuais usam os mesmos estudantes. Não interprete a diferença como evolução do grupo.'
      : 'São comparados os mesmos estudantes, por habilidade. As questões são diferentes; a diferença de acertos, sozinha, não prova o efeito do apoio.',
    skills: value.skills.map(skill => ({
      ...skill,
      comparable: !legacy && skill.cohort.status === 'matched',
      groupLabel: legacy ? 'Percentuais preservados no registro'
        : skill.cohort.status === 'source_unavailable' ? 'Não foi possível conferir duas avaliações encerradas desta turma.'
          : skill.cohort.status === 'no_common_results' ? 'Não há estudantes com respostas completas para esta habilidade nas duas etapas.'
            : `${quantity(skill.cohort.studentCount, 'estudante', 'estudantes')} ${skill.cohort.studentCount === 1 ? 'comparado' : 'comparados'} nas duas etapas`,
      evidenceNotice: legacy ? null : ['limited', 'insufficient'].includes(skill.evidence.level)
        ? 'Leitura inicial: há poucos estudantes ou questões. Confira também as atividades e o que observou em sala; este resultado não confirma o domínio da habilidade.'
        : 'Considere também as atividades e o que observou em sala. Este percentual não resume tudo o que os estudantes sabem.',
    })),
  };
}
