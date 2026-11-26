import { operationalBankState } from './bankExperiences.mjs';
import { recoveryWorkspaceState } from './recoveryPlansView.mjs';

export function dashboardHomeState({ isAdmin, flags = {}, institutional = {} }) {
  if (isAdmin) return 'admin';
  if (flags.loading) return 'loading';
  const readModelEnabled = flags.features?.['institutions.read_model'];
  // Missing flags also cover denied access: absence is not a confirmed opt-out.
  if (typeof readModelEnabled !== 'boolean') return 'unavailable';
  if (!readModelEnabled) return 'teacher';
  if (institutional.enabled !== true) return 'unavailable';
  // The provider retains only the current identity's confirmed model on refresh
  // or a transient failure, and clears it when access is denied.
  if (institutional.model?.mode === 'manager') return 'manager';
  if (institutional.model?.mode === 'professional') return 'teacher';
  return institutional.loading ? 'loading' : 'unavailable';
}

export function institutionalHomeLinks(features = {}) {
  const enabled = key => features[key] === true;
  const flags = { isEnabled: enabled };
  const coordinationEnabled = ['institutions.school_coordination', 'institutions.read_model',
    'classes.core', 'classes.assessment_assignments', 'classes.assessment_results'].every(enabled);
  const network = [
    ...(coordinationEnabled ? [{ to: '/acompanhamento-escolar', label: 'Acompanhar turmas da escola', description: 'Consulte avaliações e próximos passos nas escolas autorizadas.' }] : []),
    ...(enabled('institutions.read_model') ? [{ to: '/instituicoes', label: 'Escolas e vínculos', description: 'Veja as escolas sob sua responsabilidade e confira seus vínculos com a rede.' }] : []),
    ...(enabled('institutions.network_portrait') ? [{ to: '/retrato-da-rede', label: 'Retrato da rede', description: 'Consulte os indicadores oficiais disponíveis, com suas fontes e períodos.' }] : []),
  ];
  const personal = [
    ...(enabled('classes.core') ? [{ to: '/turmas', label: 'Minhas turmas' }] : []),
    ...(enabled('planning.lesson_planner') ? [{ to: '/planejamento', label: 'Planejamentos' }] : []),
    { to: '/banco-questoes', label: 'Banco de questões' },
    { to: '/simulados', label: 'Meus simulados' },
    ...(recoveryWorkspaceState('professor', flags) === 'operational' ? [{ to: '/recomposicao', label: 'Planos de recomposição' }] : []),
    ...(operationalBankState('professor', flags, { feedback: true }) === 'operational'
      ? [{ to: '/banco-questoes/devolutivas', label: 'Devolutivas da turma' }] : []),
    { to: '/biblioteca', label: 'Biblioteca' },
    { to: '/favoritos', label: 'Favoritos' },
    { to: '/colecoes', label: 'Laboratórios de materiais' },
  ];
  return { network, personal };
}

