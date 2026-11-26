import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { deletionSelection } from '../services/adminMaterialsView.mjs';

// A lost mutation response is never replayed: reconciliation is read-only.
export default function useMaterialDeletion(onChanged) {
  const [review, setReview] = useState(null), [busy, setBusy] = useState(false), [message, setMessage] = useState('');
  const pending = useRef(false), alive = useRef(false), read = useRef(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; read.current?.abort(); }; }, []);
  async function check(ids, { uncertain = false, bulk = ids.length > 1 } = {}) {
    if (pending.current) return;
    read.current?.abort(); const controller = new AbortController(); read.current = controller;
    setReview({ ids, bulk, state: 'loading', uncertain, materials: [], missingIds: [], error: '' });
    try {
      const response = await api.get('/materials/management-selection', { params: { ids: ids.join(',') }, signal: controller.signal, timeout: 15000 });
      const next = deletionSelection(response.data, ids);
      if (controller.signal.aborted || !alive.current) return;
      setReview({ ids, bulk, state: 'ready', uncertain, ...next, error: '' });
      if (next.missingIds.length) onChanged();
    } catch (error) {
      if (!controller.signal.aborted && alive.current) setReview({ ids, bulk, state: 'error', uncertain, materials: [], missingIds: [], error: 'Não foi possível conferir os materiais. Nenhuma nova exclusão foi enviada. Tente consultar novamente.' });
    }
  }
  function close() { if (pending.current) return; read.current?.abort(); setReview(current => current?.uncertain ? { ...current, hidden: true } : null); }
  async function remove(confirmed) {
    if (pending.current || !confirmed || review?.state !== 'ready' || review.uncertain || review.missingIds.length || !review.materials.length) return;
    const snapshot = review; pending.current = true; setBusy(true); setMessage('');
    try {
      const response = snapshot.bulk ? await api.post('/materials/bulk-delete', { ids: snapshot.ids, expectedVersions: Object.fromEntries(snapshot.materials.map(m => [m.id, m.version])) }, { timeout: 20000 })
        : await api.delete('/materials/' + snapshot.ids[0], { data: { expectedVersion: snapshot.materials[0].version }, timeout: 20000 });
      if (typeof response.data?.message !== 'string' || (snapshot.bulk && response.data.deleted !== snapshot.ids.length)) throw Error('Resposta incompleta.');
      if (!alive.current) return;
      setReview(null); setMessage(snapshot.ids.length > 1 ? `${snapshot.ids.length} materiais excluídos do acervo.` : 'Material excluído do acervo.'); onChanged(true);
    } catch (error) {
      if (!alive.current) return;
      const status = error.response?.status;
      setReview({ ...snapshot, state: 'blocked', uncertain: !status || status >= 500,
        error: !status || status >= 500 ? 'Não foi possível confirmar a exclusão. Não repita o envio. Confira quais materiais ainda estão no acervo.'
          : status === 409 || status === 404 ? 'Um material mudou ou foi removido. Nenhuma exclusão deste pedido foi feita. Atualize a conferência e revise a seleção.'
            : 'A exclusão não foi autorizada ou não pôde ser validada. Confira novamente os materiais e seu acesso.' });
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { review, busy, message, pending, check, close, remove, show: () => setReview(r => r ? { ...r, hidden: false } : r),
    restart: () => { if (review?.state === 'ready' && review.materials.length) check(review.materials.map(m => m.id), { bulk: review.bulk }); },
    acknowledgeGone: () => { if (review?.state === 'ready' && !review.materials.length) { setReview(null); setMessage('Os materiais conferidos não constam mais no acervo.'); onChanged(true); } } };
}
