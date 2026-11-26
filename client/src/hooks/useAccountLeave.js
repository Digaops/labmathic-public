import { useEffect } from 'react';

// Guard app links and reloads; no drafts or passwords are persisted in browser storage.
export default function useAccountLeave(dirty, busy, message = 'Há alterações não salvas. Sair sem salvá-las?') {
  useEffect(() => {
    const warn = e => { if (dirty || busy()) { e.preventDefault(); e.returnValue = ''; } };
    const link = e => {
      const a = e.target.closest?.('a[href]');
      if (!a || e.defaultPrevented || a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const url = new URL(a.href, location.href);
      if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
      if (busy() || (dirty && !window.confirm(message))) { e.preventDefault(); e.stopPropagation(); }
    };
    window.addEventListener('beforeunload', warn); document.addEventListener('click', link, true);
    return () => { window.removeEventListener('beforeunload', warn); document.removeEventListener('click', link, true); };
  }, [dirty, busy, message]);
}
