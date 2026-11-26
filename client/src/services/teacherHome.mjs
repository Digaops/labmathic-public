// Read-only view models. An unexpected response must not look like an empty account.
import { classAssessmentPath } from './classesView.mjs';
import { recoveryAction, recoveryPlanPath, recoveryStatuses } from './recoveryPlansView.mjs';

export function homeList(payload, field = 'data') {
  const items = Array.isArray(payload) ? payload : payload?.[field];
  if (!Array.isArray(items) || items.some(item => !item || typeof item !== 'object'
    || !(item.id || item.publicId) || typeof (item.title ?? item.name) !== 'string')) {
    throw new Error('Resposta de consulta incompleta.');
  }
  return items;
}

export function homeClasses(payload) {
  const items = homeList(payload);
  if (items.some(item => typeof item.name !== 'string' || !['active', 'archived'].includes(item.status))) {
    throw new Error('Lista de turmas incompleta.');
  }
  return items.filter(item => item.status === 'active');
}
export function homePlans(payload) {
  const items = homeList(payload, 'plans');
  if (items.some(item => !item.publicId || typeof item.title !== 'string')) throw new Error('Lista de planejamentos incompleta.');
  return items;
}

export function homeOverview(payload) {
  if (!payload?.metrics || !Array.isArray(payload.recentAssessments) || !Array.isArray(payload.recentRecoveryPlans)) {
    throw new Error('Resumo de trabalho incompleto.');
  }
  homeList(payload.recentAssessments);
  homeList(payload.recentRecoveryPlans);
  for (const group of ['assessments', 'recoveryPlans']) {
    if (!payload.metrics[group] || Object.values(payload.metrics[group]).some(value => !Number.isInteger(value) || value < 0)) {
      throw new Error('Contagens de acompanhamento incompletas.');
    }
  }
  return payload;
}

export function homeAttention(overview, { assessmentsEnabled, recoveryEnabled }) {
  if (!overview) return [];
  const items = [];
  const metrics = overview.metrics;
  if (recoveryEnabled && metrics.recoveryPlans.draft > 0) items.push({ to: '/recomposicao', text: `Planos aguardando revisão: ${metrics.recoveryPlans.draft}` });
  if (assessmentsEnabled && metrics.assessments.open > 0) items.push({ to: '/turmas', text: `Avaliações em andamento: ${metrics.assessments.open}` });
  if (assessmentsEnabled && metrics.assessments.scheduled > 0) items.push({ to: '/turmas', text: `Avaliações agendadas: ${metrics.assessments.scheduled}` });
  return items;
}

export function classHomePath(id, applications = false) {
  return `/turmas?turma=${encodeURIComponent(id)}${applications ? '&secao=avaliacoes' : ''}`;
}

export function homeDate(value) {
  if (!value) return '';
  const text = String(value);
  const date = new Date(text.includes('T') ? text : text.replace(' ', 'T') + 'Z');
  return Number.isNaN(date.getTime()) ? '' : date.toLocaleDateString('pt-BR', { day: '2-digit', month: 'short' });
}

const assessmentLabels = { draft: 'Rascunho', scheduled: 'Agendada', open: 'Em andamento', closed: 'Encerrada' };
const assessmentActions = { draft: 'Revisar aplicação', scheduled: 'Conferir agendamento', open: 'Acompanhar aplicação', closed: 'Consultar aplicação' };
const planLabels = { draft: 'Rascunho', active: 'Em andamento', completed: 'Concluído', archived: 'Arquivado' };
const planningActions = { draft: 'Continuar planejamento', active: 'Acompanhar aulas', completed: 'Consultar planejamento' };
const workPriority = {
  assessment: { open: 0, draft: 2, scheduled: 5 },
  recovery: { draft: 1, active: 3 },
  planning: { active: 4, draft: 4 },
};

export function recentHomeWork({ overview, plans = [], activeClassIds = [], assessmentsEnabled, recoveryEnabled }) {
  const items = [];
  if (assessmentsEnabled) for (const item of overview?.recentAssessments || []) {
    // Only link to the exact application in a currently accessible active class.
    if (!item.class?.id || !activeClassIds.includes(item.class.id) || item.status === 'cancelled') continue;
    if (typeof item.id !== 'string' || !item.id) continue;
    const to = classAssessmentPath(item.class.id, item.id);
    if (!to) continue;
    const state = item.status;
    if (!Object.hasOwn(assessmentActions, state)) continue;
    items.push({ key: `assessment-${item.id}`, kind: 'assessment', title: item.title, state,
      context: item.class.name, status: assessmentLabels[state],
      updatedAt: item.updatedAt, to, action: assessmentActions[state] });
  }
  if (recoveryEnabled) for (const item of overview?.recentRecoveryPlans || []) {
    const to = recoveryPlanPath(item.id);
    if (!to || !Object.hasOwn(recoveryStatuses, item.status) || item.status === 'archived') continue;
    items.push({ key: `recovery-${item.id}`, kind: 'recovery', title: item.title, state: item.status,
      context: item.class?.name, status: recoveryStatuses[item.status],
      updatedAt: item.updatedAt, to, action: recoveryAction(item) });
  }
  for (const item of plans) {
    if (!Object.hasOwn(planningActions, item.status)) continue;
    items.push({ key: `planning-${item.publicId}`, kind: 'planning', title: item.title, state: item.status,
      context: item.className, status: planLabels[item.status],
      updatedAt: item.updatedAt, to: `/planejamento/${encodeURIComponent(item.publicId)}`, action: planningActions[item.status] });
  }
  const priority = item => workPriority[item.kind][item.state] ?? 6;
  return items.sort((a, b) => priority(a) - priority(b)
    || String(b.updatedAt || '').localeCompare(String(a.updatedAt || ''))
    || a.key.localeCompare(b.key)).slice(0, 4);
}
