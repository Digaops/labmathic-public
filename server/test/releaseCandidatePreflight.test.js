const test = require('node:test');
const assert = require('node:assert/strict');
const { isSourcePath, secretIndicators } = require('../scripts/ci/releaseCandidatePreflight');

test('inventário recusa bancos, segredos, builds, uploads e travessia de diretório', () => {
  for (const file of ['tmp/report.json', 'client/dist/index.html', 'server/data/a.json', 'server/uploads/file.pdf',
    'server/backups/manifest.json', 'server/.env', '.env.production', 'a.sqlite-wal', 'a.db', 'a.pem', 'a.key',
    'a.zip', '.git/config', '../outside', '/outside', 'C:/outside', 'client/../outside', 'client//a',
    'client\\file.js', '.hostinger-release.json']) assert.equal(isSourcePath(file), false, file);
  for (const file of ['.gitignore', 'package.json', 'server/package-lock.json',
    'client/src/pages/Login.jsx', 'docs/releases/candidate.json']) assert.equal(isSourcePath(file), true, file);
});

test('triagem de segredos indica a classe sem divulgar o valor e aceita fixtures sintéticas', () => {
  assert.deepEqual(secretIndicators('const secret = process.env.JWT_SECRET;'), []);
  assert.deepEqual(secretIndicators('synthetic-password-for-unit-tests'), []);
  assert.deepEqual(secretIndicators('-----BEGIN ' + 'PRIVATE KEY-----'), ['private-key']);
  assert.deepEqual(secretIndicators('ghp_' + 'a'.repeat(36)), ['github-token']);
  assert.deepEqual(secretIndicators('AKIA' + 'A'.repeat(16)), ['aws-access-key']);
  assert.deepEqual(secretIndicators('https://' + 'user:secret@example.invalid'), ['credential-url']);
});
