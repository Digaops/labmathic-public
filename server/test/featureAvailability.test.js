const test = require('node:test');
const assert = require('node:assert/strict');
const load = () => import('../../client/src/services/featureAvailability.mjs');

test('falhas transitórias preservam apenas permissões visuais já confirmadas', async () => {
  const { featureFailure } = await load();
  const previous = { features: { enabled: true, disabled: false } };
  for (const status of [undefined, 429, 502, 503]) {
    assert.deepEqual(featureFailure(previous, status), { features: previous.features, loading: false, status: 'unavailable' });
  }
  assert.deepEqual(featureFailure({ features: {} }).features, {});
  for (const status of [401, 403]) assert.deepEqual(featureFailure(previous, status).features, {});
});

test('resposta incompleta não é confundida com kill switch confirmado', async () => {
  const { validatedFeatures } = await load();
  for (const input of [null, [], {}, { enabled: 'true' }]) assert.throws(() => validatedFeatures(input, ['enabled']));
  assert.deepEqual(validatedFeatures({ enabled: false, other: true }, ['enabled']), { enabled: false });
});
