import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useBlocker, useLocation } from 'react-router-dom';
import AssessmentDialog from '../components/AssessmentDialog';
import { useAuth } from './AuthContext';
import { useFeatureFlags } from './FeatureFlagsContext';
import { authStorage } from '../services/authStorage.mjs';
import { createPlannerNavigationRegistry } from '../services/plannerNavigation.mjs';
import { recoveryWorkspaceState } from '../services/recoveryPlansView.mjs';

const PlannerNavigationContext = createContext(null);

export function PlannerNavigationProvider({ children }) {
  const { user, announcementAccessId, loading } = useAuth();
  const flags = useFeatureFlags();
  const owners = useRef(null);
  const identity = !loading && user ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  owners.current = {
    planning: flags.isEnabled('planning.lesson_planner') ? identity : null,
    recovery: recoveryWorkspaceState(user?.role, flags) === 'operational' ? identity : null,
  };
  // A 401 clears storage before redirecting. Never turn that redirect, logout,
  // feature revocation or another account's session into an unsaved-data trap.
  const [registry] = useState(() => createPlannerNavigationRegistry(scope => authStorage.token() ? owners.current[scope] : null));
  const version = useSyncExternalStore(registry.subscribe, registry.snapshot);
  const blockedOwners = useRef(null);
  const blocker = useBlocker(useCallback(transition => {
    const blockers = registry.blockingOwners(transition);
    if (!blockers.size) return false;
    blockedOwners.current = blockers;
    return true;
  }, [registry]));
  const location = useLocation();
  const [local, setLocal] = useState(null);
  const status = registry.inspect();
  const localCurrent = local && registry.isCurrent(local.id);
  const routeBlocked = blocker.state === 'blocked';
  const active = Boolean(identity && authStorage.token());
  const routeCurrent = active && routeBlocked && blockedOwners.current
    && [...blockedOwners.current].every(([scope, owner]) => owners.current[scope] === owner);

  const requestLeave = useCallback((id, onLeave) => {
    if (!registry.inspect(id).protected && !registry.inspect().busy) return true;
    setLocal({ id, onLeave });
    return false;
  }, [registry]);
  const context = useMemo(() => ({ registry, requestLeave }), [registry, requestLeave]);

  useEffect(() => {
    const warn = event => {
      if (registry.inspect().protected) { event.preventDefault(); event.returnValue = ''; }
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [registry]);
  useEffect(() => { setLocal(null); }, [location.key]);
  useEffect(() => {
    if (local && !localCurrent) setLocal(null);
    if (!routeBlocked) return;
    if (!routeCurrent) blocker.reset();
    else if (!registry.shouldBlock({ currentLocation: location, nextLocation: blocker.location })) {
      // A confirmed save can finish while a navigation is waiting.
      blocker.proceed();
    }
  }, [local, localCurrent, routeBlocked, routeCurrent, blocker, location, registry, version]);

  const stay = () => {
    setLocal(null);
    if (blocker.state === 'blocked') blocker.reset();
  };
  const leave = () => {
    // Recheck the live pending refs at the click, not just the rendered button.
    if (!active || registry.inspect().busy) return;
    if (routeCurrent) { setLocal(null); blocker.proceed(); }
    else if (localCurrent && typeof local.onLeave === 'function') {
      const action = local.onLeave;
      setLocal(null); action();
    }
  };

  return <PlannerNavigationContext.Provider value={context}>
    {children}
    {active && (routeCurrent || localCurrent) && <AssessmentDialog title={status.busy ? 'Aguarde a confirmação do envio' : 'Sair sem salvar?'} onClose={stay}>
      <div className="space-y-4 p-3 text-sm leading-6 sm:p-4">
        <p role={status.busy ? 'status' : undefined}>{status.busy
          ? 'O envio ainda está em andamento. Aguarde a resposta antes de sair para saber se os dados foram salvos.'
          : 'Há alterações não salvas ou seleções ainda não confirmadas. Se sair agora, você perderá essas alterações.'}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn-primary min-h-11" onClick={stay}>Ficar nesta tela</button>
          {!status.busy && <button type="button" className="btn-outline min-h-11" onClick={leave}>Sair sem salvar</button>}
        </div>
      </div>
    </AssessmentDialog>}
  </PlannerNavigationContext.Provider>;
}

export function usePlannerLeave(dirty, busy, scope = 'planning') {
  const context = useContext(PlannerNavigationContext);
  if (!context) throw new Error('usePlannerLeave precisa de PlannerNavigationProvider.');
  const { registry, requestLeave } = context;
  const id = useRef(Symbol('planner-guard'));
  const latest = useRef({ dirty, busy });
  latest.current = { dirty, busy };
  const busyNow = Boolean(typeof busy === 'function' ? busy() : busy);
  useLayoutEffect(() => registry.register(id.current, () => ({
    dirty: latest.current.dirty,
    busy: typeof latest.current.busy === 'function' ? latest.current.busy() : latest.current.busy,
  }), scope), [registry, scope]);
  useLayoutEffect(() => { registry.notify(); }, [registry, dirty, busyNow]);
  return useMemo(() => {
    const mayLeave = onLeave => requestLeave(id.current, onLeave);
    mayLeave.afterSave = action => registry.afterSave(id.current, action);
    return mayLeave;
  }, [registry, requestLeave]);
}
