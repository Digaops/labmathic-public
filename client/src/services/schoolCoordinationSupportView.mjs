import { parseCoordinationClasses } from './schoolCoordinationView.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;
const date = value => typeof value === 'string' && Number.isFinite(Date.parse(value.replace(' ', 'T')));
const check = condition => { if (!condition) throw new Error('Consulta de apoio inválida. Atualize a página.'); };
const keys = (value, allowed) => check(value && typeof value === 'object' && !Array.isArray(value)
  && Object.keys(value).every(key => allowed.includes(key)) && allowed.every(key => key in value));

export function parseCoordinationSupport(value, schoolId, classId, page) {
  keys(value, ['school', 'class', 'items', 'page', 'limit', 'total', 'minimumGroup']);
  check(value.school?.id === schoolId && value.class?.id === classId && value.page === page);
  parseCoordinationClasses({ school: value.school, minimumGroup: value.minimumGroup,
    year: null, page: 1, limit: 20, total: 1, items: [{ ...value.class, openCount: 0, closedCount: 0, result: null }] });
  check(integer(page) && page > 0 && page <= 9999 && value.limit === 20 && integer(value.total)
    && Array.isArray(value.items) && value.items.length === Math.min(20, Math.max(0, value.total - (page - 1) * 20)));
  const ids = new Set();
  value.items.forEach(plan => {
    keys(plan, ['id', 'status', 'activatedAt', 'sourceClosedAt', 'execution', 'verification']);
    check(typeof plan.id === 'string' && plan.id.length > 0 && !ids.has(plan.id)); ids.add(plan.id);
    check(['active', 'completed'].includes(plan.status) && date(plan.activatedAt) && date(plan.sourceClosedAt));
    if (plan.execution !== null) {
      const e = plan.execution; keys(e, ['status', 'total', 'taught', 'skipped', 'planned']);
      check(['active', 'completed', 'archived'].includes(e.status)
        && [e.total, e.taught, e.skipped, e.planned].every(integer) && e.total === e.taught + e.skipped + e.planned);
    }
    const v = plan.verification; keys(v, ['status', 'closedAt', 'results']);
    check(['not_created', 'draft', 'scheduled', 'open', 'closed', 'cancelled'].includes(v.status));
    if (v.status === 'closed') check(date(v.closedAt) && ['available', 'protected'].includes(v.results));
    else check(v.closedAt === null && v.results === null);
    if (plan.execution === null) check(v.status === 'not_created');
  });
  return value;
}

export function supportVerificationText(verification) {
  return {
    not_created: 'Nova avaliação ainda não criada', draft: 'Nova avaliação em preparação',
    scheduled: 'Nova avaliação agendada', open: 'Nova avaliação aberta',
    cancelled: 'Nova avaliação cancelada',
    closed: verification.results === 'available' ? 'Avaliação encerrada · correções disponíveis' : 'Avaliação encerrada · resultados protegidos',
  }[verification.status];
}

export function supportNextStep(plan) {
  if (plan.execution?.status === 'archived') return 'As aulas deste plano foram arquivadas. Converse com o professor sobre como o apoio continuará.';
  if (!plan.execution) return 'Combine com o professor como organizar as aulas de apoio. A organização ainda não foi disponibilizada nesta consulta.';
  if (plan.verification.status === 'closed') return plan.verification.results === 'available'
    ? 'Converse com o professor sobre os resultados da nova avaliação e o que ainda precisa ser retomado. As correções, sozinhas, não comprovam melhoria.'
    : 'Peça ao professor para conferir as correções na própria conta. Grupos pequenos ou sem correções suficientes não têm resultados divulgados aqui.';
  if (plan.verification.status === 'open') return 'Acompanhe com o professor a participação na nova avaliação. Aguarde o encerramento e a conferência das correções.';
  if (plan.verification.status === 'scheduled') return 'Combine com o professor o apoio necessário para realizar a avaliação na data planejada.';
  if (plan.execution.planned > 0) return 'Converse sobre as aulas que ainda estão previstas e o apoio necessário para realizá-las.';
  if (plan.execution.skipped > 0) return 'Há aulas marcadas como não realizadas. Conversem sobre o que retomar antes de verificar a aprendizagem.';
  return 'Combine com o professor uma nova atividade para conferir a aprendizagem. O registro das aulas não substitui essa verificação.';
}
