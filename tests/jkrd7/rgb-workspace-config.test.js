import test from 'node:test';
import assert from 'node:assert/strict';
import { compileModel } from '../../src/jk/model-schema.js';
import { JKEngine } from '../../src/jk/engine.js';
import { createRGBWorkspace } from '../../src/jk/rgb-workspace.js';
import { defaultDisplay, batchDisplay, convertPixel } from '../../src/ui/rgb-output-display.js';
import { captureRGBConfig, validateRGBConfig } from '../../src/ui/rgb-workspace-config.js';

const initial = createRGBWorkspace();
const model = compileModel(initial.model);
const bindings = initial.bindings;
const outputs = bindings.observe.read.map(path => ({ id: path, source: path }));
const display = batchDisplay(defaultDisplay(), { start: outputs[0].id, gray: false }, outputs);

function configuration() { return captureRGBConfig(model, bindings, display); }

test('separate RGB configuration round-trips bindings and RGB lamps without adding fields to JKM', () => {
  const definition = structuredClone(model.raw);
  const saved = configuration();
  assert.deepEqual(Object.keys(saved), ['rgb', 'model', 'bindings', 'display']);
  assert.equal(saved.model, model.name);
  assert.deepEqual(validateRGBConfig(JSON.parse(JSON.stringify(saved)), model), saved);
  assert.deepEqual(model.raw, definition);
  saved.bindings.inputs[0].reverse();
  saved.display.pixels[0].channels.r.bits.reverse();
  assert.deepEqual(model.raw, definition);
  assert.equal(bindings.inputs[0][0], 'G1.G1.Q1');
  assert.equal(display.pixels[0].channels.r.bits[0], outputs[0].id);
});

test('RGB files reject extra fields, unsupported versions, wrong model identity and malformed nested state', () => {
  const invalid = [
    raw => { raw.snapshot = {}; },
    raw => { delete raw.display; },
    raw => { raw.rgb = '1'; },
    raw => { raw.rgb = 0; },
    raw => { raw.model = 'another-model'; },
    raw => { raw.bindings.inputs[0][0] = raw.bindings.inputs[0][1]; },
    raw => { raw.display.extra = 1; },
    raw => { raw.display.pixels[0].channels.r.extra = 1; },
    raw => { raw.display.pixels[0].channels.r.bits = ['Y0']; },
    raw => { raw.display.rows = 0; },
  ];
  for (const mutate of invalid) {
    const raw = configuration(); mutate(raw);
    assert.throws(() => validateRGBConfig(raw, model));
  }
});

test('independent and packed lamps may only reference the configured observed read paths', () => {
  const raw = configuration();
  raw.display.pixels[0].channels.r.bits[0] = bindings.inputs[0][0];
  assert.throws(() => validateRGBConfig(raw, model), /不在 bindings.observe.read/);
  const packed = configuration();
  packed.display.pixels[0] = convertPixel(packed.display.pixels[0], 'packed');
  assert.deepEqual(validateRGBConfig(packed, model).display.pixels[0], packed.display.pixels[0]);
  packed.display.pixels[0].bits[0] = 'G1.Q1';
  assert.throws(() => validateRGBConfig(packed, model), /不在 bindings.observe.read/);
});

test('failed RGB validation preserves queued computation and supplied configuration atomically', () => {
  const engine = new JKEngine(model, { observe: bindings.observe });
  engine.inject(bindings.inputs[0][1]); engine.step();
  const before = engine.snapshot('config-import-boundary');
  const trace = structuredClone(engine.trace);
  const raw = configuration(); raw.display.pixels[0].channels.r.bits[0] = 'G1.Q1';
  const badCopy = structuredClone(raw);
  assert.throws(() => validateRGBConfig(raw, model));
  assert.deepEqual(raw, badCopy);
  assert.deepEqual(engine.snapshot('config-import-boundary'), before);
  assert.deepEqual(engine.trace, trace);
});
