import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseModelPool, defaultPoolEntry, mutateModelPool } from '../../src/jk/model-pool.js';
import { createModelPoolApi } from '../../html/server/model-pool-api.js';
import { createSitesR2Store, MODEL_POOL_KEY } from '../../html/server/sites-r2-store.js';
import { createLocalModelPoolStore } from '../../html/server/local-model-pool-store.js';
import { createModelPoolServer } from '../../html/server/model-pool-server.js';

const now = '2026-11-06T00:00:00.000Z';
const model = (name = 'V7_TEST') => ({
  jkm: name, version: '7.0.0', queues: ['work'], roots: [{
    id: 'G1', members: [{ id: 'Q1', q: 1, trigger: { any: [] } }],
    trigger: { any: ['Q1'] }, queue: 'work', pro: {}, runtime: {},
  }],
});
const empty = () => ({ version: 1, revision: 0, temporary: [], permanent: [] });
const entry = (id = 'example', permanent = true) => ({
  id, createdAt: now, promotedAt: permanent ? now : null, model: model(),
});
const seed = () => ({ ...empty(), permanent: [entry()] });
const legacyPool = () => ({ ...seed(), permanent: [{ ...entry(), model: {
  format: 'jk-logic-structure-V4.0.0', nodes: [{ id: 'Q0', ex: 'J0K(X0)' }],
} }] });

function memoryBucket(initial = new Map()) {
  const records = new Map([...initial].map(([key, value]) => [key, {
    text: typeof value === 'string' ? value : JSON.stringify(value), etag: 'v1',
  }]));
  let revision = 1;
  return {
    records, gets: [], puts: [],
    async get(key) {
      this.gets.push(key);
      const value = records.get(key);
      await this.afterGet?.();
      return value ? { etag: value.etag, text: async () => value.text } : null;
    },
    async put(key, text, options) {
      this.puts.push({ key, text, options });
      await this.beforePut?.();
      const old = records.get(key);
      if (options.onlyIf instanceof Headers) {
        assert.equal(options.onlyIf.get('If-None-Match'), '*');
        if (old) return null;
      } else if (old?.etag !== options.onlyIf.etagMatches) return null;
      const etag = `v${++revision}`;
      records.set(key, { text, etag });
      return { etag };
    },
  };
}

const apiFor = (bucket, token = 'test-admin') => createModelPoolApi({
  storage: createSitesR2Store(bucket, seed()), token,
});
async function request(api, command, token) {
  const response = await api(new Request('https://model.example/api/model-pool', {
    method: command ? 'POST' : 'GET',
    headers: { ...(command ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(command ? { body: JSON.stringify(command) } : {}),
  }));
  return { status: response.status, data: await response.json() };
}

test('pool version 1 is a storage container and accepts only JKRD7 definitions', () => {
  const source = seed();
  const parsed = parseModelPool(source);
  assert.deepEqual(parsed, source);
  parsed.permanent[0].model.roots[0].members[0].q = 0;
  assert.equal(source.permanent[0].model.roots[0].members[0].q, 1);
  const old = legacyPool();
  const before = JSON.stringify(old);
  assert.throws(() => parseModelPool(old), error => error.status === 400);
  assert.equal(JSON.stringify(old), before);
  assert.throws(() => mutateModelPool(empty(), { action: 'import', revision: 0, model: old.permanent[0].model }));
  assert.throws(() => parseModelPool({ ...empty(), version: 7 }));
});

test('V7 import, promotion, idempotence and deletion retain revision semantics', () => {
  const initial = empty();
  let result = mutateModelPool(initial, { action: 'import', revision: 0, model: model() }, { id: 'new', now });
  assert.equal(initial.revision, 0);
  assert.equal(initial.temporary.length, 0);
  assert.equal(result.pool.revision, 1);
  assert.equal(result.selectedId, 'new');
  result = mutateModelPool(result.pool, { action: 'promote', revision: 1, id: 'new' }, { now });
  assert.equal(result.pool.revision, 2);
  assert.equal(defaultPoolEntry(result.pool).id, 'new');
  const promoted = result.pool;
  assert.deepEqual(mutateModelPool(promoted, { action: 'promote', revision: 2, id: 'new' }).pool, promoted);
  assert.throws(() => mutateModelPool(promoted, { action: 'delete', revision: 1, id: 'new' }), error => error.status === 409);
  result = mutateModelPool(promoted, { action: 'delete', revision: 2, id: 'new' });
  assert.deepEqual(result.pool, { ...empty(), revision: 3 });
});

test('the R2 V7 key initializes independently and never reads or replaces V4 storage', async () => {
  assert.equal(MODEL_POOL_KEY, 'model-pool-v7.json');
  const old = JSON.stringify(legacyPool());
  const bucket = memoryBucket(new Map([['model-pool.json', old]]));
  const first = await request(apiFor(bucket));
  assert.equal(first.status, 200);
  assert.deepEqual(first.data.pool, seed());
  assert.equal(bucket.records.get('model-pool.json').text, old);
  assert.ok(bucket.gets.every(key => key === 'model-pool-v7.json'));
  assert.equal(bucket.puts.length, 1);
  assert.equal(bucket.puts[0].key, 'model-pool-v7.json');
  assert.equal(bucket.puts[0].options.onlyIf.get('If-None-Match'), '*');
  assert.equal((await request(apiFor(bucket))).status, 200);
  assert.equal(bucket.puts.length, 1, 'later reads never seed again');
});

test('an invalid legacy object already at the V7 R2 key fails without overwriting it', async () => {
  const old = JSON.stringify(legacyPool());
  const bucket = memoryBucket(new Map([[MODEL_POOL_KEY, old]]));
  const api = apiFor(bucket);
  assert.equal((await request(api)).status, 500);
  assert.equal((await request(api, { action: 'import', revision: 0, model: model() })).status, 500);
  assert.equal(bucket.records.get(MODEL_POOL_KEY).text, old);
  assert.equal(bucket.puts.length, 0);
});

test('V7 API imports are public and permanent writes retain authorization', async () => {
  const bucket = memoryBucket(new Map([[MODEL_POOL_KEY, seed()]]));
  const api = apiFor(bucket);
  const imported = await request(api, { action: 'import', revision: 0, model: model('new') }, 'wrong');
  assert.equal(imported.status, 200);
  assert.equal(imported.data.pool.temporary[0].model.jkm, 'new');
  const id = imported.data.selectedId;
  assert.equal((await request(api, { action: 'promote', revision: 1, id })).status, 401);
  assert.equal(bucket.puts.length, 1);
  assert.equal((await request(apiFor(bucket, ''), { action: 'promote', revision: 1, id })).status, 403);
  assert.equal((await request(api, { action: 'promote', revision: 1, id }, 'test-admin')).status, 200);
  assert.equal((await request(api, { action: 'delete', revision: 2, id, group: 'temporary' })).status, 401);
  assert.equal((await request(api, { action: 'delete', revision: 2, id }, 'test-admin')).status, 200);
  assert.equal(bucket.records.get(MODEL_POOL_KEY).text.includes('test-admin'), false);
});

test('V4 import is rejected by the HTTP API before any storage mutation', async () => {
  const bucket = memoryBucket(new Map([[MODEL_POOL_KEY, seed()]]));
  const before = bucket.records.get(MODEL_POOL_KEY).text;
  const response = await request(apiFor(bucket), { action: 'import', revision: 0, model: legacyPool().permanent[0].model });
  assert.equal(response.status, 400);
  assert.equal(bucket.puts.length, 0);
  assert.equal(bucket.records.get(MODEL_POOL_KEY).text, before);
});

test('concurrent V7 R2 saves use ETag and one stale revision loses without replay', async () => {
  const bucket = memoryBucket(new Map([[MODEL_POOL_KEY, seed()]]));
  let reads = 0, release;
  const bothRead = new Promise(resolve => { release = resolve; });
  bucket.afterGet = async () => {
    if (++reads === 2) release();
    if (reads <= 2) await bothRead;
  };
  const results = await Promise.all(['a', 'b'].map(name => request(apiFor(bucket), { action: 'import', revision: 0, model: model(name) })));
  assert.deepEqual(results.map(result => result.status).sort(), [200, 409]);
  const pool = JSON.parse(bucket.records.get(MODEL_POOL_KEY).text);
  assert.equal(pool.revision, 1);
  assert.equal(pool.temporary.length, 1);
  assert.equal(bucket.puts.length, 2);
  assert.equal((await request(apiFor(bucket), { action: 'import', revision: 0, model: model() })).status, 409);
  assert.equal(bucket.puts.length, 2);
});

async function localFixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modelshow-v7-pool-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filename = path.join(directory, '.data', 'model-pool-v7.json');
  const oldFilename = path.join(directory, '.data', 'model-pool.json');
  const seedFile = path.join(directory, 'example.json');
  await fs.mkdir(path.dirname(filename));
  await fs.writeFile(oldFilename, JSON.stringify(legacyPool()));
  await fs.writeFile(seedFile, JSON.stringify(seed()));
  return { directory, filename, oldFilename, seedFile, storage: createLocalModelPoolStore(filename, seedFile) };
}

test('local V7 initialization preserves the old file and revision-guards subsequent writes', async t => {
  const local = await localFixture(t);
  const old = await fs.readFile(local.oldFilename, 'utf8');
  const first = await local.storage.read();
  assert.deepEqual(parseModelPool(JSON.parse(first.source)), seed());
  const changed = mutateModelPool(JSON.parse(first.source), { action: 'import', revision: 0, model: model() }, { id: 'new', now }).pool;
  await local.storage.write(JSON.stringify(changed), first.etag);
  await assert.rejects(local.storage.write(first.source, first.etag), error => error.status === 409);
  assert.deepEqual(JSON.parse((await local.storage.read()).source), changed);
  assert.equal(await fs.readFile(local.oldFilename, 'utf8'), old);
});

test('an invalid existing local V7 file is rejected without reseeding', async t => {
  const local = await localFixture(t);
  const old = JSON.stringify(legacyPool());
  await fs.writeFile(local.filename, old);
  const api = createModelPoolApi({ storage: local.storage });
  assert.equal((await request(api)).status, 500);
  assert.equal((await request(api, { action: 'import', revision: 0, model: model() })).status, 500);
  assert.equal(await fs.readFile(local.filename, 'utf8'), old);
});

test('local HTTP adapter serves and updates only the V7 model pool', async t => {
  const local = await localFixture(t);
  const server = createModelPoolServer({ storage: local.storage, distDir: local.directory, token: 'local-test' });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const address = `http://127.0.0.1:${server.address().port}`;
  const initial = await fetch(`${address}/api/model-pool`);
  assert.equal(initial.status, 200);
  assert.deepEqual((await initial.json()).pool, seed());
  const imported = await fetch(`${address}/api/model-pool`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action: 'import', revision: 0, model: model('LOCAL') }),
  });
  assert.equal(imported.status, 200);
  const current = await (await fetch(`${address}/example.json`)).json();
  assert.equal(current.revision, 1);
  assert.equal(current.temporary[0].model.jkm, 'LOCAL');
  const old = await fs.readFile(local.oldFilename, 'utf8');
  assert.equal(JSON.parse(old).permanent[0].model.format, 'jk-logic-structure-V4.0.0');
});
