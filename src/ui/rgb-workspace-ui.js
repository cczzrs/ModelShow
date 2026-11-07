import { APP_CONFIG } from '../../html/config.js';
import { compileModel } from '../jk/model-schema.js';
import { JKEngine } from '../jk/engine.js';
import { GPUCompute } from '../jk/gpu-compute.js';
import { createRGBWorkspace, validateRGBBindings, bitBatchToPaths } from '../jk/rgb-workspace.js';
import { NetworkView } from '../scene/network-view.js';
import { setupSceneFullscreen } from '../scene/fullscreen.js';
import { ImageInputUI } from './rgb-image-ui.js';
import { RGBOutputDisplayUI, lampDetails } from './rgb-output-ui.js';
import { defaultDisplay, batchDisplay } from './rgb-output-display.js';
import { RGBModelManager } from './rgb-model-manager.js';
import { captureRGBConfig, validateRGBConfig } from './rgb-workspace-config.js';

const pretty = value => JSON.stringify(value, null, 2);
const $ = id => document.getElementById(`rgb-${id}`);
const template = id => $(id).content.firstElementChild.cloneNode(true);
// Drawing endpoints are distinct from the real JKI addresses used in bindings.
function drawingDisplay(config) {
  const next = structuredClone(config);
  function visit(value) {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'bits') value[key] = child.map(path => `observe:${path}`);
      else visit(child);
    }
  }
  visit(next); return next;
}

/** The original RGB workspace, using only the current JKRD7 executor. */
export class RGBWorkspaceUI {
  constructor() {
    this.panel = $('panel'); this.active = true; this.running = false; this.version = 0;
    this.timer = null; this.inFlight = null; this.generation = 0; this.last = new Map();
    this.presentations = new Map(); this.configFileVersion = 0;
    this.outputCells = new Map(); this.pickerCells = new Map(); this.listeners = [];
    this.gpu = new GPUCompute((text) => { $('compute-message').textContent = text; });
    this.view = new NetworkView({
      container: $('viewport'), preserveObservationSelection: true,
      onSelect: path => this.select(path),
      onStatus: status => {
        $('render-status').textContent = status.label;
        $('render-status').title = status.reason || status.label;
        $('gpu-message').hidden = status.backend !== 'error';
        $('gpu-detail').textContent = status.reason || '';
      },
      onLayout: layout => { $('layout-status').textContent = layout.pending ? '正在排列…' : layout.error || `${layout.mode} 布局`; },
    });
    this.outputUI = new RGBOutputDisplayUI($('output-display-dialog'), config => {
      this.display = config; this.presentations.set(this.presentationKey, structuredClone(config)); this.applyDisplay(); this.renderInspector();
    });
    this.imageUI = new ImageInputUI($('image-input-dialog'), (bits, version) => {
      if (version !== this.version) throw new Error('模型或绑定已更换，请重新提取像素数据。');
      bitBatchToPaths(bits, this.bindings, this.model);
      $('input-json').value = pretty(bits); this.message('已填入图片像素数据，点击“发送信号”执行。');
    }, () => $('input-json').focus());
    this.manager = new RGBModelManager({
      onLoad: (raw, bindings) => this.boundary(() => this.install(raw, bindings)),
      getModel: () => this.model.raw, getBindings: () => this.bindings,
      onBindings: raw => this.boundary(() => this.setBindings(raw)),
      onMessage: (text, error) => this.message(text, error),
    });
    this.bind();
    const initial = createRGBWorkspace();
    this.install(initial.model, initial.bindings, true);
    this.manager.init(initial.model, initial.bindings);
    this.ready = this.view.ready;
  }

  listen(element, type, callback) {
    element.addEventListener(type, callback); this.listeners.push(() => element.removeEventListener(type, callback));
  }
  action(id, callback) {
    this.listen($(id), 'click', async () => { try { await callback(); } catch (error) { this.message(error.message, true); } });
  }
  message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
  pause() {
    this.running = false; this.generation++; clearTimeout(this.timer); this.timer = null;
    this.playbackSettings();
  }
  async boundary(action) { this.pause(); if (this.inFlight) await this.inFlight; return action(); }
  async setActive(active) {
    const generation = this.activationVersion = (this.activationVersion ?? 0) + 1;
    if (!active) await this.boundary(() => {});
    if (generation !== this.activationVersion) return false;
    this.active = active; this.view.setAnimationEnabled(active);
    if (active) { this.view.resize(); this.render(); }
    return true;
  }
  async importConfig(file) {
    const fileVersion = ++this.configFileVersion, modelVersion = this.version;
    const current = () => fileVersion === this.configFileVersion && modelVersion === this.version;
    try {
      if (file.size > APP_CONFIG.view.fileBytes) throw new Error('配置文件超过大小限制');
      const raw = JSON.parse(await file.text());
      if (!current()) return false;
      const config = validateRGBConfig(raw, this.model);
      return await this.boundary(() => {
        // Reading and waiting for an in-flight unit are separate async boundaries.
        if (!current()) return false;
        this.setBindings(config.bindings); this.manager.syncBindings(this.bindings); this.display = config.display;
        this.presentations.set(this.presentationKey, structuredClone(config.display));
        this.outputUI.load(this.display, this.bindings.observe.read.map(path => ({id:path,source:path})));
        this.applyDisplay(); this.render(); this.message('已导入 RGB 输入、观察和灯阵配置。');
        return true;
      });
    } catch (error) {
      if (fileVersion === this.configFileVersion) this.manager.error(error.message);
      return false;
    }
  }
  playbackSettings() {
    const speed = Number($('speed').value), skip = $('skip').checked;
    this.view.setPlayback({ running: this.running, speed, skip });
    $('speed-label').textContent = skip ? '计算速度' : '动画速度';
    $('speed-value').textContent = `${speed}×`;
    $('speed-budget').textContent = skip ? `每帧预算 ${APP_CONFIG.engine.frameBudgetMs * speed} ms` : `每单元 ${(APP_CONFIG.playback.duration / speed).toFixed(2)} 秒`;
    $('play').textContent = this.running ? 'Ⅱ 暂停' : '▶ 播放';
  }
  bind() {
    for (const key of ['min', 'max', 'step']) $('speed')[key] = APP_CONFIG.playback.speed[key];
    $('speed').value = APP_CONFIG.playback.speed.value; $('skip').checked = APP_CONFIG.playback.skip;
    $('backend').value = APP_CONFIG.engine.backend;
    this.listen($('speed'), 'input', () => this.playbackSettings());
    this.listen($('skip'), 'change', () => this.playbackSettings());
    this.listen($('backend'), 'change', () => this.boundary(async () => {
      if ($('backend').value === 'webgpu') await this.gpu.init();
      else $('compute-message').textContent = 'JavaScript 串行计算';
      this.render();
    }).catch(error => this.message(error.message, true)));
    this.action('send', () => this.boundary(() => {
      const paths = bitBatchToPaths(JSON.parse($('input-json').value), this.bindings, this.model);
      this.engine.injectBatch(paths); this.render(); this.message(`已发送 ${paths.length} 位输入通知。`);
    }));
    this.action('play', () => this.play());
    this.action('step', () => this.boundary(async () => {
      this.inFlight = this.process(true);
      try { await this.inFlight; } finally { this.inFlight = null; }
      this.render();
    }));
    this.action('reset', () => this.boundary(() => {
      this.engine.reset(); this.last.clear(); this.render(); this.message('已恢复模型初值。');
    }));
    this.action('config-download', () => {
      const config = captureRGBConfig(this.model, this.bindings, this.display);
      const url = URL.createObjectURL(new Blob([pretty(config)], { type: 'application/json' }));
      const link = document.getElementById('download-template').content.firstElementChild.cloneNode(true);
      link.href = url; link.download = `${this.model.name.replace(/[\\/:*?"<>|]/g, '_')}.rgb.json`;
      document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    });
    this.listen($('config-file'), 'change', event => {
      const file = event.target.files[0]; event.target.value = '';
      if (file) this.importConfig(file);
    });
    this.action('image-input', () => this.imageUI.open());
    this.action('output-render', () => this.outputUI.open());
    this.action('inspector-lamp-edit', () => this.outputUI.open(Number(this.selected.slice(5))));
    this.action('camera-reset', () => this.view.fit());
    this.action('gpu-retry', () => this.view.recover());
    this.action('node-labels', () => {
      const hidden = $('node-labels').getAttribute('aria-pressed') !== 'true';
      $('node-labels').setAttribute('aria-pressed', String(hidden));
      $('node-labels').textContent = hidden ? '显示名称和次数' : '隐藏名称和次数'; this.view.setLabels(!hidden);
    });
    this.action('black-background', () => {
      const black = $('black-background').getAttribute('aria-pressed') !== 'true';
      $('black-background').setAttribute('aria-pressed', String(black)); this.view.setBlackBackground(black);
    });
    for (const button of this.panel.querySelectorAll('[data-layout]')) {
      button.classList.toggle('active', button.dataset.layout === APP_CONFIG.scene.layout);
      button.setAttribute('aria-pressed', String(button.dataset.layout === APP_CONFIG.scene.layout));
      this.listen(button, 'click', () => {
        this.view.setLayout(button.dataset.layout);
        for (const item of this.panel.querySelectorAll('[data-layout]')) {
          item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button));
        }
      });
    }
    setupSceneFullscreen(this.panel.querySelector('.main-view'), $('scene-fullscreen'), this.panel.querySelector('.inspector'));
  }

  install(raw, bindings, initial = false) {
    const model = compileModel(raw);
    const checked = validateRGBBindings(bindings ?? { inputs: [], observe: { watch: [], read: [] } }, model);
    const engine = new JKEngine(model, { observe: checked.observe, historyLimit: APP_CONFIG.view.traceRows });
    if (this.presentationKey) this.presentations.set(this.presentationKey, structuredClone(this.display));
    this.presentationKey = JSON.stringify({model: model.raw, bindings: checked});
    this.model = model; this.engine = engine; this.bindings = checked; this.version++;
    this.last.clear(); this.selected = null;
    this.display = structuredClone(this.presentations.get(this.presentationKey) ?? defaultDisplay());
    const outputs = checked.observe.read.map(path => ({ id: path, source: path }));
    if (initial) this.display = batchDisplay(this.display, { start: outputs[0].id, gray: false }, outputs);
    this.presentations.set(this.presentationKey, structuredClone(this.display));
    this.imageUI.setModel(checked.inputs.map((_, index) => `b${index}`), this.version);
    this.outputUI.load(this.display, outputs);
    $('model-name').textContent = model.name; $('model-md5').textContent = `JKRD ${model.raw.version}`;
    $('model-validation').textContent = `JKRD7 · ${model.jki.size} JKI / ${model.jks.size} JKS`;
    $('model-errors').hidden = true; $('metadata').textContent = pretty({ jkm: model.name, version: model.raw.version, queues: model.raw.queues });
    $('input-json').value = pretty(Array(checked.inputs.length).fill(APP_CONFIG.rgb.inputBit));
    $('bindings-json').value = pretty(checked);
    this.outputCells.clear(); $('output-rows').replaceChildren(); $('outputs-empty').hidden = outputs.length > 0;
    for (const [index, output] of outputs.entries()) {
      const row = template('output-row-template'); row.querySelector('[data-output-id]').textContent = `b${index}`;
      row.querySelector('.source').textContent = output.source; row.title = output.source;
      this.outputCells.set(index, { value: row.querySelector('.output-value'), publication: row.querySelector('.output-publication') });
      $('output-rows').append(row);
    }
    this.pickerCells.clear(); $('node-picker').replaceChildren();
    const items = [...model.paths, ...outputs.map(output => `observe:${output.id}`)];
    for (const path of items) {
      const button = template('node-button-template'); button.textContent = path.startsWith('observe:') ? `观察 ${path.slice(8)}` : path;
      button.addEventListener('click', () => this.select(path)); this.pickerCells.set(path, button); $('node-picker').append(button);
    }
    this.view.setModel(model); this.render(); this.applyDisplay();
    this.message(checked.inputs.length ? 'RGB 输入与输出已就绪。' : '已加载 JKM；在模型管理中配置 RGB 输入与输出绑定。');
  }
  setBindings(raw) {
    const checked = validateRGBBindings(raw, this.model);
    this.install(this.model.raw, checked); this.message('已应用 RGB 绑定，并恢复模型初值。');
  }
  applyDisplay() {
    this.view.setOutputDisplay(drawingDisplay(this.display));
  }
  select(path) {
    this.selected = path === this.selected ? null : path;
    for (const [key, button] of this.pickerCells) button.classList.toggle('active', key === this.selected);
    this.view.update(this.engine, this.selected); this.renderInspector();
  }
  remember(entry) {
    if (!entry) return;
    if (entry.kind === 'batch') entry.entries.forEach(item => this.remember(item));
    else if (entry.kind === 'transaction') entry.nodes.forEach(item => this.remember(item));
    else if (entry.kind === 'node') this.last.set(entry.target, entry);
  }
  async process(single = false) {
    let entry;
    if ($('backend').value !== 'webgpu') entry = this.engine.step();
    else entry = single || !$('skip').checked ? await this.engine.stepAsync(input => this.gpu.compute(input))
      : await this.engine.runBatchAsync(inputs => this.gpu.computeBatch(inputs), { maxTasks: APP_CONFIG.engine.gpuBatch, maxEventUnits: APP_CONFIG.engine.frameUnits });
    this.remember(entry);
    if (entry && (single || !$('skip').checked)) { this.view.update(this.engine, this.selected); this.view.onUnit(entry, { force: single }); }
    return entry;
  }
  play() {
    if (this.running) { this.pause(); this.render(); return; }
    this.running = true; this.generation++; this.runStart = this.engine.units; this.render(); this.schedule();
  }
  schedule() {
    if (!this.running || !this.active || this.timer !== null || this.inFlight) return;
    const generation = this.generation;
    const delay = $('skip').checked ? 0 : APP_CONFIG.playback.duration * 1000 / Number($('speed').value);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (!this.running || generation !== this.generation) return;
      const work = this.tick(generation); this.inFlight = work;
      work.finally(() => { if (this.inFlight === work) this.inFlight = null; this.schedule(); });
    }, delay);
  }
  async tick(generation) {
    try {
      const started = performance.now(); let count = 0;
      do {
        if (this.engine.idle) { this.pause(); break; }
        await this.process(); count++;
        if (this.engine.units - this.runStart >= APP_CONFIG.engine.maxUnits) { this.pause(); this.message('达到本次处理预算，队列已保留。'); break; }
      } while (this.running && generation === this.generation && $('skip').checked && count < APP_CONFIG.engine.frameUnits && performance.now() - started < APP_CONFIG.engine.frameBudgetMs * Number($('speed').value));
      this.render();
    } catch (error) { this.pause(); this.message(error.message, true); this.render(); }
  }
  render() {
    if (!this.engine) return;
    this.playbackSettings();
    const { model, engine } = this;
    const operations = [...model.jki.values()].reduce((sum, node) => sum + (node.sources?.ex?.length || 0), 0);
    const edges = [...model.triggerRefs.values(), ...model.sourceRefs.values()].reduce((sum, refs) => sum + refs.length, 0) + this.bindings.observe.read.length;
    for (const [id, value] of Object.entries({ 'stat-nodes': model.jki.size, 'stat-state': model.jki.size, 'stat-edges': edges, 'stat-ex': operations, total: engine.stats.nodeTasks, total2: engine.stats.nodeTasks, 'event-total': engine.units, EXtotal: engine.stats.operations, 'queue-count': engine.pending })) $(id).textContent = value;
    $('run-status').textContent = this.running ? '运行中' : engine.idle ? '就绪' : '已暂停';
    $('footer-state').textContent = `${this.bindings.inputs.length} 输入位 / ${model.jki.size} JKI / ${this.bindings.observe.read.length} 输出位 · ${$('backend').value === 'webgpu' && this.gpu.device ? 'WebGPU EX' : 'JavaScript'}`;
    const latest = engine.outputs.at(-1), values = new Map();
    this.bindings.observe.read.forEach((path, index) => {
      const bit = latest?.values[index], cell = this.outputCells.get(index);
      if (bit !== undefined) values.set(path, bit);
      cell.value.textContent = bit ?? '未输出'; cell.value.classList.toggle('empty', bit === undefined);
      cell.publication.textContent = latest ? `第 ${engine.outputs.length} 次输出` : '尚未输出';
    });
    $('output-status').textContent = `${engine.outputs.length} 次输出 · watch 通知到达时读取`;
    $('queue-rows').replaceChildren();
    const items = [...engine.events, ...engine.tasks].slice(0, APP_CONFIG.view.queueRows);
    for (const item of items) {
      const row = template('queue-row-template'), path = item.source || item.node || item.tx;
      row.querySelector('em').textContent = item.source ? 'EV' : item.tx ? 'TX' : 'EX';
      row.querySelector('[data-node-name]').textContent = path;
      row.querySelector('.values').textContent = item.to ? `→ ${item.to.length}` : item.prereqs ? `${item.prereqs.length} 前置` : '待处理';
      row.title = pretty(item); row.querySelector('button').addEventListener('click', () => this.select(path));
      $('queue-rows').append(row);
    }
    $('queue-empty').hidden = engine.pending > 0;
    $('history').replaceChildren();
    for (const entry of engine.history.slice(-APP_CONFIG.view.traceRows).reverse()) {
      const row = template('history-row-template'); row.querySelector('span').textContent = `${entry.kind.toUpperCase()} ${entry.target}`;
      row.querySelector('b').textContent = entry.kind === 'node' ? `${entry.qBefore} → ${entry.result}` : entry.kind === 'transaction' ? `${entry.nodes.length} 次求值` : '已投递'; $('history').append(row);
    }
    this.view.update(engine, this.selected); this.outputUI.update(values); this.renderInspector();
  }
  renderInspector() {
    const selected = this.selected;
    for (const panel of $('inspector').querySelectorAll('[data-inspector-panel]')) panel.hidden = true;
    this.panel.querySelector('.inspector').classList.toggle('has-selection', selected !== null);
    $('selected-id').textContent = selected ?? '—';
    if (selected?.startsWith('lamp:')) {
      const index = Number(selected.slice(5)), pixel = this.display.pixels[index];
      $('inspector-lamp').hidden = false; $('inspector-lamp-missing').hidden = Boolean(pixel);
      $('inspector-lamp-readout').hidden = $('inspector-lamp-edit').hidden = !pixel;
      if (pixel) $('inspector-lamp-readout').textContent = lampDetails(pixel, this.view.outputState.results[index]);
      return;
    }
    if (selected?.startsWith('observe:')) {
      const path = selected.slice(8), index = this.bindings.observe.read.indexOf(path), latest = this.engine.outputs.at(-1);
      $('inspector-output').hidden = false; $('inspector-output-source').textContent = `观察来源 ${path}`;
      $('inspector-output-value').textContent = latest?.values[index] ?? '尚未输出';
      $('inspector-output-publication').textContent = `收到 watch 通知时读取 · 共 ${this.engine.outputs.length} 次`;
      return;
    }
    const node = this.model?.jki.get(selected);
    if (!node) { $('inspector-empty').hidden = false; return; }
    $('inspector-jk').hidden = false; $('inspector-fixed-id').textContent = selected;
    $('inspector-expression').textContent = node.sources?.ex?.join(' → ') || '空 EX';
    $('inspector-node-errors').hidden = true; $('inspector-jk-state').hidden = $('inspector-jk-events').hidden = false;
    $('inspector-count').textContent = this.view.counts.get(selected) || 0;
    $('inspector-q').textContent = this.engine.q[selected]; $('inspector-initial').textContent = node.q;
    $('inspector-type').textContent = 'JKI';
    $('inspector-state-rule').textContent = `EX 入口读取来源 q；seed 为 ${node.sources?.seed ?? 'q_before'}。`;
    $('inspector-propagation').textContent = Object.keys(node.publish || {})[0] || 'always';
    $('inspector-latest').textContent = this.last.get(selected)?.result ?? '尚未求值';
    $('inspector-waiting').textContent = `trigger ${JSON.stringify(node.trigger)}${this.engine.triggerAll[selected] ? ' · 到达 ' + JSON.stringify(this.engine.triggerAll[selected]) : ''}`;
    const last = this.last.get(selected);
    $('inspector-publication').textContent = last ? last.published ? '最近求值已发布通知；通知不携带值。' : '最近求值未发布通知。' : '初始化不发布通知。';
    $('inspector-evaluation').hidden = !last;
    if (last) {
      $('inspector-evaluation-title').textContent = '最近求值 · 实际读取参数';
      $('inspector-reads').textContent = pretty(last.values); $('inspector-operations').replaceChildren();
      let value = last.seed ?? last.qBefore;
      last.ops.forEach((op, index) => {
        const before = value; value = op === 'J' ? value & last.values[index] : value ^ last.values[index];
        const row = template('evaluation-step-template'); row.textContent = `${op}: ${before} ${op === 'J' ? 'AND' : 'XOR'} ${last.values[index]} → ${value}`; $('inspector-operations').append(row);
      });
    }
  }
  dispose() {
    this.configFileVersion++; this.pause(); this.imageUI.dispose(); this.outputUI.dispose(); this.manager.dispose(); this.gpu.dispose(); this.view.dispose();
    this.listeners.forEach(remove => remove()); this.listeners = [];
  }
}
