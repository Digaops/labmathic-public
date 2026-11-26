import { useEffect, useState } from 'react';
import api from '../services/api';

// Independent requests keep a slow secondary resource from blocking the teacher's classes.
export default function useHomeResource(url, identity, parse) {
  const key = url && identity ? `${identity}:${url}` : null;
  const [attempt, setAttempt] = useState(0);
  const [snapshot, setSnapshot] = useState({ key: null, status: 'idle', data: null });
  const current = !key ? { status: 'idle', data: null }
    : snapshot.key === key ? snapshot : { status: 'loading', data: null };

  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    setSnapshot({ key, status: 'loading', data: null });
    api.get(url, { signal: controller.signal, timeout: 15000 })
      .then(response => {
        if (!controller.signal.aborted) setSnapshot({ key, status: 'ready', data: parse(response.data) });
      })
      .catch(() => {
        if (!controller.signal.aborted) setSnapshot({ key, status: 'error', data: null });
      });
    return () => controller.abort();
  }, [key, url, parse, attempt]);

  return { ...current, retry: () => setAttempt(value => value + 1) };
}
