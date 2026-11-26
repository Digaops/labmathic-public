import { parseAiRequest } from './aiAuthoringView.mjs';

const BASE = '/question-bank/ai-authoring/requests';
const idle = () => ({ result: null, busy: false, checking: false, uncertain: false, error: '' });
const terminal = result => result && result.status !== 'processing';

// The exact same controller is used by React and deferred-response unit tests.
// A session belongs to one open editor; nothing is written to browser storage.
export function createAiAuthoringSession(api, { createKey = () => crypto.randomUUID() } = {}) {
  let state = idle(), operation = null, draft = null, epoch = 0, disposed = false;
  const listeners = new Set(), controllers = new Set();
  const update = patch => { if (!disposed) { state = { ...state, ...patch }; for (const listener of listeners) listener(); } };
  const active = version => !disposed && epoch === version;
  function accept(value, expected) {
    const parsed = parseAiRequest(value, expected);
    // An earlier GET/POST cannot replace a completed or reviewed view with a stale snapshot.
    if (state.result?.id === parsed.id && (terminal(state.result) && !terminal(parsed)
      || state.result.reviewed && !parsed.reviewed)) return state.result;
    update({ result: parsed, uncertain: false, error: '' }); return parsed;
  }
  function options(timeout) { const controller = new AbortController(); controllers.add(controller); return { controller, config: { signal: controller.signal, timeout } }; }
  function target() {
    if (state.result) return { id: state.result.id, key: state.result.requestKey };
    return operation ? { key: operation.key } : null;
  }
  async function send(input) {
    if (disposed || state.busy || state.checking || state.result) return;
    operation ||= { key: createKey(), input: structuredClone(input) };
    const expected = { key: operation.key }, version = epoch, call = options(55000);
    update({ busy: true, error: '' });
    try {
      const { data } = await api.post(BASE, operation.input, { ...call.config, headers: { 'Idempotency-Key': operation.key } });
      if (active(version)) accept(data, expected);
    } catch (failure) {
      if (active(version) && !terminal(state.result)) update({ uncertain: !failure.response || failure.response.status >= 500,
        error: failure.response?.data?.error || 'A conexão foi interrompida. Confira este pedido antes de enviar outro.' });
    } finally { controllers.delete(call.controller); if (active(version)) update({ busy: false }); }
  }
  async function refresh({ cancel = false, resumeId } = {}) {
    if (disposed || state.checking || (resumeId && (state.busy || state.uncertain || state.result))) return;
    const expected = resumeId ? { id: resumeId } : target();
    if (!expected) return;
    const version = epoch, call = options(15000);
    update({ checking: true, error: '' });
    try {
      const path = expected.id ? `${BASE}/${expected.id}` : `${BASE}/by-key/${expected.key}`;
      let item = parseAiRequest((await api.get(path, call.config)).data, expected);
      if (!active(version)) return;
      if (cancel && item.status === 'processing') item = parseAiRequest((await api.post(`${BASE}/${item.id}/cancel`, {}, call.config)).data, { id: item.id, key: item.requestKey });
      if (active(version)) {
        const accepted = accept(item, expected);
        if (resumeId) operation = null;
        return accepted;
      }
    } catch (failure) {
      if (active(version)) update({ error: failure.response?.status === 404
        ? 'Este pedido ainda não foi localizado. Se o envio ficou incerto, use “Reenviar o mesmo pedido”.'
        : 'Não foi possível conferir este pedido. Nenhuma nova geração foi iniciada.' });
    } finally { controllers.delete(call.controller); if (active(version)) update({ checking: false }); }
  }
  async function review(checks) {
    if (disposed || state.busy || state.checking || state.result?.status !== 'succeeded') return null;
    const expected = target(), version = epoch, call = options(15000);
    update({ busy: true, error: '' });
    try {
      const { data } = await api.post(`${BASE}/${expected.id}/review`, checks, call.config);
      if (!active(version)) return null;
      const result = parseAiRequest(data, expected);
      if (result.reviewed !== true) throw new Error('review_unconfirmed');
      return accept(result, expected);
    } catch (failure) {
      if (active(version)) update({ error: failure.response?.data?.error || 'Não foi possível confirmar a revisão. Seus campos foram preservados.' });
      return null;
    } finally { controllers.delete(call.controller); if (active(version)) update({ busy: false }); }
  }
  function reset() {
    if (disposed || state.busy || state.checking || state.uncertain || state.result?.status === 'processing') return false;
    epoch++; operation = null; state = idle(); update({}); return true;
  }
  return { getSnapshot: () => state, subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    getDraft(initial) { draft ||= structuredClone(initial); return structuredClone(draft); },
    setDraft(next) { if (!reset()) return false; draft = structuredClone(next); return true; },
    send, refresh, review, reset,
    dispose() { disposed = true; epoch++; for (const c of controllers) c.abort(); controllers.clear(); listeners.clear(); },
  };
}
