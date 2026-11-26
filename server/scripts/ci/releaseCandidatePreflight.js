// Inventário somente leitura. Não executa git add/commit/push, migrações ou deploy.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
const planPath = path.join(root, 'docs/releases/2026-09-08-candidate.json');

function isSourcePath(file) {
  if (typeof file !== 'string' || !file || file.includes('\\') || path.posix.isAbsolute(file)
      || file.split('/').some((part) => !part || part === '.' || part === '..') || file.includes(':')) return false;
  if (/(^|\/)(?:tmp|node_modules|dist|uploads|backups|data|\.git)(\/|$)/i.test(file)) return false;
  if (/(^|\/)\.env(?:\.|$)/i.test(file) || /\.(?:sqlite\d*|db|pem|key|pfx|p12|zip|log)(?:-|$)/i.test(file)) return false;
  return file !== '.hostinger-release.json';
}
function secretIndicators(content) {
  const patterns = [
    ['private-key', /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/],
    ['github-token', /\bgh[pousr]_[A-Za-z0-9]{30,}\b|\bgithub_pat_[A-Za-z0-9_]{30,}\b/],
    ['aws-access-key', /\bAKIA[A-Z0-9]{16}\b/],
    ['literal-jwt', /\beyJ[A-Za-z0-9_-]{12,}\.eyJ[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\b/],
    ['credential-url', /https?:\/\/[^\s/@:]+:[^\s/@]+@/],
  ];
  return patterns.filter(([, pattern]) => pattern.test(content)).map(([label]) => label);
}
const sha = (content) => crypto.createHash('sha256').update(content).digest('hex');
function git(...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
}
function runPreflight() {
  const plan = JSON.parse(fs.readFileSync(planPath, 'utf8'));
  assert.equal(plan.version, 1);
  assert.match(plan.baseCommit, /^[a-f0-9]{40}$/);
  assert.equal(plan.branch, 'codex/fase-2-crescimento-controlado');
  assert.equal(git('branch', '--show-current'), plan.branch, 'Branch não autorizada pelo plano.');
  git('merge-base', '--is-ancestor', plan.baseCommit, 'HEAD');
  assert.ok(Array.isArray(plan.paths) && plan.paths.length);
  assert.equal(new Set(plan.paths).size, plan.paths.length, 'Caminhos duplicados no plano.');
  const selected = new Set(plan.paths);
  const changed = new Set([
    ...git('diff', '--name-only', '-z', plan.baseCommit, '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0'),
  ].filter(Boolean));
  const preservedGeneratedChanges = [...changed].filter((file) => file.startsWith('client/dist/'));
  const unreviewed = [...changed].filter((file) => !selected.has(file) && !preservedGeneratedChanges.includes(file));
  assert.deepEqual(unreviewed, [], 'Há alterações não selecionadas para revisão: ' + unreviewed.join(', '));
  const files = plan.paths.map((file) => {
    assert.ok(isSourcePath(file), 'Arquivo operacional/sensível ou caminho inválido: ' + file);
    const resolved = path.join(root, file);
    assert.ok(fs.lstatSync(resolved).isFile() && !fs.lstatSync(resolved).isSymbolicLink(), 'Arquivo deve ser regular: ' + file);
    assert.ok(fs.realpathSync(resolved).startsWith(root + path.sep), 'Arquivo fora do projeto: ' + file);
    const bytes = fs.readFileSync(resolved);
    assert.ok(bytes.length <= 1024 * 1024, 'Fonte inesperadamente grande: ' + file);
    assert.equal(bytes.includes(0), false, 'Arquivo binário não permitido: ' + file);
    const content = bytes.toString('utf8');
    assert.deepEqual(secretIndicators(content), [], 'Indicador de segredo em ' + file + ' (conteúdo omitido).');
    return { path: file, bytes: bytes.length, sha256: sha(bytes),
      normalizedLfSha256: sha(content.replaceAll('\r\n', '\n')) };
  });
  const fingerprint = sha(files.map((file) => file.path + ':' + file.normalizedLfSha256).join('\n'));
  return { status: 'source-inventory-passed', branch: plan.branch, baseCommit: plan.baseCommit,
    currentHead: git('rev-parse', 'HEAD'), fingerprint, fileCount: files.length,
    preservedGeneratedChanges, files, publicationApproved: false,
    pendingOperationalChecks: ['explicit-authorization', 'exact-sha-ci', 'current-homologation-backup-and-restore',
      'uploads-proxy-and-cache-protection', 'assessment-maintenance-window', 'post-deploy-smoke'] };
}
if (require.main === module) {
  try { console.log(JSON.stringify(runPreflight(), null, 2)); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { isSourcePath, secretIndicators, runPreflight };
