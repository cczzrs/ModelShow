import test from 'node:test';
import assert from 'node:assert/strict';
import { RGBModelManager } from '../../src/ui/rgb-model-manager.js';

class Element extends EventTarget {
  constructor() { super(); this.value = ''; this.textContent = ''; this.hidden = false; this.disabled = false; this.open = false; this.children = []; this.files = []; }
  append(child) { this.children.push(child); }
  replaceChildren(...children) { this.children = children; }
  cloneNode() { return new Element(); }
  showModal() { this.open = true; }
  close() { this.open = false; this.dispatchEvent(new Event('close')); }
  click() { this.dispatchEvent(new Event('click')); }
  removeAttribute(name) { delete this[name]; }
}
const model = (name = 'RGB_LOCAL') => ({ jkm: name, version: '7.0.0', queues: ['work'], roots: [{
  id: 'G1', members: [{ id: 'Q1', q: 0, trigger: { any: [] } }], trigger: { any: ['Q1'] },
  queue: 'work', pro: {}, runtime: {},
}] });
const bindings = () => ({ inputs: [], watch: [], read: [] });
const emptyPool = revision => ({ version: 1, revision, temporary: [], permanent: [] });
const poolEntry = (id, permanent = false) => ({ id, createdAt: '2026-11-06T12:00:00.000Z', promotedAt: permanent ? '2026-11-06T12:01:00.000Z' : null, model: model(id) });

function setup(t, overrides = {}) {
  const originalDocument = globalThis.document, originalFetch = globalThis.fetch;
  const elements = new Map();
  globalThis.document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  } };
  document.getElementById('rgb-model-option-template').content = { firstElementChild: new Element() };
  let current = model(), currentBindings = bindings();
  const loaded = [];
  const manager = new RGBModelManager({
    onLoad: async (raw, mapped) => { loaded.push([raw, mapped]); current = raw; currentBindings = mapped ?? bindings(); },
    getModel: () => current, getBindings: () => currentBindings,
    onBindings: async value => { currentBindings = value; }, ...overrides,
  });
  manager.init(current, currentBindings);
  t.after(() => { manager.dispose(); globalThis.document = originalDocument; globalThis.fetch = originalFetch; });
  return { manager, elements, loaded, current: () => current, currentBindings: () => currentBindings };
}

test('RGB local import commits only after strict definition and workspace validation', async t => {
  const { manager, loaded } = setup(t);
  await assert.rejects(manager.importText(JSON.stringify({ ...model(), version: '4.0.0' })));
  assert.equal(loaded.length, 0);
  assert.equal(manager.local.size, 1);
  manager.onLoad = async () => { throw new Error('binding validation failed'); };
  await assert.rejects(manager.importText(JSON.stringify(model('INVALID_BINDING'))), /binding validation/);
  assert.equal(manager.selectedId, 'local:default');
  assert.equal(manager.local.size, 1);
  assert.equal(manager.busy, false);
});

test('RGB bindings stay separate and failed apply keeps the saved local binding', async t => {
  const { manager } = setup(t);
  await manager.importText(JSON.stringify(model('CUSTOM')));
  const saved = structuredClone(manager.entry());
  manager.bindingsEditor.value = JSON.stringify({ invalid: true });
  manager.onBindings = async () => { throw new Error('invalid binding'); };
  await assert.rejects(manager.applyBindings(), /invalid binding/);
  assert.deepEqual(manager.entry(), saved);
  assert.equal(Object.hasOwn(saved.model, 'display'), false);
  assert.equal(Object.hasOwn(saved.model, 'bindings'), false);
  const calls = [];
  manager.onLoad = async (raw, bound) => calls.push([raw, bound]);
  await manager.loadEntry('local:default');
  assert.deepEqual(calls[0][1], bindings());
});

test('unconfirmed shared import and delete preserve local and current records', async t => {
  const { manager, current } = setup(t);
  await manager.importText(JSON.stringify(model('CUSTOM')));
  manager.pool = emptyPool(4);
  const selected = manager.selectedId, before = structuredClone(current());
  const requests = [];
  globalThis.fetch = async (_url, options) => {
    requests.push(options);
    return { ok: false, status: 409, json: async () => ({ error: 'revision conflict' }) };
  };
  await assert.rejects(manager.add(), /revision conflict/);
  assert.equal(manager.selectedId, selected);
  assert.equal(manager.local.size, 2);
  assert.deepEqual(current(), before);
  const command = JSON.parse(requests[0].body);
  assert.deepEqual(Object.keys(command).sort(), ['action', 'model', 'revision']);
  assert.equal(command.revision, 4);
  assert.equal(requests[0].headers.Authorization, undefined);
  manager.pool = { ...emptyPool(4), temporary: [poolEntry('remote')] };
  manager.selectedId = 'remote';
  await assert.rejects(manager.remove(), /revision conflict/);
  assert.equal(manager.pool.temporary.length, 1);
  assert.equal(manager.selectedId, 'remote');
  assert.deepEqual(current(), before);
});

test('permanent authorization clears password before dispatch and keeps captured revision', async t => {
  const { manager } = setup(t);
  manager.pool = { ...emptyPool(5), temporary: [poolEntry('remote')] };
  manager.selectedId = 'remote';
  await manager.add();
  assert.equal(manager.authDialog.open, true);
  manager.$('model-auth-password').value = 'test-only-password';
  let captured;
  globalThis.fetch = async (_url, options) => {
    assert.equal(manager.$('model-auth-password').value, '');
    captured = JSON.parse(options.body);
    assert.equal(options.headers.Authorization, 'Bearer test-only-password');
    return { ok: false, status: 401, json: async () => ({ error: 'authorization failed' }) };
  };
  await manager.confirmAuthorization();
  assert.deepEqual(captured, { action: 'promote', revision: 5, id: 'remote' });
  assert.equal(manager.pendingCommand.revision, 5);
  assert.equal(manager.$('model-auth-password').value, '');
  assert.equal(manager.pool.revision, 5);
  manager.$('model-auth-password').value = 'test-only-retry';
  globalThis.fetch = async (_url, options) => {
    assert.equal(JSON.parse(options.body).revision, 5);
    return { ok: true, json: async () => ({ pool: { ...emptyPool(6), permanent: [poolEntry('remote', true)] }, selectedId: 'remote' }) };
  };
  await manager.confirmAuthorization();
  assert.equal(manager.pool.revision, 6);
  assert.equal(manager.pendingCommand, null);
  assert.equal(manager.authDialog.open, false);
});

test('closing during a file read cancels the pending import', async t => {
  const { manager, loaded } = setup(t);
  let finish;
  const read = new Promise(resolve => { finish = resolve; });
  const fileInput = manager.$('file');
  manager.dialog.showModal();
  fileInput.files = [{ size: 100, text: () => read }];
  fileInput.dispatchEvent(new Event('change'));
  manager.close(); finish(JSON.stringify(model('LATE')));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(loaded.length, 0);
  assert.equal(manager.local.size, 1);
});
