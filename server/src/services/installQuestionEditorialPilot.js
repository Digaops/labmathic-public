const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const BATCH = 'math-ef-2026-11';
const TARGET_SKILLS = ['EF05MA06', 'EF05MA09', 'EF05MA12', 'EF05MA22',
  'EF09MA05', 'EF09MA07', 'EF09MA08', 'EF09MA21'];
const STAGE_COUNTS = { prerequisite: 1, application: 2, reasoning: 1, practice: 1, verification: 1 };
const WORD = /^[a-z0-9][a-z0-9_-]{1,100}$/i;
const HEX = /^[a-f0-9]{64}$/;
const LABELS = ['A', 'B', 'C', 'D'];
const digest = (value) => createHash('sha256').update(value).digest('hex');
const text = (value, max) => typeof value === 'string' && value.trim() === value && Boolean(value) && value.length <= max;
const comparable = (value) => value.normalize('NFKC').toLowerCase().replace(/\s+/gu, ' ').trim();

function questionContentDigest(question, options) {
  return digest(JSON.stringify([
    question.skill_code, question.statement, question.support_text || null, question.image_path || null,
    options.map(option => [option.option_label, option.option_text, option.is_correct]),
  ]));
}

function loadManifest(directory, file, expectedHash) {
  const content = fs.readFileSync(path.join(__dirname, '../data', directory, file), 'utf8').replace(/\r\n/g, '\n');
  if (!HEX.test(expectedHash) || digest(content) !== expectedHash) {
    throw new Error(`O arquivo ${file} diverge do lote editorial registrado.`);
  }
  return JSON.parse(content);
}

function validateItem(item) {
  if (typeof item?.skillCode !== 'string' || !/^EF0[1-9]MA\d{2}$/.test(item.skillCode)
      || !text(item.statement, 2000) || !text(item.explanation, 3000)
      || ((item.supportText != null || item.stage === 'practice' || item.skillCode === 'EF09MA21') && !text(item.supportText, 3000))
      || typeof item.family !== 'string' || !WORD.test(item.family)
      || !['facil', 'media', 'dificil'].includes(item.difficulty)
      || !Array.isArray(item.options) || item.options.length !== 4
      || !Number.isInteger(item.correctIndex) || item.correctIndex < 0 || item.correctIndex > 3
      || item.options.some(option => !text(option?.text, 1000) || !text(option?.reason, 1000))
      || new Set(item.options.map(option => comparable(option.text))).size !== 4) {
    throw new Error(`Item editorial inválido em ${item?.skillCode}.`);
  }
}

function validatePilot(items) {
  validateBatch(items, 48);
  for (const skill of TARGET_SKILLS) {
    const rows = items.filter(item => item.skillCode === skill);
    if (rows.length !== 6 || Object.entries(STAGE_COUNTS).some(([stage, count]) =>
      rows.filter(item => item.stage === stage).length !== count)) {
      throw new Error(`Distribuição editorial inválida em ${skill}.`);
    }
    const verification = rows.find(item => item.stage === 'verification');
    if (rows.some(item => item !== verification && item.family === verification.family)) {
      throw new Error(`A verificação de ${skill} deve ter outro modelo de solução.`);
    }
  }
}

function validateBatch(items, size) {
  if (items.length !== size) throw new Error(`O lote deve conter ${size} questões.`);
  items.forEach(validateItem);
  if (new Set(items.map(item => comparable(item.statement))).size !== items.length) {
    throw new Error('O lote contém enunciados repetidos.');
  }
}

function prepareQuestionRead(database) {
  return database.prepare(`
    SELECT q.id, q.source, q.question_type, q.statement, q.support_text, q.image_path, s.code AS skill_code
    FROM questions q JOIN bncc_skills s ON s.id = q.skill_id
    WHERE q.question_code = ?
  `);
}

function prepareOptionRead(database) {
  return database.prepare(`
    SELECT option_label, option_text, is_correct FROM question_options
    WHERE question_id = ? ORDER BY option_label
  `);
}

function prepareCurationInsert(database) {
  return database.prepare(`
    INSERT INTO question_editorial_curation
      (question_id, batch_key, state, stage, family, reason, content_sha256, rationales_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
}

function cataloguedSkillCodes(database) {
  if (!database.pragma('table_info(bncc_skills)').some(column => column.name === 'code')) return new Set();
  return new Set(database.prepare('SELECT code FROM bncc_skills').pluck().all());
}

function installEditorialDrafts(database, items, batch) {
  const skillCodes = [...new Set(items.map(item => item.skillCode))];
  const gradeHasOrder = database.pragma('table_info(grades)').some(column => column.name === 'sort_order');
  const catalog = cataloguedSkillCodes(database);
  if (!gradeHasOrder || !skillCodes.some(code => catalog.has(code))) {
    return { prepared: 0, missingSkills: skillCodes };
  }
  const findSkill = database.prepare(`
    SELECT s.id FROM bncc_skills s JOIN grades g ON g.id = s.grade_id
    WHERE s.code = ? AND g.sort_order = ?
  `);
  const skills = new Map(skillCodes.map(code => [code, findSkill.get(code, Number(code.slice(2, 4)))?.id]));
  const readQuestion = prepareQuestionRead(database);
  const readOptions = prepareOptionRead(database);
  const insertEntry = prepareCurationInsert(database);
  const insertQuestion = database.prepare(`
    INSERT INTO questions
      (question_code, skill_id, statement, support_text, difficulty, question_type, official_explanation, status, reviewed, source)
    VALUES (?, ?, ?, ?, ?, 'multiple_choice', ?, 'inactive', 0, 'official')
  `);
  const insertOption = database.prepare(`
    INSERT INTO question_options (question_id, option_label, option_text, is_correct, sort_order)
    VALUES (?, ?, ?, ?, ?)
  `);

  let prepared = 0;
  for (const item of items) {
    const { questionCode, answerPosition } = item;
    const skillId = skills.get(item.skillCode);
    if (!skillId) continue;
    const { lastInsertRowid: id } = insertQuestion.run(questionCode, skillId, item.statement, item.supportText || null,
      item.difficulty, item.explanation);
    // Rotate authored answers to avoid encoding a position pattern in the source.
    const ordered = item.options.filter((_, index) => index !== item.correctIndex);
    ordered.splice(answerPosition, 0, item.options[item.correctIndex]);
    ordered.forEach((option, index) => insertOption.run(id, LABELS[index], option.text, Number(index === answerPosition), index + 1));
    const rationales = Object.fromEntries(ordered.map((option, index) => [LABELS[index], option.reason]));
    const fingerprint = questionContentDigest(readQuestion.get(questionCode), readOptions.all(id));
    insertEntry.run(id, batch, 'pilot', item.stage, item.family, 'Preparado para revisão pedagógica independente.',
      fingerprint, JSON.stringify(rationales));
    prepared++;
  }
  return { prepared, missingSkills: skillCodes.filter(code => !skills.get(code)) };
}

function installQuestionEditorialPilot(database, hashes) {
  const directory = 'question-quality-pilot';
  const holds = loadManifest(directory, 'holds.json', hashes.holds);
  const items = [...loadManifest(directory, 'grade5.json', hashes.grade5), ...loadManifest(directory, 'grade9.json', hashes.grade9)];
  validatePilot(items);
  if (!Array.isArray(holds) || !holds.length || new Set(holds.map(item => item.code)).size !== holds.length
      || holds.some(item => !/^EF0[1-9]MA\d{2}-Q\d{3}$/.test(item.code)
        || !HEX.test(item.sha256) || !text(item.reason, 500))) {
    throw new Error('Manifesto de questões bloqueadas inválido.');
  }
  const report = { held: 0, skippedHolds: [] };
  const catalog = cataloguedSkillCodes(database);
  if (holds.some(item => catalog.has(item.code.slice(0, 8)))) {
    const readQuestion = prepareQuestionRead(database);
    const readOptions = prepareOptionRead(database);
    const insertEntry = prepareCurationInsert(database);
    for (const hold of holds) {
      const question = readQuestion.get(hold.code);
      if (!question || question.source !== 'official' || question.question_type !== 'multiple_choice'
          || questionContentDigest(question, readOptions.all(question.id)) !== hold.sha256) {
        report.skippedHolds.push(hold.code);
        continue;
      }
      insertEntry.run(question.id, BATCH, 'held', null, null, hold.reason, hold.sha256, null);
      report.held++;
    }
  } else report.skippedHolds = holds.map(item => item.code);

  const drafts = TARGET_SKILLS.flatMap((skillCode, skillIndex) => items.filter(item => item.skillCode === skillCode)
    .map((item, position) => ({ ...item,
      questionCode: `${skillCode}-C26-${String(position + 1).padStart(2, '0')}`,
      answerPosition: (skillIndex + position) % LABELS.length,
    })));
  return { ...report, ...installEditorialDrafts(database, drafts, BATCH) };
}

function installQuestionEditorialChallenges(database, hashes) {
  const parts = ['grades1-3.json', 'grades4-6.json', 'grades7-9.json'];
  const items = parts.flatMap(file => {
    const part = loadManifest('question-quality-challenge', file, hashes[file]);
    if (!Array.isArray(part)) throw new Error(`O manifesto ${file} deve conter uma lista de questões.`);
    return part;
  });
  validateBatch(items, 27);
  if (new Set(items.map(item => item.skillCode)).size !== items.length
      || new Set(items.map(item => item.family)).size !== items.length
      || items.some(item => item.stage !== 'reasoning' || item.difficulty !== 'dificil')) {
    throw new Error('O lote de desafios deve ter habilidades e famílias distintas, com itens de raciocínio.');
  }
  for (let year = 1; year <= 9; year++) {
    if (items.filter(item => Number(item.skillCode.slice(2, 4)) === year).length !== 3) {
      throw new Error(`O ${year}º ano deve ter três questões no lote de desafios.`);
    }
  }
  return installEditorialDrafts(database, items.map((item, index) => ({ ...item,
    questionCode: `${item.skillCode}-D26-01`, answerPosition: index % LABELS.length,
  })), 'math-ef-challenges-2026-11');
}

module.exports = { installQuestionEditorialPilot, installQuestionEditorialChallenges, questionContentDigest };
