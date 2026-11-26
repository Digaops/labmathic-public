const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

function createTestEnvironment(inherited = process.env) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'labmathic-test-run-'));
  const uploads = path.join(root, 'uploads');
  fs.mkdirSync(uploads);
  return { root, env: { ...inherited, NODE_ENV: 'test', APP_ENV: 'development',
    DB_PATH: path.join(root, 'fallback.sqlite'), UPLOAD_DIR: uploads } };
}

function removeTestEnvironment(root) {
  const resolved = path.resolve(root);
  if (path.dirname(resolved) !== path.resolve(os.tmpdir())
    || !path.basename(resolved).startsWith('labmathic-test-run-')
    || fs.lstatSync(resolved).isSymbolicLink()) throw new Error('Diretório de teste inesperado; limpeza recusada.');
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

if (require.main === module) {
  const isolated = createTestEnvironment();
  try {
    console.info('[test] Banco e uploads padrão isolados em diretório temporário.');
    const result = spawnSync(process.execPath, ['--test', ...process.argv.slice(2)], {
      cwd: path.resolve(__dirname, '../..'), env: isolated.env, stdio: 'inherit',
    });
    process.exitCode = result.status ?? 1;
    if (result.error) console.error('[test] Não foi possível executar a suíte.');
  } finally {
    try { removeTestEnvironment(isolated.root); }
    catch { console.error('[test] Limpeza temporária não concluída; nenhum diretório externo foi removido.'); process.exitCode = 1; }
  }
}

module.exports = { createTestEnvironment, removeTestEnvironment };
