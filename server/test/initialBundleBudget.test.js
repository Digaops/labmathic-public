const test = require('node:test');
const assert = require('node:assert/strict');
let measureInitialBundle;
let initialBundleBudget;
test.before(async () => ({ measureInitialBundle, initialBundleBudget } = await import('../../client/scripts/initialBundleBudget.mjs')));
function fixture() {
  const chunk = (fileName, imports = [], isEntry = false) => ({
    type: 'chunk', fileName, imports, isEntry, code: 'export const value = "teste";',
  });
  return { 'index.js': { ...chunk('index.js', ['vendor.js', 'ui.js'], true), dynamicImports: ['pdf.js'] },
    'vendor.js': chunk('vendor.js', ['ui.js']), 'ui.js': chunk('ui.js', ['vendor.js']),
    'pdf.js': { ...chunk('pdf.js'), code: 'x'.repeat(600000) } };
}
test('orçamento inclui imports transitivos uma vez, tolera ciclos e não inclui lazy', () => {
  const bundle = fixture();
  const metrics = measureInitialBundle(bundle);
  assert.deepEqual(metrics.files, ['index.js', 'ui.js', 'vendor.js']);
  assert.equal(metrics.rawBytes, Buffer.byteLength(bundle['index.js'].code) * 3);
  assert.ok(metrics.gzipBytes > 0);
});
test('build registra métricas e falha ao estourar qualquer limite', () => {
  const bundle = fixture(); let emitted;
  const context = { error(message) { throw new Error(message); }, emitFile(asset) { emitted = asset; } };
  initialBundleBudget().generateBundle.handler.call(context, {}, bundle);
  assert.equal(emitted.fileName, 'bundle-budget.json');
  assert.equal(JSON.parse(emitted.source).rawBytes, measureInitialBundle(bundle).rawBytes);
  for (const options of [{ maxRawBytes: 1 }, { maxGzipBytes: 1 }]) {
    assert.throws(() => initialBundleBudget(options).generateBundle.handler.call(context, {}, bundle), /excedeu o orçamento/);
  }
});
test('entrada ou import ausente não produz falsa aprovação', () => {
  assert.throws(() => measureInitialBundle({}), /sem entrada/);
  const bundle = fixture(); delete bundle['vendor.js'];
  assert.throws(() => measureInitialBundle(bundle), /ausente/);
});

test('build usa runtime de produção mesmo no CI de testes sem alterar o processo pai', async () => {
  const { buildInvocation } = await import('../../client/scripts/build.mjs');
  for (const nodeEnv of ['test', 'development', 'production', undefined]) {
    const environment = { CI: 'true', NODE_ENV: nodeEnv };
    const args = ['--outDir', '../tmp/isolated-build', '--manifest'];
    const invocation = buildInvocation(args, environment);
    assert.equal(invocation.options.env.NODE_ENV, 'production');
    assert.equal(invocation.options.env.CI, 'true');
    assert.equal(environment.NODE_ENV, nodeEnv);
    assert.equal(invocation.options.shell, false);
    assert.deepEqual(invocation.args.slice(1), ['build', ...args]);
  }
});
