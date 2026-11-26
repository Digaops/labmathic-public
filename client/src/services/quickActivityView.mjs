const id = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
export function quickActivityError(questions) {
  if (!questions.length) return 'Selecione de 1 a 5 questões para esta atividade.';
  if (questions.length > 5) return 'A atividade rápida tem até 5 questões. Retire algumas ou use o modo simulado.';
  if (questions.some(q => !q || !id(q.id) || !id(q.grade_id) || !id(q.skill_id)) || new Set(questions.map(q => Number(q.id))).size !== questions.length)
    return 'Não foi possível confirmar a seleção. Retire as questões e selecione novamente.';
  if (new Set(questions.map(q => Number(q.grade_id))).size !== 1 || new Set(questions.map(q => Number(q.skill_id))).size !== 1)
    return 'Escolha questões do mesmo ano e da mesma habilidade. Para misturar habilidades, use o modo simulado.';
  if (questions.some(q => q.question_type !== 'multiple_choice' || q.quick_compatible !== true))
    return 'Use questões de múltipla escolha com quatro alternativas e uma resposta correta.';
  return '';
}
export function quickActivityQuestion(question) {
  return { grade_id: question.grade_id, skill_id: question.skill_id, skill_code: question.skill_code,
    grade_name: question.grade_name, question_type: question.question_type,
    quick_compatible: question.status === 'active' && question.options?.length === 4 &&
      new Set(question.options.map(o => o.option_label)).size === 4 &&
      question.options.every(o => ['A', 'B', 'C', 'D'].includes(o.option_label)) &&
      question.options.filter(o => Number(o.is_correct) === 1).length === 1 };
}
export function quickActivityTitle(questions) {
  return `Atividade rápida${questions[0]?.skill_code ? ' — ' + questions[0].skill_code : ''}`.slice(0, 200);
}
