const { LessonPlannerError } = require('./lessonPlanner');
const { eligibleMaterialSkill } = require('./materialSkillEligibility');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('./questionEditorialCuration');

const PAGE_SIZE = 20;
const CATEGORIES = new Set(['materials', 'questions', 'questionSets']);
const searchConnections = new WeakSet();
const normalizeSearch = value => String(value || '').normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase('pt-BR');

function invalid(message = 'Confira os filtros da busca de recursos.') {
  throw new LessonPlannerError(400, 'invalid_catalog_query', message);
}

function integer(value) {
  if (typeof value !== 'string' || !/^[1-9]\d*$/.test(value)
      || !Number.isSafeInteger(Number(value))) invalid();
  return Number(value);
}

function normalizeQuery(database, query) {
  if (typeof query.category !== 'string' || !CATEGORIES.has(query.category)) invalid('Selecione uma categoria de recurso.');
  const page = query.page === undefined ? 1 : integer(query.page);
  if (page > 1000000) invalid();
  if (query.search !== undefined && (typeof query.search !== 'string' || query.search.length > 100)) {
    invalid('A busca deve ter no máximo 100 caracteres.');
  }
  if (typeof query.skillIds !== 'string') invalid('Selecione de uma a dez habilidades.');
  const rawSkills = query.skillIds.split(',');
  if (rawSkills.length < 1 || rawSkills.length > 10) invalid('Selecione de uma a dez habilidades.');
  const skillIds = [...new Set(rawSkills.map(integer))];
  const placeholders = skillIds.map(() => '?').join(', ');
  if (database.prepare(`SELECT COUNT(*) FROM bncc_skills WHERE id IN (${placeholders})`).pluck().get(...skillIds) !== skillIds.length) {
    invalid('Há uma habilidade indisponível na busca.');
  }
  const gradeId = query.gradeId === undefined ? null : integer(query.gradeId);
  const disciplineId = query.disciplineId === undefined ? null : integer(query.disciplineId);
  if (gradeId && !database.prepare('SELECT 1 FROM grades WHERE id = ?').get(gradeId)) invalid('Ano escolar inválido.');
  if (disciplineId && !database.prepare('SELECT 1 FROM disciplines WHERE id = ?').get(disciplineId)) invalid('Componente curricular inválido.');
  const search = normalizeSearch((query.search || '').trim());
  // LIKE metacharacters are always literal text supplied by the teacher.
  const searchTerm = `%${search.replace(/[\\%_]/g, '\\$&')}%`;
  return { category: query.category, page, skillIds, placeholders, gradeId, disciplineId, search, searchTerm };
}

function resourceQuery(teacherId, query, pilotEnabled) {
  const { category, skillIds, placeholders, gradeId, disciplineId, search, searchTerm } = query;
  if (category === 'questions') {
    return {
      selection: `SELECT question.id, question.question_code AS code, question.statement AS title,
        question.difficulty, skill.code AS skillCode`,
      source: `FROM questions question JOIN bncc_skills skill ON skill.id = question.skill_id
        WHERE question.status = 'active' AND question.skill_id IN (${placeholders})
          AND ${editorialEligibleSql('question', { pilotEnabled })}
          AND (question.source = 'official' OR question.created_by = ?)
          AND (? = '' OR lesson_planner_search(question.statement || ' ' || question.question_code) LIKE ? ESCAPE '\\')
          AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id) = 4
          AND (SELECT COUNT(*) FROM question_options option WHERE option.question_id = question.id AND option.is_correct = 1) = 1`,
      order: `CASE question.difficulty WHEN 'facil' THEN 1 WHEN 'media' THEN 2 ELSE 3 END,
        question.question_code, question.id`,
      params: [...skillIds, teacherId, search, searchTerm],
    };
  }
  if (category === 'questionSets') {
    return {
      selection: `SELECT question_set.id, question_set.title, COUNT(DISTINCT item.question_id) AS questionCount`,
      source: `FROM question_sets question_set
        JOIN question_set_items item ON item.question_set_id = question_set.id
        JOIN questions question ON question.id = item.question_id
        WHERE (question_set.is_public = 1 OR question_set.user_id = ?)
          AND question.skill_id IN (${placeholders})
          AND NOT EXISTS (SELECT 1 FROM question_set_items member JOIN questions q ON q.id = member.question_id
            WHERE member.question_set_id = question_set.id AND NOT (${editorialEligibleSql('q', { pilotEnabled })}))
          AND (? = '' OR lesson_planner_search(question_set.title) LIKE ? ESCAPE '\\')
        GROUP BY question_set.id`,
      order: 'question_set.updated_at DESC, question_set.id DESC',
      params: [teacherId, ...skillIds, search, searchTerm],
    };
  }
  const conditions = [];
  const params = [...skillIds];
  if (gradeId) { conditions.push('(material.grade_id = ? OR mapping.skill_id IS NOT NULL)'); params.push(gradeId); }
  if (disciplineId) { conditions.push('(material.discipline_id = ? OR material.discipline_id IS NULL)'); params.push(disciplineId); }
  if (search) {
    conditions.push("lesson_planner_search(material.title || ' ' || COALESCE(material.description, '')) LIKE ? ESCAPE '\\'");
    params.push(searchTerm);
  }
  return {
    selection: `SELECT DISTINCT material.id, material.title, type.name AS typeName,
      grade.name AS gradeName, discipline.name AS disciplineName,
      CASE WHEN mapping.skill_id IS NOT NULL THEN 1 ELSE 0 END AS skillMatch`,
    source: `FROM materials material
      LEFT JOIN material_bncc_skills mapping ON mapping.material_id = material.id
        AND mapping.skill_id IN (${placeholders}) AND ${eligibleMaterialSkill()}
      LEFT JOIN material_types type ON type.id = material.material_type_id
      LEFT JOIN grades grade ON grade.id = material.grade_id
      LEFT JOIN disciplines discipline ON discipline.id = material.discipline_id
      ${conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''}`,
    order: 'skillMatch DESC, material.updated_at DESC, material.id DESC',
    params,
  };
}

function searchLessonPlannerResources(database, teacherId, input) {
  const query = normalizeQuery(database, input);
  if (!searchConnections.has(database)) {
    database.function('lesson_planner_search', { deterministic: true }, normalizeSearch);
    searchConnections.add(database);
  }
  const pilotEnabled = query.category !== 'materials'
    && isEditorialPilotEnabled(database, { id: teacherId, role: 'professor' });
  const { selection, source, order, params } = resourceQuery(teacherId, query, pilotEnabled);
  return database.transaction(() => {
    const total = database.prepare(`SELECT COUNT(*) FROM (${selection} ${source})`).pluck().get(...params);
    const items = database.prepare(`${selection} ${source} ORDER BY ${order} LIMIT ? OFFSET ?`)
      .all(...params, PAGE_SIZE, (query.page - 1) * PAGE_SIZE);
    return { items, total, page: query.page, pageSize: PAGE_SIZE,
      totalPages: Math.ceil(total / PAGE_SIZE), category: query.category };
  }).deferred();
}

module.exports = { searchLessonPlannerResources };
