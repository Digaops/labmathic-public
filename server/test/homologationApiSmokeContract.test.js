const assert = require('node:assert/strict');
const http = require('node:http');
const test = require('node:test');

const { runApiSmoke } = require('../scripts/homologation/apiSmoke');

const adminEmail = 'admin@homologacao.invalid';
const professorEmail = 'professor@homologacao.invalid';

function sendJson(res, status, payload, securityHeaders = false) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    ...(securityHeaders ? {
      'Content-Security-Policy': "default-src 'self'",
      'Strict-Transport-Security': 'max-age=31536000',
      'X-Content-Type-Options': 'nosniff',
    } : {}),
  });
  res.end(JSON.stringify(payload));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

test('smoke protegido aceita governança administrativa oculta e valida turmas abertas', async (t) => {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization });

    if (req.url === '/api/health') {
      return sendJson(res, 200, {
        status: 'ok', environment: 'homologation', sanitized: true, schemaVersion: 24,
        schoolDirectory: {
          sourceName: 'Inep · Censo Escolar',
          censusYear: 2025,
          rowCount: 128145,
          administrativeDependency: 'municipal',
          sha256: 'cc973b0c6c8e225cd11189bc85d257de56152caf0a1a8344343dcadb843908a8',
        },
      }, true);
    }

    if (req.url === '/api/auth/login' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.email === adminEmail) {
        return sendJson(res, 200, { user: { email: adminEmail, role: 'admin' }, token: 'admin-token-with-safe-length' });
      }
      if (body.email === professorEmail) {
        return sendJson(res, 200, { user: { email: professorEmail, role: 'professor' }, token: 'professor-token-with-safe-length' });
      }
      return sendJson(res, 401, { error: 'Credenciais inválidas.' });
    }

    if (req.url === '/api/auth/me') {
      const email = req.headers.authorization === 'Bearer admin-token-with-safe-length'
        ? adminEmail
        : professorEmail;
      return sendJson(res, 200, { email });
    }

    if (req.url === '/api/governance/admin/releases') {
      return sendJson(res, 404, { error: 'Funcionalidade administrativa desativada.' });
    }

    if (req.url.startsWith('/api/governance/features?')) {
      return sendJson(res, 200, {
        features: {
          'classes.core': true,
          'classes.student_import': true,
          'classes.entry_codes': true,
          'classes.assessment_assignments': true,
          'classes.assessment_delivery': true,
          'classes.assessment_results': true,
          'classes.student_assessment_portal': true,
          'classes.learning_recovery': true,
          'question_bank.diagnostic_generator': true,
          'planning.lesson_planner': true,
          'institutions.read_model': true,
          'institutions.management_pilot': true,
          'question_bank.typed_preview': true,
          'question_bank.feedback_preview': true,
          'question_bank.catalog_preview': true,
          'question_bank.typed_engine': false,
        },
      });
    }

    if (
      req.url === '/api/classes/bootstrap'
      || req.url === '/api/lesson-plans/bootstrap'
      || req.url.startsWith('/api/question-bank/questions?')
      || req.url === '/api/question-bank/grades'
      || req.url.startsWith('/api/question-bank/author-questions?')
    ) {
      return sendJson(res, 200, req.url === '/api/lesson-plans/bootstrap' ? { classes: [], grades: [] } : {});
    }

    if (req.url === '/api/question-bank/diagnostics/bootstrap') {
      return sendJson(res, 200, { grades: [], units: [], skills: [] });
    }

    if (req.url === '/api/question-bank/typed-authoring/versions/smoke-unavailable-version-001') {
      return sendJson(res, 404, {
        error: 'A autoria tipada ainda não está disponível.',
        code: 'feature_disabled',
      });
    }

    if (req.url === '/api/question-bank/typed-preview/catalog') {
      return sendJson(res, 200, {
        mode: 'preview', readOnly: true,
        examples: Array.from({ length: 7 }, (_, index) => ({ id: `example-${index + 1}` })),
      });
    }

    if (req.url === '/api/question-bank/feedback-preview/catalog') {
      return sendJson(res, 200, {
        mode: 'feedback_preview', readOnly: true,
        examples: Array.from({ length: 3 }, (_, index) => ({ id: `feedback-${index + 1}` })),
      });
    }

    if (req.url === '/api/question-bank/feedback-preview/examples/even-numbers-feedback?view=after_submission') {
      return sendJson(res, 200, { feedback: { available: false, reason: 'Aguardando encerramento.' } });
    }

    if (req.url === '/api/question-bank/feedback-preview/examples/fraction-half-feedback?view=teacher') {
      return sendJson(res, 200, {
        feedback: { available: true, guide: { choiceInsights: [{}, {}, {}, {}] } },
      });
    }

    if (req.url === '/api/question-bank/catalog-preview/catalog') {
      return sendJson(res, 200, {
        mode: 'question_bank_catalog_preview', synthetic: true, readOnly: true,
        items: Array.from({ length: 6 }, (_, index) => ({ id: `catalog-${index + 1}` })),
      });
    }

    if (req.url === '/api/question-bank/catalog-preview/catalog?reviewStatus=needs_attention') {
      return sendJson(res, 200, {
        mode: 'question_bank_catalog_preview', synthetic: true, readOnly: true,
        items: [{ id: 'attention-1' }, { id: 'attention-2' }],
      });
    }

    if (req.url === '/api/question-bank/catalog-preview/items/fraction-ordering-review') {
      return sendJson(res, 200, {
        item: { criteria: Array.from({ length: 7 }, (_, index) => ({ id: `criterion-${index + 1}` })) },
      });
    }

    if (req.url === '/api/institutions/read-model') {
      const isAdmin = req.headers.authorization === 'Bearer admin-token-with-safe-length';
      return sendJson(res, 200, isAdmin ? {
        mode: 'admin', readOnly: true,
        summary: { pendingClasses: 0 }, municipalities: [], recentAudit: [],
      } : {
        mode: 'professional', readOnly: true, status: 'no_context',
        summary: { pendingClasses: 0 }, memberships: [], classes: [],
      });
    }

    if (req.url === '/api/institutions/management') {
      const isAdmin = req.headers.authorization === 'Bearer admin-token-with-safe-length';
      return sendJson(res, 200, isAdmin ? {
        mode: 'admin', environment: 'homologation', writable: true,
        municipalities: [], schools: [], professionals: [], memberships: [],
        teacherMemberships: [], grades: [], disciplines: [], guidedClasses: [],
      } : {
        mode: 'professional', environment: 'homologation', writable: true,
        guidedClasses: [], pendingConfirmations: [],
      });
    }

    return sendJson(res, 404, { error: 'Rota de teste não prevista.' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  const report = await runApiSmoke({
    baseUrl: `http://127.0.0.1:${address.port}`,
    adminEmail,
    adminPassword: 'admin-password',
    professorEmail,
    professorPassword: 'professor-password',
  });

  assert.equal(report.status, 'passed');
  assert.equal(report.schemaVersion, 24);
  assert.equal(report.schoolDirectory.rowCount, 128145);
  assert.equal(
    requests.filter((request) => request.url === '/api/governance/admin/releases').length,
    2,
    'o contrato deve validar a rota oculta com os dois perfis'
  );
  assert.ok(requests.some((request) => request.url === '/api/classes/bootstrap'));
  assert.ok(requests.some((request) => request.url === '/api/question-bank/diagnostics/bootstrap'));
  assert.ok(requests.some((request) => request.url === '/api/lesson-plans/bootstrap'));
  assert.ok(requests.some((request) => (
    request.url === '/api/question-bank/typed-authoring/versions/smoke-unavailable-version-001'
  )));
  assert.equal(
    requests.filter((request) => request.url === '/api/question-bank/typed-preview/catalog').length,
    2,
  );
  assert.equal(
    requests.filter((request) => request.url === '/api/question-bank/feedback-preview/catalog').length,
    2,
  );
  assert.equal(
    requests.filter((request) => request.url.includes('/api/question-bank/feedback-preview/examples/')).length,
    4,
  );
  assert.equal(
    requests.filter((request) => request.url === '/api/question-bank/catalog-preview/catalog').length,
    2,
  );
  assert.equal(
    requests.filter((request) => request.url.includes('/api/question-bank/catalog-preview/')).length,
    6,
  );
  assert.equal(
    requests.filter((request) => request.url === '/api/institutions/read-model').length,
    2,
  );
  assert.equal(
    requests.filter((request) => request.url === '/api/institutions/management').length,
    2,
  );
});

test('smoke informa status e tipo de conteúdo quando a borda não retorna JSON', async (t) => {
  const server = http.createServer((_req, res) => {
    res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<html>indisponível</html>');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));

  const address = server.address();
  await assert.rejects(
    runApiSmoke({
      baseUrl: `http://127.0.0.1:${address.port}`,
      adminEmail,
      adminPassword: 'admin-password',
      professorEmail,
      professorPassword: 'professor-password',
    }),
    /\/api\/health retornou HTTP 503 com Content-Type "text\/html; charset=utf-8"/
  );
});
