module.exports = {
  version: 11,
  name: 'balanced_assessment_answer_keys',
  description: 'Preserva uma distribuição segura e versionada das alternativas nos simulados.',
  up(db) {
    db.exec(`
      ALTER TABLE question_set_items
      ADD COLUMN option_order TEXT
        CHECK(
          option_order IS NULL
          OR (
            length(option_order) = 4
            AND instr(option_order, 'A') > 0
            AND instr(option_order, 'B') > 0
            AND instr(option_order, 'C') > 0
            AND instr(option_order, 'D') > 0
          )
        );
    `);
  },
};
