/** Keep control state aligned with the configured scene before the first click. */
export function syncSceneControlButtons({ labels, background }, scene) {
  labels.setAttribute('aria-pressed', String(scene.nodeLabelsHidden));
  labels.textContent = scene.nodeLabelsHidden ? '显示名称和次数' : '隐藏名称和次数';
  background.setAttribute('aria-pressed', String(scene.blackBackground));
}

/** GPUCompute owns initialization deduplication and the JavaScript fallback. */
export async function initializeConfiguredBackend(gpu, backend, isDisposed = () => false) {
  if (backend !== 'webgpu' || isDisposed()) return false;
  const ready = await gpu.init();
  return !isDisposed() && ready;
}
