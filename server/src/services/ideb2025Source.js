// Reviewed release, not a user-supplied download address. Updating it requires a new review.
const sourcePage = 'https://www.gov.br/inep/pt-br/areas-de-atuacao/pesquisas-estatisticas-e-indicadores/ideb/resultados/2005-2025';
const sources = Object.freeze([
  { stage: 'elementary_initial', file: 'ideb-initial-2025.zip', sheet: 'IDEB_AI_MUNICÍPIOS',
    url: 'https://download.inep.gov.br/ideb/resultados/divulgacao_anos_iniciais_municipios_2025.zip',
    sha256: '89100286327ab07a4b1318ba51974d62da90af334f663bedf6374cb67298a3e7' },
  { stage: 'elementary_final', file: 'ideb-final-2025.zip', sheet: 'IDEB_AF_MUNICÍPIOS',
    url: 'https://download.inep.gov.br/ideb/resultados/divulgacao_anos_finais_municipios_2025.zip',
    sha256: '5f81ae18d33567608f10551d4f563a6879afc0182ff28cfd81e913958a30a6b3' },
]);
const ibge = Object.freeze({ file: 'ibge-municipalities.json',
  url: 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios',
  sha256: '86ecdccdf97d72e7e5e46f0854cfcea8bacc28154cc1bc4ed0e6110e3a6c9c02' });
module.exports = { sourcePage, sources, ibge, years: [2023, 2025], edition: 'inep-ideb-2025-reviewed-2026-09-14' };
