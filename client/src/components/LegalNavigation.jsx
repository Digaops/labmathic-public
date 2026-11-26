import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';

export const legalSectionId = title => 'secao-' + title.split('.')[0];
export default function LegalNavigation({ titles }) {
  const { hash } = useLocation();
  useEffect(() => {
    if (!/^#(?:secao-\d+|documento-inicio)$/.test(hash)) return;
    const target = document.getElementById(hash.slice(1));
    target?.focus({ preventScroll: true }); target?.scrollIntoView({ block: 'start' });
  }, [hash]);
  return <details className="legal-index mb-5 rounded-xl border border-slate-200 bg-slate-50 px-3 dark:border-white/15 dark:bg-white/5">
    <summary className="min-h-11 cursor-pointer py-3 text-sm font-bold">Ir para um assunto</summary>
    <nav aria-label="Assuntos deste documento" className="grid gap-1 pb-3 sm:grid-cols-2">{titles.map(title => <a key={title} className="flex min-h-11 items-center rounded-lg px-2 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 dark:text-cyan-200 dark:hover:bg-white/10" href={'#' + legalSectionId(title)}>{title}</a>)}</nav>
  </details>;
}
