const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assertLoopbackEndpoint,
  awsV4Headers,
  resolveReportPath,
} = require('../scripts/ci/offsiteBackupRehearsal');

test('ensaio S3 aceita somente HTTP loopback sem credenciais ou caminhos', () => {
  assert.equal(assertLoopbackEndpoint('http://127.0.0.1:5000').hostname, '127.0.0.1');
  assert.equal(assertLoopbackEndpoint('http://localhost:5000').hostname, 'localhost');
  assert.throws(
    () => assertLoopbackEndpoint('https://storage.example.com'),
    /somente endpoint HTTP loopback/
  );
  assert.throws(
    () => assertLoopbackEndpoint('http://192.168.1.10:5000'),
    /somente endpoint HTTP loopback/
  );
  assert.throws(
    () => assertLoopbackEndpoint('http://user:pass@127.0.0.1:5000'),
    /nao pode conter credenciais/
  );
  assert.throws(
    () => assertLoopbackEndpoint('http://127.0.0.1:5000/production'),
    /nao pode conter credenciais/
  );
});

test('relatorio do ensaio permanece dentro do workspace', () => {
  assert.match(resolveReportPath('.ci-artifacts/backup.json'), /\.ci-artifacts[\\/]backup\.json$/);
  assert.throws(
    () => resolveReportPath('../../../outside.json'),
    /deve permanecer dentro do workspace/
  );
});

test('assinatura de criacao do bucket nao inclui a chave secreta', () => {
  const headers = awsV4Headers({
    method: 'PUT',
    url: new URL('http://127.0.0.1:5000/labmathic-synthetic'),
    accessKeyId: 'synthetic-access',
    secretAccessKey: 'synthetic-secret-not-for-output',
  });

  assert.match(headers.authorization, /^AWS4-HMAC-SHA256 Credential=synthetic-access\//);
  assert.match(headers.authorization, /SignedHeaders=host;x-amz-content-sha256;x-amz-date/);
  assert.doesNotMatch(headers.authorization, /synthetic-secret-not-for-output/);
  assert.equal(headers['x-amz-content-sha256'].length, 64);
});
