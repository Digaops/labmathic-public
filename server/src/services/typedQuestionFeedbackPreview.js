const {
  compileTypedQuestionDefinition,
  scoreTypedQuestionResponse,
} = require('./typedQuestionEngine');

const VIEW_STATES = Object.freeze([
  'before_submission',
  'after_submission',
  'assessment_closed',
  'teacher',
]);

const RELEASE_LABELS = Object.freeze({
  after_submission: 'Após a entrega',
  after_assessment_close: 'Após o encerramento',
  teacher_only: 'Somente professor',
});

class TypedQuestionFeedbackPreviewError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'TypedQuestionFeedbackPreviewError';
    this.code = code;
    this.status = status;
  }
}

function base(interactionType, strategy, releasePolicy) {
  return {
    interactionType,
    scoring: {
      strategy,
      partialCredit: strategy === 'partial_with_penalty',
    },
    accessibility: {
      responseLabel: 'Resposta da questão demonstrativa',
      instructions: 'Analise a resposta sintética usada para demonstrar a devolutiva.',
    },
    print: {
      supported: true,
      layout: interactionType === 'numeric' ? 'answer_box' : 'choice_list',
      instructions: 'Registre a resposta no espaço indicado.',
      answerSpaceLines: interactionType === 'numeric' ? 2 : 0,
    },
    feedback: {
      releasePolicy,
      general: null,
      correct: null,
      incorrect: null,
      choiceFeedback: {},
    },
  };
}

const EXAMPLE_INPUTS = Object.freeze([
  {
    id: 'fraction-half-feedback',
    title: 'Fração que representa a metade',
    typeLabel: 'Escolha única',
    pedagogicalPurpose: 'Distinguir a relação parte-todo sem se apoiar apenas nos números isolados.',
    definition: {
      ...base('single_choice', 'exact', 'after_submission'),
      content: {
        stem: 'Qual fração representa a metade de uma unidade?',
        supportText: 'Compare numerador e denominador antes de responder.',
        choices: [
          { id: 'one_third', text: '1/3' },
          { id: 'one_half', text: '1/2' },
          { id: 'two_thirds', text: '2/3' },
          { id: 'three_fourths', text: '3/4' },
        ],
      },
      answerKey: { choiceId: 'one_half' },
    },
    response: { choiceId: 'one_third' },
    responseDisplay: '1/3',
    guide: {
      referenceAnswer: '1/2',
      summary: 'Metade significa dividir a unidade em duas partes iguais e considerar uma delas.',
      resolutionSteps: [
        'Observe em quantas partes iguais a unidade foi dividida: o denominador deve ser 2.',
        'Considere quantas dessas partes foram tomadas: o numerador deve ser 1.',
        'A escrita que reúne essas duas informações é 1/2.',
      ],
      misconception: 'A resposta 1/3 sugere que o denominador foi associado a “uma parte” sem verificar em quantas partes iguais o todo foi dividido.',
      nextStep: 'Retomar representações de uma mesma unidade dividida em 2, 3 e 4 partes e pedir que o estudante nomeie cada parte antes de usar a notação.',
      choiceInsights: [
        { choice: '1/3', insight: 'Confunde metade com uma fração unitária qualquer.' },
        { choice: '1/2', insight: 'Reconhece uma de duas partes iguais.' },
        { choice: '2/3', insight: 'Pode associar números maiores a uma fração “mais próxima” da metade.' },
        { choice: '3/4', insight: 'Pode comparar apenas a diferença entre numerador e denominador.' },
      ],
    },
  },
  {
    id: 'even-numbers-feedback',
    title: 'Reconhecimento de números pares',
    typeLabel: 'Múltiplas respostas',
    pedagogicalPurpose: 'Verificar uma regra em todos os elementos, aceitando evidência parcial sem ignorar seleções indevidas.',
    definition: {
      ...base('multiple_response', 'partial_with_penalty', 'after_assessment_close'),
      content: {
        stem: 'Quais números abaixo são pares?',
        supportText: 'Pode haver mais de uma resposta.',
        choices: [
          { id: 'two', text: '2' },
          { id: 'three', text: '3' },
          { id: 'four', text: '4' },
          { id: 'five', text: '5' },
        ],
      },
      answerKey: { choiceIds: ['two', 'four'] },
    },
    response: { choiceIds: ['two'] },
    responseDisplay: '2',
    guide: {
      referenceAnswer: '2 e 4',
      summary: 'Um número natural é par quando pode ser organizado em grupos de dois sem sobra.',
      resolutionSteps: [
        'Verifique cada número separadamente, formando pares.',
        'O 2 forma um par e o 4 forma dois pares completos.',
        'O 3 e o 5 deixam uma unidade sem par; por isso, não devem ser marcados.',
      ],
      misconception: 'Marcar apenas 2 sugere reconhecimento do caso-base, mas a regra ainda não foi generalizada para outros números que formam pares completos.',
      nextStep: 'Usar tampinhas ou desenhos para formar pares com 2, 3, 4 e 5 elementos e registrar quando existe sobra.',
      choiceInsights: [
        { choice: '2', insight: 'Caso-base de número par.' },
        { choice: '3', insight: 'Deixa uma unidade sem par.' },
        { choice: '4', insight: 'Forma dois pares completos.' },
        { choice: '5', insight: 'Deixa uma unidade sem par.' },
      ],
    },
  },
  {
    id: 'square-perimeter-feedback',
    title: 'Perímetro de um quadrado',
    typeLabel: 'Resposta numérica',
    pedagogicalPurpose: 'Diferenciar medida do lado e contorno total da figura.',
    definition: {
      ...base('numeric', 'numeric_exact', 'teacher_only'),
      content: {
        stem: 'Um quadrado tem lado de 3 cm. Qual é o seu perímetro?',
        supportText: 'Registre somente o valor numérico.',
        unit: 'cm',
      },
      answerKey: { value: 12 },
    },
    response: { value: '9' },
    responseDisplay: '9 cm',
    guide: {
      referenceAnswer: '12 cm',
      summary: 'Perímetro é a medida do contorno; em um quadrado, os quatro lados têm a mesma medida.',
      resolutionSteps: [
        'Identifique a medida de um lado: 3 cm.',
        'Conte os lados do quadrado: são quatro lados iguais.',
        'Some 3 + 3 + 3 + 3, ou calcule 4 × 3, obtendo 12 cm.',
      ],
      misconception: 'A resposta 9 pode indicar uso de 3 × 3, procedimento associado à área, em vez da soma das medidas do contorno.',
      nextStep: 'Comparar, na mesma figura quadriculada, o contorno percorrido e a quantidade de quadradinhos internos antes de nomear perímetro e área.',
      choiceInsights: [],
    },
  },
]);

function publicQuestion(definition) {
  return {
    engineVersion: definition.engineVersion,
    formatVersion: definition.formatVersion,
    interactionType: definition.interactionType,
    content: definition.content,
    accessibility: definition.accessibility,
    print: definition.print,
  };
}

const EXAMPLES = Object.freeze(EXAMPLE_INPUTS.map((input) => {
  const compiled = compileTypedQuestionDefinition(input.definition);
  const score = scoreTypedQuestionResponse(compiled.definition, input.response);
  return Object.freeze({
    id: input.id,
    title: input.title,
    typeLabel: input.typeLabel,
    pedagogicalPurpose: input.pedagogicalPurpose,
    releasePolicy: compiled.definition.feedback.releasePolicy,
    releasePolicyLabel: RELEASE_LABELS[compiled.definition.feedback.releasePolicy],
    question: publicQuestion(compiled.definition),
    responseDisplay: input.responseDisplay,
    score,
    guide: input.guide,
  });
}));

function feedbackIsAvailable(releasePolicy, view) {
  if (view === 'teacher') return true;
  if (releasePolicy === 'teacher_only') return false;
  if (releasePolicy === 'after_submission') {
    return view === 'after_submission' || view === 'assessment_closed';
  }
  return view === 'assessment_closed';
}

function unavailableReason(releasePolicy, view) {
  if (view === 'before_submission') {
    return 'A devolutiva permanece protegida enquanto a resposta ainda está em elaboração.';
  }
  if (releasePolicy === 'teacher_only') {
    return 'Esta devolutiva é exclusiva do professor e não é liberada ao estudante.';
  }
  return 'A política congelada exige o encerramento da avaliação antes da liberação.';
}

function getFeedbackPreviewCatalog() {
  return {
    mode: 'feedback_preview',
    readOnly: true,
    catalogVersion: 1,
    views: VIEW_STATES,
    examples: EXAMPLES.map((example) => ({
      id: example.id,
      title: example.title,
      typeLabel: example.typeLabel,
      pedagogicalPurpose: example.pedagogicalPurpose,
      releasePolicy: example.releasePolicy,
      releasePolicyLabel: example.releasePolicyLabel,
    })),
  };
}

function getFeedbackPreviewExample(exampleId, view) {
  if (!VIEW_STATES.includes(view)) {
    throw new TypedQuestionFeedbackPreviewError(
      'invalid_preview_view',
      'O cenário de visualização informado é inválido.',
    );
  }
  const example = EXAMPLES.find((candidate) => candidate.id === exampleId);
  if (!example) {
    throw new TypedQuestionFeedbackPreviewError(
      'preview_example_not_found',
      'Exemplo de devolutiva não encontrado.',
      404,
    );
  }
  const available = feedbackIsAvailable(example.releasePolicy, view);
  const response = {
    mode: 'feedback_preview',
    readOnly: true,
    view,
    example: {
      id: example.id,
      title: example.title,
      typeLabel: example.typeLabel,
      pedagogicalPurpose: example.pedagogicalPurpose,
      releasePolicy: example.releasePolicy,
      releasePolicyLabel: example.releasePolicyLabel,
      question: example.question,
      response: view === 'before_submission' ? null : { display: example.responseDisplay },
    },
    feedback: {
      available,
      reason: available ? null : unavailableReason(example.releasePolicy, view),
    },
  };
  if (available) {
    response.feedback.evidence = {
      score: example.score.score,
      isCorrect: example.score.isCorrect,
      feedbackKey: example.score.feedbackKey,
    };
    response.feedback.guide = {
      ...example.guide,
      choiceInsights: view === 'teacher' ? example.guide.choiceInsights : [],
    };
  }
  return response;
}

module.exports = {
  VIEW_STATES,
  TypedQuestionFeedbackPreviewError,
  getFeedbackPreviewCatalog,
  getFeedbackPreviewExample,
};
