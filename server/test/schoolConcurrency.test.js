const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-school-load-'));
process.env.NODE_ENV = 'test';
process.env.APP_ENV = 'development';
process.env.DB_PATH = path.join(temp, 'school.sqlite');
process.env.JWT_SECRET = 'school-concurrency-synthetic-secret-not-real';
process.env.STUDENT_ASSESSMENT_ACCESS_SECRET = 'school-concurrency-synthetic-access-secret';
process.env.SMTP_USER = '';
process.env.SMTP_PASS = '';
const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('../src/database');
const { issueUserToken, digestToken } = require('../src/services/authSessions');
const { resolveIdentity, createSchoolRateLimits, SCHOOL_LIMITS } = require('../src/middleware/schoolRateLimits');
const { ipKeyGenerator } = require('express-rate-limit');
const app = express();
const limits = createSchoolRateLimits({ production: true });
app.use('/api', limits.ingressLimiter);
app.use('/api/auth/login', limits.loginOriginLimiter);
app.use('/api/student-assessments/session', limits.studentAssessmentEntryLimiter);
app.use(express.json());
app.use('/api', limits.identifyRateLimitPrincipal, limits.apiLimiter);
app.use('/api/auth/login', limits.authLimiter);
app.use('/api/student-assessments/session', limits.studentAssessmentCodeLimiter);
app.use('/api/classes', require('../src/routes/classAssessmentStudentAccess'));
app.use('/api/student-assessments', require('../src/routes/studentAssessmentPortal'));
app.use('/api/auth', require('../src/routes/auth'));
app.use('/api/notifications', require('../src/routes/notifications'));
app.use('/api/governance', require('../src/routes/governance'));
app.use(require('../src/middleware/apiErrors'));
let server; let base;
const teachers = [];
const classPublicId = 'synthetic-class-shared-school';
const assignmentPublicId = 'synthetic-assessment-shared-school';
const accessPath = `/api/classes/${classPublicId}/assessments/${assignmentPublicId}/student-access`;
let studentTokens = [];
let codes = [];
const password = 'Synthetic-school-password!';
async function request(url, { token, method = 'GET', body, headers = {} } = {}) {
  const response = await fetch(base + url, { method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined });
  const text = await response.text();
  return { status: response.status, headers: response.headers, data: text ? JSON.parse(text) : null };
}
function insert(sql, ...values) { return Number(db.prepare(sql).run(...values).lastInsertRowid); }

test.before(async () => {
  for (let i = 0; i < 10; i += 1) {
    const email = `synthetic-teacher-${i}@example.invalid`;
    const id = insert('INSERT INTO users (name,email,password,role) VALUES (?,?,?,?)',
      `Professor sintético ${i}`, email, bcrypt.hashSync(password, 4), 'professor');
    teachers.push({ id, email, token: issueUserToken(id) });
  }
  const owner = teachers[0].id;
  const grade = insert('INSERT INTO grades (name,sort_order) VALUES (?,?)', '7º Ano sintético', 7);
  const discipline = insert('INSERT INTO disciplines (name) VALUES (?)', 'Matemática sintética');
  const classId = insert(`INSERT INTO school_classes
    (public_id, owner_teacher_id, name, grade_id, academic_year, created_by, updated_by)
    VALUES (?, ?, '7º A sintético', ?, 2026, ?, ?)`, classPublicId, owner, grade, owner, owner);
  insert('INSERT INTO school_class_disciplines (class_id, owner_teacher_id, discipline_id, added_by) VALUES (?,?,?,?)', classId, owner, discipline, owner);
  const assignment = insert(`INSERT INTO class_assessment_assignments
    (public_id,class_id,owner_teacher_id,title_snapshot,snapshot_hash,question_count,created_by,updated_by)
    VALUES (?,?,?,'Avaliação sintética de concorrência',?,1,?,?)`, assignmentPublicId, classId, owner, 'f'.repeat(64), owner, owner);
  const item = insert(`INSERT INTO class_assessment_items
    (assignment_id,class_id,owner_teacher_id,question_code_snapshot,statement_snapshot,difficulty_snapshot,sort_order)
    VALUES (?,?,?,'CONCURRENCY-Q001','Quanto é 1 + 1?', 'media',1)`, assignment, classId, owner);
  for (const [i, label] of ['A', 'B', 'C', 'D'].entries()) {
    insert(`INSERT INTO class_assessment_item_options
      (assessment_item_id,assignment_id,class_id,owner_teacher_id,option_label,option_text_snapshot,is_correct,sort_order)
      VALUES (?,?,?,?,?,?,?,?)`, item, assignment, classId, owner, label, String(i + 1), i === 1 ? 1 : 0, i);
  }
  for (let i = 0; i < 35; i += 1) {
    const student = insert(`INSERT INTO students (public_id,owner_teacher_id,display_name,created_by,updated_by)
      VALUES (?,?,?,?,?)`, `synthetic-student-school-${i}`, owner, `Estudante sintético ${i}`, owner, owner);
    const enrollment = insert(`INSERT INTO school_class_enrollments (class_id,student_id,owner_teacher_id,created_by,updated_by)
      VALUES (?,?,?,?,?)`, classId, student, owner, owner, owner);
    insert(`INSERT INTO class_assessment_participants
      (assignment_id,class_id,student_id,enrollment_id,owner_teacher_id,created_by,updated_by)
      VALUES (?,?,?,?,?,?,?)`, assignment, classId, student, enrollment, owner, owner, owner);
  }
  db.prepare(`UPDATE class_assessment_assignments SET status = 'scheduled', opens_at = ?, closes_at = ?, revision = revision + 1 WHERE id = ?`)
    .run('2099-01-01T10:00:00Z', '2099-01-01T12:00:00Z', assignment);
  db.prepare(`UPDATE feature_flags SET master_enabled = 1, default_enabled = 1 WHERE flag_key IN
    ('classes.core','classes.assessment_assignments','classes.assessment_delivery','classes.student_assessment_portal')`).run();
  const pilotFlags = db.prepare(`SELECT id FROM feature_flags WHERE flag_key IN
    ('classes.core','classes.assessment_assignments','classes.assessment_delivery','classes.student_assessment_portal')`).all();
  for (const teacher of teachers) for (const flag of pilotFlags) {
    db.prepare(`INSERT INTO feature_flag_user_rules
      (feature_flag_id,user_id,enabled,reason,created_by,updated_by) VALUES (?,?,1,?,?,?)`)
      .run(flag.id, teacher.id, 'Teste sintético de concorrência escolar', owner, owner);
  }
  server = await new Promise(resolve => { const current = app.listen(0, '127.0.0.1', () => resolve(current)); });
  base = `http://127.0.0.1:${server.address().port}`;
  const initial = await request(accessPath, { token: teachers[0].token });
  assert.equal(initial.status, 200, JSON.stringify(initial.data));
  const enabled = await request(accessPath, { method: 'PATCH', token: teachers[0].token,
    body: { expectedRevision: initial.data.assessment.revision, enabled: true, resultMode: 'score_after_submit' } });
  assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
  const generated = await request(accessPath + '/credentials', { method: 'POST', token: teachers[0].token,
    body: { expectedRevision: enabled.data.assessment.revision, confirmation: 'GERAR_ACESSOS' } });
  assert.equal(generated.status, 201, JSON.stringify(generated.data));
  codes = generated.data.generated.map(row => row.code);
  db.prepare(`UPDATE class_assessment_assignments SET status = 'open', opens_at = '2000-01-01T10:00:00Z',
    opened_at = '2000-01-01T10:00:00Z', revision = revision + 1 WHERE id = ?`).run(assignment);
});
test.after(async () => {
  if (server) await new Promise(resolve => server.close(resolve));
  db.close(); fs.rmSync(temp, { recursive: true, force: true });
});

test('35 estudantes e 10 professores entram pela mesma origem sem bloqueio indevido', async () => {
  const [students, professionals] = await Promise.all([
    Promise.all(codes.map(code => request('/api/student-assessments/session', { method: 'POST', body: { code } }))),
    Promise.all(teachers.map(teacher => request('/api/auth/login', { method: 'POST', body: { email: teacher.email, password } }))),
  ]);
  assert.equal(students.length, 35);
  for (const result of [...students, ...professionals]) assert.equal(result.status, 200, JSON.stringify(result.data));
  studentTokens = students.map(result => result.data.token);
  for (const token of studentTokens) assert.equal(resolveIdentity({ headers: { authorization: `Bearer ${token}` } }).kind, 'student');
  const resumed = await Promise.all(studentTokens.map(token => request('/api/student-assessments/me', { token })));
  resumed.forEach(result => assert.equal(result.status, 200));
  assert.equal(db.prepare('SELECT COUNT(*) FROM class_assessment_attempts').pluck().get(), 35);
});

test('600 leituras de 10 professores não gastam um único orçamento de 500 por IP', async () => {
  const results = await Promise.all(teachers.map(async teacher => {
    const statuses = [];
    for (let i = 0; i < 60; i += 1) {
      const url = i % 2 ? '/api/notifications?limit=10' : '/api/governance/features?keys=classes.core';
      statuses.push((await request(url, { token: teacher.token })).status);
    }
    return statuses;
  }));
  assert.equal(results.flat().length, 600);
  assert.equal(results.flat().every(status => status === 200), true);
});

test('falhas repetidas de uma conta não bloqueiam outro professor e informam Retry-After', async () => {
  for (let i = 0; i < SCHOOL_LIMITS.loginFailures; i += 1) {
    assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: teachers[1].email, password: 'errada' } })).status, 401);
  }
  const blocked = await request('/api/auth/login', { method: 'POST', body: { email: teachers[1].email.toUpperCase(), password } });
  assert.equal(blocked.status, 429);
  assert.ok(Number(blocked.headers.get('retry-after')) > 0);
  assert.equal(blocked.data.code, 'rate_limited');
  assert.equal((await request('/api/auth/login', { method: 'POST', body: { email: teachers[2].email, password } })).status, 200);
});

test('tentativas repetidas por código são limitadas; código legítimo distinto continua utilizável', async () => {
  for (let i = 0; i < SCHOOL_LIMITS.studentCodeFailures; i += 1) {
    assert.equal((await request('/api/student-assessments/session', { method: 'POST', body: { code: 'AAAA-BBBB-CCCC-DDDD' } })).status, 401);
  }
  assert.equal((await request('/api/student-assessments/session', { method: 'POST', body: { code: 'aaaabbbbccccdddd' } })).status, 429);
  assert.equal((await request('/api/student-assessments/session', { method: 'POST', body: { code: codes[0] } })).status, 200);
});

test('identidade forjada, conta excluída e token revogado não ganham orçamentos próprios', () => {
  const asRequest = token => ({ headers: { authorization: `Bearer ${token}` } });
  const fake = jwt.sign({ id: 99999999 }, process.env.JWT_SECRET, { expiresIn: '1h' });
  assert.equal(resolveIdentity(asRequest(fake)), null);
  for (let i = 0; i < 10; i += 1) assert.equal(resolveIdentity(asRequest(`forged-${i}`)), null);
  const token = issueUserToken(teachers[9].id);
  db.prepare('INSERT INTO revoked_auth_tokens (token_digest,user_id,expires_at) VALUES (?,?,?)')
    .run(digestToken(token), teachers[9].id, Math.floor(Date.now() / 1000) + 600);
  assert.equal(resolveIdentity(asRequest(token)), null);
  assert.equal(ipKeyGenerator('2001:db8:1234:5600::1'), ipKeyGenerator('2001:db8:1234:56ff::2'));
});

test('credencial usada mantém identidade; expiração e revogação removem seu orçamento', t => {
  const input = { headers: { authorization: `Bearer ${studentTokens[0]}` } };
  const credentialId = resolveIdentity(input).key.slice('student:'.length);
  const original = db.prepare('SELECT expires_at FROM class_assessment_access_credentials WHERE public_id = ?').get(credentialId);
  db.prepare("UPDATE class_assessment_access_credentials SET status = 'used', used_at = CURRENT_TIMESTAMP WHERE public_id = ?").run(credentialId);
  assert.equal(resolveIdentity(input).kind, 'student');
  // O vencimento é imutável no banco: avançar apenas o relógio do teste.
  const clock = t.mock.method(Date, 'now', () => Date.parse(original.expires_at) + 1000);
  try {
    const { signStudentSession, verifyStudentSession } = require('../src/services/studentAssessmentAccess');
    const fresh = signStudentSession(credentialId);
    assert.equal(verifyStudentSession(fresh).credentialId, credentialId);
    assert.equal(resolveIdentity({ headers: { authorization: `Bearer ${fresh}` } }), null);
  } finally { clock.mock.restore(); }
  db.prepare("UPDATE class_assessment_access_credentials SET status = 'revoked', revoked_at = CURRENT_TIMESTAMP WHERE public_id = ?").run(credentialId);
  assert.equal(resolveIdentity(input), null);
});

test('exceder o orçamento de um professor não bloqueia outro na mesma escola', async () => {
  // Este professor já realizou 60 leituras no ensaio anterior.
  for (let i = 60; i < SCHOOL_LIMITS.professional; i += 1) {
    assert.equal((await request('/api/auth/me', { token: teachers[8].token })).status, 200);
  }
  assert.equal((await request('/api/auth/me', { token: teachers[8].token })).status, 429);
  assert.equal((await request('/api/auth/me', { token: teachers[7].token })).status, 200);
});

test('rotacionar Bearers inválidos não contorna o orçamento anônimo por origem', async () => {
  let blocked = false;
  for (let i = 0; i <= SCHOOL_LIMITS.anonymous; i += 1) {
    const result = await request('/api/auth/me', { token: `forged-rotated-${i}` });
    if (result.status === 429) { blocked = true; break; }
    assert.equal(result.status, 401);
  }
  assert.equal(blocked, true);
  assert.equal((await request('/api/auth/me', { token: 'another-forged-token' })).status, 429);
  assert.equal((await request('/api/auth/me', { token: teachers[7].token })).status, 200);
});
