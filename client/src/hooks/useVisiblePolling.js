import { useCallback, useEffect, useRef } from 'react';
import { createVisiblePoller } from '../services/visiblePolling.mjs';

export function useVisiblePolling(task, { enabled = true, intervalMs, eventName } = {}) {
  const poller = useRef(null);
  useEffect(() => {
    if (!enabled) return undefined;
    const current = createVisiblePoller(task, { intervalMs, eventName });
    poller.current = current;
    return () => { current.stop(); if (poller.current === current) poller.current = null; };
  }, [task, enabled, intervalMs, eventName]);
  return useCallback(() => poller.current?.refresh() ?? Promise.resolve(), []);
}
