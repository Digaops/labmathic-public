export const issueReasons = { answer: 'Gabarito ou alternativa', content: 'Enunciado ou conteúdo', media: 'Arquivo, imagem ou vídeo', accessibility: 'Dificuldade de leitura ou acesso', other: 'Outro problema' };
export const issueStatuses = { open: 'Aguardando revisão', in_review: 'Em revisão', resolved: 'Revisão concluída: ajustado', not_changed: 'Revisão concluída: sem alteração' };
export const issueActions = { created: 'Relato enviado', claimed: 'Administração assumiu a revisão', resolved: 'Revisão concluída: ajustado', not_changed: 'Revisão concluída: sem alteração' };
const id = value => typeof value === 'string' && /^[0-9a-f-]{36}$/.test(value);
const positive = value => Number.isSafeInteger(value) && value > 0;
const string = value => typeof value === 'string';
function validSummary(row) { return row && id(row.id) && ['question', 'material'].includes(row.targetType) && positive(row.targetId) && string(row.targetLabel) && Object.hasOwn(issueStatuses, row.status) && Object.hasOwn(issueReasons, row.reason) && positive(row.revision) && string(row.createdAt) && string(row.updatedAt); }
function invalid() { throw new Error('Resposta de relatos inválida.'); }
export function parseIssueList(data) {
  if (!data || !Array.isArray(data.items) || data.items.length > 20 || !data.items.every(validSummary) || new Set(data.items.map(r => r.id)).size !== data.items.length || !Number.isSafeInteger(data.total) || data.total < data.items.length || !positive(data.page) || data.pageSize !== 20) invalid();
  return data;
}
export function parseIssue(data) {
  if (!validSummary(data) || !string(data.description) || !(data.assignee === null || string(data.assignee)) || !['canReview', 'canClaim', 'targetAvailable'].every(k => typeof data[k] === 'boolean') || !Array.isArray(data.events)
    || !data.events.every(e => e && Object.hasOwn(issueActions, e.action) && string(e.reply) && positive(e.revision) && string(e.createdAt))) invalid();
  if (data.targetPath !== null && !(string(data.targetPath) && (/^\/material\/[1-9]\d*$/.test(data.targetPath) || /^\/banco-questoes\?search=/.test(data.targetPath)))) invalid();
  return data;
}
export function parseIssueReceipt(data) { if (!data || !id(data.id)) invalid(); return data; }
export function issueDate(value) { const date = new Date(value.replace(' ', 'T') + (value.endsWith('Z') ? '' : 'Z')); return Number.isNaN(date.getTime()) ? 'Data indisponível' : date.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }); }
