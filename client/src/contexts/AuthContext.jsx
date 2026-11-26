import { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import api from '../services/api';
import { authStorage, AUTH_EVENT } from '../services/authStorage.mjs';

const AuthContext = createContext(null);
const ANNOUNCEMENT_ACCESS_KEY = 'labmathic_announcement_access_id';
function createAnnouncementAccessId() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
}
function announcementAccessId() {
  try {
    const id = sessionStorage.getItem(ANNOUNCEMENT_ACCESS_KEY) || createAnnouncementAccessId();
    sessionStorage.setItem(ANNOUNCEMENT_ACCESS_KEY, id);
    return id;
  } catch { return createAnnouncementAccessId(); }
}
function clearAnnouncement() {
  try { sessionStorage.removeItem(ANNOUNCEMENT_ACCESS_KEY); } catch { /* Não impedir a saída. */ }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(() => authStorage.read()?.user || null);
  const [loading, setLoading] = useState(true);
  const [sessionNotice, setSessionNotice] = useState('');
  const [accessId, setAccessId] = useState(() => authStorage.token() ? announcementAccessId() : null);
  const revision = useRef(0);
  const bootstrap = useRef(null);

  useEffect(() => {
    const onStorage = event => {
      if (event.key !== AUTH_EVENT || !event.newValue) return;
      let kind;
      try { ({ kind } = JSON.parse(event.newValue)); } catch { return; }
      if (!['login', 'logout', 'changed', 'expired'].includes(kind)) return;
      revision.current += 1;
      bootstrap.current?.abort();
      authStorage.lock();
      clearAnnouncement(); setAccessId(null); setUser(null); setLoading(false);
      setSessionNotice(kind === 'logout' ? 'A sessão foi encerrada em outra aba.'
        : 'A sessão mudou em outra aba. Entre novamente para continuar com a sua conta.');
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  useEffect(() => {
    const token = authStorage.token();
    if (!token) { setUser(null); setLoading(false); return; }
    const controller = new AbortController();
    bootstrap.current = controller;
    api.get('/auth/me', { signal: controller.signal, headers: { Authorization: `Bearer ${token}` } })
      .then(res => {
        if (controller.signal.aborted || authStorage.token() !== token) return;
        if (authStorage.updateUser(res.data, token, { verified: true })) setUser(res.data);
      })
      .catch(error => {
        if (controller.signal.aborted || authStorage.token() !== token) return;
        // Indisponibilidade transitória não apaga uma sessão recuperável.
        if (error.response?.status !== 401 && error.response?.status !== 404) return;
        authStorage.clear(token); authStorage.announce('expired');
        clearAnnouncement(); setAccessId(null); setUser(null);
      })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, []);

  const login = useCallback(async (email, password, remember = false, { signal } = {}) => {
    bootstrap.current?.abort();
    const operation = ++revision.current;
    const res = await api.post('/auth/login', { email, password }, { signal, timeout: 30000 });
    try {
      if (signal?.aborted || operation !== revision.current) throw new Error('A entrada foi interrompida ou a sessão mudou. Tente entrar novamente.');
      authStorage.save(res.data.token, res.data.user, remember === true);
    } catch (error) {
      // Um login que não pode ser guardado não deve deixar o token novo ativo.
      try { await api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${res.data.token}` }, timeout: 15000 }); } catch { /* Informar falha sem indicar login concluído. */ }
      throw error;
    }
    clearAnnouncement(); setAccessId(announcementAccessId());
    setSessionNotice(''); setUser(res.data.user);
    authStorage.announce('login');
    return res.data.user;
  }, []);

  const logout = useCallback(async () => {
    bootstrap.current?.abort();
    const token = authStorage.token();
    if (token) {
      try { await api.post('/auth/logout', null, { headers: { Authorization: `Bearer ${token}` }, timeout: 15000 }); }
      catch (error) { if (error.response?.status !== 401) throw error; }
    }
    if (token && !authStorage.clear(token)) return;
    if (!token) authStorage.lock();
    revision.current += 1;
    clearAnnouncement(); setAccessId(null); setUser(null); setSessionNotice('');
    authStorage.announce('logout');
  }, []);

  const forgotPassword = useCallback(async email => (await api.post('/auth/forgot-password', { email })).data, []);
  const updateUser = useCallback(data => {
    if (authStorage.updateUser(data, authStorage.token())) setUser(data);
  }, []);
  const replaceSessionToken = useCallback((token, previousToken) => {
    if (!authStorage.replaceToken(token, previousToken)) return false;
    authStorage.announce('changed');
    return true;
  }, []);

  return (
    <AuthContext.Provider value={{ user, setUser: updateUser, replaceSessionToken, loading, login, logout,
      forgotPassword, sessionNotice, announcementAccessId: accessId, isAdmin: user?.role === 'admin' }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth deve ser usado dentro de AuthProvider');
  return ctx;
}
