const test = require('node:test'), assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const BASE = '/question-bank/ai-authoring/requests';
let createAiAuthoringSession, view;
test.before(async () => {
  ({ createAiAuthoringSession } = await import('../../client/src/services/aiAuthoringSession.mjs'));
  view = await import('../../client/src/services/aiAuthoringView.mjs');
});
const input = () => ({ mode: 'new_question', gradeId: 7, unitId: 1, skillIds: [71], academicYear: 2026,
  teacherText: 'Divisão de materiais entre grupos.', privacyConfirmed: true });
function result(key = randomUUID(), status = 'succeeded', id = randomUUID()) {
  return { id, requestKey: key, status, createdAt: Date.now(), reviewed: false, model: 'gpt-fixture', failureCode: null,
    brief: { version: 1, mode: 'new_question', grade: { id: 7, name: '7º Ano - EF' }, unit: { id: 1, name: 'Números' },
      skills: [{ id: 71, code: 'EF07MA01', description: 'Habilidade sintética para teste de vínculo.' }],
      academicYear: 2026, teacherText: input().teacherText, status: 'prepared_not_generated', requiresTeacherReview: true },
    suggestion: status === 'succeeded' ? { status: 'awaiting_teacher_review', reviewed: false, publishable: false,
      statement: 'Quanto é 24 dividido por 4?', explanation: '24 dividido por 4 é 6.',
      gradeId: 7, unitId: 1, skillIds: [71], academicYear: 2026,
      options: ['4','6','8','12'].map((text, i) => ({ text, correct: i === 1 })) } : null };
}
const catalog = () => ({ available: true, maxSkills: 1, dailyLimit: 5, latest: null, curriculum: {
  grades: [{ id: 7, name: '7º Ano - EF' }], units: [{ id: 1, name: 'Números' }],
  skills: [{ id: 71, grade_id: 7, unit_id: 1, code: 'EF07MA01', description: 'Habilidade sintética.' }],
} });
const deferred = () => { let resolve, reject; const promise = new Promise((ok, no) => { resolve = ok; reject = no; }); return { promise, resolve, reject }; };

test('contrato da interface rejeita respostas incompletas, de outro pedido e confirmações não booleanas', () => {
  const valid = result(); assert.equal(view.parseAiRequest(valid), valid);
  assert.throws(() => view.parseAiRequest(valid, { key: randomUUID() }));
  assert.throws(() => view.parseAiRequest(valid, { id: randomUUID() }));
  for (const mutate of [r => { r.reviewed = 'false'; }, r => { r.brief = null; }, r => { r.createdAt = 'ontem'; },
    r => { r.suggestion.academicYear = 2027; }, r => { r.suggestion.skillIds = [99]; },
    r => { r.suggestion.options[1].correct = 1; }, r => { r.suggestion.options[0].text = '6'; },
    r => { r.suggestion.publishable = true; }, r => { r.status = 'processing'; }, r => { r.suggestion.explanation = ''; }]) {
    const bad = structuredClone(valid); mutate(bad); assert.throws(() => view.parseAiRequest(bad));
  }
  assert.equal(view.parseAiBootstrap(catalog()).latest, null);
  for (const mutate of [c => { c.curriculum = null; }, c => { c.available = 'true'; }, c => { c.latest = {}; },
    c => { c.curriculum.skills[0].grade_id = 999; }, c => { c.curriculum.skills.push(c.curriculum.skills[0]); },
    c => { c.curriculum.grades = [null]; }, c => { c.dailyLimit = 50; }]) {
    const bad = catalog(); mutate(bad); assert.throws(() => view.parseAiBootstrap(bad));
  }
});

test('mudanças no conteúdo exigem nova confirmação de privacidade e validação do recorte', () => {
  const original = input();
  for (const patch of [{ teacherText: 'Outro tema' }, { gradeId: 8 }, { unitId: 2 }, { skillIds: [72] },
    { academicYear: 2027 }, { mode: 'complement' }, { teacherText: 'Outro texto', privacyConfirmed: true }]) {
    assert.equal(view.editAiInput(original, patch).privacyConfirmed, false);
  }
  assert.equal(view.editAiInput(original, { privacyConfirmed: true }).privacyConfirmed, true);
  assert.equal(view.editAiInput(original, { privacyConfirmed: 'true' }).privacyConfirmed, false);
  assert.equal(original.privacyConfirmed, true);
  assert.equal(view.aiBriefError(original, catalog()), '');
  for (const patch of [{ academicYear: 0 }, { academicYear: 2026.5 }, { academicYear: 2101 }, { academicYear: '2026' },
    { skillIds: [] }, { unitId: 99 }, { mode: 'complement', teacherText: ' ' }, { teacherText: 'x'.repeat(4001) }, { privacyConfirmed: false }]) {
    assert.ok(view.aiBriefError({ ...original, ...patch }, catalog()));
  }
  assert.equal(view.aiInput({ statement: 'Meu enunciado' }).mode, 'complement');
  assert.equal(view.aiInput({ statement: '' }).mode, 'new_question');
});

test('reenvio após perda de conexão conserva chave e conteúdo, sem disparo duplicado', async () => {
  const key = randomUUID(), first = deferred(), calls = [];
  const session = createAiAuthoringSession({ post: (...args) => { calls.push(args); return calls.length === 1 ? first.promise : Promise.resolve({ data: result(key) }); } }, { createKey: () => key });
  const sent = input(), pending = session.send(sent); sent.teacherText = 'Mutação externa';
  await session.send(input()); assert.equal(calls.length, 1); assert.equal(session.reset(), false);
  first.reject(new Error('connection lost')); await pending;
  assert.equal(session.getSnapshot().uncertain, true);
  assert.equal(session.reset(), false); assert.equal(session.setDraft(input()), false);
  await session.send({ ...input(), teacherText: 'Não deve substituir o pedido incerto' });
  assert.equal(calls.length, 2); assert.deepEqual(calls[0][1], input()); assert.deepEqual(calls[1][1], input());
  assert.equal(calls[0][2].headers['Idempotency-Key'], key); assert.equal(calls[1][2].headers['Idempotency-Key'], key);
  assert.equal(session.getSnapshot().result.status, 'succeeded'); assert.equal(session.getSnapshot().uncertain, false);
});

test('cancelamento localiza o pedido pela chave exata e ignora POST atrasado em processamento', async () => {
  const key = randomUUID(), id = randomUUID(), pendingResponse = deferred(), calls = [];
  const session = createAiAuthoringSession({
    get: async path => { calls.push(path); return { data: result(key, 'processing', id) }; },
    post: async (path) => { calls.push(path); return path === BASE ? pendingResponse.promise : { data: result(key, 'cancelled', id) }; },
  }, { createKey: () => key });
  const pending = session.send(input()); await session.refresh({ cancel: true });
  assert.deepEqual(calls, [BASE, `${BASE}/by-key/${key}`, `${BASE}/${id}/cancel`]);
  assert.equal(session.getSnapshot().result.status, 'cancelled'); assert.equal(session.reset(), false);
  pendingResponse.resolve({ data: result(key, 'processing', id) }); await pending;
  assert.equal(session.getSnapshot().result.status, 'cancelled'); assert.equal(session.getSnapshot().busy, false);
  assert.equal(session.reset(), true); assert.equal(session.getSnapshot().result, null);
});

test('duas sessões mantêm pedidos separados; retomar não segue o último pedido de outra aba', async () => {
  const a = result(randomUUID(), 'processing'), b = result(randomUUID(), 'processing'), gets = [], posts = [];
  const api = {
    get: async path => { gets.push(path); return { data: structuredClone(path.endsWith(a.id) ? a : b) }; },
    post: async path => { posts.push(path); return { data: { ...a, status: 'cancelled' } }; },
  };
  const first = createAiAuthoringSession(api), second = createAiAuthoringSession(api);
  await first.refresh({ resumeId: a.id }); await second.refresh({ resumeId: b.id });
  await first.refresh({ resumeId: b.id }); // Cannot replace an already open request.
  await first.refresh({ cancel: true });
  assert.deepEqual(gets, [`${BASE}/${a.id}`, `${BASE}/${b.id}`, `${BASE}/${a.id}`]);
  assert.deepEqual(posts, [`${BASE}/${a.id}/cancel`]);
  assert.equal(first.getSnapshot().result.id, a.id); assert.equal(second.getSnapshot().result.id, b.id);
  assert.equal(second.getSnapshot().result.status, 'processing');
});

test('pedido recusado por outro em andamento permite retomar explicitamente o anterior', async () => {
  const previous = result(randomUUID(), 'processing'), paths = [];
  const session = createAiAuthoringSession({
    post: async () => { throw { response: { status: 409, data: { error: 'Já há uma sugestão em andamento.' } } }; },
    get: async path => { paths.push(path); return { data: previous }; },
  });
  await session.send(input()); assert.equal(session.getSnapshot().uncertain, false);
  await session.refresh({ resumeId: previous.id });
  assert.deepEqual(paths, [`${BASE}/${previous.id}`]); assert.equal(session.getSnapshot().result.id, previous.id);
});

test('consultas simultâneas não duplicam ações e não permitem descartar pedido no meio da conferência', async () => {
  const r = result(), read = deferred(); let gets = 0;
  const session = createAiAuthoringSession({ get: () => { gets++; return read.promise; } });
  const pending = session.refresh({ resumeId: r.id });
  await session.refresh({ cancel: true }); await session.send(input());
  assert.equal(gets, 1); assert.equal(session.reset(), false); assert.equal(session.getSnapshot().checking, true);
  read.resolve({ data: r }); await pending;
  assert.equal(session.getSnapshot().checking, false); assert.equal(session.getSnapshot().result.id, r.id);
});

test('resposta de outro pedido é recusada sem cancelar ou incorporar a sugestão alheia', async () => {
  const wanted = randomUUID(), other = result(); let posts = 0;
  const session = createAiAuthoringSession({ get: async () => ({ data: other }), post: async () => { posts++; } });
  await session.refresh({ resumeId: wanted, cancel: true });
  assert.equal(posts, 0); assert.equal(session.getSnapshot().result, null); assert.ok(session.getSnapshot().error);
});

test('revisão deve ser confirmada pelo servidor e não é desfeita por uma consulta defasada', async () => {
  const r = result(), posted = [], checks = { math: true, clarity: true, curriculum: true }; let confirmed = false;
  const session = createAiAuthoringSession({ get: async () => ({ data: structuredClone(r) }),
    post: async (path, body) => { posted.push([path, body]); return { data: { ...structuredClone(r), reviewed: confirmed } }; } });
  await session.refresh({ resumeId: r.id });
  assert.equal(await session.review(checks), null); assert.equal(session.getSnapshot().result.reviewed, false);
  confirmed = true; assert.equal((await session.review(checks)).reviewed, true);
  await session.refresh(); assert.equal(session.getSnapshot().result.reviewed, true);
  assert.deepEqual(posted[0], [`${BASE}/${r.id}/review`, checks]);
  const original = { image_path: 'keep.png', support_text: 'Apoio mantido', id: 12 };
  const editor = view.aiToEditor(original, session.getSnapshot().result);
  assert.equal(editor.image_path, original.image_path); assert.equal(editor.support_text, original.support_text);
  assert.equal(editor.id, 12); assert.equal(editor.ai_request_id, r.id); assert.equal(editor.options[1].is_correct, 1);
  assert.throws(() => view.aiToEditor(original, { ...r, reviewed: 'true' }));
  assert.deepEqual(original, { image_path: 'keep.png', support_text: 'Apoio mantido', id: 12 });
});

test('falha de revisão preserva a sugestão e não expõe detalhes sem mensagem pública', async () => {
  const r = result();
  const session = createAiAuthoringSession({ get: async () => ({ data: r }),
    post: async () => { throw new Error('internal secret'); } });
  await session.refresh({ resumeId: r.id });
  assert.equal(await session.review({ math: true, clarity: true, curriculum: true }), null);
  assert.equal(session.getSnapshot().result.id, r.id); assert.equal(session.getSnapshot().busy, false);
  assert.doesNotMatch(session.getSnapshot().error, /internal secret/);
});

test('rascunho vive apenas no editor; desmontar a ajuda não o perde, fechar o editor cancela callbacks', async () => {
  const key = randomUUID(), pending = deferred(); let signal, updates = 0;
  const session = createAiAuthoringSession({ post: (_path, _body, config) => { signal = config.signal; return pending.promise; } }, { createKey: () => key });
  const initial = input(), copy = session.getDraft(initial); copy.teacherText = 'Mutação externa';
  assert.deepEqual(session.getDraft({}), initial);
  assert.equal(session.setDraft({ ...initial, teacherText: 'Rascunho preservado' }), true);
  const off = session.subscribe(() => { updates++; });
  const sent = session.send(initial); off(); const count = updates;
  assert.equal(session.getDraft({}).teacherText, 'Rascunho preservado');
  const snapshot = session.getSnapshot(); session.dispose(); assert.equal(signal.aborted, true);
  pending.resolve({ data: result(key) }); await sent;
  assert.equal(updates, count); assert.equal(session.getSnapshot(), snapshot);
  await session.send(input()); await session.refresh(); assert.equal(await session.review({}), null);
  assert.equal(session.reset(), false);
  assert.equal(createAiAuthoringSession({}).getDraft(initial).teacherText, initial.teacherText);
});

test('pedido não localizado mantém reenvio idempotente, sem procurar outro pedido nem gerar sozinho', async () => {
  const key = randomUUID(), paths = [];
  const session = createAiAuthoringSession({ post: async () => { throw new Error('connection lost'); },
    get: async path => { paths.push(path); throw { response: { status: 404 } }; } }, { createKey: () => key });
  await session.send(input()); await session.refresh();
  assert.deepEqual(paths, [`${BASE}/by-key/${key}`]); assert.equal(session.getSnapshot().uncertain, true);
  assert.equal(session.getSnapshot().result, null); assert.match(session.getSnapshot().error, /Reenviar o mesmo pedido/);
});
