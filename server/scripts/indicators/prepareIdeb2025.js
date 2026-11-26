// Produces a NEW local artifact; never opens the application DB or activates flags.
const fs = require('node:fs'), path = require('node:path'), assert = require('node:assert/strict');
const { prepareIdeb } = require('../../src/services/idebImport');
const { validatePrepared } = require('../../src/services/municipalIndicators');
async function run(args) {
  assert.equal(args.length, 3, 'Uso: node prepareIdeb2025.js <pasta-fontes> <tmp/retrato-prepared-NOVO> <data-coleta-ISO>');
  const [directory, target, retrievedAt] = args;
  const root = fs.realpathSync(path.resolve(__dirname, '../../..'));
  const output = path.resolve(target), expectedParent = path.join(root, 'tmp');
  assert.equal(fs.realpathSync(path.dirname(output)), expectedParent, 'Saída permitida somente em tmp do projeto.');
  assert.match(path.basename(output), /^retrato-prepared-[a-zA-Z0-9-]+$/);
  assert.ok(!fs.existsSync(output), 'A saída já existe; nenhum arquivo será sobrescrito.');
  const batch = validatePrepared(await prepareIdeb(fs.realpathSync(directory), { retrievedAt }));
  fs.mkdirSync(output, { recursive: false });
  fs.writeFileSync(path.join(output, 'batch.json'), JSON.stringify(batch), { flag: 'wx' });
  const samples = batch.rows.filter(row => ['2306405', '3550308', '1100015'].includes(row.ibgeCode));
  fs.writeFileSync(path.join(output, 'review.json'), JSON.stringify({ id: batch.id, manifest: batch.manifest, samples, publication: 'not_activated' }, null, 2), { flag: 'wx' });
  console.log(JSON.stringify({ output, id: batch.id, rowCount: batch.rows.length, municipalitiesWithData: batch.manifest.municipalityCount,
    searchableMunicipalities: batch.places.length, status: 'prepared_not_activated', realDatabaseTouched: false }));
}
if (require.main === module) run(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { run };
