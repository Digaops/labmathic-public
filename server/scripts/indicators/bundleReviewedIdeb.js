// Packages only the already-reviewed public batch; no network or database access.
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { validatePrepared } = require('../../src/services/municipalIndicators');
const BATCH_ID = '630a121381c0121aeabdf8a9da10feb5b41f962afa7fb335262f9f3ad17fe758';
const ARTIFACT = 'municipal-ideb-2025.json.gz';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function run(args) {
  assert.equal(args.length, 1, 'Informe o batch.json público já revisado.');
  const bytes = fs.readFileSync(args[0]);
  assert.ok(bytes.length <= 4 * 1024 * 1024);
  const batch = validatePrepared(JSON.parse(bytes));
  assert.equal(batch.id, BATCH_ID, 'Somente a edição revisada pode ser empacotada.');
  const folder = path.resolve(__dirname, '../../catalogs');
  const artifact = path.join(folder, ARTIFACT), manifestPath = path.join(folder, 'municipal-ideb-2025.manifest.json');
  assert.ok(!fs.existsSync(artifact) && !fs.existsSync(manifestPath), 'Artefato existente; sobrescrita recusada.');
  const packed = zlib.gzipSync(bytes, { level: 9 });
  const manifest = { version: 1, batchId: batch.id, artifact: ARTIFACT,
    artifactBytes: packed.length, artifactSha256: sha(packed), expandedBytes: bytes.length,
    expandedSha256: sha(bytes), rowCount: batch.rows.length, placeCount: batch.places.length,
    approvalReference: 'docs/releases/2026-09-14-functional-homologation.md' };
  fs.writeFileSync(artifact, packed, { flag: 'wx' });
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx' });
  console.log(JSON.stringify(manifest, null, 2));
}
if (require.main === module) { try { run(process.argv.slice(2)); } catch (error) { console.error(error.message); process.exitCode = 1; } }
module.exports = { BATCH_ID, ARTIFACT, run };
