const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/quickActivityView.mjs');
test('choosing a class preserves a pending activity but never carries it to another class', async () => {
  const { classSelectionChange } = await import('../../client/src/services/classesView.mjs');
  assert.deepEqual(classSelectionChange({ id: '', source: '42' }, 'turma'), { turma: 'turma', secao: 'avaliacoes', simulado: '42' });
  for (const query of [{ id: 'other', source: '42' }, { id: '', source: '-1' }, { id: '', source: 'invalid' }])
    assert.deepEqual(classSelectionChange(query, 'turma'), { turma: 'turma', secao: null, simulado: null });
});
function question(id = 1) { return { id, grade_id: 7, skill_id: 2, skill_code: 'EF07MA02', question_type: 'multiple_choice', quick_compatible: true }; }
test('quick activity accepts one to five questions and rejects mixed or unknown selections', async () => {
  const { quickActivityError: check } = await model;
  assert.equal(check([question()]), '');
  assert.equal(check(Array.from({ length: 5 }, (_, i) => question(i + 1))), '');
  for (const input of [[], [null], [question(), question()], Array.from({ length: 6 }, (_, i) => question(i + 1)),
    [question(), { ...question(2), skill_id: 3 }], [question(), { ...question(2), grade_id: 8 }], [{ ...question(), question_type: 'numeric' }],
    [{ ...question(), quick_compatible: false }], [{ ...question(), grade_id: undefined }]]) assert.ok(check(input));
});
test('quick activity validates alternatives before adding and suggests an editable title', async () => {
  const { quickActivityQuestion: metadata, quickActivityTitle } = await model;
  const source = { ...question(), status: 'active', options: ['A', 'B', 'C', 'D'].map((option_label, i) => ({ option_label, is_correct: Number(i === 0) })) };
  assert.equal(metadata(source).quick_compatible, true);
  assert.equal(metadata({ ...source, status: 'inactive' }).quick_compatible, false);
  assert.equal(metadata({ ...source, options: source.options.slice(0, 3) }).quick_compatible, false);
  assert.equal(metadata({ ...source, options: source.options.map(o => ({ ...o, is_correct: 1 })) }).quick_compatible, false);
  assert.equal(quickActivityTitle([question()]), 'Atividade rápida — EF07MA02');
});
test('guided activity reuses private set creation and does not auto-apply or auto-print', () => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/QuestionBank.jsx'), 'utf8');
  assert.match(source, /user\?\.role === 'professor' && searchParams.get\('atividade'\) === 'rapida'/);
  assert.match(source, /quickActivity && quickActivityError\(selectedQuestions\)/);
  assert.match(source, /api.post\('\/question-bank\/question-sets'/);
  assert.match(source, /setUncertain/);
  assert.match(source, /context\.classId/);
  assert.match(source, /navigate\(`\/simulados\/\$\{createdId\}/);
});
