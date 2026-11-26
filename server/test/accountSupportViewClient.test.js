const test = require('node:test'), assert = require('node:assert/strict');
const view = import('../../client/src/services/accountSupportView.mjs');
const user = { id: 4, role: 'professor' }, admin = { id: 1, role: 'admin' };
const prefs = { grades: [{ id: 1, name: '1º Ano' }, { id: 2, name: '2º Ano' }], selectedGradeIds: [1], revision: 2, selectionMode: 'selected' };
const thread = { id: 3, professor_id: 4, subject: 'Sugestão', status: 'open', professor_name: 'Docente de teste', professor_email: 'teste@example.invalid', unread_count: 1, message_count: 1 };
const message = { id: 8, thread_id: 3, sender_id: 4, sender_role: 'professor', sender_name: 'Docente de teste', body: 'Preciso de ajuda', created_at: '2026-09-09 12:00:00', read_at: null };
test('preferências distinguem todos, selecionados, catálogo ausente e identidades inválidas', async () => {
  const v = await view; assert.deepEqual(v.parsePreferences(prefs), prefs);
  assert.equal(v.parsePreferences({ ...prefs, selectedGradeIds: [], selectionMode: 'all' }).selectionMode, 'all');
  for (const bad of [{}, { ...prefs, selectedGradeIds: [3] }, { ...prefs, selectedGradeIds: [1, 1] }, { ...prefs, revision: -1 }, { ...prefs, selectionMode: 'all' }, { ...prefs, grades: [{ id: 1, name: '' }] }]) assert.throws(() => v.parsePreferences(bad));
  assert.ok(v.sameIds([1, 2], [2, 1])); assert.ok(!v.sameIds([1], [2]));
});
test('perfil exige a mesma conta/papel; senha só confirma com token', async () => {
  const v = await view, account = { ...user, name: 'Nome', email: 'email@example.invalid' };
  assert.equal(v.parseAccount(account, user), account);
  assert.throws(() => v.parseAccount({ ...account, id: 5 }, user)); assert.throws(() => v.parseAccount({ ...account, role: 'admin' }, user));
  assert.throws(() => v.parsePasswordChange({ message: 'ok' })); assert.equal(v.parsePasswordChange({ token: 'synthetic' }), 'synthetic');
});
test('conversas verificam dono e vazio real sem transformar contrato inválido em lista vazia', async () => {
  const v = await view; assert.deepEqual(v.parseSupportList({ threads: [] }, user).threads, []);
  assert.equal(v.parseSupportList({ threads: [thread] }, user).threads.length, 1);
  assert.throws(() => v.parseSupportList({}, user)); assert.throws(() => v.parseSupportList({ threads: [{ ...thread, professor_id: 6 }] }, user));
  assert.throws(() => v.parseSupportList({ threads: [thread, thread] }, user));
  assert.throws(() => v.parseSupportList({ threads: [thread] }, admin));
  assert.equal(v.parseSupportList({ threads: [], totals: { total_threads: 0, open_threads: null, unread_messages: 0, by_subject: [] } }, admin).threads.length, 0);
});
test('detalhe rejeita outra conversa, assunto, remetente e mensagem malformada; legado continua legível', async () => {
  const v = await view, detail = { thread, messages: [message] };
  assert.equal(v.parseSupportDetail(detail, user, 3, 'Sugestão'), detail);
  assert.throws(() => v.parseSupportDetail(detail, user, 8)); assert.throws(() => v.parseSupportDetail(detail, user, 3, 'Outro assunto'));
  assert.throws(() => v.parseSupportDetail({ thread, messages: [{ ...message, thread_id: 4 }] }, user, 3));
  assert.throws(() => v.parseSupportDetail({ thread, messages: [{ ...message, sender_id: 6 }] }, user, 3));
  assert.throws(() => v.parseSupportDetail({ thread, messages: [{ ...message, body: {} }] }, user, 3));
  assert.equal(v.parseSupportDetail({ thread: { ...thread, subject: 'Assunto antigo' }, messages: [message] }, user, 3).thread.subject, 'Assunto antigo');
});
test('sucesso do envio exige mensagem nova da mesma conta e assunto', async () => {
  const v = await view, detail = { thread, messages: [message] };
  assert.equal(v.confirmSupportSend(detail, user, 3, 'Sugestão', message.body, []).messages.length, 1);
  assert.throws(() => v.confirmSupportSend(detail, user, 3, 'Sugestão', message.body, [8]));
  assert.throws(() => v.confirmSupportSend(detail, user, 3, 'Sugestão', 'Outra mensagem', []));
});
test('rascunhos têm chave por assunto ou conversa, erros não renderizam objetos e envio perdido é incerto', async () => {
  const v = await view;
  assert.equal(v.supportDraftKey(user, null, 'Sugestão'), v.supportDraftKey(user, 3, 'Sugestão'));
  assert.notEqual(v.supportDraftKey(user, 3, 'Sugestão'), v.supportDraftKey(user, 4, 'Outro assunto'));
  assert.notEqual(v.supportDraftKey(admin, 3), v.supportDraftKey(admin, 4));
  assert.equal(v.requestError({ response: { data: { error: {} } } }, 'Falha'), 'Falha');
  assert.ok(v.uncertainWrite({})); assert.ok(v.uncertainWrite({ response: { status: 503 } })); assert.ok(!v.uncertainWrite({ response: { status: 400 } }));
  assert.equal(v.supportDate('invalida'), ''); assert.ok(v.supportDate('2026-09-09 12:00:00').includes('2026'));
});
