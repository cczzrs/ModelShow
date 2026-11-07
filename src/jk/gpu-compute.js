import { APP_CONFIG } from '../../html/config.js';
import { computeEX } from './engine.js';

/** WebGPU evaluates EX only. The JS scheduler owns all ordering and publication. */
export class GPUCompute {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.device = null;
    this.pipeline = null;
    this.stats = { dispatches: 0, tasks: 0, fallbacks: 0 };
    this.reason = '尚未初始化';
    this.initialization = null;
    this.disposed = false;
  }
  async init() {
    if (this.device) return true;
    if (this.initialization) return this.initialization;
    this.disposed = false;
    this.initialization = this.initialize();
    try { return await this.initialization; } finally { this.initialization = null; }
  }
  async initialize() {
    let candidate;
    try {
      if (!globalThis.navigator?.gpu) throw new Error('此浏览器未提供 WebGPU');
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error('没有可用的 WebGPU 适配器');
      const device = candidate = await adapter.requestDevice();
      const module = device.createShaderModule({ label: APP_CONFIG.gpu.label, code: `
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> result: array<u32>;
@compute @workgroup_size(${APP_CONFIG.gpu.workgroupSize})
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let job = gid.x;
  if (job >= data[0]) { return; }
  let base = 4u + job * 4u;
  let offset = data[base];
  let length = data[base + 1u];
  var acc = data[base + 2u];
  for (var i = 0u; i < length; i = i + 1u) {
    let op = data[offset + i * 2u];
    let value = data[offset + i * 2u + 1u];
    if (op == 0u) { acc = acc & value; } else { acc = acc ^ value; }
  }
  result[job] = acc;
}` });
      const info = await module.getCompilationInfo();
      const errors = info.messages.filter(message => message.type === 'error');
      if (errors.length) { device.destroy(); throw new Error(errors.map(message => message.message).join('; ')); }
      this.pipeline = await device.createComputePipelineAsync({ label: APP_CONFIG.gpu.label, layout: 'auto', compute: { module, entryPoint: 'main' } });
      if (this.disposed) { device.destroy(); return false; }
      this.device = device;
      this.reason = '';
      device.lost.then(info => {
        if (this.device === device) { this.device = null; this.reason = `设备不可用：${info.message || info.reason}`; this.onStatus(this.reason, false); }
      });
      this.onStatus('WebGPU 已就绪 · EX 在 GPU 上执行', true);
      return true;
    } catch (error) {
      candidate?.destroy();
      this.reason = error.message;
      this.onStatus(`${this.reason}；计算使用 JavaScript`, false);
      return false;
    }
  }
  async compute(input) { return (await this.computeBatch([input]))[0]; }
  async computeBatch(inputs) {
    if (!inputs.length) return [];
    if (!this.device) { this.stats.fallbacks += inputs.length; return inputs.map(computeEX); }
    // Device loss, limits, and dispatch failures never interrupt a JK transaction.
    // Recompute from the same immutable entrance values, before any q commit.
    try {
      const results = [];
      for (let offset = 0; offset < inputs.length; offset += APP_CONFIG.gpu.maxBatch) {
        results.push(...await this.dispatch(inputs.slice(offset, offset + APP_CONFIG.gpu.maxBatch)));
      }
      return results;
    } catch (error) {
      this.stats.fallbacks += inputs.length;
      this.reason = `GPU 计算失败：${error.message}`;
      const device = this.device;
      this.device = null;
      device?.destroy();
      this.onStatus(`${this.reason}；本批及后续使用 JavaScript`, false);
      return inputs.map(computeEX);
    }
  }
  async dispatch(inputs) {
    const device = this.device;
    const size = 4 + inputs.length * 4 + inputs.reduce((sum, input) => sum + input.ops.length * 2, 0);
    if (size * 4 > device.limits.maxStorageBufferBindingSize) throw new Error('EX 超出 GPU 缓冲区限制');
    const packed = new Uint32Array(size);
    packed[0] = inputs.length;
    let offset = 4 + inputs.length * 4;
    inputs.forEach((input, index) => {
      packed.set([offset, input.ops.length, input.seed ?? input.qBefore, 0], 4 + index * 4);
      input.ops.forEach((op, i) => { packed[offset++] = op === 'J' ? 0 : 1; packed[offset++] = input.values[i]; });
    });
    const buffers = [];
    let scopeOpen = false;
    try {
      device.pushErrorScope('validation'); scopeOpen = true;
      const source = device.createBuffer({ label: 'EX entrance values', size: packed.byteLength, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST }); buffers.push(source);
      const result = device.createBuffer({ size: inputs.length * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC }); buffers.push(result);
      const readback = device.createBuffer({ size: inputs.length * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ }); buffers.push(readback);
      device.queue.writeBuffer(source, 0, packed);
      const bindGroup = device.createBindGroup({ layout: this.pipeline.getBindGroupLayout(0), entries: [
        { binding: 0, resource: { buffer: source } }, { binding: 1, resource: { buffer: result } },
      ] });
      const encoder = device.createCommandEncoder();
      const pass = encoder.beginComputePass();
      pass.setPipeline(this.pipeline); pass.setBindGroup(0, bindGroup);
      pass.dispatchWorkgroups(Math.ceil(inputs.length / APP_CONFIG.gpu.workgroupSize)); pass.end();
      encoder.copyBufferToBuffer(result, 0, readback, 0, inputs.length * 4);
      device.queue.submit([encoder.finish()]);
      const validation = await device.popErrorScope(); scopeOpen = false;
      if (validation) throw new Error(validation.message);
      await readback.mapAsync(GPUMapMode.READ);
      const bits = Array.from(new Uint32Array(readback.getMappedRange()));
      readback.unmap();
      if (bits.some(bit => bit !== 0 && bit !== 1)) throw new Error('GPU 返回非 bit 结果');
      this.stats.dispatches++; this.stats.tasks += inputs.length;
      return bits;
    } finally {
      if (scopeOpen) await device.popErrorScope().catch(() => {});
      buffers.forEach(buffer => buffer.destroy());
    }
  }
  dispose() { this.disposed = true; const device = this.device; this.device = null; device?.destroy(); }
}
