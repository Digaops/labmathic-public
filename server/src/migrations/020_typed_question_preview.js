module.exports = {
  version: 20,
  name: 'typed_question_preview',
  description: 'Adiciona a flag independente do laboratorio tipado somente leitura.',
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
        'question_bank.typed_preview',
        'Laboratorio de formatos tipados',
        'Exibe exemplos sinteticos compilados para tela e impressao, sem autoria ou publicacao.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.2.0';
    `);
  },
};
