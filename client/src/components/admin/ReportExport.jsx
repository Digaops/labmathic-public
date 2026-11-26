import { useEffect, useRef, useState } from 'react';
import ModalLayer from '../ModalLayer';
import api from '../../services/api';
import { csvTypes } from '../../services/adminReportsView.mjs';
import { readPanel, readButton, readPrimary, readField } from './AdminReadParts';

export default function ReportExport({ onClose }) {
  const [type, setType] = useState('materials'), [consent, setConsent] = useState(false), [status, setStatus] = useState('idle'), [message, setMessage] = useState('');
  const current = useRef(null), alive = useRef(false), select = useRef(null), alert = useRef(null), urls = useRef(new Map());
  useEffect(() => { alive.current = true; select.current?.focus(); return () => { alive.current = false; current.current?.abort(); for (const [url, timer] of urls.current) { clearTimeout(timer); URL.revokeObjectURL(url); } urls.current.clear(); }; }, []);
  useEffect(() => { if (message) { alert.current?.focus({ preventScroll: true }); alert.current?.scrollIntoView({ block: 'nearest' }); } }, [message]);
  function cancel() { current.current?.abort(); onClose(); }
  async function download(e) {
    e.preventDefault(); if (current.current || !consent) return;
    const controller = new AbortController(); current.current = controller; setStatus('loading'); setMessage('Preparando o arquivo…');
    try {
      const response = await api.get('/reports/export/' + type, { responseType: 'blob', signal: controller.signal, timeout: 30000 });
      if (!alive.current || controller.signal.aborted) return;
      if (!String(response.headers['content-type']).toLowerCase().startsWith('text/csv') || !response.data.size) throw Error('Arquivo inválido');
      const url = URL.createObjectURL(response.data);
      const timer = setTimeout(() => { URL.revokeObjectURL(url); urls.current.delete(url); }, 30000); urls.current.set(url, timer);
      const a = document.createElement('a'); a.href = url; a.download = `relatorio-${type}.csv`; document.body.appendChild(a); a.click(); a.remove();
      setStatus('success'); setMessage('Arquivo enviado ao navegador. Confira a pasta de downloads ou escolha onde salvar.');
    } catch (error) { if (alive.current && !controller.signal.aborted) { setStatus('error'); setMessage('Não foi possível preparar o arquivo. Você pode tentar novamente.'); } }
    finally { if (current.current === controller) current.current = null; }
  }
  return <ModalLayer label="Baixar relatório" onClose={cancel} className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-3 backdrop-blur-sm"><section data-admin-read className={readPanel + ' w-full max-w-lg p-4 text-slate-900 dark:text-slate-100'}>
    <header className="mb-3 flex items-center justify-between gap-2"><h2 className="text-lg font-bold">Baixar relatório</h2><button type="button" className={readButton} onClick={cancel}>Fechar</button></header>
    <form onSubmit={download} className="space-y-3"><label className="block text-sm font-semibold" htmlFor="report-export">Dados do arquivo</label><select ref={select} id="report-export" className={readField} value={type} disabled={status === 'loading'} onChange={e => { setType(e.target.value); setConsent(false); setMessage(''); setStatus('idle'); }}>{Object.entries(csvTypes).map(([key, item]) => <option key={key} value={key}>{item.label}</option>)}</select>
      <p className="text-sm leading-6">{csvTypes[type].scope}</p><p className="text-sm leading-6">Formato CSV, para abrir em planilhas. Compartilhe apenas com quem pode consultar esses dados.</p>
      <label className="flex min-h-11 items-start gap-2 py-2 text-sm leading-6"><input type="checkbox" className="mt-1 h-5 w-5 shrink-0" checked={consent} disabled={status === 'loading'} onChange={e => setConsent(e.target.checked)} />Entendi quais dados serão baixados e cuidarei do compartilhamento.</label>
      {message && <p ref={alert} tabIndex={-1} role={status === 'error' ? 'alert' : 'status'} className="rounded-xl bg-slate-100 p-3 text-sm leading-6 dark:bg-white/5">{message}</p>}
      <footer className="flex flex-wrap justify-end gap-2"><button type="button" className={readButton} onClick={cancel}>{status === 'loading' ? 'Cancelar consulta' : 'Voltar'}</button><button type="submit" className={readPrimary} disabled={!consent || status === 'loading' || status === 'success'}>{status === 'loading' ? 'Preparando…' : status === 'success' ? 'Enviado ao navegador' : 'Baixar CSV'}</button></footer>
    </form>
  </section></ModalLayer>;
}
