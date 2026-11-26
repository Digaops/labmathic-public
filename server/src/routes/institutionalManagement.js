const express = require('express');
const { PasswordOperationError } = require('../services/passwordOperations');
const { revalidatePasswordActor } = require('../services/passwordAccess');

const config = require('../config');
const db = require('../database');
const { authenticate } = require('../middleware/auth');
const { evaluateFeatureFlag } = require('../services/featureFlags');
const {
  searchIbgeMunicipalities,
  searchSchoolDirectory,
} = require('../services/institutionalDirectories');
const {
  FEATURE_KEY,
  InstitutionalManagementError,
  confirmGuidedClass,
  createGuidedClass,
  createMembership,
  createMunicipality,
  createProfessional,
  createSchool,
  getInstitutionalManagementState,
  getInstitutionalOperation,
  updateMunicipality,
  updateSchool,
} = require('../services/institutionalManagement');

const router = express.Router();

function strictBody(body, allowedFields) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InstitutionalManagementError(
      400,
      'invalid_request_shape',
      'O corpo da requisição deve ser um objeto JSON.',
    );
  }
  const unexpected = Object.keys(body).filter((field) => !allowedFields.includes(field));
  if (unexpected.length > 0) {
    throw new InstitutionalManagementError(
      400,
      'invalid_request_shape',
      'A requisição possui campos não permitidos.',
      { unexpected },
    );
  }
  return body;
}

function strictQuery(query, allowedFields) {
  const unexpected = Object.keys(query || {}).filter((field) => !allowedFields.includes(field));
  if (unexpected.length > 0) {
    throw new InstitutionalManagementError(
      400,
      'invalid_request_shape',
      'A consulta possui parâmetros não permitidos.',
      { unexpected },
    );
  }
  return query || {};
}

function mapError(error, res) {
  if (error instanceof InstitutionalManagementError || error instanceof PasswordOperationError) {
    if (error.status === 503) res.setHeader('Retry-After', '3');
    return res.status(error.status).json({
      error: error.message,
      code: error.code,
      ...(error.details === undefined ? {} : { details: error.details }),
    });
  }
  if (process.env.NODE_ENV !== 'production') {
    console.error('[institutional-management]', error);
  }
  return res.status(500).json({
    error: 'Não foi possível concluir a operação institucional.',
    code: 'institutional_management_unavailable',
  });
}

function requestMetadata(req) {
  return {
    ipAddress: req.ip || null,
    userAgent: req.get('user-agent') || null,
  };
}

function idempotencyKey(req) {
  return req.get('Idempotency-Key');
}

function write(handler, { created = false } = {}) {
  return async (req, res) => {
    try {
      const result = await handler(req);
      return res.status(created && !result.replayed ? 201 : 200).json(result);
    } catch (error) {
      return mapError(error, res);
    }
  };
}

function requirePilot(req, res, next) {
  if (config.appEnvironment !== 'homologation' && process.env.NODE_ENV !== 'test') {
    return res.status(404).json({
      error: 'Piloto operacional indisponível neste ambiente.',
      code: 'homologation_only',
    });
  }
  const userId = Number(req.user?.id);
  const principal = Number.isInteger(userId) && userId > 0
    ? db.prepare('SELECT id, name, email, role FROM users WHERE id = ?').get(userId)
    : null;
  if (!principal) {
    return res.status(401).json({ error: 'Sessão inválida ou expirada.', code: 'invalid_principal' });
  }
  const decision = evaluateFeatureFlag(db, FEATURE_KEY, principal);
  if (!decision.enabled) {
    return res.status(404).json({
      error: 'Piloto operacional institucional indisponível.',
      code: 'feature_disabled',
    });
  }
  req.user = { ...req.user, ...principal };
  return next();
}

router.use((_req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Vary', 'Authorization');
  next();
});
router.use(authenticate, requirePilot);

router.get('/', (req, res) => {
  try {
    return res.json(getInstitutionalManagementState(db, { actor: req.user }));
  } catch (error) {
    return mapError(error, res);
  }
});

router.get('/operation', (req, res) => {
  try {
    strictQuery(req.query, []);
    return res.json(getInstitutionalOperation(db, { actor: req.user, idempotencyKey: idempotencyKey(req) }));
  } catch (error) { return mapError(error, res); }
});

router.get('/directories/municipalities', async (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      throw new InstitutionalManagementError(
        403,
        'admin_required',
        'A consulta de diretórios institucionais é exclusiva da administração geral neste piloto.',
      );
    }
    const query = strictQuery(req.query, ['query']);
    return res.json(await searchIbgeMunicipalities(query.query));
  } catch (error) {
    return mapError(error, res);
  }
});

router.get('/directories/schools', (req, res) => {
  try {
    if (req.user.role !== 'admin') {
      throw new InstitutionalManagementError(
        403,
        'admin_required',
        'A consulta de diretórios institucionais é exclusiva da administração geral neste piloto.',
      );
    }
    const query = strictQuery(req.query, ['municipalityPublicId', 'query']);
    return res.json(searchSchoolDirectory(db, {
      municipalityPublicId: query.municipalityPublicId,
      query: query.query,
    }));
  } catch (error) {
    return mapError(error, res);
  }
});

router.post('/municipalities', write((req) => {
  const body = strictBody(req.body, ['name', 'ibgeCode']);
  return createMunicipality(db, {
    actor: req.user,
    name: body.name,
    ibgeCode: body.ibgeCode,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}, { created: true }));

router.patch('/municipalities/:municipalityPublicId', write((req) => {
  const body = strictBody(req.body, ['name', 'ibgeCode', 'expectedRevision']);
  return updateMunicipality(db, {
    actor: req.user,
    municipalityPublicId: req.params.municipalityPublicId,
    name: body.name,
    ibgeCode: body.ibgeCode,
    expectedRevision: body.expectedRevision,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}));

router.post('/municipalities/:municipalityPublicId/schools', write((req) => {
  const body = strictBody(req.body, ['name', 'censusCode']);
  return createSchool(db, {
    actor: req.user,
    municipalityPublicId: req.params.municipalityPublicId,
    name: body.name,
    censusCode: body.censusCode,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}, { created: true }));

router.patch('/municipalities/:municipalityPublicId/schools/:schoolPublicId', write((req) => {
  const body = strictBody(req.body, ['name', 'censusCode', 'expectedRevision']);
  return updateSchool(db, {
    actor: req.user,
    municipalityPublicId: req.params.municipalityPublicId,
    schoolPublicId: req.params.schoolPublicId,
    name: body.name,
    censusCode: body.censusCode,
    expectedRevision: body.expectedRevision,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}));

router.post('/memberships', write((req) => {
  const body = strictBody(req.body, [
    'userId',
    'role',
    'municipalityPublicId',
    'schoolPublicId',
  ]);
  return createMembership(db, {
    actor: req.user,
    userId: body.userId,
    role: body.role,
    municipalityPublicId: body.municipalityPublicId,
    schoolPublicId: body.schoolPublicId,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}, { created: true }));

router.post('/professionals', write((req) => {
  const body = strictBody(req.body, [
    'name',
    'email',
    'temporaryPassword',
    'role',
    'municipalityPublicId',
    'schoolPublicId',
  ]);
  return createProfessional(db, {
    actor: req.user,
    fingerprintSecret: config.jwtSecret,
    revalidate() {
      revalidatePasswordActor(req, true);
      if (!evaluateFeatureFlag(db, FEATURE_KEY, req.user).enabled) {
        throw new InstitutionalManagementError(404, 'feature_disabled', 'Piloto operacional institucional indisponível.');
      }
    },
    name: body.name,
    email: body.email,
    temporaryPassword: body.temporaryPassword,
    role: body.role,
    municipalityPublicId: body.municipalityPublicId,
    schoolPublicId: body.schoolPublicId,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}, { created: true }));

router.post('/classes', write((req) => {
  const body = strictBody(req.body, [
    'membershipPublicId',
    'name',
    'gradeId',
    'academicYear',
    'disciplineIds',
  ]);
  return createGuidedClass(db, {
    actor: req.user,
    membershipPublicId: body.membershipPublicId,
    name: body.name,
    gradeId: body.gradeId,
    academicYear: body.academicYear,
    disciplineIds: body.disciplineIds,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}, { created: true }));

router.post('/classes/:classPublicId/confirm', write((req) => {
  const body = strictBody(req.body, ['expectedContextUpdatedAt']);
  return confirmGuidedClass(db, {
    actor: req.user,
    classPublicId: req.params.classPublicId,
    expectedContextUpdatedAt: body.expectedContextUpdatedAt,
    idempotencyKey: idempotencyKey(req),
    requestMetadata: requestMetadata(req),
  });
}));

module.exports = router;
