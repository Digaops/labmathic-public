module.exports = {
  version: 1,
  name: 'baseline_current_schema_v1_4_1',
  description: 'Registra como baseline o schema existente na versao v1.4.1.',
  up() {
    // Migração intencionalmente vazia.
    //
    // O database.js já cria e compatibiliza o schema existente antes de chamar
    // o executor formal. Esta baseline permite que toda alteração posterior
    // seja numerada, validada por checksum e executada uma única vez.
  },
};
