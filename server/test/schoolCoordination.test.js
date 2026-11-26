const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { randomUUID } = require('node:crypto');
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-school-coordination-'));
process.env.NODE_ENV = 'test'; process.env.APP_ENV = 'development'; process.env.DB_PATH = path.join(temp, 'database.sqlite');
process.env.UPLOAD_DIR = path.join(temp, 'uploads'); process.env.JWT_SECRET = 'synthetic-school-coordination-tests-only';
const db = require('../src/database'), express = require('express');
const { issueUserToken } = require('../src/services/authSessions');
const { FLAGS, SUPPORT_FLAGS, schoolClasses, classSupport } = require('../src/services/schoolCoordination');
const app = express(); app.use(express.json()); app.use('/api/school-coordination', require('../src/routes/schoolCoordination'));
app.use(require('../src/middleware/apiErrors'));
const insert = (sql, ...args) => Number(db.prepare(sql).run(...args).lastInsertRowid);
const flag = (key, enabled) => assert.equal(db.prepare('UPDATE feature_flags SET master_enabled=?,default_enabled=?,rollout_percentage=?,release_id=NULL WHERE flag_key=?').run(enabled, enabled, enabled ? 100 : 0, key).changes, 1, `Flag inexistente: ${key}`);
let server, base, admin, teacher, coordinator, outsider, municipal, manager, school, otherSchool, municipality, grade, normal, small, empty, waiting, archived, otherClass, assessment;
function user(name, role = 'professor') { return insert('INSERT INTO users(name,email,password,role) VALUES (?,?,?,?)', name, name + '@example.invalid', 'hash', role); }
function membership(id, role, schoolId) { return insert('INSERT INTO institutional_memberships(public_id,user_id,role,municipality_id,school_id,created_by) VALUES (?,?,?,?,?,?)', randomUUID(), id, role, municipality, schoolId, admin); }
function makeClass(name, schoolId = school, verified = true, year = 2026) {
  const id = insert('INSERT INTO school_classes(public_id,owner_teacher_id,name,grade_id,academic_year,created_by) VALUES (?,?,?,?,?,?)', randomUUID(), teacher, name, grade, year, teacher);
  if (schoolId) {
    db.prepare("UPDATE school_class_institution_contexts SET municipality_id=?,school_id=?,migration_status='linked',linked_by=?,linked_at=CURRENT_TIMESTAMP WHERE class_id=?").run(municipality, schoolId, admin, id);
    if (verified) db.prepare("UPDATE school_class_institution_contexts SET migration_status='verified',verified_by=?,verified_at=CURRENT_TIMESTAMP WHERE class_id=?").run(teacher, id);
  }
  return id;
}
function makeAssessment(classId, count = 5, status = 'closed', date = '2026-09-15 12:00:00', definitions = [{}], sourceSet = null, roster = []) {
  const id = insert(`INSERT INTO class_assessment_assignments(public_id,class_id,owner_teacher_id,title_snapshot,snapshot_hash,question_count,created_by,source_question_set_id)
    VALUES (?,?,?,'Título privado não deve sair na consulta',?,?,?,?)`, randomUUID(), classId, teacher, 'a'.repeat(64), definitions.length, teacher, sourceSet);
  const items = definitions.map((definition, order) => {
    const item = insert(`INSERT INTO class_assessment_items(assignment_id,class_id,owner_teacher_id,question_code_snapshot,statement_snapshot,difficulty_snapshot,sort_order,skill_code_snapshot,skill_description_snapshot,source_skill_id)
      VALUES (?,?,?,'QA-ESCOLA','Enunciado privado não deve sair','media',?,?,?,?)`, id, classId, teacher, order, definition.code ?? null, definition.description ?? null, definition.skillId ?? null);
    const options = ['A', 'B', 'C', 'D'].map((label, i) => insert(`INSERT INTO class_assessment_item_options(assessment_item_id,assignment_id,class_id,owner_teacher_id,option_label,option_text_snapshot,is_correct,sort_order)
      VALUES (?,?,?,?,?,?,?,?)`, item, id, classId, teacher, label, `Alternativa ${label}`, i === 0 ? 1 : 0, i));
    return { item, options, ...definition };
  });
  const participants = Array.from({ length: Math.max(1, count + 2) }, (_, i) => {
    const student = roster[i]?.student_id ?? insert('INSERT INTO students(public_id,owner_teacher_id,display_name,created_by) VALUES (?,?,?,?)', randomUUID(), teacher, `ESTUDANTE SIGILOSO ${i}`, teacher);
    const enrollment = roster[i]?.enrollment_id ?? insert('INSERT INTO school_class_enrollments(class_id,student_id,owner_teacher_id,created_by) VALUES (?,?,?,?)', classId, student, teacher, teacher);
    const participant = insert('INSERT INTO class_assessment_participants(assignment_id,class_id,student_id,enrollment_id,owner_teacher_id,created_by) VALUES (?,?,?,?,?,?)', id, classId, student, enrollment, teacher, teacher);
    return { participant, student };
  });
  // One exempted participant and one pending participant are never included in the mean.
  db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP WHERE id=?").run(participants.at(-1).participant);
  if (status !== 'draft') db.prepare("UPDATE class_assessment_assignments SET status='open',opened_at=? WHERE id=?").run(date, id);
  if (status === 'closed' || status === 'open') {
    for (let i = 0; i < count; i++) {
      const p = participants[i];
      const attempt = insert('INSERT INTO class_assessment_attempts(public_id,participant_id,assignment_id,class_id,student_id,owner_teacher_id,question_count,created_by) VALUES (?,?,?,?,?,?,?,?)', randomUUID(), p.participant, id, classId, p.student, teacher, definitions.length, teacher);
      let correctCount = 0, answeredCount = 0;
      for (const item of items) {
        const correct = (item.correctIndices ? item.correctIndices.includes(i) : i % 2 === 0) ? 1 : 0;
        const blank = item.blankIndices?.includes(i);
        correctCount += blank ? 0 : correct; answeredCount += blank ? 0 : 1;
        insert('INSERT INTO class_assessment_responses(attempt_id,assessment_item_id,assignment_id,class_id,owner_teacher_id,selected_option_id,is_correct,answered_at) VALUES (?,?,?,?,?,?,?,?)', attempt, item.item, id, classId, teacher, blank ? null : item.options[correct ? 0 : 1], blank ? 0 : correct, blank ? null : date);
      }
      db.prepare("UPDATE class_assessment_attempts SET status='submitted',answered_count=?,correct_count=?,score_percentage=?,submitted_at=? WHERE id=?").run(answeredCount, correctCount, correctCount * 100 / definitions.length, date, attempt);
    }
    if (status === 'closed') db.prepare("UPDATE class_assessment_assignments SET status='closed',closed_at=? WHERE id=?").run(date, id);
  }
  return id;
}
const publicSchool = () => db.prepare('SELECT public_id FROM schools WHERE id=?').pluck().get(school);
const classesPath = () => '/schools/' + publicSchool() + '/classes';
const skillsPath = classId => classesPath() + '/' + db.prepare('SELECT public_id FROM school_classes WHERE id=?').pluck().get(classId) + '/skills';
const skillDefinitions = [
  { code: 'EF05MA01-QA', description: 'Ler e comparar números — exemplo sintético.', correctIndices: [0] },
  { code: 'EF05MA01-QA', description: 'Ler e comparar números — exemplo sintético.', correctIndices: [1, 2], blankIndices: [4] },
  { code: 'EF05MA02-QA', description: 'Resolver problemas com medidas — exemplo sintético.', correctIndices: [0, 1, 2, 3, 4] },
  { correctIndices: [], blankIndices: [0, 1, 2, 3, 4] },
];
async function request(url = '/schools', id = coordinator) {
  const response = await fetch(base + '/api/school-coordination' + url, { headers: id ? { Authorization: 'Bearer ' + issueUserToken(id) } : {} });
  return { status: response.status, data: await response.json(), cache: response.headers.get('cache-control'), vary: response.headers.get('vary') };
}
test.before(async () => {
  try {
  admin = user('admin.coord.qa', 'admin'); teacher = user('docente.coord.qa'); coordinator = user('coordenacao.qa'); outsider = user('outro.coord.qa'); municipal = user('municipal.coord.qa'); manager = user('gestao.coord.qa');
  grade = insert("INSERT INTO grades(name) VALUES ('5º Ano — teste')");
  municipality = insert('INSERT INTO municipalities(public_id,name,created_by) VALUES (?,?,?)', randomUUID(), 'Município de teste', admin);
  school = insert('INSERT INTO schools(public_id,municipality_id,name,created_by) VALUES (?,?,?,?)', randomUUID(), municipality, 'Escola Horizonte — teste', admin);
  otherSchool = insert('INSERT INTO schools(public_id,municipality_id,name,created_by) VALUES (?,?,?,?)', randomUUID(), municipality, 'Escola fora do vínculo', admin);
  membership(teacher, 'teacher', school); membership(teacher, 'teacher', otherSchool); membership(coordinator, 'school_coordinator', school);
  membership(coordinator, 'teacher', school); membership(manager, 'school_manager', school); membership(municipal, 'municipal_manager', null);
  normal = makeClass('5º A — Manhã'); small = makeClass('5º B — Tarde'); empty = makeClass('5º C — Sem avaliação'); waiting = makeClass('Turma ainda sem confirmação', school, false); archived = makeClass('Turma arquivada'); otherClass = makeClass('Turma de outra escola', otherSchool);
  db.prepare("UPDATE school_classes SET status='archived',archived_at=CURRENT_TIMESTAMP WHERE id=?").run(archived);
  assessment = makeAssessment(normal, 5); makeAssessment(normal, 4, 'closed', '2026-09-15T11:00:00.000Z'); makeAssessment(normal, 5, 'open'); makeAssessment(normal, 0, 'draft'); makeAssessment(small, 4); makeAssessment(otherClass, 5);
  await new Promise(resolve => { server = app.listen(0, '127.0.0.1', () => { base = 'http://127.0.0.1:' + server.address().port; resolve(); }); });
  } catch (error) { console.error('Synthetic coordination fixture failed:', error); throw error; }
});
test.after(async () => { if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); } db.close(); assert.equal(path.dirname(temp), fs.realpathSync(os.tmpdir())); assert.match(path.basename(temp), /^labmathic-school-coordination-/); fs.rmSync(temp, { recursive: true, force: true }); });

test('default fechado, autenticação e dependências obrigatórias, reaplicação sem mudanças', async () => {
  assert.equal((await request('/schools', null)).status, 401);
  assert.equal((await request()).status, 404);
  const saved = db.prepare("SELECT master_enabled,default_enabled,rollout_percentage FROM feature_flags WHERE flag_key='institutions.school_coordination'").get();
  assert.deepEqual(saved, { master_enabled: 0, default_enabled: 0, rollout_percentage: 0 });
  FLAGS.forEach(key => flag(key, 1));
  for (const key of FLAGS) { flag(key, 0); assert.equal((await request()).status, 404); assert.equal((await request(classesPath())).status, 404); flag(key, 1); }
  assert.equal(require('../src/migrations').runMigrations(db, { logger: { info() {} } }).appliedNow.length, 0);
});
test('escopo exato, papéis acumulados, gestão municipal e administrador sem conceder permissões', async () => {
  const r = await request(); assert.equal(r.status, 200); assert.equal(r.data.total, 1); assert.equal(r.data.items[0].id, publicSchool()); assert.equal(r.cache, 'no-store'); assert.match(r.vary, /Authorization/);
  assert.equal((await request('/schools', teacher)).data.total, 0); assert.equal((await request('/schools', outsider)).data.total, 0);
  assert.equal((await request('/schools', manager)).data.total, 1); assert.equal((await request('/schools', municipal)).data.total, 2); assert.equal((await request('/schools', admin)).data.total, 2);
  assert.equal((await request(classesPath(), teacher)).status, 404); assert.equal((await request(classesPath(), outsider)).status, 404);
  assert.throws(() => schoolClasses(db, { id: outsider, role: 'admin' }, publicSchool()), error => error.status === 404);
  const otherId = db.prepare('SELECT public_id FROM schools WHERE id=?').pluck().get(otherSchool);
  assert.deepEqual((await request('/schools/' + otherId + '/classes')).data, (await request('/schools/' + randomUUID() + '/classes')).data);
  assert.equal(db.prepare('SELECT role FROM users WHERE id=?').pluck().get(coordinator), 'professor');
});
test('somente turmas ativas verificadas; último encerramento real, não maior id nem melhor nota', async () => {
  const r = await request(classesPath()); assert.equal(r.status, 200, JSON.stringify(r.data)); assert.equal(r.data.total, 3);
  const row = r.data.items.find(item => item.name.startsWith('5º A'));
  assert.equal(row.closedCount, 2); assert.equal(row.openCount, 1);
  assert.deepEqual(row.result, { status: 'available', closedAt: '2026-09-15 12:00:00', questionCount: 1, correctedCount: 5, meanPercentage: 60 });
  const protectedRow = r.data.items.find(item => item.name.startsWith('5º B'));
  assert.deepEqual(protectedRow.result, { status: 'protected', closedAt: '2026-09-15 12:00:00', questionCount: 1 });
  assert.equal(r.data.items.find(item => item.name.startsWith('5º C')).result, null);
  assert.doesNotMatch(JSON.stringify(r.data), /ESTUDANTE|SIGILOSO|Título privado|Enunciado privado|display_name|teacher_id|student_id|attempt|participant/);
  const view = await import('../../client/src/services/schoolCoordinationView.mjs'); view.parseCoordinationClasses(r.data);
});
test('revogação do vínculo da coordenação ou do docente bloqueia dados na próxima consulta', async () => {
  const revoke = (id, role, state) => db.prepare("UPDATE institutional_memberships SET status=?,ended_at=CASE WHEN ?='inactive' THEN CURRENT_TIMESTAMP ELSE NULL END WHERE user_id=? AND role=?").run(state, state, id, role);
  revoke(coordinator, 'school_coordinator', 'inactive'); assert.equal((await request()).data.total, 0); assert.equal((await request(classesPath())).status, 404); revoke(coordinator, 'school_coordinator', 'active');
  revoke(teacher, 'teacher', 'inactive'); assert.equal((await request(classesPath())).data.total, 0); revoke(teacher, 'teacher', 'active');
  db.prepare("UPDATE users SET role='admin' WHERE id=?").run(coordinator);
  // Service must reload the current role, rather than trusting an earlier actor object.
  assert.equal(schoolClasses(db, { id: coordinator, role: 'professor' }, publicSchool()).total, 3);
  db.prepare("UPDATE users SET role='professor' WHERE id=?").run(coordinator);
});
test('correção anulada não entra e redução do grupo oculta a média, sem transformar ausência em zero', async () => {
  const participant = db.prepare("SELECT participant_id FROM class_assessment_attempts WHERE assignment_id=? AND status='submitted' ORDER BY id LIMIT 1").pluck().get(assessment);
  db.exec('SAVEPOINT verify_exemption');
  try {
    db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP WHERE id=?").run(participant);
    assert.equal(schoolClasses(db, { id: coordinator }, publicSchool()).items.find(item => item.name.startsWith('5º A')).result.status, 'protected');
  } finally { db.exec('ROLLBACK TO verify_exemption; RELEASE verify_exemption'); }
  const attempt = db.prepare('SELECT id FROM class_assessment_attempts WHERE assignment_id=? ORDER BY id LIMIT 1').get(assessment);
  db.prepare("UPDATE class_assessment_attempts SET status='voided',voided_at=CURRENT_TIMESTAMP WHERE id=?").run(attempt.id);
  const row = (await request(classesPath())).data.items.find(item => item.name.startsWith('5º A')); assert.equal(row.result.status, 'protected'); assert.equal(row.result.meanPercentage, undefined);
});
test('bloqueio emergencial prevalece inclusive na homologação e sobre liberação individual', async () => {
  const config = require('../src/config'), previous = config.appEnvironment;
  try {
    config.appEnvironment = 'homologation';
    flag('institutions.school_coordination', 0); assert.equal((await request()).status, 404);
    flag('institutions.school_coordination', 1);
    db.exec("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético para teste',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='institutions.school_coordination'");
    assert.equal((await request()).status, 404); assert.equal((await request(classesPath())).status, 404);
  } finally { config.appEnvironment = previous; db.exec("UPDATE feature_flags SET kill_switch_active=0,kill_switch_reason=NULL,kill_switch_activated_at=NULL WHERE flag_key='institutions.school_coordination'"); flag('institutions.school_coordination', 1); }
});
test('filtros estritos, paginação limitada, ano letivo e nenhum identificador numérico exposto', async () => {
  for (const url of ['/schools?page=0', '/schools?page=1.2', '/schools?page[]=1', '/schools?search[]=x', '/schools?unknown=1', classesPath() + '?year=1999', classesPath() + '?year=2026&year=2025', classesPath() + '?student=1']) assert.equal((await request(url)).status, 400);
  assert.equal((await request('/schools?search=Horizonte')).data.total, 1); assert.equal((await request('/schools?search=inexistente')).data.total, 0);
  assert.equal((await request(classesPath() + '?year=2025')).data.total, 0);
  for (let i = 0; i < 22; i++) makeClass('Turma adicional ' + i, school, true, 2025);
  const first = (await request(classesPath() + '?year=2025')).data, second = (await request(classesPath() + '?year=2025&page=2')).data;
  assert.equal(first.total, 22); assert.equal(first.items.length, 20); assert.equal(second.items.length, 2);
  assert.equal(new Set([...first.items, ...second.items].map(row => row.id)).size, 22);
});
test('busca escolar: encontra turma fora da primeira página e combina nome, ano escolar e ano letivo', async () => {
  const initial = (await request(classesPath() + '?year=2025')).data;
  const next = (await request(classesPath() + '?year=2025&page=2')).data;
  const target = next.items[0];
  assert.equal(initial.items.some(item => item.id === target.id), false);
  const found = await request(classesPath() + '?year=2025&search=' + encodeURIComponent(target.name));
  assert.equal(found.status, 200); assert.equal(found.data.total, 1); assert.equal(found.data.items[0].id, target.id);
  assert.equal((await request(classesPath() + '?year=2026&search=' + encodeURIComponent(target.name))).data.total, 0);
  assert.equal((await request(classesPath() + '?year=2025&search=5%C2%BA%20Ano')).data.total, 22);
  assert.equal((await request(classesPath() + '?year=2025&search=adicional&page=2')).data.items.length, 2);
  assert.deepEqual((await request(classesPath() + '?search=%20%20')).data, (await request(classesPath())).data);
});

test('busca escolar: ignora caixa e acentos, trata caracteres SQL literalmente e valida entrada', async () => {
  assert.equal((await request(classesPath() + '?search=MANHA')).data.items[0].name, '5º A — Manhã');
  assert.equal((await request(classesPath() + '?search=manh%C3%A3')).data.total, 1);
  for (const text of ["%' OR 1=1 --", '_', 'inexistente']) {
    const result = await request(classesPath() + '?search=' + encodeURIComponent(text));
    assert.equal(result.status, 200); assert.equal(result.data.total, 0);
  }
  for (const suffix of ['?search[]=A', '?search=A&search=B', '?search=' + 'x'.repeat(101), '?search[student]=1'])
    assert.equal((await request(classesPath() + suffix)).status, 400);
  assert.equal((await request(classesPath() + '?search=' + 'x'.repeat(100))).status, 200);
});

test('busca escolar: não revela outras escolas, turmas não confirmadas ou arquivadas, e mantém auditoria mínima', async () => {
  for (const text of ['outra escola', 'sem confirmação', 'arquivada'])
    assert.equal((await request(classesPath() + '?search=' + encodeURIComponent(text))).data.total, 0);
  const endpoint = classesPath() + '?search=MANHA';
  assert.equal((await request(endpoint, null)).status, 401);
  assert.equal((await request(endpoint, outsider)).status, 404);
  const result = await request(endpoint); assert.equal(result.status, 200); assert.equal(result.cache, 'no-store');
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE action='school_coordination_classes_read' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(Object.keys(metadata).sort(), ['page', 'returned', 'schoolId', 'year']);
  assert.doesNotMatch(JSON.stringify(metadata), /MANHA|search|name/);
  for (const key of FLAGS) {
    try { flag(key, 0); assert.equal((await request(endpoint)).status, 404); } finally { flag(key, 1); }
  }
  db.exec('SAVEPOINT search_scope');
  try {
    db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role='school_coordinator'").run(coordinator);
    assert.equal((await request(endpoint)).status, 404);
  } finally { db.exec('ROLLBACK TO search_scope; RELEASE search_scope'); }
});

test('consulta auditada, sem conteúdo livre; falha de auditoria impede entrega e preserva avaliações', async () => {
  const before = db.prepare('SELECT * FROM class_assessment_assignments').all();
  const r = await request(classesPath()); assert.equal(r.status, 200);
  const audit = db.prepare("SELECT metadata_json FROM activity_log WHERE action='school_coordination_classes_read' ORDER BY id DESC LIMIT 1").get();
  assert.deepEqual(Object.keys(JSON.parse(audit.metadata_json)).sort(), ['page', 'returned', 'schoolId', 'year']);
  db.exec("CREATE TRIGGER reject_coordination_audit BEFORE INSERT ON activity_log WHEN NEW.action LIKE 'school_coordination_%' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  assert.equal((await request()).status, 500); assert.equal((await request(classesPath())).status, 500);
  db.exec('DROP TRIGGER reject_coordination_audit'); assert.deepEqual(db.prepare('SELECT * FROM class_assessment_assignments').all(), before);
});

test('habilidades: agrupa questões, respeita denominadores e não transforma pendências em zeros', async () => {
  const classId = makeClass('Habilidades — 5º A', school, true, 2027);
  makeAssessment(classId, 5, 'closed', '2026-09-19 12:00:00', skillDefinitions);
  const r = await request(skillsPath(classId)); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.cache, 'no-store'); assert.match(r.vary, /Authorization/);
  assert.equal(r.data.result.correctedCount, 5); assert.equal(r.data.result.meanPercentage, 40);
  assert.deepEqual(r.data.result.skills.map(s => [s.code, s.questionCount, s.successRate]), [['EF05MA01-QA', 2, 30], ['EF05MA02-QA', 1, 100], [null, 1, 0]]);
  assert.doesNotMatch(JSON.stringify(r.data), /ESTUDANTE|SIGILOSO|Título privado|Enunciado privado|Alternativa|student|teacher_id|attempt|participant|correct_count|is_correct/);
  const { parseCoordinationSkills } = await import('../../client/src/services/schoolCoordinationView.mjs');
  assert.equal(parseCoordinationSkills(r.data, publicSchool(), r.data.class.id), r.data);
});

test('habilidades: vazio é diferente de protegido; última avaliação não usa a melhor nota nem maior id', async () => {
  assert.equal((await request(skillsPath(empty))).data.result, null);
  const classId = makeClass('Recência protegida', school, true, 2027);
  makeAssessment(classId, 4, 'closed', '2026-09-19 12:00:00', skillDefinitions);
  makeAssessment(classId, 5, 'closed', '2026-09-19T11:59:59.000Z', skillDefinitions);
  makeAssessment(classId, 5, 'open', '2026-09-20 12:00:00', skillDefinitions);
  assert.deepEqual((await request(skillsPath(classId))).data.result, { closedAt: '2026-09-19 12:00:00', questionCount: 4, status: 'protected' });
  makeAssessment(classId, 5, 'closed', '2026-09-19T12:00:00.000Z', skillDefinitions);
  assert.equal((await request(skillsPath(classId))).data.result.status, 'available');
});

test('habilidades: cada consulta reaplica autenticação, flags, escopo e vínculos atuais', async () => {
  assert.equal((await request(skillsPath(normal), null)).status, 401);
  for (const actor of [teacher, outsider]) assert.equal((await request(skillsPath(normal), actor)).status, 404);
  for (const actor of [admin, municipal, manager]) assert.equal((await request(skillsPath(normal), actor)).status, 200);
  for (const classId of [otherClass, waiting, archived]) assert.equal((await request(skillsPath(classId))).status, 404);
  const missing = await request(classesPath() + '/' + randomUUID() + '/skills');
  assert.deepEqual((await request(skillsPath(otherClass))).data, missing.data);
  for (const key of FLAGS) { try { flag(key, 0); assert.equal((await request(skillsPath(normal))).status, 404); } finally { flag(key, 1); } }
  db.exec('SAVEPOINT revoke_skills');
  try {
    db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role='school_coordinator'").run(coordinator);
    assert.equal((await request(skillsPath(normal))).status, 404);
  } finally { db.exec('ROLLBACK TO revoke_skills; RELEASE revoke_skills'); }
  db.exec('SAVEPOINT revoke_teacher_skills');
  try {
    db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role='teacher'").run(teacher);
    assert.equal((await request(skillsPath(normal))).status, 404);
  } finally { db.exec('ROLLBACK TO revoke_teacher_skills; RELEASE revoke_teacher_skills'); }
  db.exec('SAVEPOINT revoke_role_skills');
  try {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher);
    assert.equal((await request(skillsPath(normal))).status, 404);
    db.exec("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético de habilidades',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='institutions.school_coordination'");
    assert.equal((await request(skillsPath(normal), admin)).status, 404);
  } finally { db.exec('ROLLBACK TO revoke_role_skills; RELEASE revoke_role_skills'); }
  for (const query of ['?year=2026', '?page=1', '?student=1', '?search[]=x']) assert.equal((await request(skillsPath(normal) + query)).status, 400);
});

test('habilidades: dispensa e anulação retiram a correção e grupo abaixo de cinco não revela habilidades', async () => {
  const classId = makeClass('Proteção após revisão', school, true, 2027);
  const assignment = makeAssessment(classId, 6, 'closed', '2026-09-19 12:00:00', skillDefinitions);
  const attempts = db.prepare('SELECT id,participant_id FROM class_assessment_attempts WHERE assignment_id=? ORDER BY id').all(assignment);
  db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP WHERE id=?").run(attempts[0].participant_id);
  const r = (await request(skillsPath(classId))).data.result;
  assert.equal(r.correctedCount, 5);
  assert.equal(r.skills.find(s => s.code === 'EF05MA01-QA').successRate, 20);
  assert.equal(r.skills.find(s => s.code === 'EF05MA02-QA').successRate, 80);
  db.prepare("UPDATE class_assessment_attempts SET status='voided',voided_at=CURRENT_TIMESTAMP WHERE id=?").run(attempts[1].id);
  assert.deepEqual((await request(skillsPath(classId))).data.result, { closedAt: '2026-09-19 12:00:00', questionCount: 4, status: 'protected' });
});

test('habilidades: registros incompletos não fabricam percentuais; não expõe tamanho de subgrupo', async () => {
  const classId = makeClass('Falha sintética de integridade', school, true, 2027);
  const assignment = makeAssessment(classId, 5, 'closed', '2026-09-19 12:00:00', skillDefinitions);
  db.exec('SAVEPOINT incomplete_skills');
  try {
    // Deliberately simulate damaged legacy data only inside this isolated, rolled-back fixture.
    db.exec('DROP TRIGGER class_assessment_responses_validate_delete');
    db.prepare('DELETE FROM class_assessment_responses WHERE id=(SELECT MIN(id) FROM class_assessment_responses WHERE assignment_id=?)').run(assignment);
    const result = (await request(skillsPath(classId))).data.result;
    assert.deepEqual(result.skills.find(s => s.code === 'EF05MA01-QA'), { code: 'EF05MA01-QA', description: skillDefinitions[0].description, questionCount: 2, status: 'unavailable' });
    assert.equal(result.skills.find(s => s.code === 'EF05MA02-QA').successRate, 100);
    assert.equal(result.skills.at(-2).code, 'EF05MA01-QA');
    assert.equal(result.skills.at(-1).code, null);
  } finally { db.exec('ROLLBACK TO incomplete_skills; RELEASE incomplete_skills'); }
});

test('habilidades: auditoria mínima é obrigatória e consulta não altera avaliações ou respostas', async () => {
  const before = ['class_assessment_assignments', 'class_assessment_attempts', 'class_assessment_responses'].map(t => db.prepare(`SELECT * FROM ${t}`).all());
  assert.equal((await request(skillsPath(normal))).status, 200);
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE action='school_coordination_skills_read' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(Object.keys(metadata).sort(), ['classId', 'resultStatus', 'schoolId']);
  db.exec("CREATE TRIGGER reject_skills_audit BEFORE INSERT ON activity_log WHEN NEW.action='school_coordination_skills_read' BEGIN SELECT RAISE(ABORT,'synthetic audit failure'); END");
  try { assert.equal((await request(skillsPath(normal))).status, 500); } finally { db.exec('DROP TRIGGER reject_skills_audit'); }
  assert.deepEqual(['class_assessment_assignments', 'class_assessment_attempts', 'class_assessment_responses'].map(t => db.prepare(`SELECT * FROM ${t}`).all()), before);
});

test('habilidades: classificação vazia vira grupo único sem esconder habilidades identificadas', async () => {
  const classId = makeClass('Classificação incompleta', school, true, 2027);
  makeAssessment(classId, 5, 'closed', '2026-09-19 12:00:00', [
    { code: '', description: 'Texto que não deve identificar uma habilidade' },
    { code: '  ', description: 'Outro texto sem código' },
    { code: ' EF05MA01-QA ', description: ' Ler e comparar números. ' },
  ]);
  assert.deepEqual((await request(skillsPath(classId))).data.result.skills, [
    { code: 'EF05MA01-QA', description: 'Ler e comparar números.', questionCount: 1, status: 'available', successRate: 60 },
    { code: null, description: null, questionCount: 2, status: 'available', successRate: 60 },
  ]);
});

test('habilidades: avaliação no limite de 100 questões mantém todos os grupos, sem recorte silencioso', async () => {
  const classId = makeClass('Cem habilidades sintéticas', school, true, 2027);
  makeAssessment(classId, 5, 'closed', '2026-09-19 12:00:00', Array.from({ length: 100 }, (_, index) => ({
    code: `QA-${String(index).padStart(3, '0')}`, description: `Habilidade sintética ${index}.`,
  })));
  const r = await request(skillsPath(classId)); assert.equal(r.status, 200);
  assert.equal(r.data.result.skills.length, 100);
  assert.equal(r.data.result.questionCount, 100);
  assert.equal(new Set(r.data.result.skills.map(s => s.code)).size, 100);
  assert.ok(r.data.result.skills.every(s => s.successRate === 60 && s.questionCount === 1));
  (await import('../../client/src/services/schoolCoordinationView.mjs')).parseCoordinationSkills(r.data, publicSchool(), r.data.class.id);
});

// Synthetic support fixtures go through the real schema constraints, without dropping triggers.
let supportClass, supportSkill, activeSupport;
const supportPath = classId => skillsPath(classId).replace(/skills$/, 'support');
function makeSupport(classId, { status = 'active', execution = true, executionDraft = false,
  lessonStates = ['taught', 'skipped', 'planned'], verification = 'not_created', corrected = 5, baselineCount = 5,
  pairStudents = false, skills = [supportSkill], baselineCorrectIndices, verificationCorrectIndices, verificationBlankIndices } = {}) {
  const questionSet = insert("INSERT INTO question_sets(user_id,title,is_public) VALUES (?,'DIAGNÓSTICO PRIVADO',0)", teacher);
  insert('INSERT INTO diagnostic_question_sets(question_set_id,owner_teacher_id,grade_id,questions_per_skill,total_questions) VALUES (?,?,?,2,2)', questionSet, teacher, grade);
  insert('INSERT INTO diagnostic_question_set_reviews(question_set_id,owner_teacher_id,reviewed_by) VALUES (?,?,?)', questionSet, teacher, teacher);
  const definitions = skills.map(skill => ({ skillId: skill.id, code: skill.code, description: skill.description }));
  const source = makeAssessment(classId, baselineCount, 'closed', '2026-09-15 12:00:00',
    definitions.flatMap(definition => Array.from({ length: 2 }, () => ({ ...definition, correctIndices: baselineCorrectIndices }))), questionSet);
  const id = insert(`INSERT INTO learning_recovery_plans(public_id,owner_teacher_id,class_id,source_assignment_id,title,
    idempotency_key_hash,request_fingerprint,source_assessment_revision,source_results_revision_hash,
    diagnostic_algorithm_version_snapshot,diagnostic_confirmation_version_snapshot,created_by)
    VALUES (?,?,?,?,'PLANO PRIVADO',?,?,1,?,'balanced-v1','teacher-review-v1',?)`, randomUUID(), teacher, classId, source,
  randomUUID().replace(/-/g, '').repeat(2), 'b'.repeat(64), 'c'.repeat(64), teacher);
  skills.forEach((skill, index) => insert(`INSERT INTO learning_recovery_plan_skills(plan_id,owner_teacher_id,class_id,source_skill_id,skill_code_snapshot,
    skill_description_snapshot,success_rate_snapshot,opportunity_count,diagnostic_level,priority,rationale)
    VALUES (?,?,?,?,?,?,20,10,'below_expected',?,'JUSTIFICATIVA PRIVADA')`, id, teacher, classId, skill.id, skill.code, skill.description, index + 1));
  let executionId = null, verificationId = null;
  if (status !== 'draft') {
    db.prepare("UPDATE learning_recovery_plans SET status='active',activated_at='2026-09-17 12:00:00' WHERE id=?").run(id);
    if (execution) {
      const year = db.prepare('SELECT academic_year FROM school_classes WHERE id=?').pluck().get(classId);
      executionId = insert(`INSERT INTO teaching_plans(public_id,owner_teacher_id,class_id,grade_id,source_recovery_plan_id,title,
        period_type,academic_year,starts_on,ends_on,created_by) VALUES (?,?,?,?,?,'AULAS PRIVADAS','custom',?,'2026-09-17','2026-09-30',?)`, randomUUID(), teacher, classId, grade, id, year, teacher);
      const lessons = [...lessonStates, 'planned'].map((state, index) => {
        const lessonId = insert(`INSERT INTO teaching_plan_lessons(public_id,plan_id,owner_teacher_id,title,objective,teacher_notes,sequence_order,lesson_phase)
          VALUES (?,?,?,'TÍTULO PRIVADO','OBJETIVO PRIVADO','ANOTAÇÃO PRIVADA',?,?)`, randomUUID(), executionId, teacher, index + 1, index === lessonStates.length ? 'monitoring' : 'intervention');
        insert(`INSERT INTO teaching_plan_lesson_skills(lesson_id,plan_id,owner_teacher_id,source_skill_id,skill_code_snapshot,skill_description_snapshot)
          VALUES (?,?,?,?,?,?)`, lessonId, executionId, teacher, supportSkill.id, supportSkill.code, supportSkill.description);
        return { lessonId, state };
      });
      if (!executionDraft) {
        db.prepare("UPDATE teaching_plans SET status='active',activated_at='2026-09-17 12:00:00' WHERE id=?").run(executionId);
        for (const lesson of lessons) if (lesson.state !== 'planned') db.prepare('UPDATE teaching_plan_lessons SET status=? WHERE id=?').run(lesson.state, lesson.lessonId);
        if (verification !== 'not_created') {
          const monitoringSet = insert("INSERT INTO question_sets(user_id,title,is_public) VALUES (?,'VERIFICAÇÃO PRIVADA',0)", teacher);
          insert(`INSERT INTO learning_recovery_monitoring_cycles(public_id,recovery_plan_id,execution_plan_id,monitoring_lesson_id,
            owner_teacher_id,class_id,question_set_id,created_by) VALUES (?,?,?,?,?,?,?,?)`, randomUUID(), id, executionId, lessons.at(-1).lessonId, teacher, classId, monitoringSet, teacher);
          verificationId = makeAssessment(classId, ['closed', 'open'].includes(verification) ? corrected : 0,
            ['closed', 'open'].includes(verification) ? verification : 'draft', '2026-09-20 12:00:00',
            definitions.map(definition => ({ ...definition, correctIndices: verificationCorrectIndices, blankIndices: verificationBlankIndices })), monitoringSet,
            pairStudents ? db.prepare('SELECT student_id,enrollment_id FROM class_assessment_participants WHERE assignment_id=? ORDER BY id').all(source) : []);
          if (verification === 'scheduled') db.prepare("UPDATE class_assessment_assignments SET status='scheduled',opens_at='2026-09-25 12:00:00' WHERE id=?").run(verificationId);
          if (verification === 'cancelled') db.prepare("UPDATE class_assessment_assignments SET status='cancelled',cancelled_at='2026-09-20 12:00:00' WHERE id=?").run(verificationId);
        }
        if (status === 'completed') {
          db.prepare("UPDATE teaching_plan_lessons SET status='skipped' WHERE id=?").run(lessons.at(-1).lessonId);
          db.prepare("UPDATE teaching_plans SET status='completed',completed_at='2026-09-20 12:00:00' WHERE id=?").run(executionId);
        }
      }
    }
    if (status !== 'active') db.prepare(`UPDATE learning_recovery_plans SET status=?,
      completed_at=CASE WHEN ?='completed' THEN '2026-09-20 12:00:00' END,
      archived_at=CASE WHEN ?='archived' THEN '2026-09-20 12:00:00' END WHERE id=?`).run(status, status, status, id);
  }
  return { id, source, executionId, verificationId, publicId: db.prepare('SELECT public_id FROM learning_recovery_plans WHERE id=?').pluck().get(id) };
}

test('apoio: depende das flags existentes e separa aulas realizadas, previstas e não realizadas', async () => {
  supportClass = makeClass('5º D — Apoio à aprendizagem', school, true, 2028);
  const unit = insert("INSERT INTO bncc_units(name) VALUES ('Unidade sintética de apoio')");
  const skillId = insert("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES ('EF05MA-SUPPORT-QA','Resolver problemas — exemplo sintético.',?,?)", grade, unit);
  supportSkill = db.prepare('SELECT id,code,description FROM bncc_skills WHERE id=?').get(skillId);
  activeSupport = makeSupport(supportClass);
  for (const key of SUPPORT_FLAGS) { flag(key, 0); assert.equal((await request(supportPath(supportClass))).status, 404); flag(key, 1); }
  const r = await request(supportPath(supportClass)); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.cache, 'no-store'); assert.match(r.vary, /Authorization/);
  assert.deepEqual(r.data.items[0], { id: activeSupport.publicId, status: 'active', activatedAt: '2026-09-17 12:00:00',
    sourceClosedAt: '2026-09-15 12:00:00', execution: { status: 'active', total: 3, taught: 1, skipped: 1, planned: 1 },
    verification: { status: 'not_created', closedAt: null, results: null } });
  (await import('../../client/src/services/schoolCoordinationSupportView.mjs')).parseCoordinationSupport(r.data, publicSchool(), r.data.class.id, 1);
});

test('apoio: rascunhos e planos arquivados não aparecem; execução privada não vaza; conclusão não implica verificação', async () => {
  const classId = makeClass('Visibilidade dos planos', school, true, 2028);
  makeSupport(classId, { status: 'draft' }); makeSupport(classId, { status: 'archived' });
  const draftExecution = makeSupport(classId, { executionDraft: true });
  const noExecution = makeSupport(classId, { execution: false });
  const completed = makeSupport(classId, { status: 'completed', lessonStates: ['taught', 'skipped'] });
  const r = await request(supportPath(classId)); assert.equal(r.status, 200); assert.equal(r.data.total, 3);
  for (const id of [draftExecution.publicId, noExecution.publicId]) assert.equal(r.data.items.find(x => x.id === id).execution, null);
  assert.equal(r.data.items.at(-1).id, completed.publicId);
  assert.equal(r.data.items.at(-1).verification.status, 'not_created');
  assert.doesNotMatch(JSON.stringify(r.data), /PRIVAD|SIGILOSO|student|teacher_id|rationale|score|success_rate|title|objective|notes|group/);
});

test('apoio: usa a verificação do próprio plano e não a última avaliação da turma; consulta acompanha estados reais', async () => {
  const classId = makeClass('Verificação do plano', school, true, 2028);
  for (const state of ['draft', 'scheduled', 'open', 'closed', 'cancelled']) {
    const plan = makeSupport(classId, { verification: state });
    makeAssessment(classId, 6, 'closed', '2026-09-21 12:00:00');
    const r = await request(supportPath(classId)); assert.equal(r.status, 200, JSON.stringify(r.data));
    const item = r.data.items.find(x => x.id === plan.publicId);
    assert.deepEqual(item.verification, { status: state, closedAt: state === 'closed' ? '2026-09-20 12:00:00' : null, results: state === 'closed' ? 'available' : null });
    assert.equal(item.sourceClosedAt, '2026-09-15 12:00:00');
  }
});

test('apoio: grupos pequenos, dispensas e anulações não revelam quantidades nem fabricam resultados', async () => {
  const classId = makeClass('Verificação protegida', school, true, 2028);
  for (const count of [0, 4, 5]) {
    const plan = makeSupport(classId, { verification: 'closed', corrected: count, baselineCount: 4 });
    const get = async () => (await request(supportPath(classId))).data.items.find(x => x.id === plan.publicId);
    assert.equal((await get()).verification.results, count < 5 ? 'protected' : 'available');
    if (count === 5) {
      const attempt = db.prepare('SELECT id,participant_id FROM class_assessment_attempts WHERE assignment_id=? LIMIT 1').get(plan.verificationId);
      db.exec('SAVEPOINT support_exempt');
      try {
        db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP WHERE id=?").run(attempt.participant_id);
        assert.equal((await get()).verification.results, 'protected');
      } finally { db.exec('ROLLBACK TO support_exempt; RELEASE support_exempt'); }
      db.prepare("UPDATE class_assessment_attempts SET status='voided',voided_at=CURRENT_TIMESTAMP WHERE id=?").run(attempt.id);
      assert.equal((await get()).verification.results, 'protected');
    }
    assert.deepEqual(Object.keys((await get()).verification).sort(), ['closedAt', 'results', 'status']);
  }
});

test('apoio: autenticação, escopo, filtros e revogação são revalidados a cada consulta', async () => {
  const endpoint = supportPath(supportClass);
  assert.equal((await request(endpoint, null)).status, 401);
  for (const id of [teacher, outsider]) assert.equal((await request(endpoint, id)).status, 404);
  for (const id of [admin, manager, municipal]) assert.equal((await request(endpoint, id)).status, 200);
  assert.throws(() => classSupport(db, { id: outsider, role: 'admin' }, publicSchool(), randomUUID()), e => e.status === 404);
  for (const id of [waiting, archived, otherClass]) assert.equal((await request(supportPath(id))).status, 404);
  for (const key of [...FLAGS, ...SUPPORT_FLAGS]) {
    try { flag(key, 0); assert.equal((await request(endpoint)).status, 404); } finally { flag(key, 1); }
  }
  for (const [id, role] of [[coordinator, 'school_coordinator'], [teacher, 'teacher']]) {
    db.exec('SAVEPOINT support_revocation');
    try {
      db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role=?").run(id, role);
      assert.equal((await request(endpoint)).status, 404);
    } finally { db.exec('ROLLBACK TO support_revocation; RELEASE support_revocation'); }
  }
  for (const q of ['?page=0', '?page=-1', '?page=1.5', '?page=10000', '?page[]=1', '?year=2028', '?student=1']) assert.equal((await request(endpoint + q)).status, 400);
  assert.equal((await request(supportPath(empty))).data.total, 0);
});

test('apoio: paginação de vinte sem omissão silenciosa; auditoria obrigatória e nenhuma alteração pedagógica', async () => {
  const classId = makeClass('Paginação do apoio', school, true, 2028);
  for (let i = 0; i < 21; i++) makeSupport(classId, { execution: false });
  const tables = ['learning_recovery_plans', 'teaching_plans', 'teaching_plan_lessons', 'learning_recovery_monitoring_cycles', 'class_assessment_assignments', 'class_assessment_attempts'];
  const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all());
  const first = (await request(supportPath(classId))).data;
  const second = (await request(supportPath(classId) + '?page=2')).data;
  assert.equal(first.total, 21); assert.equal(first.items.length, 20); assert.equal(second.items.length, 1);
  assert.equal(new Set([...first.items, ...second.items].map(x => x.id)).size, 21);
  assert.equal((await request(supportPath(classId) + '?page=3')).data.items.length, 0);
  const parse = (await import('../../client/src/services/schoolCoordinationSupportView.mjs')).parseCoordinationSupport;
  parse(first, publicSchool(), first.class.id, 1); parse(second, publicSchool(), first.class.id, 2);
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE action='school_coordination_support_read' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(Object.keys(metadata).sort(), ['classId', 'page', 'returned', 'schoolId']);
  db.exec("CREATE TRIGGER reject_support_audit BEFORE INSERT ON activity_log WHEN NEW.action='school_coordination_support_read' BEGIN SELECT RAISE(ABORT,'synthetic support audit failure'); END");
  try { assert.equal((await request(supportPath(classId))).status, 500); } finally { db.exec('DROP TRIGGER reject_support_audit'); }
  assert.deepEqual(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()), before);
});

test('apoio: novos registros são lidos sem cache e bloqueio emergencial prevalece para administradores', async () => {
  const endpoint = supportPath(supportClass);
  db.exec('SAVEPOINT support_latest');
  try {
    db.prepare("UPDATE teaching_plan_lessons SET status='taught' WHERE plan_id=? AND status='planned' AND lesson_phase='intervention'").run(activeSupport.executionId);
    let item = (await request(endpoint)).data.items[0];
    assert.deepEqual(item.execution, { status: 'active', total: 3, taught: 2, skipped: 1, planned: 0 });
    db.prepare("UPDATE teaching_plans SET status='archived',archived_at=CURRENT_TIMESTAMP WHERE id=?").run(activeSupport.executionId);
    item = (await request(endpoint)).data.items[0]; assert.equal(item.execution.status, 'archived');
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher);
    assert.equal((await request(endpoint)).status, 404);
  } finally { db.exec('ROLLBACK TO support_latest; RELEASE support_latest'); }
  db.exec('SAVEPOINT support_kill');
  try {
    db.exec("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético do apoio',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='classes.learning_recovery'");
    assert.equal((await request(endpoint, admin)).status, 404);
  } finally { db.exec('ROLLBACK TO support_kill; RELEASE support_kill'); }
});

const comparisonPath = (classId, plan) => supportPath(classId) + '/' + plan.publicId + '/comparison';
let comparisonClass, pairedSupport;

test('comparação escolar: usa mesmos estudantes por habilidade, questões congeladas e não média global nem snapshot antigo', async () => {
  comparisonClass = makeClass('5º E — Verificação do apoio', school, true, 2028);
  pairedSupport = makeSupport(comparisonClass, { verification: 'closed', baselineCount: 6, corrected: 5, pairStudents: true,
    baselineCorrectIndices: [0, 5], verificationCorrectIndices: [0, 1, 2, 3] });
  // Unrelated, later closed assessment must not replace the linked verification.
  makeAssessment(comparisonClass, 6, 'closed', '2026-09-21 12:00:00');
  const r = await request(comparisonPath(comparisonClass, pairedSupport)); assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.cache, 'no-store'); assert.match(r.vary, /Authorization/);
  assert.deepEqual(r.data.comparison, { status: 'available', methodology: 'matched-students-v2', hasProtectedSkills: false,
    sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: '2026-09-20 12:00:00',
    skills: [{ code: supportSkill.code, description: supportSkill.description, studentCount: 5,
      diagnostic: { questionCount: 2, opportunities: 10, successRate: 20 },
      verification: { questionCount: 1, opportunities: 5, successRate: 80 }, difference: 60 }] });
  assert.doesNotMatch(JSON.stringify(r.data), /PRIVAD|SIGILOSO|student_id|teacher_id|excluded|diagnosticSnapshot|rationale|title|notes|groups|trajectory/);
  (await import('../../client/src/services/schoolCoordinationComparisonView.mjs')).parseSchoolComparison(r.data, publicSchool(), r.data.class.id, pairedSupport.publicId);
  db.exec('SAVEPOINT comparison_bank_change');
  try {
    db.prepare("UPDATE bncc_skills SET description='Descrição atual diferente' WHERE id=?").run(supportSkill.id);
    assert.deepEqual((await request(comparisonPath(comparisonClass, pairedSupport))).data.comparison, r.data.comparison);
  } finally { db.exec('ROLLBACK TO comparison_bank_change; RELEASE comparison_bank_change'); }
});

test('comparação escolar: duas etapas grandes sem estudantes em comum ou com quatro pares ficam protegidas', async () => {
  for (const options of [
    { pairStudents: false, baselineCount: 5, corrected: 5 },
    { pairStudents: true, baselineCount: 4, corrected: 5 },
    { pairStudents: true, baselineCount: 5, corrected: 4 },
    { pairStudents: true, baselineCount: 5, corrected: 0 },
  ]) {
    const plan = makeSupport(comparisonClass, { ...options, verification: 'closed' });
    const r = await request(comparisonPath(comparisonClass, plan)); assert.equal(r.status, 200);
    assert.deepEqual(r.data.comparison, { status: 'protected', sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: '2026-09-20 12:00:00' });
  }
  const plan = makeSupport(comparisonClass, { pairStudents: true, baselineCount: 6, corrected: 6, verification: 'closed' });
  // Five eligible corrections on each side, but only four students in common.
  for (const [id, offset] of [[plan.source, 0], [plan.verificationId, 1]]) {
    db.prepare(`UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP
      WHERE id=(SELECT id FROM class_assessment_participants WHERE assignment_id=? ORDER BY id LIMIT 1 OFFSET ?)`)
      .run(id, offset);
  }
  assert.equal((await request(supportPath(comparisonClass))).data.items.find(x => x.id === plan.publicId).verification.results, 'available');
  assert.equal((await request(comparisonPath(comparisonClass, plan))).data.comparison.status, 'protected');
});

test('comparação escolar: dispensa ou anulação em qualquer etapa reduz o pareamento e esconde dados antigos', async () => {
  for (const assignment of [pairedSupport.source, pairedSupport.verificationId]) {
    for (const mutation of ['exempt', 'void']) {
      db.exec('SAVEPOINT comparison_revoke');
      try {
        const attempt = db.prepare('SELECT id,participant_id FROM class_assessment_attempts WHERE assignment_id=? ORDER BY id LIMIT 1').get(assignment);
        if (mutation === 'exempt') db.prepare("UPDATE class_assessment_participants SET status='exempted',exempted_at=CURRENT_TIMESTAMP WHERE id=?").run(attempt.participant_id);
        else db.prepare("UPDATE class_assessment_attempts SET status='voided',voided_at=CURRENT_TIMESTAMP WHERE id=?").run(attempt.id);
        const c = (await request(comparisonPath(comparisonClass, pairedSupport))).data.comparison;
        assert.equal(c.status, 'protected'); assert.equal('skills' in c, false);
      } finally { db.exec('ROLLBACK TO comparison_revoke; RELEASE comparison_revoke'); }
    }
  }
});

test('comparação escolar: proteção é por habilidade, resposta incompleta não vira zero e não revela tamanho do subgrupo', async () => {
  const id = insert("INSERT INTO bncc_skills(code,description,grade_id,unit_id) SELECT 'EF05MA-SECOND-QA','Habilidade protegida sintética',grade_id,unit_id FROM bncc_skills WHERE id=?", supportSkill.id);
  const extra = db.prepare('SELECT id,code,description FROM bncc_skills WHERE id=?').get(id);
  const plan = makeSupport(comparisonClass, { verification: 'closed', pairStudents: true, skills: [supportSkill, extra] });
  db.exec('SAVEPOINT comparison_incomplete');
  try {
    // Deliberate corruption simulation, isolated and rolled back. Regular fixtures retain all triggers.
    db.exec('DROP TRIGGER class_assessment_responses_validate_delete');
    db.prepare(`DELETE FROM class_assessment_responses WHERE id=(SELECT r.id FROM class_assessment_responses r
      JOIN class_assessment_items i ON i.id=r.assessment_item_id WHERE r.assignment_id=? AND i.skill_code_snapshot=? LIMIT 1)`)
      .run(plan.verificationId, extra.code);
    const c = (await request(comparisonPath(comparisonClass, plan))).data.comparison;
    assert.equal(c.status, 'available'); assert.equal(c.hasProtectedSkills, true); assert.equal(c.skills.length, 1);
    assert.equal(c.skills[0].code, supportSkill.code); assert.equal(c.skills[0].studentCount, 5);
    assert.doesNotMatch(JSON.stringify(c), /Habilidade protegida|SECOND|excluded|cohort|diagnosticSnapshot/);
  } finally { db.exec('ROLLBACK TO comparison_incomplete; RELEASE comparison_incomplete'); }
});

test('comparação escolar: zero real, queda e estabilidade permanecem distintos de ausência de dados', async () => {
  for (const [before, after, blank, expected] of [
    [[], [0, 1, 2, 3, 4], [], [0, 100, 100]],
    [[0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [0, 1, 2, 3, 4], [100, 0, -100]],
    [[0], [0], [], [20, 20, 0]],
  ]) {
    const plan = makeSupport(comparisonClass, { verification: 'closed', pairStudents: true,
      baselineCorrectIndices: before, verificationCorrectIndices: after, verificationBlankIndices: blank });
    const c = (await request(comparisonPath(comparisonClass, plan))).data.comparison;
    assert.equal(c.status, 'available');
    assert.deepEqual([c.skills[0].diagnostic.successRate, c.skills[0].verification.successRate, c.skills[0].difference], expected);
  }
});

test('comparação escolar: verificação ausente, em preparação, agendada, aberta ou cancelada não divulga resultados', async () => {
  for (const state of ['not_created', 'draft', 'scheduled', 'open', 'cancelled']) {
    const plan = makeSupport(comparisonClass, { verification: state, pairStudents: true });
    const r = await request(comparisonPath(comparisonClass, plan)); assert.equal(r.status, 200);
    assert.deepEqual(r.data.comparison, { status: 'awaiting_verification', sourceClosedAt: '2026-09-15 12:00:00', verificationClosedAt: null });
  }
});

test('comparação escolar: escopo, papel atual, rascunhos, flags, filtros e revogação bloqueiam consulta direta', async () => {
  const endpoint = comparisonPath(comparisonClass, pairedSupport);
  assert.equal((await request(endpoint, null)).status, 401);
  for (const id of [teacher, outsider]) assert.equal((await request(endpoint, id)).status, 404);
  for (const id of [admin, manager, municipal]) assert.equal((await request(endpoint, id)).status, 200);
  for (const key of [...FLAGS, ...SUPPORT_FLAGS]) {
    try { flag(key, 0); assert.equal((await request(endpoint)).status, 404); } finally { flag(key, 1); }
  }
  for (const classId of [normal, waiting, archived, otherClass]) assert.equal((await request(comparisonPath(classId, pairedSupport))).status, 404);
  for (const state of ['draft', 'archived']) {
    const plan = makeSupport(comparisonClass, { status: state });
    const r = await request(comparisonPath(comparisonClass, plan));
    assert.equal(r.status, 404); assert.deepEqual(r.data, (await request(comparisonPath(comparisonClass, { publicId: randomUUID() }))).data);
  }
  for (const [id, role] of [[coordinator, 'school_coordinator'], [teacher, 'teacher']]) {
    db.exec('SAVEPOINT comparison_membership');
    try {
      db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role=?").run(id, role);
      assert.equal((await request(endpoint)).status, 404);
    } finally { db.exec('ROLLBACK TO comparison_membership; RELEASE comparison_membership'); }
  }
  db.exec('SAVEPOINT comparison_role_kill');
  try {
    db.prepare("UPDATE users SET role='admin' WHERE id=?").run(teacher);
    assert.equal((await request(endpoint)).status, 404);
    db.exec("UPDATE feature_flags SET kill_switch_active=1,kill_switch_reason='Bloqueio sintético comparação',kill_switch_activated_at=CURRENT_TIMESTAMP WHERE flag_key='institutions.school_coordination'");
    assert.equal((await request(endpoint, admin)).status, 404);
  } finally { db.exec('ROLLBACK TO comparison_role_kill; RELEASE comparison_role_kill'); }
  for (const query of ['?page=1', '?student=1', '?year=2028']) assert.equal((await request(endpoint + query)).status, 400);
});

test('comparação escolar: somente leitura, auditoria mínima obrigatória e nenhuma alteração de resultados', async () => {
  const tables = ['learning_recovery_plans', 'learning_recovery_plan_skills', 'teaching_plans', 'teaching_plan_lessons', 'class_assessment_assignments', 'class_assessment_attempts', 'class_assessment_responses'];
  const before = tables.map(t => db.prepare(`SELECT * FROM ${t}`).all());
  const endpoint = comparisonPath(comparisonClass, pairedSupport);
  assert.equal((await request(endpoint)).status, 200);
  const metadata = JSON.parse(db.prepare("SELECT metadata_json FROM activity_log WHERE action='school_coordination_comparison_read' ORDER BY id DESC LIMIT 1").pluck().get());
  assert.deepEqual(Object.keys(metadata).sort(), ['classId', 'planId', 'resultStatus', 'schoolId']);
  db.exec("CREATE TRIGGER reject_comparison_audit BEFORE INSERT ON activity_log WHEN NEW.action='school_coordination_comparison_read' BEGIN SELECT RAISE(ABORT,'synthetic comparison audit failure'); END");
  try { assert.equal((await request(endpoint)).status, 500); } finally { db.exec('DROP TRIGGER reject_comparison_audit'); }
  assert.deepEqual(tables.map(t => db.prepare(`SELECT * FROM ${t}`).all()), before);
});

test('navegação real opt-in com dados fictícios e base temporária', { skip: process.env.COORDINATION_INTERACTIVE_QA !== '1', timeout: 1260000 }, async () => {
  const build = path.resolve(__dirname, '../../tmp/school-coordination-build'); assert.ok(fs.existsSync(path.join(build, 'index.html')));
  assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/); assert.match(db.name, /labmathic-school-coordination-/);
  const config = require('../src/config'); config.smtp.user = ''; config.smtp.pass = ''; config.appEnvironment = 'development';
  const password = await require('bcryptjs').hash('Visual-QA-Only-2026!', 10); db.prepare('UPDATE users SET password=?').run(password);
  makeAssessment(normal, 5, 'closed', '2026-09-19 12:00:00', skillDefinitions);
  insert("INSERT INTO materials(title,description,created_by) VALUES ('Frações — ensaio de revisão','Material sintético para repetir o relato de problema.',?)", admin);
  for (const route of ['auth', 'governance', 'classes', 'notifications', 'announcements', 'categories', 'materials', 'favorites', 'ratings', 'comments', 'support', 'reports']) app.use('/api/' + route, require('../src/routes/' + route));
  app.use('/api/institutions/read-model', require('../src/routes/institutionalReadModel'));
  app.use('/api/content-issues', require('../src/routes/contentIssues')); flag('content.issue_review', 1);
  app.use('/api/pedagogical-cycle', require('../src/routes/pedagogicalCycle')); flag('pedagogy.operational_cycle', 1);
  app.use('/api/question-bank', require('../src/routes/questionBank'));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'API não disponível neste ensaio.' }));
  let finish; const done = new Promise(resolve => { finish = resolve; });
  app.get('/__qa', (_req, res) => res.send('<h1>Conferência sintética isolada</h1><form method="post" action="/__qa/revoke"><button>Revogar coordenação fictícia</button></form><form method="post" action="/__qa/restore"><button>Restaurar coordenação fictícia</button></form><form method="post" action="/__qa/finish"><button>Encerrar conferência local</button></form>'));
  app.post('/__qa/revoke', (_req, res) => {
    db.prepare("UPDATE institutional_memberships SET status='inactive',ended_at=CURRENT_TIMESTAMP WHERE user_id=? AND role='school_coordinator'").run(coordinator);
    res.redirect('/__qa');
  });
  app.post('/__qa/restore', (_req, res) => {
    db.prepare("UPDATE institutional_memberships SET status='active',ended_at=NULL WHERE user_id=? AND role='school_coordinator'").run(coordinator);
    res.redirect('/__qa');
  });
  app.post('/__qa/finish', (_req, res) => { res.send('Conferência encerrada.'); setTimeout(finish, 100); });
  app.use(express.static(build)); app.get('*', (_req, res) => res.sendFile(path.join(build, 'index.html')));
  console.log('COORDINATION_QA_READY', JSON.stringify({ baseUrl: base, coordinator: 'coordenacao.qa@example.invalid', teacher: 'docente.coord.qa@example.invalid', schoolId: publicSchool() }));
  const timer = setTimeout(finish, 1200000); try { await done; } finally { clearTimeout(timer); }
});
