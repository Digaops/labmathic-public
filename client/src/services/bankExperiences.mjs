// Presentation only. Server-side permissions remain authoritative.
export const BANK_EXAMPLES = [
  { flag: 'question_bank.typed_preview', to: '/exemplos/formatos', label: 'Exemplos de formatos' },
  { flag: 'question_bank.feedback_preview', to: '/exemplos/devolutivas', label: 'Exemplos de devolutivas' },
  { flag: 'question_bank.catalog_preview', to: '/exemplos/banco-questoes', label: 'Exemplos do Banco 2.0' },
];

export function bankAccessState({ role, loading, unavailable, enabled, dependenciesReady = true }) {
  if (loading) return 'loading';
  // Keep an already-confirmed workspace mounted during a transient poll failure,
  // so the teacher's unsaved text is not discarded. Identity changes clear flags.
  if (role === 'professor' && enabled === true && dependenciesReady) return 'operational';
  if (unavailable) return 'unavailable';
  if (role !== 'professor') return 'role_restricted';
  return 'not_released';
}

export function operationalBankState(role, { loading, unavailable, isEnabled }, { feedback = false } = {}) {
  return bankAccessState({
    role, loading, unavailable, enabled: isEnabled('pedagogy.operational_cycle'),
    dependenciesReady: !feedback || ['classes.core', 'classes.assessment_assignments', 'classes.assessment_results'].every(isEnabled),
  });
}

export function classReturnPath(search) {
  const id = new URLSearchParams(search).get('turma');
  // Public IDs are opaque: preserve legacy identifiers as well as UUIDs.
  if (!/^[a-z\d_-]{16,100}$/i.test(id || '')) return '/turmas';
  return '/turmas?' + new URLSearchParams({ turma: id, secao: 'avaliacoes' });
}
