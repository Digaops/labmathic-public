import { useEffect, useId, useRef } from 'react';
export const accountPanel = 'rounded-xl border border-slate-200 bg-white p-3 text-slate-900 dark:border-white/10 dark:bg-[#111e31] dark:text-slate-100 sm:p-4';
export function AccountNotice({ value, focus = false }) {
  const ref = useRef(null);
  useEffect(() => {
    if (focus && value?.kind === 'error' && value.text && ref.current?.getClientRects().length) {
      ref.current.focus({ preventScroll: true }); ref.current.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    }
  }, [focus, value]);
  if (!value?.text) return null;
  return <p ref={ref} tabIndex={focus ? -1 : undefined} role={value.kind === 'error' ? 'alert' : 'status'} className={`scroll-mt-28 rounded-lg border p-3 text-sm ${value.kind === 'error' ? 'border-amber-300 bg-amber-50 text-amber-950 dark:bg-amber-400/10 dark:text-amber-100' : 'border-emerald-300 bg-emerald-50 text-emerald-950 dark:bg-emerald-400/10 dark:text-emerald-100'}`}>{value.text}</p>;
}
export function AccountSelect({ label, value, onChange, options, disabled }) {
  const id = useId();
  return <div><label htmlFor={id} className="mb-1 block text-sm font-semibold">{label}</label><select id={id} className="select" value={value} onChange={e => onChange(e.target.value)} disabled={disabled}>{options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select></div>;
}
