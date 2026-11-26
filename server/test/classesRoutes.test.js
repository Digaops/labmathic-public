const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { strToU8, zipSync } = require('fflate');

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-classes-api-'));
process.env.DB_PATH = path.join(tempDir, 'database.sqlite');
process.env.JWT_SECRET = 'classes-tests-only-secret-with-safe-length';
process.env.CLASS_ENTRY_CODE_SECRET = 'classes-entry-code-tests-only-secret-with-safe-length';

const express = require('express');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const classesRouter = require('../src/routes/classes');

const app = express();
app.use(express.json());
app.use('/api/classes', classesRouter);
app.use((_error, _req, res, _next) => res.status(500).json({
  error: 'Erro interno no teste.',
  detail: _error.message,
}));

let server;
let baseUrl;
let professor;
let otherProfessor;
let admin;
let professorToken;
let otherProfessorToken;
let adminToken;
let gradeId;
let disciplineId;
let classId;
let studentId;

function xlsxBuffer(rows, { formula = false } = {}) {
  const values = rows.flat();
  const cell = (value, reference) => formula && reference === 'A2'
    ? `<c r="${reference}"><f>HYPERLINK(&quot;https://invalid.local&quot;)</f><v>0</v></c>`
    : `<c r="${reference}" t="s"><v>${values.indexOf(value)}</v></c>`;
  const sheetRows = rows.map((row, rowIndex) => (
    `<row r="${rowIndex + 1}">${row.map((value, columnIndex) => (
      cell(value, `${String.fromCharCode(65 + columnIndex)}${rowIndex + 1}`)
    )).join('')}</row>`
  )).join('');
  return Buffer.from(zipSync({
    '[Content_Types].xml': strToU8('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/></Types>'),
    '_rels/.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>'),
    'xl/workbook.xml': strToU8('<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Estudantes" sheetId="1" r:id="rId1"/></sheets></workbook>'),
    'xl/_rels/workbook.xml.rels': strToU8('<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/></Relationships>'),
    'xl/sharedStrings.xml': strToU8(`<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${values.length}" uniqueCount="${values.length}">${values.map((value) => `<si><t>${value}</t></si>`).join('')}</sst>`),
    'xl/worksheets/sheet1.xml': strToU8(`<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${sheetRows}</sheetData></worksheet>`),
  }));
}

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

function enableFlagForUser(flagKey, user) {
  const flag = db.prepare('SELECT id FROM feature_flags WHERE flag_key = ?').get(flagKey);
  db.prepare('UPDATE feature_flags SET master_enabled = 1 WHERE id = ?').run(flag.id);
  db.prepare(`
    INSERT OR REPLACE INTO feature_flag_user_rules (
      feature_flag_id, user_id, enabled, reason, created_by, updated_by
    ) VALUES (?, ?, 1, 'Liberacao controlada para teste automatizado', ?, ?)
  `).run(flag.id, user.id, admin.id, admin.id);
}

async function request(urlPath, options = {}) {
  const headers = { ...(options.headers || {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method: options.method || 'GET',
    headers,
    body,
  });
  return { status: response.status, headers: response.headers, payload: await response.json() };
}

test.before(async () => {
  admin = insertUser('Admin Teste', 'admin-turmas@teste.local', 'admin');
  professor = insertUser('Professora Ana', 'ana-turmas@teste.local', 'professor');
  otherProfessor = insertUser('Professor Bruno', 'bruno-turmas@teste.local', 'professor');
  professorToken = tokenFor(professor);
  otherProfessorToken = tokenFor(otherProfessor);
  adminToken = tokenFor(admin);
  gradeId = db.prepare("INSERT INTO grades (name, sort_order) VALUES ('7º Ano - EF', 7)").run().lastInsertRowid;
  disciplineId = db.prepare("INSERT INTO disciplines (name) VALUES ('Matemática')").run().lastInsertRowid;

  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

test.after(async () => {
  if (server) await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  db.close();
  fs.rmSync(tempDir, { recursive: true, force: true });
});

test('falha fechada quando classes.core está desligada e recusa administradores', async () => {
  const disabled = await request('/api/classes/bootstrap', { token: professorToken });
  assert.equal(disabled.status, 404);
  assert.match(disabled.payload.error, /indisponível/i);

  const adminResponse = await request('/api/classes/bootstrap', { token: adminToken });
  assert.equal(adminResponse.status, 403);
});

test('cria turma somente para o professor proprietário e exige revisão otimista', async () => {
  enableFlagForUser('classes.core', professor);
  enableFlagForUser('classes.core', otherProfessor);

  const created = await request('/api/classes', {
    method: 'POST',
    token: professorToken,
    body: {
      name: '7º A — Matemática',
      gradeId,
      academicYear: 2026,
      disciplineIds: [disciplineId],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.name, '7º A — Matemática');
  classId = created.payload.id;

  const isolated = await request(`/api/classes/${classId}`, { token: otherProfessorToken });
  assert.equal(isolated.status, 404);

  const updated = await request(`/api/classes/${classId}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      name: '7º A — Matemática 2026',
      gradeId,
      academicYear: 2026,
      disciplineIds: [disciplineId],
      expectedRevision: created.payload.revision,
    },
  });
  assert.equal(updated.status, 200);
  assert.equal(updated.payload.revision, created.payload.revision + 1);

  const stale = await request(`/api/classes/${classId}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      name: 'Edição antiga',
      gradeId,
      academicYear: 2026,
      disciplineIds: [disciplineId],
      expectedRevision: created.payload.revision,
    },
  });
  assert.equal(stale.status, 409);
});

test('cadastro manual mantém estudante restrito ao professor e à turma', async () => {
  const created = await request(`/api/classes/${classId}/students`, {
    method: 'POST',
    token: professorToken,
    body: { displayName: 'Estudante Teste', externalReference: 'MAT-001' },
  });
  assert.equal(created.status, 201, JSON.stringify(created.payload));
  assert.equal(created.payload.externalReference, 'MAT-001');
  studentId = created.payload.id;

  const withdrawn = await request(`/api/classes/${classId}/enrollments/${studentId}`, {
    method: 'PATCH',
    token: professorToken,
    body: { status: 'withdrawn', expectedRevision: created.payload.enrollmentRevision },
  });
  assert.equal(withdrawn.status, 200);
  assert.equal(withdrawn.payload.enrollmentStatus, 'withdrawn');

  const staleEnrollment = await request(`/api/classes/${classId}/enrollments/${studentId}`, {
    method: 'PATCH',
    token: professorToken,
    body: { status: 'active', expectedRevision: created.payload.enrollmentRevision },
  });
  assert.equal(staleEnrollment.status, 409);

  const reactivated = await request(`/api/classes/${classId}/enrollments/${studentId}`, {
    method: 'PATCH',
    token: professorToken,
    body: { status: 'active', expectedRevision: withdrawn.payload.enrollmentRevision },
  });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.payload.enrollmentStatus, 'active');

  const otherRoster = await request('/api/classes/students/roster', { token: otherProfessorToken });
  assert.equal(otherRoster.status, 200);
  assert.equal(otherRoster.payload.length, 0);

  const detail = await request(`/api/classes/${classId}`, { token: professorToken });
  assert.equal(detail.payload.students.length, 1);
  assert.equal(detail.payload.students[0].id, studentId);
});

test('resumo da página inicial é privado e reflete turmas e estudantes ativos', async () => {
  const overview = await request('/api/classes/home-overview', { token: professorToken });
  assert.equal(overview.status, 200, JSON.stringify(overview.payload));
  assert.equal(overview.payload.metrics.activeClasses, 1);
  assert.equal(overview.payload.metrics.activeStudents, 1);
  assert.deepEqual(overview.payload.metrics.assessments, {
    draft: 0,
    scheduled: 0,
    open: 0,
    closed: 0,
  });
  assert.deepEqual(overview.payload.metrics.recoveryPlans, {
    total: 0,
    draft: 0,
    active: 0,
    completed: 0,
    archived: 0,
  });
  assert.deepEqual(overview.payload.recentAssessments, []);
  assert.deepEqual(overview.payload.recentRecoveryPlans, []);

  const isolated = await request('/api/classes/home-overview', { token: otherProfessorToken });
  assert.equal(isolated.status, 200);
  assert.equal(isolated.payload.metrics.activeClasses, 0);
  assert.equal(isolated.payload.metrics.activeStudents, 0);
});

test('pré-visualiza CSV sem gravar e só importa depois da confirmação', async () => {
  enableFlagForUser('classes.student_import', professor);
  const before = db.prepare('SELECT COUNT(*) AS count FROM students WHERE owner_teacher_id = ?').get(professor.id).count;
  const form = new FormData();
  form.append('file', new Blob(['Nome;Matrícula\nMaria Souza;MAT-002\nJoão Lima;MAT-003\n'], { type: 'text/csv' }), 'estudantes.csv');
  const preview = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST',
    token: professorToken,
    form,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.canImport, true);
  assert.equal(preview.payload.summary.create, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM students WHERE owner_teacher_id = ?').get(professor.id).count, before);

  const imported = await request(`/api/classes/${classId}/import`, {
    method: 'POST',
    token: professorToken,
    body: { rows: preview.payload.rows },
  });
  assert.equal(imported.status, 201);
  assert.equal(imported.payload.created, 2);
  assert.equal(imported.payload.enrolled, 2);
});

test('importação de planilha não revela nem altera turma de outro professor', async () => {
  enableFlagForUser('classes.student_import', otherProfessor);
  const form = new FormData();
  form.append('file', new Blob([
    'Nome;Matrícula\nEstudante indevido;MAT-ISOLAMENTO\n',
  ], { type: 'text/csv' }), 'isolamento.csv');

  const preview = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST',
    token: otherProfessorToken,
    form,
  });
  assert.equal(preview.status, 404);

  const imported = await request(`/api/classes/${classId}/import`, {
    method: 'POST',
    token: otherProfessorToken,
    body: {
      rows: [{ displayName: 'Estudante indevido', externalReference: 'MAT-ISOLAMENTO' }],
    },
  });
  assert.equal(imported.status, 404);
  assert.equal(
    db.prepare("SELECT COUNT(*) FROM students WHERE external_reference = 'MAT-ISOLAMENTO'")
      .pluck().get(),
    0
  );
});

test('lê XLSX real e recusa fórmulas antes de processar as células', async () => {
  const validForm = new FormData();
  validForm.append('file', new Blob([xlsxBuffer([
    ['Nome', 'Matrícula'],
    ['Carla XLSX', 'MAT-XLSX-1'],
  ])]), 'estudantes.xlsx');
  const valid = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST', token: professorToken, form: validForm,
  });
  assert.equal(valid.status, 200, JSON.stringify(valid.payload));
  assert.equal(valid.payload.rows[0].displayName, 'Carla XLSX');
  assert.equal(valid.headers.get('cache-control'), 'private, no-store');

  const formulaForm = new FormData();
  formulaForm.append('file', new Blob([xlsxBuffer([
    ['Nome', 'Matrícula'],
    ['Fórmula', 'MAT-FORMULA'],
  ], { formula: true })]), 'formula.xlsx');
  const formula = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST', token: professorToken, form: formulaForm,
  });
  assert.equal(formula.status, 400);
  assert.match(formula.payload.error, /fórmula|planilha/i);
});

test('planilha recusa campos multipart extras e expansão fora dos limites', async () => {
  const form = new FormData();
  form.append('extra', 'não esperado');
  form.append('file', new Blob(['Nome\nEstudante sintético']), 'estudantes.csv');
  assert.equal((await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST', token: professorToken, form,
  })).status, 400);

  const { validateXlsxArchive } = require('../src/services/studentImport');
  const file = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData/></worksheet>') }));
  const centralDirectoryOffset = file.readUInt32LE(file.length - 6);
  file.writeUInt32LE(1, centralDirectoryOffset + 24);
  await assert.rejects(validateXlsxArchive(file), /xlsx_unsafe_archive/);

  const sparse = Buffer.from(zipSync({ 'xl/worksheets/sheet1.xml': strToU8('<worksheet><sheetData><row r="2049"/></sheetData></worksheet>') }));
  await assert.rejects(validateXlsxArchive(sparse), /xlsx_unsafe_grid/);
});

test('rejeita fórmulas, linhas duplicadas e arquivos acima do limite', async () => {
  const form = new FormData();
  form.append('file', new Blob(['Nome;Matrícula\n=HYPERLINK("x");MAT-X\nAna;MAT-X\n'], { type: 'text/csv' }), 'invalido.csv');
  const preview = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST', token: professorToken, form,
  });
  assert.equal(preview.status, 200);
  assert.equal(preview.payload.canImport, false);
  assert.ok(preview.payload.rows.some((row) => row.action === 'invalid'));

  const largeForm = new FormData();
  largeForm.append('file', new Blob([Buffer.alloc(1024 * 1024 + 1, 65)]), 'grande.csv');
  const tooLarge = await request(`/api/classes/${classId}/import/preview`, {
    method: 'POST', token: professorToken, form: largeForm,
  });
  assert.equal(tooLarge.status, 413);
});

test('código aparece uma vez, fica somente em digest e entrada repetida é idempotente', async () => {
  enableFlagForUser('classes.entry_codes', professor);
  const generated = await request(`/api/classes/${classId}/codes`, {
    method: 'POST',
    token: professorToken,
    body: { maxUses: 3, validDays: 1 },
  });
  assert.equal(generated.status, 201);
  assert.match(generated.payload.code, /^[A-Z2-9]{4}(?:-[A-Z2-9]{4}){3}$/);

  const stored = db.prepare('SELECT code_digest, use_count FROM school_class_entry_codes WHERE public_id = ?')
    .get(generated.payload.id);
  assert.equal(stored.code_digest.length, 64);
  assert.equal(JSON.stringify(stored).includes(generated.payload.code.replaceAll('-', '')), false);

  const joined = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Aluno pelo código',
      requestId: 'join-request-0000000000000001',
    },
  });
  assert.equal(joined.status, 201);
  assert.equal(joined.payload.className, '7º A — Matemática 2026');

  const repeated = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Aluno pelo código',
      requestId: 'join-request-0000000000000001',
    },
  });
  assert.equal(repeated.status, 200);
  assert.equal(repeated.payload.alreadyJoined, true);
  assert.equal(db.prepare('SELECT use_count FROM school_class_entry_codes WHERE public_id = ?').get(generated.payload.id).use_count, 1);

  const sameNameDifferentPerson = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Aluno pelo código',
      requestId: 'join-request-0000000000000002',
    },
  });
  assert.equal(sameNameDifferentPerson.status, 201);
  assert.equal(db.prepare('SELECT use_count FROM school_class_entry_codes WHERE public_id = ?').get(generated.payload.id).use_count, 2);

  const finalUse = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Terceira pessoa',
      requestId: 'join-request-0000000000000003',
    },
  });
  assert.equal(finalUse.status, 201);
  assert.equal(db.prepare('SELECT use_count FROM school_class_entry_codes WHERE public_id = ?').get(generated.payload.id).use_count, 3);

  const repeatedAfterLimit = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Aluno pelo código',
      requestId: 'join-request-0000000000000001',
    },
  });
  assert.equal(repeatedAfterLimit.status, 200);
  assert.equal(repeatedAfterLimit.payload.alreadyJoined, true);

  const currentRevision = db.prepare(`
    SELECT revision FROM school_class_entry_codes WHERE public_id = ?
  `).pluck().get(generated.payload.id);
  const revoked = await request(`/api/classes/${classId}/codes/${generated.payload.id}/revoke`, {
    method: 'POST',
    token: professorToken,
    body: { expectedRevision: currentRevision },
  });
  assert.equal(revoked.status, 200);

  const refused = await request('/api/classes/join', {
    method: 'POST',
    body: {
      code: generated.payload.code,
      displayName: 'Outra pessoa',
      requestId: 'join-request-0000000000000004',
    },
  });
  assert.equal(refused.status, 400);
  assert.doesNotMatch(refused.payload.error, /revog|expir|limite/i);
});

test('arquivar turma revoga códigos remanescentes sem apagar estudantes', async () => {
  const detail = await request(`/api/classes/${classId}`, { token: professorToken });
  const archived = await request(`/api/classes/${classId}/status`, {
    method: 'PATCH',
    token: professorToken,
    body: { status: 'archived', expectedRevision: detail.payload.revision },
  });
  assert.equal(archived.status, 200);
  assert.equal(archived.payload.status, 'archived');
  assert.ok(db.prepare('SELECT COUNT(*) AS count FROM students WHERE owner_teacher_id = ?').get(professor.id).count >= 4);
  assert.equal(
    db.prepare('SELECT COUNT(*) AS count FROM school_class_entry_codes WHERE class_id = (SELECT id FROM school_classes WHERE public_id = ?) AND revoked_at IS NULL').get(classId).count,
    0
  );

  const student = detail.payload.students.find((item) => item.id === studentId);
  const enrollmentChange = await request(`/api/classes/${classId}/enrollments/${studentId}`, {
    method: 'PATCH',
    token: professorToken,
    body: { status: 'withdrawn', expectedRevision: student.enrollmentRevision },
  });
  assert.equal(enrollmentChange.status, 409);

  const classEdit = await request(`/api/classes/${classId}`, {
    method: 'PUT',
    token: professorToken,
    body: {
      name: archived.payload.name,
      gradeId: archived.payload.grade.id,
      academicYear: archived.payload.academicYear,
      disciplineIds: archived.payload.disciplines.map(({ id }) => id),
      expectedRevision: archived.payload.revision,
    },
  });
  assert.equal(classEdit.status, 409);

  const roster = await request('/api/classes/students/roster', { token: professorToken });
  assert.equal(roster.status, 200);
  assert.equal(roster.payload.find((item) => item.id === studentId).classCount, 0);
});
