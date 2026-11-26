const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
let createNumericSubmission;
test.before(async () => { ({ createNumericSubmission } = await import('../../client/src/services/numericAssessmentSubmission.mjs')); });
const body = () => ({ title: 'Medidas', numericVersionIds: ['version-1'], participantIds: ['student-1'],
  instructions: 'Resolva com calma.', pedagogicalConfirmed: true, randomizeOptions: false });

test('pedido numérico preserva chave e cópia imutável das escolhas originais', () => {
  const guard = createNumericSubmission(), original = body();
  const request = guard.begin(original, 'original-key');
  original.title = 'Outro título'; original.numericVersionIds.push('version-2'); original.participantIds[0] = 'student-2';
  assert.deepEqual(request.body, body());
  assert.equal(request.key, 'original-key');
  assert.throws(() => request.body.numericVersionIds.push('version-3'), TypeError);
  assert.throws(() => request.body.participantIds.splice(0, 1), TypeError);
  assert.ok(Object.isFrozen(request.body));
  assert.equal(guard.begin(original, 'another-key'), request);
});

test('rede, timeout, resposta inválida e erro do servidor exigem conferência explícita', () => {
  for (const error of [new Error('Network'), {}, { response: { status: 200 } },
    { response: { status: 408 } }, { response: { status: 500 } }, { response: { status: 503 } }]) {
    const guard = createNumericSubmission(), request = guard.begin(body(), 'key');
    assert.equal(guard.failed(error), true);
    assert.equal(guard.uncertain, true);
    assert.equal(guard.request, request);
  }
});

test('rejeição definitiva inicial permite ajustar o conteúdo e tentar novamente', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429]) {
    const guard = createNumericSubmission(); guard.begin(body(), 'key');
    assert.equal(guard.failed({ response: { status } }), false);
    assert.equal(guard.request, null);
    assert.equal(guard.begin({ ...body(), title: 'Corrigido' }, 'key').body.title, 'Corrigido');
  }
});

test('permissão revogada ou conflito após resposta perdida não descarta o primeiro envio', () => {
  for (const status of [400, 401, 403, 404, 409, 422, 429, 500]) {
    const guard = createNumericSubmission(), request = guard.begin(body(), 'key');
    guard.failed(new Error('Lost response'));
    assert.equal(guard.failed({ response: { status } }), true);
    assert.equal(guard.begin({ ...body(), title: 'Não enviar' }, 'different-key'), request);
  }
});

test('somente confirmação ou um novo formulário libera o pedido preservado', () => {
  const guard = createNumericSubmission(); guard.begin(body(), 'key'); guard.failed({});
  guard.confirmed();
  assert.equal(guard.uncertain, false); assert.equal(guard.request, null);
  const next = guard.begin({ ...body(), title: 'Nova atividade' }, 'new-key');
  assert.equal(next.key, 'new-key'); assert.equal(next.body.title, 'Nova atividade');
  const other = createNumericSubmission(); assert.equal(other.request, null);
  assert.equal(guard.request, next);
});

test('interface bloqueia edição, oferece conferência manual e avisa antes de sair', () => {
  const screen = fs.readFileSync(require.resolve('../../client/src/components/ClassAssessments.jsx'), 'utf8');
  assert.match(screen, /submission\.uncertain \? submission\.request : null/);
  assert.match(screen, /parseAssignments\(\[response.data\]\)/);
  assert.match(screen, /submission\.failed\(requestError\)/);
  assert.match(screen, /fieldset disabled=\{saving \|\| preparing \|\| numericUncertain\}/);
  assert.match(screen, /Conferir salvamento/);
  assert.match(screen, /window.confirm\(numericSubmissionLeaveMessage\)/);
  assert.match(screen, /useAccountLeave\(numericUncertain/);
  assert.match(screen, /submissionNotice\.current\?\.closest\('\[data-assessment-dialog\]'\)\?\.scrollTo\(\{ top: 0 \}\)/);
  assert.match(screen, /numericActivity \? 'Atividade numérica' : 'Simulado'/);
  const guard = fs.readFileSync(require.resolve('../../client/src/services/numericAssessmentSubmission.mjs'), 'utf8');
  assert.doesNotMatch(guard, /setInterval|setTimeout|localStorage|sessionStorage|fetch\(/);
});
