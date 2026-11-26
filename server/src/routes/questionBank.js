const express = require('express');
const { createHash } = require('node:crypto');
const path = require('path');
const db = require('../database');
const { authenticate, requireAdmin } = require('../middleware/auth');
const upload = require('../middleware/upload').images;
const { notifyAllExcept, notifyAdmins } = require('../helpers/notify');
const { logActivity, logActivityStrict } = require('../helpers/activity');
const { discardNewUpload, preservePreviousImage } = require('../services/imageLifecycle');
const { editorialEligibleSql, isEditorialPilotEnabled } = require('../services/questionEditorialCuration');
const {
  AnswerKeyBalanceError,
  answerKeySummary,
  applyOptionOrder,
  createQuestionSetOptionOrders,
  normalizeOptionOrder,
} = require('../services/answerKeyBalance');

const router = express.Router();

router.use(authenticate);
// Numeric drafts have their own authenticated editor; legacy screens expect alternatives.
router.use(['/questions/:id', '/author-questions/:id'], (req, res, next) => {
  const id = Number(req.params.id);
  if (Number.isSafeInteger(id) && db.prepare("SELECT 1 FROM questions WHERE id=? AND question_type='numeric_draft'").get(id)) {
    return res.status(404).json({ error: 'Questão não encontrada neste editor.' });
  }
  return next();
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function parsePositiveInt(value, fallback = null) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) return fallback;
  return number;
}

const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.svg']);

function validateQuestionImage(file) {
  if (!file) return null;

  const ext = path.extname(file.originalname).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(ext) || !file.mimetype?.startsWith('image/')) {
    discardNewUpload(file.filename);
    return 'A imagem da questão deve ser um arquivo de imagem válido.';
  }

  return null;
}

function parseJsonField(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value !== 'string') return value;
  return JSON.parse(value);
}

function parseBooleanField(value) {
  return value === true || value === 1 || value === '1' || value === 'true';
}

const MAX_QUESTION_SET_ITEMS = 100;

function parseQuestionSetItemId(value) {
  if (typeof value !== 'number' && typeof value !== 'string') return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function normalizeQuestionSetSubmission(body, existingImageVisibility = new Map()) {
  const submittedItems = Array.isArray(body.question_items) ? body.question_items : [];
  const submittedIds = Array.isArray(body.question_ids) ? body.question_ids : [];
  const submittedCount = Math.max(submittedIds.length, submittedItems.length);
  if (submittedCount > MAX_QUESTION_SET_ITEMS) return { submittedCount };

  const ids = submittedIds.length ? submittedIds : submittedItems.map(item => item?.question_id);
  const validQuestionIds = ids.map(parseQuestionSetItemId).filter(id => id !== null);
  const uniqueQuestionIds = [...new Set(validQuestionIds)];
  const submittedVisibility = new Map();

  submittedItems.forEach((item) => {
    const questionId = parseQuestionSetItemId(item?.question_id);
    if (!questionId || !Object.prototype.hasOwnProperty.call(item, 'show_image')) return;
    submittedVisibility.set(questionId, parseBooleanField(item.show_image) ? 1 : 0);
  });

  const questionItems = uniqueQuestionIds.map((questionId, index) => ({
    question_id: questionId,
    sort_order: index + 1,
    show_image: submittedVisibility.has(questionId)
      ? submittedVisibility.get(questionId)
      : existingImageVisibility.has(questionId)
        ? existingImageVisibility.get(questionId)
        : 1,
  }));

  return {
    submittedCount,
    uniqueQuestionIds,
    questionItems,
  };
}

function normalizeDevelopmentSpace(value) {
  const allowedSpaces = ['none', 'small', 'medium', 'large'];
  return allowedSpaces.includes(value) ? value : 'none';
}

function normalizeQuestionBody(body) {
  return {
    ...body,
    skill_id: Number(body.skill_id),
    development_space: normalizeDevelopmentSpace(body.development_space),
    reviewed: parseBooleanField(body.reviewed),
    remove_image: parseBooleanField(body.remove_image),
    options: parseJsonField(body.options, []),
  };
}

function buildQuestionFilters(query, user, onlyActive = false) {
  const conditions = ["q.question_type IS NOT 'numeric_draft'"];
  const params = [];

  if (onlyActive) {
    conditions.push(`q.status = 'active'`);
    conditions.push(editorialEligibleSql('q', { pilotEnabled: isEditorialPilotEnabled(db, user) }));
  }

  if (user.role !== 'admin') {
    conditions.push(`(q.source = 'official' OR (q.source = 'teacher' AND q.created_by = ?))`);
    params.push(user.id);
  } else if (query.source && ['official', 'teacher'].includes(query.source)) {
    conditions.push('q.source = ?');
    params.push(query.source);
  }

  if (query.search) {
    conditions.push(`(
      q.question_code LIKE ? 
      OR q.statement LIKE ? 
      OR q.support_text LIKE ?
      OR q.official_explanation LIKE ?
      OR bs.code LIKE ?
      OR bs.description LIKE ?
    )`);

    const term = `%${query.search}%`;
    params.push(term, term, term, term, term, term);
  }

  if (query.grade_id) {
    conditions.push('bs.grade_id = ?');
    params.push(Number(query.grade_id));
  } else if (query.my_grades === '1' && user.role === 'professor') {
    conditions.push(`(
      NOT EXISTS (
        SELECT 1 FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
      OR bs.grade_id IN (
        SELECT preference.grade_id
        FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
    )`);
    params.push(user.id, user.id);
  }

  if (query.unit_id) {
    conditions.push('bs.unit_id = ?');
    params.push(Number(query.unit_id));
  }

  if (query.skill_id) {
    conditions.push('q.skill_id = ?');
    params.push(Number(query.skill_id));
  }

  if (query.difficulty) {
    conditions.push('q.difficulty = ?');
    params.push(query.difficulty);
  }

  if (query.status && !onlyActive) {
    conditions.push('q.status = ?');
    params.push(query.status);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

function attachOptions(questions, optionOrders = null) {
  const optionStmt = db.prepare(`
    SELECT 
      id,
      question_id,
      option_label,
      option_text,
      is_correct,
      sort_order
    FROM question_options
    WHERE question_id = ?
    ORDER BY sort_order ASC, option_label ASC
  `);

  return questions.map((question) => {
    const { option_order: storedOptionOrder, ...publicQuestion } = question;
    const sourceOptions = optionStmt.all(question.id);
    const optionOrder = optionOrders?.get(question.id) || normalizeOptionOrder(storedOptionOrder);
    return {
      ...publicQuestion,
      options: optionOrder
        ? applyOptionOrder(sourceOptions, optionOrder)
        : sourceOptions,
    };
  });
}

function attachEditorial({ editorial_state, editorial_stage, editorial_family, editorial_batch,
  editorial_reason, editorial_rationales, ...question }, user) {
  if (!editorial_state) return question;
  const editorial = { state: editorial_state, stage: editorial_stage };
  if (user.role === 'admin') Object.assign(editorial, {
    family: editorial_family,
    batchKey: editorial_batch,
    reason: editorial_reason,
    rationales: editorial_rationales ? JSON.parse(editorial_rationales) : null,
  });
  return { ...question, editorial };
}

// ─────────────────────────────────────────────
// GET /api/question-bank/grades
// Lista anos que possuem habilidades BNCC
// ─────────────────────────────────────────────

router.get('/grades', (req, res) => {
  const grades = db.prepare(`
    SELECT DISTINCT
      g.id,
      g.name,
      g.sort_order
    FROM grades g
    INNER JOIN bncc_skills bs ON bs.grade_id = g.id
    ORDER BY g.sort_order ASC, g.name ASC
  `).all();

  res.json(grades);
});

// ─────────────────────────────────────────────
// GET /api/question-bank/units
// Lista unidades temáticas
// Pode filtrar por grade_id
// ─────────────────────────────────────────────

router.get('/units', (req, res) => {
  const gradeId = parsePositiveInt(req.query.grade_id);
  const useMyGrades = req.query.my_grades === '1' && req.user.role === 'professor';

  let units;

  if (gradeId) {
    units = db.prepare(`
      SELECT DISTINCT
        bu.id,
        bu.name,
        bu.sort_order
      FROM bncc_units bu
      INNER JOIN bncc_skills bs ON bs.unit_id = bu.id
      WHERE bs.grade_id = ?
      ORDER BY bu.sort_order ASC, bu.name ASC
    `).all(gradeId);
  } else if (useMyGrades) {
    units = db.prepare(`
      SELECT DISTINCT
        bu.id,
        bu.name,
        bu.sort_order
      FROM bncc_units bu
      INNER JOIN bncc_skills bs ON bs.unit_id = bu.id
      WHERE NOT EXISTS (
        SELECT 1 FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      ) OR bs.grade_id IN (
        SELECT preference.grade_id
        FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
      ORDER BY bu.sort_order ASC, bu.name ASC
    `).all(req.user.id, req.user.id);
  } else {
    units = db.prepare(`
      SELECT
        id,
        name,
        sort_order
      FROM bncc_units
      ORDER BY sort_order ASC, name ASC
    `).all();
  }

  res.json(units);
});

// ─────────────────────────────────────────────
// GET /api/question-bank/skills
// Lista habilidades BNCC
// Filtros: grade_id, unit_id
// ─────────────────────────────────────────────

router.get('/skills', (req, res) => {
  const conditions = [];
  const params = [];
  const editorialCatalogSql = req.user.role === 'admin' ? '' : `AND ${editorialEligibleSql('q', {
    pilotEnabled: isEditorialPilotEnabled(db, req.user),
  })}`;

  if (req.query.grade_id) {
    conditions.push('bs.grade_id = ?');
    params.push(Number(req.query.grade_id));
  }

  if (!req.query.grade_id && req.query.my_grades === '1' && req.user.role === 'professor') {
    conditions.push(`(
      NOT EXISTS (
        SELECT 1 FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
      OR bs.grade_id IN (
        SELECT preference.grade_id
        FROM teacher_grade_preferences preference
        WHERE preference.teacher_id = ?
      )
    )`);
    params.push(req.user.id, req.user.id);
  }

  if (req.query.unit_id) {
    conditions.push('bs.unit_id = ?');
    params.push(Number(req.query.unit_id));
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const skills = db.prepare(`
    SELECT
      bs.id,
      bs.code,
      bs.description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      (
        SELECT COUNT(*)
        FROM questions q
        WHERE q.skill_id = bs.id
        ${editorialCatalogSql}
      ) AS question_count,
      (
        SELECT COUNT(*)
        FROM questions q
        WHERE q.skill_id = bs.id
        AND q.status = 'active'
        ${editorialCatalogSql}
      ) AS active_question_count
    FROM bncc_skills bs
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    ${whereClause}
    ORDER BY g.sort_order ASC, bu.sort_order ASC, bs.code ASC
  `).all(...params);

  res.json(skills);
});

// ─────────────────────────────────────────────
// GET /api/question-bank/questions
// Professor e admin listam questões
// Professor recebe apenas active
// Admin pode filtrar status
// ─────────────────────────────────────────────

router.get('/questions', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  const onlyActive = req.user.role !== 'admin';
  const { whereClause, params } = buildQuestionFilters(req.query, req.user, onlyActive);

  const validSorts = {
    code_asc: 'q.question_code ASC',
    code_desc: 'q.question_code DESC',
    recent: 'q.created_at DESC',
    oldest: 'q.created_at ASC',
    difficulty: `
      CASE q.difficulty
        WHEN 'facil' THEN 1
        WHEN 'media' THEN 2
        WHEN 'dificil' THEN 3
        ELSE 4
      END ASC
    `,
  };

  const sortKey = req.query.sort || 'code_asc';
  const orderBy = validSorts[sortKey] || validSorts.code_asc;

  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    ${whereClause}
  `).get(...params).total;

  const questions = db.prepare(`
    SELECT
      q.id,
      q.question_code,
      q.skill_id,
      bs.code AS skill_code,
      bs.description AS skill_description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.reviewed,
      q.source,
      q.created_by,
      creator.name AS creator_name,
      q.created_at,
      q.updated_at,
      editorial.state AS editorial_state, editorial.stage AS editorial_stage,
      editorial.family AS editorial_family, editorial.batch_key AS editorial_batch,
      editorial.reason AS editorial_reason, editorial.rationales_json AS editorial_rationales
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    LEFT JOIN users creator ON creator.id = q.created_by
    LEFT JOIN question_editorial_curation editorial ON editorial.question_id = q.id
    ${whereClause}
    ORDER BY ${orderBy}
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    data: attachOptions(questions.map(question => attachEditorial(question, req.user))),
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ─────────────────────────────────────────────
// GET /api/question-bank/questions/:id
// Busca uma questão específica com alternativas
// ─────────────────────────────────────────────

router.get('/questions/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const onlyActiveSql = req.user.role !== 'admin' ? `AND q.status = 'active'
    AND ${editorialEligibleSql('q', { pilotEnabled: isEditorialPilotEnabled(db, req.user) })}` : '';
  const privacySql = req.user.role !== 'admin'
    ? `AND (q.source = 'official' OR (q.source = 'teacher' AND q.created_by = ?))`
    : '';

  const question = db.prepare(`
    SELECT
      q.id,
      q.question_code,
      q.skill_id,
      bs.code AS skill_code,
      bs.description AS skill_description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.reviewed,
      q.source,
      q.created_by,
      creator.name AS creator_name,
      q.created_at,
      q.updated_at,
      editorial.state AS editorial_state, editorial.stage AS editorial_stage,
      editorial.family AS editorial_family, editorial.batch_key AS editorial_batch,
      editorial.reason AS editorial_reason, editorial.rationales_json AS editorial_rationales
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    LEFT JOIN users creator ON creator.id = q.created_by
    LEFT JOIN question_editorial_curation editorial ON editorial.question_id = q.id
    WHERE q.id = ?
    ${onlyActiveSql}
    ${privacySql}
  `).get(...(req.user.role === 'admin' ? [id] : [id, req.user.id]));

  if (!question) {
    return res.status(404).json({ error: 'Questão não encontrada.' });
  }

  const withOptions = attachOptions([attachEditorial(question, req.user)])[0];

  res.json(withOptions);
});

// ─────────────────────────────────────────────
// GET /api/question-bank/stats
// Estatísticas gerais para admin
// ─────────────────────────────────────────────

router.get('/stats', requireAdmin, (req, res) => {
  const totals = db.prepare(`
    SELECT
      (SELECT COUNT(*) FROM bncc_skills) AS total_skills,
      (SELECT COUNT(*) FROM questions WHERE question_type IS NOT 'numeric_draft') AS total_questions,
      (SELECT COUNT(*) FROM question_options) AS total_options,
      (SELECT COUNT(*) FROM questions WHERE status = 'active') AS active_questions,
      (SELECT COUNT(*) FROM questions WHERE status = 'inactive' AND question_type IS NOT 'numeric_draft') AS inactive_questions,
      (SELECT COUNT(*) FROM question_sets) AS total_question_sets,
      (SELECT COUNT(*) FROM questions WHERE source = 'teacher' AND question_type IS NOT 'numeric_draft') AS teacher_questions,
      (SELECT COUNT(DISTINCT created_by) FROM questions WHERE source = 'teacher' AND question_type IS NOT 'numeric_draft') AS teacher_question_creators,
      (SELECT COUNT(*) FROM question_sets WHERE contains_author_questions = 1) AS teacher_question_sets
  `).get();

  const byGrade = db.prepare(`
    SELECT
      g.id AS grade_id,
      g.name AS grade_name,
      COUNT(q.id) AS question_count
    FROM grades g
    LEFT JOIN bncc_skills bs ON bs.grade_id = g.id
    LEFT JOIN questions q ON q.skill_id = bs.id AND q.question_type IS NOT 'numeric_draft'
    GROUP BY g.id
    ORDER BY g.sort_order ASC, g.name ASC
  `).all();

  const byUnit = db.prepare(`
    SELECT
      bu.id AS unit_id,
      bu.name AS unit_name,
      COUNT(q.id) AS question_count
    FROM bncc_units bu
    LEFT JOIN bncc_skills bs ON bs.unit_id = bu.id
    LEFT JOIN questions q ON q.skill_id = bs.id AND q.question_type IS NOT 'numeric_draft'
    GROUP BY bu.id
    ORDER BY bu.sort_order ASC, bu.name ASC
  `).all();

  res.json({
    ...totals,
    byGrade,
    byUnit, 
  });
});

// ─────────────────────────────────────────────
// Helper: validar alternativas
// ─────────────────────────────────────────────

function validateOptions(options) {
  if (!Array.isArray(options) || options.length !== 4) {
    return 'A questão deve ter exatamente 4 alternativas.';
  }

  const allowedLabels = ['A', 'B', 'C', 'D'];
  const labels = options.map((option) => option.option_label);

  for (const label of allowedLabels) {
    if (!labels.includes(label)) {
      return `A alternativa ${label} é obrigatória.`;
    }
  }

  const uniqueLabels = [...new Set(labels)];
  if (uniqueLabels.length !== 4) {
    return 'As alternativas não podem ter letras repetidas.';
  }

  for (const option of options) {
    if (!allowedLabels.includes(option.option_label)) {
      return 'As alternativas devem usar apenas os rótulos A, B, C e D.';
    }

    if (!option.option_text || !option.option_text.trim()) {
      return `O texto da alternativa ${option.option_label} é obrigatório.`;
    }
  }

  const correctCount = options.filter((option) => Number(option.is_correct) === 1).length;

  if (correctCount !== 1) {
    return 'A questão deve ter exatamente uma alternativa correta.';
  }

  return null;
}

// ─────────────────────────────────────────────
// POST /api/question-bank/questions
// Cria questão com 4 alternativas
// Apenas admin
// ─────────────────────────────────────────────

function getAuthorQuestion(questionId) {
  const question = db.prepare(`
    SELECT
      q.id,
      q.question_code,
      q.skill_id,
      bs.code AS skill_code,
      bs.description AS skill_description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.reviewed,
      q.source,
      q.created_by,
      creator.name AS creator_name,
      q.created_at,
      q.updated_at
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    LEFT JOIN users creator ON creator.id = q.created_by
    WHERE q.id = ? AND q.source = 'teacher' AND q.question_type IS NOT 'numeric_draft'
  `).get(questionId);

  return question ? attachOptions([question])[0] : null;
}

function validateAuthorQuestionPayload(payload) {
  if (!payload.skill_id || !Number.isInteger(Number(payload.skill_id))) {
    return 'Habilidade BNCC é obrigatória.';
  }

  if (!payload.statement || !payload.statement.trim()) {
    return 'Enunciado é obrigatório.';
  }

  if (payload.statement.trim().length > 10000) {
    return 'O enunciado deve ter no máximo 10.000 caracteres.';
  }

  if (!['facil', 'media', 'dificil'].includes(payload.difficulty || 'media')) {
    return 'Dificuldade inválida.';
  }

  const skill = db.prepare('SELECT id FROM bncc_skills WHERE id = ?').get(Number(payload.skill_id));
  if (!skill) return 'Habilidade BNCC não encontrada.';

  return validateOptions(payload.options);
}

// Questões autorais: o professor enxerga apenas as próprias e o admin enxerga todas.
router.get('/author-questions', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 12));
  const offset = (page - 1) * limit;
  const conditions = ["q.source = 'teacher'", "q.question_type IS NOT 'numeric_draft'"];
  const params = [];

  if (req.user.role !== 'admin') {
    conditions.push('q.created_by = ?');
    params.push(req.user.id);
  } else if (req.query.user_id) {
    conditions.push('q.created_by = ?');
    params.push(Number(req.query.user_id));
  }

  if (req.query.search) {
    conditions.push('(q.statement LIKE ? OR q.question_code LIKE ? OR bs.code LIKE ? OR creator.name LIKE ?)');
    const term = `%${String(req.query.search).trim()}%`;
    params.push(term, term, term, term);
  }

  const whereClause = `WHERE ${conditions.join(' AND ')}`;
  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    LEFT JOIN users creator ON creator.id = q.created_by
    ${whereClause}
  `).get(...params).total;

  const questions = db.prepare(`
    SELECT
      q.id, q.question_code, q.skill_id,
      bs.code AS skill_code, bs.description AS skill_description,
      bs.grade_id, g.name AS grade_name, bs.unit_id, bu.name AS unit_name,
      q.statement, q.support_text, q.image_path, q.development_space,
      q.difficulty, q.question_type, q.official_explanation, q.status,
      q.reviewed, q.source, q.created_by, creator.name AS creator_name,
      q.created_at, q.updated_at,
      (SELECT COUNT(*) FROM question_set_items qsi WHERE qsi.question_id = q.id) AS question_set_count
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    LEFT JOIN users creator ON creator.id = q.created_by
    ${whereClause}
    ORDER BY q.updated_at DESC, q.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    data: attachOptions(questions),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  });
});

router.post('/author-questions', upload.single('image'), (req, res) => {
  if (req.user.role !== 'professor') {
    discardNewUpload(req.file?.filename);
    return res.status(403).json({ error: 'A criação de questões autorais é exclusiva para professores.' });
  }

  const imageError = validateQuestionImage(req.file);
  if (imageError) return res.status(400).json({ error: imageError });
  res.on('finish', () => {
    if (req.file && res.statusCode >= 400) discardNewUpload(req.file.filename);
  });

  let payload;
  try {
    payload = normalizeQuestionBody(req.body);
  } catch {
    return res.status(400).json({ error: 'As alternativas enviadas são inválidas.' });
  }

  const validationError = validateAuthorQuestionPayload(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  const questionCode = `AUT-${req.user.id}-${Date.now().toString(36).toUpperCase()}`;
  const createQuestion = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO questions (
        question_code, skill_id, statement, support_text, image_path,
        development_space, difficulty, question_type, official_explanation,
        status, reviewed, created_by, source
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'multiple_choice', ?, 'active', 0, ?, 'teacher')
    `).run(
      questionCode,
      Number(payload.skill_id),
      payload.statement.trim(),
      payload.support_text?.trim() || null,
      req.file?.filename || null,
      normalizeDevelopmentSpace(payload.development_space),
      payload.difficulty || 'media',
      payload.official_explanation?.trim() || null,
      req.user.id
    );

    const insertOption = db.prepare(`
      INSERT INTO question_options (question_id, option_label, option_text, is_correct, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);

    [...payload.options]
      .sort((a, b) => ['A', 'B', 'C', 'D'].indexOf(a.option_label) - ['A', 'B', 'C', 'D'].indexOf(b.option_label))
      .forEach((option, index) => {
        insertOption.run(
          result.lastInsertRowid,
          option.option_label,
          option.option_text.trim(),
          Number(option.is_correct) === 1 ? 1 : 0,
          index + 1
        );
      });

    require('../services/aiAuthoring').recordAiQuestionLink(db, req.user.id, Number(result.lastInsertRowid), req.body.ai_request_id);
    return result.lastInsertRowid;
  });

  let questionId;
  try {
    questionId = createQuestion();
  } catch (error) {
    discardNewUpload(req.file?.filename);
    throw error;
  }

  const created = getAuthorQuestion(questionId);
  notifyAdmins(
    req.user.id,
    'teacher_question_created',
    'Nova questão autoral criada',
    `${req.user.name} criou uma questão autoral vinculada a ${created.skill_code}.`,
    { question_id: created.id, creator_id: req.user.id }
  );

  logActivity({
    user: req.user,
    action: 'create_teacher_question',
    module: 'question_bank',
    entityType: 'question',
    entityId: created.id,
    entityTitle: created.question_code,
    description: `${req.user.name} criou a questão autoral ${created.question_code}.`,
    metadata: {
      skill_code: created.skill_code,
      difficulty: created.difficulty,
      source: 'teacher',
      has_image: Boolean(created.image_path),
    },
    req,
  });

  res.status(201).json(created);
});

router.put('/author-questions/:id', upload.single('image'), (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const existing = id ? getAuthorQuestion(id) : null;

  if (!existing) {
    discardNewUpload(req.file?.filename);
    return res.status(404).json({ error: 'Questão autoral não encontrada.' });
  }

  if (existing.created_by !== req.user.id && req.user.role !== 'admin') {
    discardNewUpload(req.file?.filename);
    return res.status(403).json({ error: 'Você só pode editar suas próprias questões.' });
  }

  const imageError = validateQuestionImage(req.file);
  if (imageError) return res.status(400).json({ error: imageError });
  res.on('finish', () => {
    if (req.file && res.statusCode >= 400) discardNewUpload(req.file.filename);
  });

  let payload;
  try {
    payload = normalizeQuestionBody(req.body);
  } catch {
    return res.status(400).json({ error: 'As alternativas enviadas são inválidas.' });
  }

  const validationError = validateAuthorQuestionPayload(payload);
  if (validationError) return res.status(400).json({ error: validationError });

  let imagePath = existing.image_path;
  if (payload.remove_image) imagePath = null;
  if (req.file) imagePath = req.file.filename;

  const updateQuestion = db.transaction(() => {
    preservePreviousImage(req, 'question', existing, imagePath, req.file ? 'replaced' : 'removed');
    db.prepare(`
      UPDATE questions
      SET skill_id = ?, statement = ?, support_text = ?, image_path = ?,
          development_space = ?, difficulty = ?, official_explanation = ?,
          updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      Number(payload.skill_id), payload.statement.trim(), payload.support_text?.trim() || null,
      imagePath, normalizeDevelopmentSpace(payload.development_space), payload.difficulty || 'media',
      payload.official_explanation?.trim() || null, id
    );

    db.prepare('DELETE FROM question_options WHERE question_id = ?').run(id);
    const insertOption = db.prepare(`
      INSERT INTO question_options (question_id, option_label, option_text, is_correct, sort_order)
      VALUES (?, ?, ?, ?, ?)
    `);
    [...payload.options]
      .sort((a, b) => ['A', 'B', 'C', 'D'].indexOf(a.option_label) - ['A', 'B', 'C', 'D'].indexOf(b.option_label))
      .forEach((option, index) => {
        insertOption.run(id, option.option_label, option.option_text.trim(), Number(option.is_correct) === 1 ? 1 : 0, index + 1);
      });

    require('../services/aiAuthoring').recordAiQuestionLink(db, req.user.id, id, req.body.ai_request_id);
    const updated = getAuthorQuestion(id);
    logActivityStrict({
      user: req.user,
      action: 'update_teacher_question',
      module: 'question_bank',
      entityType: 'question',
      entityId: id,
      entityTitle: updated.question_code,
      description: `${req.user.name} atualizou a questão autoral ${updated.question_code}.`,
      metadata: { skill_code: updated.skill_code, difficulty: updated.difficulty },
      req,
    });
    return updated;
  });

  let updated;
  try {
    updated = updateQuestion();
  } catch (error) {
    discardNewUpload(req.file?.filename);
    throw error;
  }

  res.json(updated);
});

router.delete('/author-questions/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const existing = id ? getAuthorQuestion(id) : null;

  if (!existing) return res.status(404).json({ error: 'Questão autoral não encontrada.' });
  if (existing.created_by !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Você só pode excluir suas próprias questões.' });
  }

  const usage = db.prepare(
    'SELECT COUNT(*) AS total FROM question_set_items WHERE question_id = ?'
  ).get(id).total;

  if (usage > 0) {
    return res.status(409).json({
      error: 'Esta questão faz parte de um simulado. Remova-a dos simulados antes de excluir.',
    });
  }

  db.transaction(() => {
    preservePreviousImage(req, 'question', existing, null, 'deleted');
    db.prepare('DELETE FROM questions WHERE id = ?').run(id);

    logActivityStrict({
      user: req.user,
      action: 'delete_teacher_question',
      module: 'question_bank',
      entityType: 'question',
      entityId: id,
      entityTitle: existing.question_code,
      description: `${req.user.name} excluiu a questão autoral ${existing.question_code}.`,
      metadata: { source: 'teacher' },
      isCritical: true,
      req,
    });
  })();

  res.json({ message: 'Questão autoral excluída com sucesso.' });
});

router.post('/questions', requireAdmin, upload.single('image'), (req, res) => {
  const imageError = validateQuestionImage(req.file);
  if (imageError) return res.status(400).json({ error: imageError });
  res.on('finish', () => {
    if (req.file && res.statusCode >= 400) discardNewUpload(req.file.filename);
  });

  const {
    question_code,
    skill_id,
    statement,
    support_text,
    development_space,
    difficulty,
    question_type,
    official_explanation,
    status,
    reviewed,
    remove_image,
    options,
  } = normalizeQuestionBody(req.body);
  if (!question_code || !question_code.trim()) {
    return res.status(400).json({ error: 'Código da questão é obrigatório.' });
  }

  if (!skill_id || !Number.isInteger(Number(skill_id))) {
    return res.status(400).json({ error: 'Habilidade BNCC é obrigatória.' });
  }

  if (!statement || !statement.trim()) {
    return res.status(400).json({ error: 'Enunciado é obrigatório.' });
  }

  const allowedDifficulties = ['facil', 'media', 'dificil'];
  const finalDifficulty = difficulty || 'media';

  if (!allowedDifficulties.includes(finalDifficulty)) {
    return res.status(400).json({ error: 'Dificuldade inválida.' });
  }

  const allowedStatuses = ['active', 'inactive'];
  const finalStatus = status || 'active';

  if (!allowedStatuses.includes(finalStatus)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const finalQuestionType = question_type || 'multiple_choice';

  if (finalQuestionType !== 'multiple_choice') {
    return res.status(400).json({ error: 'Tipo de questão inválido.' });
  }

  const skill = db.prepare(`
    SELECT id
    FROM bncc_skills
    WHERE id = ?
  `).get(Number(skill_id));

  if (!skill) {
    return res.status(404).json({ error: 'Habilidade BNCC não encontrada.' });
  }

  const optionsError = validateOptions(options);

  if (optionsError) {
    return res.status(400).json({ error: optionsError });
  }

  const existingCode = db.prepare(`
    SELECT id
    FROM questions
    WHERE question_code = ?
  `).get(question_code.trim());

  if (existingCode) {
    return res.status(409).json({ error: 'Já existe uma questão com este código.' });
  }

  const createQuestion = db.transaction(() => {
    const result = db.prepare(`
      INSERT INTO questions (
        question_code,
        skill_id,
        statement,
        support_text,
        image_path,
        development_space,
        difficulty,
        question_type,
        official_explanation,
        status,
        reviewed,
        created_by
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      question_code.trim(),
      Number(skill_id),
      statement.trim(),
      support_text?.trim() || null,
      req.file?.filename || null,
      development_space,
      finalDifficulty,
      finalQuestionType,
      official_explanation?.trim() || null,
      finalStatus,
      reviewed ? 1 : 0,
      req.user.id
    );

    const questionId = result.lastInsertRowid;

    const insertOption = db.prepare(`
      INSERT INTO question_options (
        question_id,
        option_label,
        option_text,
        is_correct,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    const sortedOptions = [...options].sort((a, b) => {
      return ['A', 'B', 'C', 'D'].indexOf(a.option_label) - ['A', 'B', 'C', 'D'].indexOf(b.option_label);
    });

    sortedOptions.forEach((option, index) => {
      insertOption.run(
        questionId,
        option.option_label,
        option.option_text.trim(),
        Number(option.is_correct) === 1 ? 1 : 0,
        option.sort_order ? Number(option.sort_order) : index + 1
      );
    });

    return questionId;
  });

  let questionId;
  try {
    questionId = createQuestion();
  } catch (err) {
    discardNewUpload(req.file?.filename);
    throw err;
  }

  const created = db.prepare(`
    SELECT
      q.id,
      q.question_code,
      q.skill_id,
      bs.code AS skill_code,
      bs.description AS skill_description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.reviewed,
      q.created_by,
      q.created_at,
      q.updated_at
    FROM questions q
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    WHERE q.id = ?
  `).get(questionId);

  logActivity({
    user: req.user,
    action: 'create_question',
    module: 'question_bank',
    entityType: 'question',
    entityId: created.id,
    entityTitle: created.question_code,
    description: `${req.user.name} criou a questão ${created.question_code}.`,
    metadata: {
      question_code: created.question_code,
      skill_id: created.skill_id,
      skill_code: created.skill_code,
      grade: created.grade_name,
      unit: created.unit_name,
      difficulty: created.difficulty,
      development_space: created.development_space,
      status: created.status,
      reviewed: Boolean(created.reviewed),
      has_image: Boolean(created.image_path),
    },
    req,
  });

  res.status(201).json(attachOptions([created])[0]);
});

// ─────────────────────────────────────────────
// PUT /api/question-bank/questions/:id
// Edita questão e alternativas
// Apenas admin
// ─────────────────────────────────────────────

router.put('/questions/:id', requireAdmin, upload.single('image'), (req, res) => {
  const imageError = validateQuestionImage(req.file);
  if (imageError) return res.status(400).json({ error: imageError });
  res.on('finish', () => {
    if (req.file && res.statusCode >= 400) discardNewUpload(req.file.filename);
  });

  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const existing = db.prepare(`
    SELECT *
    FROM questions
    WHERE id = ?
  `).get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Questão não encontrada.' });
  }
  if (db.prepare('SELECT 1 FROM question_editorial_curation WHERE question_id = ?').get(id)) {
    return res.status(409).json({ code: 'question_editorial_content_locked',
      error: 'Esta questão faz parte da curadoria. Cadastre uma nova questão para alterar o conteúdo.' });
  }

  const {
    question_code,
    skill_id,
    statement,
    support_text,
    development_space,
    difficulty,
    question_type,
    official_explanation,
    status,
    reviewed,
    remove_image,
    options,
  } = normalizeQuestionBody(req.body);

  if (!question_code || !question_code.trim()) {
    return res.status(400).json({ error: 'Código da questão é obrigatório.' });
  }

  if (!skill_id || !Number.isInteger(Number(skill_id))) {
    return res.status(400).json({ error: 'Habilidade BNCC é obrigatória.' });
  }

  if (!statement || !statement.trim()) {
    return res.status(400).json({ error: 'Enunciado é obrigatório.' });
  }

  const allowedDifficulties = ['facil', 'media', 'dificil'];
  const finalDifficulty = difficulty || 'media';

  if (!allowedDifficulties.includes(finalDifficulty)) {
    return res.status(400).json({ error: 'Dificuldade inválida.' });
  }

  const allowedStatuses = ['active', 'inactive'];
  const finalStatus = status || 'active';

  if (!allowedStatuses.includes(finalStatus)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  const finalQuestionType = question_type || 'multiple_choice';

  if (finalQuestionType !== 'multiple_choice') {
    return res.status(400).json({ error: 'Tipo de questão inválido.' });
  }

  const skill = db.prepare(`
    SELECT id
    FROM bncc_skills
    WHERE id = ?
  `).get(Number(skill_id));

  if (!skill) {
    return res.status(404).json({ error: 'Habilidade BNCC não encontrada.' });
  }

  const duplicatedCode = db.prepare(`
    SELECT id
    FROM questions
    WHERE question_code = ?
    AND id <> ?
  `).get(question_code.trim(), id);

  if (duplicatedCode) {
    return res.status(409).json({ error: 'Já existe outra questão com este código.' });
  }

  const optionsError = validateOptions(options);

  if (optionsError) {
    return res.status(400).json({ error: optionsError });
  }

  const imagePath = req.file
    ? req.file.filename
    : remove_image
      ? null
      : existing.image_path;

  const updateQuestion = db.transaction(() => {
    preservePreviousImage(req, 'question', existing, imagePath, req.file ? 'replaced' : 'removed');
    db.prepare(`
    UPDATE questions
    SET
      question_code = ?,
      skill_id = ?,
      statement = ?,
      support_text = ?,
      image_path = ?,
      development_space = ?,
      difficulty = ?,
      question_type = ?,
      official_explanation = ?,
      status = ?,
      reviewed = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
    `).run(
      question_code.trim(),
      Number(skill_id),
      statement.trim(),
      support_text?.trim() || null,
      imagePath,
      development_space,
      finalDifficulty,
      finalQuestionType,
      official_explanation?.trim() || null,
      finalStatus,
      reviewed ? 1 : 0,
      id
    );

    db.prepare(`
      DELETE FROM question_options
      WHERE question_id = ?
    `).run(id);

    const insertOption = db.prepare(`
      INSERT INTO question_options (
        question_id,
        option_label,
        option_text,
        is_correct,
        sort_order
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    const sortedOptions = [...options].sort((a, b) => {
      return ['A', 'B', 'C', 'D'].indexOf(a.option_label) - ['A', 'B', 'C', 'D'].indexOf(b.option_label);
    });

    sortedOptions.forEach((option, index) => {
      insertOption.run(
        id,
        option.option_label,
        option.option_text.trim(),
        Number(option.is_correct) === 1 ? 1 : 0,
        option.sort_order ? Number(option.sort_order) : index + 1
      );
    });
    const updated = db.prepare(`
      SELECT
        q.id,
        q.question_code,
        q.skill_id,
        bs.code AS skill_code,
        bs.description AS skill_description,
        bs.grade_id,
        g.name AS grade_name,
        bs.unit_id,
        bu.name AS unit_name,
        q.statement,
        q.support_text,
        q.image_path,
        q.development_space,
        q.difficulty,
        q.question_type,
        q.official_explanation,
        q.status,
        q.reviewed,
        q.created_by,
        q.created_at,
        q.updated_at
      FROM questions q
      INNER JOIN bncc_skills bs ON bs.id = q.skill_id
      INNER JOIN grades g ON g.id = bs.grade_id
      INNER JOIN bncc_units bu ON bu.id = bs.unit_id
      WHERE q.id = ?
    `).get(id);

    logActivityStrict({
      user: req.user,
      action: 'update_question',
      module: 'question_bank',
      entityType: 'question',
      entityId: id,
      entityTitle: updated.question_code,
      description: `${req.user.name} editou a questão ${updated.question_code}.`,
      metadata: {
        previous: {
          question_code: existing.question_code,
          skill_id: existing.skill_id,
          difficulty: existing.difficulty,
          development_space: existing.development_space,
          status: existing.status,
          reviewed: Boolean(existing.reviewed),
          has_image: Boolean(existing.image_path),
        },
        current: {
          question_code: updated.question_code,
          skill_id: updated.skill_id,
          skill_code: updated.skill_code,
          difficulty: updated.difficulty,
          development_space: updated.development_space,
          status: updated.status,
          reviewed: Boolean(updated.reviewed),
          has_image: Boolean(updated.image_path),
        },
        image_changed: Boolean(req.file) || Boolean(remove_image),
        alternatives_recreated: true,
      },
      req,
    });

    return attachOptions([updated])[0];
  });

  let updated;
  try {
    updated = updateQuestion();
  } catch (err) {
    discardNewUpload(req.file?.filename);
    throw err;
  }
  res.json(updated);
});

// ─────────────────────────────────────────────
// PATCH /api/question-bank/questions/:id/status
// Ativa ou inativa questão
// Apenas admin
// ─────────────────────────────────────────────

function changeQuestionAvailability(req, res, id, changes) {
  const reviewing = Object.hasOwn(changes, 'reviewed');
  const column = reviewing ? 'reviewed' : 'status';
  const value = changes[column];
  const change = db.transaction(() => {
    const existing = db.prepare(`SELECT q.*, editorial.state AS editorial_state, editorial.batch_key AS editorial_batch
      FROM questions q LEFT JOIN question_editorial_curation editorial ON editorial.question_id=q.id
      WHERE q.id = ?`).get(id);
    if (!existing) return { status: 404, body: { error: 'Questão não encontrada.' } };
    if (existing.editorial_state === 'held' && (reviewing || value === 'active')) {
      return { status: 409, body: { code: 'question_editorial_hold',
        error: 'Esta questão está em curadoria por divergência com a habilidade. Cadastre uma nova questão para substituí-la.' } };
    }
    if (existing.editorial_state === 'pilot' && value === 'active' && existing.reviewed !== 1) {
      return { status: 409, body: { code: 'question_editorial_review_required',
        error: 'Registre a revisão pedagógica antes de ativar esta questão.' } };
    }

    db.prepare(`UPDATE questions SET ${column} = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`).run(value, id);
    const updated = db.prepare('SELECT * FROM questions WHERE id = ?').get(id);
    const log = existing.editorial_state === 'pilot' ? logActivityStrict : logActivity;
    const metadata = reviewing
      ? { previous_reviewed: Boolean(existing.reviewed), current_reviewed: Boolean(value) }
      : { previous_status: existing.status, current_status: value };
    log({
      user: req.user,
      action: reviewing ? 'update_question_review' : 'update_question_status',
      module: 'question_bank',
      entityType: 'question',
      entityId: id,
      entityTitle: existing.question_code,
      description: reviewing
        ? `${req.user.name} marcou a questão ${existing.question_code} como ${value ? 'revisada' : 'não revisada'}.`
        : `${req.user.name} ${value === 'active' ? 'ativou' : 'desativou'} a questão ${existing.question_code}.`,
      metadata: { question_code: existing.question_code, ...metadata,
        ...(existing.editorial_batch ? { editorial_batch: existing.editorial_batch } : {}) },
      isCritical: existing.editorial_state === 'pilot' || (!reviewing && value === 'inactive'),
      req,
    });
    return { status: 200, body: updated };
  });
  const { status, body } = change.immediate();
  return res.status(status).json(body);
}

router.patch('/questions/:id/status', requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const { status } = req.body;

  if (!['active', 'inactive'].includes(status)) {
    return res.status(400).json({ error: 'Status inválido.' });
  }

  return changeQuestionAvailability(req, res, id, { status });
});

// ─────────────────────────────────────────────
// PATCH /api/question-bank/questions/:id/reviewed
// Marca questão como revisada ou não revisada
// Apenas admin
// ─────────────────────────────────────────────

router.patch('/questions/:id/reviewed', requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido.' });

  const { reviewed } = req.body;
  if (![true, false, 0, 1, '0', '1'].includes(reviewed)) {
    return res.status(400).json({ error: 'Valor de revisão inválido.' });
  }
  return changeQuestionAvailability(req, res, id, { reviewed: Number(parseBooleanField(reviewed)) });
});

// ─────────────────────────────────────────────
// DELETE /api/question-bank/questions/:id
// Compatibilidade: desativa a questão em vez de excluir definitivamente
// Apenas admin
// ─────────────────────────────────────────────

router.delete('/questions/:id', requireAdmin, (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const existing = db.prepare(`
    SELECT *
    FROM questions
    WHERE id = ?
  `).get(id);

  if (!existing) {
    return res.status(404).json({ error: 'Questão não encontrada.' });
  }

  db.prepare(`
    UPDATE questions
    SET status = 'inactive', updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `).run(id);

  logActivity({
    user: req.user,
    action: 'delete_question',
    module: 'question_bank',
    entityType: 'question',
    entityId: id,
    entityTitle: existing.question_code,
    description: `${req.user.name} desativou a questão ${existing.question_code}.`,
    metadata: {
      question_code: existing.question_code,
      previous_status: existing.status,
      current_status: 'inactive',
    },
    isCritical: true,
    req,
  });

  res.json({ message: 'Questão desativada com sucesso.' });
});

// ─────────────────────────────────────────────
// POST /api/question-bank/question-sets
// Cria um simulado com questões selecionadas
// Professor e admin podem criar
// ─────────────────────────────────────────────

function readCreatedQuestionSet(id, ownerId) {
  return db.prepare(`
    SELECT qs.*, u.name AS user_name,
      (SELECT COUNT(*) FROM question_set_items item WHERE item.question_set_id = qs.id) AS question_count,
      (SELECT COUNT(*) FROM question_set_items item JOIN questions q ON q.id = item.question_id
        WHERE item.question_set_id = qs.id AND q.source = 'teacher') AS author_question_count
    FROM question_sets qs
    LEFT JOIN users u ON u.id = qs.user_id
    WHERE qs.id = ? AND qs.user_id = ?
  `).get(id, ownerId);
}

const questionSetDigest = value => createHash('sha256').update(value).digest('hex');

router.post('/question-sets', (req, res, next) => {
  const key = req.get('Idempotency-Key');
  res.set('Cache-Control', 'private, no-store');
  if (key !== undefined && !/^[A-Za-z0-9._:-]{16,120}$/.test(key)) {
    return res.status(400).json({ code: 'invalid_idempotency_key', error: 'Chave de idempotência inválida.' });
  }

  const body = req.body ?? {};
  const title = typeof body.title === 'string' ? body.title.trim() : '';
  if (!title) {
    return res.status(400).json({ error: 'Título é obrigatório.' });
  }

  if (title.length > 200) {
    return res.status(400).json({ error: 'Título deve ter no máximo 200 caracteres.' });
  }

  if (body.description != null && typeof body.description !== 'string') {
    return res.status(400).json({ error: 'Descrição inválida.' });
  }
  if (body.description?.length > 5000) {
    return res.status(400).json({ error: 'Descrição deve ter no máximo 5000 caracteres.' });
  }
  const description = body.description?.trim() || null;
  const requestedPublic = parseBooleanField(body.is_public);

  const { submittedCount, uniqueQuestionIds, questionItems } = normalizeQuestionSetSubmission(body);
  if (submittedCount === 0) {
    return res.status(400).json({ error: 'Selecione pelo menos uma questão.' });
  }

  if (submittedCount > MAX_QUESTION_SET_ITEMS) {
    return res.status(400).json({ error: 'O simulado pode ter no máximo 100 questões.' });
  }

  if (uniqueQuestionIds.length === 0) {
    return res.status(400).json({ error: 'Nenhuma questão válida foi enviada.' });
  }

  const keyHash = key === undefined ? null : questionSetDigest(key);
  const fingerprint = keyHash && questionSetDigest(JSON.stringify([title, description, requestedPublic, questionItems]));
  const createSet = db.transaction(() => {
    if (keyHash) {
      const receipt = db.prepare(`SELECT request_fingerprint, question_set_id FROM question_set_creation_receipts
        WHERE owner_user_id = ? AND idempotency_key_hash = ?`).get(req.user.id, keyHash);
      if (receipt) {
        if (receipt.request_fingerprint !== fingerprint) {
          return { status: 409, code: 'question_set_idempotency_conflict', error: 'Esta chave de envio já foi usada com outros dados.' };
        }
        const existing = readCreatedQuestionSet(receipt.question_set_id, req.user.id);
        if (!existing) return { status: 410, code: 'question_set_deleted', error: 'O simulado deste envio foi excluído.' };
        return { status: 200, result: existing };
      }
    }

    const placeholders = uniqueQuestionIds.map(() => '?').join(',');
    const visibilityClause = req.user.role === 'admin'
      ? ''
      : `AND (source = 'official' OR (source = 'teacher' AND created_by = ?))`;
    const visibilityParams = req.user.role === 'admin' ? [] : [req.user.id];
    const activeQuestions = db.prepare(`
      SELECT q.source, editorial.state AS editorial_state FROM questions q
      LEFT JOIN question_editorial_curation editorial ON editorial.question_id = q.id
      WHERE q.id IN (${placeholders}) AND q.status = 'active' AND q.question_type IS NOT 'numeric_draft'
      AND ${editorialEligibleSql('q', { pilotEnabled: isEditorialPilotEnabled(db, req.user) })}
      ${visibilityClause}
    `).all(...uniqueQuestionIds, ...visibilityParams);

    if (activeQuestions.length !== uniqueQuestionIds.length) {
      return { status: 400, error: 'Uma ou mais questões não estão disponíveis para novos simulados. Atualize a seleção.' };
    }

    const optionOrders = createQuestionSetOptionOrders(
      db, questionItems, `question-set:new:${req.user.id}:${title}:${uniqueQuestionIds.join(',')}`
    );
    const authorQuestionCount = activeQuestions.filter(question => question.source === 'teacher').length;
    const containsAuthorQuestions = authorQuestionCount > 0;
    const containsEditorialPilot = activeQuestions.some(question => question.editorial_state === 'pilot');
    const effectiveIsPublic = Number(!containsAuthorQuestions && !containsEditorialPilot && requestedPublic);
    const result = db.prepare(`
      INSERT INTO question_sets (
        user_id,
        title,
        description,
        is_public,
        contains_author_questions
      )
      VALUES (?, ?, ?, ?, ?)
    `).run(
      req.user.id,
      title,
      description,
      effectiveIsPublic,
      containsAuthorQuestions ? 1 : 0
    );

    const questionSetId = result.lastInsertRowid;

    const insertItem = db.prepare(`
      INSERT INTO question_set_items (
        question_set_id,
        question_id,
        sort_order,
        show_image,
        option_order
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    questionItems.forEach((item) => {
      insertItem.run(
        questionSetId,
        item.question_id,
        item.sort_order,
        item.show_image,
        optionOrders.get(item.question_id)
      );
    });

    if (keyHash) {
      db.prepare(`INSERT INTO question_set_creation_receipts (owner_user_id, idempotency_key_hash,
        request_fingerprint, question_set_id) VALUES (?, ?, ?, ?)`)
        .run(req.user.id, keyHash, fingerprint, questionSetId);
    }
    const created = readCreatedQuestionSet(questionSetId, req.user.id);
    if (created.is_public === 1) {
      notifyAllExcept(
        req.user.id,
        'new_public_question_set',
        'Novo simulado público disponível',
        `"${created.title}" foi compartilhado no Banco de Questões.`,
        { question_set_id: created.id }
      );
    }
    if (req.user.role === 'professor') {
      notifyAdmins(
        req.user.id,
        'teacher_question_set_created',
        'Novo simulado criado por professor',
        authorQuestionCount > 0
          ? `${req.user.name} criou "${created.title}" com ${authorQuestionCount} questão(ões) autoral(is).`
          : `${req.user.name} criou o simulado "${created.title}".`,
        { question_set_id: created.id, creator_id: req.user.id, author_question_count: authorQuestionCount }
      );
    }
    logActivityStrict({
      user: req.user,
      action: 'create_question_set',
      module: 'question_sets',
      entityType: 'question_set',
      entityId: created.id,
      entityTitle: created.title,
      description: `${req.user.name} criou o simulado "${created.title}".`,
      metadata: {
        title: created.title,
        is_public: Boolean(created.is_public),
        question_count: created.question_count,
        author_question_count: authorQuestionCount,
        contains_author_questions: containsAuthorQuestions,
        question_ids: uniqueQuestionIds,
        answer_key_methodology: 'balanced-answer-key-v1',
      },
      req,
    });
    return { status: 201, result: created };
  });

  try {
    const { status, result, code, error } = createSet.immediate();
    if (error) return res.status(status).json({ code, error });
    if (status === 200) res.set('Idempotency-Replayed', 'true');
    return res.status(status).json(result);
  } catch (error) {
    if (error instanceof AnswerKeyBalanceError) {
      return res.status(400).json({ error: error.message, questionId: error.questionId });
    }
    return next(error);
  }
});

// ─────────────────────────────────────────────
// GET /api/question-bank/question-sets
// Lista simulados do usuário e simulados públicos
// Admin pode ver todos usando ?all=1
// ─────────────────────────────────────────────

router.get('/question-sets', (req, res) => {
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(req.query.limit, 10) || 10));
  const offset = (page - 1) * limit;

  const conditions = [];
  const params = [];

  if (req.user.role !== 'admin') {
    conditions.push('(qs.user_id = ? OR qs.is_public = 1)');
    params.push(req.user.id);
  }

  if (req.query.search) {
    conditions.push('(qs.title LIKE ? OR qs.description LIKE ?)');
    const term = `%${req.query.search}%`;
    params.push(term, term);
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';

  const total = db.prepare(`
    SELECT COUNT(*) AS total
    FROM question_sets qs
    ${whereClause}
  `).get(...params).total;

  const sets = db.prepare(`
    SELECT
      qs.id,
      qs.user_id,
      u.name AS user_name,
      qs.title,
      qs.description,
      qs.is_public,
      qs.contains_author_questions,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic,
      diagnostic.grade_id AS diagnostic_grade_id,
      diagnostic_grade.name AS diagnostic_grade_name,
      CASE WHEN diagnostic_review.question_set_id IS NULL THEN 0 ELSE 1 END AS diagnostic_reviewed,
      diagnostic_review.reviewed_at AS diagnostic_reviewed_at,
      qs.created_at,
      qs.updated_at,
      (
        SELECT COUNT(*)
        FROM question_set_items qsi
        WHERE qsi.question_set_id = qs.id
      ) AS question_count,
      (
        SELECT COUNT(*)
        FROM question_set_items qsi
        JOIN questions q ON q.id = qsi.question_id
        WHERE qsi.question_set_id = qs.id AND q.source = 'teacher'
      ) AS author_question_count
    FROM question_sets qs
    LEFT JOIN users u ON u.id = qs.user_id
    LEFT JOIN diagnostic_question_sets diagnostic ON diagnostic.question_set_id = qs.id
    LEFT JOIN grades diagnostic_grade ON diagnostic_grade.id = diagnostic.grade_id
    LEFT JOIN diagnostic_question_set_reviews diagnostic_review
      ON diagnostic_review.question_set_id = diagnostic.question_set_id
    ${whereClause}
    ORDER BY qs.updated_at DESC, qs.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  res.json({
    data: sets,
    pagination: {
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit),
    },
  });
});

// ─────────────────────────────────────────────
// GET /api/question-bank/question-sets/:id
// Abre um simulado com suas questões e alternativas
// ─────────────────────────────────────────────

router.get('/question-sets/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const questionSet = db.prepare(`
    SELECT
      qs.*,
      u.name AS user_name,
      CASE WHEN diagnostic.question_set_id IS NULL THEN 0 ELSE 1 END AS is_diagnostic,
      diagnostic.grade_id AS diagnostic_grade_id,
      diagnostic_grade.name AS diagnostic_grade_name,
      diagnostic.algorithm_version AS diagnostic_algorithm_version,
      CASE WHEN diagnostic_review.question_set_id IS NULL THEN 0 ELSE 1 END AS diagnostic_reviewed,
      diagnostic_review.reviewed_by AS diagnostic_reviewed_by,
      diagnostic_review.reviewed_at AS diagnostic_reviewed_at,
      diagnostic_review.confirmation_version AS diagnostic_review_confirmation_version
    FROM question_sets qs
    LEFT JOIN users u ON u.id = qs.user_id
    LEFT JOIN diagnostic_question_sets diagnostic ON diagnostic.question_set_id = qs.id
    LEFT JOIN grades diagnostic_grade ON diagnostic_grade.id = diagnostic.grade_id
    LEFT JOIN diagnostic_question_set_reviews diagnostic_review
      ON diagnostic_review.question_set_id = diagnostic.question_set_id
    WHERE qs.id = ?
  `).get(id);

  if (!questionSet) {
    return res.status(404).json({ error: 'Simulado não encontrado.' });
  }

  const canAccess =
    questionSet.user_id === req.user.id ||
    (questionSet.is_public === 1 && questionSet.contains_author_questions !== 1) ||
    req.user.role === 'admin';

  if (!canAccess) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }
    try {
    db.prepare(`
      INSERT INTO question_set_access_history (
        user_id,
        question_set_id
      )
      VALUES (?, ?)
    `).run(req.user.id, id);
    } catch {
      // Não bloqueia a abertura do simulado caso o log falhe
    }

  const questions = db.prepare(`
    SELECT
      q.id,
      q.question_code,
      q.skill_id,
      bs.code AS skill_code,
      bs.description AS skill_description,
      bs.grade_id,
      g.name AS grade_name,
      bs.unit_id,
      bu.name AS unit_name,
      q.statement,
      q.support_text,
      q.image_path,
      q.development_space,
      q.difficulty,
      q.question_type,
      q.official_explanation,
      q.status,
      q.reviewed,
      q.source,
      q.created_by,
      creator.name AS creator_name,
      qsi.sort_order,
      qsi.show_image,
      qsi.option_order
    FROM question_set_items qsi
    INNER JOIN questions q ON q.id = qsi.question_id
    INNER JOIN bncc_skills bs ON bs.id = q.skill_id
    INNER JOIN grades g ON g.id = bs.grade_id
    INNER JOIN bncc_units bu ON bu.id = bs.unit_id
    LEFT JOIN users creator ON creator.id = q.created_by
    WHERE qsi.question_set_id = ?
    ORDER BY qsi.sort_order ASC, q.question_code ASC
  `).all(id);

  let optionOrders;
  try {
    const hasCompleteStoredOrder = questions.every(({ option_order: order }) => (
      Boolean(normalizeOptionOrder(order))
    ));
    optionOrders = hasCompleteStoredOrder
      ? new Map(questions.map((question) => [question.id, question.option_order]))
      : createQuestionSetOptionOrders(
        db,
        questions.map(({ id: questionId }) => ({ question_id: questionId })),
        `question-set:${id}`
      );
  } catch (error) {
    if (error instanceof AnswerKeyBalanceError) {
      return res.status(409).json({
        error: 'O gabarito deste simulado possui uma questão inválida e precisa ser revisado.',
        questionId: error.questionId,
      });
    }
    throw error;
  }
  const presentedQuestions = attachOptions(questions, optionOrders);

  res.json({
    ...questionSet,
    answer_key: answerKeySummary(presentedQuestions.map((question) => ({
      id: question.id,
      options: question.options,
    }))),
    questions: presentedQuestions,
  });
});

// Confirma a revisão pedagógica do diagnóstico. A confirmação é única,
// pertence ao professor autor e libera o simulado para aplicação em turmas.
router.post('/question-sets/:id/diagnostic-review', (req, res, next) => {
  const id = parsePositiveInt(req.params.id);
  if (!id) return res.status(400).json({ error: 'ID inválido.' });
  if (req.body?.confirmed !== true) {
    return res.status(400).json({
      error: 'Confirme explicitamente que você revisou as questões e o gabarito.',
    });
  }

  const currentUser = db.prepare('SELECT id, name, email, role FROM users WHERE id = ?')
    .get(req.user.id);
  if (!currentUser || currentUser.role !== 'professor') {
    return res.status(403).json({ error: 'A revisão deve ser confirmada pelo professor responsável.' });
  }

  try {
    const confirmReview = db.transaction(() => {
      const diagnostic = db.prepare(`
        SELECT diagnostic.question_set_id, diagnostic.owner_teacher_id, question_set.title
        FROM diagnostic_question_sets diagnostic
        JOIN question_sets question_set ON question_set.id = diagnostic.question_set_id
        WHERE diagnostic.question_set_id = ?
      `).get(id);
      if (!diagnostic) return { error: 404, message: 'Avaliação diagnóstica não encontrada.' };
      if (diagnostic.owner_teacher_id !== currentUser.id) {
        return { error: 403, message: 'Somente o professor responsável pode confirmar esta revisão.' };
      }

      const existing = db.prepare(`
        SELECT reviewed_by, reviewed_at, confirmation_version
        FROM diagnostic_question_set_reviews
        WHERE question_set_id = ?
      `).get(id);
      if (existing) return { diagnostic, review: existing, alreadyReviewed: true };

      db.prepare(`
        INSERT INTO diagnostic_question_set_reviews (
          question_set_id, owner_teacher_id, reviewed_by
        ) VALUES (?, ?, ?)
      `).run(id, currentUser.id, currentUser.id);
      const review = db.prepare(`
        SELECT reviewed_by, reviewed_at, confirmation_version
        FROM diagnostic_question_set_reviews
        WHERE question_set_id = ?
      `).get(id);
      return { diagnostic, review, alreadyReviewed: false };
    });

    const result = confirmReview.immediate();
    if (result.error) return res.status(result.error).json({ error: result.message });

    if (!result.alreadyReviewed) {
      logActivity({
        user: currentUser,
        action: 'review_diagnostic_question_set',
        module: 'question_sets',
        entityType: 'question_set',
        entityId: id,
        entityTitle: result.diagnostic.title,
        metadata: { confirmation_version: result.review.confirmation_version },
        req,
      });
    }

    return res.status(result.alreadyReviewed ? 200 : 201).json({
      questionSetId: id,
      reviewed: true,
      reviewedBy: result.review.reviewed_by,
      reviewedAt: result.review.reviewed_at,
      confirmationVersion: result.review.confirmation_version,
      alreadyReviewed: result.alreadyReviewed,
    });
  } catch (error) {
    return next(error);
  }
});

// ─────────────────────────────────────────────
// PUT /api/question-bank/question-sets/:id
// Edita título, descrição, visibilidade e questões do simulado
// Apenas dono ou admin
// ─────────────────────────────────────────────

router.put('/question-sets/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const questionSet = db.prepare(`
    SELECT *
    FROM question_sets
    WHERE id = ?
  `).get(id);

  if (!questionSet) {
    return res.status(404).json({ error: 'Simulado não encontrado.' });
  }

  const canEdit = questionSet.user_id === req.user.id || req.user.role === 'admin';

  if (!canEdit) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  const isDiagnostic = Boolean(db.prepare(`
    SELECT 1 FROM diagnostic_question_sets WHERE question_set_id = ?
  `).get(id));
  if (isDiagnostic) {
    return res.status(409).json({
      error: 'A composição diagnóstica fica preservada. Gere uma nova avaliação para trocar as questões.',
    });
  }

  const { title, description, is_public } = req.body;
  const existingImageVisibility = new Map(
    db.prepare(`
      SELECT question_id, show_image
      FROM question_set_items
      WHERE question_set_id = ?
    `).all(id).map((item) => [item.question_id, item.show_image])
  );
  const { submittedCount, uniqueQuestionIds, questionItems } = normalizeQuestionSetSubmission(
    req.body,
    existingImageVisibility
  );

  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Título é obrigatório.' });
  }

  if (title.trim().length > 200) {
    return res.status(400).json({ error: 'Título deve ter no máximo 200 caracteres.' });
  }

  if (description && description.length > 5000) {
    return res.status(400).json({ error: 'Descrição deve ter no máximo 5000 caracteres.' });
  }

  if (submittedCount === 0) {
    return res.status(400).json({ error: 'Selecione pelo menos uma questão.' });
  }

  if (submittedCount > MAX_QUESTION_SET_ITEMS) {
    return res.status(400).json({ error: 'O simulado pode ter no máximo 100 questões.' });
  }

  if (uniqueQuestionIds.length === 0) {
    return res.status(400).json({ error: 'Nenhuma questão válida foi enviada.' });
  }

  const placeholders = uniqueQuestionIds.map(() => '?').join(',');

  const updateVisibilityClause = req.user.role === 'admin'
    ? ''
    : `AND (source = 'official' OR (source = 'teacher' AND created_by = ?))`;
  const updateVisibilityParams = req.user.role === 'admin' ? [] : [req.user.id];

  const activeQuestions = db.prepare(`
    SELECT q.id, q.source, q.created_by, editorial.state AS editorial_state
    FROM questions q
    LEFT JOIN question_editorial_curation editorial ON editorial.question_id = q.id
    WHERE q.id IN (${placeholders})
    AND q.status = 'active'
    AND ${editorialEligibleSql('q', { pilotEnabled: isEditorialPilotEnabled(db, req.user) })}
    ${updateVisibilityClause}
  `).all(...uniqueQuestionIds, ...updateVisibilityParams);

  if (activeQuestions.length !== uniqueQuestionIds.length) {
    return res.status(400).json({
      error: 'Uma ou mais questões não estão disponíveis para novos simulados. Atualize a seleção.',
    });
  }

  let optionOrders;
  try {
    optionOrders = createQuestionSetOptionOrders(
      db,
      questionItems,
      `question-set:update:${id}:${uniqueQuestionIds.join(',')}`
    );
  } catch (error) {
    if (error instanceof AnswerKeyBalanceError) {
      return res.status(400).json({ error: error.message, questionId: error.questionId });
    }
    throw error;
  }

  const authorQuestionCount = activeQuestions.filter((question) => question.source === 'teacher').length;
  const containsAuthorQuestions = authorQuestionCount > 0;
  const containsEditorialPilot = activeQuestions.some(question => question.editorial_state === 'pilot');
  const effectiveIsPublic = Number(!containsAuthorQuestions && !containsEditorialPilot && parseBooleanField(is_public));

  const updateSet = db.transaction(() => {
    db.prepare(`
      UPDATE question_sets
      SET
        title = ?,
        description = ?,
        is_public = ?,
        contains_author_questions = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(
      title.trim(),
      description?.trim() || null,
      effectiveIsPublic,
      containsAuthorQuestions ? 1 : 0,
      id
    );

    db.prepare(`
      DELETE FROM question_set_items
      WHERE question_set_id = ?
    `).run(id);

    const insertItem = db.prepare(`
      INSERT INTO question_set_items (
        question_set_id,
        question_id,
        sort_order,
        show_image,
        option_order
      )
      VALUES (?, ?, ?, ?, ?)
    `);

    questionItems.forEach((item) => {
      insertItem.run(
        id,
        item.question_id,
        item.sort_order,
        item.show_image,
        optionOrders.get(item.question_id)
      );
    });
  });

  updateSet();

    const updated = db.prepare(`
      SELECT
        qs.*,
        u.name AS user_name,
        (
          SELECT COUNT(*)
          FROM question_set_items qsi
          WHERE qsi.question_set_id = qs.id
        ) AS question_count,
        (
          SELECT COUNT(*)
          FROM question_set_items qsi
          JOIN questions q ON q.id = qsi.question_id
          WHERE qsi.question_set_id = qs.id AND q.source = 'teacher'
        ) AS author_question_count
      FROM question_sets qs
      LEFT JOIN users u ON u.id = qs.user_id
      WHERE qs.id = ?
    `).get(id);

    const becamePublic = questionSet.is_public !== 1 && updated.is_public === 1;

    if (becamePublic) {
      notifyAllExcept(
        req.user.id,
        'new_public_question_set',
        'Novo simulado público disponível',
        `"${updated.title}" foi compartilhado no Banco de Questões.`,
        { question_set_id: updated.id }
      );
    }

    logActivity({
      user: req.user,
      action: 'update_question_set',
      module: 'question_sets',
      entityType: 'question_set',
      entityId: updated.id,
      entityTitle: updated.title,
      description: `${req.user.name} atualizou o simulado "${updated.title}".`,
      metadata: {
        previous: {
          title: questionSet.title,
          description: questionSet.description,
          is_public: Boolean(questionSet.is_public),
        },
        current: {
          title: updated.title,
          description: updated.description,
          is_public: Boolean(updated.is_public),
          question_count: updated.question_count,
          author_question_count: updated.author_question_count,
          contains_author_questions: Boolean(updated.contains_author_questions),
        },
        question_ids: uniqueQuestionIds,
        answer_key_methodology: 'balanced-answer-key-v1',
      },
      isCritical: becamePublic,
      req,
    });

    res.json(updated);
});

// ─────────────────────────────────────────────
// PATCH /api/question-bank/question-sets/:id/items/:questionId/image-visibility
// Define se a imagem aparece neste simulado específico
// Apenas dono ou admin
// ─────────────────────────────────────────────

router.patch('/question-sets/:id/items/:questionId/image-visibility', (req, res) => {
  const id = parsePositiveInt(req.params.id);
  const questionId = parsePositiveInt(req.params.questionId);

  if (!id || !questionId) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const item = db.prepare(`
    SELECT
      qsi.id,
      qsi.show_image,
      qs.user_id,
      q.image_path
    FROM question_set_items qsi
    INNER JOIN question_sets qs ON qs.id = qsi.question_set_id
    INNER JOIN questions q ON q.id = qsi.question_id
    WHERE qsi.question_set_id = ? AND qsi.question_id = ?
  `).get(id, questionId);

  if (!item) {
    return res.status(404).json({ error: 'Questão não encontrada neste simulado.' });
  }

  if (item.user_id !== req.user.id && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  if (!item.image_path) {
    return res.status(400).json({ error: 'Esta questão não possui imagem de apoio.' });
  }

  const showImage = parseBooleanField(req.body.show_image) ? 1 : 0;

  db.transaction(() => {
    db.prepare(`
      UPDATE question_set_items
      SET show_image = ?
      WHERE id = ?
    `).run(showImage, item.id);

    db.prepare(`
      UPDATE question_sets
      SET updated_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(id);
  })();

  res.json({
    question_set_id: id,
    question_id: questionId,
    show_image: showImage,
  });
});

// ─────────────────────────────────────────────
// DELETE /api/question-bank/question-sets/:id
// Exclui simulado
// Apenas dono ou admin
// ─────────────────────────────────────────────

router.delete('/question-sets/:id', (req, res) => {
  const id = parsePositiveInt(req.params.id);

  if (!id) {
    return res.status(400).json({ error: 'ID inválido.' });
  }

  const questionSet = db.prepare(`
    SELECT *
    FROM question_sets
    WHERE id = ?
  `).get(id);

  if (!questionSet) {
    return res.status(404).json({ error: 'Simulado não encontrado.' });
  }

  const canDelete = questionSet.user_id === req.user.id || req.user.role === 'admin';

  if (!canDelete) {
    return res.status(403).json({ error: 'Acesso negado.' });
  }

  db.prepare(`
    DELETE FROM question_sets
    WHERE id = ?
  `).run(id);

  logActivity({
    user: req.user,
    action: 'delete_question_set',
    module: 'question_sets',
    entityType: 'question_set',
    entityId: questionSet.id,
    entityTitle: questionSet.title,
    description: `${req.user.name} excluiu o simulado "${questionSet.title}".`,
    metadata: {
      title: questionSet.title,
      is_public: Boolean(questionSet.is_public),
    },
    isCritical: true,
    req,
  });

  res.json({ message: 'Simulado excluído com sucesso.' });
});
module.exports = router;
