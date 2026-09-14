import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { createModelPoolServer } from '../server/model-pool-server.js';
import { parseModelPool } from '../src/model-pool.js';

const model = name => ({name, md5: 'original-md5', nodes: [{id: 'Q2Label', ex: ' J0 K(X0) '}], initial_q: {0: [], 1: []}, q_y: [{Y0: 'Q2Label'}], custom: {keep: true}});
const request = (address, route = '/api/model-pool', {method = 'GET', headers = {}, body} = {}) => new Promise((resolve, reject) => {
  const content = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
  const req = http.request(`${address}${route}`, {method, headers: {...(content === undefined ? {} : {'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(content)}), ...headers}}, response => {
    const chunks = [];
    response.on('data', chunk => chunks.push(chunk));
    response.on('end', () => {
      const text = Buffer.concat(chunks).toString();
      let data;
      try { data = JSON.parse(text); } catch {}
      resolve({status: response.statusCode, headers: response.headers, text, data});
    });
    response.on('error', reject);
  });
  req.on('error', reject);
  req.end(content);
});

function memoryStore(source) {
  let generation = 0;
  return {
    source, reads: 0, writes: 0, closes: 0,
    get etag() { return `"generation-${generation}"`; },
    replace(next) { this.source = next; generation++; },
    async read() {
      this.reads++;
      if (this.readError) throw this.readError;
      const snapshot = {source: this.source, etag: this.etag};
      await this.afterRead?.(snapshot);
      return snapshot;
    },
    async write(next, expectedEtag) {
      this.writes++;
      await this.beforeWrite?.(next, expectedEtag);
      if (this.writeError) throw this.writeError;
      if (expectedEtag !== this.etag) throw Object.assign(new Error('模型池已被其他设备修改，请刷新后重试。'), {status: 409});
      this.replace(next);
    },
    close() { this.closes++; },
  };
}

async function fixture(t, options = {}) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'modelshow-pool-'));
  const distDir = path.join(directory, 'dist');
  const original = `${JSON.stringify(model('原始模型'), null, 2)}\n`;
  const storage = memoryStore(original);
  await fs.mkdir(distDir);
  await fs.writeFile(path.join(distDir, 'index.html'), '<!doctype html><title>Model pool</title>');
  await fs.writeFile(path.join(distDir, 'viewer.js'), 'export const current = true;');
  // A stale build copy must never hide the live pool.
  await fs.writeFile(path.join(distDir, 'example.json'), '{"stale":true}');
  const servers = [];
  async function start(overrides = {}) {
    const server = createModelPoolServer({storage, distDir, token: '', allowedOrigins: [], ...options, ...overrides});
    servers.push(server);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    return {server, address: `http://127.0.0.1:${server.address().port}`};
  }
  t.after(async () => {
    for (const server of servers) {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
    await fs.rm(directory, {recursive: true, force: true});
  });
  return {directory, storage, distDir, original, start, ...await start()};
}

test('public startup preserves legacy data on GET and permits temporary management without enabling permanent writes', async t => {
  const {address, storage, directory, original} = await fixture(t);
  const read = await request(address);
  assert.equal(read.status, 200);
  assert.equal(read.data.writable, true);
  assert.equal(read.data.authRequired, false);
  assert.equal(read.data.permanentWritable, false);
  assert.equal(read.data.pool.permanent[0].model.name, '原始模型');
  assert.equal(read.headers['cache-control'], 'no-store');
  assert.equal(storage.source, original);
  assert.deepEqual(await fs.readdir(directory), ['dist']);
  assert.equal(storage.writes, 0);
  const denied = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 0, id: 'example'}});
  assert.equal(denied.status, 403);
  assert.equal(storage.source, original);
  const imported = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: model('temporary without a server token')}});
  assert.equal(imported.status, 200);
  assert.equal(imported.data.pool.temporary.length, 1);
  const promote = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'promote', revision: 1, id: imported.data.selectedId}});
  assert.equal(promote.status, 403);
  const deleted = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 1, id: imported.data.selectedId}});
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.pool.revision, 2);
  assert.equal(deleted.data.pool.temporary.length, 0);
  assert.deepEqual(deleted.data.pool.permanent, read.data.pool.permanent);
});

test('authenticated import, promotion and deletion persist across clients and server instances with all original fields', async t => {
  const {address, storage, original, start} = await fixture(t, {token: 'test-admin-secret'});
  const headers = {Authorization: 'Bearer test-admin-secret'};
  const anonymous = await request(address);
  assert.equal(anonymous.data.writable, true);
  assert.equal(anonymous.data.authRequired, true);
  assert.equal(anonymous.data.permanentWritable, false);
  assert.equal((await request(address, '/api/model-pool', {headers})).data.permanentWritable, true);
  const imported = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'import', revision: 0, model: model('新模型')}});
  assert.equal(imported.status, 200);
  assert.equal(imported.data.pool.revision, 1);
  assert.deepEqual(imported.data.pool.temporary[0].model, model('新模型'));
  assert.equal(imported.data.selectedId, imported.data.pool.temporary[0].id);
  assert.equal(storage.writes, 1);
  assert.deepEqual((await request(address)).data.pool, imported.data.pool, 'a separate anonymous client sees the shared update');
  const restarted = await start();
  assert.deepEqual((await request(restarted.address)).data.pool, imported.data.pool);
  const promoted = await request(restarted.address, '/api/model-pool', {method: 'POST', headers, body: {action: 'promote', revision: 1, id: imported.data.selectedId}});
  assert.equal(promoted.status, 200);
  assert.equal(promoted.data.pool.revision, 2);
  assert.equal(promoted.data.pool.temporary.length, 0);
  assert.equal(promoted.data.pool.permanent.length, 2);
  assert.equal(storage.writes, 2);
  const idempotent = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'promote', revision: 2, id: imported.data.selectedId}});
  assert.equal(idempotent.status, 200);
  assert.deepEqual(idempotent.data.pool, promoted.data.pool);
  assert.equal(storage.writes, 2, 'idempotent promotion does not rewrite the R2 object');
  const deleted = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'delete', revision: 2, id: imported.data.selectedId}});
  assert.equal(deleted.status, 200);
  assert.equal(deleted.data.pool.revision, 3);
  assert.equal(deleted.data.selectedId, 'example');
  assert.deepEqual(parseModelPool(JSON.parse(storage.source)), deleted.data.pool);
  assert.equal(JSON.stringify(deleted.data).includes('test-admin-secret'), false);
});

test('simultaneous writes are serialized; stale revisions and missing IDs do not overwrite data', async t => {
  const {address, storage} = await fixture(t, {token: 'test-write'});
  const writes = await Promise.all(['A', 'B'].map(name => request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: model(name)}})));
  assert.deepEqual(writes.map(result => result.status).sort(), [200, 409]);
  const saved = storage.source;
  assert.equal(JSON.parse(saved).temporary.length, 1);
  const missing = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 1, id: 'missing'}});
  assert.equal(missing.status, 404);
  assert.equal(storage.source, saved);
  const fresh = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 1, model: model('C')}});
  assert.equal(fresh.status, 200, 'a failed mutation must not poison subsequent operations');
  assert.equal(fresh.data.pool.revision, 2);
  assert.equal(fresh.data.pool.temporary.length, 2);
});

test('every write rereads shared object revisions; corrupt JSON and invalid pools are never overwritten', async t => {
  const {address, storage, original} = await fixture(t, {token: 'test-write'});
  const outside = {...parseModelPool(JSON.parse(original)), revision: 17};
  storage.replace(JSON.stringify(outside));
  const stale = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 0, id: 'example'}});
  assert.equal(stale.status, 409);
  assert.equal((await request(address)).data.pool.revision, 17);
  for (const corrupt of ['{malformed', JSON.stringify({...outside, permanent: null})]) {
    storage.replace(corrupt);
    assert.equal((await request(address)).status, 500);
    assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 17, id: 'example'}})).status, 500);
    assert.equal(storage.source, corrupt);
    assert.equal(storage.writes, 0);
  }
});

test('two independent backend instances cannot overwrite the same R2 snapshot', {timeout: 5_000}, async t => {
  const {address, storage, start} = await fixture(t);
  const second = await start();
  let releaseReads;
  const bothRead = new Promise(resolve => { releaseReads = resolve; });
  t.after(() => releaseReads());
  storage.afterRead = async () => {
    if (storage.reads === 2) releaseReads();
    await bothRead;
  };
  const responses = await Promise.all([address, second.address].map((serverAddress, index) => request(serverAddress, '/api/model-pool', {
    method: 'POST', body: {action: 'import', revision: 0, model: model(`concurrent-${index}`)},
  })));
  assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
  assert.equal(storage.writes, 2, 'both instances reach the conditional write with the same fresh revision');
  const winner = responses.find(response => response.status === 200);
  assert.deepEqual(JSON.parse(storage.source), winner.data.pool);
  assert.equal(winner.data.pool.revision, 1);
  assert.equal(winner.data.pool.temporary.length, 1);
  delete storage.afterRead;
  assert.deepEqual((await request(second.address)).data.pool, winner.data.pool);
  const later = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 1, model: model('explicit retry')}});
  assert.equal(later.status, 200);
  assert.equal(later.data.pool.temporary.length, 2);
  assert.equal(storage.writes, 3, 'the conflicting command was never automatically replayed');
});

test('ETag protects external object changes even when the JSON revision is unchanged', async t => {
  const {address, storage, original} = await fixture(t);
  const external = parseModelPool(JSON.parse(original));
  external.permanent[0].model.name = 'external update at the same revision';
  storage.beforeWrite = () => {
    delete storage.beforeWrite;
    storage.replace(JSON.stringify(external));
  };
  const response = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: model('stale snapshot')}});
  assert.equal(response.status, 409);
  assert.equal(storage.writes, 1);
  assert.deepEqual(JSON.parse(storage.source), external);
  assert.deepEqual((await request(address)).data.pool, external);
});

test('storage failures do not fall back to local files and later requests can recover', async t => {
  const {address, storage, original, directory} = await fixture(t);
  const command = {action: 'import', revision: 0, model: model('pending')};
  storage.readError = Object.assign(new Error('R2 暂时不可用。'), {status: 503});
  assert.equal((await request(address)).status, 503);
  assert.equal((await request(address, '/example.json')).status, 503, 'a stale build copy must not replace unavailable R2 data');
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: command})).status, 503);
  assert.equal((await request(address, '/')).status, 200, 'the application shell remains available offline');
  assert.equal(storage.writes, 0);
  delete storage.readError;
  storage.writeError = Object.assign(new Error('R2 保存失败，请刷新后确认共享状态。'), {status: 503});
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: command})).status, 503);
  assert.equal(storage.source, original);
  assert.deepEqual(await fs.readdir(directory), ['dist']);
  delete storage.writeError;
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: command})).status, 200);
  assert.equal(JSON.parse(storage.source).temporary.length, 1);
});

test('missing storage version prevents unsafe writes and untyped failures are sanitized', async t => {
  const {address, storage, original} = await fixture(t);
  storage.afterRead = snapshot => { snapshot.etag = ''; };
  const command = {action: 'import', revision: 0, model: model('unsafe')};
  assert.equal((await request(address)).status, 503);
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: command})).status, 503);
  assert.equal(storage.writes, 0);
  assert.equal(storage.source, original);
  delete storage.afterRead;
  storage.readError = new Error('internal credential-like text must remain private');
  const failed = await request(address);
  assert.equal(failed.status, 500);
  assert.equal(failed.text.includes('credential-like'), false);
});

test('closing the backend releases its storage resources once', async t => {
  const {server, storage} = await fixture(t);
  await new Promise(resolve => server.close(resolve));
  assert.equal(storage.closes, 1);
});

test('permanent authentication cannot be bypassed with a client group and never leaks credentials', async t => {
  const secret = 'test-nonpublic-token';
  const {address, storage, original} = await fixture(t, {token: secret});
  for (const Authorization of ['', 'Bearer incorrect', `Basic ${secret}`, `Bearer ${secret} trailing`]) {
    const headers = {Authorization};
    const read = await request(address, '/api/model-pool', {headers});
    assert.equal(read.status, 200);
    assert.equal(read.data.writable, true);
    assert.equal(read.data.permanentWritable, false);
    assert.equal(read.text.includes(secret), false);
    for (const action of ['promote', 'delete']) {
      const denied = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action, revision: 0, id: 'example', group: 'temporary'}});
      assert.equal(denied.status, 401);
      assert.equal(denied.text.includes(secret), false);
    }
  }
  assert.equal(storage.source, original);
});

test('temporary imports and deletions stay public even when a server token is configured or a wrong token is supplied', async t => {
  const {address} = await fixture(t, {token: 'protected-permanent'});
  let revision = 0;
  for (const headers of [{}, {Authorization: 'Bearer wrong-token'}]) {
    const imported = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'import', revision, model: model('public temporary')}});
    assert.equal(imported.status, 200);
    revision++;
    assert.equal(imported.data.pool.revision, revision);
    const denied = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'promote', revision, id: imported.data.selectedId}});
    assert.equal(denied.status, 401);
    const deleted = await request(address, '/api/model-pool', {method: 'POST', headers, body: {action: 'delete', revision, id: imported.data.selectedId}});
    assert.equal(deleted.status, 200);
    revision++;
    assert.equal(deleted.data.pool.revision, revision);
    assert.equal(deleted.data.pool.temporary.length, 0);
    assert.equal(deleted.data.pool.permanent.length, 1);
  }
});

test('a queued deletion rechecks the real group after another client promotes the temporary model', {timeout: 5_000}, async t => {
  const {address, server, storage} = await fixture(t, {token: 'permanent-admin'});
  let releasePromotion, enteredPromotion;
  const promotionBlocked = new Promise(resolve => { enteredPromotion = resolve; });
  t.after(() => releasePromotion?.());
  const imported = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: model('changing group')}});
  assert.equal(imported.status, 200);
  const id = imported.data.selectedId;
  storage.beforeWrite = async () => {
    delete storage.beforeWrite;
    enteredPromotion();
    await new Promise(resolve => { releasePromotion = resolve; });
  };
  const promotion = request(address, '/api/model-pool', {method: 'POST', headers: {Authorization: 'Bearer permanent-admin'}, body: {action: 'promote', revision: 1, id}});
  await promotionBlocked;
  const deletionReceived = new Promise(resolve => server.once('request', req => req.once('end', resolve)));
  const deletion = request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 2, id, group: 'temporary'}});
  await deletionReceived;
  releasePromotion();
  assert.equal((await promotion).status, 200);
  assert.equal((await deletion).status, 401, 'the pending public delete cannot rely on the old temporary group');
  const stale = await request(address, '/api/model-pool', {method: 'POST', body: {action: 'delete', revision: 1, id}});
  assert.equal(stale.status, 409, 'a stale client refreshes before retrying with permanent authorization');
  const fresh = await request(address);
  assert.equal(fresh.data.pool.revision, 2);
  assert.equal(fresh.data.pool.permanent.some(entry => entry.id === id), true);
  const authorized = await request(address, '/api/model-pool', {method: 'POST', headers: {Authorization: 'Bearer permanent-admin'}, body: {action: 'delete', revision: 2, id}});
  assert.equal(authorized.status, 200);
});

test('same-origin requests and explicit CORS allowlists work; hostile and malformed origins are denied before mutation', async t => {
  const {address, storage, original} = await fixture(t, {token: 'admin', allowedOrigins: ['https://viewer.example']});
  for (const Origin of [address, 'https://viewer.example']) {
    const read = await request(address, '/api/model-pool', {headers: {Origin}});
    assert.equal(read.status, 200);
    assert.equal(read.headers['access-control-allow-origin'], Origin);
    assert.equal(read.headers.vary, 'Origin');
    const preflight = await request(address, '/api/model-pool', {method: 'OPTIONS', headers: {Origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'content-type, authorization'}});
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers['access-control-allow-headers'], /Authorization/);
    assert.match(preflight.headers['access-control-allow-methods'], /POST/);
  }
  for (const Origin of ['https://attacker.example', 'null', 'not-an-origin', 'https://viewer.example/path', 'https://viewer.example@attacker.example']) {
    for (const method of ['GET', 'OPTIONS', 'POST']) {
      const denied = await request(address, '/api/model-pool', {method, headers: {Origin, Authorization: 'Bearer admin'}, ...(method === 'POST' ? {body: {action: 'import', revision: 0, model: model('blocked cross-origin import')}} : {})});
      assert.equal(denied.status, 403);
      assert.equal(denied.headers['access-control-allow-origin'], undefined);
    }
  }
  assert.equal(storage.source, original);
});

test('API rejects invalid content types, malformed JSON, oversized bodies and unsupported methods', async t => {
  const {address, storage, original} = await fixture(t, {token: 'test-write'});
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'application/json-invalid']) {
    assert.equal((await request(address, '/api/model-pool', {method: 'POST', headers: {'Content-Type': contentType}, body: '{}'})).status, 415);
  }
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: '{'})).status, 400);
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: 'null'})).status, 400);
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: {}}})).status, 400);
  assert.equal((await request(address, '/api/model-pool', {method: 'POST', headers: {'Content-Length': String(32 * 1024 * 1024 + 1)}, body: '{}'})).status, 413);
  assert.equal((await request(address, '/api/model-pool', {method: 'PUT'})).status, 405);
  assert.equal(storage.source, original);
});

test('production assets and live example.json are served safely without path traversal or symlink escapes', async t => {
  const {address, directory, distDir} = await fixture(t, {token: 'test-write'});
  await fs.writeFile(path.join(directory, 'private.txt'), 'PRIVATE FILE');
  await fs.symlink(path.join(directory, 'private.txt'), path.join(distDir, 'leak.txt'));
  await fs.writeFile(path.join(distDir, '.hidden'), 'HIDDEN FILE');
  await fs.writeFile(path.join(distDir, 'example.json.bak'), 'PRIVATE FILE');
  await fs.writeFile(path.join(distDir, 'example.json.backup.tmp'), 'PRIVATE FILE');
  const index = await request(address, '/');
  assert.equal(index.status, 200);
  assert.match(index.headers['content-type'], /^text\/html/);
  assert.match(index.text, /Model pool/);
  const script = await request(address, '/viewer.js?v=1');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal((await request(address, '/viewer.js', {method: 'HEAD'})).text, '');
  for (const route of ['/missing.js', '/..%2fprivate.txt', '/%2e%2e/private.txt', '/leak.txt', '/.hidden', '/%00bad', '/..%5cprivate.txt', '/example.json.bak', '/example.json.backup.tmp']) {
    const rejected = await request(address, route);
    assert.equal(rejected.status, 404, route);
    assert.equal(rejected.text.includes('PRIVATE FILE'), false);
  }
  assert.equal((await request(address, '/%zz')).status, 400);
  assert.equal((await request(address, '/', {method: 'POST', body: '{}'})).status, 405);
  const before = await request(address, '/example.json');
  assert.equal(before.status, 200);
  assert.equal(before.data.permanent.length, 1);
  assert.equal(before.data.stale, undefined);
  assert.equal(before.headers['cache-control'], 'no-store');
  await request(address, '/api/model-pool', {method: 'POST', body: {action: 'import', revision: 0, model: model('latest')}});
  assert.equal((await request(address, '/example.json')).data.temporary[0].model.name, 'latest');
  assert.equal((await request(address, '/example.json', {method: 'HEAD'})).text, '');
});
