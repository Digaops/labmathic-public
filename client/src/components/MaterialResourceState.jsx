import { RefreshCw } from 'lucide-react';

export const materialSurface = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
export const materialFocus = 'focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cyan-600 dark:focus-visible:outline-cyan-300';
export const materialButton = `inline-flex min-h-11 items-center justify-center gap-2 rounded-xl px-3 text-sm font-semibold text-cyan-800 hover:bg-cyan-50 disabled:cursor-not-allowed disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5 ${materialFocus}`;

export default function MaterialResourceState({ resource, label }) {
  if (resource.status === 'ready' || resource.status === 'idle') return null;
  if (resource.status === 'loading') return <p role="status" className="py-2 text-sm text-slate-600 dark:text-slate-300">Carregando {label}…</p>;
  return <div role="alert" className="text-sm text-amber-900 dark:text-amber-200"><p>Não foi possível consultar {label}.</p>
    <button type="button" onClick={resource.retry} className={materialButton} aria-label={`Tentar novamente: ${label}`}><RefreshCw size={16} aria-hidden="true" />Tentar novamente</button>
  </div>;
}
