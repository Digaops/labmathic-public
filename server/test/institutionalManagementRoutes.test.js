const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-institutional-management-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDirectory, 'database.sqlite');
process.env.JWT_SECRET = 'institutional-management-route-secret-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const config = require('../src/config');
const db = require('../src/database');
const router = require('../src/routes/institutionalManagement');

const app = express();
app.use(express.json());
app.use('/api/institutions/management', router);

let server;
let baseUrl;
let admin;
let teacher;

function addUser(name, email, role) {
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-sintetico', ?)
  `).run(name, email, role).lastInsertRowid);
  return { id, name, email, role };
}

function tokenFor(user, overrides = {}) {
  const authVersion = db.prepare('SELECT auth_version FROM users WHERE id=?').pluck().get(user.id);
  return jwt.sign({ ...user, authVersion, ...overrides }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function fakeIbgePayload() {
  const rows = Array.from({ length: 5_000 }, (_, index) => ({
    id: 1_000_000 + index,
    nome: `Município rota ${index}`,
    microrregiao: { mesorregiao: { UF: { sigla: 'SP' } } },
  }));
  rows[10] = {
    id: 3_550_308,
    nome: 'São Paulo',
    microrregiao: { mesorregiao: { UF: { sigla: 'SP' } } },
  };
  return rows;
}

async function request(pathname, options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  if (options.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey;
  const response = await fetch(`${baseUrl}/api/institutions/management${pathname}`, {
    method: options.method || 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    payload: await response.json(),
  };
}

test.before(async () => {
  admin = addUser('Admin Piloto', 'admin-piloto@teste.local', 'admin');
  teacher = addUser('Professora Piloto', 'professora-piloto@teste.local', 'professor');
  db.prepare(`INSERT INTO grades (name, sort_order) VALUES ('7º Ano Piloto', 7)`).run();
  db.prepare(`INSERT INTO disciplines (name) VALUES ('Matemática')`).run();
  const flagId = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'institutions.management_pilot'
  `).pluck().get();
  db.prepare(`UPDATE feature_flags SET master_enabled = 1 WHERE id = ?`).run(flagId);
  const enable = db.prepare(`
    INSERT INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Piloto institucional em teste isolado', ?, ?)
  `);
  enable.run(flagId, admin.id, admin.id, admin.id);
  enable.run(flagId, teacher.id, admin.id, admin.id);
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => (
    error ? reject(error) : resolve()
  )));
  db.close();
  fs.rmSync(tempDirectory, { recursive: true, force: true });
});

test('falha fechada sem autenticação e expõe estado operacional sem cache', async () => {
  const unauthenticated = await request('/');
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.cacheControl, 'no-store');

  const state = await request('/', { token: tokenFor(admin) });
  assert.equal(state.status, 200, JSON.stringify(state.payload));
  assert.equal(state.payload.mode, 'admin');
  assert.equal(state.payload.environment, 'homologation');
  assert.equal(state.payload.writable, true);
  assert.ok(Array.isArray(state.payload.professionals));
  assert.ok(state.payload.professionals.some((item) => item.id === teacher.id));
});

test('diretório de municípios é administrativo, autenticado e mediado pela API do IBGE', async () => {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = async (input, options) => {
    if (String(input) === 'https://servicodados.ibge.gov.br/api/v1/localidades/municipios') {
      return new Response(JSON.stringify(fakeIbgePayload()), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return nativeFetch(input, options);
  };
  try {
    const response = await request('/directories/municipalities?query=sao%20paulo', {
      token: tokenFor(admin),
    });
    assert.equal(response.status, 200, JSON.stringify(response.payload));
    assert.deepEqual(response.payload.results[0], {
      ibgeCode: '3550308',
      name: 'São Paulo',
      uf: 'SP',
    });
    assert.equal(response.payload.source.name, 'IBGE Localidades');

    const invalid = await request('/directories/municipalities?query=sao&limit=5000', {
      token: tokenFor(admin),
    });
    assert.equal(invalid.status, 400);
    assert.equal(invalid.payload.code, 'invalid_request_shape');

    const denied = await request('/directories/municipalities?query=sao', {
      token: tokenFor(teacher),
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.payload.code, 'admin_required');
  } finally {
    globalThis.fetch = nativeFetch;
  }
});

test('admin configura a rede e a mesma chave idempotente não duplica cadastros', async () => {
  const municipalityKey = 'municipality-route-idempotency-0001';
  const municipality = await request('/municipalities', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: municipalityKey,
    body: { name: 'Município Piloto', ibgeCode: '3550308' },
  });
  assert.equal(municipality.status, 201, JSON.stringify(municipality.payload));
  assert.equal(municipality.payload.replayed, false);
  const municipalityPublicId = municipality.payload.municipality.publicId;

  const replay = await request('/municipalities', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: municipalityKey,
    body: { name: 'Município Piloto', ibgeCode: '3550308' },
  });
  assert.equal(replay.status, 200);
  assert.equal(replay.payload.replayed, true);
  assert.equal(replay.payload.municipality.publicId, municipalityPublicId);
  assert.equal(db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(), 1);

  const school = await request(`/municipalities/${municipalityPublicId}/schools`, {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: 'school-route-idempotency-000001',
    body: { name: 'Escola Municipal Piloto', censusCode: 'ESCOLA-001' },
  });
  assert.equal(school.status, 201, JSON.stringify(school.payload));
  const schoolPublicId = school.payload.school.publicId;

  const municipalityUpdate = await request(`/municipalities/${municipalityPublicId}`, {
    method: 'PATCH',
    token: tokenFor(admin),
    idempotencyKey: 'municipality-update-idempotency-01',
    body: {
      name: 'Município Piloto Atualizado',
      ibgeCode: '3550308',
      expectedRevision: municipality.payload.municipality.revision,
    },
  });
  assert.equal(municipalityUpdate.status, 200, JSON.stringify(municipalityUpdate.payload));
  assert.equal(municipalityUpdate.payload.municipality.revision, 2);

  const staleMunicipalityUpdate = await request(`/municipalities/${municipalityPublicId}`, {
    method: 'PATCH',
    token: tokenFor(admin),
    idempotencyKey: 'municipality-stale-idempotency-01',
    body: {
      name: 'Município Piloto Desatualizado',
      ibgeCode: '3550308',
      expectedRevision: municipality.payload.municipality.revision,
    },
  });
  assert.equal(staleMunicipalityUpdate.status, 409);
  assert.equal(staleMunicipalityUpdate.payload.code, 'stale_revision');

  const schoolUpdate = await request(`/municipalities/${municipalityPublicId}/schools/${schoolPublicId}`, {
    method: 'PATCH',
    token: tokenFor(admin),
    idempotencyKey: 'school-update-idempotency-0001',
    body: {
      name: 'Escola Municipal Piloto Atualizada',
      censusCode: 'ESCOLA-001',
      expectedRevision: school.payload.school.revision,
    },
  });
  assert.equal(schoolUpdate.status, 200, JSON.stringify(schoolUpdate.payload));
  assert.equal(schoolUpdate.payload.school.revision, 2);

  const membership = await request('/memberships', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: 'membership-route-idempotency-01',
    body: {
      userId: teacher.id,
      role: 'teacher',
      municipalityPublicId,
      schoolPublicId,
    },
  });
  assert.equal(membership.status, 201, JSON.stringify(membership.payload));
  assert.equal(membership.payload.membership.professionalEmail, teacher.email);

  const grade = db.prepare('SELECT id FROM grades ORDER BY sort_order, id LIMIT 1').get();
  const discipline = db.prepare(`SELECT id FROM disciplines WHERE name = 'Matemática' LIMIT 1`).get()
    || db.prepare('SELECT id FROM disciplines ORDER BY id LIMIT 1').get();
  assert.ok(grade && discipline);
  const schoolClass = await request('/classes', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: 'class-route-idempotency-0000001',
    body: {
      membershipPublicId: membership.payload.membership.publicId,
      name: '7º A · Piloto',
      gradeId: grade.id,
      academicYear: 2026,
      disciplineIds: [discipline.id],
    },
  });
  assert.equal(schoolClass.status, 201, JSON.stringify(schoolClass.payload));
  assert.equal(schoolClass.payload.schoolClass.migrationStatus, 'linked');
  assert.equal(schoolClass.payload.schoolClass.origin, 'guided_pilot');

  const teacherState = await request('/', { token: tokenFor(teacher, { role: 'admin' }) });
  assert.equal(teacherState.status, 200);
  assert.equal(teacherState.payload.mode, 'professional');
  assert.equal(teacherState.payload.pendingConfirmations.length, 1);

  const confirmation = await request(`/classes/${schoolClass.payload.schoolClass.publicId}/confirm`, {
    method: 'POST',
    token: tokenFor(teacher, { role: 'admin' }),
    idempotencyKey: 'confirmation-route-idempotency-01',
    body: { expectedContextUpdatedAt: schoolClass.payload.schoolClass.contextUpdatedAt },
  });
  assert.equal(confirmation.status, 200, JSON.stringify(confirmation.payload));
  assert.equal(confirmation.payload.schoolClass.migrationStatus, 'verified');
  assert.equal(
    db.prepare(`SELECT migration_status FROM school_class_institution_contexts`).pluck().get(),
    'verified',
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_write_operations').pluck().get(), 7);
  assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 7);
});

test('diretório escolar filtra pelo IBGE do município e sinaliza escola já cadastrada', async () => {
  const municipality = db.prepare(`SELECT id, public_id FROM municipalities LIMIT 1`).get();
  db.prepare(`
    INSERT INTO schools (
      public_id, municipality_id, name, census_code, created_by, updated_by
    ) VALUES ('route-existing-school-catalog', ?, 'Escola já cadastrada no catálogo', '35000008', ?, ?)
  `).run(municipality.id, admin.id, admin.id);
  const importId = Number(db.prepare(`
    INSERT INTO institutional_directory_imports (
      public_id, directory_type, source_name, source_year, source_url,
      source_sha256, row_count
    ) VALUES (
      'route-school-directory-import', 'inep_school_catalog', 'Inep · Censo Escolar',
      2025, 'https://download.inep.gov.br/dados_abertos/', ?, 2
    )
  `).run('c'.repeat(64)).lastInsertRowid);
  const insert = db.prepare(`
    INSERT INTO institutional_school_directory (
      import_id, census_year, census_code, ibge_code, school_name, search_name,
      municipality_name, uf, administrative_dependency, operating_status
    ) VALUES (?, 2025, ?, '3550308', ?, ?, 'Município Piloto Atualizado', 'SP', 'municipal', 'active')
  `);
  insert.run(importId, '35000008', 'Escola já cadastrada no catálogo', 'escola ja cadastrada no catalogo');
  insert.run(importId, '35000009', 'EMEF Catálogo Oficial', 'emef catalogo oficial');

  const result = await request(`/directories/schools?municipalityPublicId=${municipality.public_id}&query=catalogo`, {
    token: tokenFor(admin),
  });
  assert.equal(result.status, 200, JSON.stringify(result.payload));
  assert.equal(result.payload.available, true);
  assert.equal(result.payload.source.censusYear, 2025);
  assert.equal(result.payload.results.some((item) => item.alreadyRegistered), true);
  assert.equal(result.payload.results.some((item) => item.censusCode === '35000009'), true);
});

test('papel atual do banco prevalece e professor não configura a rede', async () => {
  const denied = await request('/municipalities', {
    method: 'POST',
    token: tokenFor(teacher, { role: 'admin' }),
    idempotencyKey: 'teacher-cannot-create-municipality',
    body: { name: 'Município Indevido', ibgeCode: '3304557' },
  });
  assert.equal(denied.status, 403);
  assert.equal(denied.payload.code, 'admin_required');
  assert.equal(db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(), 1);
});

test('cria conta piloto e vínculo na mesma transação sem registrar senha', async () => {
  const municipality = db.prepare(`SELECT public_id FROM municipalities LIMIT 1`).get();
  const school = db.prepare(`SELECT public_id FROM schools LIMIT 1`).get();
  const response = await request('/professionals', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: 'professional-route-idempotency-01',
    body: {
      name: 'Professor Novo Piloto',
      email: 'novo-professor@homologacao.invalid',
      temporaryPassword: 'SenhaTemporaria123!',
      role: 'teacher',
      municipalityPublicId: municipality.public_id,
      schoolPublicId: school.public_id,
    },
  });
  assert.equal(response.status, 201, JSON.stringify(response.payload));
  assert.equal(response.payload.professional.email, 'novo-professor@homologacao.invalid');
  const audit = db.prepare(`
    SELECT previous_json, current_json FROM institutional_audit_log
    WHERE entity_key = ?
  `).get(response.payload.membership.publicId);
  assert.doesNotMatch(JSON.stringify(audit), /SenhaTemporaria|password|senha/i);
});

test('contrato rejeita campos desconhecidos antes de escrever', async () => {
  const before = db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get();
  const response = await request('/municipalities', {
    method: 'POST',
    token: tokenFor(admin),
    idempotencyKey: 'unknown-field-route-idempotency',
    body: { name: 'Município Inválido', ibgeCode: '3304557', masterEnabled: true },
  });
  assert.equal(response.status, 400);
  assert.equal(response.payload.code, 'invalid_request_shape');
  assert.equal(db.prepare('SELECT COUNT(*) FROM municipalities').pluck().get(), before);
});

test('piloto permanece fechado quando a aplicação não está na homologação', async () => {
  const originalEnvironment = config.appEnvironment;
  const originalNodeEnv = process.env.NODE_ENV;
  try {
    config.appEnvironment = 'production';
    process.env.NODE_ENV = 'production';
    const response = await request('/', { token: tokenFor(admin) });
    assert.equal(response.status, 404);
    assert.equal(response.payload.code, 'homologation_only');
  } finally {
    config.appEnvironment = originalEnvironment;
    process.env.NODE_ENV = originalNodeEnv;
  }
});

test('clareza da tela docente e regressão dos perfis com API real (QA opt-in)', { skip: process.env.INSTITUTIONAL_BROWSER_QA !== '1', timeout: 180000 }, async () => {
  const report = await require('../scripts/ci/institutionalContextBrowser.cjs').runInstitutionalContextBrowser({ app, db, baseUrl, admin, teacher, tokenFor });
  assert.equal(report.status, 'passed');
  console.log(JSON.stringify(report));
});
test('recibo institucional é somente leitura, por autor, sem segredos e protegido por flag/ambiente', async () => {
  const key = 'receipt-route-qa40-municipality';
  const created = await request('/municipalities', { token: tokenFor(admin), method: 'POST', idempotencyKey: key, body: { name: 'Município do recibo QA40' } });
  assert.equal(created.status, 201);
  const counts = () => db.prepare('SELECT (SELECT count(*) FROM municipalities) AS municipalities, (SELECT count(*) FROM institutional_write_operations) AS operations').get();
  const before = counts();
  assert.equal((await request('/operation', { idempotencyKey: key })).status, 401);
  assert.equal((await request('/operation', { token: tokenFor(admin) })).status, 400);
  assert.equal((await request('/operation?key=not-in-url', { token: tokenFor(admin), idempotencyKey: key })).status, 400);
  const receipt = await request('/operation', { token: tokenFor(admin), idempotencyKey: key });
  assert.equal(receipt.status, 200); assert.equal(receipt.cacheControl, 'no-store');
  assert.equal(receipt.payload.operationType, 'create_municipality');
  assert.deepEqual(receipt.payload.result, { ...created.payload, replayed: true });
  assert.doesNotMatch(JSON.stringify(receipt.payload), /password|fingerprint|key_hash|receipt-route-qa40/);
  assert.deepEqual((await request('/operation', { token: tokenFor(teacher), idempotencyKey: key })).payload, { found: false });
  try {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher.id);
    assert.deepEqual((await request('/operation', { token: tokenFor(teacher, { role: 'admin' }), idempotencyKey: key })).payload, { found: false }, 'Outro administrador não recebe o recibo');
    db.prepare("UPDATE users SET role='professor' WHERE id=?").run(admin.id);
    assert.deepEqual((await request('/operation', { token: tokenFor(admin, { role: 'professor' }), idempotencyKey: key })).payload, { found: false }, 'Ex-administrador não recebe recibo administrativo');
  } finally {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(admin.id);
    db.prepare("UPDATE users SET role='professor' WHERE id=?").run(teacher.id);
  }
  assert.deepEqual((await request('/operation', { token: tokenFor(admin), idempotencyKey: key + '-absent' })).payload, { found: false });
  const flag = db.prepare("SELECT id,master_enabled FROM feature_flags WHERE flag_key='institutions.management_pilot'").get();
  try { db.prepare('UPDATE feature_flags SET master_enabled=0 WHERE id=?').run(flag.id); assert.equal((await request('/operation', { token: tokenFor(admin), idempotencyKey: key })).status, 404); }
  finally { db.prepare('UPDATE feature_flags SET master_enabled=? WHERE id=?').run(flag.master_enabled, flag.id); }
  const environment = config.appEnvironment, nodeEnvironment = process.env.NODE_ENV;
  try { config.appEnvironment = 'production'; process.env.NODE_ENV = 'production'; assert.equal((await request('/operation', { token: tokenFor(admin), idempotencyKey: key })).status, 404); }
  finally { config.appEnvironment = environment; process.env.NODE_ENV = nodeEnvironment; }
  assert.deepEqual(counts(), before);
});
