import policy from '../../../shared/uploadPolicy.json' with { type: 'json' };

const limits = new Map(policy.groups.flatMap(group => group.extensions.map(ext => [ext, group.maxMiB])));
export const imageAccept = policy.imageExtensions.join(',');
export const materialAccept = [...limits.keys()].join(',');
export const imageUploadHint = `JPG, PNG, GIF ou WEBP: até ${limits.get('.png')} MB. SVG estático: até ${limits.get('.svg')} MB.`;
export const materialUploadHint = `Imagens: ${limits.get('.png')} MB; SVG estático: ${limits.get('.svg')} MB; documentos, MP3 e WAV: ${limits.get('.pdf')} MB; textos e CSV: ${limits.get('.txt')} MB; vídeos e OGG: ${limits.get('.mp4')} MB.`;

// Convenience only. Content, limits and authorization remain enforced by API.
export function uploadSelectionError(file, purpose = 'material') {
  if (!file) return null;
  const ext = /\.[^.]+$/.exec(file.name || '')?.[0].toLowerCase();
  if (!limits.has(ext) || (purpose === 'image' && !policy.imageExtensions.includes(ext))) return 'Tipo de arquivo não permitido para este campo.';
  if (!file.size) return 'O arquivo está vazio. Selecione um arquivo com conteúdo.';
  if (file.size > limits.get(ext) * 1024 * 1024) return `Arquivos ${ext.toUpperCase()} devem ter no máximo ${limits.get(ext)} MB.`;
  return null;
}
