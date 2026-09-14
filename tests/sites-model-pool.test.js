import test from 'node:test';
import assert from 'node:assert/strict';
import { createSitesR2Store, MODEL_POOL_KEY } from '../server/sites-r2-store.js';
import { createModelPoolApi } from '../server/model-pool-api.js';
import { parseModelPool } from '../src/model-pool.js';

const model = { name: '保留原模型', md5: 'original', nodes: [{ id: 'Q0L1', ex: 'J0K(X0)' }], initial_q: { 0: [], 1: [] }, q_y: [{ Y0: 'Q0L1' }], outputDisplay: { version: 1, enabled: false, rows: 1, columns: 1, scale: 2, lamps: [] }, extra: { keep: true } };
const seed = parseModelPool(model);

function bucketFixture(initial = seed) {
  let source = initial === null ? null : JSON.stringify(initial), version = 1;
  const bucket = {
    gets: [], puts: [], get source() { return source; },
    replace(next) { source = typeof next === 'string' ? next : JSON.stringify(next); version++; },
    async get(key) {
      this.gets.push(key);
      if (this.readError) throw this.readError;
      const text = source, etag = `etag-${version}`;
      await this.afterGet?.();
      return text === null ? null : { etag, httpEtag: `"${etag}"`, text: async () => text };
    },
    async put(key, text, options) {
      this.puts.push({ key, text, options });
      await this.beforePut?.();
      if (this.writeError) throw this.writeError;
      const condition = options.onlyIf;
      if (condition instanceof Headers) {
        assert.equal(condition.get('If-None-Match'), '*');
        if (source !== null) return null;
      } else {
        assert.equal(typeof condition.etagMatches, 'string');
        if (condition.etagMatches !== `etag-${version}`) return null;
      }
      source = text; version++;
      return { etag: `etag-${version}` };
    },
  };
  return bucket;
}

const apiFor = (bucket, token = 'test-admin') => createModelPoolApi({ storage: createSitesR2Store(bucket, seed), token });
async function send(api, body, token, options = {}) {
  const request = new Request(`https://model.example${options.route ?? '/api/model-pool'}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...options.headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const response = await api(request);
  return { status: response.status, headers: response.headers, data: await response.json() };
}

test('Sites reads the existing model-pool.json via BUCKET and keeps GET read-only once migrated', async () => {
  const bucket = bucketFixture(), result = await send(apiFor(bucket));
  assert.equal(result.status, 200);
  assert.deepEqual(result.data.pool, seed);
  assert.equal(result.data.authRequired, true);
  assert.equal(result.data.permanentWritable, false);
  assert.equal(result.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual(bucket.gets, ['model-pool.json']);
  assert.equal(bucket.puts.length, 0);
});

test('first access migrates once using create-if-absent; later builds cannot overwrite a saved pool', async () => {
  const bucket = bucketFixture(null), api = apiFor(bucket);
  const first = await send(api);
  assert.equal(first.status, 200);
  assert.deepEqual(JSON.parse(bucket.source), seed);
  assert.equal(bucket.puts[0].options.onlyIf.get('If-None-Match'), '*');
  const stored = { ...seed, revision: 9, extra: 'cloud data' };
  bucket.replace(stored);
  assert.deepEqual((await send(api)).data.pool, stored);
  assert.equal(bucket.puts.length, 1);
});

test('two initial visitors preserve whichever initialization wins', async () => {
  const bucket = bucketFixture(null);
  let reads = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  bucket.afterGet = async () => { if (++reads === 2) release(); if (reads <= 2) await both; };
  const [a, b] = await Promise.all([send(apiFor(bucket)), send(apiFor(bucket))]);
  assert.equal(a.status, 200); assert.equal(b.status, 200);
  assert.deepEqual(a.data.pool, b.data.pool);
  assert.deepEqual(JSON.parse(bucket.source), seed);
  assert.equal(bucket.puts.length, 2);
  assert.ok(bucket.puts.every(call => call.options.onlyIf instanceof Headers));
});

test('temporary import and delete stay public; full models and display fields round-trip', async () => {
  const bucket = bucketFixture(), api = apiFor(bucket);
  const imported = await send(api, { action: 'import', revision: 0, model });
  assert.equal(imported.status, 200);
  assert.deepEqual(imported.data.pool.temporary[0].model, model);
  assert.equal(imported.data.pool.revision, 1);
  assert.equal(bucket.puts[0].key, MODEL_POOL_KEY);
  assert.deepEqual(bucket.puts[0].options.onlyIf, { etagMatches: 'etag-1' });
  const deleted = await send(api, { action: 'delete', revision: 1, id: imported.data.selectedId }, 'wrong');
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.pool.temporary.length, 0);
});

test('permanent actions require the existing administrator policy and leave denied writes untouched', async () => {
  const bucket = bucketFixture(), api = apiFor(bucket);
  const imported = await send(api, { action: 'import', revision: 0, model });
  const promotion = { action: 'promote', revision: 1, id: imported.data.selectedId };
  for (const token of [undefined, 'wrong']) assert.equal((await send(api, promotion, token)).status, 401);
  assert.equal(bucket.puts.length, 1);
  assert.equal((await send(api, promotion, 'test-admin')).status, 200);
  const deletion = { action: 'delete', revision: 2, id: imported.data.selectedId, group: 'temporary' };
  assert.equal((await send(api, deletion)).status, 401);
  assert.equal((await send(apiFor(bucket, ''), deletion)).status, 403);
  assert.equal((await send(api, deletion, 'test-admin')).status, 200);
  assert.equal(JSON.stringify(JSON.parse(bucket.source)).includes('test-admin'), false);
});

test('two independent Sites requests get one success and one 409 for the same ETag', async () => {
  const bucket = bucketFixture();
  let reads = 0, release;
  const both = new Promise(resolve => { release = resolve; });
  bucket.afterGet = async () => { if (++reads === 2) release(); if (reads <= 2) await both; };
  const results = await Promise.all(['A', 'B'].map(name => send(apiFor(bucket), { action: 'import', revision: 0, model: { ...model, name } })));
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const saved = JSON.parse(bucket.source);
  assert.equal(saved.revision, 1); assert.equal(saved.temporary.length, 1);
  assert.equal(bucket.puts.length, 2, 'the losing command is not replayed');
  const stale = await send(apiFor(bucket), { action: 'import', revision: 0, model });
  assert.equal(stale.status, 409); assert.equal(bucket.puts.length, 2);
});

test('ETag prevents overwrites even when another change retains the same JSON revision', async () => {
  const bucket = bucketFixture();
  const changed = { ...seed, external: true };
  bucket.beforePut = () => { bucket.beforePut = null; bucket.replace(changed); };
  assert.equal((await send(apiFor(bucket), { action: 'import', revision: 0, model })).status, 409);
  assert.deepEqual(JSON.parse(bucket.source), changed);
});

test('read errors, corrupt objects and unavailable bindings never seed or report save success', async () => {
  const bucket = bucketFixture(null);
  bucket.readError = new Error('private details');
  const unavailable = await send(apiFor(bucket));
  assert.equal(unavailable.status, 503); assert.equal(bucket.puts.length, 0);
  assert.equal(JSON.stringify(unavailable.data).includes('private details'), false);
  delete bucket.readError; bucket.replace('{invalid');
  assert.equal((await send(apiFor(bucket))).status, 500); assert.equal(bucket.puts.length, 0);
  assert.equal((await send(apiFor(undefined))).status, 503);
  bucket.replace(seed); bucket.writeError = new Error('private write error');
  const uncertain = await send(apiFor(bucket), { action: 'import', revision: 0, model });
  assert.equal(uncertain.status, 503); assert.match(uncertain.data.error, /未确认/);
  assert.equal(bucket.puts.length, 1); assert.deepEqual(JSON.parse(bucket.source), seed);
});

test('hosted API keeps origins, preflight, live example and invalid request protections', async () => {
  const bucket = bucketFixture(), api = apiFor(bucket);
  assert.equal((await send(api, { action: 'import', revision: 0, model }, undefined, { headers: { Origin: 'https://hostile.example' } })).status, 403);
  assert.equal(bucket.puts.length, 0);
  assert.equal((await send(api, undefined, undefined, { route: '/example.json' })).status, 200);
  assert.equal((await api(new Request('https://model.example/api/model-pool', { method: 'OPTIONS' }))).status, 204);
  assert.equal((await api(new Request('https://model.example/api/model-pool', { method: 'POST', body: '{' }))).status, 415);
  assert.equal((await api(new Request('https://model.example/api/model-pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' }))).status, 400);
  assert.equal((await api(new Request('https://model.example/api/model-pool', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': String(32 * 1024 * 1024 + 1) }, body: '{}' }))).status, 413);
});

test('explicit R2 throttling is retryable without disconnecting the manager or replaying writes', async () => {
  const bucket = bucketFixture();
  bucket.writeError = new Error('R2 put failed: Too many requests (10058)');
  const limited = await send(apiFor(bucket), { action: 'import', revision: 0, model });
  assert.equal(limited.status, 429);
  assert.match(limited.data.error, /稍后重试/);
  assert.equal(bucket.puts.length, 1);
  assert.deepEqual(JSON.parse(bucket.source), seed);
});
