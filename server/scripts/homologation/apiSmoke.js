const assert = require('node:assert/strict');

const DEFAULT_TIMEOUT_MS = 10_000;

function readRequiredEnvironment(name) {
  const value = String(process.env[name] || '').trim();
  if (!value) throw new Error(`Variável obrigatória ausente: ${name}.`);
  return value;
}

function validateBaseUrl(rawBaseUrl) {
  const url = new URL(rawBaseUrl);
  const isLoopback = ['localhost', '127.0.0.1', '::1'].includes(url.hostname);
  if (url.protocol !== 'https:' && !(isLoopback && url.protocol === 'http:')) {
    throw new Error('A homologação remota deve usar HTTPS; HTTP é aceito apenas em loopback local.');
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('HOMOLOGATION_BASE_URL deve conter somente origem e caminho base, sem credenciais ou parâmetros.');
  }
  return url.toString().replace(/\/$/, '');
}

async function requestJson(baseUrl, pathname, options = {}) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: options.method || 'GET',
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs || DEFAULT_TIMEOUT_MS),
    headers: {
      Accept: 'application/json',
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
      ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const contentType = response.headers.get('content-type') || '';
  const rawBody = await response.text();
  if (!/application\/json/i.test(contentType)) {
    throw new Error(
      `${pathname} retornou HTTP ${response.status} com Content-Type `
      + `"${contentType || 'ausente'}" em vez de JSON.`
    );
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new Error(`${pathname} retornou JSON inválido com HTTP ${response.status}.`);
  }
  const expectedStatus = options.expectedStatus ?? 200;
  assert.equal(
    response.status,
    expectedStatus,
    `${pathname} retornou HTTP ${response.status}: ${payload?.error || 'resposta inesperada'}`
  );
  return { response, payload };
}

async function login(baseUrl, email, password, expectedRole) {
  const { payload } = await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: { email, password },
  });
  assert.equal(payload.user?.email, email);
  assert.equal(payload.user?.role, expectedRole);
  assert.equal(typeof payload.token, 'string');
  assert.ok(payload.token.length > 20, 'O login não retornou um token utilizável.');
  return payload.token;
}

async function runApiSmoke(input = {}) {
  const baseUrl = validateBaseUrl(
    input.baseUrl || readRequiredEnvironment('HOMOLOGATION_BASE_URL')
  );
  const adminEmail = input.adminEmail || readRequiredEnvironment('HOMOLOGATION_ADMIN_EMAIL');
  const adminPassword = input.adminPassword || readRequiredEnvironment('HOMOLOGATION_ADMIN_PASSWORD');
  const professorEmail = input.professorEmail || readRequiredEnvironment('HOMOLOGATION_PROFESSOR_EMAIL');
  const professorPassword = input.professorPassword
    || readRequiredEnvironment('HOMOLOGATION_PROFESSOR_PASSWORD');
  const checks = [];

  const { response: healthResponse, payload: health } = await requestJson(
    baseUrl,
    '/api/health'
  );
  assert.equal(health.status, 'ok');
  assert.equal(health.environment, 'homologation');
  assert.equal(health.sanitized, true);
  assert.ok(Number(health.schemaVersion) >= 24, 'A homologação não aplicou a migração 024.');
  assert.equal(health.schoolDirectory?.sourceName, 'Inep · Censo Escolar');
  assert.equal(health.schoolDirectory?.censusYear, 2025);
  assert.equal(health.schoolDirectory?.rowCount, 128145);
  assert.equal(health.schoolDirectory?.administrativeDependency, 'municipal');
  assert.equal(
    health.schoolDirectory?.sha256,
    'cc973b0c6c8e225cd11189bc85d257de56152caf0a1a8344343dcadb843908a8',
    'A homologação não carregou exatamente o catálogo municipal aprovado.',
  );
  assert.equal(healthResponse.headers.get('x-content-type-options'), 'nosniff');
  assert.ok(healthResponse.headers.get('content-security-policy'), 'CSP ausente.');
  assert.ok(healthResponse.headers.get('strict-transport-security'), 'HSTS ausente.');
  checks.push('health-and-security-headers');

  await requestJson(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: {
      email: 'credencial-inexistente@homologacao.invalid',
      password: 'credencial-incorreta',
    },
    expectedStatus: 401,
  });
  checks.push('invalid-login-rejected');

  const adminToken = await login(baseUrl, adminEmail, adminPassword, 'admin');
  const { payload: adminMe } = await requestJson(baseUrl, '/api/auth/me', {
    token: adminToken,
  });
  assert.equal(adminMe.email, adminEmail);
  await requestJson(baseUrl, '/api/governance/admin/releases', {
    token: adminToken,
    expectedStatus: 404,
  });
  await requestJson(baseUrl, '/api/question-bank/questions?page=1&limit=1', { token: adminToken });
  const { payload: adminInstitutional } = await requestJson(
    baseUrl,
    '/api/institutions/read-model',
    { token: adminToken },
  );
  assert.equal(adminInstitutional.mode, 'admin');
  assert.equal(adminInstitutional.readOnly, true);
  assert.equal(typeof adminInstitutional.summary?.pendingClasses, 'number');
  const { payload: adminInstitutionalManagement } = await requestJson(
    baseUrl,
    '/api/institutions/management',
    { token: adminToken },
  );
  assert.equal(adminInstitutionalManagement.mode, 'admin');
  assert.equal(adminInstitutionalManagement.environment, 'homologation');
  assert.equal(adminInstitutionalManagement.writable, true);
  assert.ok(Array.isArray(adminInstitutionalManagement.municipalities));
  assert.ok(Array.isArray(adminInstitutionalManagement.professionals));
  checks.push('admin-read-paths-and-institutional-management-pilot');

  const professorToken = await login(
    baseUrl,
    professorEmail,
    professorPassword,
    'professor'
  );
  const { payload: professorMe } = await requestJson(baseUrl, '/api/auth/me', {
    token: professorToken,
  });
  assert.equal(professorMe.email, professorEmail);
  await requestJson(baseUrl, '/api/question-bank/grades', { token: professorToken });
  await requestJson(baseUrl, '/api/question-bank/author-questions?page=1&limit=1', {
    token: professorToken,
  });
  const { payload: featureDecisions } = await requestJson(
    baseUrl,
    '/api/governance/features?keys=classes.core,classes.student_import,classes.entry_codes,classes.assessment_assignments,classes.assessment_delivery,classes.assessment_results,classes.student_assessment_portal,classes.learning_recovery,question_bank.diagnostic_generator,planning.lesson_planner,institutions.read_model,institutions.management_pilot,question_bank.typed_preview,question_bank.feedback_preview,question_bank.catalog_preview,question_bank.typed_engine',
    { token: professorToken }
  );
  for (const key of [
    'classes.core',
    'classes.student_import',
    'classes.entry_codes',
    'classes.assessment_assignments',
    'classes.assessment_delivery',
    'classes.assessment_results',
    'classes.student_assessment_portal',
    'classes.learning_recovery',
    'question_bank.diagnostic_generator',
    'planning.lesson_planner',
    'institutions.read_model',
    'institutions.management_pilot',
    'question_bank.typed_preview',
    'question_bank.feedback_preview',
    'question_bank.catalog_preview',
  ]) {
    assert.equal(featureDecisions.features[key], true, `${key} deveria estar aberta na homologação.`);
  }
  assert.equal(
    featureDecisions.features['question_bank.typed_engine'],
    false,
    'O motor tipado deve permanecer fechado nesta etapa.',
  );
  for (const token of [adminToken, professorToken]) {
    const { payload: typedPreview } = await requestJson(
      baseUrl,
      '/api/question-bank/typed-preview/catalog',
      { token },
    );
    assert.equal(typedPreview.mode, 'preview');
    assert.equal(typedPreview.readOnly, true);
    assert.equal(typedPreview.examples?.length, 7);
    assert.equal(JSON.stringify(typedPreview).includes('answerKey'), false);

    const { payload: feedbackCatalog } = await requestJson(
      baseUrl,
      '/api/question-bank/feedback-preview/catalog',
      { token },
    );
    assert.equal(feedbackCatalog.mode, 'feedback_preview');
    assert.equal(feedbackCatalog.readOnly, true);
    assert.equal(feedbackCatalog.examples?.length, 3);
    assert.equal(JSON.stringify(feedbackCatalog).includes('referenceAnswer'), false);

    const { payload: protectedFeedback } = await requestJson(
      baseUrl,
      '/api/question-bank/feedback-preview/examples/even-numbers-feedback?view=after_submission',
      { token },
    );
    assert.equal(protectedFeedback.feedback?.available, false);
    assert.equal(JSON.stringify(protectedFeedback).includes('resolutionSteps'), false);

    const { payload: teacherFeedback } = await requestJson(
      baseUrl,
      '/api/question-bank/feedback-preview/examples/fraction-half-feedback?view=teacher',
      { token },
    );
    assert.equal(teacherFeedback.feedback?.available, true);
    assert.equal(teacherFeedback.feedback?.guide?.choiceInsights?.length, 4);

    const { payload: catalogPreview } = await requestJson(
      baseUrl,
      '/api/question-bank/catalog-preview/catalog',
      { token },
    );
    assert.equal(catalogPreview.mode, 'question_bank_catalog_preview');
    assert.equal(catalogPreview.synthetic, true);
    assert.equal(catalogPreview.readOnly, true);
    assert.equal(catalogPreview.items?.length, 6);
    assert.equal(JSON.stringify(catalogPreview).includes('answerKey'), false);

    const { payload: filteredCatalog } = await requestJson(
      baseUrl,
      '/api/question-bank/catalog-preview/catalog?reviewStatus=needs_attention',
      { token },
    );
    assert.equal(filteredCatalog.items?.length, 2);

    const { payload: catalogDossier } = await requestJson(
      baseUrl,
      '/api/question-bank/catalog-preview/items/fraction-ordering-review',
      { token },
    );
    assert.equal(catalogDossier.item?.criteria?.length, 7);
    assert.equal(Object.hasOwn(catalogDossier.item || {}, 'qualityScore'), false);
  }
  const { payload: typedAuthoringGuard } = await requestJson(
    baseUrl,
    '/api/question-bank/typed-authoring/versions/smoke-unavailable-version-001',
    { token: professorToken, expectedStatus: 404 },
  );
  assert.equal(
    typedAuthoringGuard.code,
    'feature_disabled',
    'O adaptador tipado deve existir, mas permanecer oculto pela flag.',
  );
  await requestJson(baseUrl, '/api/classes/bootstrap', { token: professorToken });
  const { payload: professorInstitutional } = await requestJson(
    baseUrl,
    '/api/institutions/read-model',
    { token: professorToken },
  );
  assert.equal(professorInstitutional.mode, 'professional');
  assert.equal(professorInstitutional.readOnly, true);
  assert.ok(Array.isArray(professorInstitutional.classes));
  const { payload: professorInstitutionalManagement } = await requestJson(
    baseUrl,
    '/api/institutions/management',
    { token: professorToken },
  );
  assert.equal(professorInstitutionalManagement.mode, 'professional');
  assert.equal(professorInstitutionalManagement.environment, 'homologation');
  assert.ok(Array.isArray(professorInstitutionalManagement.pendingConfirmations));
  const { payload: plannerBootstrap } = await requestJson(
    baseUrl,
    '/api/lesson-plans/bootstrap',
    { token: professorToken }
  );
  assert.ok(Array.isArray(plannerBootstrap.classes), 'O planejador não retornou as turmas.');
  assert.ok(Array.isArray(plannerBootstrap.grades), 'O planejador não retornou os anos BNCC.');
  const { payload: diagnosticBootstrap } = await requestJson(
    baseUrl,
    '/api/question-bank/diagnostics/bootstrap',
    { token: professorToken }
  );
  assert.ok(Array.isArray(diagnosticBootstrap.grades), 'O gerador diagnÃ³stico nÃ£o retornou os anos.');
  assert.ok(Array.isArray(diagnosticBootstrap.units), 'O gerador diagnÃ³stico nÃ£o retornou as unidades temÃ¡ticas.');
  assert.ok(Array.isArray(diagnosticBootstrap.skills), 'O gerador diagnÃ³stico nÃ£o retornou as habilidades.');
  await requestJson(baseUrl, '/api/governance/admin/releases', {
    token: professorToken,
    expectedStatus: 404,
  });
  checks.push('professor-read-paths-diagnostic-planning-typed-feedback-catalog-previews-guard-and-rbac');

  return {
    status: 'passed',
    environment: health.environment,
    sanitized: health.sanitized,
    schemaVersion: health.schemaVersion,
    schoolDirectory: health.schoolDirectory,
    checks,
  };
}

if (require.main === module) {
  runApiSmoke()
    .then((report) => console.log(JSON.stringify(report, null, 2)))
    .catch((error) => {
      console.error(JSON.stringify({ status: 'failed', error: error.message }, null, 2));
      process.exitCode = 1;
    });
}

module.exports = {
  runApiSmoke,
  validateBaseUrl,
};
