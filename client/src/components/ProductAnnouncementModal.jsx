import { createPortal } from 'react-dom';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { X, ArrowRight } from 'lucide-react';
import useModalLifecycle from '../hooks/useModalLifecycle';
import { useAuth } from '../contexts/AuthContext';
import api from '../services/api';
import { parseAnnouncement, parseImpression } from '../services/auxiliaryView.mjs';

export default function ProductAnnouncementModal() {
  const { user, announcementAccessId } = useAuth();
  return <Announcement key={`${user?.id}:${announcementAccessId}`} user={user} accessId={announcementAccessId} />;
}
function Announcement({ user, accessId }) {
  const [announcement, setAnnouncement] = useState(null);
  const navigate = useNavigate(), dialogRef = useRef(null);
  useEffect(() => {
    if (user?.role !== 'professor' || !accessId) return;
    const controller = new AbortController();
    (async () => {
      try {
        const current = await api.get('/announcements/current', { params: { access_id: accessId }, signal: controller.signal, timeout: 15000 });
        if (!current.data?.announcement || controller.signal.aborted) return;
        const candidate = parseAnnouncement(current.data.announcement);
        const response = await api.post('/announcements/' + candidate.id + '/impressions', { access_id: accessId }, { signal: controller.signal, timeout: 15000 });
        const confirmed = parseImpression(response.data, candidate.id);
        if (!controller.signal.aborted) setAnnouncement(confirmed);
      } catch { /* Optional information must not block the teacher's work or retry a write. */ }
    })();
    return () => controller.abort();
  }, [user?.id, user?.role, accessId]);
  useModalLifecycle(dialogRef, { open: Boolean(announcement), onClose: () => setAnnouncement(null) });
  if (!announcement) return null;
  return createPortal(<div data-modal-layer className="fixed inset-0 z-[90] flex items-center justify-center bg-[#031126]/80 p-3" onClick={() => setAnnouncement(null)}>
    <section ref={dialogRef} data-product-announcement role="dialog" aria-modal="true" aria-labelledby="product-announcement-title" tabIndex={-1} onClick={e => e.stopPropagation()} className="max-h-[calc(100dvh-1.5rem)] w-full max-w-2xl overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white text-slate-900 shadow-xl dark:border-white/15 dark:bg-[#111E31] dark:text-slate-100">
      <header className="flex items-start gap-2 border-b border-slate-200 p-4 dark:border-white/10">
        <div className="min-w-0 flex-1"><p className="text-xs font-semibold text-blue-700 dark:text-cyan-200">Novidades do LabMathic</p><h2 id="product-announcement-title" className="mt-1 text-xl font-bold">{announcement.title}</h2></div>
        <button type="button" onClick={() => setAnnouncement(null)} aria-label="Fechar aviso" className="flex min-h-11 min-w-11 items-center justify-center rounded-xl hover:bg-slate-100 dark:hover:bg-white/10"><X size={20} aria-hidden="true" /></button>
      </header>
      <div className="space-y-3 p-4">
        <p className="text-sm leading-6 text-slate-600 dark:text-slate-300">{announcement.payload.intro}</p>
        <button type="button" onClick={() => setAnnouncement(null)} className="btn-primary min-h-11">Entendi, continuar</button>
        <ul className="divide-y divide-slate-200 dark:divide-white/10">{announcement.payload.features.map(feature => <li key={feature.key} className="py-3">
          <h3 className="font-bold">{feature.title}</h3><p className="mt-1 text-sm leading-6 text-slate-600 dark:text-slate-300">{feature.description}</p>
          {feature.key === 'author_questions' && <p className="mt-2 text-xs leading-5 text-slate-500 dark:text-slate-300">Outros professores não conseguem visualizar suas questões autorais.</p>}
          <button type="button" className="mt-2 inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-sm font-bold text-blue-700 hover:bg-blue-50 dark:text-cyan-200 dark:hover:bg-white/10" onClick={() => { setAnnouncement(null); navigate(feature.actionPath); }}>{feature.actionLabel}<ArrowRight size={16} aria-hidden="true" /></button>
        </li>)}</ul>
        <p className="text-xs leading-5 text-slate-500 dark:text-slate-300">Este aviso tem um limite de {announcement.maxImpressions} exibições por conta nesta atualização.</p>
        <button type="button" onClick={() => setAnnouncement(null)} className="btn-primary min-h-11">Fechar novidades</button>
      </div>
    </section>
  </div>, document.body);
}
