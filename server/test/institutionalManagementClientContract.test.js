const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function clientSource(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', relativePath), 'utf8');
}

test('frontend oferece jornada institucional operacional, auditável e confirmada por duas pessoas', () => {
  const flags = clientSource('contexts/FeatureFlagsContext.jsx');
  const page = clientSource('pages/InstitutionalContext.jsx');
  const network = clientSource('components/InstitutionalNetwork.jsx');
  const panel = clientSource('components/InstitutionalManagementPanel.jsx');
  const combobox = clientSource('components/form/AccessibleCombobox.jsx');
  const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  const route = fs.readFileSync(path.join(__dirname, '..', 'src', 'routes', 'institutionalManagement.js'), 'utf8');

  assert.match(flags, /'institutions\.management_pilot'/);
  assert.match(page, /InstitutionalNetwork/);
  assert.match(network, /InstitutionalManagementPanel/);
  assert.match(network, /managementOpened && <InstitutionalManagementPanel/);
  assert.match(network, /Ambiente de testes/);
  assert.match(panel, /Cadastrar município/);
  assert.match(panel, /Adicionar escola/);
  assert.match(panel, /Cadastrar ou vincular profissional/);
  assert.match(panel, /Preparar turma para o professor/);
  assert.match(panel, /Confirmar turma/);
  const hook = clientSource('hooks/useInstitutionalManagement.js');
  assert.match(hook, /Idempotency-Key/);
  assert.match(hook, /management\/operation/);
  assert.match(panel, /InstitutionalWriteReview/);
  assert.match(panel, /temporaryPassword/);
  assert.match(clientSource('components/InstitutionalWriteReview.jsx'), /ambiente de testes/);
  assert.match(panel, /directories\/municipalities/);
  assert.match(panel, /directories\/schools/);
  assert.match(panel, /Buscar no IBGE/);
  assert.match(panel, /Rede municipal · Inep/);
  assert.match(panel, /Incluir manualmente/);
  assert.match(panel, /id="institutional-task"/);
  assert.match(panel, /hidden=\{task !== 'school'\}/);
  assert.match(combobox, /role="combobox"/);
  assert.match(combobox, /role="listbox"/);
  assert.match(combobox, /dark:bg-\[#17263a\]/);
  assert.match(combobox, /max-h-64/);
  assert.doesNotMatch(panel, /api\.delete\s*\(/);
  assert.match(server, /app\.use\('\/api\/institutions\/management', require\('\.\/routes\/institutionalManagement'\)\)/);
  assert.match(route, /config\.appEnvironment !== 'homologation'/);
  assert.match(route, /code: 'homologation_only'/);
});
