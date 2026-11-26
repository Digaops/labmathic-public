import { createContext, useContext, useState, useCallback, useMemo, useRef } from 'react';
import { CheckCircle2, AlertTriangle, XCircle, Info, X } from 'lucide-react';

const ToastContext = createContext(null);

const icons = {
  success: CheckCircle2,
  warning: AlertTriangle,
  error: XCircle,
  info: Info,
};

const styles = {
  success: 'bg-teal-50 border-teal-300 text-teal-900 dark:bg-[#0B322E] dark:border-teal-700 dark:text-teal-100',
  warning: 'bg-yellow-50 border-yellow-300 text-yellow-900 dark:bg-[#3A2D0C] dark:border-yellow-700 dark:text-yellow-100',
  error: 'bg-rose-50 border-rose-300 text-rose-900 dark:bg-[#351B26] dark:border-rose-700 dark:text-rose-100',
  info: 'bg-sky-50 border-sky-300 text-sky-900 dark:bg-[#102B48] dark:border-sky-700 dark:text-sky-100',
};

const iconStyles = {
  success: 'text-teal-700 dark:text-teal-300',
  warning: 'text-yellow-700 dark:text-yellow-300',
  error: 'text-rose-700 dark:text-rose-300',
  info: 'text-sky-700 dark:text-sky-300',
};

export function ToastProvider({ children }) {
  const [toasts, setToasts] = useState([]);
  const idRef = useRef(0);

  const addToast = useCallback((message, type = 'info', duration = 4000) => {
    const id = ++idRef.current;
    setToasts(prev => [...prev, { id, message, type }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts(prev => prev.filter(t => t.id !== id));
      }, duration);
    }
    return id;
  }, []);

  const removeToast = useCallback((id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  }, []);

  const toast = useMemo(() => ({
    success: (msg, dur) => addToast(msg, 'success', dur),
    error: (msg, dur) => addToast(msg, 'error', dur ?? 6000),
    warning: (msg, dur) => addToast(msg, 'warning', dur),
    info: (msg, dur) => addToast(msg, 'info', dur),
  }), [addToast]);

  return (
    <ToastContext.Provider value={toast}>
      {children}
      {/* Toast container */}
      <div data-toasts className="pointer-events-none fixed bottom-4 left-4 right-4 z-[100] flex max-w-[calc(100vw-2rem)] flex-col gap-3 sm:bottom-6 sm:left-auto sm:right-6 sm:w-96">
        {toasts.map(t => {
          const Icon = icons[t.type];
          return (
            <div
              key={t.id}
              className={`pointer-events-auto flex items-start gap-2 rounded-xl border py-2 pl-3 pr-1 shadow-lg animate-slide-up ${styles[t.type]}`}
              role="alert"
            >
              <Icon size={20} aria-hidden="true" className={`mt-3 flex-shrink-0 ${iconStyles[t.type]}`} />
              <p className="min-w-0 flex-1 break-words py-3 text-sm font-medium">{t.message}</p>
              <button
                onClick={() => removeToast(t.id)}
                type="button"
                className="flex min-h-11 min-w-11 flex-shrink-0 items-center justify-center rounded-lg hover:bg-black/5 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-[-2px] dark:hover:bg-white/10"
                aria-label="Fechar"
              >
                <X size={16} />
              </button>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast deve ser usado dentro de ToastProvider');
  return ctx;
}
