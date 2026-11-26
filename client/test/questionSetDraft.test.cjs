const test = require('node:test');
const assert = require('node:assert/strict');
const moduleReady = import('../src/services/questionSetDraft.mjs');
function memoryStorage() {
  const data = new Map();
  return { get length() { return data.size; }, key: i => [...data.keys()][i] ?? null,
    getItem: k => data.get(k) ?? null, setItem: (k, v) => data.set(k, String(v)), removeItem: k => data.delete(k) };
}
const body = { title: 'Frações — 6º ano', description: null, is_public: false,
  question_ids: [2, 1], question_items: [{ question_id: 2, show_image: false }, { question_id: 1, show_image: true }] };
const draft = () => ({ selectedIds: [2, 1], selected: {
  2: { id: 2, statement: 'Questão autoral', question_code: 'Q2', source: 'teacher', show_image: false },
  1: { id: 1, statement: 'Questão oficial', question_code: 'Q1', show_image: true },
}, form: { title: body.title, description: '', is_public: false }, pending: null });

test('resposta perdida conserva chave e corpo mesmo após edição externa e recarga', async () => {
  const { createQuestionSetSubmission, questionSetDraftStore } = await moduleReady;
  const storage = memoryStorage();
  const controller = createQuestionSetSubmission(null, () => 'request-key-00000001');
  const input = structuredClone(body);
  const first = controller.begin(input);
  input.title = 'Alterado'; first.body.question_ids.reverse();
  assert.equal(controller.failed(new Error('connection reset')), true);
  const store = questionSetDraftStore(1, () => storage);
  assert.equal(store.write({ ...draft(), pending: controller.pending }), true);
  const resumed = createQuestionSetSubmission(store.read().pending, () => { throw Error('Não pode gerar outra chave'); });
  const retry = resumed.begin({ title: 'Outro envio' });
  assert.deepEqual(retry, { key: 'request-key-00000001', body });
  assert.equal(resumed.failed({ response: { status: 403 } }), true, 'rejeição posterior não prova que primeiro envio falhou');
  assert.deepEqual(resumed.begin({}), retry);
  resumed.confirmed(); store.clear();
  assert.equal(store.read(), null);
  assert.equal(resumed.pending, null);
});

test('rejeição definitiva inicial libera edição; timeout e erro de servidor mantêm o envio', async () => {
  const { createQuestionSetSubmission } = await moduleReady;
  for (const status of [400, 403, 422, 429]) {
    const controller = createQuestionSetSubmission(null, () => 'request-key-00000001');
    controller.begin(body);
    assert.equal(controller.failed({ response: { status } }), false);
    assert.equal(controller.pending, null);
  }
  for (const status of [408, 500, 502, 503]) {
    const controller = createQuestionSetSubmission(null, () => 'request-key-00000001');
    const first = controller.begin(body);
    assert.equal(controller.failed({ response: { status } }), true);
    assert.deepEqual(controller.begin({}), first);
  }
});

test('rascunho preserva ordem e imagem; não é lido por outra conta', async () => {
  const { questionSetDraftStore } = await moduleReady;
  const storage = memoryStorage();
  const own = questionSetDraftStore(7, () => storage);
  assert.equal(own.write({ ...draft(), context: { classId: 'class-synthetic-0001', quick: true } }), true);
  const recovered = questionSetDraftStore(7, () => storage).read();
  assert.deepEqual(recovered.selectedIds, [2, 1]);
  assert.equal(recovered.selected[2].show_image, false);
  assert.equal(recovered.form.title, body.title);
  assert.deepEqual(recovered.context, { classId: 'class-synthetic-0001', quick: true });
  assert.equal(questionSetDraftStore(8, () => storage).read(), null);
  assert.equal(questionSetDraftStore(null, () => storage).write(draft()), false);
});

test('exclusão ou conflito encerram a confirmação sem criar nova chave, inclusive após recarga', async () => {
  const { createQuestionSetSubmission, questionSetDraftStore } = await moduleReady;
  for (const [status, code] of [[410, 'question_set_deleted'], [409, 'question_set_idempotency_conflict']]) {
    const controller = createQuestionSetSubmission(null, () => 'request-key-00000001');
    controller.begin(body); controller.failed(new Error('Resposta perdida'));
    assert.equal(controller.failed({ response: { status, data: { code } } }), true);
    assert.equal(controller.terminal, code);
    assert.throws(() => controller.begin(body), /encerrado/);
    const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
    store.write({ ...draft(), pending: controller.pending });
    const restored = createQuestionSetSubmission(store.read().pending);
    assert.equal(restored.terminal, code);
    assert.throws(() => restored.begin(body), /encerrado/);
  }
});

test('saída, bloqueio entre abas e troca de conta limpam rascunhos sem apagar preferências', async () => {
  const { questionSetDraftStore } = await moduleReady;
  const { createAuthStorage } = await import('../src/services/authStorage.mjs');
  for (const operation of ['clear', 'lock', 'save']) {
    const local = memoryStorage(), session = memoryStorage();
    const auth = createAuthStorage({ local: () => local, session: () => session });
    const user = { id: 1, name: 'Teste', email: 'test@example.invalid', role: 'professor' };
    auth.save('original', user);
    session.setItem('theme', 'dark');
    questionSetDraftStore(1, () => session).write(draft());
    questionSetDraftStore(2, () => session).write(draft());
    if (operation === 'save') auth.save('next', { ...user, id: 2 });
    else auth[operation]();
    assert.equal(questionSetDraftStore(1, () => session).read(), null);
    assert.equal(questionSetDraftStore(2, () => session).read(), null);
    assert.equal(session.getItem('theme'), 'dark');
  }
});

test('dados inválidos, JSON quebrado e armazenamento bloqueado não são tratados como rascunho salvo', async () => {
  const { questionSetDraftStore, QUESTION_SET_DRAFT_PREFIX } = await moduleReady;
  const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
  for (const raw of ['{', JSON.stringify({ ...draft(), selectedIds: [1, 1] }),
    JSON.stringify({ ...draft(), pending: { key: 'invalid', body } }),
    JSON.stringify({ ...draft(), form: { title: 'x'.repeat(201), description: '' } })]) {
    storage.setItem(QUESTION_SET_DRAFT_PREFIX + 1, raw);
    assert.equal(store.read(), null);
  }
  const blocked = questionSetDraftStore(1, () => { throw Error('Storage disabled'); });
  assert.equal(blocked.read(), null);
  assert.equal(blocked.write(draft()), false);
  assert.doesNotThrow(() => blocked.clear());
});

test('rascunho indisponível ou inválido é distinto de ausência e nunca é apagado pela leitura', async () => {
  const { questionSetDraftStore, QUESTION_SET_DRAFT_PREFIX } = await moduleReady;
  const storage = memoryStorage(), store = questionSetDraftStore(1, () => storage);
  assert.equal(store.inspect().status, 'missing');
  for (const raw of ['{', '', JSON.stringify({ pending: { key: 'already-issued-key' } })]) {
    storage.setItem(QUESTION_SET_DRAFT_PREFIX + 1, raw);
    assert.equal(store.inspect().status, 'invalid');
    assert.equal(storage.getItem(QUESTION_SET_DRAFT_PREFIX + 1), raw);
  }
  const blocked = questionSetDraftStore(1, () => { throw Error('Storage disabled'); });
  assert.equal(blocked.inspect().status, 'unavailable');
  assert.equal(blocked.clear(), false);
  assert.equal(store.clear(), true);
  assert.equal(store.inspect().status, 'missing');
});

test('retomada apresenta o pedido congelado quando seleção e formulário divergirem', async () => {
  const { normalizeQuestionSetDraft } = await moduleReady;
  const pending = { key: 'request-key-00000001', body };
  const input = draft();
  input.selectedIds = [1];
  delete input.selected[2];
  input.form = { title: 'Edição posterior', description: 'Outro texto', is_public: true };
  input.selected[1].show_image = false;
  const actual = normalizeQuestionSetDraft({ ...input, pending });
  assert.deepEqual(actual.pending, pending);
  assert.deepEqual(actual.selectedIds, body.question_ids);
  assert.equal(actual.form.title, body.title);
  assert.equal(actual.form.description, '');
  assert.equal(actual.form.is_public, false);
  assert.equal(actual.selected[1].show_image, true);
  assert.equal(actual.selected[2].show_image, false);
  assert.match(actual.selected[2].statement, /Confira o conteúdo/);
});

test('confirmação exige recurso completo da própria conta e permite conteúdo editado após criação', async () => {
  const { confirmedQuestionSetId } = await moduleReady;
  const resource = { id: 8, user_id: 1, title: 'Título já editado', description: null,
    is_public: 0, question_count: 2, author_question_count: 1 };
  assert.equal(confirmedQuestionSetId(resource, 1), 8);
  for (const invalid of [{ id: 8 }, { ...resource, user_id: 2 }, { ...resource, question_count: 1.5 },
    { ...resource, author_question_count: 3 }, { ...resource, title: '' }, { ...resource, is_public: null },
    { ...resource, description: undefined }]) {
    assert.equal(confirmedQuestionSetId(invalid, 1), null);
  }
});
