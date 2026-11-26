const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const indexPath = path.resolve(__dirname, '../src/index.js');

test('health de deploy não usa cache nem o orçamento do limitador geral', () => {
  const source = fs.readFileSync(indexPath, 'utf8');
  const healthRoutes = source.match(/app\.get\('\/api\/health', healthCheck\)/g) || [];
  const healthRouteAt = source.indexOf("app.get('/api/health', healthCheck)");
  const apiLimiterAt = source.indexOf("app.use('/api/', apiLimiter)");

  assert.equal(healthRoutes.length, 1);
  assert.ok(healthRouteAt >= 0);
  assert.ok(apiLimiterAt > healthRouteAt, 'o health deve ser montado antes do limitador geral');
  assert.match(source, /Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate'/);
  assert.match(source, /Surrogate-Control', 'no-store'/);
  assert.match(source, /revision: config\.deploymentMetadata\?\.sourceSha/);
  assert.match(source, /schemaVersion/);
});
