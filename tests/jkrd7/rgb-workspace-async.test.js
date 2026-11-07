import test from 'node:test';
import assert from 'node:assert/strict';
import { RGBWorkspaceUI } from '../../src/ui/rgb-workspace-ui.js';
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
