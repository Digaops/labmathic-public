// Provider-independent preparation. No model, key, paid call or automatic publication.
function prepareAuthoringBrief(input, curriculum) {
  const allowed = ['mode', 'gradeId', 'academicYear', 'unitId', 'skillIds', 'teacherText', 'privacyConfirmed'];
  if (!input || Object.keys(input).some(key => !allowed.includes(key))
    || !['new_question', 'complement', 'image_brief'].includes(input.mode)
    || !Number.isSafeInteger(input.gradeId) || !Number.isSafeInteger(input.unitId)
    || !Number.isInteger(input.academicYear) || input.academicYear < 2000 || input.academicYear > 2100
    || input.privacyConfirmed !== true || !Array.isArray(input.skillIds)
    || input.skillIds.length < 1 || input.skillIds.length > 3
    || input.skillIds.some(id => !Number.isSafeInteger(id) || id <= 0)
    || new Set(input.skillIds).size !== input.skillIds.length) throw new Error('Confira ano escolar, ano letivo, unidade e habilidades.');
  const text = typeof input.teacherText === 'string' ? input.teacherText.trim() : '';
  if (text.length > 4000 || (input.mode !== 'new_question' && !text)
    || privateOrUnsafeText(text)) throw new Error('Revise o texto e não inclua dados pessoais.');
  const grade = curriculum.grades.find(g => g.id === input.gradeId);
  const unit = curriculum.units.find(u => u.id === input.unitId);
  const skills = input.skillIds.map(id => curriculum.skills.find(s => s.id === id));
  if (!grade || !unit || skills.some(s => !s || s.grade_id !== grade.id || s.unit_id !== unit.id)) {
    throw new Error('Habilidade não pertence ao ano escolar e à unidade selecionados.');
  }
  return { version: 1, mode: input.mode, academicYear: input.academicYear,
    grade: { id: grade.id, name: grade.name }, unit: { id: unit.id, name: unit.name },
    skills: skills.map(s => ({ id: s.id, code: s.code, description: s.description })),
    teacherText: text, status: 'prepared_not_generated', requiresTeacherReview: true };
}
function validateQuestionSuggestion(value, brief) {
  const fields = ['statement', 'options', 'explanation', 'skillIds', 'gradeId', 'unitId', 'academicYear'];
  if (!value || Object.keys(value).some(key => !fields.includes(key))
    || value.gradeId !== brief.grade.id || value.unitId !== brief.unit.id || value.academicYear !== brief.academicYear
    || !Array.isArray(value.skillIds) || value.skillIds.length !== brief.skills.length
    || new Set(value.skillIds).size !== value.skillIds.length
    || value.skillIds.some(id => !brief.skills.some(s => s.id === id))
    || !Array.isArray(value.options) || value.options.length !== 4
    || value.options.some(o => !o || Object.keys(o).some(k => !['text', 'correct'].includes(k)) || typeof o.correct !== 'boolean')
    || value.options.filter(o => o.correct).length !== 1) throw new Error('Sugestão não corresponde ao pedido pedagógico.');
  const texts = [value.statement, value.explanation, ...value.options.map(o => o.text)];
  if (texts.some(t => typeof t !== 'string' || !t.trim() || t.length > 6000 || privateOrUnsafeText(t))
    || new Set(value.options.map(o => o.text.trim().toLocaleLowerCase('pt-BR'))).size !== 4) {
    throw new Error('Revise enunciado, alternativas e explicação.');
  }
  // Structural validity is not factual correctness or proof of BNCC alignment.
  return { ...value, status: 'awaiting_teacher_review', reviewed: false, publishable: false };
}
module.exports = { prepareAuthoringBrief, validateQuestionSuggestion };

// Heuristics only, not a complete personal-data detector. Human privacy confirmation remains required.
function privateOrUnsafeText(text) {
  return /[\w.+-]+@[\w.-]+\.[a-z]{2,}/i.test(text) || /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(text)
    || /\(\d{2}\)\s?9?\d{4}[- ]\d{4}\b/.test(text) || /<[^>]+>|[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text);
}
