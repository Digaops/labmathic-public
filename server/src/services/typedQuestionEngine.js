const crypto = require('crypto');

const ENGINE_VERSION = 1;
const FORMAT_VERSION = 1;
const INTERACTION_TYPES = Object.freeze([
  'single_choice',
  'true_false',
  'multiple_response',
  'numeric',
  'fill_blank',
  'ordering',
  'matching',
]);
const FEEDBACK_RELEASE_POLICIES = Object.freeze([
  'after_submission',
  'after_assessment_close',
  'teacher_only',
]);
const STRATEGIES_BY_TYPE = Object.freeze({
  single_choice: ['exact'],
  true_false: ['exact'],
  multiple_response: ['exact', 'partial_with_penalty'],
  numeric: [
    'numeric_exact',
    'numeric_absolute_tolerance',
    'numeric_relative_tolerance',
    'numeric_range',
  ],
  fill_blank: ['exact', 'per_blank'],
  ordering: ['exact', 'per_position'],
  matching: ['exact', 'per_pair'],
});
const PARTIAL_STRATEGIES = new Set([
  'partial_with_penalty',
  'per_blank',
  'per_position',
  'per_pair',
]);
const PRINT_LAYOUTS_BY_TYPE = Object.freeze({
  single_choice: ['choice_list'],
  true_false: ['boolean_choice'],
  multiple_response: ['choice_list'],
  numeric: ['answer_box'],
  fill_blank: ['inline_blanks'],
  ordering: ['numbered_sequence'],
  matching: ['two_columns'],
});
const IDENTIFIER_PATTERN = /^[a-z][a-z0-9_-]{0,39}$/;

class TypedQuestionEngineError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.name = 'TypedQuestionEngineError';
    this.code = code;
    this.details = details;
  }
}

function fail(code, message, details) {
  throw new TypedQuestionEngineError(code, message, details);
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function assertObject(value, label) {
  if (!isObject(value)) fail('invalid_definition', `${label} deve ser um objeto.`);
}

function assertKeys(value, { allowed, required = allowed }, label) {
  assertObject(value, label);
  const unexpected = Object.keys(value).filter((key) => !allowed.includes(key));
  const missing = required.filter((key) => !Object.hasOwn(value, key));
  if (unexpected.length > 0 || missing.length > 0) {
    fail('invalid_definition_shape', `${label} possui campos ausentes ou não permitidos.`, {
      unexpected,
      missing,
    });
  }
}

function requiredText(value, label, minimum = 1, maximum = 20000) {
  if (typeof value !== 'string') {
    fail('invalid_definition', `${label} deve ser texto.`);
  }
  const normalized = value.trim().replace(/\r\n?/g, '\n');
  if (normalized.length < minimum || normalized.length > maximum) {
    fail(
      'invalid_definition',
      `${label} deve ter entre ${minimum} e ${maximum} caracteres.`,
    );
  }
  return normalized;
}

function optionalText(value, label, maximum = 20000) {
  if (value === undefined || value === null || value === '') return null;
  return requiredText(value, label, 1, maximum);
}

function requiredBoolean(value, label) {
  if (typeof value !== 'boolean') fail('invalid_definition', `${label} deve ser booleano.`);
  return value;
}

function requiredNumber(value, label) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_definition', `${label} deve ser um número finito.`);
  }
  return Object.is(value, -0) ? 0 : value;
}

function requiredIdentifier(value, label) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(
      'invalid_definition',
      `${label} deve começar por letra minúscula e conter apenas letras, números, _ ou -.`,
    );
  }
  return value;
}

function assertUnique(values, label) {
  if (new Set(values).size !== values.length) {
    fail('invalid_definition', `${label} não pode conter identificadores duplicados.`);
  }
}

function normalizeItems(items, label, { minimum = 2, maximum = 12 } = {}) {
  if (!Array.isArray(items) || items.length < minimum || items.length > maximum) {
    fail(
      'invalid_definition',
      `${label} deve conter entre ${minimum} e ${maximum} itens.`,
    );
  }
  const normalized = items.map((item, index) => {
    assertKeys(item, { allowed: ['id', 'text'] }, `${label}[${index}]`);
    return {
      id: requiredIdentifier(item.id, `${label}[${index}].id`),
      text: requiredText(item.text, `${label}[${index}].text`, 1, 5000),
    };
  });
  assertUnique(normalized.map((item) => item.id), `${label}.id`);
  return normalized;
}

function normalizeBaseContent(content, allowedExtra = [], requiredExtra = []) {
  assertKeys(content, {
    allowed: ['stem', 'supportText', ...allowedExtra],
    required: ['stem', ...requiredExtra],
  }, 'content');
  return {
    stem: requiredText(content.stem, 'content.stem', 1, 20000),
    supportText: optionalText(content.supportText, 'content.supportText', 20000),
  };
}

function normalizeScoring(scoring, interactionType) {
  assertKeys(scoring, { allowed: ['strategy', 'partialCredit'] }, 'scoring');
  if (!STRATEGIES_BY_TYPE[interactionType].includes(scoring.strategy)) {
    fail(
      'invalid_scoring_strategy',
      `A estratégia ${String(scoring.strategy)} não é compatível com ${interactionType}.`,
    );
  }
  const partialCredit = requiredBoolean(scoring.partialCredit, 'scoring.partialCredit');
  if (partialCredit !== PARTIAL_STRATEGIES.has(scoring.strategy)) {
    fail(
      'invalid_scoring_strategy',
      'scoring.partialCredit não corresponde à estratégia informada.',
    );
  }
  return { strategy: scoring.strategy, partialCredit };
}

function normalizeAccessibility(accessibility, interactionType) {
  assertKeys(accessibility, {
    allowed: ['responseLabel', 'instructions', 'keyboardInstructions'],
    required: ['responseLabel', 'instructions'],
  }, 'accessibility');
  const keyboardInstructions = optionalText(
    accessibility.keyboardInstructions,
    'accessibility.keyboardInstructions',
    1000,
  );
  if (['ordering', 'matching'].includes(interactionType) && !keyboardInstructions) {
    fail(
      'accessibility_incomplete',
      `accessibility.keyboardInstructions é obrigatório para ${interactionType}.`,
    );
  }
  return {
    responseLabel: requiredText(
      accessibility.responseLabel,
      'accessibility.responseLabel',
      2,
      300,
    ),
    instructions: requiredText(
      accessibility.instructions,
      'accessibility.instructions',
      2,
      1000,
    ),
    keyboardInstructions,
  };
}

function normalizePrint(print, interactionType) {
  assertKeys(print, {
    allowed: ['supported', 'layout', 'instructions', 'answerSpaceLines'],
    required: ['supported', 'layout', 'instructions', 'answerSpaceLines'],
  }, 'print');
  if (print.supported !== true) {
    fail('print_not_supported', 'A primeira versão exige suporte à impressão.');
  }
  if (!PRINT_LAYOUTS_BY_TYPE[interactionType].includes(print.layout)) {
    fail('invalid_print_layout', `print.layout não é compatível com ${interactionType}.`);
  }
  if (
    !Number.isInteger(print.answerSpaceLines)
    || print.answerSpaceLines < 0
    || print.answerSpaceLines > 20
  ) {
    fail('invalid_definition', 'print.answerSpaceLines deve ser um inteiro entre 0 e 20.');
  }
  if (
    ['numeric', 'fill_blank', 'ordering', 'matching'].includes(interactionType)
    && print.answerSpaceLines < 1
  ) {
    fail(
      'invalid_print_layout',
      `print.answerSpaceLines deve reservar espaço de resposta para ${interactionType}.`,
    );
  }
  return {
    supported: true,
    layout: print.layout,
    instructions: requiredText(print.instructions, 'print.instructions', 2, 1000),
    answerSpaceLines: print.answerSpaceLines,
  };
}

function normalizeFeedback(feedback, validChoiceIds) {
  const supplied = feedback === undefined ? {} : feedback;
  assertKeys(supplied, {
    allowed: ['releasePolicy', 'general', 'correct', 'incorrect', 'choiceFeedback'],
    required: [],
  }, 'feedback');
  const choiceFeedback = supplied.choiceFeedback === undefined ? {} : supplied.choiceFeedback;
  assertObject(choiceFeedback, 'feedback.choiceFeedback');
  const invalidIds = Object.keys(choiceFeedback).filter((id) => !validChoiceIds.includes(id));
  if (invalidIds.length > 0) {
    fail('invalid_definition', 'feedback.choiceFeedback referencia alternativa inexistente.', {
      invalidIds,
    });
  }
  const normalizedChoiceFeedback = Object.keys(choiceFeedback)
    .sort()
    .reduce((result, id) => {
      result[id] = optionalText(
        choiceFeedback[id],
        `feedback.choiceFeedback.${id}`,
        5000,
      );
      return result;
    }, {});
  const releasePolicy = supplied.releasePolicy || 'teacher_only';
  if (!FEEDBACK_RELEASE_POLICIES.includes(releasePolicy)) {
    fail('invalid_definition', 'feedback.releasePolicy é inválida.');
  }
  return {
    releasePolicy,
    general: optionalText(supplied.general, 'feedback.general', 5000),
    correct: optionalText(supplied.correct, 'feedback.correct', 5000),
    incorrect: optionalText(supplied.incorrect, 'feedback.incorrect', 5000),
    choiceFeedback: normalizedChoiceFeedback,
  };
}

function normalizeChoiceDefinition(input, multiple) {
  const contentBase = normalizeBaseContent(input.content, ['choices'], ['choices']);
  const choices = normalizeItems(input.content.choices, 'content.choices', {
    minimum: 2,
    maximum: multiple ? 12 : 8,
  });
  const choiceIds = choices.map((choice) => choice.id);
  if (multiple) {
    assertKeys(input.answerKey, { allowed: ['choiceIds'] }, 'answerKey');
    if (!Array.isArray(input.answerKey.choiceIds) || input.answerKey.choiceIds.length === 0) {
      fail('invalid_answer_key', 'answerKey.choiceIds deve conter ao menos uma alternativa.');
    }
    const correctChoiceIds = input.answerKey.choiceIds.map((id, index) => (
      requiredIdentifier(id, `answerKey.choiceIds[${index}]`)
    ));
    assertUnique(correctChoiceIds, 'answerKey.choiceIds');
    const invalidIds = correctChoiceIds.filter((id) => !choiceIds.includes(id));
    if (invalidIds.length > 0) {
      fail('invalid_answer_key', 'O gabarito referencia alternativas inexistentes.', { invalidIds });
    }
    if (
      input.scoring.strategy === 'partial_with_penalty'
      && correctChoiceIds.length === choiceIds.length
    ) {
      fail(
        'invalid_answer_key',
        'A correção parcial com penalidade exige ao menos uma alternativa incorreta.',
      );
    }
    return {
      content: { ...contentBase, choices },
      answerKey: { choiceIds: [...correctChoiceIds].sort() },
      validChoiceIds: choiceIds,
    };
  }

  assertKeys(input.answerKey, { allowed: ['choiceId'] }, 'answerKey');
  const choiceId = requiredIdentifier(input.answerKey.choiceId, 'answerKey.choiceId');
  if (!choiceIds.includes(choiceId)) {
    fail('invalid_answer_key', 'answerKey.choiceId referencia alternativa inexistente.');
  }
  return {
    content: { ...contentBase, choices },
    answerKey: { choiceId },
    validChoiceIds: choiceIds,
  };
}

function normalizeTrueFalseDefinition(input) {
  const content = normalizeBaseContent(input.content);
  assertKeys(input.answerKey, { allowed: ['value'] }, 'answerKey');
  return {
    content,
    answerKey: { value: requiredBoolean(input.answerKey.value, 'answerKey.value') },
    validChoiceIds: [],
  };
}

function normalizeNumericDefinition(input) {
  const content = normalizeBaseContent(input.content, ['unit'], []);
  content.unit = optionalText(input.content.unit, 'content.unit', 100);
  const strategy = input.scoring.strategy;
  let answerKey;
  if (strategy === 'numeric_exact') {
    assertKeys(input.answerKey, { allowed: ['value'] }, 'answerKey');
    answerKey = { value: requiredNumber(input.answerKey.value, 'answerKey.value') };
  } else if (strategy === 'numeric_absolute_tolerance') {
    assertKeys(input.answerKey, { allowed: ['value', 'tolerance'] }, 'answerKey');
    const tolerance = requiredNumber(input.answerKey.tolerance, 'answerKey.tolerance');
    if (tolerance <= 0) fail('invalid_answer_key', 'answerKey.tolerance deve ser positivo.');
    answerKey = {
      value: requiredNumber(input.answerKey.value, 'answerKey.value'),
      tolerance,
    };
  } else if (strategy === 'numeric_relative_tolerance') {
    assertKeys(input.answerKey, { allowed: ['value', 'tolerancePercent'] }, 'answerKey');
    const value = requiredNumber(input.answerKey.value, 'answerKey.value');
    const tolerancePercent = requiredNumber(
      input.answerKey.tolerancePercent,
      'answerKey.tolerancePercent',
    );
    if (value === 0) {
      fail('invalid_answer_key', 'Tolerância relativa não pode usar valor esperado zero.');
    }
    if (tolerancePercent <= 0 || tolerancePercent > 100) {
      fail('invalid_answer_key', 'answerKey.tolerancePercent deve estar entre 0 e 100.');
    }
    answerKey = { value, tolerancePercent };
  } else {
    assertKeys(input.answerKey, {
      allowed: ['minimum', 'maximum', 'includeMinimum', 'includeMaximum'],
    }, 'answerKey');
    const minimum = requiredNumber(input.answerKey.minimum, 'answerKey.minimum');
    const maximum = requiredNumber(input.answerKey.maximum, 'answerKey.maximum');
    if (minimum >= maximum) {
      fail('invalid_answer_key', 'answerKey.minimum deve ser menor que answerKey.maximum.');
    }
    answerKey = {
      minimum,
      maximum,
      includeMinimum: requiredBoolean(input.answerKey.includeMinimum, 'answerKey.includeMinimum'),
      includeMaximum: requiredBoolean(input.answerKey.includeMaximum, 'answerKey.includeMaximum'),
    };
  }
  return { content, answerKey, validChoiceIds: [] };
}

function normalizeFillBlankDefinition(input) {
  const contentBase = normalizeBaseContent(input.content, ['prompt', 'blanks'], ['prompt', 'blanks']);
  const prompt = requiredText(input.content.prompt, 'content.prompt', 1, 20000);
  const blanks = normalizeItems(input.content.blanks, 'content.blanks', {
    minimum: 1,
    maximum: 20,
  });
  const blankIds = blanks.map((blank) => blank.id);
  for (const blankId of blankIds) {
    const escapedId = blankId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const occurrences = prompt.match(new RegExp(`\\{\\{${escapedId}\\}\\}`, 'g')) || [];
    if (occurrences.length !== 1) {
      fail(
        'invalid_definition',
        `content.prompt deve conter {{${blankId}}} exatamente uma vez.`,
      );
    }
  }
  const placeholders = [...prompt.matchAll(/\{\{([a-z][a-z0-9_-]{0,39})\}\}/g)]
    .map((match) => match[1]);
  const promptWithoutKnownPlaceholders = blankIds.reduce(
    (value, id) => value.replace(`{{${id}}}`, ''),
    prompt,
  );
  if (
    placeholders.some((id) => !blankIds.includes(id))
    || promptWithoutKnownPlaceholders.includes('{{')
    || promptWithoutKnownPlaceholders.includes('}}')
  ) {
    fail('invalid_definition', 'content.prompt contém lacuna não declarada.');
  }
  assertKeys(input.answerKey, { allowed: ['answers', 'normalization'] }, 'answerKey');
  assertKeys(input.answerKey.normalization, {
    allowed: ['caseSensitive', 'accentSensitive'],
  }, 'answerKey.normalization');
  const normalization = {
    caseSensitive: requiredBoolean(
      input.answerKey.normalization.caseSensitive,
      'answerKey.normalization.caseSensitive',
    ),
    accentSensitive: requiredBoolean(
      input.answerKey.normalization.accentSensitive,
      'answerKey.normalization.accentSensitive',
    ),
  };
  if (!Array.isArray(input.answerKey.answers) || input.answerKey.answers.length !== blanks.length) {
    fail('invalid_answer_key', 'answerKey.answers deve responder a todas as lacunas.');
  }
  const answers = input.answerKey.answers.map((answer, index) => {
    assertKeys(answer, { allowed: ['blankId', 'acceptedAnswers'] }, `answerKey.answers[${index}]`);
    const blankId = requiredIdentifier(answer.blankId, `answerKey.answers[${index}].blankId`);
    if (!Array.isArray(answer.acceptedAnswers) || answer.acceptedAnswers.length === 0) {
      fail('invalid_answer_key', 'Cada lacuna deve possuir ao menos uma resposta aceita.');
    }
    const acceptedAnswers = answer.acceptedAnswers.map((value, answerIndex) => (
      requiredText(
        value,
        `answerKey.answers[${index}].acceptedAnswers[${answerIndex}]`,
        1,
        500,
      )
    ));
    assertUnique(acceptedAnswers, `answerKey.answers[${index}].acceptedAnswers`);
    assertUnique(
      acceptedAnswers.map((value) => normalizeTextAnswer(value, normalization)),
      `answerKey.answers[${index}].acceptedAnswers normalizadas`,
    );
    return { blankId, acceptedAnswers };
  });
  assertUnique(answers.map((answer) => answer.blankId), 'answerKey.answers.blankId');
  const missingBlankIds = blankIds.filter((id) => !answers.some((answer) => answer.blankId === id));
  const invalidBlankIds = answers.filter((answer) => !blankIds.includes(answer.blankId));
  if (missingBlankIds.length > 0 || invalidBlankIds.length > 0) {
    fail('invalid_answer_key', 'answerKey.answers não corresponde às lacunas declaradas.');
  }
  return {
    content: { ...contentBase, prompt, blanks },
    answerKey: {
      answers: answers.sort((a, b) => a.blankId.localeCompare(b.blankId)),
      normalization,
    },
    validChoiceIds: [],
  };
}

function normalizeOrderingDefinition(input) {
  const contentBase = normalizeBaseContent(input.content, ['items'], ['items']);
  const items = normalizeItems(input.content.items, 'content.items', { minimum: 2, maximum: 20 });
  assertKeys(input.answerKey, { allowed: ['orderedItemIds'] }, 'answerKey');
  if (!Array.isArray(input.answerKey.orderedItemIds)) {
    fail('invalid_answer_key', 'answerKey.orderedItemIds deve ser uma lista.');
  }
  const orderedItemIds = input.answerKey.orderedItemIds.map((id, index) => (
    requiredIdentifier(id, `answerKey.orderedItemIds[${index}]`)
  ));
  assertPermutation(orderedItemIds, items.map((item) => item.id), 'answerKey.orderedItemIds');
  return {
    content: { ...contentBase, items },
    answerKey: { orderedItemIds },
    validChoiceIds: [],
  };
}

function normalizeMatchingDefinition(input) {
  const contentBase = normalizeBaseContent(
    input.content,
    ['leftItems', 'rightItems'],
    ['leftItems', 'rightItems'],
  );
  const leftItems = normalizeItems(input.content.leftItems, 'content.leftItems', {
    minimum: 2,
    maximum: 20,
  });
  const rightItems = normalizeItems(input.content.rightItems, 'content.rightItems', {
    minimum: 2,
    maximum: 20,
  });
  if (leftItems.length !== rightItems.length) {
    fail('invalid_definition', 'matching exige a mesma quantidade de itens nas duas colunas.');
  }
  assertKeys(input.answerKey, { allowed: ['pairs'] }, 'answerKey');
  if (!Array.isArray(input.answerKey.pairs) || input.answerKey.pairs.length !== leftItems.length) {
    fail('invalid_answer_key', 'answerKey.pairs deve formar uma correspondência completa.');
  }
  const pairs = input.answerKey.pairs.map((pair, index) => {
    assertKeys(pair, { allowed: ['leftId', 'rightId'] }, `answerKey.pairs[${index}]`);
    return {
      leftId: requiredIdentifier(pair.leftId, `answerKey.pairs[${index}].leftId`),
      rightId: requiredIdentifier(pair.rightId, `answerKey.pairs[${index}].rightId`),
    };
  });
  const leftIds = leftItems.map((item) => item.id);
  const rightIds = rightItems.map((item) => item.id);
  assertPermutation(pairs.map((pair) => pair.leftId), leftIds, 'answerKey.pairs.leftId');
  assertPermutation(pairs.map((pair) => pair.rightId), rightIds, 'answerKey.pairs.rightId');
  return {
    content: { ...contentBase, leftItems, rightItems },
    answerKey: { pairs: pairs.sort((a, b) => a.leftId.localeCompare(b.leftId)) },
    validChoiceIds: [],
  };
}

function assertPermutation(actual, expected, label) {
  if (
    actual.length !== expected.length
    || new Set(actual).size !== actual.length
    || actual.some((id) => !expected.includes(id))
  ) {
    fail('invalid_answer_key', `${label} deve ser uma permutação completa dos itens.`);
  }
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isObject(value)) {
    return Object.keys(value).sort().reduce((result, key) => {
      result[key] = canonicalize(value[key]);
      return result;
    }, {});
  }
  return value;
}

function compileTypedQuestionDefinition(input) {
  assertKeys(input, {
    allowed: [
      'engineVersion',
      'formatVersion',
      'interactionType',
      'content',
      'scoring',
      'answerKey',
      'accessibility',
      'print',
      'feedback',
    ],
    required: ['interactionType', 'content', 'scoring', 'answerKey', 'accessibility', 'print'],
  }, 'definition');
  const engineVersion = input.engineVersion === undefined ? ENGINE_VERSION : input.engineVersion;
  const formatVersion = input.formatVersion === undefined ? FORMAT_VERSION : input.formatVersion;
  if (engineVersion !== ENGINE_VERSION || formatVersion !== FORMAT_VERSION) {
    fail('unsupported_definition_version', 'Apenas engineVersion 1 e formatVersion 1 são aceitos.');
  }
  if (!INTERACTION_TYPES.includes(input.interactionType)) {
    fail('unsupported_interaction_type', 'interactionType não é suportado.');
  }
  const scoring = normalizeScoring(input.scoring, input.interactionType);
  const normalizer = {
    single_choice: (value) => normalizeChoiceDefinition(value, false),
    true_false: normalizeTrueFalseDefinition,
    multiple_response: (value) => normalizeChoiceDefinition(value, true),
    numeric: normalizeNumericDefinition,
    fill_blank: normalizeFillBlankDefinition,
    ordering: normalizeOrderingDefinition,
    matching: normalizeMatchingDefinition,
  }[input.interactionType];
  const normalizedType = normalizer({ ...input, scoring });
  const definition = canonicalize({
    engineVersion,
    formatVersion,
    interactionType: input.interactionType,
    content: normalizedType.content,
    scoring,
    answerKey: normalizedType.answerKey,
    accessibility: normalizeAccessibility(input.accessibility, input.interactionType),
    print: normalizePrint(input.print, input.interactionType),
    feedback: normalizeFeedback(input.feedback, normalizedType.validChoiceIds),
  });
  const definitionJson = JSON.stringify(definition);
  const definitionHash = crypto.createHash('sha256').update(definitionJson).digest('hex');
  return {
    definition,
    definitionJson,
    definitionHash,
    metadata: {
      engineVersion,
      formatVersion,
      interactionType: input.interactionType,
      correctionMode: 'automatic',
      scoringStrategy: scoring.strategy,
      partialCredit: scoring.partialCredit,
      accessibilityReady: true,
      printSupported: true,
    },
  };
}

function parseStoredDefinition(value) {
  let parsed = value;
  if (typeof value === 'string') {
    try {
      parsed = JSON.parse(value);
    } catch {
      fail('invalid_stored_definition', 'A definição armazenada não contém JSON válido.');
    }
  }
  try {
    return compileTypedQuestionDefinition(parsed).definition;
  } catch (error) {
    if (error instanceof TypedQuestionEngineError) {
      fail('invalid_stored_definition', error.message, { sourceCode: error.code });
    }
    throw error;
  }
}

function assertResponseKeys(response, allowed, label = 'response') {
  if (!isObject(response)) fail('invalid_response', `${label} deve ser um objeto.`);
  const unexpected = Object.keys(response).filter((key) => !allowed.includes(key));
  if (unexpected.length > 0) {
    fail('invalid_response', `${label} possui campos não permitidos.`, { unexpected });
  }
}

function parseNumericResponse(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_response', 'A resposta numérica deve ser finita.');
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value !== 'string') {
    fail('invalid_response', 'A resposta numérica deve ser texto simples ou número.');
  }
  const normalized = value.trim();
  if (normalized === '') return null;
  if (!/^[+-]?(?:\d+(?:[.,]\d+)?|[.,]\d+)$/.test(normalized)) {
    fail(
      'invalid_response',
      'Use um número sem separador de milhar, expoente ou unidade.',
    );
  }
  const parsed = Number(normalized.replace(',', '.'));
  if (!Number.isFinite(parsed)) fail('invalid_response', 'A resposta numérica deve ser finita.');
  return Object.is(parsed, -0) ? 0 : parsed;
}

function normalizeTextAnswer(value, normalization) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'string' && typeof value !== 'number') {
    fail('invalid_response', 'A resposta de lacuna deve ser texto ou número.');
  }
  let normalized = String(value).trim().replace(/\s+/g, ' ');
  if (!normalization.accentSensitive) {
    normalized = normalized.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  }
  if (!normalization.caseSensitive) normalized = normalized.toLocaleLowerCase('pt-BR');
  return normalized;
}

function boundedScore(value) {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return Math.round(value * 1e12) / 1e12;
}

function buildScore(answered, score, details) {
  const normalizedScore = boundedScore(score);
  let feedbackKey = 'unanswered';
  if (answered) {
    if (normalizedScore === 1) feedbackKey = 'correct';
    else if (normalizedScore > 0) feedbackKey = 'partial';
    else feedbackKey = 'incorrect';
  }
  return {
    answered,
    score: normalizedScore,
    isCorrect: answered && normalizedScore === 1,
    requiresManualReview: false,
    feedbackKey,
    details,
  };
}

function scoreSingleChoice(definition, response) {
  assertResponseKeys(response, ['choiceId']);
  const choiceId = response.choiceId;
  if (choiceId === null || choiceId === undefined || choiceId === '') {
    return buildScore(false, 0, { selected: 0, total: 1 });
  }
  if (typeof choiceId !== 'string' || !definition.content.choices.some((item) => item.id === choiceId)) {
    fail('invalid_response', 'response.choiceId referencia alternativa inexistente.');
  }
  return buildScore(true, choiceId === definition.answerKey.choiceId ? 1 : 0, {
    selected: 1,
    total: 1,
  });
}

function scoreTrueFalse(definition, response) {
  assertResponseKeys(response, ['value']);
  if (response.value === null || response.value === undefined) {
    return buildScore(false, 0, { selected: 0, total: 1 });
  }
  if (typeof response.value !== 'boolean') {
    fail('invalid_response', 'response.value deve ser booleano.');
  }
  return buildScore(true, response.value === definition.answerKey.value ? 1 : 0, {
    selected: 1,
    total: 1,
  });
}

function scoreMultipleResponse(definition, response) {
  assertResponseKeys(response, ['choiceIds']);
  if (!Array.isArray(response.choiceIds)) {
    fail('invalid_response', 'response.choiceIds deve ser uma lista.');
  }
  const selected = response.choiceIds;
  assertUniqueResponse(selected, 'response.choiceIds');
  const validIds = definition.content.choices.map((choice) => choice.id);
  if (selected.some((id) => typeof id !== 'string' || !validIds.includes(id))) {
    fail('invalid_response', 'response.choiceIds referencia alternativa inexistente.');
  }
  if (selected.length === 0) {
    return buildScore(false, 0, { selected: 0, matched: 0, total: definition.answerKey.choiceIds.length });
  }
  const correctIds = definition.answerKey.choiceIds;
  const correctSelected = selected.filter((id) => correctIds.includes(id)).length;
  const incorrectSelected = selected.length - correctSelected;
  const exact = correctSelected === correctIds.length && incorrectSelected === 0;
  const score = definition.scoring.strategy === 'exact'
    ? (exact ? 1 : 0)
    : (correctSelected / correctIds.length)
      - (incorrectSelected / (validIds.length - correctIds.length));
  return buildScore(true, score, {
    selected: selected.length,
    matched: correctSelected,
    total: correctIds.length,
  });
}

function scoreNumeric(definition, response) {
  assertResponseKeys(response, ['value']);
  const value = parseNumericResponse(response.value);
  if (value === null) return buildScore(false, 0, { accepted: false, total: 1 });
  const key = definition.answerKey;
  let accepted = false;
  if (definition.scoring.strategy === 'numeric_exact') accepted = value === key.value;
  if (definition.scoring.strategy === 'numeric_absolute_tolerance') {
    accepted = Math.abs(value - key.value) <= key.tolerance;
  }
  if (definition.scoring.strategy === 'numeric_relative_tolerance') {
    accepted = Math.abs(value - key.value) <= Math.abs(key.value) * (key.tolerancePercent / 100);
  }
  if (definition.scoring.strategy === 'numeric_range') {
    const aboveMinimum = key.includeMinimum ? value >= key.minimum : value > key.minimum;
    const belowMaximum = key.includeMaximum ? value <= key.maximum : value < key.maximum;
    accepted = aboveMinimum && belowMaximum;
  }
  return buildScore(true, accepted ? 1 : 0, { accepted, total: 1 });
}

function scoreFillBlank(definition, response) {
  assertResponseKeys(response, ['answers']);
  if (!isObject(response.answers)) fail('invalid_response', 'response.answers deve ser um objeto.');
  const validIds = definition.content.blanks.map((blank) => blank.id);
  const suppliedIds = Object.keys(response.answers);
  if (suppliedIds.some((id) => !validIds.includes(id))) {
    fail('invalid_response', 'response.answers contém lacuna inexistente.');
  }
  const normalization = definition.answerKey.normalization;
  let answeredCount = 0;
  let matched = 0;
  for (const expected of definition.answerKey.answers) {
    const supplied = normalizeTextAnswer(response.answers[expected.blankId], normalization);
    if (supplied !== '') answeredCount += 1;
    const accepted = expected.acceptedAnswers
      .map((value) => normalizeTextAnswer(value, normalization));
    if (supplied !== '' && accepted.includes(supplied)) matched += 1;
  }
  const total = definition.answerKey.answers.length;
  if (answeredCount === 0) return buildScore(false, 0, { answeredCount: 0, matched: 0, total });
  const score = definition.scoring.strategy === 'exact'
    ? (matched === total ? 1 : 0)
    : matched / total;
  return buildScore(true, score, { answeredCount, matched, total });
}

function scoreOrdering(definition, response) {
  assertResponseKeys(response, ['orderedItemIds']);
  if (!Array.isArray(response.orderedItemIds)) {
    fail('invalid_response', 'response.orderedItemIds deve ser uma lista.');
  }
  if (response.orderedItemIds.length === 0) {
    return buildScore(false, 0, { matched: 0, total: definition.answerKey.orderedItemIds.length });
  }
  assertResponsePermutation(
    response.orderedItemIds,
    definition.content.items.map((item) => item.id),
    'response.orderedItemIds',
  );
  const matched = response.orderedItemIds.filter(
    (id, index) => id === definition.answerKey.orderedItemIds[index],
  ).length;
  const total = definition.answerKey.orderedItemIds.length;
  const score = definition.scoring.strategy === 'exact'
    ? (matched === total ? 1 : 0)
    : matched / total;
  return buildScore(true, score, { matched, total });
}

function scoreMatching(definition, response) {
  assertResponseKeys(response, ['pairs']);
  if (!Array.isArray(response.pairs)) fail('invalid_response', 'response.pairs deve ser uma lista.');
  const total = definition.answerKey.pairs.length;
  if (response.pairs.length === 0) return buildScore(false, 0, { matched: 0, total });
  const pairs = response.pairs.map((pair, index) => {
    if (!isObject(pair)) fail('invalid_response', `response.pairs[${index}] deve ser objeto.`);
    const unexpected = Object.keys(pair).filter((key) => !['leftId', 'rightId'].includes(key));
    if (unexpected.length > 0 || typeof pair.leftId !== 'string' || typeof pair.rightId !== 'string') {
      fail('invalid_response', `response.pairs[${index}] é inválido.`);
    }
    return { leftId: pair.leftId, rightId: pair.rightId };
  });
  assertResponsePermutation(
    pairs.map((pair) => pair.leftId),
    definition.content.leftItems.map((item) => item.id),
    'response.pairs.leftId',
  );
  assertResponsePermutation(
    pairs.map((pair) => pair.rightId),
    definition.content.rightItems.map((item) => item.id),
    'response.pairs.rightId',
  );
  const expected = new Map(definition.answerKey.pairs.map((pair) => [pair.leftId, pair.rightId]));
  const matched = pairs.filter((pair) => expected.get(pair.leftId) === pair.rightId).length;
  const score = definition.scoring.strategy === 'exact'
    ? (matched === total ? 1 : 0)
    : matched / total;
  return buildScore(true, score, { matched, total });
}

function assertUniqueResponse(values, label) {
  if (new Set(values).size !== values.length) {
    fail('invalid_response', `${label} não pode conter itens duplicados.`);
  }
}

function assertResponsePermutation(actual, expected, label) {
  if (
    actual.length !== expected.length
    || new Set(actual).size !== actual.length
    || actual.some((id) => typeof id !== 'string' || !expected.includes(id))
  ) {
    fail('invalid_response', `${label} deve ser uma permutação completa dos itens.`);
  }
}

function scoreTypedQuestionResponse(storedDefinition, response) {
  const definition = parseStoredDefinition(storedDefinition);
  const scorer = {
    single_choice: scoreSingleChoice,
    true_false: scoreTrueFalse,
    multiple_response: scoreMultipleResponse,
    numeric: scoreNumeric,
    fill_blank: scoreFillBlank,
    ordering: scoreOrdering,
    matching: scoreMatching,
  }[definition.interactionType];
  return scorer(definition, response);
}

module.exports = {
  ENGINE_VERSION,
  FORMAT_VERSION,
  INTERACTION_TYPES,
  STRATEGIES_BY_TYPE,
  TypedQuestionEngineError,
  compileTypedQuestionDefinition,
  scoreTypedQuestionResponse,
};
