const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TypedQuestionEngineError,
  compileTypedQuestionDefinition,
  scoreTypedQuestionResponse,
} = require('../src/services/typedQuestionEngine');

const common = {
  accessibility: {
    responseLabel: 'Resposta da questão',
    instructions: 'Leia o enunciado e registre sua resposta.',
  },
  feedback: {
    releasePolicy: 'after_assessment_close',
    general: 'Retome a estratégia usada e confira cada etapa.',
    correct: 'Boa estratégia.',
    incorrect: 'Revise os dados do enunciado.',
    choiceFeedback: {},
  },
};

function base(interactionType, scoring, layout, answerSpaceLines = 0) {
  return {
    interactionType,
    scoring: {
      strategy: scoring,
      partialCredit: ['partial_with_penalty', 'per_blank', 'per_position', 'per_pair']
        .includes(scoring),
    },
    accessibility: { ...common.accessibility },
    print: {
      supported: true,
      layout,
      instructions: 'Marque ou escreva a resposta no espaço indicado.',
      answerSpaceLines,
    },
    feedback: { ...common.feedback, choiceFeedback: {} },
  };
}

function singleChoiceDefinition() {
  return {
    ...base('single_choice', 'exact', 'choice_list'),
    content: {
      stem: 'Qual fração representa metade?',
      supportText: null,
      choices: [
        { id: 'choice_a', text: '1/3' },
        { id: 'choice_b', text: '1/2' },
        { id: 'choice_c', text: '2/3' },
      ],
    },
    answerKey: { choiceId: 'choice_b' },
  };
}

test('compila definição canônica estável e metadados sem alterar o banco legado', () => {
  const first = compileTypedQuestionDefinition(singleChoiceDefinition());
  const reordered = singleChoiceDefinition();
  reordered.content = {
    choices: reordered.content.choices,
    supportText: null,
    stem: reordered.content.stem,
  };
  const second = compileTypedQuestionDefinition(reordered);

  assert.equal(first.definitionJson, second.definitionJson);
  assert.equal(first.definitionHash, second.definitionHash);
  assert.match(first.definitionHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(first.metadata, {
    engineVersion: 1,
    formatVersion: 1,
    interactionType: 'single_choice',
    correctionMode: 'automatic',
    scoringStrategy: 'exact',
    partialCredit: false,
    accessibilityReady: true,
    printSupported: true,
  });
});

test('corrige escolha única e verdadeiro ou falso sem expor o gabarito', () => {
  const single = compileTypedQuestionDefinition(singleChoiceDefinition()).definition;
  const correct = scoreTypedQuestionResponse(single, { choiceId: 'choice_b' });
  const wrong = scoreTypedQuestionResponse(single, { choiceId: 'choice_a' });
  assert.equal(correct.score, 1);
  assert.equal(wrong.score, 0);
  assert.equal(JSON.stringify(correct).includes('choice_b'), false);

  const boolean = compileTypedQuestionDefinition({
    ...base('true_false', 'exact', 'boolean_choice'),
    content: { stem: 'Todo quadrado possui quatro lados.', supportText: null },
    answerKey: { value: true },
  }).definition;
  assert.equal(scoreTypedQuestionResponse(boolean, { value: true }).isCorrect, true);
  assert.equal(scoreTypedQuestionResponse(boolean, { value: false }).isCorrect, false);
  assert.equal(scoreTypedQuestionResponse(boolean, { value: null }).answered, false);
});

test('corrige múltiplas respostas por exatidão ou crédito parcial com penalidade', () => {
  const content = {
    stem: 'Quais números são pares?',
    supportText: null,
    choices: [
      { id: 'two', text: '2' },
      { id: 'three', text: '3' },
      { id: 'four', text: '4' },
      { id: 'five', text: '5' },
    ],
  };
  const exact = compileTypedQuestionDefinition({
    ...base('multiple_response', 'exact', 'choice_list'),
    content,
    answerKey: { choiceIds: ['two', 'four'] },
  }).definition;
  assert.equal(scoreTypedQuestionResponse(exact, { choiceIds: ['four', 'two'] }).score, 1);
  assert.equal(scoreTypedQuestionResponse(exact, { choiceIds: ['two'] }).score, 0);

  const partial = compileTypedQuestionDefinition({
    ...base('multiple_response', 'partial_with_penalty', 'choice_list'),
    content,
    answerKey: { choiceIds: ['two', 'four'] },
  }).definition;
  assert.equal(scoreTypedQuestionResponse(partial, { choiceIds: ['two'] }).score, 0.5);
  assert.equal(scoreTypedQuestionResponse(partial, { choiceIds: ['two', 'three'] }).score, 0);
  assert.equal(scoreTypedQuestionResponse(partial, { choiceIds: ['three'] }).score, 0);
});

test('aceita número com vírgula e aplica exatidão, tolerâncias e intervalo', () => {
  const numericBase = (strategy, answerKey) => compileTypedQuestionDefinition({
    ...base('numeric', strategy, 'answer_box', 2),
    content: { stem: 'Qual é o resultado?', supportText: null, unit: 'cm' },
    answerKey,
  }).definition;

  const exact = numericBase('numeric_exact', { value: 2.5 });
  assert.equal(scoreTypedQuestionResponse(exact, { value: '2,5' }).score, 1);
  assert.throws(
    () => scoreTypedQuestionResponse(exact, { value: '2.500,00' }),
    (error) => error.code === 'invalid_response',
  );

  const absolute = numericBase('numeric_absolute_tolerance', { value: 10, tolerance: 0.2 });
  assert.equal(scoreTypedQuestionResponse(absolute, { value: 10.2 }).score, 1);
  assert.equal(scoreTypedQuestionResponse(absolute, { value: 10.21 }).score, 0);

  const relative = numericBase('numeric_relative_tolerance', {
    value: 200,
    tolerancePercent: 5,
  });
  assert.equal(scoreTypedQuestionResponse(relative, { value: 190 }).score, 1);
  assert.equal(scoreTypedQuestionResponse(relative, { value: 189.9 }).score, 0);

  const range = numericBase('numeric_range', {
    minimum: 4,
    maximum: 6,
    includeMinimum: false,
    includeMaximum: true,
  });
  assert.equal(scoreTypedQuestionResponse(range, { value: 4 }).score, 0);
  assert.equal(scoreTypedQuestionResponse(range, { value: 6 }).score, 1);
});

test('corrige lacunas com equivalências configuráveis de caixa e acentuação', () => {
  const definition = compileTypedQuestionDefinition({
    ...base('fill_blank', 'per_blank', 'inline_blanks', 2),
    content: {
      stem: 'Complete a decomposição.',
      supportText: null,
      prompt: '{{hundreds}} centenas e {{tens}} dezenas.',
      blanks: [
        { id: 'hundreds', text: 'Quantidade de centenas' },
        { id: 'tens', text: 'Quantidade de dezenas' },
      ],
    },
    answerKey: {
      answers: [
        { blankId: 'hundreds', acceptedAnswers: ['Três', '3'] },
        { blankId: 'tens', acceptedAnswers: ['quatro', '4'] },
      ],
      normalization: { caseSensitive: false, accentSensitive: false },
    },
  }).definition;

  const partial = scoreTypedQuestionResponse(definition, {
    answers: { hundreds: '  TRES ', tens: 'cinco' },
  });
  assert.equal(partial.score, 0.5);
  assert.equal(partial.feedbackKey, 'partial');
  assert.equal(scoreTypedQuestionResponse(definition, { answers: {} }).answered, false);
});

test('corrige ordenação por posição e associação por par', () => {
  const ordering = compileTypedQuestionDefinition({
    ...base('ordering', 'per_position', 'numbered_sequence', 4),
    accessibility: {
      ...common.accessibility,
      keyboardInstructions: 'Use os controles mover para cima e mover para baixo.',
    },
    content: {
      stem: 'Ordene do menor para o maior.',
      supportText: null,
      items: [
        { id: 'one', text: '1' },
        { id: 'two', text: '2' },
        { id: 'three', text: '3' },
      ],
    },
    answerKey: { orderedItemIds: ['one', 'two', 'three'] },
  }).definition;
  assert.ok(Math.abs(
    scoreTypedQuestionResponse(ordering, { orderedItemIds: ['one', 'three', 'two'] }).score
      - (1 / 3),
  ) < 1e-12);

  const matching = compileTypedQuestionDefinition({
    ...base('matching', 'per_pair', 'two_columns', 4),
    accessibility: {
      ...common.accessibility,
      keyboardInstructions: 'Escolha um item de cada coluna para formar cada par.',
    },
    content: {
      stem: 'Associe a forma ao número de lados.',
      supportText: null,
      leftItems: [
        { id: 'triangle', text: 'Triângulo' },
        { id: 'square', text: 'Quadrado' },
      ],
      rightItems: [
        { id: 'three_sides', text: '3' },
        { id: 'four_sides', text: '4' },
      ],
    },
    answerKey: {
      pairs: [
        { leftId: 'triangle', rightId: 'three_sides' },
        { leftId: 'square', rightId: 'four_sides' },
      ],
    },
  }).definition;
  assert.equal(scoreTypedQuestionResponse(matching, {
    pairs: [
      { leftId: 'triangle', rightId: 'four_sides' },
      { leftId: 'square', rightId: 'three_sides' },
    ],
  }).score, 0);
  assert.equal(scoreTypedQuestionResponse(matching, {
    pairs: [
      { leftId: 'triangle', rightId: 'three_sides' },
      { leftId: 'square', rightId: 'four_sides' },
    ],
  }).score, 1);
});

test('falha de forma fechada para campos desconhecidos, acessibilidade e impressão incompletas', () => {
  assert.throws(
    () => compileTypedQuestionDefinition({ ...singleChoiceDefinition(), surprise: true }),
    (error) => error instanceof TypedQuestionEngineError
      && error.code === 'invalid_definition_shape',
  );

  const noLabel = singleChoiceDefinition();
  delete noLabel.accessibility.responseLabel;
  assert.throws(
    () => compileTypedQuestionDefinition(noLabel),
    (error) => error.code === 'invalid_definition_shape',
  );

  const noPrint = singleChoiceDefinition();
  noPrint.print.supported = false;
  assert.throws(
    () => compileTypedQuestionDefinition(noPrint),
    (error) => error.code === 'print_not_supported',
  );

  const invalidNumericPrint = {
    ...base('numeric', 'numeric_exact', 'answer_box', 0),
    content: { stem: 'Qual é o resultado?', supportText: null, unit: null },
    answerKey: { value: 4 },
  };
  assert.throws(
    () => compileTypedQuestionDefinition(invalidNumericPrint),
    (error) => error.code === 'invalid_print_layout',
  );

  const invalidPartial = singleChoiceDefinition();
  invalidPartial.scoring.partialCredit = true;
  assert.throws(
    () => compileTypedQuestionDefinition(invalidPartial),
    (error) => error.code === 'invalid_scoring_strategy',
  );
});

test('rejeita respostas ambíguas, duplicadas ou incompletas', () => {
  const single = compileTypedQuestionDefinition(singleChoiceDefinition()).definition;
  assert.throws(
    () => scoreTypedQuestionResponse(single, { choiceId: 'choice_b', extra: true }),
    (error) => error.code === 'invalid_response',
  );

  const multiple = compileTypedQuestionDefinition({
    ...base('multiple_response', 'exact', 'choice_list'),
    content: {
      stem: 'Escolha os pares.',
      choices: [
        { id: 'two', text: '2' },
        { id: 'three', text: '3' },
      ],
    },
    answerKey: { choiceIds: ['two'] },
  }).definition;
  assert.throws(
    () => scoreTypedQuestionResponse(multiple, { choiceIds: ['two', 'two'] }),
    (error) => error.code === 'invalid_response',
  );
});
