// A session owns exactly one loading task (and its PDF.js worker). Stale page
// requests never touch the canvas; renders are serialized before reusing it.
export function pdfPageText(content) {
  if (!Array.isArray(content?.items)) throw new Error('Texto da página indisponível.');
  // PDF.js provides the source order and explicit line endings. Do not infer
  // headings, tables, image descriptions, reading order or OCR from the canvas.
  return content.items.filter(item => typeof item?.str === 'string')
    .map(item => item.str + (item.hasEOL ? '\n' : '')).join('').trim();
}

export function createPdfSession({ getDocument, url, onLoaded, onError, onBusy, onText }) {
  let closed = false;
  let revision = 0;
  let document;
  let renderTask;
  let canvas;
  let chain = Promise.resolve();
  let disposal;
  let textPage = null;
  let textRevision = 0;
  let textTask;
  const pageUses = new Map();

  const retainPage = page => pageUses.set(page, (pageUses.get(page) || 0) + 1);
  const releasePage = page => {
    if (!page) return;
    const remaining = (pageUses.get(page) || 1) - 1;
    if (remaining) { pageUses.set(page, remaining); return; }
    pageUses.delete(page);
    try { page.cleanup(); } catch { /* Document may already be destroyed. */ }
  };
  const currentText = (pageNumber, request) => !closed && pageNumber === textPage && request === textRevision;
  const beginText = (pageNumber, force = false) => {
    if (onText && (force || textPage !== pageNumber)) {
      textPage = pageNumber; textRevision += 1; textTask = null;
      onText({ pageNumber, status: 'loading', text: '' });
    }
    return textRevision;
  };
  const extractText = (page, pageNumber, request) => {
    if (!onText || !currentText(pageNumber, request)) return Promise.resolve();
    if (textTask) return textTask;
    retainPage(page);
    textTask = Promise.resolve().then(() => page.getTextContent()).then(content => {
      const text = pdfPageText(content);
      if (currentText(pageNumber, request)) onText({ pageNumber, status: text ? 'ready' : 'empty', text });
    }).catch(() => {
      if (currentText(pageNumber, request)) onText({ pageNumber, status: 'error', text: '' });
    }).finally(() => releasePage(page));
    return textTask;
  };
  const loadingTask = getDocument({ url, disableAutoFetch: false, disableStream: false });
  const loaded = loadingTask.promise.then(pdf => {
    if (closed) return;
    document = pdf;
    onLoaded(pdf.numPages);
  }).catch(() => {
    if (!closed) {
      onError('Não foi possível carregar o PDF.');
      dispose();
    }
  });

  function render(pageNumber, target, container) {
    const request = ++revision;
    renderTask?.cancel();
    const current = () => !closed && request === revision;
    if (!document || !target || closed) return Promise.resolve();
    const textRequest = beginText(pageNumber);
    onBusy(true);
    chain = chain.then(async () => {
      let page;
      try {
        if (!current()) return;
        page = await document.getPage(pageNumber);
        retainPage(page);
        if (!current()) return;
        // Text extraction has its own revision and does not hold the canvas
        // queue. A slow extraction must not prevent reading the next page.
        extractText(page, pageNumber, textRequest);
        canvas = target;
        const style = container ? window.getComputedStyle(container) : null;
        const padding = style ? parseFloat(style.paddingLeft) + parseFloat(style.paddingRight) : 32;
        const width = Math.max((container?.clientWidth || 1000) - padding - 2, 1);
        const base = page.getViewport({ scale: 1 });
        const viewport = page.getViewport({ scale: Math.min(width / base.width, 2.2) });
        const outputScale = Math.min(window.devicePixelRatio || 1, 2,
          Math.sqrt(16000000 / (viewport.width * viewport.height)));
        canvas.width = Math.max(1, Math.floor(viewport.width * outputScale));
        canvas.height = Math.max(1, Math.floor(viewport.height * outputScale));
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        canvas.style.height = `${Math.floor(viewport.height)}px`;
        const context = canvas.getContext('2d');
        context.setTransform(outputScale, 0, 0, outputScale, 0, 0);
        context.clearRect(0, 0, canvas.width, canvas.height);
        renderTask = page.render({ canvasContext: context, viewport });
        await renderTask.promise;
      } catch (error) {
        if (current() && error?.name !== 'RenderingCancelledException') onError('Não foi possível renderizar esta página do PDF.');
      } finally {
        renderTask = null;
        // Release only after both paint and text users finish with this page.
        releasePage(page);
        if (current()) onBusy(false);
      }
    });
    return chain;
  }

  async function retryText(pageNumber) {
    if (!onText || closed || !document || pageNumber !== textPage) return;
    const request = beginText(pageNumber, true);
    let page;
    try {
      page = await document.getPage(pageNumber);
      retainPage(page);
      if (currentText(pageNumber, request)) await extractText(page, pageNumber, request);
    } catch {
      if (currentText(pageNumber, request)) onText({ pageNumber, status: 'error', text: '' });
    } finally { releasePage(page); }
  }

  function dispose() {
    if (closed) return disposal;
    closed = true;
    revision += 1;
    textRevision += 1; textPage = null; textTask = null;
    renderTask?.cancel();
    document = null;
    if (canvas) { canvas.width = 0; canvas.height = 0; canvas = null; }
    // LoadingTask.destroy also handles close-before-load and terminates its worker.
    disposal = Promise.resolve().then(() => loadingTask.destroy()).catch(() => {});
    return disposal;
  }
  return { loaded, render, retryText, dispose };
}
