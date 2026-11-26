import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { requestError } from '../services/accountSupportView.mjs';

export default function useSupportRead(path, parse, paused = false, period = 12000) {
  const [result, setResult] = useState(null), [attempt, setAttempt] = useState(0);
  const request = useRef(null);
  useEffect(() => {
    if (!path || paused) return;
    const controller = new AbortController(); request.current = controller; let timer;
    function schedule() { timer = setTimeout(() => { if (document.visibilityState === 'visible') read(); else schedule(); }, period); }
    async function read() {
      if (controller.signal.aborted) return;
      setResult(previous => ({ path, data: previous?.path === path ? previous.data : null, loading: true, error: previous?.path === path ? previous.error : '' }));
      try {
        const { data } = await api.get(path, { signal: controller.signal, timeout: 15000 });
        const value = parse(data);
        if (!controller.signal.aborted) setResult({ path, data: value, loading: false, error: '' });
      } catch (e) {
        if (!controller.signal.aborted) setResult(previous => ({ path, data: previous?.path === path ? previous.data : null, loading: false, error: requestError(e, 'Não foi possível carregar. Tente novamente.') }));
      } finally {
        if (!controller.signal.aborted) schedule();
      }
    }
    read();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [path, parse, paused, period, attempt]);
  const current = result?.path === path ? result : null;
  return { data: current?.data, error: current?.error, loading: Boolean(path) && (!current || current.loading),
    cancel: () => request.current?.abort(),
    refresh: () => setAttempt(a => a + 1),
    adopt: value => { request.current?.abort(); setResult({ path, data: value, loading: false, error: '' }); },
  };
}
