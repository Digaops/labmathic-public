// Opt-in inspection, reusing only the synthetic learning-recovery API fixture.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const { chromium, expect } = createRequire(path.join(root, 'client/package.json'))('@playwright/test');

async function runScreenLayoutAudit({ app, db, baseUrl, teacher, admin, classPublicId, assessmentPublicId }) {
  assert.equal(process.env.SCREEN_LAYOUT_AUDIT, '1');
  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.match(db.name, /labmathic-recovery-preview-api-[^/\\]+[/\\]database\.sqlite$/);
  const config = require('../../src/config');
  assert.equal(path.dirname(config.uploadDir), path.dirname(db.name));
  // Affects only this ephemeral process; never invokes the production entrypoint.
  config.appEnvironment = 'homologation';
  config.smtp.user = ''; config.smtp.pass = '';
  config.classEntryCodeSecret = crypto.randomBytes(32).toString('hex');
  config.studentAssessmentAccessSecret = crypto.randomBytes(32).toString('hex');
  const express = require('express');
  for (const route of ['auth', 'users', 'materials', 'categories', 'favorites', 'collections', 'ratings', 'comments',
    'share', 'notifications', 'reports', 'activity', 'support', 'announcements', 'governance', 'classes']) {
    app.use(`/api/${route}`, require(`../../src/routes/${route}`));
  }
  for (const [url, module] of [
    ['institutions/read-model', 'institutionalReadModel'], ['institutions/management', 'institutionalManagement'],
    ['content-issues', 'contentIssues'], ['school-coordination', 'schoolCoordination'],
    ['municipal-indicators', 'municipalIndicators'], ['question-bank/numeric-drafts', 'numericQuestionDrafts'],
    ['question-bank', 'diagnostics'], ['question-bank', 'questionBank'], ['question-bank/typed-authoring', 'typedQuestionAuthoring'],
    ['question-bank/typed-preview', 'typedQuestionPreview'], ['question-bank/feedback-preview', 'typedQuestionFeedbackPreview'],
    ['question-bank/catalog-preview', 'questionBankCatalogPreview'], ['classes', 'classAssessmentStudentAccess'],
    ['student-assessments', 'studentAssessmentPortal'], ['lesson-plans', 'lessonPlanner'],
  ]) app.use(`/api/${url}`, require(`../../src/routes/${module}`));
  app.use('/uploads', require('../../src/middleware/protectedUploads'));
  app.use('/api', (_req, res) => res.sendStatus(404));
  const teacherHomeOnly = process.env.TEACHER_HOME_BROWSER === '1';
  const libraryOnly = process.env.LIBRARY_BROWSER === '1';
  const materialOnly = process.env.MATERIAL_BROWSER === '1';
  const favoritesOnly = process.env.FAVORITES_BROWSER === '1';
  const questionSetsOnly = process.env.QUESTION_SETS_BROWSER === '1';
  const demoLayoutOnly = process.env.DEMO_LAYOUT_BROWSER === '1';
  const auxiliaryOnly = process.env.AUXILIARY_BROWSER === '1';
  const institutionalFormsOnly = process.env.INSTITUTIONAL_FORMS_BROWSER === '1';
  const institutionalNetworkOnly = process.env.INSTITUTIONAL_NETWORK_BROWSER === '1';
  const adminInsightsOnly = process.env.ADMIN_INSIGHTS_BROWSER === '1';
  const adminUsersOnly = process.env.ADMIN_USERS_BROWSER === '1';
  const adminCategoriesOnly = process.env.ADMIN_CATEGORIES_BROWSER === '1';
  const materialFormOnly = process.env.MATERIAL_FORM_BROWSER === '1';
  const adminMaterialsOnly = process.env.ADMIN_MATERIALS_BROWSER === '1';
  const adminHomeOnly = process.env.ADMIN_HOME_BROWSER === '1';
  const adminDashboardOnly = process.env.ADMIN_DASHBOARD_BROWSER === '1';
  const publicAccessOnly = process.env.PUBLIC_ACCESS_BROWSER === '1';
  const accountLayoutOnly = process.env.ACCOUNT_LAYOUT_BROWSER === '1';
  const plannerLayoutOnly = process.env.PLANNER_LAYOUT_BROWSER === '1';
  const executionLayoutOnly = process.env.EXECUTION_LAYOUT_BROWSER === '1';
  const recoveryLayoutOnly = process.env.RECOVERY_LAYOUT_BROWSER === '1';
  const cycleLayoutOnly = process.env.CYCLE_LAYOUT_BROWSER === '1';
  const authoringOnly = process.env.AUTHORING_BROWSER === '1';
  const questionBankOnly = process.env.QUESTION_BANK_BROWSER === '1';
  const studentAccessOnly = process.env.STUDENT_ACCESS_BROWSER === '1';
  const assessmentsOnly = process.env.ASSESSMENTS_BROWSER === '1';
  const classesOnly = process.env.CLASSES_BROWSER === '1';
  const collectionsOnly = process.env.COLLECTIONS_BROWSER === '1';
  assert.ok([institutionalFormsOnly, institutionalNetworkOnly, adminInsightsOnly, adminUsersOnly, adminCategoriesOnly, materialFormOnly, adminMaterialsOnly, adminHomeOnly, adminDashboardOnly, auxiliaryOnly, publicAccessOnly, accountLayoutOnly, demoLayoutOnly, plannerLayoutOnly, executionLayoutOnly, recoveryLayoutOnly, cycleLayoutOnly, teacherHomeOnly, libraryOnly, materialOnly, favoritesOnly, collectionsOnly, classesOnly, assessmentsOnly, studentAccessOnly, questionBankOnly, authoringOnly, questionSetsOnly].filter(Boolean).length <= 1, 'Choose one focused browser QA');
  const build = path.join(root, institutionalFormsOnly ? 'tmp/institutional-forms-build' : institutionalNetworkOnly ? 'tmp/institutional-network-build' : adminInsightsOnly ? 'tmp/admin-insights-build' : adminUsersOnly ? 'tmp/admin-users-build' : adminCategoriesOnly ? 'tmp/admin-categories-build' : materialFormOnly ? 'tmp/material-form-build' : adminMaterialsOnly ? 'tmp/admin-materials-build' : adminHomeOnly ? 'tmp/admin-home-build' : adminDashboardOnly ? 'tmp/admin-dashboard-build' : auxiliaryOnly ? 'tmp/auxiliary-build' : publicAccessOnly ? 'tmp/public-access-build' : accountLayoutOnly ? 'tmp/account-layout-build' : demoLayoutOnly ? 'tmp/demo-layout-build' : plannerLayoutOnly ? 'tmp/planner-layout-build' : executionLayoutOnly ? 'tmp/execution-layout-build' : recoveryLayoutOnly ? 'tmp/recovery-layout-build' : cycleLayoutOnly ? 'tmp/cycle-layout-build' : questionSetsOnly ? 'tmp/question-sets-build' : authoringOnly ? 'tmp/authoring-build' : questionBankOnly ? 'tmp/question-bank-build' : studentAccessOnly ? 'tmp/student-assessment-build' : assessmentsOnly ? 'tmp/assessments-build' : classesOnly ? 'tmp/classes-build' : collectionsOnly ? 'tmp/collections-build' : favoritesOnly ? 'tmp/favorites-build' : materialOnly ? 'tmp/material-build' : libraryOnly ? 'tmp/library-build' : teacherHomeOnly ? 'tmp/teacher-home-build' : 'tmp/screen-layout-build');
const journeyBuild = process.env.PLATFORM_JOURNEY_AUDIT === '1' ? path.join(root, process.env.EXEMPTIONS_AUDIT === '1' ? 'tmp/exemptions-build' : process.env.ASSESSMENT_ROSTER_AUDIT === '1' ? 'tmp/assessment-roster-build' : process.env.RECOVERY_PARTICIPANTS_AUDIT === '1' ? 'tmp/recovery-participants-build' : process.env.RECOVERY_LANGUAGE_AUDIT === '1' ? 'tmp/recovery-language-build' : process.env.ACCESSIBILITY_DATES_AUDIT === '1' ? 'tmp/accessibility-dates-build' : process.env.MATERIAL_BNCC_AUDIT === '1' ? 'tmp/material-bncc-build' : process.env.MATERIAL_PUBLICATION_AUDIT === '1' ? 'tmp/material-publication-build' : process.env.MATERIAL_FORMATS_AUDIT === '1' ? 'tmp/material-formats-build' : process.env.TEACHER_ACCESS_AUDIT === '1' ? 'tmp/teacher-access-build' : process.env.BANK_ACCESS_AUDIT === '1' ? 'tmp/bank-access-build' : process.env.RECOVERY_QUESTIONS_AUDIT === '1' ? 'tmp/recovery-questions-build' : process.env.RECOVERY_COMPARISON_AUDIT === '1' ? 'tmp/recovery-comparison-build' : 'tmp/platform-journey-build') : build;
  assert.ok(fs.existsSync(path.join(journeyBuild, 'index.html')), 'Build the isolated frontend first');
  app.use(express.static(journeyBuild));
  app.get('*', (_req, res) => res.sendFile(path.join(journeyBuild, 'index.html')));
  app.use(require('../../src/middleware/apiErrors'));
  const internalOnly = process.env.SCREEN_LAYOUT_INTERNAL_ONLY === '1';
  const output = path.join(root, process.env.EXEMPTIONS_AUDIT === '1' ? 'tmp/exemptions-bootstrap' : process.env.ASSESSMENT_ROSTER_AUDIT === '1' ? 'tmp/assessment-roster-bootstrap' : process.env.RECOVERY_PARTICIPANTS_AUDIT === '1' ? 'tmp/recovery-participants-bootstrap' : process.env.RECOVERY_LANGUAGE_AUDIT === '1' ? 'tmp/recovery-language-bootstrap' : process.env.ACCESSIBILITY_DATES_AUDIT === '1' ? 'tmp/accessibility-dates-bootstrap' : process.env.MATERIAL_BNCC_AUDIT === '1' ? 'tmp/material-bncc-bootstrap' : process.env.MATERIAL_PUBLICATION_AUDIT === '1' ? 'tmp/material-publication-bootstrap' : process.env.MATERIAL_FORMATS_AUDIT === '1' ? 'tmp/material-formats-bootstrap' : process.env.TEACHER_ACCESS_AUDIT === '1' ? 'tmp/teacher-access-bootstrap' : process.env.BANK_ACCESS_AUDIT === '1' ? 'tmp/bank-access-bootstrap' : process.env.RECOVERY_QUESTIONS_AUDIT === '1' ? 'tmp/recovery-questions-bootstrap' : process.env.RECOVERY_COMPARISON_AUDIT === '1' ? 'tmp/recovery-comparison-bootstrap' : process.env.PLATFORM_JOURNEY_AUDIT === '1' ? 'tmp/platform-journey-bootstrap' : institutionalFormsOnly ? 'tmp/institutional-forms-qa' : institutionalNetworkOnly ? 'tmp/institutional-network-qa' : adminInsightsOnly ? 'tmp/admin-insights-qa' : adminUsersOnly ? 'tmp/admin-users-qa' : adminCategoriesOnly ? 'tmp/admin-categories-qa' : materialFormOnly ? 'tmp/material-form-qa' : adminMaterialsOnly ? 'tmp/admin-materials-qa' : adminHomeOnly ? 'tmp/admin-home-qa' : adminDashboardOnly ? 'tmp/admin-dashboard-qa' : auxiliaryOnly ? 'tmp/auxiliary-qa' : publicAccessOnly ? 'tmp/public-access-qa' : accountLayoutOnly ? 'tmp/account-layout-qa' : demoLayoutOnly ? 'tmp/demo-layout-qa' : plannerLayoutOnly ? 'tmp/planner-layout-qa' : executionLayoutOnly ? 'tmp/execution-layout-qa' : recoveryLayoutOnly ? 'tmp/recovery-layout-qa' : cycleLayoutOnly ? 'tmp/cycle-layout-qa' : questionSetsOnly ? 'tmp/question-sets-qa' : authoringOnly ? 'tmp/authoring-qa' : questionBankOnly ? 'tmp/question-bank-qa' : studentAccessOnly ? 'tmp/student-access-qa' : assessmentsOnly ? 'tmp/assessments-qa' : classesOnly ? 'tmp/classes-qa' : collectionsOnly ? 'tmp/collections-qa' : favoritesOnly ? 'tmp/favorites-qa' : materialOnly ? 'tmp/material-qa' : libraryOnly ? 'tmp/library-qa' : teacherHomeOnly ? 'tmp/teacher-home-qa' : internalOnly ? 'tmp/screen-layout-internal-audit' : 'tmp/screen-layout-audit'); fs.mkdirSync(output, { recursive: true });
  const report = { status: 'running', syntheticDataOnly: true, cases: [], internal: [], pageErrors: [], httpErrors: [] };
  const record = () => fs.writeFileSync(path.join(output, (institutionalFormsOnly || institutionalNetworkOnly || adminInsightsOnly || adminUsersOnly || adminCategoriesOnly || auxiliaryOnly || adminDashboardOnly || adminHomeOnly || adminMaterialsOnly || materialFormOnly) ? 'bootstrap-report.json' : 'report.json'), JSON.stringify(report, null, 2)); record();
  const { issueUserToken } = require('../../src/services/authSessions');
  const tokenFor = user => issueUserToken(user.id);
  let operation = 0;
  async function api(url, user = teacher, body, method = body ? 'POST' : 'GET') {
    const response = await fetch(`${baseUrl}/api${url}`, { method,
      headers: { Authorization: `Bearer ${tokenFor(user)}`, 'Content-Type': 'application/json', 'Idempotency-Key': `screen-layout-audit-fixture-${++operation}` },
      body: body ? JSON.stringify(body) : undefined });
    const value = await response.json(); assert.ok(response.ok, `${url}: ${JSON.stringify(value)}`); return value;
  }
  function enable(user, operational = true) {
    db.prepare('UPDATE feature_flags SET master_enabled = 1').run();
    for (const flag of db.prepare('SELECT id, flag_key FROM feature_flags').all()) {
      db.prepare(`INSERT OR REPLACE INTO feature_flag_user_rules (feature_flag_id,user_id,enabled,reason,created_by,updated_by)
        VALUES (?,?,?,'Inspeção sintética de telas',?,?)`).run(flag.id, user.id, Number((operational || flag.flag_key !== 'pedagogy.operational_cycle') && (flag.flag_key !== 'materials.bncc_curation' || process.env.MATERIAL_BNCC_AUDIT === '1') && (flag.flag_key !== 'materials.draft_publication' || process.env.MATERIAL_PUBLICATION_AUDIT === '1')), admin.id, admin.id);
    }
  }
  function account(name) {
    const id = Number(db.prepare("INSERT INTO users (name,email,password,role) VALUES (?,?,'hash-sintetico','professor')")
      .run(name, `${crypto.randomUUID()}@audit.invalid`).lastInsertRowid);
    return { id, name, email: db.prepare('SELECT email FROM users WHERE id=?').pluck().get(id), role: 'professor' };
  }
  const previewUser = account('Docente de demonstração'); const manager = account('Gestora da rede de teste');
  for (const user of [teacher, admin, manager]) enable(user);
  enable(previewUser, false);
  const mun = (await api('/institutions/management/municipalities', admin, { name: 'Município de teste' })).municipality;
  const school = (await api(`/institutions/management/municipalities/${mun.publicId}/schools`, admin, { name: 'Escola Municipal de Teste' })).school;
  await api('/institutions/management/memberships', admin, { userId: teacher.id, role: 'teacher', municipalityPublicId: mun.publicId, schoolPublicId: school.publicId });
  await api('/institutions/management/memberships', admin, { userId: manager.id, role: 'municipal_manager', municipalityPublicId: mun.publicId });
  const grade = db.prepare("SELECT id FROM grades WHERE name='7º Ano - EF'").pluck().get();
  const discipline = db.prepare('SELECT id FROM disciplines LIMIT 1').pluck().get();
  const classGrade = db.prepare('SELECT grade_id FROM school_classes WHERE public_id=?').pluck().get(classPublicId);
  const skill = db.prepare('SELECT id FROM bncc_skills WHERE grade_id=? LIMIT 1').pluck().get(classGrade)
    || Number(db.prepare("INSERT INTO bncc_skills(code,description,grade_id,unit_id) VALUES ('EF01MA01-AUDIT','Comparar números em situações do dia a dia.',?,?)")
      .run(classGrade, db.prepare('SELECT id FROM bncc_units LIMIT 1').pluck().get()).lastInsertRowid);
  const questionSetId = db.prepare('SELECT id FROM question_sets WHERE user_id=? ORDER BY id LIMIT 1').pluck().get(teacher.id);
  // A minimal, valid, one-page PDF; created only inside this fixture's uploads.
  const stream = 'BT /F1 20 Tf 40 750 Td (Atividades de matematica - teste sintetico) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>', `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`];
  let pdf = '%PDF-1.4\n'; const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(pdf)); pdf += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(pdf); pdf += `xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  fs.writeFileSync(path.join(config.uploadDir, 'layout-fixture.pdf'), pdf);
  const materialType = Number(db.prepare("INSERT INTO material_types(name,icon) VALUES ('PDF de teste','pdf')").run().lastInsertRowid);
  const materialId = Number(db.prepare(`INSERT INTO materials(title,description,discipline_id,grade_id,file_path,file_format,material_type_id,created_by)
    VALUES ('Problemas para conversar em sala','Material sintético para inspeção de interface.',?,?,'layout-fixture.pdf','PDF',?,?)`).run(discipline, grade, materialType, admin.id).lastInsertRowid);
  db.prepare('INSERT INTO favorites(user_id,material_id) VALUES (?,?)').run(teacher.id, materialId);
  const collectionId = Number(db.prepare("INSERT INTO collections(user_id,name,description,is_public) VALUES (?,'Números e estratégias','Materiais para planejar a aula.',1)").run(admin.id).lastInsertRowid);
  db.prepare('INSERT INTO collection_items(collection_id,material_id) VALUES (?,?)').run(collectionId, materialId);
  const share = await api('/share', admin, { material_id: materialId, expires_hours: 1 });
  const plan = (await api('/lesson-plans', teacher, { title: 'Semana de resolução de problemas', classPublicId, disciplineId: discipline,
    periodType: 'week', startsOn: '2026-09-14', endsOn: '2026-09-18', lessons: [{ title: 'Comparar estratégias',
      objective: 'Resolver problemas e conversar sobre diferentes estratégias.', plannedDate: '2026-09-14', durationMinutes: 50,
      skillIds: [skill], resources: [{ type: 'material', id: materialId }] }] })).plan;
  const threadId = Number(db.prepare("INSERT INTO support_threads(professor_id,subject) VALUES (?,'Ajuda no planejamento')").run(teacher.id).lastInsertRowid);
  db.prepare("INSERT INTO support_messages(thread_id,sender_id,body) VALUES (?,?,'Como posso retomar a avaliação desta turma?')").run(threadId, teacher.id);
  const cycle = `/banco-questoes/devolutivas?turma=${classPublicId}&avaliacao=${assessmentPublicId}`;
  const classes = `/turmas?turma=${classPublicId}`;
  const cases = [
    ['login', '/login', null, 'Login'], ['forgot', '/esqueci-senha', null, 'ForgotPassword'],
    ['reset', '/resetar-senha/' + 'a'.repeat(64), null, 'ResetPassword'],
    ['shared', '/compartilhado/' + share.token, null, 'SharedMaterial'],
    ['shared-invalid', '/compartilhado/' + 'b'.repeat(64), null, 'SharedMaterial'],
    ['privacy', '/privacidade', null, 'PrivacyPolicy'], ['terms', '/termos-de-uso', null, 'TermsOfUse'],
    ['join-class', '/entrar-na-turma', null, 'JoinClass'], ['student-entry', '/responder', null, 'StudentAssessment'],
    ['not-found', '/pagina-inexistente-qa', null, 'NotFound'],
    ['home', '/', teacher, 'Dashboard'], ['library', '/biblioteca', teacher, 'Library'],
    ['material', `/material/${materialId}`, teacher, 'MaterialView'], ['profile', '/perfil', teacher, 'Profile'],
    ['favorites', '/favoritos', teacher, 'Favorites'], ['collections', '/colecoes', teacher, 'Collections'],
    ['collection', `/colecoes/${collectionId}`, teacher, 'CollectionView'], ['questions', '/banco-questoes', teacher, 'QuestionBank'],
    ['formats-preview', '/banco-questoes/formatos', previewUser, 'TypedQuestionLab'],
    ['feedback-preview', '/exemplos/devolutivas', previewUser, 'TypedQuestionFeedbackLab'],
    ['catalog-preview', '/exemplos/banco-questoes', previewUser, 'QuestionBankCatalogLab'],
    ['formats-explicit', '/exemplos/formatos', previewUser, 'TypedQuestionLab'],
    ['cycle-not-released', cycle, previewUser, 'OperationalBankAccess'],
    ['bank-operational', '/banco-questoes/revisao?turma=' + classPublicId, teacher, 'QuestionBank'],
    ['cycle-picker', '/banco-questoes/devolutivas', teacher, 'PedagogicalCycle'], ['cycle-detail', cycle, teacher, 'PedagogicalCycle'],
    ['question-sets', '/simulados', teacher, 'QuestionSets'], ['question-set', `/simulados/${questionSetId}`, teacher, 'QuestionSetView'],
    ['support-teacher', '/fale-conosco', teacher, 'SupportChat'], ['classes', classes, teacher, 'Classes'],
    ['content-issues', '/problemas-no-acervo', teacher, 'ContentIssues'],
    ['school-coordination', '/acompanhamento-escolar', manager, 'SchoolCoordination'],
    ['network-portrait', '/retrato-da-rede', teacher, 'NetworkPortrait'],
    ['recovery', '/recomposicao', teacher, 'LearningRecoveryPlans'], ['lesson-plans', '/planejamento', teacher, 'LessonPlans'],
    ['lesson-new', '/planejamento/novo', teacher, 'LessonPlanEditor'], ['lesson-edit', `/planejamento/${plan.publicId}`, teacher, 'LessonPlanEditor'],
    ['institutions-teacher', '/instituicoes', teacher, 'InstitutionalContext'], ['institutions-manager', '/instituicoes', manager, 'InstitutionalContext'],
    ['institutions-admin', '/instituicoes', admin, 'InstitutionalContext'], ['home-admin', '/', admin, 'Dashboard'],
    ['admin', '/admin', admin, 'admin/AdminDashboard'], ['admin-materials', '/admin/materiais', admin, 'admin/AdminMaterials'],
    ['numeric-reviews', '/admin/questoes-numericas/revisoes', admin, 'admin/NumericReviews'],
    ['admin-material-new', '/admin/materiais/novo', admin, 'admin/MaterialForm'], ['admin-material-edit', `/admin/materiais/${materialId}/editar`, admin, 'admin/MaterialForm'],
    ['admin-drafts', '/admin/materiais/rascunhos', admin, 'admin/MaterialDrafts'], ['admin-draft-new', '/admin/materiais/rascunhos/novo', admin, 'admin/MaterialForm'],
    ['admin-material-curation', `/admin/materiais/${materialId}/habilidades`, admin, 'admin/MaterialCuration'],
    ['admin-draft-review', '/admin/materiais/rascunhos/1', admin, 'admin/MaterialDraftReview'], ['admin-draft-edit', '/admin/materiais/rascunhos/1/editar', admin, 'admin/MaterialForm'],
    ['admin-categories', '/admin/categorias', admin, 'admin/AdminCategories'], ['admin-users', '/admin/usuarios', admin, 'admin/AdminUsers'],
    ['admin-reports', '/admin/relatorios', admin, 'admin/AdminReports'], ['admin-activity', '/admin/atividades', admin, 'admin/AdminActivityLog'],
    ['support-admin', '/fale-conosco', admin, 'SupportChat'], ['questions-admin', '/banco-questoes', admin, 'QuestionBank'],
  ];
  report.inventory = cases.map(([id, url, user, component]) => ({ id, url, role: user?.role || 'public', component })); record();
  const appSource = fs.readFileSync(path.join(root, 'client/src/App.jsx'), 'utf8');
  const routeTemplates = [...new Set([...appSource.matchAll(/<Route\s+path="([^"]+)"/g)].map(match => match[1].startsWith('/') || match[1] === '*' ? match[1] : '/' + match[1]))];
  report.routeCoverage = routeTemplates.map(template => ({ template, covered: template === '*' || cases.some(([, url]) => new RegExp('^' + template.replace(/:[^/]+/g, '[^/]+') + '$').test(url.split('?')[0])) }));
  assert.deepEqual(report.routeCoverage.filter(item => !item.covered), [], 'Every declared route needs an audit case'); record();
  if (process.env.PLATFORM_JOURNEY_AUDIT === '1') return require('./platformJourneyAudit.cjs').holdIsolatedFixture({ baseUrl, db, teacher, admin, manager, previewUser, tokenFor, report, materialId, collectionId, classPublicId, assessmentPublicId, questionSetId, plan, share });
  if (demoLayoutOnly) return require('./demoLayoutBrowser.cjs').runDemoLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, db, output });
  if (institutionalFormsOnly) return require('./institutionalFormsBrowser.cjs').runInstitutionalFormsBrowser({ baseUrl, teacher, admin, tokenFor, db, output, mun, school });
  if (institutionalNetworkOnly) return require('./institutionalNetworkBrowser.cjs').runInstitutionalNetworkBrowser({ baseUrl, teacher, admin, manager, tokenFor, db, output, mun, school });
  if (adminInsightsOnly) return require('./adminInsightsBrowser.cjs').runAdminInsightsBrowser({ baseUrl, teacher, admin, tokenFor, materialId, questionSetId, db, output });
  if (adminUsersOnly) return require('./adminUsersBrowser.cjs').runAdminUsersBrowser({ baseUrl, teacher, admin, tokenFor, db, output });
  if (adminCategoriesOnly) return require('./adminCategoriesBrowser.cjs').runAdminCategoriesBrowser({ baseUrl, teacher, admin, tokenFor, db, output });
  if (materialFormOnly) return require('./materialFormBrowser.cjs').runMaterialFormBrowser({ baseUrl, teacher, admin, tokenFor, materialId, db, output });
  if (adminMaterialsOnly) return require('./adminMaterialsBrowser.cjs').runAdminMaterialsBrowser({ baseUrl, teacher, admin, tokenFor, materialId, db, output });
  if (adminHomeOnly) return require('./adminHomeBrowser.cjs').runAdminHomeBrowser({ baseUrl, teacher, admin, tokenFor, materialId, questionSetId, db, output });
  if (adminDashboardOnly) return require('./adminDashboardBrowser.cjs').runAdminDashboardBrowser({ baseUrl, teacher, admin, tokenFor, materialId, questionSetId, db, output });
  if (auxiliaryOnly) return require('./auxiliaryBrowser.cjs').runAuxiliaryBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, materialId, db, output });
  if (publicAccessOnly) return require('./publicAccessBrowser.cjs').runPublicAccessBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, materialId, share, db, output });
  if (accountLayoutOnly) return require('./accountLayoutBrowser.cjs').runAccountLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, db, output });
  if (plannerLayoutOnly) return require('./plannerLayoutBrowser.cjs').runPlannerLayoutBrowser({ baseUrl, teacher, admin, tokenFor, classPublicId, plan, materialId, skill, db, output });
  if (executionLayoutOnly) return require('./executionLayoutBrowser.cjs').runExecutionLayoutBrowser({ baseUrl, teacher, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (recoveryLayoutOnly) return require('./recoveryLayoutBrowser.cjs').runRecoveryLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (cycleLayoutOnly) return require('./cycleLayoutBrowser.cjs').runCycleLayoutBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (questionSetsOnly) return require('./questionSetsBrowser.cjs').runQuestionSetsBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, questionSetId, db, output });
  if (authoringOnly) return require('./authoringBrowser.cjs').runAuthoringBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, db, output });
  if (questionBankOnly) return require('./questionBankBrowser.cjs').runQuestionBankBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, db, output });
  if (studentAccessOnly) return require('./studentAccessBrowser.cjs').runStudentAccessBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (assessmentsOnly) return require('./assessmentsBrowser.cjs').runAssessmentsBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (classesOnly) return require('./classesBrowser.cjs').runClassesBrowser({ baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, assessmentPublicId, db, output });
  if (teacherHomeOnly) return require('./teacherHomeBrowser.cjs').runTeacherHomeBrowser({
    baseUrl, teacher, admin, previewUser, tokenFor, classPublicId, plan, materialId, db, output,
  });
  if (libraryOnly) return require('./libraryBrowser.cjs').runLibraryBrowser({
    baseUrl, teacher, admin, previewUser, tokenFor, materialId, db, output,
  });
  if (materialOnly) return require('./materialBrowser.cjs').runMaterialBrowser({
    baseUrl, teacher, admin, previewUser, tokenFor, materialId, collectionId, db, output,
  });
  if (favoritesOnly) return require('./favoritesBrowser.cjs').runFavoritesBrowser({
    baseUrl, teacher, admin, previewUser, tokenFor, materialId, db, output,
  });
  if (collectionsOnly) return require('./collectionsBrowser.cjs').runCollectionsBrowser({
    baseUrl, teacher, admin, previewUser, tokenFor, materialId, collectionId, db, output,
  });
  const browser = await chromium.launch({ headless: true });
  async function context(user, viewport, theme = 'dark') {
    const ctx = await browser.newContext({ viewport, colorScheme: theme, ...(viewport.width < 600 ? { isMobile: true, hasTouch: true } : {}) });
    await ctx.route('**/*', route => route.request().url().startsWith(baseUrl + '/') ? route.continue() : route.abort());
    await ctx.addInitScript(({ origin, user, token, theme }) => {
      if (location.origin !== origin) return;
      localStorage.setItem('theme', theme);
      if (user) sessionStorage.setItem('labmathic_auth_session_v1', JSON.stringify({ user, token }));
    }, { origin: baseUrl, user, token: user ? tokenFor(user) : null, theme });
    ctx.on('page', page => {
      page.on('pageerror', error => report.pageErrors.push({ url: page.url(), message: error.message }));
      page.on('response', response => { if (response.status() >= 400 && response.url().startsWith(baseUrl + '/api/')) report.httpErrors.push({ page: page.url(), url: response.url(), status: response.status() }); });
    });
    return ctx;
  }
  async function ready(page, url) {
    await page.goto(baseUrl + url); await page.waitForLoadState('networkidle');
    const notice = page.getByRole('button', { name: 'Entendi, continuar', exact: true });
    if (await notice.isVisible()) await notice.click();
    await page.waitForTimeout(350);
  }
  async function capture(page, id, internal = false) {
    // Let CSS transitions settle; initial animation frames are not layout evidence.
    await page.waitForTimeout(350);
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollX, scrollY,
      scrollWidth: document.documentElement.scrollWidth, scrollHeight: document.documentElement.scrollHeight,
      headings: [...document.querySelectorAll('h1,h2')].filter(e => e.getBoundingClientRect().height).map(e => ({ text: e.textContent.trim(), top: Math.round(e.getBoundingClientRect().top) })),
      controls: [...document.querySelectorAll('main button,main a,main input,main select,[role="dialog"] button')]
        .filter(e => e.getBoundingClientRect().height).map(e => ({ text: e.getAttribute('aria-label') || e.textContent.trim() || e.placeholder || e.name,
          top: Math.round(e.getBoundingClientRect().top), height: Math.round(e.getBoundingClientRect().height), width: Math.round(e.getBoundingClientRect().width) })).slice(0, 90),
    }));
    await page.screenshot({ path: path.join(output, id + '.png'), scale: 'css' });
    fs.writeFileSync(path.join(output, id + '.txt'), await page.locator('body').innerText());
    (internal ? report.internal : report.cases).push({ id, url: page.url(), ...metrics }); record();
  }
  try {
    for (const [id, url, user] of internalOnly ? [] : cases) {
      for (const viewport of [{ width: 1024, height: 600 }, { width: 390, height: 664 }]) {
        const ctx = await context(user, viewport); const page = await ctx.newPage();
        await ready(page, url); await capture(page, `${id}-${viewport.width}`); await ctx.close();
      }
      console.log('Inspecionado:', id);
    }
    for (const id of internalOnly ? [] : ['home', 'library', 'questions', 'classes', 'lesson-edit', 'cycle-detail', 'admin-users']) {
      const [, url, user] = cases.find(item => item[0] === id);
      const ctx = await context(user, { width: 390, height: 664 }, 'light'); const page = await ctx.newPage();
      await ready(page, url); await capture(page, `${id}-light`); await ctx.close();
    }
    if (process.env.SCREEN_LAYOUT_ROUTES_ONLY === '1') {
      assert.deepEqual(report.pageErrors, []);
      assert.deepEqual(report.cases.filter(item => item.scrollWidth > item.width + 1), [], 'Every route must fit its viewport');
      report.status = 'captured'; record(); return report;
    }
    // Audit error presentation without accepting a failed query as an empty dataset.
    const ctx = await context(teacher, { width: 390, height: 664 }); const page = await ctx.newPage();
    await page.route('**/api/favorites?*', route => route.fulfill({ status: 503, json: { error: 'Consulta de teste indisponível.' } }));
    await ready(page, '/favoritos'); await capture(page, 'favorites-query-error', true);
    await ready(page, '/admin/usuarios'); await expect(page).toHaveURL(baseUrl + '/');
    report.teacherAdminDenied = true;
    await ready(page, '/banco-questoes');
    await page.getByRole('button', { name: 'Gerar diagnóstico', exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible(); await capture(page, 'diagnostic-dialog', true);
    await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
    await page.getByRole('button', { name: 'Criar questão autoral', exact: true }).click();
    await page.waitForTimeout(350); await capture(page, 'author-question-form', true);
    await page.keyboard.press('Escape');
    await ready(page, cycle);
    await page.getByRole('button', { name: 'Meu registro', exact: true }).click();
    await page.getByRole('heading', { name: 'Meu registro sobre a turma', exact: true }).scrollIntoViewIfNeeded();
    await capture(page, 'cycle-feedback-form', true);
    if (internalOnly) {
      // Read-only opening and closing: no form submission, removal or publication.
      const dialogCapture = async (name) => {
        await expect(page.getByRole('dialog').last()).toBeVisible(); await page.waitForTimeout(400);
        await capture(page, name, true); await page.keyboard.press('Escape'); await expect(page.getByRole('dialog')).toHaveCount(0);
      };
      await page.getByRole('button', { name: 'Plano de apoio', exact: true }).click();
      await page.getByRole('button', { name: 'Abrir plano e execução', exact: true }).first().click();
      await dialogCapture('recovery-plan-detail');
      await ready(page, classes);
      const tabs = page.getByRole('tablist', { name: 'Conteúdo da turma', exact: true });
      await tabs.scrollIntoViewIfNeeded(); await capture(page, 'class-students', true);
      for (const [label, name] of [[/^Criar turma$/, 'class-create'], [/^Adicionar$/, 'student-create']]) {
        await page.getByRole('button', { name: label }).click(); await dialogCapture(name);
      }
      await page.locator('[data-class-detail] summary').filter({ hasText: 'Organizar turma' }).click();
      for (const [label, name] of [['Importar estudantes', 'student-import'], ['Código de entrada', 'class-entry-codes']]) {
        await page.getByRole('button', { name: label, exact: true }).click(); await dialogCapture(name);
      }
      await page.locator('[data-class-detail] summary').filter({ hasText: 'Organizar turma' }).click();
      await tabs.getByRole('tab', { name: 'Aplicações', exact: true }).click(); await page.waitForLoadState('networkidle');
      await tabs.scrollIntoViewIfNeeded(); await capture(page, 'class-applications', true);
      await page.getByRole('button', { name: 'Nova aplicação', exact: true }).click(); await dialogCapture('class-application-wizard');
      await page.getByRole('button', { name: 'Corrigir e analisar resultados', exact: true }).first().click();
      await expect(page.getByRole('dialog')).toBeVisible(); await page.waitForLoadState('networkidle');
      await capture(page, 'results-mobile', true);
      for (const name of ['Questões', 'Habilidades BNCC', 'Estudantes']) {
        await page.getByRole('tab', { name, exact: true }).last().click(); await page.waitForTimeout(350);
        await capture(page, 'results-' + ({ 'Questões': 'questions', 'Habilidades BNCC': 'skills', 'Estudantes': 'students' })[name], true);
      }
      await page.getByRole('button', { name: 'Ver correção', exact: true }).first().click(); await page.waitForLoadState('networkidle');
      await capture(page, 'student-correction', true); await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await page.getByRole('button', { name: 'Acessos dos estudantes', exact: true }).first().click(); await dialogCapture('student-access-management');
      await ready(page, '/biblioteca');
      await page.getByRole('button', { name: /^Filtros/ }).click(); await dialogCapture('library-filters');
      await ready(page, `/planejamento/${plan.publicId}`);
      await page.getByRole('button', { name: 'Vincular', exact: true }).nth(0).click(); await dialogCapture('lesson-skills');
      await page.getByRole('button', { name: 'Vincular', exact: true }).nth(1).click(); await dialogCapture('lesson-resources');
      await ready(page, `/material/${materialId}`); await page.locator('canvas').first().scrollIntoViewIfNeeded();
      await capture(page, 'pdf-reading', true);
      const adminCtx = await context(admin, { width: 390, height: 664 }); const adminPage = await adminCtx.newPage();
      for (const [url, label, name] of [['/admin/usuarios', 'Novo usuário', 'admin-user-form'], ['/admin/categorias', 'Nova disciplina', 'admin-category-form'], ['/colecoes', 'Novo laboratório', 'admin-collection-form']]) {
        await ready(adminPage, url); await adminPage.getByRole('button', { name: label, exact: true }).click();
        await expect(adminPage.getByRole('dialog')).toBeVisible(); await adminPage.waitForTimeout(350);
        await capture(adminPage, name, true); await adminPage.keyboard.press('Escape');
        await expect(adminPage.getByRole('dialog')).toHaveCount(0);
      }
      await adminCtx.close();
      const previewCtx = await context(previewUser, { width: 390, height: 664 }); const preview = await previewCtx.newPage();
      await ready(preview, '/banco-questoes/formatos');
      await preview.getByRole('heading', { level: 2 }).first().scrollIntoViewIfNeeded(); await capture(preview, 'formats-workspace', true);
      await ready(preview, '/exemplos/devolutivas');
      await preview.getByRole('button', { name: /Visão do professor/ }).click();
      await preview.getByRole('heading', { name: 'Tornar o raciocínio verificável', exact: true }).scrollIntoViewIfNeeded();
      await capture(preview, 'feedback-preview-teacher', true); await previewCtx.close();
      await ready(page, '/');
      await page.getByRole('button', { name: 'Abrir menu', exact: true }).click();
      await capture(page, 'teacher-navigation', true);
      await page.getByRole('button', { name: 'Fechar menu', exact: true }).click();
      await page.waitForTimeout(350);
      await page.getByRole('button', { name: 'Notificações', exact: true }).click();
      await expect(page.getByText('Notificações', { exact: true })).toBeVisible();
      await capture(page, 'notifications', true);
      await ready(page, '/banco-questoes');
      await page.getByText(/^\d+ questões encontradas$/).scrollIntoViewIfNeeded();
      await capture(page, 'question-bank-items', true);
      await ready(page, '/fale-conosco');
      await page.getByPlaceholder('Escreva sua mensagem para a administração...').scrollIntoViewIfNeeded();
      await capture(page, 'teacher-message-composer', true);
      // Additional synthetic application only: no reopening previous assessments and no real student.
      const participantIds = db.prepare('SELECT public_id FROM students WHERE owner_teacher_id=?').pluck().all(teacher.id);
      const draft = await api(`/classes/${classPublicId}/assessments`, teacher, { sourceQuestionSetId: questionSetId, participantIds });
      const assessmentPath = `/classes/${classPublicId}/assessments/${draft.id}`;
      const opened = await api(assessmentPath + '/delivery', teacher, { expectedRevision: draft.revision, action: 'open' }, 'PATCH');
      const credentials = await api(assessmentPath + '/student-access/credentials', teacher, { expectedRevision: opened.revision, confirmation: 'GERAR_ACESSOS' });
      assert.ok(credentials.generated.length > 0);
      const studentCtx = await context(null, { width: 390, height: 664 }); const student = await studentCtx.newPage();
      await ready(student, '/responder');
      await student.getByLabel('Código individual de acesso', { exact: true }).fill(credentials.generated[0].code);
      await student.getByRole('button', { name: 'Entrar na avaliação', exact: true }).click();
      await expect(student.getByRole('radiogroup')).toBeVisible(); await student.waitForLoadState('networkidle');
      await capture(student, 'student-answering-mobile', true);
      await student.getByRole('button', { name: 'Próxima', exact: true }).click();
      await capture(student, 'student-next-question', true);
      await student.setViewportSize({ width: 1024, height: 600 }); await student.evaluate(() => scrollTo(0, 0));
      await capture(student, 'student-answering-notebook', true); await studentCtx.close();
    }
    const start = Date.now(); let iterations = 0;
    while (Date.now() - start < 30000) {
      await page.mouse.wheel(0, 250); await page.keyboard.press('Tab'); await page.mouse.wheel(0, -250); await page.waitForTimeout(500); iterations++;
    }
    report.explorationIterations = iterations; await ctx.close();
    report.status = 'captured'; record(); return report;
  } catch (error) {
    report.status = 'incomplete'; report.failure = error.message; record(); throw error;
  } finally { await browser.close(); }
}
module.exports = { runScreenLayoutAudit };
