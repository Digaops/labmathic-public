module.exports = {
  version: 22,
  name: 'question_bank_catalog_preview',
  description: 'Adiciona a flag independente do laboratorio de descoberta e qualidade do banco.',
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
        'question_bank.catalog_preview',
        'Laboratorio do Banco de Questoes 2.0',
        'Valida filtros e criterios de qualidade com itens sinteticos somente leitura.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.2.0';
    `);
  },
};
