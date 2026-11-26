import { createPortal } from 'react-dom';
import { useRef } from 'react';
import { X } from 'lucide-react';
import useModalLifecycle from '../hooks/useModalLifecycle';
import { materialButton } from './MaterialResourceState';

// A single scroll area keeps long titles and form controls reachable in a short window.
export default function AssessmentDialog({ title, onClose, closeDisabled = false, children, wide = false }) {
  const ref = useRef(null);
  useModalLifecycle(ref, { onClose, closeDisabled });
  return createPortal(<div data-modal-layer className="fixed inset-0 z-[110] flex items-center justify-center bg-slate-950/75 p-2 backdrop-blur-sm sm:p-4">
    <section data-assessment-dialog ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1}
      className={`assessment-workspace max-h-[calc(100dvh-1rem)] w-full overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-2xl outline-none dark:border-white/10 dark:bg-[#0D192B] dark:text-slate-100 sm:max-h-[calc(100dvh-2rem)] ${wide ? 'max-w-6xl' : 'max-w-3xl'}`}>
      <header className="flex items-start justify-between gap-2 border-b border-slate-200 p-3 dark:border-white/10 sm:px-4">
        <h2 className="min-w-0 self-center break-words text-lg font-bold">{title}</h2>
        <button type="button" aria-label="Fechar" disabled={closeDisabled} onClick={onClose} className={`${materialButton} min-w-11 shrink-0`}><X size={18} aria-hidden="true" /></button>
      </header>
      {children}
    </section>
  </div>, document.body);
}
