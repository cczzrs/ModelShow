import { APP_CONFIG } from '../../html/config.js';
import { NetworkView as SceneView } from './view.js';
import { createDisplayModel, unitTransfers } from './model-view.js';
import { LAYOUT_MODES } from './layout.js';
import { disposeGroup } from './resources.js';
import { disposeRenderer } from './renderer-backend.js';

/** Keep the established scene and controls; adapt only JKRD7 presentation data. */
export class NetworkView extends SceneView {
  constructor({ container, onSelect = () => {}, onStatus = () => {}, onLayout = () => {}, preserveObservationSelection = false }) {
    super(container, key => onSelect(!preserveObservationSelection && key?.startsWith('observe:') ? key.slice(8) : key),
      error => onStatus({ backend: 'error', label: '渲染中断', reason: error.message }),
      layout => {
        if (!layout.pending && !layout.error) this.resetCamera();
        onLayout(layout);
      },
      backend => onStatus({ backend, label: backend === 'webgpu' ? 'WebGPU' : 'Canvas 3D', reason: this.fallbackReason }));
    this.playback = { running: false, speed: APP_CONFIG.playback.speed.value, skip: APP_CONFIG.playback.skip };
    this.motionEnabled = true; this.disposed = false; this.counts = new Map();
    this.traceCursor = 0; this.lastUnits = 0; this.observationKey = '';
    this.ready = super.init().then(() => {
      if (this.disposed) { this.releaseRenderer(); return; }
      this.resetCamera();
      const frame = now => {
        if (this.disposed) return;
        if (this.animationStart !== undefined && this.signals.length) {
          const elapsed = (now - this.animationStart) / 1000;
          this.progress(Math.min(1, elapsed * this.playback.speed / APP_CONFIG.playback.duration));
          if (this.signalProgress >= 1) { this.clearSignals(); this.animationStart = undefined; }
        }
        try { super.render(this.motionEnabled); } catch (error) { this.fail(error); }
        this.animationFrame = requestAnimationFrame(frame);
      };
      this.animationFrame = requestAnimationFrame(frame);
    });
  }

  setModel(compiled) {
    this.compiled = compiled; this.runtimeEngine = null; this.observationKey = '';
    this.counts = new Map(); this.traceSource = null; this.traceCursor = 0; this.lastUnits = 0;
    this.animationStart = undefined;
    super.setModel(createDisplayModel(compiled));
    this.resetCamera();
  }

  update(engine, selected) {
    if (!engine || !this.compiled) return;
    if (engine !== this.runtimeEngine || engine.trace !== this.traceSource || engine.units < this.lastUnits) {
      this.clearSignals(); this.animationStart = undefined;
      this.counts = new Map(); this.traceCursor = 0;
    }
    this.runtimeEngine = engine; this.traceSource = engine.trace; this.lastUnits = engine.units;
    const observation = { watch: [...engine.watch], read: [...engine.read] };
    const key = JSON.stringify(observation);
    if (key !== this.observationKey) {
      const mode = this.layoutMode;
      this.observationKey = key;
      super.setModel(createDisplayModel(this.compiled, observation));
      if (mode !== this.layoutMode) this.requestLayout(mode);
    }
    for (; this.traceCursor < engine.trace.length; this.traceCursor += 1) {
      const entry = engine.trace[this.traceCursor];
      if (entry.q) this.counts.set(entry.q, (this.counts.get(entry.q) ?? 0) + 1);
    }
    const outputs = new Map();
    const latest = engine.outputs.at(-1);
    if (latest) engine.read.forEach((path, index) => outputs.set(`observe:${path}`, latest.values[index]));
    const projection = { counts: this.counts, outputs };
    this.selected = selected; this.outputBoard.select(selected);
    super.refresh(projection);
  }

  setLayout(mode) {
    if (!LAYOUT_MODES.includes(mode)) throw new Error(`未知布局：${mode}`);
    if (this.model) this.requestLayout(mode);
    else this.layoutMode = mode;
  }
  setLabels(enabled) { this.setNodeLabelsHidden(!enabled); }
  fit() { this.resetCamera(); }
  setAnimationEnabled(enabled) { this.motionEnabled = Boolean(enabled); }
  setPlayback({ running = this.playback.running, speed = this.playback.speed, skip = this.playback.skip } = {}) {
    const skipChanged = skip && !this.playback.skip;
    if (this.animationStart !== undefined && speed !== this.playback.speed) {
      const now = performance.now();
      this.animationStart = now - (now - this.animationStart) * this.playback.speed / speed;
    }
    this.playback = { running, speed, skip };
    if (skipChanged) { this.clearSignals(); this.animationStart = undefined; }
  }
  onUnit(entry, { force = false } = {}) {
    if (!this.compiled || this.playback.skip && !force) return;
    const transfers = unitTransfers(this.compiled, entry);
    const engine = this.runtimeEngine;
    if (entry?.kind === 'event' && entry.event?.out !== false && engine?.watch.has(entry.target)) {
      const latest = engine.outputs.at(-1);
      if (latest) engine.read.forEach((path, index) => transfers.push({
        source: path, target: `observe:${path}`, value: latest.values[index],
      }));
    }
    this.showTransfers(transfers.slice(0, APP_CONFIG.playback.maxVisuals));
    this.animationStart = this.signals.length ? performance.now() : undefined;
  }
  get visualBusy() { return this.signals.length > 0 && this.signalProgress < 1; }

  releaseRenderer() {
    this.available = false; this.resizeObserver?.disconnect(); this.controls?.dispose();
    if (this.visibilityChanged) document.removeEventListener('visibilitychange', this.visibilityChanged);
    const renderer = this.renderer; this.renderer = null;
    renderer?.domElement.remove(); disposeRenderer(renderer);
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.animationFrame);
    this.layoutGeneration += 1; this.layoutWorker?.terminate();
    this.releaseRenderer(); this.clearSignals();
    this.labels?.dispose(); this.batches?.dispose();
    for (const visual of this.visuals.values()) visual.mesh.material.dispose();
    this.nodeGeometry?.dispose(); disposeGroup(this.group); this.outputBoard.clear();
    this.scene.clear(); this.visuals.clear();
  }
}
