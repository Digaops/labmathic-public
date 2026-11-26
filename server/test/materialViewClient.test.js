const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const model = import('../../client/src/services/materialView.mjs');
const read = name => fs.readFileSync(path.resolve(__dirname, '../../client/src', name), 'utf8');

test('material reconhece formato sem depender do ícone pedagógico', async () => {
  const { materialKind } = await model;
  assert.equal(materialKind({ file_format: 'PDF', material_type_icon: 'file' }), 'pdf');
  for (const material_type_icon of ['pdf', 'video', 'image', 'document', null]) {
    assert.equal(materialKind({ material_type_icon }), 'document');
    assert.equal(materialKind({ file_format: 'WEBM', material_type_icon }), 'video');
    assert.equal(materialKind({ file_format: 'PNG', material_type_icon }), 'image');
  }
  assert.equal(materialKind({ file_format: 'DOCX' }), 'document');
});

test('extensão do arquivo prevalece sobre formato legado e categoria, sem mutações', async () => {
  const { materialKind, materialFormat } = await model;
  for (const [extension, kind] of [['pdf', 'pdf'], ['mp4', 'video'], ['webm', 'video'], ['mov', 'video'], ['ogg', 'video'],
    ['jpg', 'image'], ['jpeg', 'image'], ['png', 'image'], ['webp', 'image'], ['gif', 'image'], ['svg', 'image'], ['docx', 'document'], ['html', 'document'], ['mp3', 'document']]) {
    const data = Object.freeze({ file_path: '/uploads/Atividade.' + extension.toUpperCase(), file_format: 'PDF', material_type_icon: 'pdf' });
    assert.equal(materialKind(data), kind); assert.equal(materialFormat(data), extension.toUpperCase());
  }
  assert.equal(materialKind({ file_path: 'https://example.invalid/VIDEO.webm?download=arquivo.pdf#t=4', file_format: 'PDF' }), 'video');
  assert.equal(materialKind({ file_path: 'a.html', file_format: 'PDF' }), 'document');
  assert.equal(materialKind({ file_path: 'a.desconhecido', file_format: 'PDF' }), 'document');
});

test('formatos legados sem extensão mantêm fallback explícito, nunca pelo ícone', async () => {
  const { materialKind } = await model;
  for (const [file_format, kind] of [[' pdf ', 'pdf'], ['.webm', 'video'], ['video/mp4', 'video'], ['video/quicktime', 'video'], ['image/svg+xml', 'image'], ['application/pdf', 'pdf'], ['', 'document']])
    assert.equal(materialKind({ file_path: 'arquivo-sem-extensao', file_format, material_type_icon: 'image' }), kind);
});

test('prévia prioriza anexo e mantém links externos separados sem iframe genérico', async () => {
  const { materialPreview } = await model;
  const external_url = 'https://www.youtube.com/watch?v=abcdefghijk';
  assert.deepEqual(materialPreview({ file_path: 'a.webm', external_url, material_type_icon: 'pdf' }), { kind: 'video', url: '/uploads/a.webm' });
  assert.deepEqual(materialPreview({ file_path: 'a.docx', external_url, file_format: 'PDF' }), { kind: 'document', url: '/uploads/a.docx' });
  assert.deepEqual(materialPreview({ external_url, material_type_icon: 'pdf', file_format: 'PDF' }), { kind: 'youtube', url: 'https://www.youtube-nocookie.com/embed/abcdefghijk' });
  for (const url of ['https://example.invalid/video.mp4', 'https://youtube.com.evil.invalid/watch?v=abcdefghijk', 'javascript:alert(1)', 'https://user:secret@youtube.com/watch?v=abcdefghijk'])
    assert.deepEqual(materialPreview({ external_url: url, material_type_icon: 'video' }), { kind: 'document', url: null });
  assert.deepEqual(materialPreview({ file_path: '../a.pdf', file_format: 'PDF' }), { kind: 'document', url: null });
});

test('prévia compartilhada não recupera origem externa bloqueada nem transmite segredo a terceiros', async () => {
  const { materialPreview } = await model;
  const { sharedFileUrl } = await import('../../client/src/services/publicAccess.mjs');
  const token = 'a'.repeat(64), material = { file_path: 'vídeo.webm', file_format: 'PDF' };
  assert.deepEqual(materialPreview(material, sharedFileUrl(material.file_path, token)), { kind: 'video', url: '/uploads/v%C3%ADdeo.webm?share=' + token });
  for (const file_path of ['https://example.invalid/a.pdf', '../a.pdf', 'javascript:alert(1)'])
    assert.deepEqual(materialPreview({ file_path, file_format: 'PDF' }, sharedFileUrl(file_path, token)), { kind: 'document', url: null });
  const youtube = materialPreview({ external_url: 'https://youtu.be/abcdefghijk' }, null);
  assert.equal(youtube.url.includes(token), false);
});

test('duas páginas usam o mesmo leitor, com erro explícito e descarte de vídeo', () => {
  const preview = read('components/MaterialPreview.jsx');
  for (const name of ['pages/MaterialView.jsx', 'pages/SharedMaterial.jsx']) assert.match(read(name), /<MaterialPreview/);
  assert.match(read('pages/SharedMaterial.jsx'), /restrictFeatures shared/);
  assert.match(preview, /userRole=\{userRole\} restrictFeatures=\{restrictFeatures\}/);
  assert.match(preview, /video.pause\(\); video.removeAttribute\('src'\); video.load\(\)/);
  assert.match(preview, /preload="metadata"/); assert.match(preview, /playsInline/);
  assert.match(preview, /lazy\(\(\) => import\('\.\/PDFViewer'\)\)/);
  assert.match(preview, /max-h-\[max\(10rem,calc\(100svh-20rem\)\)\]/);
  assert.match(preview, /Conferir arquivo e tentar novamente/); assert.match(preview, /Conferir link e tentar novamente/);
  assert.doesNotMatch(preview, /material_type_icon|dangerouslySetInnerHTML|autoPlay/);
});
test('material distingue respostas válidas vazias de leitura não confirmada', async () => {
  const { parseMaterial, parseFavorite, parseRating, parseComments, parseCollections } = await model;
  assert.deepEqual(parseMaterial({ id: 1, title: 'Material', topics: [] }), { id: 1, title: 'Material', topics: [] });
  assert.throws(() => parseMaterial({ id: 1, title: 'A', description: {} }));
  assert.throws(() => parseMaterial({ id: 1, title: 'A', topics: [null] }));
  assert.throws(() => parseFavorite({})); assert.equal(parseFavorite({ favorited: false }).favorited, false);
  assert.throws(() => parseRating({ average: 0, count: 0, userScore: 9 }));
  assert.doesNotThrow(() => parseRating({ average: 0, count: 0, userScore: null }));
  assert.deepEqual(parseComments([]), []); assert.throws(() => parseComments({}));
  assert.deepEqual(parseCollections([]), []); assert.throws(() => parseCollections([{ id: 1 }]));
});
test('arquivos e links não promovem esquemas ativos, credenciais ou travessia de pastas', async () => {
  const { materialFileUrl, externalMaterialUrl } = await model;
  assert.equal(materialFileUrl('a b.pdf'), '/uploads/a%20b.pdf');
  assert.equal(materialFileUrl('/uploads/a.pdf'), '/uploads/a.pdf');
  assert.equal(materialFileUrl('https://example.org/a.pdf'), 'https://example.org/a.pdf');
  for (const value of ['javascript:alert(1)', 'data:text/html,x', '../a.pdf', '/evil/path', '//example.org/a', 'a\\b.pdf']) assert.equal(materialFileUrl(value), null);
  for (const value of ['javascript:alert(1)', '//example.org', 'https://' + 'user:password@example.org']) assert.equal(externalMaterialUrl(value), null);
});
test('embed reconhece somente domínios reais do YouTube e ID válido', async () => {
  const { youtubeMaterialId } = await model;
  assert.equal(youtubeMaterialId('https://www.youtube.com/watch?v=abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeMaterialId('https://youtu.be/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeMaterialId('https://www.youtube.com/shorts/abcdefghijk'), 'abcdefghijk');
  assert.equal(youtubeMaterialId('https://youtube.com.evil.example/watch?v=abcdefghijk'), null);
  assert.equal(youtubeMaterialId('https://youtu.be/not-valid'), null);
});
test('retorno preserva consulta/página e limita destino ao contexto interno conhecido', async () => {
  const { materialReturn } = await model;
  assert.deepEqual(materialReturn({ from: '/biblioteca?search=frações&page=2', fromLabel: 'Biblioteca' }), { to: '/biblioteca?search=frações&page=2', label: 'Voltar para Biblioteca' });
  assert.equal(materialReturn({ from: '/colecoes/2' }).label, 'Voltar para o laboratório');
  for (const from of ['https://example.org', '//example.org', '/admin/usuarios', '/\\example.org']) assert.equal(materialReturn({ from }).to, '/biblioteca');
  assert.equal(materialReturn().to, '/biblioteca');
});
test('comentários são explícitos, editáveis sem hover, e exclusão pede confirmação', () => {
  const source = read('components/MaterialFeedback.jsx');
  assert.match(source, /Check } from 'lucide-react'/);
  assert.match(source, /open \? `\/comments\/material/);
  assert.match(source, /Confirmar exclusão/);
  assert.match(source, /Manter comentário/);
  assert.match(source, /evite dados de estudantes/);
  assert.doesNotMatch(source, /opacity-0|group-hover/);
});
test('ações não repetem escrita e não atualizam UI desmontada; restrições PDF preservadas', () => {
  const action = read('hooks/useMaterialAction.js');
  assert.match(action, /if \(pending.current\) return/);
  assert.match(action, /if \(!alive.current\) return/);
  assert.equal((action.match(/await write\(\)/g) || []).length, 1);
  const material = read('pages/MaterialView.jsx');
  assert.match(material, /key=\{`\$\{identity\}:\$\{id\}`\}/);
  assert.match(material, /restrictFeatures=\{user\?\.role === 'professor'\}/);
  assert.match(material, /user\?\.role === 'admin' && <MaterialManagement/);
  assert.match(material, /window.history.state.idx > 0/);
  assert.match(material, /Voltar à tela anterior/);
  assert.match(read('components/PDFViewer.jsx'), /containerRef.current\?\.scrollTo\(0, 0\)/);
  assert.match(read('components/PDFViewer.jsx'), /viewerRef.current\?\.scrollIntoView/);
});

test('avisos compartilhados cabem no celular e têm fundo escuro opaco e fechamento acessível', () => {
  const source = read('contexts/ToastContext.jsx');
  assert.match(source, /data-toasts/);
  assert.match(source, /left-4 right-4/);
  assert.match(source, /min-h-11 min-w-11/);
  assert.match(source, /focus-visible:outline/);
  assert.equal((source.match(/dark:bg-\[#[\dA-F]+\]/g) || []).length, 4);
  assert.doesNotMatch(source, /bg-secondary-50|bg-red-50|bg-primary-50/);
});
