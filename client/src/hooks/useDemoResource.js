import { useEffect, useState } from 'react';
import api from '../services/api';

// Never expose a previous selection while a new example or release view is loading.
export default function useDemoResource(path, parse) {
  const [result, setResult] = useState(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!path) { setResult(null); return undefined; }
    const controller = new AbortController();
    setResult(null);
    api.get(path, { signal: controller.signal, timeout: 15000 })
      .then(({ data }) => {
        const value = parse(data);
        if (!controller.signal.aborted) setResult({ path, attempt, value });
      })
      .catch(error => {
        if (!controller.signal.aborted) setResult({ path, attempt, error: error.response?.data?.error || 'Não foi possível carregar os exemplos. Tente novamente.' });
      });
    return () => controller.abort();
  }, [path, parse, attempt]);
  const current = result?.path === path && result?.attempt === attempt ? result : null;
  return { data: current?.value, error: current?.error, loading: Boolean(path) && !current, retry: () => setAttempt(n => n + 1) };
}
