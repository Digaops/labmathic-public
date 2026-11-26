const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const path = require('path');
const fs = require('fs');
const config = require('./config');

async function startApplication() {
const isProduction = config.isProduction;
const clientDist = path.join(__dirname, '../../client/dist');
if (isProduction && config.appEnvironment !== 'homologation') {
  require('./productionStartup').assertProductionStartup(config, clientDist);
}
const { prepareHomologationRelease, activateHomologationPilot, getReleaseReadiness } = require('./homologationReleasePreparation');
// Nenhum require de database/rotas antes do backup solicitado pela release protegida.
const releaseReceipt = await prepareHomologationRelease(config);
const db = require('./database');
activateHomologationPilot(db, config, releaseReceipt);
const { activateHomologationNetworkPortrait, networkPortraitReadiness } = require('./services/homologationNetworkPortrait');
activateHomologationNetworkPortrait(db, config, releaseReceipt);

const schoolDirectoryReadiness = {
  required: isProduction && config.appEnvironment === 'homologation',
  status: isProduction && config.appEnvironment === 'homologation' ? 'initializing' : 'ready',
};

// Ensure upload directory
if (!isProduction && !fs.existsSync(config.uploadDir)) {
  fs.mkdirSync(config.uploadDir, { recursive: true });
}

const app = express();

// Necessário em produção/Hostinger porque a aplicação roda atrás de proxy.
// Permite que o express-rate-limit use corretamente o IP real via X-Forwarded-For.
if (isProduction) {
  app.set('trust proxy', 1);
}

// Security middleware
app.use(helmet({
  crossOriginResourcePolicy: { policy: 'cross-origin' },
  contentSecurityPolicy: isProduction ? undefined : false,
  hsts: isProduction ? { maxAge: 31536000, includeSubDomains: true } : false,
}));
app.use(compression());

// Política de uso escolar, sem desativar a proteção ampla por origem.
const {
  ingressLimiter, identifyRateLimitPrincipal, apiLimiter, loginOriginLimiter, authLimiter,
  forgotOriginLimiter, forgotAccountLimiter, downloadLimiter, classJoinLimiter, classCodeLimiter,
  studentAssessmentEntryLimiter, studentAssessmentCodeLimiter,
} = require('./middleware/schoolRateLimits').createSchoolRateLimits();

function healthCheck(_req, res) {
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  res.setHeader('Surrogate-Control', 'no-store');

  if (schoolDirectoryReadiness.required && schoolDirectoryReadiness.status !== 'ready') {
    res.status(503).json({
      status: schoolDirectoryReadiness.status === 'failed' ? 'unhealthy' : 'initializing',
      environment: config.appEnvironment,
      sanitized: true,
      revision: config.deploymentMetadata?.sourceSha || null,
      schoolDirectoryStatus: schoolDirectoryReadiness.status,
      timestamp: new Date().toISOString(),
    });
    return;
  }

  try {
    const currentRelease = db.prepare(`
      SELECT version
      FROM product_releases
      WHERE status = 'general'
      ORDER BY datetime(COALESCE(released_at, created_at)) DESC, id DESC
      LIMIT 1
    `).get();
    const schemaVersion = db.prepare(`
      SELECT COALESCE(MAX(version), 0) AS version
      FROM schema_migrations
    `).get().version;
    const schoolDirectory = schemaVersion >= 24
      ? db.prepare(`
          SELECT source_name, source_year, source_sha256, row_count, imported_at
          FROM institutional_directory_imports
          WHERE directory_type = 'inep_school_catalog'
          ORDER BY source_year DESC, id DESC
          LIMIT 1
        `).get()
      : null;

    res.json({
      status: 'ok',
      environment: config.appEnvironment,
      sanitized: config.appEnvironment === 'homologation' ? true : undefined,
      revision: config.deploymentMetadata?.sourceSha || null,
      release: currentRelease?.version || null,
      schemaVersion,
      networkPortrait: config.appEnvironment === 'homologation' && schemaVersion >= 32
        ? networkPortraitReadiness(db) : undefined,
      schoolDirectory: config.appEnvironment === 'homologation' && schoolDirectory
        ? {
            sourceName: schoolDirectory.source_name,
            censusYear: schoolDirectory.source_year,
            sha256: schoolDirectory.source_sha256,
            rowCount: schoolDirectory.row_count,
            administrativeDependency: 'municipal',
            importedAt: schoolDirectory.imported_at,
          }
        : undefined,
      timestamp: new Date().toISOString(),
    });
  } catch {
    res.status(503).json({
      status: 'unhealthy',
      timestamp: new Date().toISOString(),
    });
  }
}

// CORS - em produção, aceitar apenas a origem configurada
app.use(cors({
  origin: isProduction
    ? config.corsOrigin
    : [config.corsOrigin, 'http://localhost:5173', 'http://localhost:5174', 'http://127.0.0.1:5173', 'http://127.0.0.1:5174'],
  credentials: true,
}));
// O health de deploy precisa permanecer observável mesmo quando os smoke tests
// consomem o orçamento do limitador geral. Ele não aceita escrita nem credenciais.
app.get('/api/health', healthCheck);
app.use((req, res, next) => {
  if (!schoolDirectoryReadiness.required || schoolDirectoryReadiness.status === 'ready') {
    next();
    return;
  }
  res.setHeader('Cache-Control', 'no-store');
  res.status(503).json({
    error: 'A homologação está preparando o catálogo escolar. Tente novamente em instantes.',
    code: 'homologation_initializing',
  });
});
// Limita a rota publica antes de interpretar um corpo potencialmente grande.
// O segundo limitador depende do codigo normalizado e, por isso, vem apos o parser.
app.use('/api/', ingressLimiter);
app.use('/api/auth/login', loginOriginLimiter);
app.use('/api/auth/forgot-password', forgotOriginLimiter);
app.use('/api/classes/join', classJoinLimiter);
app.use('/api/student-assessments/session', studentAssessmentEntryLimiter);
// Smaller, content-safe parser for AI; no malformed pedagogical text in generic error logs.
app.use('/api/ai', require('./routes/ai').parseJson);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
app.use('/api/', identifyRateLimitPrincipal);
app.use('/api/', apiLimiter);
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/forgot-password', forgotAccountLimiter);
app.use('/api/materials/*/download', downloadLimiter);
app.use('/api/classes/join', classCodeLimiter);
app.use('/api/student-assessments/session', studentAssessmentCodeLimiter);

app.use('/uploads', require('./middleware/protectedUploads'));



// Routes
app.use('/api/auth', require('./routes/auth'));
app.use('/api/users', require('./routes/users'));
app.use('/api/municipal-indicators', require('./routes/municipalIndicators'));
app.use('/api/materials', require('./routes/materials'));
app.use('/api/categories', require('./routes/categories'));
app.use('/api/favorites', require('./routes/favorites'));
app.use('/api/collections', require('./routes/collections'));
app.use('/api/ratings', require('./routes/ratings'));
app.use('/api/comments', require('./routes/comments'));
app.use('/api/share', require('./routes/share'));
app.use('/api/notifications', require('./routes/notifications'));
app.use('/api/reports', require('./routes/reports'));
app.use('/api/activity', require('./routes/activity'));
app.use('/api/question-bank/numeric-drafts', require('./routes/numericQuestionDrafts'));
app.use('/api/question-bank', require('./routes/diagnostics'));
app.use('/api/question-bank', require('./routes/questionBank'));
app.use('/api/question-bank/typed-authoring', require('./routes/typedQuestionAuthoring'));
app.use('/api/question-bank/ai-authoring', require('./routes/aiAuthoring').createRouter(require('./database')));
app.use('/api/ai', require('./routes/ai').createRouter(db));
app.use('/api/question-bank/typed-preview', require('./routes/typedQuestionPreview'));
app.use('/api/question-bank/feedback-preview', require('./routes/typedQuestionFeedbackPreview'));
app.use('/api/question-bank/catalog-preview', require('./routes/questionBankCatalogPreview'));
app.use('/api/pedagogical-cycle', require('./routes/pedagogicalCycle'));
app.use('/api/support', require('./routes/support'));
app.use('/api/content-issues', require('./routes/contentIssues'));
app.use('/api/school-coordination', require('./routes/schoolCoordination'));
app.use('/api/announcements', require('./routes/announcements'));
app.use('/api/governance', require('./routes/governance'));
app.use('/api/institutions/read-model', require('./routes/institutionalReadModel'));
app.use('/api/institutions/management', require('./routes/institutionalManagement'));
app.use('/api/classes', require('./routes/classAssessments'));
app.use('/api/classes', require('./routes/classAssessmentResults'));
app.use('/api/classes', require('./routes/classAssessmentStudentAccess'));
app.use('/api/classes', require('./routes/classes'));
app.use('/api/student-assessments', require('./routes/studentAssessmentPortal'));
app.use('/api/lesson-plans', require('./routes/lessonPlanner'));

// Leitura operacional, sem ativação, credenciais, identidades ou acesso às devolutivas.
if (config.appEnvironment === 'homologation' && config.deploymentMetadata?.preparation) {
  const { authenticate, requireAdmin } = require('./middleware/auth');
  app.get('/api/homologation/release-readiness', authenticate, requireAdmin, (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.json(getReleaseReadiness(db, config, releaseReceipt));
  });
}

// Serve frontend em produção
if (isProduction) {
  if (fs.existsSync(clientDist)) {
    app.use(express.static(clientDist));
    app.get('*', (_req, res, next) => {
      if (_req.path.startsWith('/api/')) return next();
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }
}

// Error handling
app.use(require('./middleware/apiErrors'));

function scheduleCleanup() {
  const cleanup = () => {
    try {
      db.prepare("DELETE FROM password_reset_tokens WHERE expires_at < datetime('now') OR used = 1").run();
      db.prepare("DELETE FROM share_links WHERE expires_at < datetime('now')").run();
      db.prepare('DELETE FROM revoked_auth_tokens WHERE expires_at <= ?').run(Math.floor(Date.now() / 1000));
    } catch {
      // silently handled
    }
  };
  cleanup();
  setInterval(cleanup, 6 * 60 * 60 * 1000);
}

async function prepareRuntime() {
  const { bootstrapBundledSchoolDirectory } = require('./services/bundledSchoolDirectory');
  const directoryBootstrap = await bootstrapBundledSchoolDirectory(db, {
    appEnvironment: config.appEnvironment,
    nodeEnvironment: process.env.NODE_ENV,
  });
  if (directoryBootstrap.status !== 'skipped') {
    console.info(
      `[database] Catálogo escolar Inep ${directoryBootstrap.censusYear}: `
      + `${directoryBootstrap.status}, ${directoryBootstrap.rowCount} escolas.`,
    );
  }
  schoolDirectoryReadiness.status = 'ready';
  scheduleCleanup();
}

app.listen(config.port, isProduction ? undefined : '127.0.0.1', () => {
  if (!isProduction) {
    console.log(`Servidor rodando em http://127.0.0.1:${config.port}`);
  }
});

prepareRuntime().catch((error) => {
  schoolDirectoryReadiness.status = 'failed';
  console.error(`[startup] Falha ao preparar a homologação: ${error.message}`);
});
}

const initialization = startApplication();
module.exports = initialization;
initialization.catch((error) => {
  // Não imprimir caminhos, e-mails ou conteúdo de backup em logs de hospedagem.
  console.error(`[startup] Inicialização recusada: ${error.releaseSafe ? error.message : 'falha operacional; conferir o ambiente e os recibos de release.'}`);
  process.exitCode = 1;
});
