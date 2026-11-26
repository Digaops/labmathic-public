import { useId, useRef } from 'react';
import useModalLifecycle from '../hooks/useModalLifecycle';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function Modal({ open, onClose, title, children, maxWidth = 'max-w-lg' }) {
  const titleId = useId();
  const dialogRef = useRef(null);
  useModalLifecycle(dialogRef, { open, onClose });

  if (!open) return null;

  return createPortal((
    <div data-modal-layer className="fixed inset-0 z-[100] flex items-center justify-center p-4 animate-fade-in" role="presentation">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />

      {/* Modal */}
      <div
        ref={dialogRef}
        tabIndex={-1}
        aria-labelledby={titleId}
        aria-modal="true"
        className={`relative bg-white dark:bg-neutral-800 rounded-2xl shadow-2xl shadow-neutral-900/20 w-full ${maxWidth} max-h-[calc(100dvh-2rem)] overflow-y-auto animate-scale-in outline-none`}
        role="dialog"
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-100 bg-white p-5 dark:border-neutral-700 dark:bg-neutral-800">
          <h3 id={titleId} className="text-lg font-bold text-neutral-800 dark:text-neutral-100">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-neutral-400 hover:text-neutral-600 hover:bg-neutral-100 dark:hover:bg-neutral-700 dark:hover:text-neutral-300 transition-all"
            aria-label="Fechar"
          >
            <X size={18} />
          </button>
        </div>

        {/* Body */}
        <div className="p-5">
          {children}
        </div>
      </div>
    </div>
  ), document.body);
}
