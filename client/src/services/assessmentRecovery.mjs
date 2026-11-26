import {isNumeric,responseValue,validNumericInput,canonicalNumericInput} from './numericResponse.mjs';
// A cópia desta aba contém apenas identificadores opacos e respostas, nunca questões ou gabaritos.
export const DRAFT_KEY = 'labmathic.studentAssessmentDraft.v1';
const MAX_AGE = 8 * 60 * 60 * 1000;
const selections = (portal) => portal.items.map((item) => ({ itemId: item.id, optionId: responseValue(item) }));
const equal = (item,a,b) => isNumeric(item) ? validNumericInput(a) && validNumericInput(b)
  && canonicalNumericInput(a)===canonicalNumericInput(b) : a===b;
const draftValueValid = (item,value) => isNumeric(item) ? value===null || (typeof value==='string' && value.length<=20 && /^[+\-\d.,]*$/.test(value))
  : value===null || item.options.some(option=>option.id===value);
const scopeOf = (portal) => portal.attempt?.draftScope
  || JSON.stringify([portal.attempt?.startedAt, portal.items.map(({ id }) => id).sort()]);

export function createAssessmentRecovery({ request, storage = () => sessionStorage, onChange = () => {},
  now = Date.now, schedule = setTimeout, cancel = clearTimeout, canAutoRetry = () => true }) {
  let server = null;
  let changes = new Map();
  let flight = null;
  let uncertain = false;
  let restored = false;
  let conflicts = [];
  let busy = false;
  let stopped = false;
  let timer;
  let abort;
  let failures = 0;
  let retryAt = 0;
  let rateLimitedUntil = 0;
  let phase = 'checking';
  let message = '';
  let storageAvailable = true;
  let unreadableDraft = false;
  let hasRecoveryCopy = false;
  try { hasRecoveryCopy = Boolean(storage().getItem(DRAFT_KEY)); } catch { storageAvailable = false; }
  let expired = false;
  let serverOffset = 0;

  const pending = () => [...changes.keys()];
  const terminal = () => server && server.attempt?.status !== 'draft';
  const invalidNumericIds = () => (server?.items || [])
    .filter(item => isNumeric(item) && changes.has(item.id) && !validNumericInput(changes.get(item.id).value))
    .map(item => item.id);
  const deadlinePassed = () => expired || Boolean(server?.attempt?.deadline
    && Date.parse(server.attempt.deadline) <= now() + serverOffset);
  function snapshot() {
    return {
      portal: server && { ...server, items: server.items.map((item) => ({ ...item,
        [isNumeric(item)?'numericValue':'selectedOptionId']: terminal() || !changes.has(item.id) ? responseValue(item) : changes.get(item.id).value,
      })) },
      pendingIds: pending(), invalidNumericIds: invalidNumericIds(), conflicts, busy, phase, message, storageAvailable, retryAt, hasRecoveryCopy,
      serverSelections: server ? Object.fromEntries(selections(server).map((r) => [r.itemId, r.optionId])) : {},
      expired: deadlinePassed(), uncertain,
      canSubmit: Boolean(server && !terminal() && !busy && !changes.size && !conflicts.length
        && !uncertain && !deadlinePassed() && phase === 'ready'),
      canEdit: Boolean(server && !terminal() && !uncertain && !deadlinePassed() && phase !== 'blocked'),
    };
  }
  const emit = () => { if (!stopped) onChange(snapshot()); };
  function persist() {
    if (!server) return;
    if (unreadableDraft && !changes.size && !flight && !uncertain) return;
    try {
      if (changes.size || flight || uncertain) {
        storage().setItem(DRAFT_KEY, JSON.stringify({ version: 1, scope: scopeOf(server),
          savedAt: now(), changes: [...changes], flight, uncertain }));
      } else storage().removeItem(DRAFT_KEY);
      storageAvailable = true;
      hasRecoveryCopy = Boolean(changes.size || flight || uncertain);
      unreadableDraft = false;
    } catch { storageAvailable = false; }
  }
  function restore(portal) {
    if (restored) return;
    restored = true;
    try {
      const raw = storage().getItem(DRAFT_KEY);
      if (!raw) return;
      const record = JSON.parse(raw);
      if (record.version !== 1 || record.scope !== scopeOf(portal)
          || !Number.isFinite(record.savedAt) || now() - record.savedAt > MAX_AGE
          || record.savedAt > now() + 60000) {
        storage().removeItem(DRAFT_KEY);
        message = 'Uma cópia antiga ou de outro acesso não foi aplicada a esta avaliação.';
        return;
      }
      const validOption = (id, value) => portal.items.some(item => item.id===id && draftValueValid(item,value));
      if (!Array.isArray(record.changes) || record.changes.length > portal.items.length
          || record.changes.some((entry) => !Array.isArray(entry) || entry.length !== 2
            || !entry[1] || !validOption(entry[0], entry[1].base) || !validOption(entry[0], entry[1].value))
          || new Set(record.changes.map(([id]) => id)).size !== record.changes.length) throw Error('invalid_draft');
      if (record.flight && (!Number.isInteger(record.flight.revision)
          || !Array.isArray(record.flight.responses) || record.flight.responses.length !== portal.items.length
          || record.flight.responses.some((r) => !r || !validOption(r.itemId, r.optionId))
          || new Set(record.flight.responses.map((r) => r.itemId)).size !== portal.items.length)) throw Error('invalid_flight');
      changes = new Map(record.changes);
      flight = record.flight || null;
      uncertain = record.uncertain === true;
    } catch {
      // Não substitua silenciosamente um registro ilegível por uma cópia vazia.
      storageAvailable = false;
      unreadableDraft = true;
      message = 'Não foi possível recuperar a cópia desta aba. Confira as respostas confirmadas e avise o professor.';
    }
  }
  function accept(portal) {
    if (['checking', 'saving', 'submitting'].includes(phase)) message = '';
    if (!portal.attempt || !['draft', 'submitted'].includes(portal.attempt.status)) {
      phase = 'blocked';
      message = 'Esta tentativa não está mais disponível. Avise o professor antes de iniciar outro acesso.';
      if (!server) server = portal;
      return;
    }
    restore(portal);
    if (server && scopeOf(server) !== scopeOf(portal)) {
      phase = 'blocked';
      message = 'O acesso passou a apontar para outra tentativa. Saia e entre novamente; a cópia pendente não será enviada.';
      return;
    }
    serverOffset = Date.parse(portal.serverTime) - now();
    const ownAck = flight && portal.attempt.revision === flight.revision + 1
      && flight.responses.every((r) => portal.items.some((item) => item.id === r.itemId && equal(item,responseValue(item),r.optionId)));
    conflicts = [];
    for (const [id, change] of changes) {
      const item = portal.items.find((entry) => entry.id === id);
      if (!item) { conflicts.push(id); continue; }
      if (ownAck) change.base = flight.responses.find((r) => r.itemId === id).optionId;
      const olderWriteMayArrive = flight && portal.attempt.revision === flight.revision
        && flight.responses.some((r) => r.itemId === id && r.optionId !== change.value);
      if (equal(item,responseValue(item),change.value) && !olderWriteMayArrive) changes.delete(id);
      else if (!equal(item,responseValue(item),change.base)) conflicts.push(id);
    }
    server = portal;
    flight = null;
    if (uncertain && portal.attempt.status === 'draft') {
      message = 'A entrega ainda não está confirmada. Confira suas respostas e clique em entregar novamente.';
    }
    uncertain = false;
    phase = 'ready';
    if (portal.attempt.status !== 'draft') {
      if (changes.size) message = 'A avaliação foi encerrada. ' + changes.size
        + ' resposta(s) desta aba não coincidem com a entrega e não foram incluídas. Avise o professor.';
    } else if (portal.assessment.status !== 'open') {
      phase = 'blocked';
      message = 'Esta aplicação não está aberta para alterações. Avise o professor.';
    }
    persist();
  }
  function queue(delay = 350) {
    cancel(timer);
    if (!stopped && phase !== 'blocked' && !terminal()) timer = schedule(() => {
      if (canAutoRetry()) void sync();
    }, delay);
  }
  function fail(error) {
    const status = error.response?.status;
    const permanent = [400, 401, 403, 404, 410, 423].includes(status);
    phase = permanent ? 'blocked' : 'offline';
    message = error.response?.data?.error || (terminal()
      ? 'Não foi possível atualizar o resultado e a orientação. Tente novamente.'
      : uncertain
      ? 'A conexão falhou durante a entrega. Estamos verificando se ela chegou; não envie novamente ainda.'
      : 'Não foi possível confirmar o salvamento. Suas escolhas continuam nesta aba.');
    failures += 1;
    const retrySeconds = Number(error.response?.headers?.['retry-after'] || error.response?.data?.retryAfterSeconds);
    const delay = Math.max(Math.min(60000, 5000 * 2 ** Math.min(failures - 1, 4)),
      Number.isFinite(retrySeconds) ? Math.min(86400000, Math.max(0, retrySeconds * 1000)) : 0);
    retryAt = now() + delay;
    if (status === 429) rateLimitedUntil = retryAt;
    persist();
    if (!permanent) queue(delay);
  }
  async function call(method, path, body) {
    abort = new AbortController();
    return request(method, path, body, abort.signal);
  }
  async function sync() {
    if (stopped || busy || phase === 'blocked' || now() < retryAt) return;
    const submitted = terminal();
    cancel(timer);
    busy = true;
    phase = 'checking';
    emit();
    try {
      // Toda repetição consulta o servidor antes de escrever: a resposta HTTP pode ter se perdido após o commit.
      const current = await call('get', '/me');
      if (stopped) return;
      // A consulta após a entrega nunca pode reabrir a tentativa nem gravar respostas.
      if (submitted && current.attempt?.status !== 'submitted') throw new Error('Entrega não confirmada na consulta.');
      accept(current);
      const invalid = new Set(invalidNumericIds());
      if (!submitted && phase !== 'blocked' && !terminal() && !deadlinePassed()
          && changes.size > invalid.size && !conflicts.length) {
        // A API recebe todas as respostas. Reuse o valor confirmado quando a
        // digitação estiver incompleta e mantenha a edição na cópia da aba.
        const responses = selections(server).map((r) => ({ ...r,
          optionId: changes.has(r.itemId) && !invalid.has(r.itemId) ? changes.get(r.itemId).value : r.optionId }));
        flight = { revision: server.attempt.revision, responses };
        persist();
        phase = 'saving';
        emit();
        const saved = await call('put', '/responses', { expectedRevision: flight.revision,
          responses:responses.map(r=>isNumeric(server.items.find(item=>item.id===r.itemId))
            ? {itemId:r.itemId,numericValue:canonicalNumericInput(r.optionId)} : r) });
        if (stopped) return;
        accept(saved);
      }
      failures = 0;
      retryAt = 0;
    } catch (error) { if (!stopped) fail(error); }
    finally {
      busy = false;
      emit();
      if (!stopped && phase === 'ready' && !terminal()
          && ((changes.size > invalidNumericIds().length && !conflicts.length && !deadlinePassed()) || expired)) queue(expired ? 1000 : 350);
    }
  }
  return {
    snapshot,
    start(portal) {
      if (portal) { accept(portal); emit(); if (changes.size || uncertain) queue(); }
      else void sync();
    },
    retry() {
      if (phase === 'blocked' || now() < rateLimitedUntil) return;
      retryAt = 0;
      void sync();
    },
    offline() {
      if (stopped || phase === 'blocked' || terminal() || busy) return;
      phase = 'offline';
      message = 'Sem conexão com a rede. A confirmação depende do servidor.';
      emit();
    },
    choose(id, value) {
      if (!snapshot().canEdit || conflicts.includes(id)) return;
      const item = server.items.find((entry) => entry.id === id);
      if (!item || !draftValueValid(item,value)) return;
      changes.set(id, { base: changes.has(id)?changes.get(id).base:responseValue(item), value });
      if (!busy && !flight && equal(item,responseValue(item),value)) changes.delete(id);
      if (phase !== 'offline') message = '';
      persist(); emit();
      if (!busy) queue(Math.max(350, retryAt - now()));
    },
    resolve(id, keepLocal) {
      if (busy || !conflicts.includes(id) || terminal() || deadlinePassed()) return;
      const item = server.items.find((entry) => entry.id === id);
      if (!item) return;
      if (keepLocal) changes.get(id).base = responseValue(item);
      else changes.delete(id);
      conflicts = conflicts.filter((entry) => entry !== id);
      persist(); emit(); queue();
    },
    expire() { if (expired) return; expired = true; emit(); void sync(); },
    async submit() {
      if (!snapshot().canSubmit) return;
      cancel(timer);
      busy = true; uncertain = true; phase = 'submitting'; message = '';
      persist(); emit();
      try {
        const submitted = await call('post', '/submit', { expectedRevision: server.attempt.revision });
        if (!stopped) accept(submitted);
      } catch (error) { if (!stopped) fail(error); }
      finally { busy = false; emit(); }
    },
    forget() { try { storage().removeItem(DRAFT_KEY); hasRecoveryCopy = false; } catch { /* Não use limpeza global. */ } },
    dispose() { stopped = true; cancel(timer); abort?.abort(); },
  };
}
