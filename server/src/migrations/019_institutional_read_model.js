module.exports = {
  version: 19,
  name: 'institutional_read_model',
  description: 'Adiciona a flag independente da visao institucional somente leitura.',
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
        'institutions.read_model',
        'Visao institucional somente leitura',
        'Exibe contexto proprio e agregados institucionais verificados sem permitir alteracoes.',
        id,
        0,
        0,
        0
      FROM product_releases
      WHERE version = '2.1.0';
    `);
  },
};
