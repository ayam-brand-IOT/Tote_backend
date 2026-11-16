const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { transitions, hasDestination, lifecycleRoute } = require('../lifecycle');

function harness(status, links = [{ destination: 'F1' }]) {
  const routes = new Map();
  const writes = [];
  const events = [];
  const record = { id: 1, tote_id: 'T001', status, tote_kg: 10 };
  const connection = {
    beginTransaction: async () => events.push('begin'),
    commit: async () => events.push('commit'),
    rollback: async () => events.push('rollback'),
    release: () => events.push('release'),
    query: async (sql, params) => {
      if (sql.includes('FROM tote_assets')) return [[{ tote_id: 'T001', status: 'active' }]];
      if (sql.includes('SELECT destination FROM tote_line')) return [links];
      if (sql.startsWith('SELECT') && sql.includes('FROM totes'))
        return [[record].filter(r => !sql.includes("status != 'offloaded-to-clean'") || r.status !== 'offloaded-to-clean')];
      writes.push({ sql, params });
      return [{ insertId: 2 }];
    },
  };
  const pool = { getConnection: async () => connection };
  const app = Object.fromEntries(['get', 'post', 'put', 'patch'].map(method => [method, (path, fn) => routes.set(`${method} ${path}`, fn)]));
  const source = fs.readFileSync(require.resolve('../index'), 'utf8');
  vm.runInNewContext(source.slice(source.indexOf("app.post('/api/totes',"), source.indexOf('// ========== PRODUCT ENDPOINTS ==========')), {
    app, db: pool, ALLOWED_TRANSITIONS: transitions, hasDestination, lifecycleRoute,
    broadcastToBrowsers: () => {}, console,
  });
  return { writes, events, async call(route, body) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; events.push('response'); return this; } };
    await routes.get(route)({ params: { id: 'T001' }, body }, res);
    return res;
  } };
}

for (const state of Object.keys(transitions).filter(s => s !== 'offloaded-to-clean')) {
  test(`inbound rejects unfinished ${state} cycle even without links`, async () => {
    const h = harness(state, []);
    assert.equal((await h.call('post /api/totes', { tote_id: 'T001' })).statusCode, 409);
    assert.equal(h.writes.length, 0);
    assert.ok(h.events.includes('rollback'));
  });
}
test('inbound accepts a closed cycle and commits before responding', async () => {
  const h = harness('offloaded-to-clean');
  assert.equal((await h.call('post /api/totes', { tote_id: 'T001' })).statusCode, 201);
  assert.equal(h.writes.length, 1);
  assert.ok(h.events.indexOf('commit') < h.events.indexOf('response'));
});
test('weight update cannot skip product linking', async () => {
  const h = harness('inbound-ready', []);
  assert.equal((await h.call('put /api/totes/:id', { ice_out_kg: 0 })).statusCode, 409);
  assert.equal(h.writes.length, 0);
});
for (const links of [[], [{ destination: null }], [{ destination: ' ' }], [{ destination: 'F1' }, { destination: null }]]) {
  test(`outbound rejects missing destinations: ${JSON.stringify(links)}`, async () => {
    const h = harness('product-linked', links);
    assert.equal((await h.call('put /api/totes/:id', { raw_kg: 100 })).statusCode, 409);
    assert.equal(h.writes.length, 0);
  });
}
test('outbound accepts linked product with destination', async () => {
  const h = harness('product-linked');
  assert.equal((await h.call('put /api/totes/:id', { raw_kg: 100 })).statusCode, 200);
  assert.ok(h.writes[0].params.includes('outbound-ready'));
});
test('force cannot skip lifecycle stages', async () => {
  const h = harness('inbound-ready');
  assert.equal((await h.call('patch /api/totes/:id/status', { status: 'offloaded-to-clean', force: true })).statusCode, 400);
  assert.equal(h.writes.length, 0);
});
test('complete cannot close an inbound cycle', async () => {
  const h = harness('inbound-ready');
  assert.equal((await h.call('post /api/totes/:id/complete', {})).statusCode, 409);
  assert.equal(h.writes.length, 0);
});
test('complete accepts received tote', async () => {
  const h = harness('received-for-packing');
  assert.equal((await h.call('post /api/totes/:id/complete', {})).statusCode, 200);
  assert.equal(h.writes.length, 1);
});
