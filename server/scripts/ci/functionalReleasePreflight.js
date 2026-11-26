// Read-only inventory for this candidate; never stages files or publishes by itself.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { isSourcePath, secretIndicators } = require('./releaseCandidatePreflight');
const { readBundledPortrait } = require('../../src/services/homologationNetworkPortrait');
const root = path.resolve(__dirname, '../../..');
const base = '537c340f534055b91cd60d5803cbd376879d7e58';
const artifact = 'server/catalogs/municipal-ideb-2025.json.gz';
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).trim();
function run() {
  assert.equal(git('branch', '--show-current'), 'codex/fase-2-crescimento-controlado');
  git('merge-base', '--is-ancestor', base, 'HEAD');
  const changed = [...new Set([...git('diff', '--name-only', '-z', base, '--').split('\0'),
    ...git('ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort();
  const preserved = changed.filter(file => file.startsWith('client/dist/'));
  const selected = changed.filter(file => !preserved.includes(file));
  const batch = readBundledPortrait();
  const files = selected.map(file => {
    assert.ok(/^(client\/src\/|server\/(src|test|scripts)\/|docs\/)/.test(file)
      || ['server/catalogs/municipal-ideb-2025.manifest.json', artifact].includes(file), 'Caminho não revisado: ' + file);
    assert.ok(isSourcePath(file));
    const resolved = path.join(root, file), stat = fs.lstatSync(resolved);
    assert.ok(stat.isFile() && !stat.isSymbolicLink() && fs.realpathSync(resolved).startsWith(fs.realpathSync(root) + path.sep));
    const bytes = fs.readFileSync(resolved);
    assert.ok(bytes.length < 1024 * 1024, 'Arquivo maior que o limite: ' + file);
    if (file !== artifact) {
      assert.equal(bytes.includes(0), false, 'Arquivo binário inesperado: ' + file);
      assert.deepEqual(secretIndicators(bytes.toString('utf8')), [], 'Possível segredo em ' + file + '; conteúdo omitido.');
      assert.ok(!/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{35,}/.test(bytes.toString('utf8')), 'Possível chave de API em ' + file);
    }
    return { path: file, bytes: bytes.length, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
  });
  return { status: 'passed', base, head: git('rev-parse', 'HEAD'), batchId: batch.id, fileCount: files.length, preserved, files };
}
if (require.main === module) { try { console.log(JSON.stringify(run(), null, 2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { run };
