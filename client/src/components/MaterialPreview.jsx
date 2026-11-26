import { lazy, Suspense, useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import { materialPreview, externalMaterialUrl } from '../services/materialView.mjs';
import { materialButton as button } from './MaterialResourceState';

const PDFViewer = lazy(() => import('./PDFViewer'));
const videoFrame = 'aspect-video w-full max-h-[max(10rem,calc(100svh-20rem))] bg-black';

export default function MaterialPreview({ material, fileUrl, userRole, restrictFeatures = false, shared = false, draft = false, onRetry }) {
  const preview = materialPreview(material, fileUrl);
  return <PreviewContent key={`${preview.kind}:${preview.url}`} preview={preview} material={material} fileUrl={fileUrl}
    userRole={userRole} restrictFeatures={restrictFeatures} shared={shared} draft={draft} onRetry={onRetry} />;
}

function PreviewContent({ preview, material, fileUrl, userRole, restrictFeatures, shared, draft, onRetry }) {
  const [failed, setFailed] = useState(false);
  const videoRef = useRef(null);
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      // Stop playback and release the media resource when leaving/changing files.
      if (video) { video.pause(); video.removeAttribute('src'); video.load(); }
    };
  }, [failed]);
  if (preview.kind === 'pdf') return <Suspense fallback={<p role="status" className="p-4 text-sm text-slate-700 dark:text-slate-200">Preparando a leitura do PDF…</p>}><PDFViewer fileUrl={preview.url} title={material.title} userRole={userRole} restrictFeatures={restrictFeatures} /></Suspense>;
  if (!failed && preview.kind === 'image') return <img src={preview.url} alt={material.title} onError={() => setFailed(true)} className="mx-auto max-h-[80svh] max-w-full object-contain" />;
  if (preview.kind === 'youtube') return <iframe tabIndex={0} className={videoFrame} src={preview.url} title={material.title}
    referrerPolicy="no-referrer" allow="encrypted-media; picture-in-picture" allowFullScreen />;
  if (!failed && preview.kind === 'video') return <video tabIndex={0} ref={videoRef} controls playsInline preload="metadata" src={preview.url}
    onError={() => setFailed(true)} className={videoFrame + ' object-contain'} aria-label={material.title}><track kind="captions" /></video>;

  const external = externalMaterialUrl(material.external_url);
  const title = failed ? 'Não foi possível abrir a prévia' : fileUrl ? 'Este formato não tem prévia aqui'
    : external ? 'Material disponível em outro site' : 'Arquivo não disponível para leitura';
  return <div className="p-4" role={failed ? 'alert' : undefined}>
    <h2 className="flex items-center gap-2 font-semibold text-slate-900 dark:text-white"><FileText size={20} aria-hidden="true" />{title}</h2>
    <p className="mt-2 text-sm leading-6 text-slate-600 dark:text-slate-300">{failed
      ? 'O arquivo pode estar indisponível ou não ser compatível com este navegador. Confira sua conexão e tente novamente.'
      : !fileUrl && external ? 'Use “Abrir no site de origem” acima para consultar o conteúdo.'
      : fileUrl && shared ? 'Você pode tentar baixar o material pelo botão acima.'
      : fileUrl && draft ? 'Use “Abrir em outra aba” para conferir o arquivo antes de publicar.'
      : fileUrl && userRole === 'admin' ? 'Você pode baixar o arquivo na área “Gerenciar material”, abaixo.'
      : shared ? 'Peça a quem compartilhou uma versão disponível para leitura.' : 'Peça à administração uma versão disponível para leitura.'}</p>
    {failed && onRetry && <button type="button" className={button + ' mt-2'} onClick={onRetry}>{shared ? 'Conferir link e tentar novamente' : 'Conferir arquivo e tentar novamente'}</button>}
  </div>;
}
