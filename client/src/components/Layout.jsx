import { Outlet, useLocation, useNavigationType } from 'react-router-dom';
import { Suspense, useLayoutEffect, useRef } from 'react';
import Spinner from './Spinner';
import Header from './Header';
import ProductAnnouncementModal from './ProductAnnouncementModal';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';

export default function Layout() {
  const { unavailable, refresh } = useFeatureFlags();
  const { pathname, hash } = useLocation();
  const navigation = useNavigationType();
  const content = useRef(null);
  const previousPathname = useRef(pathname);
  useLayoutEffect(() => {
    const changedPage = previousPathname.current !== pathname;
    previousPathname.current = pathname;
    if (!changedPage || hash || (navigation !== 'PUSH' && navigation !== 'REPLACE')) return;
    content.current?.focus({ preventScroll: true });
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }, [pathname, hash, navigation]);

  function skipNavigation(event) {
    event.preventDefault();
    content.current?.focus({ preventScroll: true });
    content.current?.scrollIntoView({ block: 'start', behavior: 'instant' });
  }

  return (
    <div className="app-shell relative min-h-screen overflow-hidden">
      <a href="#conteudo-principal" className="skip-to-content" onClick={skipNavigation}>Ir para o conteúdo</a>
      <div className="app-watermark" aria-hidden="true" />
      <Header />
      <ProductAnnouncementModal />
      <main id="conteudo-principal" ref={content} tabIndex={-1} className="app-main relative z-10">
        {unavailable && <div role="status" className="mx-4 mb-3 flex flex-wrap items-center justify-between gap-2 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-950 dark:border-amber-400/30 dark:bg-amber-950/40 dark:text-amber-100">
          <p>Conexão instável: mantendo as opções já confirmadas. Gravações ainda precisam de confirmação.</p>
          <button type="button" className="min-h-11 rounded-lg px-2 font-bold underline underline-offset-4 focus-visible:outline focus-visible:outline-2" onClick={refresh}>Verificar conexão</button>
        </div>}
        <div className="animate-fade-in pb-10">
          <Suspense fallback={<div role="status" aria-live="polite"><Spinner text="Carregando esta tela..." /></div>}>
            <Outlet />
          </Suspense>
        </div>
      </main>
    </div>
  );
}
