import * as THREE from 'three/webgpu';
import { APP_CONFIG } from '../../html/config.js';
import { CanvasRenderer } from './canvas-renderer.js';

// A lost device or a partially initialized renderer can also fail during disposal.
export function disposeRenderer(renderer) {
  if (!renderer) return;
  // Three 0.180 dispose() calls async setAnimationLoop(), which retries init()
  // when initialization failed. Avoid that unhandled rejection on the failure path.
  const incomplete = renderer.isRenderer === true && renderer._initialized === false;
  if (renderer.backend?.isWebGPUBackend) renderer.onDeviceLost = () => {};
  try { if (!incomplete) renderer.dispose(); } catch { /* Continue releasing the device. */ }
  if (renderer.backend?.isWebGPUBackend) {
    try { renderer.backend.context?.unconfigure(); } catch { /* The context may already be lost. */ }
    try { renderer.backend.device?.destroy(); } catch { /* The device may already be lost. */ }
  }
}

export async function createRenderer(view, {
  mode = APP_CONFIG.scene.renderer.mode,
  gpu = globalThis.navigator?.gpu,
  createGPU = () => new THREE.WebGPURenderer({ antialias: true, alpha: true }),
  createCanvas = () => new CanvasRenderer(view),
  timeoutMs = APP_CONFIG.scene.renderer.initTimeoutMs,
} = {}) {
  const software = reason => ({ renderer: createCanvas(), backend: 'canvas', reason });
  if (mode === 'canvas') return software(null);
  if (!gpu) return software('浏览器未提供 WebGPU');

  let renderer, timer, abandoned = false;
  // Cover both adapter discovery and device initialization with one deadline.
  const initialize = async () => {
    const adapter = await gpu.requestAdapter();
    if (abandoned) return null;
    if (!adapter) throw new Error('未找到可用的 GPU');
    renderer = createGPU();
    // Three 0.180 otherwise silently tries WebGL, which is not our software path.
    renderer._getFallback = null;
    try {
      await renderer.init();
    } finally {
      // A timed-out init can allocate resources after the first cleanup attempt.
      if (abandoned) disposeRenderer(renderer);
    }
    if (abandoned) return null;
    if (!renderer.backend?.isWebGPUBackend) throw new Error('WebGPU 未能启动');
    if (renderer._isDeviceLost) throw new Error('GPU 在初始化期间失去连接');
    return renderer;
  };
  try {
    const ready = await Promise.race([
      initialize(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('WebGPU 初始化超时')), timeoutMs);
      }),
    ]);
    return { renderer: ready, backend: 'webgpu', reason: null };
  } catch (error) {
    abandoned = true;
    disposeRenderer(renderer);
    return software(error?.message || 'WebGPU 不可用');
  } finally {
    clearTimeout(timer);
  }
}
