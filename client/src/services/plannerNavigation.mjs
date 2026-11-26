// One registry feeds the router's single blocker. Readers are live so a write
// that starts before React commits its busy state is still protected.
export function createPlannerNavigationRegistry(currentOwner) {
  const entries = new Map();
  const savedScopes = new Set();
  const listeners = new Set();
  let version = 0;
  const notify = () => { version += 1; listeners.forEach(listener => listener()); };
  const current = id => {
    const entry = entries.get(id), owner = entry && currentOwner(entry.scope);
    return entry && owner && entry.owner === owner ? entry : null;
  };
  const inspect = (id, skipSaved = false) => {
    let dirty = false, busy = false;
    for (const key of id === undefined ? entries.keys() : [id]) {
      const entry = current(key);
      if (!entry || (skipSaved && savedScopes.has(key))) continue;
      const state = entry.read();
      dirty ||= Boolean(state.dirty);
      busy ||= Boolean(state.busy);
    }
    return { dirty, busy, protected: dirty || busy };
  };
  const blockingOwners = ({ currentLocation, nextLocation } = {}) => {
    const recoveryPage = /^\/recomposicao\/?$/i;
    const sameRecoveryPage = recoveryPage.test(currentLocation?.pathname) && recoveryPage.test(nextLocation?.pathname);
    const owners = new Map();
    for (const [id, { scope, owner }] of entries) {
      // The plans workspace already guards a change of selected plan in its URL.
      if (scope === 'recovery' && sameRecoveryPage) continue;
      if (inspect(id, true).protected) owners.set(scope, owner);
    }
    return owners;
  };
  return {
    register(id, read, scope = 'planning') {
      const entry = { owner: currentOwner(scope), read, scope };
      entries.set(id, entry); notify();
      return () => {
        if (entries.get(id) === entry) { entries.delete(id); notify(); }
      };
    },
    inspect,
    isCurrent: id => Boolean(current(id)),
    blockingOwners,
    shouldBlock: transition => blockingOwners(transition).size > 0,
    notify,
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    snapshot: () => version,
    afterSave(id, action) {
      // This applies only to the caller and only during this synchronous action.
      // A failed, async or unrelated later navigation cannot inherit a free pass.
      if (!current(id) || inspect(id).busy || typeof action !== 'function') return false;
      savedScopes.add(id);
      try { action(); return true; }
      finally { savedScopes.delete(id); }
    },
  };
}
