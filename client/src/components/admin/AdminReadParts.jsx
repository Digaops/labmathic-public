export const readPanel = 'rounded-2xl border border-slate-200 bg-white dark:border-white/10 dark:bg-[#111E31]';
export const readButton = 'inline-flex min-h-11 items-center justify-center rounded-xl px-3 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-40 dark:text-cyan-200 dark:hover:bg-white/5';
export const readPrimary = readButton + ' bg-blue-700 text-white hover:bg-blue-800 dark:bg-blue-700 dark:text-white';
export const readField = 'min-h-11 w-full min-w-0 rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 dark:border-white/20 dark:bg-[#0B1728] dark:text-slate-100';
export function ReadState({ resource, children }) {
  if (resource.status === 'loading') return <p role="status" className="p-3 text-sm">Consultando registros…</p>;
  if (resource.status !== 'ready') return <div role="alert" className={readPanel + ' p-3 text-sm leading-6'}><p>Não foi possível consultar estes dados. Isso não significa que não existam registros.</p><button type="button" className={readButton} onClick={resource.retry}>Tentar novamente</button></div>;
  return children(resource.data);
}
export function ReadMetrics({ rows }) {
  return <dl className="grid grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">{rows.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs leading-5 text-slate-600 dark:text-slate-300">{label}</dt><dd className="text-lg font-bold">{typeof value === 'number' ? value.toLocaleString('pt-BR') : value}</dd></div>)}</dl>;
}
