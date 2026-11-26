import { useCallback, useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { useVisiblePolling } from './useVisiblePolling';
import usePublicWrite from './usePublicWrite';
import { parseNotifications } from '../services/auxiliaryView.mjs';
import { confirmPublicMessage } from '../services/publicAccess.mjs';
import { retryDelay } from '../services/visiblePolling.mjs';
import { useToast } from '../contexts/ToastContext';

export default function useHeaderNotifications(userId) {
  const [state, setState] = useState({ data: null, loading: true, error: '' });
  const active = useRef(null), alive = useRef(true), writing = useRef(false), blockedUntil = useRef(0);
  const write = usePublicWrite(), toast = useToast();
  useEffect(() => { alive.current = true; return () => { alive.current = false; active.current?.abort(); }; }, []);
  const read = useCallback(async ({ signal, manual = false, afterWrite = false } = {}) => {
    if (!alive.current || (writing.current && !afterWrite)) return;
    if (Date.now() < blockedUntil.current) {
      if (manual) setState(s => ({ ...s, loading: false, error: 'Aguarde um pouco antes de consultar os avisos novamente.' }));
      return;
    }
    if (active.current && !manual) return;
    active.current?.abort();
    const controller = new AbortController(); active.current = controller;
    const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) controller.abort();
    setState(s => ({ ...s, loading: true }));
    try {
      const res = await api.get('/notifications?limit=10', { signal: controller.signal, timeout: 15000 });
      const data = parseNotifications(res.data, userId);
      if (!controller.signal.aborted && alive.current) setState({ data, loading: false, error: '' });
    } catch (error) {
      if (!controller.signal.aborted && alive.current) {
        blockedUntil.current = Date.now() + retryDelay(error);
        setState(s => ({ ...s, loading: false, error: 'Não foi possível atualizar seus avisos. Tente consultar novamente.' }));
        if (!manual) throw error;
      }
    } finally { signal?.removeEventListener('abort', abort); if (active.current === controller) active.current = null; }
  }, [userId]);
  useVisiblePolling(read, { enabled: Boolean(userId), intervalMs: 30000, eventName: 'notifications:refresh' });
  function mark(id) {
    return write.run(async signal => {
      writing.current = true; active.current?.abort(); active.current = null;
      try {
        const res = await api.put(id ? `/notifications/${id}/read` : '/notifications/read-all', null, { signal, timeout: 15000 });
        confirmPublicMessage(res.data);
        await read({ signal, manual: true, afterWrite: true });
      } finally { writing.current = false; }
    }, () => {}, () => {
      const error = 'Não confirmamos a marcação dos avisos. Consulte novamente antes de repetir.';
      setState(s => ({ ...s, loading: false, error })); toast.warning(error, 7000);
    });
  }
  return { ...state, busy: write.busy, mark, refresh: () => read({ manual: true }) };
}
