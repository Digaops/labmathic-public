import { useLayoutEffect, useRef } from 'react';
import { registerModal } from '../services/modalLifecycle.mjs';

export default function useModalLifecycle(dialogRef, { open = true, onClose, closeDisabled = false } = {}) {
  const latest = useRef({ onClose, closeDisabled });
  useLayoutEffect(() => { latest.current = { onClose, closeDisabled }; });
  useLayoutEffect(() => {
    if (!open) return undefined;
    return registerModal(dialogRef.current, () => {
      if (!latest.current.closeDisabled) latest.current.onClose?.();
    });
  }, [dialogRef, open]);
}
