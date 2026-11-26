import { formatCount } from '../utils/pluralize.js';

// Presentation only. Keep API state names and stored teacher titles unchanged.
export function recoverySummary({ priorityCount, groupCount, studentCount, plannedQuestionCount }) {
  return [
    formatCount(priorityCount, 'prioridade', 'prioridades'),
    formatCount(groupCount, 'grupo', 'grupos'),
    formatCount(studentCount, 'estudante', 'estudantes'),
    formatCount(plannedQuestionCount, 'questão prevista', 'questões previstas'),
  ].join(' · ');
}

const verificationSteps = {
  needs_application: ['Questões da verificação salvas', 'Agora prepare a aplicação para esta turma. O simulado já estará escolhido. Selecione o grupo de apoio, toda a turma ou nomes individualmente. Confira quem participará antes de salvar.'],
  draft: ['Verificação em rascunho', 'Confira os estudantes e as opções da aplicação. Depois, libere as respostas agora ou agende o período.'],
  scheduled: ['Verificação agendada', 'A aplicação abrirá no período informado. Confira as datas e oriente os estudantes.'],
  open: ['Verificação em andamento', 'Acompanhe as respostas e as correções. Encerre a aplicação quando a turma terminar.'],
  awaiting_results: ['Verificação sem resultados corrigidos', 'A aplicação foi encerrada. Abra os resultados e confira as correções antes de comparar com o diagnóstico.'],
  cancelled: ['Verificação cancelada', 'Registre nesta etapa por que a verificação não aconteceu e confirme como não realizada.'],
};
export function verificationNextStep(state) {
  return [...(Object.hasOwn(verificationSteps, state) ? verificationSteps[state] : ['Confira a situação da verificação', 'Abra as aplicações da turma para conferir o que está salvo.'])];
}
export function legacyVerificationNotice(title) {
  return typeof title === 'string' && title.startsWith('Monitoramento · ')
    ? 'Este simulado foi criado com o nome antigo “Monitoramento”. Ele corresponde à verificação da aprendizagem; seu título foi preservado.'
    : '';
}
