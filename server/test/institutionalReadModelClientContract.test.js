const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function clientSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', relativePath), 'utf8');
}

test('frontend publica uma experiência institucional visível, sinalizada e somente leitura', () => {
  const app = clientSource('App.jsx');
  const flags = clientSource('contexts/FeatureFlagsContext.jsx');
  const header = clientSource('components/Header.jsx');
  const dashboard = clientSource('components/AdministrativeHome.jsx');
  const page = clientSource('pages/InstitutionalContext.jsx');
  const network = clientSource('components/InstitutionalNetwork.jsx');
  const readModelContext = clientSource('contexts/InstitutionalReadModelContext.jsx');
  const main = clientSource('main.jsx');

  assert.match(flags, /'institutions\.read_model'/);
  assert.match(app, /path="instituicoes"/);
  assert.match(app, /flag="institutions\.read_model"/);
  assert.match(header, /to="\/instituicoes"/);
  assert.match(header, /isInstitutionalManager \? 'Minha rede' : 'Minha escola'/);
  assert.match(dashboard, /NetworkSummary/);
  assert.match(dashboard, /flags.isEnabled\('institutions\.read_model'\)/);
  assert.match(dashboard, /Consultar resumo da rede/);
  assert.match(main, /InstitutionalReadModelProvider/);
  assert.match(readModelContext, /api\.get\('\/institutions\/read-model', \{ signal: controller.signal/);
  assert.match(network, /Somente consulta:/);
  assert.match(network, /Minha rede/);
  assert.match(network, /escolas sob sua responsabilidade/);
  assert.match(network, /Vínculos por função/);
  assert.match(network, /Nenhum vínculo é escolhido pelo nome ou pelo e-mail/);
  assert.match(readModelContext, /generation.current/);
  assert.match(readModelContext, /snapshot.identity === identity/);
  assert.match(page, /useInstitutionalReadModel/);
  assert.doesNotMatch(page, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(readModelContext, /api\.(post|put|patch|delete)\s*\(/);
});

test('visão docente prioriza turmas sem expor controles administrativos ou ignorar flags', () => {
  const page = clientSource('pages/InstitutionalContext.jsx');
  const teacher = clientSource('components/ProfessionalInstitutionalContext.jsx');
  const panel = clientSource('components/InstitutionalManagementPanel.jsx');
  assert.match(page, /model.mode === 'professional'/);
  assert.match(page, /<ProfessionalInstitutionalContext model=\{model\}/);
  assert.match(teacher, /Minha escola e minhas turmas/);
  assert.match(teacher, /isEnabled\('classes\.core'\)/);
  assert.match(teacher, /operationalPilot && <InstitutionalManagementPanel compact/);
  assert.match(teacher, /canOpen && <Link to=\{`\/turmas\?turma=\$\{encodeURIComponent\(item.publicId\)\}/);
  assert.match(teacher, /item.status !== 'archived'/);
  assert.match(teacher, /Sobre as escolas e as confirmações/);
  assert.doesNotMatch(teacher, /api\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(teacher, /min-h-40|py-10|Fundação institucional|Escrita isolada|Sem inferência/);
  assert.match(panel, /compact && pending.length === 0\) return failed \? null/);
  assert.match(panel, /expectedContextUpdatedAt: item.contextUpdatedAt/);
  assert.match(panel, /Não confirme ainda/);
});
