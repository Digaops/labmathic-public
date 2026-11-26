const test = require('node:test');
const assert = require('node:assert/strict');

const model = import('../../client/src/services/plannerNavigation.mjs');

test('um registro reúne editor e seletores e lê o envio pendente antes do próximo render', async () => {
  const { createPlannerNavigationRegistry } = await model;
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  const editor = { dirty: false, busy: false }, picker = { dirty: false, busy: false };
  const unmountEditor = registry.register('editor', () => editor);
  const unmountPicker = registry.register('picker', () => picker);
  assert.equal(registry.shouldBlock(), false);
  picker.dirty = true;
  assert.deepEqual(registry.inspect('editor'), { dirty: false, busy: false, protected: false });
  assert.equal(registry.shouldBlock(), true);
  picker.dirty = false;
  editor.busy = true;
  assert.equal(registry.shouldBlock(), true, 'a referência pendente já bloqueia sem publicação de estado');
  assert.equal(registry.inspect().busy, true);
  unmountPicker();
  assert.equal(registry.shouldBlock(), true);
  editor.busy = false;
  assert.equal(registry.shouldBlock(), false);
  editor.dirty = true;
  unmountEditor();
  assert.equal(registry.shouldBlock(), false);
});

test('salvamento confirmado libera só o próprio escopo durante a ação síncrona', async () => {
  const { createPlannerNavigationRegistry } = await model;
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  const editor = { dirty: true, busy: false }, picker = { dirty: true, busy: false };
  registry.register('editor', () => editor);
  const removePicker = registry.register('picker', () => picker);
  assert.equal(registry.afterSave('editor', () => assert.equal(registry.shouldBlock(), true)), true,
    'a seleção ainda não confirmada continua protegida');
  removePicker();
  assert.equal(registry.afterSave('editor', () => {
    assert.equal(registry.shouldBlock(), false);
    assert.equal(registry.inspect().protected, true, 'beforeunload não recebe passe global');
  }), true);
  assert.equal(registry.shouldBlock(), true, 'a próxima navegação não herda autorização');
  assert.throws(() => registry.afterSave('editor', () => { throw Error('ação interrompida'); }), /interrompida/);
  assert.equal(registry.shouldBlock(), true, 'exceções também encerram o escopo');
  let invoked = false;
  editor.busy = true;
  assert.equal(registry.afterSave('editor', () => { invoked = true; }), false);
  assert.equal(invoked, false, 'não libera envio ainda pendente');
});

test('ação diferida não leva o passe de um salvamento para uma navegação futura', async () => {
  const { createPlannerNavigationRegistry } = await model;
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  registry.register('editor', () => ({ dirty: true, busy: false }));
  let protectedLater;
  registry.afterSave('editor', () => queueMicrotask(() => { protectedLater = registry.shouldBlock(); }));
  await new Promise(resolve => queueMicrotask(resolve));
  assert.equal(protectedLater, true);
});

test('logout, revogação e troca de conta invalidam os guards e respostas antigas', async () => {
  const { createPlannerNavigationRegistry } = await model;
  let owner = 'teacher:session-1';
  const registry = createPlannerNavigationRegistry(() => owner);
  registry.register('editor', () => ({ dirty: true, busy: true }));
  assert.equal(registry.shouldBlock(), true);
  owner = null;
  assert.equal(registry.shouldBlock(), false);
  assert.equal(registry.inspect().busy, false);
  assert.equal(registry.afterSave('editor', () => assert.fail('resposta revogada não pode navegar')), false);
  owner = 'other-teacher:session-2';
  assert.equal(registry.shouldBlock(), false);
  assert.equal(registry.isCurrent('editor'), false);
  registry.register('other-editor', () => ({ dirty: true, busy: false }));
  assert.equal(registry.shouldBlock(), true);
});

test('limpeza de uma inscrição antiga não remove a inscrição atual do mesmo guard', async () => {
  const { createPlannerNavigationRegistry } = await model;
  const registry = createPlannerNavigationRegistry(() => 'teacher:session-1');
  const removeOld = registry.register('editor', () => ({ dirty: false, busy: false }));
  const removeCurrent = registry.register('editor', () => ({ dirty: true, busy: false }));
  removeOld();
  assert.equal(registry.shouldBlock(), true);
  removeCurrent();
  assert.equal(registry.shouldBlock(), false);
});

test('planejamento e recomposição perdem proteção de forma independente ao revogar a liberação', async () => {
  const { createPlannerNavigationRegistry } = await model;
  let token = true;
  const owner = 'teacher:session-1';
  const owners = { planning: owner, recovery: owner };
  const registry = createPlannerNavigationRegistry(scope => token ? owners[scope] : null);
  const state = { dirty: true, busy: false };
  registry.register('plan', () => state);
  registry.register('review', () => state, 'recovery');
  registry.register('execution', () => ({ dirty: false, busy: true }), 'recovery');
  const scopes = () => [...registry.blockingOwners()];
  assert.deepEqual(scopes(), [['planning', owner], ['recovery', owner]]);
  owners.planning = null;
  assert.deepEqual(scopes(), [['recovery', owner]]);
  assert.equal(registry.inspect().busy, true);
  assert.equal(registry.afterSave('plan', () => assert.fail('planejamento revogado')), false);
  owners.planning = owner;
  owners.recovery = null;
  assert.deepEqual(scopes(), [['planning', owner]]);
  assert.equal(registry.inspect().busy, false);
  token = false;
  assert.equal(registry.shouldBlock(), false);
  token = true;
  owners.planning = owners.recovery = 'other-teacher:session-2';
  assert.equal(registry.inspect().protected, false);
});
