module.exports = {
  version: 21,
  name: 'typed_question_feedback_preview',
  description: 'Adiciona a flag independente do laboratorio de devolutivas pedagogicas.',
  up(db) {
    db.exec(`
      INSERT INTO feature_flags (
        flag_key,
        name,
        description,
        release_id,
        master_enabled,
        default_enabled,
        rollout_percentage
      )
      SELECT
        'question_bank.feedback_preview',
        'Laboratorio de devolutivas pedagogicas',
        'Simula gabarito comentado e politicas de liberacao com exemplos sinteticos somente leitura.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.2.0';
    `);
  },
};
