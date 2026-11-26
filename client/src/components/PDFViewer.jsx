import { useRef, useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight, Loader2, AlertCircle } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import { createPdfSession } from '../services/pdfSession.mjs';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export default function PDFViewer({
  fileUrl,
  title = 'Documento PDF',
  userRole,
  restrictFeatures = false,
}) {
  const shouldRestrict = restrictFeatures || userRole === 'professor';

  const containerRef = useRef(null);
  const viewerRef = useRef(null);
  const canvasRef = useRef(null);
  const sessionRef = useRef(null);
  const [retry, setRetry] = useState(0);

  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [loadingPdf, setLoadingPdf] = useState(true);
  const [loadingPage, setLoadingPage] = useState(false);
  const [error, setError] = useState('');
  const [pageText, setPageText] = useState(null);
  const textState = pageText?.source === fileUrl && pageText.pageNumber === currentPage
    ? pageText : { status: 'loading', text: '' };

  useEffect(() => {
    setCurrentPage(1);
    setTotalPages(0);
    setError('');
    setPageText(null);
    setLoadingPage(false);
    setLoadingPdf(Boolean(fileUrl));
    if (!fileUrl) return undefined;
    let session;
    try {
      session = createPdfSession({
        getDocument: pdfjsLib.getDocument,
        url: fileUrl,
        onLoaded: pages => { setTotalPages(pages); setLoadingPdf(false); },
        onError: message => { setError(message); setLoadingPdf(false); },
        onBusy: setLoadingPage,
        onText: state => setPageText({ ...state, source: fileUrl }),
      });
      sessionRef.current = session;
    } catch {
      setError('Não foi possível carregar o PDF.');
      setLoadingPdf(false);
    }
    return () => {
      if (sessionRef.current === session) sessionRef.current = null;
      session?.dispose();
    };
  }, [fileUrl, retry]);

  useEffect(() => {
    if (loadingPdf || error || !fileUrl) return undefined;
    const session = sessionRef.current;
    const render = () => session?.render(currentPage, canvasRef.current, containerRef.current);
    let timer = setTimeout(render, 100);
    let width = containerRef.current?.clientWidth;
    const observer = new ResizeObserver(([entry]) => {
      const nextWidth = entry.target.clientWidth;
      if (nextWidth === width) return;
      width = nextWidth;
      clearTimeout(timer);
      timer = setTimeout(render, 150);
    });
    if (containerRef.current) observer.observe(containerRef.current);
    return () => { clearTimeout(timer); observer.disconnect(); };
  }, [currentPage, loadingPdf, error, fileUrl, retry]);

  const goToPage = pageNum => {
    if (!loadingPage && pageNum >= 1 && pageNum <= totalPages) {
      containerRef.current?.scrollTo(0, 0);
      // Announce the pending paint immediately, including the render debounce.
      setLoadingPage(true);
      setCurrentPage(pageNum);
      // The bottom paginator also returns the outer page to the reader, below
      // the sticky application header, instead of leaving its beginning hidden.
      viewerRef.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
    }
  };

  if (!fileUrl) {
    return (
      <div className="h-[68svh] min-h-[360px] bg-neutral-100 dark:bg-neutral-800 flex items-center justify-center text-neutral-400 rounded-2xl sm:h-[78vh] lg:h-[85vh]">
        PDF não encontrado.
      </div>
    );
  }

  return (
    <div
      ref={viewerRef}
      data-pdf-viewer
      className="w-full scroll-mt-28 overflow-hidden rounded-2xl border border-neutral-200 bg-neutral-100 dark:border-neutral-700 dark:bg-neutral-900"
      onContextMenu={shouldRestrict ? (event) => event.preventDefault() : undefined}
    >
      {loadingPdf && (
        <div className="flex h-[68svh] min-h-[360px] flex-col items-center justify-center text-neutral-500 sm:h-[78vh] lg:h-[85vh]">
          <Loader2 className="mb-3 animate-spin" size={30} />
          <p className="text-sm">Carregando PDF...</p>
        </div>
      )}

      {!loadingPdf && error && (
        <div className="flex h-[68svh] min-h-[360px] flex-col items-center justify-center px-4 text-center text-red-500 sm:h-[78vh] lg:h-[85vh]">
          <AlertCircle className="mb-3" size={30} />
          <p className="text-sm font-medium">{error}</p>
          <button
            type="button"
            onClick={() => setRetry(value => value + 1)}
              className="btn-primary mt-4 min-h-11 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300"
          >
            Tentar novamente
          </button>
        </div>
      )}

      {!loadingPdf && !error && (
        <>
          {totalPages > 0 && (
            <PDFPagination
              currentPage={currentPage}
              totalPages={totalPages}
              loadingPage={loadingPage}
              onPrevious={() => goToPage(currentPage - 1)}
              onNext={() => goToPage(currentPage + 1)}
            />
          )}

          <details data-pdf-text className="border-b border-neutral-200 bg-white px-3 dark:border-neutral-700 dark:bg-neutral-800 sm:px-4">
            <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-neutral-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 dark:text-neutral-100 dark:focus-visible:outline-cyan-300">
              Ler texto da página {currentPage}
            </summary>
            <section aria-label={`Texto da página ${currentPage} de ${totalPages}`} aria-busy={textState.status === 'loading'} className="space-y-3 pb-4">
              <p className="max-w-prose text-sm leading-6 text-neutral-600 dark:text-neutral-300">Texto disponível no arquivo, na ordem fornecida pelo PDF. Imagens, tabelas e fórmulas podem precisar de uma descrição complementar.</p>
              <p role="status" className="text-sm leading-6 text-neutral-700 dark:text-neutral-200">
                {textState.status === 'loading' ? `Carregando texto da página ${currentPage}…`
                  : textState.status === 'ready' ? `Texto da página ${currentPage} disponível.`
                    : textState.status === 'empty' ? 'Esta página não contém texto extraível. Ela pode ser digitalizada, conter apenas imagens ou estar em branco. Peça uma versão acessível do material.'
                      : 'Não foi possível extrair o texto desta página. A visualização da página continua disponível.'}
              </p>
              {textState.status === 'ready' && <div role="document" tabIndex={0} dir="auto" aria-label={`Conteúdo textual da página ${currentPage}`}
                className="max-h-[36rem] overflow-auto whitespace-pre-wrap break-words rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-base leading-7 text-neutral-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-700 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-100 dark:focus-visible:outline-cyan-300 [overflow-wrap:anywhere]">
                {textState.text}
              </div>}
              {textState.status === 'error' && <button type="button" className="btn-outline min-h-11" onClick={() => sessionRef.current?.retryText(currentPage)}>Tentar carregar texto novamente</button>}
            </section>
          </details>

          <div
            ref={containerRef}
            role="region"
            tabIndex={0}
            aria-busy={loadingPage}
            className="relative flex h-[68svh] min-h-[360px] justify-center overflow-auto bg-neutral-200 p-3 dark:bg-neutral-950 sm:h-[78vh] sm:p-5 lg:h-[85vh] lg:p-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300"
            aria-label={title}
          >
            {loadingPage && (
              <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-xl bg-white/90 px-3 py-2 text-xs text-neutral-500 shadow dark:bg-neutral-800/90">
                <Loader2 className="animate-spin" size={14} />
                Carregando página...
              </div>
            )}

            <canvas
              ref={canvasRef}
              role="img"
              aria-label={`Página ${currentPage} de ${totalPages}: ${title}`}
              className="select-none rounded-sm bg-white shadow-xl"
            />
          </div>

          {totalPages > 0 && (
            <PDFPagination
              currentPage={currentPage}
              totalPages={totalPages}
              loadingPage={loadingPage}
              onPrevious={() => goToPage(currentPage - 1)}
              onNext={() => goToPage(currentPage + 1)}
              borderPosition="top"
            />
          )}
        </>
      )}
    </div>
  );
}

function PDFPagination({
  currentPage,
  totalPages,
  loadingPage,
  onPrevious,
  onNext,
  borderPosition = 'bottom',
}) {
  const borderClass = borderPosition === 'top'
    ? 'border-t border-neutral-200 dark:border-neutral-700'
    : 'border-b border-neutral-200 dark:border-neutral-700';

  return (
    <div className={`bg-white px-3 py-3 dark:bg-neutral-800 ${borderClass}`}>
      <div className="mx-auto flex max-w-md items-center justify-between gap-3 sm:justify-center sm:gap-5">
        <button
          type="button"
          onClick={onPrevious}
          disabled={currentPage <= 1 || loadingPage}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold text-neutral-700 shadow-sm transition-colors hover:border-primary-200 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-cyan-400/40 dark:hover:text-cyan-200 sm:flex-none"
          title="Página anterior"
          aria-label="Página anterior"
        >
          <ChevronLeft size={18} />
          <span className="hidden sm:inline">Anterior</span>
        </button>

        <div className="min-w-fit rounded-xl bg-neutral-100 px-3 py-2 text-center text-xs font-bold text-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 sm:text-sm">
          Página <span className="font-black">{currentPage}</span> de{' '}
          <span className="font-black">{totalPages}</span>
        </div>

        <button
          type="button"
          onClick={onNext}
          disabled={currentPage >= totalPages || loadingPage}
          className="inline-flex min-h-11 flex-1 items-center justify-center gap-1.5 rounded-xl border border-neutral-200 bg-white px-3 text-sm font-bold text-neutral-700 shadow-sm transition-colors hover:border-primary-200 hover:text-primary-600 disabled:cursor-not-allowed disabled:opacity-40 dark:border-neutral-700 dark:bg-neutral-900 dark:text-neutral-200 dark:hover:border-cyan-400/40 dark:hover:text-cyan-200 sm:flex-none"
          title="Próxima página"
          aria-label="Próxima página"
        >
          <span className="hidden sm:inline">Próxima</span>
          <ChevronRight size={18} />
        </button>
      </div>
    </div>
  );
}
