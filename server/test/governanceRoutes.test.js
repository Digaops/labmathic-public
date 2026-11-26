const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-governance-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'governance-tests-only-secret';
process.env.GOVERNANCE_ADMIN_ENABLED = 'true';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const config = require('../src/config');
const governanceRouter = require('../src/routes/governance');

const app = express();
app.use(express.json());
app.use('/api/governance', governanceRouter);
app.use('/api/classes', require('../src/routes/classes'));
app.use((_err, _req, res, _next) => {
  res.status(500).json({ error: 'Erro interno no teste.' });
});

let server;
let baseUrl;
let adminToken;
let professorToken;

function insertUser(name, email, role) {
  const result = db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-de-teste', ?)
  `).run(name, email, role);
  return { id: result.lastInsertRowid, name, email, role };
}

function tokenFor(user) {
  return jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '10m' });
}

async function request(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';

  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const payload = await response.json();
  return { status: response.status, payload };
}

test.before(async () => {
  const admin = insertUser('Admin Teste', 'admin-governanca@teste.local', 'admin');
  const professor = insertUser('Professor Teste', 'prof-governanca@teste.local', 'professor');
  adminToken = tokenFor(admin);
  professorToken = tokenFor(professor);

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      const address = server.address();
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) {
    await new Promise((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('bloqueia endpoints administrativos para professores', async () => {
  const response = await request('/api/governance/admin/releases', {
    token: professorToken,
  });

  assert.equal(response.status, 403);
  assert.match(response.payload.error, /administradores/i);
});

test('não permite avaliar flags sem autenticação', async () => {
  const response = await request('/api/governance/features?keys=teste.nova_tela');
  assert.equal(response.status, 401);
});

test('cria release e feature flag desligada por padrão com auditoria', async () => {
  const releaseResponse = await request('/api/governance/admin/releases', {
    method: 'POST',
    token: adminToken,
    body: {
      version: '1.6.0',
      title: 'Fundação de crescimento',
      reason: 'Preparação segura para o próximo ciclo',
    },
  });
  assert.equal(releaseResponse.status, 201);
  assert.equal(releaseResponse.payload.status, 'draft');

  const flagResponse = await request('/api/governance/admin/feature-flags', {
    method: 'POST',
    token: adminToken,
    body: {
      key: 'teste.nova_tela',
      name: 'Nova tela em teste',
      reason: 'Iniciar com a funcionalidade desativada',
    },
  });
  assert.equal(flagResponse.status, 201);
  assert.equal(flagResponse.payload.masterEnabled, false);
  assert.equal(flagResponse.payload.defaultEnabled, false);
  assert.equal(flagResponse.payload.rolloutPercentage, 0);

  const evaluation = await request('/api/governance/features?keys=teste.nova_tela', {
    token: professorToken,
  });
  assert.equal(evaluation.status, 200);
  assert.equal(evaluation.payload.features['teste.nova_tela'], false);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM governance_audit_log').get().count,
    2
  );
});

test('rollout e kill switch respeitam revisão otimista e precedência', async () => {
  const flag = db.prepare("SELECT * FROM feature_flags WHERE flag_key = 'teste.nova_tela'").get();
  const rollout = await request(`/api/governance/admin/feature-flags/${flag.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: {
      expected_revision: flag.revision,
      master_enabled: true,
      rollout_percentage: 100,
      reason: 'Liberar para validação autenticada controlada',
    },
  });
  assert.equal(rollout.status, 200);
  assert.equal(rollout.payload.revision, flag.revision + 1);

  const enabledEvaluation = await request('/api/governance/features?keys=teste.nova_tela', {
    token: professorToken,
  });
  assert.equal(enabledEvaluation.payload.features['teste.nova_tela'], true);

  const staleUpdate = await request(`/api/governance/admin/feature-flags/${flag.id}`, {
    method: 'PATCH',
    token: adminToken,
    body: {
      expected_revision: flag.revision,
      rollout_percentage: 50,
      reason: 'Simular uma atualização administrativa concorrente',
    },
  });
  assert.equal(staleUpdate.status, 409);

  const killSwitch = await request(`/api/governance/admin/feature-flags/${flag.id}/kill-switch`, {
    method: 'POST',
    token: adminToken,
    body: {
      expected_revision: rollout.payload.revision,
      active: true,
      reason: 'Interromper imediatamente durante a validação',
    },
  });
  assert.equal(killSwitch.status, 200);
  assert.equal(killSwitch.payload.killSwitchActive, true);

  const disabledEvaluation = await request('/api/governance/features?keys=teste.nova_tela', {
    token: professorToken,
  });
  assert.equal(disabledEvaluation.payload.features['teste.nova_tela'], false);
});

test('lista regras de piloto somente para administradores', async () => {
  const flag = db.prepare("SELECT * FROM feature_flags WHERE flag_key = 'teste.nova_tela'").get();
  const groupResponse = await request('/api/governance/admin/pilot-groups', {
    method: 'POST',
    token: adminToken,
    body: {
      key: 'professores_validacao',
      name: 'Professores de validação',
      reason: 'Criar grupo controlado para validar a consulta de regras',
    },
  });
  assert.equal(groupResponse.status, 201);

  const ruleResponse = await request(
    `/api/governance/admin/feature-flags/${flag.id}/pilot-groups/${groupResponse.payload.id}`,
    {
      method: 'PUT',
      token: adminToken,
      body: {
        enabled: true,
        reason: 'Liberar o grupo somente durante a validação do endpoint',
      },
    }
  );
  assert.equal(ruleResponse.status, 200);

  const listResponse = await request(`/api/governance/admin/feature-flags/${flag.id}/rules`, {
    token: adminToken,
  });
  assert.equal(listResponse.status, 200);
  assert.equal(listResponse.payload.featureFlag.id, flag.id);
  assert.equal(listResponse.payload.groupRules.length, 1);
  assert.equal(listResponse.payload.groupRules[0].group_key, 'professores_validacao');
  assert.equal(listResponse.payload.groupRules[0].enabled, true);

  const forbiddenResponse = await request(`/api/governance/admin/feature-flags/${flag.id}/rules`, {
    token: professorToken,
  });
  assert.equal(forbiddenResponse.status, 403);
});

test('oculta o plano de controle administrativo quando ele está desativado', async (t) => {
  const previousState = config.governanceAdminEnabled;
  config.governanceAdminEnabled = false;
  t.after(() => {
    config.governanceAdminEnabled = previousState;
  });

  const response = await request('/api/governance/admin/releases', {
    token: adminToken,
  });

  assert.equal(response.status, 404);
  assert.match(response.payload.error, /desativada/i);
});

test('homologação bloqueia a API de turmas após kill switch auditado e só reabre com revisão válida', async t => {
  const previousEnvironment = config.appEnvironment;
  config.appEnvironment = 'homologation';
  t.after(() => { config.appEnvironment = previousEnvironment; });
  const flag = db.prepare("SELECT * FROM feature_flags WHERE flag_key = 'classes.core'").get();
  assert.equal(flag.kill_switch_active, 0);
  assert.equal((await request('/api/classes', { token: professorToken })).status, 200);
  const endpoint = `/api/governance/admin/feature-flags/${flag.id}/kill-switch`;
  const body = { expected_revision: flag.revision, active: true, reason: 'Interrupção sintética para validar a homologação' };
  assert.equal((await request(endpoint, { method: 'POST', token: professorToken, body })).status, 403);
  const stopped = await request(endpoint, { method: 'POST', token: adminToken, body });
  assert.equal(stopped.status, 200);
  assert.equal((await request('/api/classes', { token: professorToken })).status, 404);
  const evaluation = await request('/api/governance/features?keys=classes.core', { token: professorToken });
  assert.equal(evaluation.payload.features['classes.core'], false);
  const audit = db.prepare("SELECT * FROM governance_audit_log WHERE entity_key = 'classes.core' ORDER BY id DESC LIMIT 1").get();
  assert.equal(audit.action, 'activate_kill_switch');
  assert.equal(JSON.parse(audit.current_json).killSwitchActive, true);
  assert.equal((await request(endpoint, { method: 'POST', token: adminToken, body: { ...body, active: false } })).status, 409);
  assert.equal((await request('/api/classes', { token: professorToken })).status, 404);

  db.exec(`CREATE TRIGGER synthetic_kill_audit_failure BEFORE INSERT ON governance_audit_log
    WHEN NEW.entity_key = 'classes.core' BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END;`);
  try {
    assert.equal((await request(endpoint, { method: 'POST', token: adminToken,
      body: { ...body, active: false, expected_revision: stopped.payload.revision } })).status, 500);
    assert.equal((await request('/api/classes', { token: professorToken })).status, 404);
    assert.equal(db.prepare('SELECT revision FROM feature_flags WHERE id = ?').get(flag.id).revision, stopped.payload.revision);
  } finally { db.exec('DROP TRIGGER synthetic_kill_audit_failure'); }
  const restarted = await request(endpoint, { method: 'POST', token: adminToken,
    body: { ...body, active: false, expected_revision: stopped.payload.revision } });
  assert.equal(restarted.status, 200);
  assert.equal((await request('/api/classes', { token: professorToken })).status, 200);
  assert.equal(db.prepare("SELECT COUNT(*) FROM governance_audit_log WHERE entity_key = 'classes.core'").pluck().get(), 2);
});
