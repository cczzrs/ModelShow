import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { APP_CONFIG } from '../../html/config.js';
import { compileModel } from '../../src/jk/model-schema.js';
import { JKEngine } from '../../src/jk/engine.js';
import { createRGBWorkspace, validateRGBBindings, bitBatchToPaths } from '../../src/jk/rgb-workspace.js';
import { defaultImageInputConfig, extractPixelData, mapPixelData, clampSelection } from '../../src/ui/rgb-image-input.js';
import { decodeInputImage } from '../../src/ui/rgb-image-loader.js';

const sample = createRGBWorkspace();
const compiled = compileModel(sample.model);
const bitsFor = bytes => bytes.flatMap(value => Array.from({ length: 8 }, (_, bit) => value >> bit & 1));
function finish(engine) { let count = 0; while (!engine.idle) { engine.step(); assert.ok(++count < 10000); } }

test('RGB workspace is an ordinary JKRD7 composition with a complete-frame observer', () => {
  assert.equal(compiled.jki.size, 216 * 5 + 1);
  assert.equal(sample.bindings.inputs.length, 216);
  assert.deepEqual(sample.bindings.observe.watch, ['G1.Q1']);
  assert.deepEqual(Object.keys(sample.model), ['jkm', 'version', 'queues', 'roots']);
  assert.deepEqual(validateRGBBindings(sample.bindings, compiled), sample.bindings);
  const engine = new JKEngine(compiled, { observe: sample.bindings.observe });
  const bytes = Array.from({ length: 27 }, (_, index) => (index * 73 + 19) & 255), bits = bitsFor(bytes);
  const initialQ = structuredClone(engine.q);
  engine.injectBatch(bitBatchToPaths(bits, sample.bindings, compiled));
  assert.deepEqual(engine.q, initialQ, 'external inputs only enqueue notifications');
  finish(engine);
  assert.deepEqual(engine.outputs.map(entry => entry.values), [bits]);
});

test('overlapping complete RGB frames publish exactly once each and preserve bytes', () => {
  const engine = new JKEngine(compiled, { observe: sample.bindings.observe });
  const frames = [Array(216).fill(1), Array.from({ length: 216 }, (_, index) => index % 3 === 0 ? 1 : 0), Array(216).fill(0)];
  for (const bits of frames) engine.injectBatch(bitBatchToPaths(bits, sample.bindings, compiled));
  finish(engine);
  assert.deepEqual(engine.outputs.map(entry => entry.values), frames);
  assert.equal(engine.trace.filter(entry => entry.output).length, 3);
  assert.ok(Object.values(engine.triggerAll).every(arrivals => arrivals.every(value => value === null)));
});

test('malformed bits and bindings reject before an existing runtime can be changed', () => {
  const engine = new JKEngine(compiled, { observe: sample.bindings.observe });
  engine.injectBatch(bitBatchToPaths(Array(216).fill(0), sample.bindings, compiled));
  const before = engine.snapshot('unchanged');
  for (const bits of [[], Array(216), [...Array(215).fill(0), true], [...Array(215).fill(0), '1']]) {
    assert.throws(() => bitBatchToPaths(bits, sample.bindings, compiled));
  }
  const invalid = structuredClone(sample.bindings);
  invalid.inputs[1][0] = invalid.inputs[0][0];
  assert.throws(() => validateRGBBindings(invalid, compiled), /重复/);
  invalid.inputs[1] = ['G1.G2.Q5', 'G1.G2.Q2'];
  assert.throws(() => validateRGBBindings(invalid, compiled), /合法/);
  invalid.inputs[1] = sample.bindings.inputs[1]; invalid.observe.read.push('G1.G999.Q5');
  assert.throws(() => validateRGBBindings(invalid, compiled), /无效/);
  assert.deepEqual(engine.snapshot('unchanged'), before);
});

test('RGB crop, alpha composition and bit order produce explicit bit arrays', () => {
  const data = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 64, 128, 128]) };
  const config = defaultImageInputConfig();
  const pixels = extractPixelData(data, { x: 0, y: 0, width: 2, height: 1 }, config);
  assert.deepEqual([...pixels.bytes], [255, 0, 0, 127, 159, 191]);
  const labels = Array.from({ length: 48 }, (_, index) => `b${47 - index}`);
  const mapped = mapPixelData(pixels, config, labels);
  assert.deepEqual(mapped.bits, bitsFor([...pixels.bytes]));
  assert.deepEqual(JSON.parse(mapped.json), mapped.bits);
  const msb = mapPixelData(pixels, { ...config, bitOrder: 'msb-first' }, labels);
  assert.deepEqual(msb.bits, [...pixels.bytes].flatMap(value => Array.from({ length: 8 }, (_, bit) => value >> (7 - bit) & 1)));
  assert.throws(() => mapPixelData(pixels, config, labels.slice(1)), /恰好匹配/);
});

test('channel arrangement, grayscale and source bounds retain the old extraction controls', () => {
  const data = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 64, 255, 0, 128, 255, 255]) };
  const area = { x: 0, y: 0, width: 2, height: 1 }, config = defaultImageInputConfig();
  assert.deepEqual([...extractPixelData(data, area, { ...config, arrangement: 'channel' }).bytes], [255, 0, 0, 128, 64, 255]);
  assert.deepEqual([...extractPixelData(data, area, { ...config, encoding: 'gray' }).bytes], [84, 104]);
  assert.deepEqual(clampSelection({ x: -3, y: 4, width: 9, height: 9 }, 2, 1), area);
  assert.throws(() => extractPixelData(data, { ...area, x: 1 }, config), /原图内部/);
});

test('restored PNG presets use validated image decode and reject oversized or corrupt input', async () => {
  for (const name of ['b1.png', 'b2.png']) {
    const bytes = await readFile(new URL(`../../html/${name}`, import.meta.url));
    const header = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const size = { width: header.getUint32(16), height: header.getUint32(20) };
    let closed = false;
    const result = await decodeInputImage(new File([bytes], name, { type: 'image/png' }), {
      createBitmap: async (_blob, options) => { assert.equal(options.imageOrientation, 'from-image'); return { ...size, close() { closed = true; } }; },
    });
    assert.equal(result.name, name); assert.equal(result.width, size.width); assert.equal(closed, false);
    result.bitmap.close(); assert.equal(closed, true);
  }
  await assert.rejects(decodeInputImage(new File(['invalid'], 'bad.png'), { createBitmap: async () => assert.fail('must reject before decode') }), /仅支持/);
  await assert.rejects(decodeInputImage({ size: APP_CONFIG.rgb.imageInput.limits.fileBytes + 1, arrayBuffer() { assert.fail('must reject before reading'); } }), /超过/);
});

test('RGB complete frames match the central Python reference record and final state', () => {
  const engine = new JKEngine(compiled, { observe: sample.bindings.observe });
  const batches = [Array(216).fill(1), Array.from({ length: 216 }, (_, index) => index % 2)]
    .map(bits => bitBatchToPaths(bits, sample.bindings, compiled));
  for (const batch of batches) engine.injectBatch(batch);
  finish(engine);
  const result = spawnSync('python3', ['-c', `
import json,sys
sys.path.insert(0,sys.argv[1])
from jk_model import Model
from jk_reference import Reference
value=json.load(sys.stdin)
ref=Reference(Model(value['model'],'ModelShow RGB'),value['observe']['watch'],value['observe']['read'])
for batch in value['batches']:
    for path in batch: ref.inject(path)
ref.run()
print(json.dumps({'record':ref.record(),'snapshot':ref.snapshot('final')}))
`, fileURLToPath(new URL('../../../JK/scripts/', import.meta.url))], {
    input: JSON.stringify({ model: sample.model, observe: sample.bindings.observe, batches }), encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' }, maxBuffer: 8 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const expected = JSON.parse(result.stdout);
  assert.deepEqual(engine.trace, expected.record);
  assert.deepEqual(engine.snapshot('final'), expected.snapshot);
});
