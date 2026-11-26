const FILTER_KEYS = Object.freeze([
  'search',
  'interactionType',
  'grade',
  'unit',
  'reviewStatus',
  'source',
  'hasCommentedSolution',
  'printReady',
  'diagnosticCompatible',
]);

const REVIEW_STATUS_LABELS = Object.freeze({
  ready: 'Pronto para uso revisado',
  in_review: 'Em revisão pedagógica',
  needs_attention: 'Requer ajustes',
});

const SOURCE_LABELS = Object.freeze({
  official: 'Acervo oficial',
  teacher: 'Autoria docente',
});

const CRITERIA_LABELS = Object.freeze({
  alignment: 'Alinhamento à habilidade',
  clarity: 'Clareza e suficiência',
  cognitiveDemand: 'Demanda cognitiva',
  accessibility: 'Acessibilidade',
  scoring: 'Correção verificável',
  print: 'Equivalência em papel',
  feedback: 'Devolutiva pedagógica',
});

class QuestionBankCatalogPreviewError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'QuestionBankCatalogPreviewError';
    this.code = code;
    this.status = status;
  }
}

function criterion(id, state, evidence) {
  return Object.freeze({ id, label: CRITERIA_LABELS[id], state, evidence });
}

const ITEMS = Object.freeze([
  {
    id: 'fraction-equivalence-review',
    code: 'LAB-QB-001',
    title: 'Frações equivalentes em representação visual',
    interactionType: 'single_choice',
    interactionLabel: 'Escolha única',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática',
    grade: '5º ano',
    unit: 'Números',
    skillCode: 'EF05MA03',
    skillSummary: 'Identificar e representar frações, associando-as a pontos da reta numérica.',
    difficulty: 'Média',
    reviewStatus: 'ready',
    source: 'official',
    hasCommentedSolution: true,
    printReady: true,
    diagnosticCompatible: true,
    statement: 'Qual representação mostra uma fração equivalente a 1/2?',
    supportText: 'As quatro alternativas usam figuras de mesmo tamanho e contraste equivalente.',
    choices: ['Duas de quatro partes', 'Uma de três partes', 'Três de quatro partes', 'Duas de três partes'],
    reviewerNote: 'A habilidade, o comando e a evidência esperada estão alinhados; manter revisão de contraste na arte final.',
    criteria: [
      criterion('alignment', 'ready', 'O comando observa equivalência e não apenas leitura de numerador e denominador.'),
      criterion('clarity', 'ready', 'Enunciado curto, referência visual explícita e uma tarefa por vez.'),
      criterion('cognitiveDemand', 'ready', 'Exige comparar relações parte-todo em vez de localizar palavra-chave.'),
      criterion('accessibility', 'ready', 'Descrição textual prevista e figuras sem dependência exclusiva de cor.'),
      criterion('scoring', 'ready', 'Uma alternativa correta e distratores conceitualmente distinguíveis.'),
      criterion('print', 'ready', 'Mantém legibilidade e proporção em escala de cinza.'),
      criterion('feedback', 'ready', 'Inclui resolução comentada e leitura prudente dos distratores.'),
    ],
  },
  {
    id: 'even-number-selection-review',
    code: 'LAB-QB-002',
    title: 'Reconhecimento de números pares',
    interactionType: 'multiple_response',
    interactionLabel: 'Múltiplas respostas',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática parcial',
    grade: '4º ano',
    unit: 'Números',
    skillCode: 'EF04MA11',
    skillSummary: 'Identificar regularidades em sequências numéricas compostas por múltiplos.',
    difficulty: 'Baixa',
    reviewStatus: 'in_review',
    source: 'teacher',
    hasCommentedSolution: true,
    printReady: true,
    diagnosticCompatible: true,
    statement: 'Quais números podem ser organizados em pares sem deixar sobra?',
    supportText: 'O estudante pode selecionar mais de uma opção.',
    choices: ['2', '3', '4', '5'],
    reviewerNote: 'A regra é observável, mas a equipe deve decidir se o objetivo é reconhecer pares ou generalizar múltiplos de dois.',
    criteria: [
      criterion('alignment', 'attention', 'A habilidade selecionada é mais ampla do que a tarefa apresentada.'),
      criterion('clarity', 'ready', 'O comando informa a possibilidade de múltiplas respostas.'),
      criterion('cognitiveDemand', 'attention', 'A lista curta pode medir reconhecimento pontual; considerar uma justificativa oral na mediação.'),
      criterion('accessibility', 'ready', 'Seleções possuem rótulos explícitos e ordem de teclado previsível.'),
      criterion('scoring', 'ready', 'Crédito parcial desconta seleções incorretas e não supera a nota máxima.'),
      criterion('print', 'ready', 'Caixas de marcação preservam a equivalência da interação.'),
      criterion('feedback', 'ready', 'A resolução mostra formação de pares com e sem sobra.'),
    ],
  },
  {
    id: 'square-perimeter-review',
    code: 'LAB-QB-003',
    title: 'Perímetro de um quadrado',
    interactionType: 'numeric',
    interactionLabel: 'Resposta numérica',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática exata',
    grade: '5º ano',
    unit: 'Grandezas e medidas',
    skillCode: 'EF05MA20',
    skillSummary: 'Investigar área e perímetro de figuras planas e suas relações.',
    difficulty: 'Média',
    reviewStatus: 'ready',
    source: 'official',
    hasCommentedSolution: true,
    printReady: true,
    diagnosticCompatible: true,
    statement: 'Um quadrado tem lado de 3 cm. Qual é a medida de seu perímetro?',
    supportText: 'A unidade aparece no enunciado e no campo de resposta.',
    choices: [],
    reviewerNote: 'O item diferencia contorno e área, com unidade explícita e regra de correção determinística.',
    criteria: [
      criterion('alignment', 'ready', 'A ação solicitada observa diretamente o cálculo de perímetro.'),
      criterion('clarity', 'ready', 'Dados suficientes e unidade definida sem informação acessória.'),
      criterion('cognitiveDemand', 'ready', 'Exige selecionar a operação coerente com a grandeza.'),
      criterion('accessibility', 'ready', 'Não depende de imagem e aceita leitura linear.'),
      criterion('scoring', 'ready', 'Valor numérico canônico, sem inferir unidade digitada no campo.'),
      criterion('print', 'ready', 'Campo de resolução dimensionado para cálculo curto.'),
      criterion('feedback', 'ready', 'Compara a soma dos lados ao procedimento de área.'),
    ],
  },
  {
    id: 'fraction-ordering-review',
    code: 'LAB-QB-004',
    title: 'Ordenação de frações na reta',
    interactionType: 'ordering',
    interactionLabel: 'Ordenação',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática por posição',
    grade: '6º ano',
    unit: 'Números',
    skillCode: 'EF06MA08',
    skillSummary: 'Reconhecer, comparar e ordenar números racionais positivos.',
    difficulty: 'Alta',
    reviewStatus: 'needs_attention',
    source: 'teacher',
    hasCommentedSolution: false,
    printReady: true,
    diagnosticCompatible: false,
    statement: 'Organize as frações em ordem crescente.',
    supportText: 'A versão atual não explicita a estratégia esperada nem oferece reta de apoio.',
    choices: ['1/2', '2/3', '3/4', '5/6'],
    reviewerNote: 'Requer resolução comentada e decisão sobre o uso em diagnóstico antes de reutilização.',
    criteria: [
      criterion('alignment', 'ready', 'Comparação e ordenação correspondem à habilidade declarada.'),
      criterion('clarity', 'ready', 'O sentido da ordenação está explícito.'),
      criterion('cognitiveDemand', 'ready', 'A tarefa exige comparar denominadores diferentes.'),
      criterion('accessibility', 'attention', 'A interação precisa de instrução de teclado mais concreta para reordenação.'),
      criterion('scoring', 'ready', 'A regra por posição é determinística e conserva limite entre zero e um.'),
      criterion('print', 'ready', 'A sequência numerada oferece alternativa equivalente em papel.'),
      criterion('feedback', 'attention', 'Ainda não existe resolução que torne a estratégia comparativa verificável.'),
    ],
  },
  {
    id: 'proportional-matching-review',
    code: 'LAB-QB-005',
    title: 'Associação entre razão e representação',
    interactionType: 'matching',
    interactionLabel: 'Associação de colunas',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática por par',
    grade: '7º ano',
    unit: 'Álgebra',
    skillCode: 'EF07MA17',
    skillSummary: 'Resolver problemas que envolvam variação de proporcionalidade direta e inversa.',
    difficulty: 'Média',
    reviewStatus: 'in_review',
    source: 'official',
    hasCommentedSolution: true,
    printReady: true,
    diagnosticCompatible: false,
    statement: 'Associe cada situação à razão que a representa.',
    supportText: 'Os pares usam textos curtos e identificadores independentes da posição visual.',
    choices: [],
    reviewerNote: 'A associação está acessível, mas a compatibilidade diagnóstica depende de revisão da matriz de habilidades.',
    criteria: [
      criterion('alignment', 'attention', 'Duas situações podem exigir habilidades auxiliares não declaradas.'),
      criterion('clarity', 'ready', 'Colunas possuem títulos e correspondências semanticamente distintas.'),
      criterion('cognitiveDemand', 'ready', 'Exige interpretar a relação antes de associar a expressão.'),
      criterion('accessibility', 'ready', 'Pares são anunciados por rótulo e podem ser percorridos por teclado.'),
      criterion('scoring', 'ready', 'Cada origem aceita exatamente um destino e o crédito parcial é explícito.'),
      criterion('print', 'ready', 'Duas colunas cabem em A4 sem depender de linhas cruzadas.'),
      criterion('feedback', 'ready', 'O guia explica a relação representada em cada par.'),
    ],
  },
  {
    id: 'decimal-fill-review',
    code: 'LAB-QB-006',
    title: 'Composição de número decimal',
    interactionType: 'fill_blank',
    interactionLabel: 'Preenchimento de lacunas',
    correctionMode: 'automatic',
    correctionLabel: 'Correção automática por lacuna',
    grade: '5º ano',
    unit: 'Números',
    skillCode: 'EF05MA02',
    skillSummary: 'Ler, escrever e ordenar números racionais na forma decimal.',
    difficulty: 'Baixa',
    reviewStatus: 'needs_attention',
    source: 'teacher',
    hasCommentedSolution: false,
    printReady: false,
    diagnosticCompatible: false,
    statement: 'Complete: três inteiros e cinco décimos correspondem a ___.',
    supportText: 'A resposta aceita vírgula decimal, mas a ficha impressa ainda precisa de espaço adequado.',
    choices: [],
    reviewerNote: 'Antes do uso, explicitar equivalências aceitas e ajustar a versão impressa.',
    criteria: [
      criterion('alignment', 'ready', 'A escrita decimal corresponde à habilidade indicada.'),
      criterion('clarity', 'ready', 'O enunciado contém uma única lacuna e referência posicional.'),
      criterion('cognitiveDemand', 'attention', 'O item é adequado para verificação inicial, não para inferência ampla da habilidade.'),
      criterion('accessibility', 'ready', 'A lacuna possui rótulo completo e aceita vírgula ou ponto na entrada digital.'),
      criterion('scoring', 'attention', 'A lista de equivalências precisa ser congelada antes de publicação.'),
      criterion('print', 'attention', 'O espaço atual é insuficiente para escrita ampliada.'),
      criterion('feedback', 'attention', 'Não existe resolução comentada ou próxima ação cadastrada.'),
    ],
  },
]);

function uniqueValues(field) {
  return [...new Set(ITEMS.map((item) => item[field]))].sort((a, b) => a.localeCompare(b, 'pt-BR'));
}

const FILTER_OPTIONS = Object.freeze({
  interactionTypes: [...new Map(ITEMS.map((item) => [item.interactionType, item.interactionLabel])).entries()]
    .map(([value, label]) => ({ value, label })),
  grades: uniqueValues('grade'),
  units: uniqueValues('unit'),
  reviewStatuses: Object.entries(REVIEW_STATUS_LABELS).map(([value, label]) => ({ value, label })),
  sources: Object.entries(SOURCE_LABELS).map(([value, label]) => ({ value, label })),
});

function singleValue(value, label) {
  if (Array.isArray(value)) {
    throw new QuestionBankCatalogPreviewError('invalid_filter', `${label} deve possuir um único valor.`);
  }
  return String(value ?? '').trim();
}

function optionalEnum(value, allowed, label) {
  const normalized = singleValue(value, label);
  if (!normalized) return '';
  if (!allowed.includes(normalized)) {
    throw new QuestionBankCatalogPreviewError('invalid_filter', `${label} informado é inválido.`);
  }
  return normalized;
}

function optionalBoolean(value, label) {
  const normalized = singleValue(value, label).toLowerCase();
  if (!normalized) return null;
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new QuestionBankCatalogPreviewError('invalid_filter', `${label} deve ser true ou false.`);
}

function normalizeFilters(query = {}) {
  const unknown = Object.keys(query).filter((key) => !FILTER_KEYS.includes(key));
  if (unknown.length > 0) {
    throw new QuestionBankCatalogPreviewError('unknown_filter', 'A consulta contém filtros não permitidos.');
  }
  const search = singleValue(query.search, 'Busca');
  if (search.length > 80) {
    throw new QuestionBankCatalogPreviewError('invalid_filter', 'A busca deve possuir no máximo 80 caracteres.');
  }
  return {
    search: search.toLocaleLowerCase('pt-BR'),
    interactionType: optionalEnum(query.interactionType, ITEMS.map((item) => item.interactionType), 'Tipo de interação'),
    grade: optionalEnum(query.grade, FILTER_OPTIONS.grades, 'Ano escolar'),
    unit: optionalEnum(query.unit, FILTER_OPTIONS.units, 'Unidade temática'),
    reviewStatus: optionalEnum(query.reviewStatus, Object.keys(REVIEW_STATUS_LABELS), 'Estado de revisão'),
    source: optionalEnum(query.source, Object.keys(SOURCE_LABELS), 'Autoria'),
    hasCommentedSolution: optionalBoolean(query.hasCommentedSolution, 'Resolução comentada'),
    printReady: optionalBoolean(query.printReady, 'Prontidão para impressão'),
    diagnosticCompatible: optionalBoolean(query.diagnosticCompatible, 'Compatibilidade diagnóstica'),
  };
}

function matchesFilters(item, filters) {
  if (filters.search) {
    const haystack = [item.code, item.title, item.skillCode, item.skillSummary, item.statement]
      .join(' ')
      .toLocaleLowerCase('pt-BR');
    if (!haystack.includes(filters.search)) return false;
  }
  for (const field of ['interactionType', 'grade', 'unit', 'reviewStatus', 'source']) {
    if (filters[field] && item[field] !== filters[field]) return false;
  }
  for (const field of ['hasCommentedSolution', 'printReady', 'diagnosticCompatible']) {
    if (filters[field] !== null && item[field] !== filters[field]) return false;
  }
  return true;
}

function summarizeCriteria(criteria) {
  return criteria.reduce((summary, item) => {
    summary[item.state] = (summary[item.state] || 0) + 1;
    return summary;
  }, { ready: 0, attention: 0 });
}

function catalogItem(item) {
  return {
    id: item.id,
    code: item.code,
    title: item.title,
    interactionType: item.interactionType,
    interactionLabel: item.interactionLabel,
    correctionLabel: item.correctionLabel,
    grade: item.grade,
    unit: item.unit,
    skillCode: item.skillCode,
    difficulty: item.difficulty,
    reviewStatus: item.reviewStatus,
    reviewStatusLabel: REVIEW_STATUS_LABELS[item.reviewStatus],
    source: item.source,
    sourceLabel: SOURCE_LABELS[item.source],
    hasCommentedSolution: item.hasCommentedSolution,
    printReady: item.printReady,
    diagnosticCompatible: item.diagnosticCompatible,
    criteriaSummary: summarizeCriteria(item.criteria),
  };
}

function getQuestionBankCatalogPreview(query = {}) {
  const filters = normalizeFilters(query);
  const filtered = ITEMS.filter((item) => matchesFilters(item, filters));
  return {
    mode: 'question_bank_catalog_preview',
    synthetic: true,
    readOnly: true,
    catalogVersion: 1,
    filters: FILTER_OPTIONS,
    total: filtered.length,
    summary: {
      ready: filtered.filter((item) => item.reviewStatus === 'ready').length,
      inReview: filtered.filter((item) => item.reviewStatus === 'in_review').length,
      needsAttention: filtered.filter((item) => item.reviewStatus === 'needs_attention').length,
    },
    items: filtered.map(catalogItem),
  };
}

function getQuestionBankCatalogPreviewItem(itemId) {
  const item = ITEMS.find((candidate) => candidate.id === itemId);
  if (!item) {
    throw new QuestionBankCatalogPreviewError(
      'catalog_preview_item_not_found',
      'Item sintético de revisão não encontrado.',
      404,
    );
  }
  return {
    mode: 'question_bank_catalog_preview',
    synthetic: true,
    readOnly: true,
    item: {
      ...catalogItem(item),
      correctionMode: item.correctionMode,
      skillSummary: item.skillSummary,
      statement: item.statement,
      supportText: item.supportText,
      choices: item.choices,
      reviewerNote: item.reviewerNote,
      criteria: item.criteria,
    },
  };
}

module.exports = {
  FILTER_KEYS,
  QuestionBankCatalogPreviewError,
  getQuestionBankCatalogPreview,
  getQuestionBankCatalogPreviewItem,
};
