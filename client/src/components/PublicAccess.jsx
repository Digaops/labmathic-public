import { useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { Eye, EyeOff } from 'lucide-react';

export const accessInput = 'access-input h-12 w-full rounded-xl border border-slate-300 bg-white px-3 text-base text-[#0F172A] outline-none focus:border-blue-600 focus:ring-4 focus:ring-blue-500/15 disabled:opacity-60';
export const accessButton = 'inline-flex min-h-12 items-center justify-center rounded-xl bg-[#1D4ED8] px-4 py-2 text-base font-bold text-white hover:bg-[#1E40AF] disabled:cursor-wait disabled:opacity-60';
export const accessLink = 'inline-flex min-h-11 items-center justify-center rounded-lg text-sm font-semibold text-[#1D4ED8] underline-offset-4 hover:underline';

export default function PublicAccess({ title, description, children }) {
  return <div className="login-screen public-access min-h-svh bg-[#061B3A] text-[#0F172A]">
    <main className="mx-auto flex min-h-svh max-w-lg items-center px-3 py-4 sm:px-5">
      <section aria-labelledby="access-title" className="w-full rounded-2xl border border-white/80 bg-white p-5 shadow-xl sm:p-7">
        <div className="mb-4 flex items-center gap-2"><img src="/logos/logo-labmathic-mark.png" alt="" width="32" height="32" /><span className="text-lg font-extrabold text-[#0F172A]">Lab<span className="text-[#1D4ED8]">Mathic</span></span></div>
        <h1 id="access-title" className="text-2xl font-extrabold tracking-tight text-[#0F172A]">{title}</h1>
        {description && <p className="mt-2 text-sm leading-6 text-[#64748B]">{description}</p>}
        {children}
        <nav aria-label="Voltar ao acesso" className="mt-3"><Link to="/login" className={accessLink}>Voltar para entrar</Link></nav>
      </section>
    </main>
  </div>;
}
export function PublicNotice({ text, success = false, id }) {
  const ref = useRef(null);
  useEffect(() => { if (text && ref.current) { ref.current.focus({ preventScroll: true }); ref.current.scrollIntoView({ block: 'nearest' }); } }, [text]);
  return text ? <p id={id} ref={ref} tabIndex={-1} role={success ? 'status' : 'alert'} className={`my-3 rounded-xl border p-3 text-sm leading-6 ${success ? 'border-emerald-200 bg-emerald-50 text-emerald-950' : 'border-red-200 bg-red-50 text-red-900'}`}>{text}</p> : null;
}
export function PublicPassword({ id, label, value, onChange, visible, toggle, disabled }) {
  return <div><label htmlFor={id} className="mb-1 block text-sm font-semibold text-[#0F172A]">{label}</label>
    <div className="relative"><input id={id} name={id} type={visible ? 'text' : 'password'} autoComplete="new-password" required maxLength={1024} value={value} onChange={onChange} disabled={disabled} className={`${accessInput} pr-12`} />
      <button type="button" disabled={disabled} onClick={toggle} aria-label={`${visible ? 'Ocultar' : 'Mostrar'} ${label.toLowerCase()}`} aria-pressed={visible} className="absolute right-0.5 top-0.5 flex h-11 w-11 items-center justify-center rounded-lg text-[#1D4ED8]">{visible ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}</button>
    </div></div>;
}
