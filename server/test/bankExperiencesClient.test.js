const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const load = () => import('../../client/src/services/bankExperiences.mjs');
const source = relative => fs.readFileSync(path.join(__dirname, '../../client/src', relative), 'utf8');

for (const [name, input, expected] of [
  ['liberação confirmada', { role: 'professor', enabled: true }, 'operational'],
  ['sem liberação', { role: 'professor', enabled: false }, 'not_released'],
  ['carregando', { role: 'professor', loading: true, enabled: true }, 'loading'],
  ['falha antes da confirmação', { role: 'professor', unavailable: true }, 'unavailable'],
  ['falha após negativa anterior', { role: 'professor', enabled: false, unavailable: true }, 'unavailable'],
  ['falha transitória não desmonta formulário já autorizado', { role: 'professor', enabled: true, unavailable: true }, 'operational'],
  ['administrador não é docente', { role: 'admin', enabled: true }, 'role_restricted'],
  ['papel ausente', { enabled: true }, 'role_restricted'],
  ['liberação não booleana', { role: 'professor', enabled: 'true' }, 'not_released'],
  ['dependência confirmada desligada', { role: 'professor', enabled: true, dependenciesReady: false }, 'not_released'],
  ['dependência não confirmada durante falha', { role: 'professor', enabled: true, dependenciesReady: false, unavailable: true }, 'unavailable'],
]) test(`entrada operacional: ${name}`, async () => {
  const { bankAccessState } = await load();
  assert.equal(bankAccessState(input), expected);
});

test('revogação confirmada e nova identidade não reaproveitam liberação da conta anterior', async () => {
  const { bankAccessState } = await load();
  assert.equal(bankAccessState({ role: 'professor', enabled: false }), 'not_released');
  assert.equal(bankAccessState({ role: 'professor', loading: true }), 'loading');
  assert.match(source('contexts/FeatureFlagsContext.jsx'), /snapshot.identity === identity/);
});

test('acesso às devolutivas exige papel, liberação e dependências do ciclo', async () => {
  const { operationalBankState } = await load();
  const options = { feedback: true };
  const allowed = { isEnabled: () => true };
  assert.equal(operationalBankState('professor', allowed, options), 'operational');
  assert.equal(operationalBankState('professor', { ...allowed, unavailable: true }, options), 'operational');
  assert.equal(operationalBankState('professor', { ...allowed, loading: true }, options), 'loading');
  assert.equal(operationalBankState('admin', allowed, options), 'role_restricted');
  for (const disabled of ['pedagogy.operational_cycle', 'classes.core', 'classes.assessment_assignments', 'classes.assessment_results']) {
    const flags = { isEnabled: name => name !== disabled };
    assert.equal(operationalBankState('professor', flags, options), 'not_released');
    assert.equal(operationalBankState('professor', flags), disabled === 'pedagogy.operational_cycle' ? 'not_released' : 'operational');
  }
});

test('retorno à turma mantém somente identificador válido, sem redirecionamento externo', async () => {
  const { classReturnPath } = await load();
  const id = '11111111-2222-4333-8444-555555555555';
  assert.equal(classReturnPath(`?turma=${id}&avaliacao=123&return=https://example.invalid`), `/turmas?turma=${id}&secao=avaliacoes`);
  assert.equal(classReturnPath('?turma=class-recovery-public-id-0001'), '/turmas?turma=class-recovery-public-id-0001&secao=avaliacoes');
  for (const query of ['', '?turma=', '?turma=//example.invalid', '?turma=<script>']) assert.equal(classReturnPath(query), '/turmas');
});

test('cada exemplo tem endereço próprio, independente da flag operacional', async () => {
  const { BANK_EXAMPLES } = await load();
  assert.equal(BANK_EXAMPLES.length, 3);
  assert.equal(new Set(BANK_EXAMPLES.map(x => x.to)).size, 3);
  for (const item of BANK_EXAMPLES) {
    assert.match(item.to, /^\/exemplos\//);
    assert.match(item.label, /^Exemplos/);
    assert.match(item.flag, /_preview$/);
    assert.ok(source('App.jsx').includes(`path="${item.to.slice(1)}"`));
  }
});

test('URLs antigas de trabalho não possuem fallback demonstrativo nem redirecionamento', () => {
  const app = source('App.jsx');
  const experience = app.slice(app.indexOf('function BankExperience'), app.indexOf('function ProtectedRoute'));
  assert.match(experience, /OperationalBankAccess/);
  assert.doesNotMatch(experience, /TypedQuestionFeedbackLab|QuestionBankCatalogLab|Navigate/);
  const gate = source('components/OperationalBankAccess.jsx');
  assert.match(gate, /state === 'operational'/);
  assert.match(gate, /classReturnPath\(location.search\)/);
  assert.doesNotMatch(gate, /setSearchParams|navigate\(|api\.(post|put|patch|delete)/);
});

test('início, atalhos e menus distinguem trabalhar de experimentar', () => {
  const home = source('components/TeacherHome.jsx');
  const admin = source('components/AdministrativeHome.jsx');
  const menu = source('components/Header.jsx');
  assert.match(home, /feedbackAvailable && <ToolLink to="\/banco-questoes\/devolutivas"/);
  assert.equal((menu.match(/feedbackAvailable && <NavLink to="\/banco-questoes\/devolutivas"/g) || []).length, 2);
  assert.match(source('components/OperationalBankAccess.jsx'), /operationalBankState\(user\?\.role, flags, \{ feedback \}\)/);
  assert.match(menu, /Exemplos · não salvam atividades/);
  assert.equal((menu.match(/examples.map\(item/g) || []).length, 2);
  assert.match(home, /to="\/banco-questoes\/devolutivas"/);
  assert.match(home, /to: '\/exemplos\/devolutivas'/);
  assert.match(admin, /'\/exemplos\/devolutivas'/);
  assert.doesNotMatch(admin, /'\/banco-questoes\/devolutivas'/);
  const demo = source('components/DemoWorkspace.jsx');
  assert.match(demo, /Exemplos inventados, sem gravação ou envio/);
  assert.match(demo, /Trabalhar com minhas turmas/);
  assert.match(source('components/OperationalBankAccess.jsx'), /data-bank-access=\{state\} className="[^"]*\bbg-slate-50\b[^"]*\btext-slate-900\b[^"]*\bdark:bg-transparent\b[^"]*\bdark:text-slate-100\b/);
  assert.doesNotMatch(source('index.css'), /html:not\(\.dark\)\s+\.app-shell\s+main\s*>\s*\.animate-fade-in/);
});
