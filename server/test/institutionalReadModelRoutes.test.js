const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const tempDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-institutional-read-'));
process.env.NODE_ENV = 'test';
process.env.DB_PATH = path.join(tempDirectory, 'database.sqlite');
process.env.JWT_SECRET = 'institutional-read-model-route-secret-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const institutionalReadModelRouter = require('../src/routes/institutionalReadModel');

const app = express();
app.use(express.json());
app.use('/api/institutions/read-model', institutionalReadModelRouter);

let server;
let baseUrl;
let admin;
let teacher;
let outsider;
let manager;

function addUser(name, email, role) {
  const id = Number(db.prepare(`
    INSERT INTO users (name, email, password, role)
    VALUES (?, ?, 'hash-sintetico', ?)
  `).run(name, email, role).lastInsertRowid);
  return { id, name, email, role };
}

function tokenFor(user, overrides = {}) {
  return jwt.sign({ ...user, ...overrides }, process.env.JWT_SECRET, { expiresIn: '10m' });
}

function enableFor(...users) {
  const flag = db.prepare(`
    SELECT id FROM feature_flags WHERE flag_key = 'institutions.read_model'
  `).get();
  db.prepare(`
    UPDATE feature_flags
    SET master_enabled = 1, kill_switch_active = 0,
        kill_switch_reason = NULL, kill_switch_activated_at = NULL
    WHERE id = ?
  `).run(flag.id);
  const addRule = db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Leitura institucional isolada para teste HTTP', ?, ?)
  `);
  for (const user of users) addRule.run(flag.id, user.id, admin.id, admin.id);
}

async function request(options = {}) {
  const headers = { Accept: 'application/json' };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const response = await fetch(`${baseUrl}/api/institutions/read-model`, { headers });
  return {
    status: response.status,
    cacheControl: response.headers.get('cache-control'),
    vary: response.headers.get('vary'),
    payload: await response.json(),
  };
}

test.before(async () => {
  admin = addUser('Admin Institucional', 'admin-institucional@teste.local', 'admin');
  teacher = addUser('Professora Institucional', 'professora-institucional@teste.local', 'professor');
  outsider = addUser('Professor Fora do Escopo', 'professor-externo@teste.local', 'professor');
  manager = addUser('Gestora Municipal', 'gestora-municipal@teste.local', 'professor');
  const gradeId = Number(db.prepare(`
    INSERT INTO grades (name, sort_order) VALUES ('7º Ano - Institucional', 7)
  `).run().lastInsertRowid);
  const municipalityId = Number(db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-route-read-001', 'Município Sintético', '3550308', ?)
  `).run(admin.id).lastInsertRowid);
  const schoolId = Number(db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-route-read-public-01', ?, 'Escola Sintética', ?)
  `).run(municipalityId, admin.id).lastInsertRowid);
  const otherMunicipalityId = Number(db.prepare(`
    INSERT INTO municipalities (public_id, name, ibge_code, created_by)
    VALUES ('municipality-route-other-01', 'Município Fora do Escopo', '3304557', ?)
  `).run(admin.id).lastInsertRowid);
  db.prepare(`
    INSERT INTO schools (public_id, municipality_id, name, created_by)
    VALUES ('school-route-other-public', ?, 'Escola Fora do Escopo', ?)
  `).run(otherMunicipalityId, admin.id);
  db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES ('membership-manager-route-01', ?, 'municipal_manager', ?, NULL, ?)
  `).run(manager.id, municipalityId, admin.id);
  db.prepare(`
    INSERT INTO institutional_memberships (
      public_id, user_id, role, municipality_id, school_id, created_by
    ) VALUES ('membership-route-read-001', ?, 'teacher', ?, ?, ?)
  `).run(teacher.id, municipalityId, schoolId, admin.id);
  const verifiedClassId = Number(db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-route-verified-001', ?, 'Turma Própria Verificada', ?, 2026, ?)
  `).run(teacher.id, gradeId, teacher.id).lastInsertRowid);
  db.prepare(`
    UPDATE school_class_institution_contexts
    SET municipality_id = ?, school_id = ?, migration_status = 'linked',
        linked_by = ?, linked_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ?
  `).run(municipalityId, schoolId, admin.id, verifiedClassId);
  db.prepare(`
    UPDATE school_class_institution_contexts
    SET migration_status = 'verified', verified_by = ?,
        verified_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
    WHERE class_id = ?
  `).run(outsider.id, verifiedClassId);
  db.prepare(`
    INSERT INTO school_classes (
      public_id, owner_teacher_id, name, grade_id, academic_year, created_by
    ) VALUES ('class-route-private-0001', ?, 'Turma Privada de Outro Professor', ?, 2026, ?)
  `).run(outsider.id, gradeId, outsider.id);

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

test('exige autenticação, não armazena cache e falha fechada com a flag desligada', async () => {
  const unauthenticated = await request();
  assert.equal(unauthenticated.status, 401);
  assert.equal(unauthenticated.cacheControl, 'no-store');
  assert.match(unauthenticated.vary, /Authorization/i);

  const disabled = await request({ token: tokenFor(admin) });
  assert.equal(disabled.status, 404);
  assert.equal(disabled.payload.code, 'feature_disabled');
  assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), 0);

  enableFor(admin, teacher, outsider, manager);
});

test('admin recebe apenas agregados verificados e nenhuma identidade profissional', async () => {
  const beforeAudit = db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get();
  const response = await request({ token: tokenFor(admin) });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.mode, 'admin');
  assert.equal(response.payload.readOnly, true);
  assert.equal(response.payload.summary.activeMunicipalities, 2);
  assert.equal(response.payload.summary.activeSchools, 2);
  assert.equal(response.payload.summary.verifiedClasses, 1);
  assert.equal(response.payload.summary.pendingClasses, 1);
  assert.equal(response.payload.summary.roleCoverage.municipalManagers, 1);
  assert.equal(response.payload.summary.roleCoverage.teachers, 1);
  const verifiedSchool = response.payload.municipalities
    .flatMap((municipality) => municipality.schools)
    .find((school) => school.publicId === 'school-route-read-public-01');
  assert.equal(verifiedSchool.verifiedClassCount, 1);
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /Professora Institucional|Professor Fora do Escopo|Turma Privada/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), beforeAudit);

});

test('professor recebe só o próprio contexto e o papel atual prevalece sobre token adulterado', async () => {
  const staleAdminToken = tokenFor(teacher, { role: 'admin' });
  const response = await request({ token: staleAdminToken });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.mode, 'professional');
  assert.equal(response.payload.status, 'verified_context');
  assert.deepEqual(response.payload.classes.map((item) => item.name), ['Turma Própria Verificada']);
  assert.doesNotMatch(JSON.stringify(response.payload), /Turma Privada de Outro Professor/);

  const outsiderResponse = await request({ token: tokenFor(outsider) });
  assert.equal(outsiderResponse.status, 200);
  assert.equal(outsiderResponse.payload.mode, 'professional');
  assert.equal(outsiderResponse.payload.status, 'pending_institutional_link');
  assert.deepEqual(
    outsiderResponse.payload.classes.map((item) => item.name),
    ['Turma Privada de Outro Professor'],
  );
  assert.doesNotMatch(JSON.stringify(outsiderResponse.payload), /Turma Própria Verificada/);
});

test('gestão recebe apenas agregados verificados do vínculo institucional ativo', async () => {
  const beforeAudit = db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get();
  const response = await request({ token: tokenFor(manager, { role: 'admin' }) });
  assert.equal(response.status, 200, JSON.stringify(response.payload));
  assert.equal(response.payload.mode, 'manager');
  assert.equal(response.payload.scopeLevel, 'municipality');
  assert.equal(response.payload.readOnly, true);
  assert.equal(response.payload.summary.activeMunicipalities, 1);
  assert.equal(response.payload.summary.activeSchools, 1);
  assert.equal(response.payload.summary.verifiedClasses, 1);
  assert.doesNotMatch(
    JSON.stringify(response.payload),
    /Município Fora do Escopo|Escola Fora do Escopo|Professora Institucional|Turma Própria/,
  );
  assert.equal(db.prepare('SELECT COUNT(*) FROM institutional_audit_log').pluck().get(), beforeAudit);

  db.prepare(`
    UPDATE institutional_memberships
    SET status = 'inactive', ended_at = CURRENT_TIMESTAMP,
        revision = revision + 1, updated_at = CURRENT_TIMESTAMP
    WHERE user_id = ? AND role = 'municipal_manager'
  `).run(manager.id);
  const inactiveResponse = await request({ token: tokenFor(manager, { role: 'admin' }) });
  assert.equal(inactiveResponse.status, 200);
  assert.equal(inactiveResponse.payload.mode, 'professional');
  assert.equal(inactiveResponse.payload.status, 'no_context');
});

test('a aplicação principal registra a rota institucional em caminho próprio', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'src', 'index.js'), 'utf8');
  assert.match(
    source,
    /app\.use\('\/api\/institutions\/read-model', require\('\.\/routes\/institutionalReadModel'\)\)/,
  );
});
