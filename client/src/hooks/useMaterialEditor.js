import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { materialReceipt } from '../services/materialFormView.mjs';
import { draftReceipt } from '../services/materialDraftView.mjs';
import { curationReceipt } from '../services/materialCurationView.mjs';

// Only a request code is kept in this tab. Draft text and files stay in memory.
export default function useMaterialEditor(identity, targetId, mode = 'material') {
  const curation = mode === 'curation', drafts = mode !== 'material', publishing = mode === 'publish';
  const base = curation ? '/materials/curation' : '/materials/management' + (drafts ? '/drafts' : '');
  const storageKey = `labmathic_material_operation_v1:${identity}:${drafts ? mode + ':' : ''}${targetId || 'new'}`;
  const [restored] = useState(() => { try { const key = sessionStorage.getItem(storageKey); return /^[a-zA-Z0-9_-]{20,120}$/.test(key || '') ? key : null; } catch { return null; } });
  const [state, setState] = useState({ status: restored ? 'uncertain' : 'idle', message: restored ? 'Há um pedido desta aba sem confirmação. Confira o resultado antes de continuar.' : '' });
  const key = useRef(restored), last = useRef(null), pending = useRef(false), alive = useRef(false), reading = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; reading.current?.abort(); }; }, []);
  function forget() { try { sessionStorage.removeItem(storageKey); } catch { /* Retain the receipt when storage fails. */ } key.current = null; }
  function accept(data, operationKey) {
    const receipt = curation ? curationReceipt(data, operationKey, targetId) : drafts ? draftReceipt(data, operationKey, targetId, publishing) : materialReceipt(data, operationKey, targetId);
    if (alive.current) { forget(); last.current = null; setState({ status: 'success', receipt, message: curation ? 'Revisão registrada.' : 'Material salvo.' }); }
  }
  async function send(snapshot, uncertain = false) {
    if (pending.current) return;
    pending.current = true; setState({ status: 'busy', message: curation ? 'Enviando e conferindo a associação…' : 'Enviando e conferindo o material…' });
    try {
      let data;
      if (curation) data = snapshot.payload;
      else { data = new FormData(); data.append('payload', JSON.stringify(snapshot.payload)); if (snapshot.file) data.append('file', snapshot.file); }
      const response = await api.request({ method: targetId && !publishing && !curation ? 'PUT' : 'POST', url: curation ? base + '/materials/' + targetId + '/reviews' : base + (targetId ? '/' + targetId : '') + (publishing ? '/publish' : ''), data, timeout: 120000, headers: { 'Idempotency-Key': snapshot.key } });
      accept(response.data, snapshot.key);
    } catch (error) {
      if (!alive.current) return;
      const status = error.response?.status, code = error.response?.data?.code;
      if (uncertain || !status || status >= 500 || code === 'operation_conflict') setState({ status: 'uncertain', message: curation ? 'Não foi possível confirmar a revisão. Confira o pedido antes de tentar registrar outra.' : 'Não foi possível confirmar o resultado. Confira o pedido; não faça outro cadastro para repeti-lo.' });
      else { forget(); last.current = null; setState({ status: ['material_conflict', 'review_conflict'].includes(code) ? 'conflict' : 'error', message: error.response?.data?.error || 'O material não foi salvo. Confira os dados e seu acesso.' }); }
    } finally { pending.current = false; }
  }
  async function save(payload, file) {
    if (pending.current || ['success', 'conflict', 'uncertain', 'checking'].includes(state.status)) return;
    const operationKey = key.current || crypto.randomUUID();
    try { sessionStorage.setItem(storageKey, operationKey); }
    catch { setState({ status: 'error', message: 'Não foi possível guardar o código de conferência nesta aba. Habilite o armazenamento do navegador antes de enviar.' }); return; }
    const resumed = Boolean(key.current); key.current = operationKey;
    last.current = { key: operationKey, payload, file }; await send(last.current, resumed);
  }
  async function check() {
    if (pending.current || !key.current) return;
    reading.current?.abort(); const controller = new AbortController(); reading.current = controller;
    const operationKey = key.current; setState({ status: 'checking', message: 'Conferindo o pedido no acervo…' });
    try { const response = await api.get(base + '/operations/' + operationKey, { signal: controller.signal, timeout: 15000 });
      if (!controller.signal.aborted) accept(response.data, operationKey);
    } catch (error) { if (alive.current && !controller.signal.aborted) setState({ status: 'uncertain', message: error.response?.data?.code === 'operation_unconfirmed'
      ? 'O pedido ainda não aparece como concluído. Aguarde e confira de novo, ou reenvie usando o mesmo código.' : 'Não foi possível consultar o resultado. O código do pedido continua guardado nesta aba.' }); }
  }
  return { ...state, pending, save, check, retryAvailable: Boolean(last.current), retry: () => { if (last.current && state.status === 'uncertain') send(last.current, true); },
    prepareAgain: () => { if (!last.current && state.status === 'uncertain') setState({ status: 'idle', message: 'Prepare os dados novamente. O envio reutilizará o código anterior para não criar outro material se aquele pedido já tiver sido salvo.' }); } };
}
