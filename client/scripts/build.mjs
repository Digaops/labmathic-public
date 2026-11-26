import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// NODE_ENV=test do CI não deve selecionar o runtime de desenvolvimento do React.
// Apenas o subprocesso de build muda de ambiente; os testes continuam isolados.
export function buildInvocation(args = [], environment = process.env) {
  return {
    executable: process.execPath,
    args: [fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)), 'build', ...args],
    options: { env: { ...environment, NODE_ENV: 'production' }, stdio: 'inherit', shell: false },
  };
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const command = buildInvocation(process.argv.slice(2));
  const result = spawnSync(command.executable, command.args, command.options);
  if (result.error) console.error('Não foi possível iniciar o build do frontend.');
  process.exitCode = result.status ?? 1;
}
