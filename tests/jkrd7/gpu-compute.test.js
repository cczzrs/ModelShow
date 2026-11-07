import test from 'node:test';
import assert from 'node:assert/strict';
import { GPUCompute } from '../../src/jk/gpu-compute.js';
import { computeEX } from '../../src/jk/engine.js';
import { APP_CONFIG } from '../../html/config.js';

function globals(t, values) {
  const original = new Map(Object.keys(values).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(values)) Object.defineProperty(globalThis, key, { configurable: true, value });
  t.after(() => {
    for (const [key, descriptor] of original) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
  });
}

const entrances = () => [
  { path: 'G1.Q1', qBefore: 1, seed: 0, ops: ['J'], values: [1] },
  { path: 'G1.Q2', qBefore: 1, ops: ['J'], values: [1] },
  { path: 'G1.Q3', qBefore: 0, seed: 0, ops: ['K', 'K'], values: [1, 1] },
];

// This adapter mock decodes submitted storage buffers and exercises transfers,
// mapping and resource disposal. It does not claim to execute or validate WGSL.
function mockDevice({ validationError = null, mapError = null } = {}) {
  const buffers = [];
  let bound;
  const device = {
    limits: { maxStorageBufferBindingSize: 1024 * 1024 },
    destroyed: false,
    scopes: 0,
    dispatches: [],
    pushErrorScope() { this.scopes += 1; },
    async popErrorScope() { this.scopes -= 1; return validationError; },
    createBuffer({ size }) {
      const buffer = {
        bytes: new ArrayBuffer(size), destroyed: false, mapped: false,
        async mapAsync() { if (mapError) throw mapError; this.mapped = true; },
        getMappedRange() { assert.equal(this.mapped, true); return this.bytes; },
        unmap() { this.mapped = false; },
        destroy() { this.destroyed = true; },
      };
      buffers.push(buffer);
      return buffer;
    },
    createBindGroup({ entries }) { return entries.map(entry => entry.resource.buffer); },
    createCommandEncoder() {
      const commands = [];
      return {
        beginComputePass() {
          return {
            setPipeline() {},
            setBindGroup(_, group) { bound = group; },
            dispatchWorkgroups(count) {
              device.dispatches.push(count);
              const group = bound;
              commands.push(() => {
                const input = new Uint32Array(group[0].bytes);
                const output = new Uint32Array(group[1].bytes);
                for (let job = 0; job < input[0]; job += 1) {
                  const header = 4 + job * 4;
                  const start = input[header], length = input[header + 1];
                  let bit = Boolean(input[header + 2]);
                  for (let index = 0; index < length; index += 1) {
                    const op = input[start + index * 2], value = Boolean(input[start + index * 2 + 1]);
                    bit = op === 0 ? bit && value : bit !== value;
                  }
                  output[job] = Number(bit);
                }
              });
            },
            end() {},
          };
        },
        copyBufferToBuffer(source, sourceOffset, target, targetOffset, size) {
          commands.push(() => new Uint8Array(target.bytes, targetOffset, size).set(new Uint8Array(source.bytes, sourceOffset, size)));
        },
        finish() { return commands; },
      };
    },
    queue: {
      writeBuffer(buffer, offset, source) {
        new Uint8Array(buffer.bytes, offset, source.byteLength).set(new Uint8Array(source.buffer, source.byteOffset, source.byteLength));
      },
      submit(batches) { batches.flat().forEach(command => command()); },
    },
    destroy() { this.destroyed = true; },
  };
  return { device, buffers };
}

function attach(gpu, device) {
  gpu.device = device;
  gpu.pipeline = { getBindGroupLayout() { return {}; } };
}

function gpuConstants(t) {
  globals(t, {
    GPUBufferUsage: { STORAGE: 1, COPY_DST: 2, COPY_SRC: 4, MAP_READ: 8 },
    GPUMapMode: { READ: 1 },
  });
}

test('unavailable WebGPU reports JavaScript fallback and preserves EX entrance values', async t => {
  globals(t, { navigator: {} });
  const statuses = [];
  const gpu = new GPUCompute((...status) => statuses.push(status));
  assert.equal(await gpu.init(), false);
  assert.equal(statuses.at(-1)[1], false);
  assert.match(statuses.at(-1)[0], /JavaScript/);
  const input = entrances(), before = structuredClone(input);
  assert.deepEqual(await gpu.computeBatch(input), [0, 1, 0]);
  assert.deepEqual(input, before);
  assert.deepEqual(gpu.stats, { dispatches: 0, tasks: 0, fallbacks: 3 });
  assert.deepEqual(await gpu.computeBatch([]), []);
});

test('a later GPU chunk failure discards every partial result and recomputes the whole batch', async () => {
  const statuses = [], gpu = new GPUCompute((...status) => statuses.push(status));
  const device = { destroyed: false, destroy() { this.destroyed = true; } };
  attach(gpu, device);
  const input = Array.from({ length: APP_CONFIG.gpu.maxBatch + 3 }, (_, index) => ({
    path: `G1.Q${index + 1}`, qBefore: 0, seed: 1, ops: ['J', 'K', 'K'], values: [1, index % 2, index % 2],
  }));
  const before = structuredClone(input);
  let calls = 0;
  gpu.dispatch = async chunk => {
    calls += 1;
    if (calls === 2) throw new Error('device lost after first chunk');
    return chunk.map(() => 0); // Deliberately invalid partial values must not escape.
  };
  assert.deepEqual(await gpu.computeBatch(input), input.map(() => 1));
  assert.equal(calls, 2);
  assert.deepEqual(input, before);
  assert.equal(gpu.device, null);
  assert.equal(device.destroyed, true);
  assert.equal(gpu.stats.fallbacks, input.length);
  assert.match(statuses.at(-1)[0], /本批及后续使用 JavaScript/);
  assert.deepEqual(await gpu.computeBatch(entrances()), [0, 1, 0]);
  assert.equal(calls, 2, 'later batches must not return to the failed device');
});

test('packed EX jobs preserve seed zero, repeated sources and long variable-length expressions', async t => {
  gpuConstants(t);
  const { device, buffers } = mockDevice(), gpu = new GPUCompute();
  attach(gpu, device);
  const input = entrances();
  input.push({ path: 'G1.Q4', qBefore: 1, ops: Array(8193).fill('K'), values: Array(8193).fill(1) });
  input.push({ path: 'G1.Q5', qBefore: 0, seed: 1, ops: ['J', 'K', 'J'], values: [0, 1, 1] });
  const before = structuredClone(input);
  assert.deepEqual(await gpu.computeBatch(input), [0, 1, 0, 0, 1]);
  assert.deepEqual(input, before);
  assert.equal(gpu.stats.dispatches, 1);
  assert.equal(gpu.stats.tasks, input.length);
  assert.equal(gpu.stats.fallbacks, 0);
  assert.equal(device.scopes, 0);
  assert.ok(buffers.every(buffer => buffer.destroyed && !buffer.mapped));
});

test('GPU validation and mapping errors clean resources and return the complete JavaScript batch', async t => {
  gpuConstants(t);
  for (const settings of [{ validationError: { message: 'validation failure' } }, { mapError: new Error('mapping failure') }]) {
    const { device, buffers } = mockDevice(settings), gpu = new GPUCompute();
    attach(gpu, device);
    const input = entrances();
    assert.deepEqual(await gpu.computeBatch(input), input.map(computeEX));
    assert.equal(gpu.device, null);
    assert.equal(device.destroyed, true);
    assert.equal(device.scopes, 0);
    assert.ok(buffers.length > 0 && buffers.every(buffer => buffer.destroyed));
    assert.equal(gpu.stats.fallbacks, input.length);
    assert.equal(gpu.stats.dispatches, 0);
  }
});
