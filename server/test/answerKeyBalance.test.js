const assert = require('node:assert/strict');
const test = require('node:test');
const {
  AnswerKeyBalanceError,
  answerKeySummary,
  applyOptionOrder,
  createBalancedOptionOrders,
} = require('../src/services/answerKeyBalance');

function entries(count, correctLabel = 'A') {
  return Array.from({ length: count }, (_, questionIndex) => ({
    id: questionIndex + 1,
    options: ['A', 'B', 'C', 'D'].map((label) => ({
      option_label: label,
      option_text: `Questão ${questionIndex + 1} · ${label}`,
      is_correct: label === correctLabel ? 1 : 0,
      sort_order: label.charCodeAt(0) - 64,
    })),
  }));
}

function presentedEntries(sourceEntries, orders) {
  return sourceEntries.map((entry) => ({
    id: entry.id,
    options: applyOptionOrder(entry.options, orders.get(entry.id)),
  }));
}

test('equilibra dez questões mesmo quando todos os gabaritos de origem são A', () => {
  const source = entries(10, 'A');
  const orders = createBalancedOptionOrders(source, 'simulado-10');
  const summary = answerKeySummary(presentedEntries(source, orders));

  assert.equal(summary.questionCount, 10);
  assert.equal(summary.balanced, true);
  assert.equal(summary.maxAllowed, 4);
  assert.ok(summary.maxCount <= 3);
  assert.equal(Object.values(summary.counts).reduce((sum, value) => sum + value, 0), 10);
});

test('ordem é determinística para o mesmo simulado e não altera o conteúdo correto', () => {
  const source = entries(17, 'A');
  const first = createBalancedOptionOrders(source, 'simulado-estavel');
  const second = createBalancedOptionOrders(source, 'simulado-estavel');

  assert.deepEqual([...first], [...second]);
  presentedEntries(source, first).forEach((entry) => {
    const correct = entry.options.find(({ is_correct: isCorrect }) => isCorrect === 1);
    assert.match(correct.option_text, /· A$/);
  });
});

test('mantém a melhor distribuição possível também em simulados pequenos', () => {
  for (const count of [1, 2, 3, 4]) {
    const source = entries(count, 'D');
    const orders = createBalancedOptionOrders(source, `simulado-${count}`);
    const summary = answerKeySummary(presentedEntries(source, orders));
    assert.equal(summary.balanced, true);
    assert.ok(summary.maxCount <= 1);
  }
});

test('recusa questão incompleta ou com mais de um gabarito', () => {
  assert.throws(
    () => createBalancedOptionOrders([{ id: 99, options: entries(1)[0].options.slice(0, 3) }], 'inválido'),
    AnswerKeyBalanceError
  );
  const duplicatedCorrect = entries(1)[0];
  duplicatedCorrect.options[1].is_correct = 1;
  assert.throws(
    () => createBalancedOptionOrders([duplicatedCorrect], 'inválido'),
    /um único gabarito/
  );
});
