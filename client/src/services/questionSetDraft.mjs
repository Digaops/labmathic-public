// Temporary, account-scoped working copy. Never store student data or credentials.
export const QUESTION_SET_DRAFT_PREFIX = 'labmathic_question_set_draft_v1:';
const validId = value => Number.isSafeInteger(value) && value > 0;
const validKey = value => typeof value === 'string' && /^[A-Za-z0-9._:-]{16,120}$/.test(value);
const text = (value, max) => typeof value === 'string' && value.length <= max;

export function normalizeQuestionSetDraft(value) {
  if (!value || !Array.isArray(value.selectedIds) || value.selectedIds.length > 100
      || value.selectedIds.some(id => !validId(id)) || new Set(value.selectedIds).size !== value.selectedIds.length
      || !text(value.form?.title, 200) || !text(value.form?.description, 5000)) return null;
  let selected = {};
  for (const id of value.selectedIds) {
    const q = value.selected?.[id];
    if (!q || !text(q.question_code, 200) || !text(q.statement, 20000)
        || (q.image_path != null && !text(q.image_path, 1000))) return null;
    selected[id] = { id, question_code: q.question_code, statement: q.statement,
      image_path: q.image_path || null, source: q.source === 'teacher' ? 'teacher' : 'official',
      show_image: q.show_image !== false, grade_id: q.grade_id, skill_id: q.skill_id,
      skill_code: typeof q.skill_code === 'string' ? q.skill_code.slice(0, 100) : '',
      grade_name: typeof q.grade_name === 'string' ? q.grade_name.slice(0, 200) : '',
      question_type: q.question_type === 'multiple_choice' ? 'multiple_choice' : '',
      quick_compatible: q.quick_compatible === true,
      ...(q.editorial_pilot === true ? { editorial_pilot: true } : {}) };
  }
  let pending = null;
  if (value.pending) {
    const { key, body } = value.pending;
    if (!validKey(key) || !body || !text(body.title, 200) || !body.title.trim()
        || (body.description != null && !text(body.description, 5000))
        || !Array.isArray(body.question_ids) || !body.question_ids.length || body.question_ids.length > 100
        || body.question_ids.some(id => !validId(id)) || new Set(body.question_ids).size !== body.question_ids.length
        || !Array.isArray(body.question_items) || body.question_items.length !== body.question_ids.length
        || body.question_items.some((item, i) => item?.question_id !== body.question_ids[i] || typeof item.show_image !== 'boolean')) return null;
    pending = { key, ...( ['question_set_deleted', 'question_set_idempotency_conflict'].includes(value.pending.terminal)
      ? { terminal: value.pending.terminal } : {}), body: { title: body.title, description: body.description || null,
      is_public: body.is_public === true, question_ids: [...body.question_ids],
      question_items: body.question_items.map(item => ({ question_id: item.question_id, show_image: item.show_image })) } };
  }
  const context = { classId: /^[a-z\d_-]{16,100}$/i.test(value.context?.classId || '') ? value.context.classId : '',
    quick: value.context?.quick === true };
  // An issued request is immutable. Show exactly that request when resuming,
  // even if a stale editor snapshot was stored alongside its receipt.
  if (pending) {
    selected = Object.fromEntries(pending.body.question_items.map(item => [item.question_id, {
      ...(selected[item.question_id] || { id: item.question_id, question_code: `Questão ${item.question_id}`,
        statement: 'Confira o conteúdo desta questão no simulado após confirmar o salvamento.', image_path: null,
        source: 'official', quick_compatible: false }), show_image: item.show_image,
    }]));
    return { selectedIds: [...pending.body.question_ids], selected, context, pending,
      form: { title: pending.body.title, description: pending.body.description || '', is_public: pending.body.is_public } };
  }
  return { selectedIds: [...value.selectedIds], selected, context,
    form: { title: value.form.title, description: value.form.description, is_public: value.form.is_public === true }, pending };
}

export function questionSetDraftStore(userId, storage = () => globalThis.sessionStorage) {
  const key = validId(userId) ? QUESTION_SET_DRAFT_PREFIX + userId : null;
  function inspect() {
    if (!key) return { status: 'unavailable', draft: null };
    let raw;
    try { raw = storage().getItem(key); } catch { return { status: 'unavailable', draft: null }; }
    if (raw == null) return { status: 'missing', draft: null };
    try {
      const draft = raw.length <= 1_000_000 ? normalizeQuestionSetDraft(JSON.parse(raw)) : null;
      return { status: draft ? 'ready' : 'invalid', draft };
    } catch { return { status: 'invalid', draft: null }; }
  }
  return {
    inspect,
    read() { return inspect().draft; },
    write(value) {
      if (!key) return false;
      try {
        const draft = normalizeQuestionSetDraft(value);
        if (!draft) return false;
        if (!draft.selectedIds.length && !draft.form.title && !draft.form.description && !draft.pending) {
          storage().removeItem(key); return true;
        }
        const raw = JSON.stringify(draft);
        if (raw.length > 1_000_000) return false;
        storage().setItem(key, raw); return true;
      } catch { return false; }
    },
    clear() { try { if (!key) return false; storage().removeItem(key); return true; } catch { return false; } },
  };
}

export function confirmedQuestionSetId(value, ownerId) {
  // A replay returns the current owned resource, which may have been edited.
  // Validate its identity and envelope without comparing mutable content.
  if (!value || !validId(value.id) || value.user_id !== ownerId
      || typeof value.title !== 'string' || !value.title.trim()
      || (value.description !== null && typeof value.description !== 'string')
      || ![0, 1, false, true].includes(value.is_public)
      || !Number.isSafeInteger(value.question_count) || value.question_count < 0
      || !Number.isSafeInteger(value.author_question_count) || value.author_question_count < 0
      || value.author_question_count > value.question_count) return null;
  return value.id;
}

export function clearQuestionSetDrafts(storage) {
  // Collect before removing: Storage indices change after each removal.
  const keys = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key?.startsWith(QUESTION_SET_DRAFT_PREFIX)) keys.push(key);
  }
  keys.forEach(key => storage.removeItem(key));
}

export function createQuestionSetSubmission(initial = null, makeKey = () => globalThis.crypto.randomUUID()) {
  let pending = initial ? structuredClone(initial) : null;
  let uncertain = Boolean(pending);
  return {
    get pending() { return pending ? structuredClone(pending) : null; },
    get uncertain() { return uncertain; },
    get terminal() { return pending?.terminal || null; },
    begin(body) {
      if (pending?.terminal) throw new Error('Este envio foi encerrado.');
      if (!pending) pending = { key: makeKey(), body: structuredClone(body) };
      return structuredClone(pending);
    },
    failed(error) {
      const status = error?.response?.status;
      const code = error?.response?.data?.code;
      if (pending && ((status === 410 && code === 'question_set_deleted')
          || (status === 409 && code === 'question_set_idempotency_conflict'))) pending.terminal = code;
      uncertain = uncertain || Boolean(pending?.terminal) || !Number.isInteger(status) || status < 400 || status >= 500 || status === 408;
      if (!uncertain) pending = null;
      return uncertain;
    },
    confirmed() { pending = null; uncertain = false; },
  };
}
