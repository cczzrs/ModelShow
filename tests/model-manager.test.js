import test from 'node:test';
import assert from 'node:assert/strict';
import {ModelManager} from '../src/model-manager.js';
import {defaultDisplay,exportDisplayModel,exportCurrentDisplayModel} from '../src/output-display.js';

const dates = ['2026-09-01T00:00:00.000Z', '2026-09-02T00:00:00.000Z', '2026-09-03T00:00:00.000Z'];
const model = name => ({name, md5: `${name}-original-md5`, nodes: [{id: 'Q0Old', ex: ' J0 K(X0) '}], initial_q: {0: [], 1: []}, q_y: [{Y0: 'Q0Old'}], custom: {keep: [1, null]}});
const entry = (id, time = dates[0], permanent = true) => ({id, createdAt: time, promotedAt: permanent ? time : null, model: model(id)});
const pool = (revision = 0) => ({version: 1, revision, permanent: [entry('permanent')], temporary: [entry('temporary', dates[2], false)]});
const freeze = value => { if (value && typeof value === 'object') {Object.freeze(value);Object.values(value).forEach(freeze);} return value; };

class Element {
  constructor(tag = 'div') {this.tag = tag;this.children = [];this.value = '';this.textContent = '';this.disabled = false;this.hidden = false;this.open = false;this.files = [];this.listeners = {};}
  append(...children) {this.children.push(...children);}
  replaceChildren(...children) {this.children = children;}
  get options() {return this.children.flatMap(child => child.tag === 'option' ? [child] : child.options);}
  addEventListener(type, callback) {this.listeners[type] = callback;}
  showModal() {this.open = true;}
  close() {this.open = false;}
  focus() {this.focused = true;}
  click() {if (!this.disabled) {this.clicks=(this.clicks??0)+1;return this.onclick?.();}}
  remove() {this.removed=true;}
}

function harness(t, prepareDownload) {
  const previous = {document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, URL: globalThis.URL, setTimeout: globalThis.setTimeout};
  const elements = new Map();
  const element = id => {if (!elements.has(id)) elements.set(id, new Element(id === 'model-pool-select' ? 'select' : 'div'));return elements.get(id);};
  const calls = [], replies = [], loads = [], messages = [], anchors = [], blobs = [], revoked = [], timers = [];
  globalThis.document = {getElementById: element, body: new Element('body'), createElement: tag => {const result=new Element(tag);if(tag==='a')anchors.push(result);return result;}};
  globalThis.window = {confirm: () => true};
  globalThis.URL = class extends previous.URL {
    static createObjectURL(blob) {blobs.push(blob);return `blob:model-download-${blobs.length}`;}
    static revokeObjectURL(url) {revoked.push(url);}
  };
  globalThis.setTimeout = (callback, delay) => {timers.push({callback,delay});return timers.length;};
  globalThis.fetch = async (url, options = {}) => {
    calls.push({url, ...options});
    assert.ok(replies.length, `unexpected fetch: ${url}`);
    const reply = await replies.shift();
    if (reply instanceof Error) throw reply;
    return {ok: reply.status >= 200 && reply.status < 300, status: reply.status, json: async () => reply.body};
  };
  t.after(() => {for (const [key, value] of Object.entries(previous)) {if (value === undefined) delete globalThis[key];else globalThis[key] = value;}});
  const manager = new ModelManager(raw => loads.push(raw), (...message) => messages.push(message),prepareDownload);
  return {manager, element, calls, loads, messages, anchors, blobs, revoked, timers,
    reply: (body, status = 200) => replies.push({status, body}),
    reject: error => replies.push(error),
    defer: () => {let resolve;replies.push(new Promise(done => {resolve = done;}));return (body, status = 200) => resolve({status, body});},
    api: (value, writable = true, authRequired = true) => replies.push({status: 200, body: {pool: value, writable, authRequired, permanentWritable: false}}),
  };
}

test('startup loads the latest permanent model and sorts both picker groups by recency', async t => {
  const h = harness(t), source = freeze({...pool(), permanent: [entry('old'), entry('latest-a', dates[1]), entry('latest-b', dates[1])]});
  h.api(source);
  await h.manager.loadInitial();
  assert.equal(h.manager.selectedId, 'latest-b');
  assert.deepEqual(h.loads, [source.permanent[2].model]);
  assert.notEqual(h.loads[0], source.permanent[2].model);
  assert.equal(h.element('model-pool-select').value, 'latest-b');
  assert.deepEqual(h.element('model-pool-select').options.map(option => option.value), ['latest-b', 'latest-a', 'old', 'temporary']);
  assert.deepEqual(JSON.parse(h.element('model-json').value), source.permanent[2].model);
  assert.equal(h.calls[0].cache, 'no-store');
});

test('public temporary operations need no token while permanent actions open a fresh password dialog', async t => {
  const h = harness(t);
  h.api(pool());await h.manager.loadInitial();
  assert.equal(h.element('import-file').disabled, false);
  assert.equal(h.element('import-json').disabled, false);
  assert.equal(h.element('model-pool-delete').disabled, false);
  assert.equal(h.calls[0].headers?.Authorization, undefined);
  await h.manager.mutate({action: 'delete', id: 'permanent'});
  assert.equal(h.calls.length, 1);
  assert.equal(h.element('model-auth-dialog').open, true);
  assert.deepEqual(h.manager.pendingCommand, {action: 'delete', id: 'permanent'});
  assert.match(h.element('model-auth-description').textContent, /删除永久模型/);
  assert.equal(h.element('model-auth-password').focused, true);
  h.element('model-auth-password').value = 'not-submitted';
  h.manager.cancelAuthorization();
  assert.equal(h.manager.pendingCommand, null);
  assert.equal(h.element('model-auth-password').value, '');
  assert.equal(h.element('model-auth-dialog').open, false);
  h.manager.select('temporary', true);
  assert.equal(h.element('model-pool-add').disabled, false);
  h.element('model-json').value += ' ';
  h.element('model-json').oninput();
  assert.equal(h.element('model-pool-add').disabled, true, 'edited JSON must first be imported as a new temporary model');
  h.reply({pool: {...pool(1), temporary: []}, selectedId: 'permanent'});
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls[1].headers.Authorization, undefined);
  assert.equal(h.element('model-auth-dialog').open, false);
});

test('password cancellation and Escape discard the action; every protected operation asks again', async t => {
  const h = harness(t);
  h.api(pool());await h.manager.loadInitial();
  await h.manager.mutate({action: 'promote', id: 'temporary'});
  await h.manager.submitAuthorization();
  assert.match(h.element('model-auth-error').textContent, /请输入/);
  assert.equal(h.calls.length, 1);
  h.element('model-auth-password').value = 'abandoned';
  let cancelled = false;
  h.element('model-auth-dialog').listeners.cancel({preventDefault() {cancelled = true;}});
  assert.equal(cancelled, true);
  assert.equal(h.manager.pendingCommand, null);
  assert.equal(h.element('model-auth-password').value, '');
  await h.manager.submitAuthorization();
  assert.equal(h.calls.length, 1);
  await h.manager.mutate({action: 'delete', id: 'permanent'});
  assert.equal(h.element('model-auth-dialog').open, true);
  assert.deepEqual(h.manager.pendingCommand, {action: 'delete', id: 'permanent'});
  assert.equal(h.element('model-auth-password').value, '');
});

test('import, promote and delete use server revisions, selection and raw model snapshots', async t => {
  const h = harness(t), initial = freeze(pool(7));
  h.api(initial, true);await h.manager.loadInitial();
  const original = freeze(model('user-raw')), imported = {...entry('server-assigned', dates[2], false), model: original};
  const afterImport = freeze({...pool(8), temporary: [...initial.temporary, imported]});
  h.reply({pool: afterImport, selectedId: 'server-assigned'});
  await h.manager.importText(JSON.stringify(original));
  assert.deepEqual(JSON.parse(h.calls[1].body), {action: 'import', model: original, revision: 7});
  assert.equal(h.calls[1].headers.Authorization, undefined);
  assert.equal(h.manager.selectedId, 'server-assigned');
  assert.deepEqual(h.manager.pool, afterImport);
  assert.deepEqual(h.loads.at(-1), original);
  assert.equal(h.loads.at(-1).nodes[0].id, 'Q0Old');
  assert.equal(h.loads.at(-1).nodes[0].ex, ' J0 K(X0) ');
  assert.equal(h.loads.at(-1).md5, 'user-raw-original-md5');
  const afterPromote = freeze({...pool(9), permanent: [...initial.permanent, {...imported, promotedAt: dates[2]}], temporary: initial.temporary});
  h.reply({pool: afterPromote, selectedId: imported.id});
  const loadsBeforePromotion = h.loads.length;
  await h.manager.mutate({action: 'promote', id: imported.id});
  assert.equal(h.calls.length, 2, 'opening the password dialog sends no mutation');
  h.element('model-auth-password').value = ' admin ';
  await h.manager.submitAuthorization();
  assert.deepEqual(JSON.parse(h.calls[2].body), {action: 'promote', id: imported.id, revision: 8});
  assert.equal(h.calls[2].headers.Authorization, 'Bearer admin');
  assert.deepEqual(h.manager.pool, afterPromote);
  assert.equal(h.loads.length, loadsBeforePromotion, 'promotion does not reset the running model');
  assert.equal(h.element('model-auth-password').value, '');
  assert.equal(h.manager.token, undefined);
  assert.equal(h.manager.pendingCommand, null);
  assert.equal(h.element('model-pool-add').disabled, true);
  const afterDelete = freeze(pool(10));
  h.reply({pool: afterDelete, selectedId: 'permanent'});
  await h.manager.mutate({action: 'delete', id: imported.id});
  assert.equal(h.calls.length, 3, 'the prior password does not authorize another operation');
  assert.equal(h.element('model-auth-dialog').open, true);
  h.element('model-auth-password').value = 'second-password';
  await h.manager.submitAuthorization();
  assert.deepEqual(JSON.parse(h.calls[3].body), {action: 'delete', id: imported.id, revision: 9});
  assert.equal(h.calls[3].headers.Authorization, 'Bearer second-password');
  assert.deepEqual(h.manager.pool, afterDelete);
  assert.equal(h.manager.selectedId, 'permanent');
  assert.deepEqual(h.loads.at(-1), initial.permanent[0].model);
  assert.equal(original.nodes[0].id, 'Q0Old');
  assert.equal(initial.revision, 7);
});

test('a revision conflict refreshes once without replaying the destructive request', async t => {
  const h = harness(t);
  h.api(pool(3), true);await h.manager.loadInitial();
  h.manager.select('temporary', true);
  h.reply({error: 'revision conflict'}, 409);
  const newer = freeze({...pool(4), temporary: [entry('other-device', dates[2], false)]});
  h.api(newer, true);
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.deepEqual(h.manager.pool, newer);
  assert.equal(h.manager.busy, false);
  assert.equal(h.manager.selectedId, 'permanent');
  assert.equal(h.loads.at(-1).name, 'permanent', 'the scene follows the fallback selection after a remote deletion');
  assert.match(h.element('import-error').textContent, /其他设备更新/);
  assert.equal(h.messages.at(-1)[1], true);
});

test('a wrong password clears the field, preserves the model and allows a separate retry', async t => {
  const h = harness(t), original = pool();
  h.api(original, true);await h.manager.loadInitial();
  await h.manager.mutate({action: 'delete', id: 'permanent'});
  h.element('model-auth-password').value = 'wrong';
  h.reply({error: '管理口令失效'}, 401);
  await h.manager.submitAuthorization();
  assert.deepEqual(h.manager.pool, original);
  assert.equal(h.calls[1].headers.Authorization, 'Bearer wrong');
  assert.equal(h.manager.token, undefined);
  assert.equal(h.manager.writable, true, 'public temporary capability remains available');
  assert.equal(h.element('model-auth-password').value, '');
  assert.equal(h.element('model-auth-dialog').open, true);
  assert.match(h.element('model-auth-error').textContent, /口令失效/);
  assert.equal(h.loads.length, 1);
  h.element('model-auth-password').value = 'correct';
  h.reply({pool: {...original, revision: 1, permanent: []}, selectedId: 'temporary'});
  await h.manager.submitAuthorization();
  assert.equal(h.calls[2].headers.Authorization, 'Bearer correct');
  assert.equal(h.element('model-auth-dialog').open, false);
  h.reply({pool: {...original, revision: 2, permanent: [], temporary: []}, selectedId: null});
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls[3].headers.Authorization, undefined, 'temporary deletion never reuses a password');
});

test('static fallback permits local import, selection and download while shared mutations stay disabled', async t => {
  const h = harness(t), legacy = freeze(model('legacy example'));
  h.reject(new Error('API unavailable'));h.reply(legacy);
  await h.manager.loadInitial();
  assert.deepEqual(h.calls.map(call => call.url), ['./api/model-pool', './example.json']);
  assert.equal(h.manager.remote, false);
  assert.equal(h.manager.writable, false);
  assert.equal(h.manager.selectedId, 'example');
  assert.deepEqual(h.loads[0], legacy);
  assert.equal(h.element('import-file').disabled, false);
  assert.equal(h.element('import-json').disabled, false);
  assert.equal(h.element('model-download').disabled, false);
  assert.equal(h.element('model-pool-add').disabled, true);
  assert.equal(h.element('model-pool-delete').disabled, true);
  assert.doesNotMatch(h.element('model-pool-status').textContent, /只读/);
  const original=freeze(model('new'));
  await h.manager.importText(JSON.stringify(original));
  const localId=h.manager.selectedId;
  assert.equal(h.manager.localEntries.size, 1);
  assert.deepEqual(h.manager.entry().model, original);
  assert.deepEqual(h.loads.at(-1), original);
  assert.deepEqual(JSON.parse(await h.manager.download()), original);
  h.manager.select('example',true);
  assert.deepEqual(h.loads.at(-1), legacy);
  h.manager.select(localId,true);
  assert.deepEqual(h.loads.at(-1), original);
  await h.manager.mutate({action: 'delete', id: 'example'});
  await h.manager.mutate({action: 'promote', id: localId});
  assert.equal(h.element('model-auth-dialog').open, false);
  assert.equal(h.calls.length, 2);
});

test('a connected backend failure is surfaced without falling back to the bundled example', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  h.reject(new Error('backend disconnected'));
  await h.manager.open();
  assert.equal(h.element('import-error').textContent, '模型池连接失败，仍可导入和下载。');
  assert.equal(h.calls.length, 2);
  assert.equal(h.calls.some(call => call.url === './example.json'), false);
  assert.equal(h.manager.writable, false);
  assert.equal(h.manager.remote, false);
  assert.equal(h.element('import-file').disabled, false);
  assert.equal(h.element('import-json').disabled, false);
  assert.equal(h.element('model-download').disabled, false);
  assert.equal(h.element('model-pool-add').disabled, true);
  assert.equal(h.element('model-pool-delete').disabled, true);
  assert.deepEqual(h.manager.pool, pool());
  h.manager.select('temporary',true);
  assert.equal(h.loads.at(-1).name, 'temporary');
  await h.manager.importText(JSON.stringify(model('during outage')));
  assert.equal(h.manager.localEntries.size, 1);
  assert.equal(h.loads.at(-1).name, 'during outage');
  assert.equal(h.calls.length, 2, 'offline imports do not keep retrying the failed backend');
});

test('remote deletion of the selected entry synchronizes the scene, including deletion of the final entry', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  const remaining = {...pool(1), permanent: []};
  h.api(remaining, true);await h.manager.open();
  assert.equal(h.manager.selectedId, 'temporary');
  assert.equal(h.element('model-pool-select').value, 'temporary');
  assert.equal(JSON.parse(h.element('model-json').value).name, 'temporary');
  assert.equal(h.loads.length, 2);
  assert.deepEqual(h.loads.at(-1), remaining.temporary[0].model);
  h.api({...remaining, revision: 2, temporary: []}, true);await h.manager.refresh();
  assert.equal(h.manager.selectedId, null);
  assert.equal(h.element('model-json').value, '');
  assert.equal(h.element('model-pool-select').disabled, true);
  assert.deepEqual(h.loads.at(-1), {name: '模型池为空', nodes: [], initial_q: {0: [], 1: []}, q_y: []});
});

test('refreshing a surviving selection preserves the running scene instead of resetting it', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  h.api({...pool(1), permanent: [...pool().permanent, entry('newer', dates[2])]}, true);
  await h.manager.open();
  assert.equal(h.manager.selectedId, 'permanent');
  assert.equal(h.loads.length, 1, 'opening management must not reset an unchanged model');
});

test('initial loading blocks closing and duplicate reads until the initial snapshot arrives', async t => {
  const h = harness(t), complete = h.defer();
  const initial = h.manager.loadInitial();
  assert.equal(h.manager.busy, true);
  await h.manager.open();
  assert.equal(h.element('import-dialog').open, true);
  assert.equal(h.calls.length, 1);
  assert.equal(h.element('import-close').disabled, true);
  h.manager.close();
  assert.equal(h.element('import-dialog').open, true);
  let cancelled = false;
  h.element('import-dialog').listeners.cancel({preventDefault() {cancelled = true;}});
  assert.equal(cancelled, true);
  complete({pool: pool(), writable: true, authRequired: true});await initial;
  assert.equal(h.manager.busy, false);
  assert.equal(h.loads.length, 1);
  h.manager.close();
  assert.equal(h.element('import-dialog').open, false);
});

test('closing the dialog cancels a file read before it can create a shared temporary model', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  h.element('import-dialog').showModal();
  let finish;
  h.element('file').files = [{text: () => new Promise(done => {finish = done;})}];
  const reading = h.element('file').onchange();
  h.manager.close();
  finish(JSON.stringify(model('cancelled')));await reading;
  assert.equal(h.calls.length, 1);
  assert.equal(h.manager.selectedId, 'permanent');
  assert.equal(h.loads.length, 1);
  assert.equal(h.element('file').value, '');
});

test('only the last chosen file may import when decodes finish in reverse order', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  h.element('import-dialog').showModal();
  let finishOld, finishNew;
  h.element('file').files = [{text: () => new Promise(done => {finishOld = done;})}];
  const older = h.element('file').onchange();
  h.element('file').files = [{text: () => new Promise(done => {finishNew = done;})}];
  const newer = h.element('file').onchange();
  const imported = {...entry('new-file', dates[2], false), model: model('new file')};
  h.reply({pool: {...pool(1), temporary: [imported]}, selectedId: imported.id});
  finishNew(JSON.stringify(imported.model));await newer;
  finishOld(JSON.stringify(model('old file')));await older;
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(JSON.parse(h.calls[1].body).model.name, 'new file');
  assert.equal(h.manager.selectedId, 'new-file');
  assert.equal(h.loads.at(-1).name, 'new file');
});

test('changing the selected pool model cancels a pending file and a failed read leaves the scene intact', async t => {
  const h = harness(t);
  h.api(pool(), true);await h.manager.loadInitial();
  h.element('import-dialog').showModal();
  let finish;
  h.element('file').files = [{text: () => new Promise(done => {finish = done;})}];
  const reading = h.element('file').onchange();
  h.element('model-pool-select').value = 'temporary';
  h.element('model-pool-select').onchange();
  finish(JSON.stringify(model('stale file')));await reading;
  assert.equal(h.calls.length, 1);
  assert.equal(h.loads.at(-1).name, 'temporary');
  h.element('file').files = [{text: async () => {throw new Error('文件无法读取');}}];
  await h.element('file').onchange();
  assert.equal(h.calls.length, 1);
  assert.equal(h.manager.selectedId, 'temporary');
  assert.match(h.element('import-error').textContent, /文件无法读取/);
});

test('a temporary model promoted by another device is not deleted after a revision conflict', async t => {
  const h = harness(t);
  h.api(pool(2));await h.manager.loadInitial();
  h.manager.select('temporary', true);
  const promoted = {...pool(3), permanent: [...pool().permanent, entry('temporary', dates[2])], temporary: []};
  h.reply({error: 'revision changed'}, 409);h.api(promoted);
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls[1].headers.Authorization, undefined);
  assert.equal(JSON.parse(h.calls[1].body).revision, 2);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1);
  assert.equal(h.manager.pool.permanent.some(item => item.id === 'temporary'), true);
  assert.equal(h.manager.selectedId, 'temporary');
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.element('model-auth-dialog').open, true);
  assert.equal(h.calls.filter(call => call.method === 'POST').length, 1, 'a renewed permanent deletion requires a fresh password');
});

test('a protected conflict cancels authorization, refreshes once and never retries with the old password', async t => {
  const h = harness(t);
  h.api(pool());await h.manager.loadInitial();
  await h.manager.mutate({action: 'promote', id: 'temporary'});
  h.element('model-auth-password').value = 'one-use';
  h.reply({error: 'changed'}, 409);h.api(pool(1));
  await h.manager.submitAuthorization();
  assert.equal(h.calls.length, 3);
  assert.equal(h.calls[1].headers.Authorization, 'Bearer one-use');
  assert.equal(h.calls[2].headers?.Authorization, undefined, 'refresh is public');
  assert.equal(h.manager.pendingCommand, null);
  assert.equal(h.element('model-auth-dialog').open, false);
  assert.equal(h.element('model-auth-password').value, '');
  assert.equal(h.manager.pool.revision, 1);
  await h.manager.submitAuthorization();
  assert.equal(h.calls.length, 3);
});

test('opening authorization cancels an earlier file read and blocks unrelated mutations', async t => {
  const h = harness(t);
  h.api(pool());await h.manager.loadInitial();
  h.element('import-dialog').showModal();
  let finish;
  h.element('file').files = [{text: () => new Promise(done => {finish = done;})}];
  const reading = h.element('file').onchange();
  await h.manager.mutate({action: 'promote', id: 'temporary'});
  finish(JSON.stringify(model('late file')));await reading;
  await h.manager.importText(JSON.stringify(model('unrelated')));
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls.length, 1);
  assert.deepEqual(h.manager.pendingCommand, {action: 'promote', id: 'temporary'});
  assert.equal(h.element('model-auth-dialog').open, true);
  assert.equal(h.element('model-pool-select').disabled, true);
  h.manager.close();
  assert.equal(h.element('import-dialog').open, true);
  h.manager.cancelAuthorization();
  assert.equal(h.calls.length, 1);
});

test('an unconfigured permanent password does not block public temporary import or delete', async t => {
  const h = harness(t);
  h.api(pool(), true, false);await h.manager.loadInitial();
  await h.manager.mutate({action: 'promote', id: 'temporary'});
  assert.equal(h.calls.length, 1);
  assert.equal(h.element('model-auth-dialog').open, false);
  assert.match(h.element('import-error').textContent, /尚未配置/);
  assert.equal(h.element('import-json').disabled, false);
  h.reply({pool: {...pool(1), temporary: []}, selectedId: 'permanent'});
  await h.manager.mutate({action: 'delete', id: 'temporary'});
  assert.equal(h.calls[1].headers.Authorization, undefined);
  assert.equal(h.manager.pool.revision, 1);
});

test('failure of both the API and seed still allows importing into an empty local pool', async t => {
  const h=harness(t);
  h.reject(new Error('backend unavailable'));h.reject(new Error('seed unavailable'));
  await h.manager.loadInitial();
  assert.equal(h.manager.remote,false);
  assert.equal(h.manager.selectedId,null);
  assert.equal(h.manager.pool.permanent.length,0);
  assert.equal(h.manager.pool.temporary.length,0);
  assert.equal(h.element('import-file').disabled,false);
  const original=model('standalone');
  await h.manager.importText(JSON.stringify(original));
  assert.deepEqual(h.loads.at(-1),original);
  assert.deepEqual(JSON.parse(await h.manager.download()),original);
  assert.equal(h.calls.length,2);
});

test('reopening offline and reconnecting preserves local entries without uploading or resetting the selected model', async t => {
  const h=harness(t);
  h.reject(new Error('offline'));h.reply(pool());await h.manager.loadInitial();
  const original=freeze(model('local draft'));
  await h.manager.importText(JSON.stringify(original));
  const localId=h.manager.selectedId,loadsBefore=h.loads.length;
  h.reject(new Error('still offline'));await h.manager.open();
  assert.equal(h.manager.selectedId,localId);
  assert.equal(h.manager.localEntries.size,1);
  assert.deepEqual(h.manager.entry().model,original);
  assert.equal(h.loads.length,loadsBefore);
  h.api({...pool(5),permanent:[entry('new server permanent',dates[2])]},true);
  await h.manager.open();
  assert.equal(h.manager.remote,true);
  assert.equal(h.manager.selectedId,localId);
  assert.equal(h.manager.localEntries.size,1);
  assert.deepEqual(h.manager.entry().model,original);
  assert.equal(h.manager.sharedPool.revision,5);
  assert.equal(h.element('model-pool-add').disabled,false);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(h.loads.length,loadsBefore);
});

test('reconnected local promotion uploads once, then retries only promotion after a wrong password', async t => {
  const h=harness(t),original=freeze(model('reconnect me'));
  h.reject(new Error('offline'));h.reply(pool());await h.manager.loadInitial();
  await h.manager.importText(JSON.stringify(original));
  const localId=h.manager.selectedId;
  h.api(pool(4),true);await h.manager.open();
  await h.manager.mutate({action:'promote',id:localId});
  assert.equal(h.element('model-auth-dialog').open,true);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0);
  const uploaded={...entry('server-draft',dates[2],false),model:original};
  const afterUpload={...pool(5),temporary:[...pool().temporary,uploaded]};
  h.reply({pool:afterUpload,selectedId:uploaded.id});h.reply({error:'口令错误'},401);
  h.element('model-auth-password').value='wrong';await h.manager.submitAuthorization();
  const firstPosts=h.calls.filter(call=>call.method==='POST');
  assert.equal(firstPosts.length,2);
  assert.deepEqual(JSON.parse(firstPosts[0].body),{action:'import',model:original,revision:4});
  assert.equal(firstPosts[0].headers.Authorization,undefined);
  assert.deepEqual(JSON.parse(firstPosts[1].body),{action:'promote',id:uploaded.id,revision:5});
  assert.equal(firstPosts[1].headers.Authorization,'Bearer wrong');
  assert.equal(h.manager.localEntries.size,0,'successful upload transfers ownership to the server entry');
  assert.equal(h.manager.selectedId,uploaded.id);
  assert.deepEqual(h.manager.pendingCommand,{action:'promote',id:uploaded.id});
  assert.deepEqual(h.manager.entry().model,original);
  assert.equal(h.manager.remote,true,'invalid credentials are not a connectivity failure');
  assert.equal(h.element('model-auth-password').value,'');
  const afterPromotion={...pool(6),temporary:pool().temporary,permanent:[...pool().permanent,{...uploaded,promotedAt:dates[2]}]};
  h.reply({pool:afterPromotion,selectedId:uploaded.id});
  h.element('model-auth-password').value='correct';await h.manager.submitAuthorization();
  const allPosts=h.calls.filter(call=>call.method==='POST');
  assert.equal(allPosts.length,3);
  assert.equal(allPosts.filter(call=>JSON.parse(call.body).action==='import').length,1);
  assert.deepEqual(JSON.parse(allPosts[2].body),{action:'promote',id:uploaded.id,revision:5});
  assert.equal(allPosts[2].headers.Authorization,'Bearer correct');
  assert.equal(h.manager.pendingCommand,null);
  assert.deepEqual(h.manager.pool,afterPromotion);
});

test('an import interrupted by a network failure preserves the raw model as a local entry', async t => {
  const h=harness(t),original=freeze({...model('unsent'),extra:['keep',7]});
  h.api(pool(7));await h.manager.loadInitial();
  h.reject(new TypeError('Failed to fetch'));
  await h.manager.importText(JSON.stringify(original));
  assert.equal(h.calls.filter(call=>call.method==='POST').length,1);
  assert.equal(h.manager.remote,false);
  assert.equal(h.manager.localEntries.size,1);
  assert.equal(h.manager.sharedPool.revision,7);
  assert.deepEqual(h.manager.entry().model,original);
  assert.deepEqual(h.loads.at(-1),original);
  assert.equal(h.element('model-pool-add').disabled,true);
  assert.equal(h.element('model-pool-delete').disabled,true);
  assert.equal(h.element('import-json').disabled,false);
  assert.deepEqual(JSON.parse(await h.manager.download()),original);
});

test('a server 503 import failure becomes local but a 409 remains a revision conflict', async t => {
  const h=harness(t);
  h.api(pool(2));await h.manager.loadInitial();
  const original=model('maintenance draft');
  h.reply({error:'service unavailable'},503);await h.manager.importText(JSON.stringify(original));
  assert.equal(h.manager.remote,false);
  assert.equal(h.manager.localEntries.size,1);
  const localId=h.manager.selectedId;
  h.api(pool(3));await h.manager.open();
  h.reply({error:'revision changed'},409);h.api(pool(4));
  await h.manager.importText(JSON.stringify(model('conflicting import')));
  assert.equal(h.manager.remote,true);
  assert.equal(h.manager.localEntries.size,1,'a conflict must not invent an offline import');
  assert.equal(h.manager.selectedId,localId);
  assert.deepEqual(h.manager.entry().model,original);
  assert.equal(h.manager.sharedPool.revision,4);
  assert.equal(h.calls.filter(call=>call.method==='POST').length,2);
  assert.match(h.element('import-error').textContent,/其他设备更新/);
});

test('download uses the current edited model, retains raw fields and releases its Blob URL', async t => {
  const h=harness(t);h.api(pool());await h.manager.loadInitial();
  const edited=freeze({...model('edited model'),outputDisplay:{version:1,enabled:false},metadata:{custom:'untouched'}});
  h.element('model-json').value=JSON.stringify(edited);h.element('model-json').oninput();
  const loadsBefore=h.loads.length,callsBefore=h.calls.length;
  const text=await h.element('model-download').click();
  assert.deepEqual(JSON.parse(text),edited);
  assert.equal(h.blobs.length,1);
  assert.deepEqual(JSON.parse(await h.blobs[0].text()),edited);
  assert.match(h.blobs[0].type,/application\/json/);
  assert.equal(h.anchors.length,1);
  assert.equal(h.anchors[0].clicks,1);
  assert.equal(h.anchors[0].href,'blob:model-download-1');
  assert.match(h.anchors[0].download,/\.json$/);
  assert.equal(h.anchors[0].removed,true);
  assert.equal(h.revoked.length,0,'the URL must survive the initiating click');
  assert.equal(h.timers.length,1);
  assert.equal(h.timers[0].delay,1000);
  h.timers[0].callback();
  assert.deepEqual(h.revoked,['blob:model-download-1']);
  assert.equal(h.loads.length,loadsBefore,'download does not replace or execute the current scene');
  assert.equal(h.calls.length,callsBefore,'download does not contact the shared backend');
  assert.equal(h.manager.entry().model.name,'permanent','editor changes are not silently written into the selected pool entry');
});

test('empty or invalid model JSON never creates a download', async t => {
  const h=harness(t);h.api(pool());await h.manager.loadInitial();
  for(const text of ['', '{', JSON.stringify({nodes:'invalid'})]){
    h.element('model-json').value=text;h.element('model-json').oninput();
    await h.manager.download();
    assert.equal(h.blobs.length,0);
    assert.equal(h.anchors.length,0);
    assert.equal(h.element('import-error').hidden,false);
    assert.ok(h.element('import-error').textContent.length>0);
  }
  assert.equal(h.calls.length,1);
  assert.equal(h.loads.length,1);
});

test('the download button uses the current board exporter offline, including changes after opening management', async t => {
  let loaded,config=defaultDisplay(1,1);
  const h=harness(t,raw=>exportCurrentDisplayModel(raw,loaded,config));
  const original=freeze(model('live display'));
  h.reject(new Error('offline'));h.reply(original);await h.manager.loadInitial();loaded=h.loads.at(-1);
  config.enabled=true;config.scale=2.5;
  config.pixels[0].channels.r={kind:'bits',bits:['Y0'],order:'msb-first',mapping:'direct'};
  config.pixels[0].channels.g={kind:'fixed',value:119};
  const requests=h.calls.length,loads=h.loads.length;
  const first=await h.element('model-download').click();
  assert.deepEqual(JSON.parse(first),exportDisplayModel(loaded,config));
  assert.deepEqual(JSON.parse(await h.blobs[0].text()).outputDisplay,config);
  config.enabled=false;config.scale=3;
  await h.element('model-download').click();
  assert.deepEqual(JSON.parse(await h.blobs[1].text()).outputDisplay,config,'each click reads the latest config and keeps hidden-board bindings');
  assert.deepEqual(JSON.parse(h.element('model-json').value),original,'export does not modify the editor or pool');
  assert.equal(h.calls.length,requests);assert.equal(h.loads.length,loads);
  assert.equal(h.manager.remote,false);
});

test('a disconnected promotion retains the already uploaded server entry and does not upload it again', async t => {
  const h=harness(t),original=model('interrupted promotion');
  h.reject(new Error('offline'));h.reply(pool());await h.manager.loadInitial();
  await h.manager.importText(JSON.stringify(original));
  const localId=h.manager.selectedId;
  h.api(pool(2));await h.manager.open();
  await h.manager.mutate({action:'promote',id:localId});
  const uploaded={...entry('already-uploaded',dates[2],false),model:original};
  const afterUpload={...pool(3),temporary:[...pool().temporary,uploaded]};
  h.reply({pool:afterUpload,selectedId:uploaded.id});h.reject(new TypeError('network lost'));
  h.element('model-auth-password').value='admin';await h.manager.submitAuthorization();
  assert.equal(h.manager.remote,false);
  assert.equal(h.manager.selectedId,uploaded.id);
  assert.equal(h.manager.localEntries.size,0);
  assert.deepEqual(h.manager.entry().model,original);
  assert.equal(h.manager.pendingCommand,null,'disconnection clears the stale protected action');
  assert.equal(h.element('model-auth-dialog').open,false);
  assert.equal(h.element('model-auth-password').value,'');
  assert.equal(h.element('model-pool-add').disabled,true);
  assert.deepEqual(JSON.parse(await h.manager.download()),original);
  h.api(afterUpload);await h.manager.open();
  await h.manager.mutate({action:'promote',id:uploaded.id});
  const promoted={...pool(4),temporary:pool().temporary,permanent:[...pool().permanent,{...uploaded,promotedAt:dates[2]}]};
  h.reply({pool:promoted,selectedId:uploaded.id});
  h.element('model-auth-password').value='admin-again';await h.manager.submitAuthorization();
  const commands=h.calls.filter(call=>call.method==='POST').map(call=>JSON.parse(call.body));
  assert.deepEqual(commands.map(command=>command.action),['import','promote','promote']);
  assert.equal(commands[2].id,uploaded.id);
  assert.equal(commands[2].revision,3);
  assert.deepEqual(h.manager.pool,promoted);
});

test('an unsaved editor draft remains downloadable across an offline and successful refresh', async t => {
  const h=harness(t),draft={...model('edited draft'),custom:{kept:true}};
  h.api(pool());await h.manager.loadInitial();
  const draftText=JSON.stringify(draft);
  h.element('model-json').value=draftText;h.element('model-json').oninput();
  h.reject(new Error('offline'));await h.manager.open();
  assert.equal(h.element('model-json').value,draftText);
  assert.deepEqual(JSON.parse(await h.manager.download()),draft);
  h.api({...pool(1),temporary:[...pool().temporary,entry('other device',dates[2],false)]});
  await h.manager.open();
  assert.equal(h.element('model-json').value,draftText);
  assert.equal(h.manager.entry().model.name,'permanent');
  assert.equal(h.manager.localEntries.size,0,'editing alone must not create or upload a model');
  assert.equal(h.calls.filter(call=>call.method==='POST').length,0);
  assert.equal(h.loads.length,1);
});
