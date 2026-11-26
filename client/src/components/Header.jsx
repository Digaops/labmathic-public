import { useState, useRef, useEffect } from 'react';
import { BANK_EXAMPLES, operationalBankState } from '../services/bankExperiences.mjs';
import { recoveryWorkspaceState } from '../services/recoveryPlansView.mjs';
import { Link, NavLink, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useTheme } from '../contexts/ThemeContext';
import { useFeatureFlags } from '../contexts/FeatureFlagsContext';
import { useInstitutionalReadModel } from '../contexts/InstitutionalReadModelContext';
import HeaderNotifications from './HeaderNotifications';
import useHeaderNotifications from '../hooks/useHeaderNotifications';
import usePublicWrite from '../hooks/usePublicWrite';
import {
  BookOpen, LayoutDashboard, Settings, User, LogOut,
  Menu, X, ChevronRight, Shield, Heart, FolderOpen,
  Bell, Moon, Sun, ClipboardList, FileText, MessageCircle, UsersRound, HeartPulse,
  CalendarRange, ChevronDown, Building2, FlaskConical
} from 'lucide-react';

export default function Header() {
  const { user, announcementAccessId } = useAuth();
  return <HeaderContent key={`${user?.id}:${announcementAccessId}`} />;
}

function HeaderContent() {
  const { user, logout, isAdmin } = useAuth();
  const { dark, toggle: toggleTheme } = useTheme();
  const flags = useFeatureFlags();
  const { isEnabled } = flags;
  const feedbackAvailable = operationalBankState(user?.role, flags, { feedback: true }) === 'operational';
  const recoveryAvailable = recoveryWorkspaceState(user?.role, flags) === 'operational';
  const examples = BANK_EXAMPLES.filter(item => isEnabled(item.flag));
  const { model: institutional } = useInstitutionalReadModel();
  const isInstitutionalManager = institutional?.mode === 'manager';
  const [menuOpen, setMenuOpen] = useState(false);
  const [desktopMenuOpen, setDesktopMenuOpen] = useState(null);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const notifications = useHeaderNotifications(user?.id);
  const unreadCount = notifications.data?.unreadCount || 0;
  const supportUnreadCount = notifications.data?.supportUnreadCount || 0;
  const leaving = usePublicWrite();
  const [logoutError, setLogoutError] = useState('');
  const userMenuRef = useRef(null), notifRef = useRef(null), desktopNavRef = useRef(null);
  const headerRef = useRef(null), triggerRef = useRef(null);
  const location = useLocation();
  const navigate = useNavigate();
  const openKey = notifOpen ? 'notifications' : userMenuOpen ? 'account' : menuOpen ? 'mobile' : desktopMenuOpen;
  const closeMenus = () => { setMenuOpen(false); setDesktopMenuOpen(null); setNotifOpen(false); setUserMenuOpen(false); };
  function toggleMenu(key, event) {
    const wasOpen = openKey === key;
    triggerRef.current = event.currentTarget; closeMenus();
    if (!wasOpen) {
      if (key === 'notifications') { setNotifOpen(true); notifications.refresh(); }
      else if (key === 'account') setUserMenuOpen(true);
      else if (key === 'mobile') setMenuOpen(true);
      else setDesktopMenuOpen(key);
    }
  }
  useEffect(() => { closeMenus(); }, [location.key]);
  useEffect(() => {
    if (!openKey) return;
    const selectors = { notifications: '[data-notification-panel]', account: '[data-account-menu]', mobile: '#mobile-main-menu', assessments: '#desktop-assessments-menu', resources: '#desktop-resources-menu' };
    const panel = headerRef.current?.querySelector(selectors[openKey]);
    const trigger = triggerRef.current;
    panel?.querySelector('a,button:not([disabled]),summary')?.focus({ preventScroll: true });
    function outside(event) { if (!panel?.contains(event.target) && !trigger?.contains(event.target)) closeMenus(); }
    function keydown(event) { if (event.key === 'Escape') { event.preventDefault(); closeMenus(); trigger?.focus({ preventScroll: true }); } }
    function resize() { closeMenus(); trigger?.focus({ preventScroll: true }); }
    document.addEventListener('pointerdown', outside);
    document.addEventListener('focusin', outside);
    document.addEventListener('keydown', keydown);
    window.addEventListener('resize', resize);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('focusin', outside); document.removeEventListener('keydown', keydown); window.removeEventListener('resize', resize); };
  }, [openKey]);

  const navLinkClass = ({ isActive }) =>
    `flex items-center gap-1.5 whitespace-nowrap px-3 py-2 rounded-xl text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-white/10 text-white ring-1 ring-cyan-300/20'
        : 'text-slate-300/80 hover:text-white hover:bg-white/[0.07]'
    }`;

  const desktopGroupClass = (isActive) =>
    `flex items-center gap-1.5 whitespace-nowrap rounded-xl px-3 py-2 text-sm font-medium transition-all duration-200 ${
      isActive
        ? 'bg-white/10 text-white ring-1 ring-cyan-300/20'
        : 'text-slate-300/80 hover:bg-white/[0.07] hover:text-white'
    }`;

  const dropdownLinkClass = ({ isActive }) =>
    `group flex items-start gap-3 rounded-xl px-3 py-2.5 transition-colors ${
      isActive
        ? 'bg-cyan-300/10 text-white'
        : 'text-slate-200 hover:bg-white/[0.07] hover:text-white'
    }`;

  const pathStartsWith = (...prefixes) => prefixes.some((prefix) => (
    location.pathname.startsWith(prefix)
  ));
  const assessmentsActive = pathStartsWith('/banco-questoes', '/simulados', '/exemplos');
  const resourcesActive = pathStartsWith('/colecoes', '/biblioteca', '/favoritos', '/material/', '/retrato-da-rede');
  const roleLabel = isAdmin ? 'Administrador' : isInstitutionalManager ? 'Gestão institucional' : 'Professor';
  const userName = user?.name?.trim() || '';
  const compactUserName = userName && userName.toLocaleLowerCase('pt-BR') !== roleLabel.toLocaleLowerCase('pt-BR')
    ? userName.split(' ')[0]
    : user?.email?.split('@')[0] || 'Minha conta';
  const avatarLabel = (userName || user?.email || roleLabel).charAt(0).toUpperCase();

  // Breadcrumb segments
  const getBreadcrumbs = () => {
    const path = location.pathname;
    const crumbs = [{ label: 'Início', to: '/' }];
    if (path.startsWith('/biblioteca')) crumbs.push({ label: 'Biblioteca', to: '/biblioteca' });
    if (path.startsWith('/material/')) {
      const previousPath = location.state?.from;
      const cameFromLaboratory = previousPath?.includes('/colecoes');

      if (cameFromLaboratory) {
        return null;
      }

      crumbs.push({ label: 'Biblioteca', to: '/biblioteca' });
      crumbs.push({ label: 'Material' });
    }
    if (path.startsWith('/favoritos')) crumbs.push({ label: 'Favoritos' });
    if (path.startsWith('/banco-questoes')) {
      crumbs.push({ label: 'Banco de Questões', to: '/banco-questoes' });
      if (path === '/banco-questoes/formatos') crumbs.push({ label: 'Exemplos de formatos' });
      if (path === '/banco-questoes/devolutivas') crumbs.push({ label: 'Devolutivas da turma' });
      if (path === '/banco-questoes/revisao') crumbs.push({ label: 'Banco de questões para a turma' });
    }
    const example = BANK_EXAMPLES.find(item => item.to === path);
    if (example) crumbs.push({ label: example.label });
    if (path.startsWith('/simulados')) {
      crumbs.push({ label: 'Meus Simulados', to: '/simulados' });
      if (path.match(/^\/simulados\/\d+$/)) crumbs.push({ label: 'Simulado' });
    }
    if (path.startsWith('/fale-conosco')) crumbs.push({ label: 'Fale Conosco' });
    if (path.startsWith('/turmas')) crumbs.push({ label: 'Turmas' });
    if (path.startsWith('/recomposicao')) crumbs.push({ label: 'Planos de recomposição' });
    if (path.startsWith('/instituicoes')) crumbs.push({ label: isAdmin ? 'Instituições' : isInstitutionalManager ? 'Minha rede' : 'Minha escola' });
    if (path.startsWith('/retrato-da-rede')) crumbs.push({ label: 'Retrato da rede' });
    if (path.startsWith('/planejamento')) {
      crumbs.push({ label: 'Planejamentos', to: '/planejamento' });
      if (path === '/planejamento/novo') crumbs.push({ label: 'Novo planejamento' });
      else if (path.match(/^\/planejamento\/[^/]+$/)) crumbs.push({ label: 'Planejamento' });
    }
    if (path.startsWith('/colecoes')) {
      crumbs.push({ label: 'Laboratórios', to: '/colecoes' });
      if (path.match(/^\/colecoes\/\d+$/)) crumbs.push({ label: 'Laboratório' });
    }
    if (path.startsWith('/admin')) {
      crumbs.push({ label: 'Administração', to: '/admin' });
      if (path.includes('/materiais/novo')) crumbs.push({ label: 'Novo Material' });
      else if (path.includes('/materiais') && path.includes('/editar')) crumbs.push({ label: 'Materiais', to: '/admin/materiais' }, { label: 'Editar' });
      else if (path.includes('/materiais')) crumbs.push({ label: 'Materiais' });
      else if (path.includes('/categorias')) crumbs.push({ label: 'Categorias' });
      else if (path.includes('/usuarios')) crumbs.push({ label: 'Usuários' });
      else if (path.includes('/relatorios')) crumbs.push({ label: 'Relatórios' });
      else if (path.includes('/atividades')) crumbs.push({ label: 'Histórico de atividades' });
    }
    if (path.startsWith('/perfil')) crumbs.push({ label: 'Minha conta' });
    return crumbs.length > 1 ? crumbs : null;
  };

  const breadcrumbs = getBreadcrumbs();

  return (
    <>
      <header ref={headerRef} data-main-header className="fixed top-0 left-0 right-0 z-50 border-b border-cyan-300/10 bg-[#061B3A]/90 shadow-sm shadow-slate-950/15 backdrop-blur-xl">
        <div className="mx-auto max-w-[1500px] px-4 sm:px-6">
          <div className="flex h-16 items-center justify-between gap-3">
            {/* Logo */}
            <Link to="/" className="group flex shrink-0 items-center gap-3 text-white">
              <div className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-2xl bg-white/95 p-1 shadow-sm shadow-slate-950/10 ring-1 ring-cyan-300/15 transition-colors group-hover:ring-cyan-300/25">
                <img
                  src="/logos/Favicon-LabMathic.png"
                  alt="LabMathic"
                  className="h-[80%] w-[80%] object-contain"
                />
              </div>
              <div className="hidden max-w-36 2xl:block">
                <p className="text-base font-bold leading-tight text-white">Lab<span className="text-cyan-300">Mathic</span></p>
                <p className="text-[11px] leading-tight text-slate-300/80">Recursos para ensinar</p>
              </div>
            </Link>

            {/* Desktop nav */}
            <nav ref={desktopNavRef} aria-label="Navegação principal" className="hidden shrink-0 min-[1280px]:flex items-center gap-1">
              <NavLink to="/" end className={navLinkClass}>
                <LayoutDashboard size={17} />
                Início
              </NavLink>
              {isEnabled('institutions.read_model') && (
                <NavLink to="/instituicoes" className={navLinkClass}>
                  <Building2 size={17} />
                  {isAdmin ? 'Instituições' : isInstitutionalManager ? 'Minha rede' : 'Minha escola'}
                </NavLink>
              )}
              {!isAdmin && isEnabled('classes.core') && (
                <NavLink to="/turmas" className={navLinkClass}>
                  <UsersRound size={17} />
                  Turmas
                </NavLink>
              )}
              {!isAdmin && isEnabled('planning.lesson_planner') && (
                <NavLink to="/planejamento" className={navLinkClass}>
                  <CalendarRange size={17} />
                  Planejamento
                </NavLink>
              )}

              <div className="relative">
                <button
                  type="button"
                  className={desktopGroupClass(assessmentsActive)}
                                    aria-expanded={desktopMenuOpen === 'assessments'}
                  aria-controls="desktop-assessments-menu"
                  onClick={e => toggleMenu('assessments', e)}
                >
                  <ClipboardList size={17} />
                  Avaliações
                  <ChevronDown size={14} className={`transition-transform ${desktopMenuOpen === 'assessments' ? 'rotate-180' : ''}`} />
                </button>
                {desktopMenuOpen === 'assessments' && (
                  <div id="desktop-assessments-menu" role="region" aria-label="Avaliações" className="absolute left-0 top-full z-50 mt-2 w-72 rounded-2xl border border-cyan-300/15 bg-[#071F42]/95 p-2 shadow-2xl shadow-slate-950/30 backdrop-blur-xl animate-scale-in">
                    <p className="px-3 pb-1.5 pt-1 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/70">Criar e acompanhar</p>
                    <NavLink to="/banco-questoes" className={dropdownLinkClass}>
                      <FileText size={18} className="mt-0.5 shrink-0 text-cyan-300" />
                      <span><strong className="block text-sm">Banco de Questões</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Questões autorais e diagnósticos</span></span>
                    </NavLink>
                    {feedbackAvailable && <NavLink to="/banco-questoes/devolutivas" className={dropdownLinkClass}>
                      <MessageCircle size={18} className="mt-0.5 shrink-0 text-amber-300" />
                      <span><strong className="block text-sm">Devolutivas da turma</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Resultados e registros do professor</span></span>
                    </NavLink>}
                    <NavLink to="/simulados" className={dropdownLinkClass}>
                      <ClipboardList size={18} className="mt-0.5 shrink-0 text-violet-300" />
                      <span><strong className="block text-sm">Simulados</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Montagem, revisão e preparação</span></span>
                    </NavLink>
                    {examples.length > 0 && <div className="mt-1 border-t border-white/10 pt-2">
                      <p className="px-3 text-xs font-semibold text-slate-300">Exemplos · não salvam atividades</p>
                      {examples.map(item => <NavLink key={item.to} to={item.to} className={dropdownLinkClass}><FlaskConical size={18} className="shrink-0 text-emerald-300" /><span className="text-sm">{item.label}</span></NavLink>)}
                    </div>}
                    {!isAdmin && isEnabled('classes.core') && (
                      <div className="mx-2 mt-1 border-t border-white/10 px-1 pt-2 text-[11px] leading-relaxed text-slate-400">As aplicações e os resultados ficam dentro de cada turma.</div>
                    )}
                  </div>
                )}
              </div>

              {recoveryAvailable && (
                <NavLink to="/recomposicao" className={navLinkClass}>
                  <HeartPulse size={17} />
                  Recomposição
                </NavLink>
              )}

              <div className="relative">
                <button
                  type="button"
                  className={desktopGroupClass(resourcesActive)}
                  aria-haspopup="menu"
                  aria-expanded={desktopMenuOpen === 'resources'}
                  aria-controls="desktop-resources-menu"
                  onClick={e => toggleMenu('resources', e)}
                >
                  <FolderOpen size={17} />
                  Recursos
                  <ChevronDown size={14} className={`transition-transform ${desktopMenuOpen === 'resources' ? 'rotate-180' : ''}`} />
                </button>
                {desktopMenuOpen === 'resources' && (
                  <div id="desktop-resources-menu" role="region" aria-label="Recursos" className="absolute left-0 top-full z-50 mt-2 w-72 rounded-2xl border border-cyan-300/15 bg-[#071F42]/95 p-2 shadow-2xl shadow-slate-950/30 backdrop-blur-xl animate-scale-in">
                    {isEnabled('institutions.network_portrait') && <NavLink to="/retrato-da-rede" className={dropdownLinkClass}><Building2 size={18} className="shrink-0 text-cyan-300" /><span><strong className="block text-sm">Retrato da rede</strong><span className="block text-xs text-slate-400">Indicadores públicos do município</span></span></NavLink>}
                    <p className="px-3 pb-1.5 pt-1 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/70">Explorar e guardar</p>
                    <NavLink to="/colecoes" className={dropdownLinkClass}>
                      <FolderOpen size={18} className="mt-0.5 shrink-0 text-cyan-300" />
                      <span><strong className="block text-sm">Laboratórios</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Coleções por tema e componente</span></span>
                    </NavLink>
                    <NavLink to="/biblioteca" className={dropdownLinkClass}>
                      <BookOpen size={18} className="mt-0.5 shrink-0 text-emerald-300" />
                      <span><strong className="block text-sm">Biblioteca</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Pesquise todo o acervo digital</span></span>
                    </NavLink>
                    <NavLink to="/favoritos" className={dropdownLinkClass}>
                      <Heart size={18} className="mt-0.5 shrink-0 text-rose-300" />
                      <span><strong className="block text-sm">Favoritos</strong><span className="mt-0.5 block text-xs text-slate-400 group-hover:text-slate-300">Materiais salvos para reutilizar</span></span>
                    </NavLink>
                  </div>
                )}
              </div>

              {isAdmin && (
              <NavLink to="/admin" className={navLinkClass}>
                <Settings size={17} />
                Administração
              </NavLink>
              )}
            </nav>

            {/* User area */}
            <div className="flex shrink-0 items-center gap-1.5">
              <NavLink
                to="/fale-conosco"
                className={({ isActive }) => `relative hidden min-[1280px]:flex items-center gap-2 whitespace-nowrap rounded-xl px-2.5 py-2 text-sm font-medium transition-all ${
                  isActive
                    ? 'bg-white/10 text-white ring-1 ring-cyan-300/20'
                    : 'text-slate-300/80 hover:bg-white/[0.07] hover:text-white'
                }`}
                title="Fale Conosco"
                aria-label="Fale Conosco"
              >
                <MessageCircle size={18} />
                {supportUnreadCount > 0 && (
                  <span className="absolute right-0.5 top-0.5 h-2.5 w-2.5 rounded-full bg-orange-400 ring-2 ring-[#061A33]" title="Nova mensagem" aria-label="Nova mensagem" />
                )}
              </NavLink>

              {/* Dark mode toggle */}
              <button
                onClick={toggleTheme}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-300/80 transition-all hover:bg-white/10 hover:text-white"
                aria-label="Alternar tema"
              >
                {dark ? <Sun size={18} /> : <Moon size={18} />}
              </button>

              {/* Notifications */}
              <div className="relative" ref={notifRef}>
                <button
                  onClick={e => toggleMenu('notifications', e)}
                  className="relative flex h-9 w-9 items-center justify-center rounded-xl text-slate-300/80 transition-all hover:bg-white/10 hover:text-white"
                  aria-label="Notificações"
                  aria-expanded={notifOpen} aria-controls="header-notifications"
                >
                  <Bell size={18} />
                  {unreadCount > 0 && (
                    <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-amber-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center">
                      {unreadCount > 9 ? '9+' : unreadCount}
                    </span>
                  )}
                </button>

                {notifOpen && <div id="header-notifications"><HeaderNotifications resource={notifications} onOpen={path => { closeMenus(); navigate(path); }} /></div>}
              </div>

              <div className="relative" ref={userMenuRef}>
                <button
                  onClick={e => toggleMenu('account', e)}
                  className="flex items-center gap-2.5 rounded-xl px-2 py-1.5 text-slate-200 transition-all hover:bg-white/10 hover:text-white"
                  aria-label="Menu do usuário"
                  aria-expanded={userMenuOpen} aria-controls="header-account"
                >
                  <div className="flex h-8 w-8 items-center justify-center rounded-xl bg-primary-100 text-sm font-bold text-primary-700 ring-1 ring-cyan-300/25">
                    {avatarLabel}
                  </div>
                  <div className="hidden text-left lg:block min-[1280px]:hidden 2xl:block">
                    <span className="block max-w-28 truncate text-sm font-medium leading-tight">{compactUserName}</span>
                    <span className="block max-w-28 truncate text-xs text-slate-300/75">{roleLabel}</span>
                  </div>
                </button>

                {userMenuOpen && (
                  <div data-account-menu id="header-account" className="header-floating rounded-2xl border border-neutral-200/80 bg-white py-1.5 shadow-lg shadow-neutral-900/10 dark:border-neutral-700 dark:bg-neutral-800 z-50 animate-scale-in">
                    <div className="px-4 py-3 border-b border-neutral-100 dark:border-neutral-700">
                      <p className="text-sm font-semibold text-neutral-800 dark:text-neutral-100">{user?.name}</p>
                      <p className="mt-0.5 break-words text-xs text-neutral-500 dark:text-neutral-300">{user?.email}</p>
                      <span className={`inline-flex items-center gap-1 mt-1.5 text-[10px] font-bold uppercase tracking-wider px-2 py-0.5 rounded-md ${
                        isAdmin ? 'bg-primary-50 text-primary-600 dark:bg-primary-400/10 dark:text-cyan-200' : 'bg-secondary-50 text-secondary-600 dark:bg-secondary-400/10 dark:text-secondary-200'
                      }`}>
                        <Shield size={10} />
                        {roleLabel}
                      </span>
                    </div>
                    <div className="py-1">
                      {logoutError && <p role="alert" className="px-4 py-2 text-sm text-red-700 dark:text-red-200">{logoutError}</p>}
                      <Link
                        to="/perfil"
                        onClick={() => setUserMenuOpen(false)}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-neutral-700 dark:text-neutral-300 hover:bg-neutral-50 dark:hover:bg-neutral-700 transition-colors rounded-lg"
                      >
                        <User size={16} />
                        Minha conta
                      </Link>
                      <button
                        disabled={leaving.busy}
                        onClick={() => { setLogoutError(''); leaving.run(() => logout(), () => closeMenus(), () => setLogoutError('Não foi possível sair. Confira a conexão e tente novamente.')); }}
                        className="w-full flex items-center gap-2.5 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 dark:hover:bg-red-500/10 transition-colors rounded-lg mx-0"
                      >
                        <LogOut size={16} />
                        {leaving.busy ? 'Saindo…' : 'Sair da conta'}
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {/* Mobile toggle */}
              <button
                onClick={e => toggleMenu('mobile', e)}
                className="flex h-9 w-9 items-center justify-center rounded-xl text-slate-300/80 transition-all hover:bg-white/10 hover:text-white min-[1280px]:hidden"
                aria-label={menuOpen ? 'Fechar menu' : 'Abrir menu'}
                aria-expanded={menuOpen}
                aria-controls="mobile-main-menu"
              >
                {menuOpen ? <X size={22} /> : <Menu size={22} />}
              </button>
            </div>
          </div>
        </div>

        {/* Mobile nav */}
        {menuOpen && (
          <nav id="mobile-main-menu" aria-label="Navegação compacta" className="grid max-h-[calc(100dvh-4rem)] gap-3 overflow-y-auto border-t border-cyan-300/10 bg-[#061B3A]/95 px-4 py-3 backdrop-blur-lg animate-slide-down sm:grid-cols-3 min-[1280px]:hidden">
            <div className="min-w-0 space-y-1">
            <p className="px-3.5 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/65">Principal</p>
            <NavLink to="/" end className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <LayoutDashboard size={17} />
              Início
            </NavLink>
            {isEnabled('institutions.read_model') && (
              <NavLink to="/instituicoes" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                <Building2 size={17} />
                {isAdmin ? 'Instituições' : isInstitutionalManager ? 'Minha rede' : 'Minha escola'}
              </NavLink>
            )}
            {!isAdmin && isEnabled('classes.core') && (
              <NavLink to="/turmas" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                <UsersRound size={17} />
                Turmas
              </NavLink>
            )}
            {!isAdmin && isEnabled('planning.lesson_planner') && (
              <NavLink to="/planejamento" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                <CalendarRange size={17} />
                Planejamento
              </NavLink>
            )}
            {recoveryAvailable && (
              <NavLink to="/recomposicao" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                <HeartPulse size={17} />
                Recomposição
              </NavLink>
            )}

            </div>
            <div className="min-w-0 space-y-1">
            <p className="px-3.5 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/65">Avaliações</p>
            <NavLink to="/banco-questoes" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <FileText size={17} />
              Banco de Questões e diagnósticos
            </NavLink>
            {feedbackAvailable && <NavLink to="/banco-questoes/devolutivas" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <MessageCircle size={17} />Devolutivas da turma
            </NavLink>}
            <NavLink to="/simulados" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <ClipboardList size={17} />
              Simulados
            </NavLink>
            {examples.length > 0 && <div className="mt-2 border-t border-white/10 pt-2">
              <p className="px-3.5 text-xs font-semibold text-slate-300">Exemplos · não salvam atividades</p>
              {examples.map(item => <NavLink key={item.to} to={item.to} className={navLinkClass} onClick={() => setMenuOpen(false)}><FlaskConical size={17} />{item.label}</NavLink>)}
            </div>}

            </div>
            <div className="min-w-0 space-y-1">
            <p className="px-3.5 pb-1 pt-1 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/65">Recursos</p>
            <NavLink to="/colecoes" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <FolderOpen size={17} />
              Laboratórios
            </NavLink>
            <NavLink to="/biblioteca" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <BookOpen size={17} />
              Biblioteca
            </NavLink>
            <NavLink to="/favoritos" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <Heart size={17} />
              Favoritos
            </NavLink>
            {isEnabled('institutions.network_portrait') && <NavLink to="/retrato-da-rede" className={navLinkClass} onClick={() => setMenuOpen(false)}><Building2 size={17} />Retrato da rede</NavLink>}

            {isAdmin && (
              <>
                <p className="px-3.5 pb-1 pt-4 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/65">Gestão</p>
                <NavLink to="/admin" className={navLinkClass} onClick={() => setMenuOpen(false)}>
                  <Settings size={17} />
                  Administração
                </NavLink>
              </>
            )}

            <p className="px-3.5 pb-1 pt-4 text-[10px] font-black uppercase tracking-[0.16em] text-cyan-300/65">Ajuda</p>
            {isEnabled('content.issue_review') && <NavLink to="/problemas-no-acervo" className={navLinkClass} onClick={() => setMenuOpen(false)}><MessageCircle size={17} />Problemas no acervo</NavLink>}
            <NavLink to="/fale-conosco" className={navLinkClass} onClick={() => setMenuOpen(false)}>
              <MessageCircle size={17} />
              Fale Conosco
              {supportUnreadCount > 0 && (
                <span className="h-2.5 w-2.5 rounded-full bg-orange-400" title="Nova mensagem" aria-label="Nova mensagem" />
              )}
            </NavLink>
            </div>
          </nav>
        )}
      </header>

      {/* Breadcrumbs */}
      {breadcrumbs && (
        <div data-breadcrumbs className="fixed top-16 left-0 right-0 z-40 border-b border-cyan-300/10 bg-[#061B3A]/[0.92] backdrop-blur-md">
          <div className="max-w-7xl mx-auto h-11 px-4 sm:px-6 flex items-center gap-1 overflow-x-auto whitespace-nowrap text-xs">
            {breadcrumbs.map((crumb, i) => (
              <span key={i} className="flex items-center gap-1">
                {i > 0 && <ChevronRight size={12} className="text-neutral-300" />}
                {crumb.to && i < breadcrumbs.length - 1 ? (
                  <Link to={crumb.to} className="font-medium text-cyan-300 hover:text-white">
                    {crumb.label}
                  </Link>
                ) : (
                  <span className="font-medium text-slate-300">{crumb.label}</span>
                )}
              </span>
            ))}
          </div>
        </div>
      )}
    </>
  );
}
