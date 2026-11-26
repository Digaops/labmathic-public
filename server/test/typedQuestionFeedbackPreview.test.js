const test = require('node:test');
const assert = require('node:assert/strict');

const {
  TypedQuestionFeedbackPreviewError,
  getFeedbackPreviewCatalog,
  getFeedbackPreviewExample,
} = require('../src/services/typedQuestionFeedbackPreview');

const FORBIDDEN_WHEN_PROTECTED = /answerKey|referenceAnswer|resolutionSteps|misconception|nextStep|choiceInsights|"score"|isCorrect|feedbackKey/;

test('catálogo descreve três exemplos sem gabarito ou guia pedagógico', () => {
  const catalog = getFeedbackPreviewCatalog();
  assert.equal(catalog.mode, 'feedback_preview');
  assert.equal(catalog.readOnly, true);
  assert.equal(catalog.examples.length, 3);
  assert.deepEqual(catalog.examples.map((example) => example.releasePolicy), [
    'after_submission',
    'after_assessment_close',
    'teacher_only',
  ]);
  assert.doesNotMatch(JSON.stringify(catalog), FORBIDDEN_WHEN_PROTECTED);
});

test('servidor aplica a matriz de liberação sem depender do cliente', () => {
  const before = getFeedbackPreviewExample('fraction-half-feedback', 'before_submission');
  assert.equal(before.feedback.available, false);
  assert.equal(before.example.response, null);
  assert.doesNotMatch(JSON.stringify(before), FORBIDDEN_WHEN_PROTECTED);

  const fractionSubmitted = getFeedbackPreviewExample('fraction-half-feedback', 'after_submission');
  assert.equal(fractionSubmitted.feedback.available, true);
  assert.equal(fractionSubmitted.feedback.guide.referenceAnswer, '1/2');
  assert.deepEqual(fractionSubmitted.feedback.guide.choiceInsights, []);

  const multipleSubmitted = getFeedbackPreviewExample('even-numbers-feedback', 'after_submission');
  assert.equal(multipleSubmitted.feedback.available, false);
  assert.doesNotMatch(JSON.stringify(multipleSubmitted), FORBIDDEN_WHEN_PROTECTED);

  const multipleClosed = getFeedbackPreviewExample('even-numbers-feedback', 'assessment_closed');
  assert.equal(multipleClosed.feedback.available, true);
  assert.equal(multipleClosed.feedback.evidence.score, 0.5);

  const teacherOnlyClosed = getFeedbackPreviewExample('square-perimeter-feedback', 'assessment_closed');
  assert.equal(teacherOnlyClosed.feedback.available, false);
  assert.doesNotMatch(JSON.stringify(teacherOnlyClosed), FORBIDDEN_WHEN_PROTECTED);

  const teacherView = getFeedbackPreviewExample('fraction-half-feedback', 'teacher');
  assert.equal(teacherView.feedback.available, true);
  assert.equal(teacherView.feedback.guide.choiceInsights.length, 4);
});

test('cenários e exemplos desconhecidos falham de forma explícita', () => {
  assert.throws(
    () => getFeedbackPreviewExample('fraction-half-feedback', 'invented'),
    (error) => error instanceof TypedQuestionFeedbackPreviewError
      && error.code === 'invalid_preview_view'
      && error.status === 400,
  );
  assert.throws(
    () => getFeedbackPreviewExample('missing-example', 'teacher'),
    (error) => error instanceof TypedQuestionFeedbackPreviewError
      && error.code === 'preview_example_not_found'
      && error.status === 404,
  );
});
