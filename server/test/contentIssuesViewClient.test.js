const test = require('node:test'), assert = require('node:assert/strict');
let view;
test.before(async () => { view = await import('../../client/src/services/contentIssuesView.mjs'); });
const item = () => ({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', targetType: 'question', targetId: 1, targetLabel: 'QA-01', reason: 'answer', status: 'open', revision: 1, createdAt: '2026-09-16 12:00:00', updatedAt: '2026-09-16 12:00:00' });
const detail = () => ({ ...item(), description: 'Relato sintético para conferência.', assignee: null, canClaim: false, canReview: false, targetAvailable: true, targetPath: '/banco-questoes?search=QA-01', events: [{ action: 'created', reply: '', revision: 1, createdAt: item().createdAt }] });
test('contrato de lista aceita página vazia mas rejeita identidade, total, enums e duplicatas inválidos', () => {
  assert.equal(view.parseIssueList({ items: [], total: 0, page: 1, pageSize: 20 }).total, 0);
  const valid = { items: [item()], total: 1, page: 1, pageSize: 20 };
  assert.deepEqual(view.parseIssueList(valid), valid);
  for (const extra of [{ items: [item(), item()], total: 2 }, { total: -1 }, { page: 0 }, { pageSize: 200 }, { items: [{ ...item(), status: 'unexpected' }] }, { items: [{ ...item(), targetId: '1' }] }]) assert.throws(() => view.parseIssueList({ ...valid, ...extra }));
});
test('detalhe não aceita links externos, HTML como link, flags ausentes ou histórico inválido', () => {
  assert.deepEqual(view.parseIssue(detail()), detail());
  for (const extra of [{ targetPath: 'https://example.invalid' }, { targetPath: '//example.invalid' }, { targetPath: 'javascript:alert(1)' }, { targetPath: '/admin/usuarios' }, { canReview: 'true' }, { canClaim: undefined }, { events: [{ action: 'delete' }] }]) assert.throws(() => view.parseIssue({ ...detail(), ...extra }));
  assert.equal(view.parseIssue({ ...detail(), targetAvailable: false, targetPath: null }).targetPath, null);
});
test('recibos exigem identificador e textos de situação distinguem revisão de correção automática', () => {
  assert.equal(view.parseIssueReceipt({ id: item().id }).id, item().id);
  for (const value of [null, {}, { id: 4 }, { id: '/admin' }]) assert.throws(() => view.parseIssueReceipt(value));
  assert.match(view.issueStatuses.not_changed, /sem alteração/); assert.match(view.issueStatuses.resolved, /ajustado/);
  assert.equal(view.issueDate('invalid'), 'Data indisponível');
});
test('relatos definem seu contraste sem regra global dependente da estrutura do cabeçalho', () => {
  const css = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../client/src/index.css'), 'utf8');
  const page = require('node:fs').readFileSync(require('node:path').resolve(__dirname, '../../client/src/pages/ContentIssues.jsx'), 'utf8');
  assert.match(page, /data-content-issues className="[^"]*\bbg-slate-50\b[^"]*\btext-slate-900\b[^"]*\bdark:bg-transparent\b[^"]*\bdark:text-slate-100\b/);
  assert.doesNotMatch(css, /html:not\(\.dark\)\s+\.app-shell\s+main\s*>\s*\.animate-fade-in/);
});
