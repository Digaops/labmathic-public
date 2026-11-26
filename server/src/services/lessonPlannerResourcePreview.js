const { LessonPlannerError } = require('./lessonPlanner');
const { AnswerKeyBalanceError, applyOptionOrder, createQuestionSetOptionOrders, normalizeOptionOrder } = require('./answerKeyBalance');

const TYPES = new Set(['material', 'question', 'question_set']);
const MAX_QUESTIONS = 100;
const unavailable = () => { throw new LessonPlannerError(404, 'resource_unavailable', 'O recurso não está disponível para consulta.'); };
const needsReview = () => { throw new LessonPlannerError(409, 'preview_requires_review', 'Não foi possível conferir este recurso. Ele precisa de revisão antes de ser visualizado.'); };

function questionIsVisible(question, teacherId) {
  return question?.id && question.status === 'active' && question.question_type === 'multiple_choice'
    && (question.source === 'official' || (question.source === 'teacher' && question.created_by === teacherId))
    && question.skillCode && question.skillDescription;
}

const questionColumns = `question.id, question.question_code AS code, question.statement,
  question.support_text AS supportText, question.image_path AS imagePath,
  question.status, question.question_type, question.source, question.created_by,
  skill.code AS skillCode, skill.description AS skillDescription`;

function presentQuestions(database, questions, setId = null) {
  if (!questions.length) needsReview();
  const placeholders = questions.map(() => '?').join(',');
  const rows = database.prepare(`SELECT question_id, option_label, option_text, is_correct, sort_order
    FROM question_options WHERE question_id IN (${placeholders})
    ORDER BY question_id, sort_order, option_label`).all(...questions.map(question => question.id));
  const optionsById = new Map(questions.map(question => [question.id, []]));
  for (const option of rows) optionsById.get(option.question_id).push(option);
  for (const question of questions) {
    const options = optionsById.get(question.id);
    if (options.length !== 4 || new Set(options.map(option => option.option_label)).size !== 4
        || options.some(option => !['A', 'B', 'C', 'D'].includes(option.option_label))
        || options.filter(option => option.is_correct === 1).length !== 1) needsReview();
  }
  let orders = null;
  if (setId !== null) {
    // Match the canonical set reader, including deterministic legacy fallback.
    orders = questions.every(question => normalizeOptionOrder(question.option_order))
      ? new Map(questions.map(question => [question.id, question.option_order]))
      : createQuestionSetOptionOrders(database, questions.map(question => ({ question_id: question.id })), `question-set:${setId}`);
  }
  return questions.map(question => {
    const options = optionsById.get(question.id);
    const presented = orders ? applyOptionOrder(options, orders.get(question.id)) : options;
    // Project explicitly: neither answer flags, explanations nor author data leave this reader.
    return {
      id: question.id, code: question.code, statement: question.statement,
      supportText: question.supportText, imagePath: question.show_image === 0 ? null : question.imagePath,
      skillCode: question.skillCode, skillDescription: question.skillDescription,
      options: presented.map(option => ({ label: option.option_label, text: option.option_text })),
    };
  });
}

function loadPreview(database, teacherId, type, id) {
  if (type === 'material') {
    const material = database.prepare(`SELECT material.id, material.title, material.description,
      material.file_path, material.file_format, material.external_url, material.duration, material.page_count,
      type.name AS material_type_name, grade.name AS grade_name, discipline.name AS discipline_name
      FROM materials material
      LEFT JOIN material_types type ON type.id = material.material_type_id
      LEFT JOIN grades grade ON grade.id = material.grade_id
      LEFT JOIN disciplines discipline ON discipline.id = material.discipline_id
      WHERE material.id = ?`).get(id);
    if (!material) unavailable();
    return { type, id, title: material.title, material };
  }
  if (type === 'question') {
    const question = database.prepare(`SELECT ${questionColumns}
      FROM questions question LEFT JOIN bncc_skills skill ON skill.id = question.skill_id
      WHERE question.id = ?`).get(id);
    if (!questionIsVisible(question, teacherId)) unavailable();
    return { type, id, title: question.code, questions: presentQuestions(database, [question]) };
  }
  const set = database.prepare(`SELECT id, title FROM question_sets
    WHERE id = ? AND (user_id = ? OR (is_public = 1 AND contains_author_questions != 1))`).get(id, teacherId);
  if (!set) unavailable();
  const count = database.prepare('SELECT COUNT(*) FROM question_set_items WHERE question_set_id = ?').pluck().get(id);
  if (count > MAX_QUESTIONS) {
    throw new LessonPlannerError(409, 'preview_limit_exceeded', `Este simulado excede o limite de ${MAX_QUESTIONS} questões da prévia.`);
  }
  const questions = database.prepare(`SELECT ${questionColumns}, item.show_image, item.option_order
    FROM question_set_items item
    LEFT JOIN questions question ON question.id = item.question_id
    LEFT JOIN bncc_skills skill ON skill.id = question.skill_id
    WHERE item.question_set_id = ? ORDER BY item.sort_order, question.question_code, item.id`).all(id);
  // Do not silently turn an inaccessible or incomplete set into a partial preview.
  if (questions.some(question => !questionIsVisible(question, teacherId))) unavailable();
  return { type, id, title: set.title, questions: presentQuestions(database, questions, id) };
}

function previewLessonPlannerResource(database, teacherId, type, value) {
  if (!TYPES.has(type) || typeof value !== 'string' || !/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new LessonPlannerError(400, 'invalid_resource_preview', 'Confira o recurso solicitado.');
  }
  try { return database.transaction(() => loadPreview(database, teacherId, type, Number(value))).deferred(); }
  catch (error) { if (error instanceof AnswerKeyBalanceError) needsReview(); throw error; }
}

module.exports = { previewLessonPlannerResource };
