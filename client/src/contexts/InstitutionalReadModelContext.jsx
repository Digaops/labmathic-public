import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { useAuth } from './AuthContext';
import { useFeatureFlags } from './FeatureFlagsContext';
import { institutionalModel } from '../services/institutionalNetworkView.mjs';
import api from '../services/api';

const InstitutionalReadModelContext = createContext(null);
const unavailable = 'Não foi possível consultar a rede agora. Tente novamente.';

export function InstitutionalReadModelProvider({ children }) {
  const { user, announcementAccessId } = useAuth();
  const { isEnabled } = useFeatureFlags();
  const enabled = Boolean(user) && isEnabled('institutions.read_model');
  const identity = enabled ? `${user.id}:${user.role}:${announcementAccessId}` : null;
  const [snapshot, setSnapshot] = useState({ identity: null, model: null, status: 'idle', error: '' });
  const request = useRef(null);
  const generation = useRef(0);
  const current = identity && snapshot.identity === identity ? snapshot : { model: null, status: enabled ? 'loading' : 'idle', error: '' };

  const refresh = useCallback(async () => {
    request.current?.abort();
    const turn = ++generation.current;
    if (!identity) {
      setSnapshot({ identity: null, model: null, status: 'idle', error: '' });
      return;
    }
    const controller = new AbortController(); request.current = controller;
    setSnapshot(previous => ({ identity, model: previous.identity === identity ? previous.model : null, status: 'loading', error: '' }));
    try {
      const response = await api.get('/institutions/read-model', { signal: controller.signal, timeout: 15000 });
      if (controller.signal.aborted || turn !== generation.current) return;
      const model = institutionalModel(response.data, user.role);
      setSnapshot({ identity, model, status: 'ready', error: '' });
    } catch (error) {
      if (controller.signal.aborted || turn !== generation.current) return;
      const accessLost = [401, 403, 404].includes(error.response?.status);
      setSnapshot(previous => ({ identity, model: !accessLost && previous.identity === identity ? previous.model : null, status: 'error', error: unavailable }));
    }
  }, [identity, user?.role]);

  useEffect(() => {
    refresh();
    return () => { generation.current++; request.current?.abort(); };
  }, [refresh]);

  const value = useMemo(() => ({
    enabled, identity, model: current.model,
    loading: current.status === 'loading' && !current.model,
    refreshing: current.status === 'loading' && Boolean(current.model),
    error: current.error, refresh,
  }), [enabled, identity, current, refresh]);
  return <InstitutionalReadModelContext.Provider value={value}>{children}</InstitutionalReadModelContext.Provider>;
}

export function useInstitutionalReadModel() {
  const context = useContext(InstitutionalReadModelContext);
  if (!context) throw new Error('useInstitutionalReadModel deve ser usado dentro de InstitutionalReadModelProvider');
  return context;
}
