const idValid = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;

export function parseMaterial(payload) {
  if (!payload || !idValid(payload.id) || typeof payload.title !== 'string'
    || ['description', 'file_path', 'external_url', 'file_format', 'material_type_icon', 'material_type_name', 'discipline_name', 'grade_name', 'duration', 'created_at']
      .some(key => payload[key] != null && typeof payload[key] !== 'string')
    || (payload.topics != null && (!Array.isArray(payload.topics) || payload.topics.some(t => !t || !idValid(t.id) || typeof t.name !== 'string')))) {
    throw new Error('Dados de material incompletos.');
  }
  return payload;
}

export function parseFavorite(payload) {
  if (typeof payload?.favorited !== 'boolean') throw new Error('Favorito não confirmado.');
  return payload;
}
export function parseRating(payload) {
  if (!payload || !Number.isInteger(payload.count) || payload.count < 0 || !Number.isFinite(payload.average)
    || payload.average < 0 || payload.average > 5 || (payload.userScore != null && (!Number.isInteger(payload.userScore) || payload.userScore < 1 || payload.userScore > 5))) throw new Error('Avaliação não confirmada.');
  return payload;
}
export function parseComments(payload) {
  if (!Array.isArray(payload) || payload.some(c => !c || !idValid(c.id) || !idValid(c.user_id)
    || typeof c.text !== 'string' || typeof c.user_name !== 'string')) throw new Error('Comentários não confirmados.');
  return payload;
}
export function parseCollections(payload) {
  if (!Array.isArray(payload) || payload.some(c => !c || !idValid(c.id) || typeof c.name !== 'string')) throw new Error('Laboratórios não confirmados.');
  return payload;
}

export function materialFileUrl(value) {
  if (!value || typeof value !== 'string' || value.includes('\\')) return null;
  if (/^https?:\/\//i.test(value)) return externalMaterialUrl(value);
  // Local uploads are filenames, never arbitrary origins or traversal paths.
  const name = value.replace(/^\/uploads\//, '');
  if (!name || name.startsWith('/') || name.split('/').some(part => part === '..' || part === '.') || /^[a-z][a-z\d+.-]*:/i.test(name)) return null;
  return '/uploads/' + name.split('/').map(part => encodeURIComponent(part)).join('/');
}
export function externalMaterialUrl(value) {
  if (typeof value !== 'string') return null;
  try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
export function youtubeMaterialId(value) {
  const safe = externalMaterialUrl(value); if (!safe) return null;
  const url = new URL(safe); let id;
  if (url.hostname === 'youtu.be') id = url.pathname.slice(1);
  else if (['youtube.com', 'www.youtube.com', 'm.youtube.com', 'www.youtube-nocookie.com'].includes(url.hostname)) {
    id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:embed|shorts)\/([^/]+)$/.exec(url.pathname)?.[1];
  }
  return /^[\w-]{11}$/.test(id || '') ? id : null;
}
const previewFormats = {
  PDF: 'pdf',
  JPG: 'image', JPEG: 'image', PNG: 'image', GIF: 'image', WEBP: 'image', SVG: 'image',
  MP4: 'video', WEBM: 'video', OGG: 'video', MOV: 'video',
};
const legacyMimeFormats = {
  'APPLICATION/PDF': 'PDF', 'IMAGE/JPEG': 'JPEG', 'IMAGE/PNG': 'PNG', 'IMAGE/GIF': 'GIF', 'IMAGE/WEBP': 'WEBP', 'IMAGE/SVG+XML': 'SVG',
  'VIDEO/MP4': 'MP4', 'VIDEO/WEBM': 'WEBM', 'VIDEO/OGG': 'OGG', 'VIDEO/QUICKTIME': 'MOV',
};
export function materialFormat(material) {
  const safeFile = materialFileUrl(material?.file_path);
  if (safeFile) {
    // The upload filename keeps the validated extension. Legacy metadata and
    // category icons must not override it. Only remote URLs have query strings.
    const pathname = /^https?:\/\//i.test(safeFile) ? new URL(safeFile).pathname : material.file_path;
    const filename = pathname.split('/').at(-1);
    const extension = /\.([^.]+)$/.exec(filename)?.[1];
    if (extension) return extension.toUpperCase();
  }
  const legacy = typeof material?.file_format === 'string' ? material.file_format.trim().replace(/^\./, '').toUpperCase() : '';
  return legacyMimeFormats[legacy] || legacy;
}
export function materialKind(material) {
  return previewFormats[materialFormat(material)] || 'document';
}
export function materialPreview(material, fileUrl = materialFileUrl(material?.file_path)) {
  // Prefer the attachment. Never silently replace a failed/unsupported file
  // with another resource, or attach a public share token to an external URL.
  if (fileUrl) return { kind: materialKind(material), url: fileUrl };
  const youtube = !material?.file_path && youtubeMaterialId(material?.external_url);
  return youtube ? { kind: 'youtube', url: `https://www.youtube-nocookie.com/embed/${youtube}` } : { kind: 'document', url: null };
}
export function materialReturn(state) {
  const from = typeof state?.from === 'string' ? state.from : '';
  if (!/^\/(?:biblioteca|favoritos|colecoes(?:\/\d+)?)?(?:\?[^#]*)?$/.test(from) || from.includes('\\')) return { to: '/biblioteca', label: 'Voltar para Biblioteca' };
  return { to: from, label: from.startsWith('/colecoes') ? 'Voltar para o laboratório'
    : `Voltar para ${state?.fromLabel === 'Laboratórios' ? 'Laboratórios' : from.startsWith('/favoritos') ? 'Favoritos' : from === '/' ? 'Início' : 'Biblioteca'}` };
}

export { eventDay as materialDate } from './eventDates.mjs';
