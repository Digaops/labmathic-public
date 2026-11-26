import { clearQuestionSetDrafts } from './questionSetDraft.mjs';

export const AUTH_RECORD = 'labmathic_auth_session_v1';
export const AUTH_EVENT = 'labmathic_auth_event';
export const AUTH_LOCK = 'labmathic_auth_recheck';
const AUTH_KEYS = [AUTH_RECORD, 'token', 'user'];
const cachedUser = value => Number.isSafeInteger(value?.id) && value.id > 0
  && typeof value.name === 'string' && typeof value.email === 'string'
  && ['admin', 'professor'].includes(value.role) ? value : null;

export function createAuthStorage({ local = () => window.localStorage, session = () => window.sessionStorage } = {}) {
  // Uma tela já aberta nunca adota silenciosamente o token de outra conta/aba.
  let boundToken;
  const remove = storage => AUTH_KEYS.forEach(key => storage.removeItem(key));
  const readRecord = storage => {
    const raw = storage.getItem(AUTH_RECORD);
    if (raw !== null) {
      try {
        const record = JSON.parse(raw);
        return { present: true, record: typeof record?.token === 'string' && record.token
          ? { token: record.token, user: cachedUser(record.user) } : null };
      } catch { return { present: true, record: null }; }
    }
    // Compatibilidade com sessões válidas salvas pelas releases anteriores.
    const token = storage.getItem('token');
    let user = null;
    try { user = JSON.parse(storage.getItem('user')); } catch { /* /auth/me recompõe o perfil. */ }
    return { present: Boolean(token), record: token ? { token, user: cachedUser(user) } : null };
  };
  const read = () => {
    try {
      if (session().getItem(AUTH_LOCK)) return null;
      const temporary = readRecord(session());
      const stored = temporary.present ? temporary : readRecord(local());
      const record = stored.record;
      if (boundToken === undefined) boundToken = record?.token || null;
      if (!record || record.token !== boundToken) return null;
      return { ...record, persistent: !temporary.present };
    } catch { return null; }
  };
  const save = (token, user, persistent = false) => {
    if (typeof token !== 'string' || !token || !cachedUser(user)) throw new Error('Resposta de autenticação incompleta. Tente novamente.');
    try {
      clearQuestionSetDrafts(session());
      const target = persistent ? local() : session();
      const other = persistent ? session() : local();
      remove(other);
      // Um único registro impede misturar token e perfil se a escrita falhar.
      target.setItem(AUTH_RECORD, JSON.stringify({ token, user }));
      target.removeItem('token'); target.removeItem('user');
      session().removeItem(AUTH_LOCK);
      boundToken = token;
    } catch {
      boundToken = null;
      for (const get of [local, session]) { try { remove(get()); } catch { /* Não promover para persistente. */ } }
      throw new Error('O navegador não permitiu guardar a sessão. Confira as permissões de armazenamento e tente novamente.');
    }
  };
  const clear = expectedToken => {
    if (expectedToken && read()?.token !== expectedToken) return false;
    boundToken = null;
    try { clearQuestionSetDrafts(session()); } catch { /* Never retain private drafts after sign-out. */ }
    for (const get of [local, session]) {
      try {
        const storage = get();
        if (!expectedToken || readRecord(storage).record?.token === expectedToken) remove(storage);
      } catch { /* A conta permanece bloqueada nesta execução. */ }
    }
    try { session().setItem(AUTH_LOCK, '1'); } catch { /* Sem persistência disponível. */ }
    return true;
  };
  return {
    read, save, clear,
    token: () => read()?.token || null,
    updateUser(user, expectedToken, { verified = false } = {}) {
      const current = read();
      if (!current || current.token !== expectedToken || !cachedUser(user)
          || (!verified && current.user && current.user.id !== user.id)) return false;
      const target = current.persistent ? local() : session();
      target.setItem(AUTH_RECORD, JSON.stringify({ token: current.token, user }));
      target.removeItem('token'); target.removeItem('user');
      return true;
    },
    replaceToken(token, expectedToken) {
      const current = read();
      if (!current || current.token !== expectedToken || typeof token !== 'string' || !token) return false;
      const target = current.persistent ? local() : session();
      target.setItem(AUTH_RECORD, JSON.stringify({ token, user: current.user }));
      target.removeItem('token'); target.removeItem('user');
      boundToken = token;
      return true;
    },
    lock() {
      boundToken = null;
      try { clearQuestionSetDrafts(session()); } catch { /* Best effort when storage is unavailable. */ }
      try { remove(session()); session().setItem(AUTH_LOCK, '1'); } catch { /* Não apagar a sessão de outra aba. */ }
    },
    announce(kind) {
      // O evento entre abas não contém token, e-mail ou dados da conta.
      try { local().setItem(AUTH_EVENT, JSON.stringify({ kind, nonce: `${Date.now()}-${Math.random()}` })); } catch { /* Melhor esforço. */ }
    },
  };
}

export const authStorage = createAuthStorage();
