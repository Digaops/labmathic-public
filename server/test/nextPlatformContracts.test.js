const test = require('node:test');
const assert = require('node:assert/strict');
const indicators = require('../src/services/municipalIndicatorsContract');
const ai = require('../src/services/aiAuthoringContract');
const row = { indicator: 'ideb', ibgeCode: '2306405', network: 'municipal', stage: 'elementary_initial',
  referenceYear: 2023, status: 'published', value: 5.8, methodologyVersion: 'fixture-v1', territoryVersion: 'fixture-2023',
  sourceUrl: indicators.catalog.ideb.source, retrievedAt: '2026-09-14T12:00:00Z', artifactSha256: 'a'.repeat(64) };
const curriculum = { grades: [{ id: 7, name: '7º Ano' }], units: [{ id: 1, name: 'Números' }],
  skills: [{ id: 10, code: 'EF07MA01', description: 'Descrição sintética para validar vínculo', grade_id: 7, unit_id: 1 },
    { id: 11, code: 'EF08MA01', description: 'Outro ano', grade_id: 8, unit_id: 1 }] };
const input = { mode: 'new_question', gradeId: 7, unitId: 1, academicYear: 2026, skillIds: [10], privacyConfirmed: true, teacherText: 'Situação cotidiana com números.' };

test('indicadores municipais exigem recorte, procedência, período e valor coerentes', () => {
  assert.equal(indicators.normalizeMunicipalIndicator(row).value, 5.8);
  assert.equal(indicators.normalizeMunicipalIndicator({ ...row, value: 0 }).value, 0);
  assert.equal(indicators.normalizeMunicipalIndicator({ ...row, status: 'not_published', value: null }).value, null);
  for (const patch of [{ network: 'state' }, { value: 11 }, { value: '5.8' }, { status: 'not_published', value: 0 },
    { ibgeCode: '230640' }, { artifactSha256: '' }, { sourceUrl: 'http://localhost/admin' }, { referenceYear: '2023' }]) {
    assert.throws(() => indicators.normalizeMunicipalIndicator({ ...row, ...patch }));
  }
});
test('comparação não mistura município, etapa, metodologia, território ou ausência', () => {
  const after = { ...row, referenceYear: 2025, value: 6 };
  assert.equal(indicators.compareMunicipalIndicators(row, after).change, 0.2);
  for (const patch of [{ ibgeCode: '3550308' }, { stage: 'elementary_final' }, { methodologyVersion: 'v2' },
    { territoryVersion: 'different' }, { status: 'suppressed', value: null }, { referenceYear: 2023 }]) {
    assert.deepEqual(indicators.compareMunicipalIndicators(row, { ...after, ...patch }), { comparable: false, change: null });
  }
});
test('briefing de IA usa catálogo confiável e distingue ano escolar de ano letivo', () => {
  const brief = ai.prepareAuthoringBrief(input, curriculum);
  assert.equal(brief.grade.id, 7); assert.equal(brief.academicYear, 2026);
  assert.equal(brief.skills[0].code, 'EF07MA01'); assert.equal(brief.status, 'prepared_not_generated');
  for (const patch of [{ skillIds: [11] }, { skillIds: [10, 10] }, { unitId: 2 }, { academicYear: '7º ano' },
    { privacyConfirmed: false }, { student: { name: 'Não enviar' } }, { teacherText: 'nome@example.org' }, { skillIds: [999] }]) {
    assert.throws(() => ai.prepareAuthoringBrief({ ...input, ...patch }, curriculum));
  }
  assert.equal(ai.prepareAuthoringBrief({ ...input, mode: 'image_brief' }, curriculum).mode, 'image_brief');
  assert.throws(() => ai.prepareAuthoringBrief({ ...input, mode: 'complement', teacherText: '' }, curriculum));
});
test('sugestão estruturada nunca se publica e não altera habilidade, ano ou unidade', () => {
  const brief = ai.prepareAuthoringBrief(input, curriculum);
  const suggestion = { statement: 'Questão sintética', explanation: 'Explicação para revisão', gradeId: 7, unitId: 1, academicYear: 2026,
    skillIds: [10], options: ['A', 'B', 'C', 'D'].map((text, i) => ({ text, correct: i === 1 })) };
  const accepted = ai.validateQuestionSuggestion(suggestion, brief);
  assert.equal(accepted.publishable, false); assert.equal(accepted.reviewed, false);
  for (const patch of [{ skillIds: [11] }, { gradeId: 8 }, { academicYear: 2027 }, { unitId: 2 }, { imageUrl: 'http://localhost' },
    { statement: '<script>alert(1)</script>' }, { options: suggestion.options.map(o => ({ ...o, correct: true })) }]) {
    assert.throws(() => ai.validateQuestionSuggestion({ ...suggestion, ...patch }, brief));
  }
});
