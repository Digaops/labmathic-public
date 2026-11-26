import { parseMaterial } from './materialView.mjs';

const types = new Set(['material', 'question', 'question_set']);
const positiveId = value => Number.isSafeInteger(value) && value > 0;
const text = value => typeof value === 'string' && Boolean(value.trim());
const optionalText = value => value == null || typeof value === 'string';
const invalid = () => { throw new Error('Não foi possível conferir o conteúdo deste recurso.'); };

export function plannerResourcePath(resource) {
  return types.has(resource?.type) && positiveId(resource.id)
    ? `/lesson-plans/catalog/resources/${resource.type}/${resource.id}/preview` : null;
}

export function parsePlannerResourcePreview(value, expected) {
  if (!plannerResourcePath(expected) || value?.type !== expected.type || value.id !== expected.id || !text(value.title)) invalid();
  if (value.type === 'material') {
    const material = parseMaterial(value.material);
    if (material.id !== expected.id || material.title !== value.title) invalid();
    return { type: value.type, id: value.id, title: value.title, material };
  }
  if (!Array.isArray(value.questions) || !value.questions.length || value.questions.length > 100
    || (value.type === 'question' && (value.questions.length !== 1 || value.questions[0]?.id !== value.id))
    || new Set(value.questions.map(question => question?.id)).size !== value.questions.length) invalid();
  const questions = value.questions.map(question => {
    if (!positiveId(question?.id) || !text(question.code) || !text(question.statement)
      || !text(question.skillCode) || !text(question.skillDescription)
      || !optionalText(question.supportText) || !optionalText(question.imagePath)
      || !Array.isArray(question.options) || question.options.length !== 4
      || question.options.some((option, index) => option?.label !== 'ABCD'[index] || !text(option.text))) invalid();
    // The preview presents no answer key, explanation or editorial metadata.
    return { id: question.id, code: question.code, statement: question.statement,
      supportText: question.supportText || '', imagePath: question.imagePath || null,
      skillCode: question.skillCode, skillDescription: question.skillDescription,
      options: question.options.map(option => ({ label: option.label, text: option.text })) };
  });
  return { type: value.type, id: value.id, title: value.title, questions };
}

export function plannerResourceError(error) {
  const status = error?.response?.status;
  if (status === 404) return 'Este recurso não está disponível para sua conta. Ele pode ter sido removido ou ter o acesso alterado.';
  if (status === 403) return 'Sua conta não tem acesso a esta consulta. Peça ajuda à administração.';
  if (status === 409 && error?.response?.data?.code === 'preview_limit_exceeded') return 'Esta prévia aceita até 100 questões. Salve o planejamento e consulte o conjunto completo na área Simulados.';
  if (status === 409) return 'Este recurso precisa de revisão antes de ser aberto aqui. Peça ajuda à administração.';
  return 'Não foi possível abrir o recurso. Confira sua conexão e tente novamente.';
}
