// Public messages are allowlisted. Never forward provider messages, bodies or stacks.
const ERRORS = Object.freeze({
  AI_NOT_CONFIGURED: [503, 'A ajuda de IA ainda não está configurada. Continue criando pelo editor.'],
  AI_DISABLED: [403, 'A ajuda de IA ainda não está liberada para esta conta.'],
  AI_FORBIDDEN: [403, 'Este recurso está disponível apenas para professores e administradores.'],
  AI_INVALID_REQUEST: [400, 'Confira o ano escolar, o tema, a dificuldade e o tipo de questão.'],
  AI_SKILL_NOT_FOUND: [400, 'Escolha uma habilidade de matemática cadastrada no LabMathic.'],
  AI_SKILL_MISMATCH: [400, 'A habilidade não pertence ao ano escolar selecionado.'],
  AI_CURRICULUM_CHANGED: [409, 'O cadastro da habilidade mudou. Confira a seleção antes de gerar novamente.'],
  AI_PERSONAL_DATA: [400, 'Retire dados de pessoas, credenciais e marcações do texto antes de continuar.'],
  AI_PROMPT_TOO_LONG: [400, 'O texto ultrapassa o limite permitido. Resuma o tema e as orientações.'],
  AI_TOO_MANY_QUESTIONS: [400, 'Solicite de uma a cinco questões, respeitando o limite configurado.'],
  AI_RATE_LIMITED: [429, 'Você fez vários pedidos em pouco tempo. Aguarde um minuto.'],
  AI_DAILY_LIMIT_REACHED: [429, 'Você atingiu o limite de gerações de hoje. Continue pelo editor.'],
  AI_MONTHLY_LIMIT_REACHED: [429, 'Você atingiu o limite de gerações deste mês. Continue pelo editor.'],
  AI_BUDGET_LIMIT_REACHED: [429, 'O orçamento disponível para IA foi atingido. Avise a administração.'],
  AI_DUPLICATE_REQUEST: [409, 'Este pedido já foi recebido. Ele não será cobrado novamente com a mesma chave.'],
  AI_TIMEOUT: [504, 'A IA demorou além do esperado. O pedido não será repetido automaticamente.'],
  AI_PROVIDER_RATE_LIMITED: [503, 'A IA está com muitos pedidos. Tente novamente mais tarde.'],
  AI_PROVIDER_UNAVAILABLE: [503, 'Não foi possível consultar a IA. Continue pelo editor ou tente mais tarde.'],
  AI_RESPONSE_REFUSED: [422, 'A IA não conseguiu atender este pedido. Revise o tema e as orientações.'],
  AI_INCOMPLETE_RESPONSE: [502, 'A sugestão não ficou completa. Tente pedir menos questões.'],
  AI_INVALID_RESPONSE: [502, 'A sugestão não passou pela conferência. Nenhuma questão foi salva.'],
  AI_USAGE_UNAVAILABLE: [503, 'Não foi possível conferir o consumo de IA. Nenhuma nova chamada será feita neste pedido.'],
});
class AiError extends Error {
  constructor(code) {
    const safeCode = Object.hasOwn(ERRORS, code) ? code : 'AI_PROVIDER_UNAVAILABLE';
    super(ERRORS[safeCode][1]);
    this.code = safeCode;
    this.status = ERRORS[safeCode][0];
  }
}
function fail(code) { throw new AiError(code); }
module.exports = { AiError, fail };
