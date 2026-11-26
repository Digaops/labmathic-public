import { useEffect, useRef, useState } from 'react';
import { Copy, Link2, X } from 'lucide-react';
import api from '../services/api';

export default function MaterialSharePanel({ materialId, onClose }) {
  const [links, setLinks] = useState([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [copyError, setCopyError] = useState('');
  const [confirmation, setConfirmation] = useState(null);
  const [hours, setHours] = useState('72');
  const [cursor, setCursor] = useState(null);
  const [nextCursor, setNextCursor] = useState(null);
  const [refresh, setRefresh] = useState(0);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError(''); setConfirmation(null);
    api.get(`/share/material/${materialId}`, { signal: controller.signal, timeout: 15_000,
      params: cursor ? { before: cursor } : {} })
      .then(({ data }) => {
        if (!controller.signal.aborted) { setLinks(data.links); setNextCursor(data.nextCursor); }
      })
      .catch(() => { if (!controller.signal.aborted) setError('Não foi possível consultar os links.'); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [materialId, cursor, refresh]);

  async function mutate(token) {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setNotice('');
    try {
      if (token) await api.delete(`/share/${token}`, { timeout: 15_000 });
      else await api.post('/share', { material_id: materialId, expires_hours: Number(hours) }, { timeout: 15_000 });
      if (!alive.current) return;
      setNotice(token ? 'Link revogado. Novos acessos por ele estão bloqueados.' : 'Link criado. Copie-o na lista abaixo.');
      setConfirmation(null); setCursor(null); setRefresh(value => value + 1);
    } catch (failure) {
      if (!alive.current) return;
      if (token && failure.response?.status === 404) {
        setNotice('Este link já não está disponível.');
        setConfirmation(null); setRefresh(value => value + 1);
      } else {
        // Não repetir uma escrita cuja confirmação pode ter se perdido.
        setError('Não foi possível confirmar a operação. Atualize a lista antes de tentar novamente.');
      }
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  async function copy(token) {
    setCopyError('');
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/compartilhado/${token}`);
      if (alive.current) setNotice('Link copiado.');
    } catch { if (alive.current) setCopyError('Não foi possível copiar. Selecione e copie o endereço no campo.'); }
  }
  return <section aria-label="Gerenciar compartilhamentos" className="card p-5">
    <div className="mb-3 flex items-center justify-between gap-2">
      <h3 className="text-sm font-bold">Compartilhamentos temporários</h3>
      <button type="button" disabled={busy} aria-label="Fechar compartilhamentos" onClick={onClose} className="btn-ghost p-2"><X size={16} /></button>
    </div>
    <p className="mb-4 text-xs text-slate-600 dark:text-slate-300">Qualquer pessoa com o link poderá ler este material até a validade. Revogar bloqueia novas leituras, mas não apaga cópias já baixadas.</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-0 flex-1 text-xs font-semibold">Validade do novo link
        <select className="select mt-1" value={hours} disabled={busy} onChange={event => setHours(event.target.value)}>
          <option value="24">24 horas</option><option value="72">3 dias</option><option value="168">7 dias</option>
        </select>
      </label>
      <button type="button" className="btn-primary" disabled={busy || loading || Boolean(error)} onClick={() => mutate()}><Link2 size={16} /> Criar link</button>
    </div>
    {notice && <p role="status" className="mt-3 text-sm text-emerald-700 dark:text-emerald-300">{notice}</p>}
    {error && <p role="alert" className="mt-3 text-sm text-red-700 dark:text-red-300">{error}</p>}
    {copyError && <p role="alert" className="mt-3 text-sm text-amber-800 dark:text-amber-200">{copyError}</p>}
    <div className="my-3 flex items-center justify-between gap-2">
      <h4 className="text-xs font-bold">Links ativos</h4>
      <button type="button" disabled={busy || loading} className="text-xs font-bold underline" onClick={() => { setCursor(null); setRefresh(value => value + 1); }}>Atualizar lista</button>
    </div>
    {loading ? <p role="status" className="text-sm">Consultando links…</p> : !error && <>
      {links.length === 0 && <p className="text-sm text-slate-600 dark:text-slate-300">Nenhum link ativo nesta página.</p>}
      <ul className="max-h-[min(20rem,32dvh)] space-y-3 overflow-y-auto">
        {links.map(link => <li key={link.id} className="rounded-xl border border-neutral-200 p-3 dark:border-white/15">
          <p className="mb-2 text-xs">Válido até {new Date(link.expires_at).toLocaleString('pt-BR')}</p>
          <div className="flex min-w-0 gap-1">
            <input aria-label={`Endereço do link ${link.id}`} className="input min-w-0 flex-1 text-xs" readOnly value={`${window.location.origin}/compartilhado/${link.token}`} />
            <button type="button" className="btn-ghost p-2" aria-label={`Copiar link ${link.id}`} onClick={() => copy(link.token)}><Copy size={16} /></button>
          </div>
          {confirmation === link.id ? <div className="mt-2 text-sm">
            <p>Bloquear novos acessos por este link?</p>
            <div className="mt-2 flex flex-wrap gap-3">
              <button type="button" disabled={busy} className="font-bold text-red-700 dark:text-red-300" onClick={() => mutate(link.token)}>Confirmar revogação</button>
              <button type="button" disabled={busy} onClick={() => setConfirmation(null)}>Cancelar</button>
            </div>
          </div> : <button type="button" disabled={busy} className="mt-2 text-xs font-bold text-red-700 dark:text-red-300" onClick={() => setConfirmation(link.id)}>Revogar link</button>}
        </li>)}
      </ul>
      {nextCursor && <button type="button" className="btn-ghost mt-3" disabled={busy} onClick={() => setCursor(nextCursor)}>Ver links anteriores</button>}
    </>}
  </section>;
}
