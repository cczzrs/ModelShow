import test from 'node:test';
import assert from 'node:assert/strict';
import { RGBWorkspaceUI, initialRGBDisplay } from '../../src/ui/rgb-workspace-ui.js';
import { APP_CONFIG } from '../../html/config.js';
import { compileModel } from '../../src/jk/model-schema.js';
import { defaultDisplay } from '../../src/ui/rgb-output-display.js';
import { captureRGBConfig } from '../../src/ui/rgb-workspace-config.js';

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}
const model = compileModel({
  jkm: 'RGB_BOUNDARY_TEST', version: '7.0.0', queues: ['work'], roots: [{
    id: 'G1', members: [
      { id: 'Q1', q: 0, trigger: { any: [] } },
      { id: 'Q2', q: 1, trigger: { any: [] } },
    ], trigger: { any: ['Q1', 'Q2'] }, queue: 'work', pro: {}, runtime: {},
  }],
});
const bindings = { inputs: [['G1.Q1', 'G1.Q2']], observe: { watch: ['G1.Q2'], read: ['G1.Q2'] } };
function configFile(red) {
  const display = defaultDisplay(1, 1); display.pixels[0].channels.r.value = red;
  return { size: 0, text: async () => JSON.stringify(captureRGBConfig(model, bindings, display)) };
}
function context(boundary) {
  const errors = [], applied = [];
  const context = {
    version: 1, configFileVersion: 0, model, bindings: structuredClone(bindings),
    presentations: new Map(), presentationKey: 'current', boundary,
    manager: { syncBindings() {}, error(message) { errors.push(message); } },
    outputUI: { load(display) { applied.push(display.pixels[0].channels.r.value); } },
    setBindings(next) { this.bindings = next; this.version++; },
    applyDisplay() {}, render() {}, message() {},
  };
  return { context, errors, applied };
}

test('only the latest RGB configuration applies after two imports wait at the same compute boundary', async () => {
  const waiting = deferred(); let entered = 0;
  const state = context(async action => { entered++; await waiting.promise; return action(); });
  const first = RGBWorkspaceUI.prototype.importConfig.call(state.context, configFile(25));
  await Promise.resolve();
  const second = RGBWorkspaceUI.prototype.importConfig.call(state.context, configFile(211));
  await Promise.resolve();
  assert.equal(entered, 2);
  waiting.resolve();
  assert.deepEqual(await Promise.all([first, second]), [false, true]);
  assert.deepEqual(state.applied, [211]);
  assert.equal(state.context.version, 2);
  assert.deepEqual(state.errors, []);
});

test('a superseded file read cannot replace a newer import or overwrite its status with an old error', async () => {
  const reading = deferred();
  const state = context(async action => action());
  const oldFile = { size: 0, text: () => reading.promise };
  const old = RGBWorkspaceUI.prototype.importConfig.call(state.context, oldFile);
  assert.equal(await RGBWorkspaceUI.prototype.importConfig.call(state.context, configFile(190)), true);
  reading.resolve('{invalid-json');
  assert.equal(await old, false);
  assert.deepEqual(state.applied, [190]);
  assert.deepEqual(state.errors, []);
});

test('a pending RGB deactivation cannot override a newer activation when a GPU unit finishes', async () => {
  const waiting = deferred(), motion = [];
  const state = {
    active: true, boundary: async action => { await waiting.promise; return action(); },
    view: { setAnimationEnabled(active) { motion.push(active); }, resize() {} }, render() {},
  };
  const leaving = RGBWorkspaceUI.prototype.setActive.call(state, false);
  assert.equal(await RGBWorkspaceUI.prototype.setActive.call(state, true), true);
  waiting.resolve();
  assert.equal(await leaving, false);
  assert.equal(state.active, true);
  assert.deepEqual(motion, [true]);
  assert.equal(await RGBWorkspaceUI.prototype.setActive.call(state, false), true);
  assert.equal(state.active, false);
  assert.deepEqual(motion, [true, false]);
});

test('initial RGB output assignment obeys its own enable, start and gray defaults', () => {
  const display = defaultDisplay(1, 1);
  const outputs = Array.from({ length: 32 }, (_, index) => ({ id: `G1.Q${index + 1}`, source: `G1.Q${index + 1}` }));
  assert.equal(initialRGBDisplay(display, outputs, { enabled: false, startIndex: 0, gray: false }), display);
  assert.equal(initialRGBDisplay(display, [], { enabled: true, startIndex: 0, gray: false }), display);
  assert.equal(initialRGBDisplay(display, outputs, { enabled: true, startIndex: 99, gray: false }), display);
  const gray = initialRGBDisplay(display, outputs, { enabled: true, startIndex: 3, gray: true });
  for (const channel of ['r', 'g', 'b']) assert.deepEqual(gray.pixels[0].channels[channel].bits, outputs.slice(3, 11).map(output => output.id));
  const rgb = initialRGBDisplay(display, outputs, { enabled: true, startIndex: 1, gray: false });
  assert.equal(rgb.pixels[0].channels.r.bits[0], outputs[1].id);
  assert.equal(rgb.pixels[0].channels.g.bits[0], outputs[9].id);
  assert.equal(rgb.pixels[0].channels.b.bits[0], outputs[17].id);
  assert.deepEqual(display, defaultDisplay(1, 1));
});

test('RGB processing waits for configured backend startup and stops if disposed while waiting', async t => {
  const before = globalThis.document;
  globalThis.document = { getElementById: id => ({ value: 'webgpu', checked: true }) };
  t.after(() => { globalThis.document = before; });
  const waiting = deferred(), calls = [];
  const state = {
    backendReady: waiting.promise, disposed: false,
    engine: { runBatchAsync: async () => { calls.push('gpu'); return null; } },
    gpu: {}, remember() {},
  };
  const processing = RGBWorkspaceUI.prototype.process.call(state);
  await Promise.resolve(); assert.deepEqual(calls, []);
  waiting.resolve(true); await processing;
  assert.deepEqual(calls, ['gpu']);
  const leaving = deferred(); state.backendReady = leaving.promise;
  const abandoned = RGBWorkspaceUI.prototype.process.call(state);
  state.disposed = true; leaving.resolve(true); await abandoned;
  assert.deepEqual(calls, ['gpu']);
});

test('RGB queue rendering uses the configured shared row limit', t => {
  class Element {
    constructor() { this.children = []; this.parts = new Map(); this.classList = { toggle() {} }; }
    querySelector(selector) { if (!this.parts.has(selector)) this.parts.set(selector, new Element()); return this.parts.get(selector); }
    replaceChildren(...children) { this.children = children; }
    append(child) { this.children.push(child); }
    addEventListener() {}
    cloneNode() { return new Element(); }
  }
  const before = globalThis.document, elements = new Map();
  globalThis.document = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id);
  } };
  t.after(() => { globalThis.document = before; });
  document.getElementById('rgb-queue-row-template').content = { firstElementChild: new Element() };
  const count = APP_CONFIG.view.queues.rows + 4;
  const context = {
    engine: { events: Array.from({ length: count }, (_, index) => ({ source: `G1.Q${index + 1}`, to: [] })), tasks: [],
      outputs: [], stats: { nodeTasks: 0, operations: 0 }, units: 0, pending: count, history: [], idle: false },
    model: { jki: new Map(), triggerRefs: new Map(), sourceRefs: new Map() },
    bindings: { inputs: [], observe: { read: [] } }, gpu: {}, view: { update() {} }, outputUI: { update() {} },
    playbackSettings() {}, renderInspector() {},
  };
  RGBWorkspaceUI.prototype.render.call(context);
  const rows = elements.get('rgb-queue-rows').children;
  assert.equal(rows.length, APP_CONFIG.view.queues.rows);
  assert.equal(rows.at(-1).querySelector('[data-node-name]').textContent, `G1.Q${APP_CONFIG.view.queues.rows}`);
});
