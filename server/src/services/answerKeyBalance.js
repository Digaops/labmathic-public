const crypto = require('node:crypto');

const OPTION_LABELS = Object.freeze(['A', 'B', 'C', 'D']);
const OPTION_ORDER_PATTERN = /^(?!.*(.).*\1)[ABCD]{4}$/;

class AnswerKeyBalanceError extends Error {
  constructor(message, questionId = null) {
    super(message);
    this.name = 'AnswerKeyBalanceError';
    this.questionId = questionId;
  }
}

function stableDigest(seed, value) {
  return crypto.createHash('sha256').update(`${seed}:${value}`).digest('hex');
}

function deterministicOrder(values, seed, identity = (value) => String(value)) {
  return [...values]
    .map((value, index) => ({
      value,
      index,
      rank: stableDigest(seed, `${identity(value)}:${index}`),
    }))
    .sort((left, right) => left.rank.localeCompare(right.rank) || left.index - right.index)
    .map(({ value }) => value);
}

function normalizeOptionOrder(value) {
  const normalized = String(value || '').toUpperCase();
  return OPTION_ORDER_PATTERN.test(normalized) ? normalized : null;
}

function correctDisplayTargets(questionCount, seed) {
  const offset = Number.parseInt(stableDigest(seed, 'offset').slice(0, 8), 16)
    % OPTION_LABELS.length;
  const pool = Array.from({ length: questionCount }, (_, index) => ({
    label: OPTION_LABELS[(index + offset) % OPTION_LABELS.length],
    token: index,
  }));
  return deterministicOrder(pool, `${seed}:targets`, ({ label, token }) => `${label}:${token}`)
    .map(({ label }) => label);
}

function optionLabel(option) {
  return String(option?.label ?? option?.option_label ?? '').toUpperCase();
}

function optionIsCorrect(option) {
  return option?.isCorrect === true
    || option?.isCorrect === 1
    || option?.is_correct === true
    || option?.is_correct === 1;
}

function validateEntry(entry) {
  const options = Array.isArray(entry?.options) ? entry.options : [];
  const labels = options.map(optionLabel);
  const correct = options.filter(optionIsCorrect);
  if (
    options.length !== OPTION_LABELS.length
    || new Set(labels).size !== OPTION_LABELS.length
    || !OPTION_LABELS.every((label) => labels.includes(label))
    || correct.length !== 1
  ) {
    throw new AnswerKeyBalanceError(
      'A questão precisa ter quatro alternativas (A–D) e um único gabarito.',
      entry?.id || null
    );
  }
}

function createBalancedOptionOrders(entries, seed) {
  if (!Array.isArray(entries) || entries.length === 0) return new Map();
  entries.forEach(validateEntry);
  const targets = correctDisplayTargets(entries.length, seed);
  return new Map(entries.map((entry, index) => {
    const correctSourceLabel = optionLabel(entry.options.find(optionIsCorrect));
    const targetIndex = OPTION_LABELS.indexOf(targets[index]);
    const remaining = deterministicOrder(
      entry.options.map(optionLabel).filter((label) => label !== correctSourceLabel),
      `${seed}:question:${entry.id}:distractors`
    );
    const sourceLabelsByDisplayPosition = new Array(OPTION_LABELS.length);
    sourceLabelsByDisplayPosition[targetIndex] = correctSourceLabel;
    let remainingIndex = 0;
    for (let displayIndex = 0; displayIndex < sourceLabelsByDisplayPosition.length; displayIndex += 1) {
      if (displayIndex === targetIndex) continue;
      sourceLabelsByDisplayPosition[displayIndex] = remaining[remainingIndex];
      remainingIndex += 1;
    }
    return [entry.id, sourceLabelsByDisplayPosition.join('')];
  }));
}

function applyOptionOrder(options, optionOrder, {
  labelKey = 'option_label',
  sortOrderKey = 'sort_order',
  sortOrderStart = 1,
} = {}) {
  const normalizedOrder = normalizeOptionOrder(optionOrder);
  if (!normalizedOrder) {
    throw new AnswerKeyBalanceError('A ordem das alternativas é inválida.');
  }
  const optionBySourceLabel = new Map(options.map((option) => [optionLabel(option), option]));
  if (optionBySourceLabel.size !== OPTION_LABELS.length) {
    throw new AnswerKeyBalanceError('As alternativas da questão estão incompletas.');
  }
  return [...normalizedOrder].map((sourceLabel, index) => ({
    ...optionBySourceLabel.get(sourceLabel),
    [labelKey]: OPTION_LABELS[index],
    [sortOrderKey]: index + sortOrderStart,
  }));
}

function answerKeySummary(entries) {
  const counts = Object.fromEntries(OPTION_LABELS.map((label) => [label, 0]));
  entries.forEach((entry) => {
    const correct = entry.options.find(optionIsCorrect);
    if (correct) counts[optionLabel(correct)] += 1;
  });
  const questionCount = entries.length;
  const maxCount = Math.max(0, ...Object.values(counts));
  const maxAllowed = questionCount <= 1
    ? 1
    : Math.max(1, Math.ceil(questionCount / 2) - 1);
  return {
    questionCount,
    counts,
    maxCount,
    maxAllowed,
    balanced: maxCount <= maxAllowed,
    methodology: 'balanced-answer-key-v1',
  };
}

function loadQuestionOptionEntries(database, questionIds) {
  if (!Array.isArray(questionIds) || questionIds.length === 0) return [];
  const placeholders = questionIds.map(() => '?').join(',');
  const rows = database.prepare(`
    SELECT question_id, option_label, is_correct, sort_order, id
    FROM question_options
    WHERE question_id IN (${placeholders})
    ORDER BY question_id, sort_order, id
  `).all(...questionIds);
  const optionsByQuestion = new Map(questionIds.map((questionId) => [questionId, []]));
  rows.forEach((option) => optionsByQuestion.get(option.question_id)?.push(option));
  return questionIds.map((questionId) => ({
    id: questionId,
    options: optionsByQuestion.get(questionId) || [],
  }));
}

function createQuestionSetOptionOrders(database, questionItems, seed) {
  const questionIds = questionItems.map(({ question_id: questionId }) => questionId);
  return createBalancedOptionOrders(loadQuestionOptionEntries(database, questionIds), seed);
}

module.exports = {
  OPTION_LABELS,
  AnswerKeyBalanceError,
  answerKeySummary,
  applyOptionOrder,
  createBalancedOptionOrders,
  createQuestionSetOptionOrders,
  loadQuestionOptionEntries,
  normalizeOptionOrder,
};
