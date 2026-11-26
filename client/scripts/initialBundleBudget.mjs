import { gzipSync } from 'node:zlib';

// Soma entradas e dependências estáticas, sem contar chunks lazy/worker.
// Gzip é uma estimativa de tamanho, não medição de rede ou tempo de carregamento.
export function measureInitialBundle(bundle) {
  const visited = new Set();
  let rawBytes = 0;
  let gzipBytes = 0;
  const visit = file => {
    if (visited.has(file)) return;
    const chunk = bundle[file];
    if (!chunk || chunk.type !== 'chunk') throw new Error(`Dependência inicial ausente: ${file}`);
    visited.add(file);
    rawBytes += Buffer.byteLength(chunk.code);
    gzipBytes += gzipSync(chunk.code).length;
    chunk.imports.forEach(visit);
  };
  const entries = Object.values(bundle).filter(chunk => chunk.type === 'chunk' && chunk.isEntry);
  if (!entries.length) throw new Error('Build sem entrada JavaScript para medir.');
  entries.forEach(chunk => visit(chunk.fileName));
  return { rawBytes, gzipBytes, files: [...visited].sort() };
}

export function initialBundleBudget({ maxRawBytes = 450_000, maxGzipBytes = 150_000 } = {}) {
  return {
    name: 'labmathic-initial-bundle-budget',
    apply: 'build',
    generateBundle: {
      order: 'post',
      handler(_options, bundle) {
        const metrics = measureInitialBundle(bundle);
        if (metrics.rawBytes > maxRawBytes || metrics.gzipBytes > maxGzipBytes) {
          this.error(`JavaScript inicial excedeu o orçamento: ${metrics.rawBytes}/${maxRawBytes} bytes; gzip ${metrics.gzipBytes}/${maxGzipBytes} bytes. Revise imports antecipados antes de ampliar o limite.`);
        }
        this.emitFile({ type: 'asset', fileName: 'bundle-budget.json',
          source: JSON.stringify({ ...metrics, maxRawBytes, maxGzipBytes }, null, 2) });
      },
    },
  };
}
