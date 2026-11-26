import { useEffect, useRef, useState } from 'react';
import { useToast } from '../contexts/ToastContext';

// Writes are explicit, serialized and never replayed after an uncertain response.
export default function useMaterialAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pending = useRef(false);
  const alive = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function run(write, { refresh, onSuccess, onError, message }) {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    try {
      await write();
      if (!alive.current) return;
      onSuccess?.(); refresh?.(); toast.success(message);
    } catch (error) {
      if (!alive.current) return;
      // A GET reconciles server state; it is not a retry of the mutation.
      refresh?.();
      const status = error.response?.status;
      const failureMessage = status >= 400 && status < 500 ? (typeof error.response?.data?.error === 'string' ? error.response.data.error : 'Não foi possível salvar. Confira os dados e seu acesso.')
        : 'Não foi possível confirmar a alteração. Confira a lista ou a situação antes de tentar outra vez.';
      onError?.(failureMessage); toast.error(failureMessage);
    } finally { pending.current = false; if (alive.current) setBusy(false); }
  }
  return { busy, run };
}
