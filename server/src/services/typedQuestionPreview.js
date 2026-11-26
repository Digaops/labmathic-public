const { compileTypedQuestionDefinition } = require('./typedQuestionEngine');

const TYPE_LABELS = Object.freeze({
  single_choice: 'Escolha única',
  true_false: 'Verdadeiro ou falso',
  multiple_response: 'Múltiplas respostas',
  numeric: 'Resposta numérica',
  fill_blank: 'Preenchimento de lacunas',
  ordering: 'Ordenação',
  matching: 'Associação de colunas',
});

const TYPE_PURPOSES = Object.freeze({
  single_choice: 'Distinguir uma resposta adequada entre alternativas plausíveis.',
  true_false: 'Analisar uma afirmação objetiva sem depender da distribuição de letras.',
  multiple_response: 'Reconhecer simultaneamente mais de uma condição verdadeira.',
  numeric: 'Produzir um valor, com unidade explicitada fora do campo de resposta.',
  fill_blank: 'Completar relações matemáticas curtas com respostas equivalentes.',
  ordering: 'Organizar elementos segundo um critério matemático observável.',
  matching: 'Relacionar representações equivalentes em dois conjuntos.',
});

function base(interactionType, strategy, layout, answerSpaceLines = 0) {
  return {
    interactionType,
    scoring: {
      strategy,
      partialCredit: ['partial_with_penalty', 'per_blank', 'per_position', 'per_pair']
        .includes(strategy),
    },
    accessibility: {
      responseLabel: 'Resposta da questão demonstrativa',
      instructions: 'Explore o formato. A resposta fica apenas neste dispositivo e não é corrigida.',
      ...(['ordering', 'matching'].includes(interactionType) ? {
        keyboardInstructions: interactionType === 'ordering'
          ? 'Use os botões mover para cima e mover para baixo; todos funcionam pelo teclado.'
          : 'Percorra cada linha e escolha uma opção da segunda coluna usando o seletor rotulado.',
      } : {}),
    },
    print: {
      supported: true,
      layout,
      instructions: 'Registre a resposta no espaço indicado.',
      answerSpaceLines,
    },
    feedback: {
      releasePolicy: 'teacher_only',
      general: null,
      correct: null,
      incorrect: null,
      choiceFeedback: {},
    },
  };
}

const EXAMPLE_INPUTS = Object.freeze([
  {
    id: 'single-choice-fractions',
    definition: {
      ...base('single_choice', 'exact', 'choice_list'),
      content: {
        stem: 'Qual fração representa a metade de uma unidade?',
        supportText: 'Compare numerador e denominador antes de marcar.',
        choices: [
          { id: 'one_third', text: '1/3' },
          { id: 'one_half', text: '1/2' },
          { id: 'two_thirds', text: '2/3' },
          { id: 'three_fourths', text: '3/4' },
        ],
      },
      answerKey: { choiceId: 'one_half' },
    },
  },
  {
    id: 'true-false-geometry',
    definition: {
      ...base('true_false', 'exact', 'boolean_choice'),
      content: {
        stem: 'Todo quadrado possui quatro lados com a mesma medida.',
        supportText: null,
      },
      answerKey: { value: true },
    },
  },
  {
    id: 'multiple-response-even',
    definition: {
      ...base('multiple_response', 'partial_with_penalty', 'choice_list'),
      content: {
        stem: 'Quais números abaixo são pares?',
        supportText: 'Pode haver mais de uma resposta. Marque somente as que considerar corretas.',
        choices: [
          { id: 'number_two', text: '2' },
          { id: 'number_three', text: '3' },
          { id: 'number_four', text: '4' },
          { id: 'number_five', text: '5' },
        ],
      },
      answerKey: { choiceIds: ['number_two', 'number_four'] },
    },
  },
  {
    id: 'numeric-perimeter',
    definition: {
      ...base('numeric', 'numeric_exact', 'answer_box', 2),
      content: {
        stem: 'Um quadrado tem lado de 3 cm. Qual é o seu perímetro?',
        supportText: 'Digite somente o valor numérico.',
        unit: 'cm',
      },
      answerKey: { value: 12 },
    },
  },
  {
    id: 'fill-blank-place-value',
    definition: {
      ...base('fill_blank', 'per_blank', 'inline_blanks', 2),
      content: {
        stem: 'Complete a decomposição do número 340.',
        supportText: null,
        prompt: '{{hundreds}} centenas e {{tens}} dezenas.',
        blanks: [
          { id: 'hundreds', text: 'Quantidade de centenas' },
          { id: 'tens', text: 'Quantidade de dezenas' },
        ],
      },
      answerKey: {
        answers: [
          { blankId: 'hundreds', acceptedAnswers: ['3', 'três'] },
          { blankId: 'tens', acceptedAnswers: ['4', 'quatro'] },
        ],
        normalization: { caseSensitive: false, accentSensitive: false },
      },
    },
  },
  {
    id: 'ordering-decimals',
    definition: {
      ...base('ordering', 'per_position', 'numbered_sequence', 4),
      content: {
        stem: 'Organize os números do menor para o maior.',
        supportText: 'Use os controles de movimento; não é necessário arrastar.',
        items: [
          { id: 'decimal_08', text: '0,8' },
          { id: 'decimal_05', text: '0,5' },
          { id: 'decimal_12', text: '1,2' },
        ],
      },
      answerKey: { orderedItemIds: ['decimal_05', 'decimal_08', 'decimal_12'] },
    },
  },
  {
    id: 'matching-fractions',
    definition: {
      ...base('matching', 'per_pair', 'two_columns', 4),
      content: {
        stem: 'Associe cada fração à sua representação decimal.',
        supportText: 'Cada opção da segunda coluna deve ser usada uma vez.',
        leftItems: [
          { id: 'fraction_half', text: '1/2' },
          { id: 'fraction_quarter', text: '1/4' },
          { id: 'fraction_three_quarters', text: '3/4' },
        ],
        rightItems: [
          { id: 'decimal_half', text: '0,5' },
          { id: 'decimal_quarter', text: '0,25' },
          { id: 'decimal_three_quarters', text: '0,75' },
        ],
      },
      answerKey: {
        pairs: [
          { leftId: 'fraction_half', rightId: 'decimal_half' },
          { leftId: 'fraction_quarter', rightId: 'decimal_quarter' },
          { leftId: 'fraction_three_quarters', rightId: 'decimal_three_quarters' },
        ],
      },
    },
  },
]);

function publicDefinition(definition) {
  return {
    engineVersion: definition.engineVersion,
    formatVersion: definition.formatVersion,
    interactionType: definition.interactionType,
    content: definition.content,
    scoring: definition.scoring,
    accessibility: definition.accessibility,
    print: definition.print,
    feedbackPolicy: definition.feedback.releasePolicy,
  };
}

const EXAMPLES = Object.freeze(EXAMPLE_INPUTS.map((example) => {
  const compiled = compileTypedQuestionDefinition(example.definition);
  return Object.freeze({
    id: example.id,
    type: compiled.metadata.interactionType,
    typeLabel: TYPE_LABELS[compiled.metadata.interactionType],
    pedagogicalPurpose: TYPE_PURPOSES[compiled.metadata.interactionType],
    correctionMode: compiled.metadata.correctionMode,
    scoringStrategy: compiled.metadata.scoringStrategy,
    partialCredit: compiled.metadata.partialCredit,
    accessibilityReady: compiled.metadata.accessibilityReady,
    printSupported: compiled.metadata.printSupported,
    definition: publicDefinition(compiled.definition),
  });
}));

function getTypedQuestionPreviewCatalog() {
  return {
    mode: 'preview',
    readOnly: true,
    catalogVersion: 1,
    examples: EXAMPLES,
  };
}

module.exports = {
  getTypedQuestionPreviewCatalog,
};
