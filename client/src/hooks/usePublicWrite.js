import { useEffect, useRef, useState } from 'react';

export default function usePublicWrite() {
  const current = useRef(null), alive = useRef(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; current.current?.abort(); }; }, []);
  async function run(request, success, failure) {
    if (current.current || !alive.current) return;
    const controller = new AbortController(); current.current = controller; setBusy(true);
    try {
      const result = await request(controller.signal);
      if (alive.current && !controller.signal.aborted) success(result);
    } catch (error) {
      if (alive.current && !controller.signal.aborted) failure(error);
    } finally {
      if (current.current === controller) { current.current = null; if (alive.current) setBusy(false); }
    }
  }
  return { busy, run };
}
