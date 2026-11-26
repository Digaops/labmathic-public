import { notificationPath } from '../services/auxiliaryView.mjs';
import { supportDate } from '../services/accountSupportView.mjs';

export default function HeaderNotifications({ resource, onOpen }) {
  const { data, loading, error, busy, mark, refresh } = resource;
  const button = 'min-h-11 rounded-lg px-2 py-2 text-sm font-semibold text-blue-700 hover:bg-blue-50 disabled:opacity-50 dark:text-cyan-200 dark:hover:bg-white/10';
  return <div data-notification-panel className="header-floating rounded-2xl border border-slate-200 bg-white p-3 text-slate-900 shadow-xl dark:border-white/15 dark:bg-[#111E31] dark:text-slate-100">
    <h2 className="text-base font-bold">Notificações</h2>
    <div className="mt-1 flex flex-wrap gap-1">
      <button type="button" disabled={busy || loading} onClick={refresh} className={button}>Atualizar avisos</button>
      {data?.unreadCount > 0 && <button type="button" disabled={busy || loading || Boolean(error)} onClick={() => mark()} className={button}>Marcar todas como lidas</button>}
    </div>
    {loading && <p role="status" className="py-2 text-sm">Atualizando avisos…</p>}
    {busy && <p role="status" className="py-2 text-sm">Conferindo a marcação…</p>}
    {error && <p role="alert" className="my-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-950 dark:bg-amber-400/10 dark:text-amber-100">{error}</p>}
    {error && data && <p className="text-xs leading-5 text-slate-600 dark:text-slate-300">Os avisos e a contagem exibidos são da última consulta confirmada.</p>}
    {data && <ul className="mt-2 space-y-1">{data.notifications.map(n => {
      const path = notificationPath(n);
      return <li key={n.id}><button type="button" disabled={busy} onClick={() => { if (!n.read) mark(n.id); if (path) onOpen(path); }} className={`w-full rounded-xl border p-3 text-left ${n.read ? 'border-transparent hover:bg-slate-50 dark:hover:bg-white/5' : 'border-blue-100 bg-blue-50 dark:border-cyan-300/15 dark:bg-cyan-300/5'}`}>
        <span className="block text-sm font-semibold">{n.title}</span>
        {n.message && <span className="mt-1 block whitespace-pre-wrap text-sm text-slate-600 dark:text-slate-300">{n.message}</span>}
        <span className="mt-2 block text-xs text-slate-500 dark:text-slate-400">{n.read ? 'Lida' : 'Não lida'} · {supportDate(n.created_at)}</span>
        <span className="mt-1 block text-xs font-semibold text-blue-700 dark:text-cyan-200">{path ? 'Abrir item relacionado' : n.read ? 'Aviso lido' : 'Marcar como lida'}</span>
      </button></li>;
    })}</ul>}
    {data && !loading && !error && !data.notifications.length && <p className="py-3 text-sm">Nenhuma notificação registrada.</p>}
  </div>;
}
