import { validReportDownload } from './pedagogicalReportView.mjs';

// Own every URL until disposal, including failed clicks and interrupted downloads.
export function createReportCsvDownload({ document, urlApi = URL, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const urls = new Map();
  let disposed = false;
  const release = url => {
    if (!urls.has(url)) return;
    clearTimer(urls.get(url)); urls.delete(url); urlApi.revokeObjectURL(url);
  };
  return {
    save(response, revision, filename) {
      if (disposed || !validReportDownload(response, revision)) throw new Error('invalid_download');
      const url = urlApi.createObjectURL(response.data);
      urls.set(url, null);
      let link;
      try {
        urls.set(url, setTimer(() => release(url), 30000));
        link = document.createElement('a'); link.href = url; link.download = filename;
        document.body.appendChild(link); link.click();
      } catch (error) { release(url); throw error; }
      finally { link?.remove(); }
    },
    dispose() { disposed = true; for (const url of urls.keys()) release(url); },
  };
}
