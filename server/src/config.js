const path = require('path');
const fs = require('fs');
const { readDeploymentMetadata } = require('./deploymentMetadata');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const isProduction = process.env.NODE_ENV === 'production';
const appEnvironment = process.env.APP_ENV || (isProduction ? 'production' : 'development');
const defaultDbPath = './data/database.sqlite';
const defaultUploadDir = './uploads';
const dbPath = path.resolve(__dirname, '..', process.env.DB_PATH || defaultDbPath);
const uploadDir = path.resolve(__dirname, '..', process.env.UPLOAD_DIR || defaultUploadDir);
const deploymentMetadataPath = path.resolve(__dirname, '../..', '.hostinger-release.json');

function failProductionConfig(message) {
  console.error(`ERRO FATAL: ${message}`);
  process.exit(1);
}

if (isProduction && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'default-secret-change-me')) {
  failProductionConfig('JWT_SECRET não configurado. Configure no arquivo .env');
}

if (isProduction && !path.isAbsolute(process.env.DB_PATH || '')) {
  failProductionConfig('DB_PATH deve conter o caminho absoluto do banco SQLite em produção.');
}

if (isProduction && !path.isAbsolute(process.env.UPLOAD_DIR || '')) {
  failProductionConfig('UPLOAD_DIR deve conter o caminho absoluto da pasta de uploads em produção.');
}

if (!['development', 'production', 'homologation'].includes(appEnvironment)) {
  failProductionConfig('APP_ENV inválido. Use development, production ou homologation.');
}

if (appEnvironment === 'homologation') {
  if (!isProduction) {
    failProductionConfig('A homologação deve usar NODE_ENV=production para manter as proteções HTTP ativas.');
  }
  if (!/(homolog|staging)/i.test(dbPath) || !/(homolog|staging)/i.test(uploadDir)) {
    failProductionConfig('DB_PATH e UPLOAD_DIR da homologação devem conter homolog ou staging no caminho.');
  }
  if (!fs.existsSync(dbPath) || !fs.statSync(dbPath).isFile()) {
    failProductionConfig('O banco sanitizado de homologação não existe. A aplicação não criará um banco vazio.');
  }
  if (!fs.existsSync(uploadDir) || !fs.statSync(uploadDir).isDirectory()) {
    failProductionConfig('UPLOAD_DIR da homologação deve existir antes da inicialização.');
  }
  if (!/(homolog|staging)/i.test(fs.realpathSync(dbPath))
      || !/(homolog|staging)/i.test(fs.realpathSync(uploadDir))) {
    failProductionConfig('Os destinos reais de DB_PATH e UPLOAD_DIR devem permanecer isolados na homologação.');
  }
  if (process.env.SMTP_USER || process.env.SMTP_PASS) {
    failProductionConfig('SMTP deve permanecer desativado na homologação para impedir e-mails reais.');
  }
  if (!process.env.STUDENT_ASSESSMENT_ACCESS_SECRET && !process.env.CLASS_ENTRY_CODE_SECRET) {
    failProductionConfig(
      'STUDENT_ASSESSMENT_ACCESS_SECRET ou CLASS_ENTRY_CODE_SECRET deve ser configurado na homologação.',
    );
  }
}

let deploymentMetadata;
try {
  deploymentMetadata = readDeploymentMetadata(deploymentMetadataPath);
} catch (error) {
  failProductionConfig(`Metadados de release da Hostinger inválidos: ${error.message}`);
}

module.exports = {
  isProduction,
  appEnvironment,
  governanceAdminEnabled: process.env.GOVERNANCE_ADMIN_ENABLED === 'true',
  port: parseInt(process.env.PORT, 10) || 3001,
  jwtSecret: process.env.JWT_SECRET || 'default-secret-change-me',
  classEntryCodeSecret: process.env.CLASS_ENTRY_CODE_SECRET || null,
  studentAssessmentAccessSecret: process.env.STUDENT_ASSESSMENT_ACCESS_SECRET
    || process.env.CLASS_ENTRY_CODE_SECRET
    || null,
  dbPath,
  uploadDir,
  corsOrigin: process.env.CORS_ORIGIN || 'http://localhost:5173',
  jwtExpiresIn: '24h',
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: parseInt(process.env.SMTP_PORT, 10) || 587,
    user: process.env.SMTP_USER || '',
    pass: process.env.SMTP_PASS || '',
    from: process.env.SMTP_FROM || 'noreply@matteca.com.br',
  },
  appUrl: process.env.APP_URL || 'http://localhost:5173',
  deploymentMetadata,
};
