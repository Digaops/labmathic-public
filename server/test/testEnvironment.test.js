const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createTestEnvironment, removeTestEnvironment } = require('../scripts/testing/runTests');

test('comando de testes substitui destinos operacionais herdados por banco e uploads temporários', () => {
  const inherited = { DB_PATH: '/operational/db.sqlite', UPLOAD_DIR: '/operational/uploads', APP_ENV: 'production', NODE_ENV: 'production', SYNTHETIC_SETTING: 'keep' };
  const isolated = createTestEnvironment(inherited);
  try {
    assert.equal(isolated.env.NODE_ENV, 'test');
    assert.equal(isolated.env.APP_ENV, 'development');
    assert.equal(isolated.env.SYNTHETIC_SETTING, 'keep');
    assert.equal(path.dirname(isolated.env.DB_PATH), isolated.root);
    assert.equal(path.dirname(isolated.env.UPLOAD_DIR), isolated.root);
    assert.equal(fs.existsSync(isolated.env.UPLOAD_DIR), true);
    assert.equal(inherited.DB_PATH, '/operational/db.sqlite');
    assert.throws(() => removeTestEnvironment(path.resolve(os.tmpdir())));
    assert.throws(() => removeTestEnvironment(path.resolve(__dirname, '..')));
  } finally { removeTestEnvironment(isolated.root); }
  assert.equal(fs.existsSync(isolated.root), false);
});
