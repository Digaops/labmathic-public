const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const { readDeploymentMetadata } = require('../src/deploymentMetadata');
const { validPreparation } = require('../src/deploymentMetadata');

test('preparação numérica exige opt-in v2, schema 39, dois hashes distintos e contrato fechado', t => {
  const preparation = { version:2, teacherHash:'a'.repeat(64), numericReviewerHash:'b'.repeat(64) };
  assert.equal(validPreparation(preparation, 39), true);
  for (const candidate of [
    {...preparation,version:1}, {...preparation,version:3}, {...preparation,numericReviewerHash:preparation.teacherHash},
    {...preparation,numericReviewerHash:'admin@example.invalid'}, {...preparation,numericReviewerHash:undefined},
    {...preparation,extra:true}, {...preparation,numericReviewerHash:'B'.repeat(64)},
  ]) assert.equal(validPreparation(candidate,39), false);
  assert.equal(validPreparation(preparation,38),false);
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'numeric-metadata-'));
  t.after(() => fs.rmSync(root,{recursive:true,force:true}));
  const file = path.join(root,'metadata.json');
  fs.writeFileSync(file,JSON.stringify({sourceSha:'a'.repeat(40),pullRequest:3,targetBranch:'homologacao',schemaVersion:39,preparation}));
  assert.deepEqual(readDeploymentMetadata(file).preparation,preparation);
  assert.equal(Object.isFrozen(readDeploymentMetadata(file).preparation),true);
});

test('aceita somente o metadado técnico esperado da homologação', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-release-'));
  const metadataPath = path.join(tempRoot, 'release.json');

  try {
    fs.writeFileSync(metadataPath, JSON.stringify({
      sourceSha: 'a'.repeat(40),
      pullRequest: 27,
      targetBranch: 'homologacao',
    }));

    assert.deepEqual(readDeploymentMetadata(metadataPath), {
      sourceSha: 'a'.repeat(40),
      pullRequest: 27,
      targetBranch: 'homologacao',
    });
    assert.equal(Object.isFrozen(readDeploymentMetadata(metadataPath)), true);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('registra a versão máxima do schema sem invalidar metadados legados', () => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-release-'));
  const metadataPath = path.join(tempRoot, 'release.json');

  try {
    fs.writeFileSync(metadataPath, JSON.stringify({
      sourceSha: 'd'.repeat(40),
      pullRequest: 28,
      targetBranch: 'homologacao',
      schemaVersion: 7,
    }));
    assert.deepEqual(readDeploymentMetadata(metadataPath), {
      sourceSha: 'd'.repeat(40),
      pullRequest: 28,
      targetBranch: 'homologacao',
      schemaVersion: 7,
    });
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
});

test('recusa SHA, branch, campos extras e links simbólicos', (t) => {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-release-'));
  const metadataPath = path.join(tempRoot, 'release.json');

  t.after(() => fs.rmSync(tempRoot, { recursive: true, force: true }));

  for (const invalidMetadata of [
    { sourceSha: 'curto', pullRequest: 1, targetBranch: 'homologacao' },
    { sourceSha: 'b'.repeat(40), pullRequest: 1, targetBranch: 'modulo-banco-questoes' },
    { sourceSha: 'b'.repeat(40), pullRequest: 1, targetBranch: 'homologacao', secret: 'x' },
    { sourceSha: 'b'.repeat(40), pullRequest: 1, targetBranch: 'homologacao', schemaVersion: 0 },
  ]) {
    fs.writeFileSync(metadataPath, JSON.stringify(invalidMetadata));
    assert.throws(() => readDeploymentMetadata(metadataPath));
  }

  if (process.platform !== 'win32') {
    const targetPath = path.join(tempRoot, 'target.json');
    fs.writeFileSync(targetPath, JSON.stringify({
      sourceSha: 'c'.repeat(40),
      pullRequest: 1,
      targetBranch: 'homologacao',
    }));
    fs.rmSync(metadataPath, { force: true });
    fs.symlinkSync(targetPath, metadataPath);
    assert.throws(() => readDeploymentMetadata(metadataPath), /simbólico/);
  }
});

test('preparação só aceita versão e hash do professor com schema compatível', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilot-metadata-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'release.json');
  const base = { sourceSha: 'a'.repeat(40), pullRequest: 3, targetBranch: 'homologacao', schemaVersion: 26 };
  for (const preparation of [null, [], {}, { version: 2, teacherHash: 'c'.repeat(64) },
    { version: 1, teacherHash: 'email@example.invalid' }, { version: 1, teacherHash: 'c'.repeat(64), enabled: true }]) {
    fs.writeFileSync(file, JSON.stringify({ ...base, preparation }));
    assert.throws(() => readDeploymentMetadata(file), /preparação/);
  }
  fs.writeFileSync(file, JSON.stringify({ ...base, preparation: { version: 1, teacherHash: 'c'.repeat(64) } }));
  assert.equal(Object.isFrozen(readDeploymentMetadata(file).preparation), true);
  fs.writeFileSync(file, JSON.stringify({ ...base, schemaVersion: 25, preparation: { version: 1, teacherHash: 'c'.repeat(64) } }));
  assert.throws(() => readDeploymentMetadata(file), /preparação/);
});
