import './style.css';
import './cosmic.css';
import { APP_CONFIG } from './config.js';
import seedPool from './example.json';
import { compileModel, validateRunScript, validateSnapshot } from '../src/jk/model-schema.js';
import { JKEngine } from '../src/jk/engine.js';
import { GPUCompute } from '../src/jk/gpu-compute.js';
import { parseModelPool } from '../src/jk/model-pool.js';
import { pixelsToBatches } from '../src/ui/image-input.js';
import { NetworkView } from '../src/scene/network-view.js';
import { setupSceneFullscreen } from '../src/scene/fullscreen.js';
import { NodeTree } from '../src/ui/node-tree.js';
import { CosmicWorkspace } from '../src/ui/cosmic-workspace.js';
import { NetworkStylePanel } from '../src/ui/network-style-panel.js';
import { syncSceneControlButtons, initializeConfiguredBackend } from '../src/ui/workspace-settings.js';
import { modelDefaults } from '../src/ui/model-defaults.js';

const $ = id => document.getElementById(id);
const jkmPanel = $('jkm-panel');
$('app').dataset.workspace = APP_CONFIG.workspace.active;
for (const [name, value] of Object.entries({ 'rail-bg': APP_CONFIG.desktop.theme.rail, fg: APP_CONFIG.desktop.theme.foreground })) {
  jkmPanel.style.setProperty(`--cosmic-${name}`, value);
}
jkmPanel.style.setProperty('--cosmic-scene-background-edge', APP_CONFIG.scene.appearance.backgroundEdge);
const nodeInspector = $('node-inspector');
for (const section of nodeInspector.querySelectorAll('[data-inspector-section]')) {
  section.open = APP_CONFIG.view.inspector.sections[section.dataset.inspectorSection];
}
$('events-records').open = APP_CONFIG.view.queues.events.records.expanded;
$('jkm-metadata-details').open = APP_CONFIG.view.disclosures.jkm.metadata;
syncSceneControlButtons({ labels: $('node-labels'), background: $('black-background') }, APP_CONFIG.scene);
const clone = id => $(id).content.firstElementChild.cloneNode(true);
const pretty = value => JSON.stringify(value, null, 2);
const builtins = seedPool.permanent.map(entry => entry.model);
let model, engine, selected, modelPath, running = false, inFlight = null, timer = null;
let schedulerVersion = 0, imageLoadVersion = 0, poolPending = false;
let disposed = false;
const fileVersions = new Map();
let runStart = 0, scriptBatches = null, nextBatch = 0, pool = null, authCommand = null, imageBitmap = null;
let observation = structuredClone(APP_CONFIG.model.defaults.observe);
const nodeTree = new NodeTree({
  element: $('node-tree'),
  groupTemplate: $('node-tree-group-template'),
  nodeTemplate: $('node-tree-node-template'),
  tagTemplate: $('node-purpose-tag-template'),
  onSelect: selectNode,
  expandedDepth: APP_CONFIG.view.inspector.tree.expandedDepth,
});
const gpu = new GPUCompute((text, ready) => {
  if (disposed) return;
  $('compute-message').textContent = text;
  $('compute-status').textContent = ready && $('backend').value === 'webgpu' ? 'WebGPU EX' : 'JavaScript';
});
const view = new NetworkView({
  container: $('viewport'), onSelect: selectNode,
  onStatus: status => { $('render-status').textContent = status.label; $('render-status').title = status.reason || status.label; $('gpu-message').hidden = status.backend !== 'error'; $('gpu-detail').textContent = status.reason || ''; },
  onLayout: layout => {
    if (layout.pending) { $('layout-status').textContent = '正在排列…'; return; }
    if (layout.error) { $('layout-status').textContent = `布局失败：${layout.error}`; return; }
    const mode = typeof layout === 'string' ? layout : layout.mode;
    $('layout-status').textContent = typeof layout === 'string' ? `${layout} 布局` : (layout.label || `${mode} 布局`);
  },
});
const desktop = new CosmicWorkspace({
  root: jkmPanel, config: APP_CONFIG.desktop,
  onAppearanceChange: (key, appearance) => {
    if (key !== 'scene') return;
    const result = view.applyAppearance(appearance);
    if (result?.blackBackgroundChanged) $('black-background').setAttribute('aria-pressed', 'false');
  },
  onCommand: command => {
    if (command === 'rgb') switchWorkspace('rgb').catch(error => message(error.message, true));
  },
});
jkmPanel.addEventListener('network-style-error', event => message(event.detail.message, true));
const networkStylePanel = new NetworkStylePanel({
  root: jkmPanel, config: APP_CONFIG.scene.styles,
  onChange: styles => view.setNetworkStyles(styles),
});
jkmPanel.addEventListener('cosmic-workspace-error', event => message(event.detail.message, true));
jkmPanel.addEventListener('cosmic-window-show', event => {
  if (!model) return;
  const key = event.detail.key;
  if (key === 'snapshot' && !$('snapshot-json').value.trim()) boundary(() => { $('snapshot-json').value = pretty(engine.snapshot(APP_CONFIG.model.snapshotName)); $('snapshot-error').textContent = ''; }).catch(error => message(error.message, true));
});
function updatePlayback() {
  const speed = Number($('speed').value), skip = $('skip').checked;
  view.setPlayback({ running, speed, skip });
  $('speed-label').textContent = skip ? '计算速度' : '动画速度';
  $('speed-budget').textContent = skip ? `每帧预算 ${APP_CONFIG.engine.frameBudgetMs * speed} ms` : `每单元 ${(APP_CONFIG.playback.duration / speed).toFixed(2)} 秒`;
}
function interval() { return $('skip').checked ? 0 : APP_CONFIG.playback.duration * 1000 / Number($('speed').value); }


function message(text, error = false) { $('message').textContent = text; $('message').classList.toggle('error', error); }
function options(element, items, selectedValue) {
  element.replaceChildren();
  items.forEach(([value, label]) => { const option = clone('option-template'); option.value = value; option.textContent = label; element.append(option); });
  if (selectedValue !== undefined) element.value = selectedValue;
}
function show(id) { if ($(id).matches('[data-cosmic-window]')) desktop.show(id); else $(id).showModal(); }
function close(id) { if ($(id).matches('[data-cosmic-window]')) desktop.hide(id); else $(id).close(); }
function download(name, value, type = 'application/json') {
  const url = URL.createObjectURL(new Blob([typeof value === 'string' ? value : pretty(value)], { type }));
  const link = clone('download-template'); link.href = url; link.download = name.replace(/[\\/:*?"<>|]/g, '_');
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}
async function readFile(file) {
  if (!file) return null;
  if (file.size > APP_CONFIG.view.fileBytes) throw new Error('文件超过 32 MiB 限制');
  return JSON.parse(await file.text());
}
function pause() { running = false; schedulerVersion++; clearTimeout(timer); timer = null; $('play').textContent = '▶ 播放'; updatePlayback(); }
async function boundary(action) { pause(); if (inFlight) await inFlight; return action(); }
function action(id, fn, errorId) {
  $(id).addEventListener('click', async () => {
    if (errorId) $(errorId).textContent = '';
    try { await fn(); } catch (error) { if (errorId) $(errorId).textContent = error.message; message(error.message, true); }
  });
}
function selectNode(path) {
  if (path !== null && !model?.jki.has(path)) return;
  selected = path; nodeTree.select(path); renderInspector(); view.update(engine, selected);
}
function setText(id, text) { const element = $(id); if (element) element.textContent = text; }
function currentScript(batches = [JSON.parse($('input-json').value)]) {
  return { run: APP_CONFIG.model.runName, model: modelPath, observe: structuredClone(observation), batches };
}
function loadModel(raw, path, builtin = false) {
  const compiled = compileModel(raw);
  const defaults = modelDefaults(compiled, { builtin });
  const observe = defaults.observe;
  const next = new JKEngine(compiled, { observe, historyLimit: APP_CONFIG.view.traceRows });
  // Replace only after the model and execution capability have both been checked.
  model = compiled; engine = next; observation = observe; modelPath = path || defaults.path;
  scriptBatches = null; nextBatch = 0; selected = null;
  $('model-name').textContent = raw.jkm;
  $('model-md5').textContent = `JKRD ${raw.version}`;
  $('cosmic-model-name').textContent = raw.jkm;
  $('cosmic-model-name').title = raw.jkm;
  $('cosmic-model-md5').textContent = raw.version;
  $('model-summary').textContent = `${raw.version} · ${model.jki.size} JKI / ${model.jks.size} JKS`;
  $('metadata').textContent = pretty(raw.pro || {});
  $('events-queue-name').textContent = engine.queue;
  $('tasks-queue-name').textContent = engine.queue;
  $('model-json').value = pretty(model.raw); $('model-path').value = modelPath;
  $('input-json').value = pretty(defaults.input);
  $('script-json').value = pretty(currentScript());
  $('watch-json').value = pretty(observation.watch); $('read-json').value = pretty(observation.read);
  $('snapshot-json').value = '';
  $('input-buttons').replaceChildren();
  for (const path of model.inputs) {
    const button = clone('input-template');
    const node = model.jki.get(path); const tag = node.pro?.tag?.filter(value => value !== 'pre').join(' ');
    button.querySelector('strong').textContent = tag || node.id;
    button.querySelector('span').textContent = path;
    button.title = `注入 ${path}`;
    button.addEventListener('click', () => boundary(() => { engine.inject(path); scriptBatches = null; render(); message(`已注入 ${path}；点击运行或单步处理。`); }).catch(error => message(error.message, true)));
    $('input-buttons').append(button);
  }
  nodeTree.setModel(model, selected);
  for (const id of ['image-zero', 'image-one']) options($(id), model.inputs.map(path => [path, path]));
  for (const [id, index] of [['image-zero', APP_CONFIG.image.inputMapping.zeroIndex], ['image-one', APP_CONFIG.image.inputMapping.oneIndex]]) {
    $(id).value = model.inputs[Math.min(index, model.inputs.length - 1)] ?? '';
  }
  networkStylePanel.setModel(model);
  view.setModel(model); render();
  message(`已加载 ${raw.jkm} · JKRD7 定义校验通过。`);
}
function renderInspector() {
  const node = model?.jki.get(selected);
  nodeTree.select(selected);
  $('selected-id').textContent = selected || '—';
  nodeInspector.classList.toggle('has-selection', Boolean(node));
  jkmPanel.querySelector('[data-cosmic-window="inspector"]').classList.toggle('has-selection', Boolean(node));
  $('node-q').textContent = node ? engine.q[selected] : '—';
  $('node-q').dataset.value = node ? engine.q[selected] : '';
  $('node-empty').hidden = Boolean(node); $('node-sections').hidden = !node;
  if (!node) return;
  $('node-initial').textContent = node.q;
  const tags = node.pro?.tag ?? [], tagKey = JSON.stringify(tags), tagContainer = $('node-tags');
  if (tagContainer.dataset.tags !== tagKey) {
    tagContainer.replaceChildren();
    for (const text of tags) {
      const tag = clone('node-purpose-tag-template'); tag.textContent = text; tagContainer.append(tag);
    }
    if (!tags.length) tagContainer.textContent = '未设置';
    tagContainer.dataset.tags = tagKey;
  }
  $('node-trigger-mode').textContent = node.trigger.all ? 'all · 全部来源到达' : 'any · 任一来源到达';
  $('node-trigger').textContent = model.triggerRefs.get(selected).join('\n') || '外部输入入口';
  const registration = model.regOf.get(selected);
  $('node-registration').textContent = registration ? `${registration.group} / ${registration.type}` : '未登记';
  const operations = node.sources?.ex ?? [], hasEX = operations.length > 0;
  $('node-ex-count').textContent = hasEX ? `${operations.length} 步` : '空 EX';
  $('node-ex-empty').hidden = hasEX; $('node-ex-fields').hidden = !hasEX;
  $('node-seed').textContent = hasEX ? node.sources.seed === undefined ? 'q_before · 执行入口的当前 q' : `固定 seed = ${node.sources.seed}` : '—';
  $('node-ex').textContent = hasEX ? operations.join(' → ') : '—';
  $('node-sources').textContent = hasEX ? model.sourceRefs.get(selected).map((path, index) => `${index + 1}. ${operations[index]} ← ${path}`).join('\n') : '—';
  $('node-publish').textContent = Object.keys(node.publish || {})[0] || 'always';
  $('node-arrivals').hidden = !node.trigger.all;
  $('node-all').textContent = node.trigger.all ? JSON.stringify(engine.triggerAll[selected]) : '—';
  $('node-json').textContent = pretty(node);
}
function queueRows(id, items) {
  $(id).replaceChildren();
  for (const item of items) {
    const row = clone('queue-row-template');
    const target = item.source || item.node || item.tx;
    row.querySelector('[data-kind]').textContent = item.source ? 'EV' : item.tx ? 'TX' : 'EX';
    row.querySelector('[data-target]').textContent = target;
    row.querySelector('[data-detail]').textContent = item.to ? `→ ${item.to.length}` : item.prereqs ? `${item.prereqs.length} 前置` : '待处理';
    row.title = JSON.stringify(item);
    row.querySelector('button').addEventListener('click', () => selectNode(target));
    $(id).append(row);
  }
}
function renderQueue(kind, items) {
  const limit = APP_CONFIG.view.queues.rows;
  $(`${kind}-count`).textContent = items.length;
  $(`${kind}-empty`).hidden = items.length > 0;
  queueRows(`${kind}-list`, items.slice(0, limit));
  const notice = $(`${kind}-limit`);
  notice.hidden = items.length <= limit;
  notice.textContent = notice.hidden ? '' : `显示前 ${limit} 项，全部 ${items.length} 项仍保留在队列中。`;
}
function historyRows(records) {
  $('trace-list').replaceChildren();
  for (const record of records) {
    const row = clone('history-row-template'), kind = Object.keys(record)[0];
    row.querySelector('[data-kind]').textContent = kind.toUpperCase();
    row.querySelector('[data-detail]').textContent = kind === 'q' ? `${record.q} · ${record.from ?? '∅'} → ${record.to}`
      : kind === 'output' ? `${record.output} · ${record.values.join('')}` : record[kind];
    row.title = JSON.stringify(record); $('trace-list').append(row);
  }
}
function renderOutput() {
  const latest = engine.outputs.at(-1);
  $('output-rows').replaceChildren();
  for (const [index, path] of observation.read.entries()) {
    const row = clone('output-row-template'); row.querySelector('[data-output-id]').textContent = `b${index}`;
    row.querySelector('.source').textContent = path;
    row.querySelector('.output-value').textContent = latest?.values[index] ?? '—';
    row.querySelector('.output-value').classList.toggle('on', latest?.values[index] === 1);
    row.querySelector('.output-publication').textContent = latest ? '已输出' : '待通知';
    $('output-rows').append(row);
  }
  $('outputs-empty').hidden = observation.read.length > 0;
  setText('output-status', latest ? `${engine.outputs.length} 次输出 · ${latest.source}` : 'watch 通知触发读取 · 尚未输出');
  $('output-bits').replaceChildren();
  for (const bit of latest?.values || []) { const item = clone('bit-template'); item.textContent = bit; item.classList.toggle('one', bit === 1); $('output-bits').append(item); }
  if (latest?.values.length) {
    const number = BigInt(`0b${latest.values.join('')}`);
    $('output-character').textContent = latest.values.length === 8 && number >= 32n && number <= 126n ? String.fromCharCode(Number(number)) : '·';
    $('output-number').textContent = `0x${number.toString(16).toUpperCase()} / ${number.toString()}`;
  } else { $('output-character').textContent = '—'; $('output-number').textContent = '等待通知'; }
  $('observe-summary').textContent = observation.watch.length ? `watch: ${observation.watch.join(', ')} · ${engine.outputs.length} 条输出` : '未配置输出订阅';
  const canvas = $('output-board'), ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const outputs = engine.outputs.slice(-APP_CONFIG.view.outputRows);
  const cols = Math.max(1, observation.read.length), cell = Math.min(APP_CONFIG.view.board.cellSize, canvas.width / cols), visible = Math.floor(canvas.height / cell);
  outputs.slice(-visible).forEach((output, y) => output.values.forEach((bit, x) => { ctx.fillStyle = bit ? APP_CONFIG.view.board.one : APP_CONFIG.view.board.zero; ctx.fillRect(x * cell + 1, y * cell + 1, Math.max(1, cell - 2), Math.max(1, cell - 2)); }));
}
function render() {
  if (!engine) return;
  $('play').textContent = running ? 'Ⅱ 暂停' : '▶ 播放';
  updatePlayback();
  $('run-state').textContent = engine.busy ? '处理中' : running ? '运行中' : engine.idle ? '静止' : '已暂停';
  $('run-status').classList.toggle('running', running);
  $('compute-status').textContent = $('backend').value === 'webgpu' && gpu.device ? 'WebGPU EX' : 'JavaScript';
  const edgeCount = [...model.triggerRefs.values()].reduce((sum, list) => sum + list.length, 0) + [...model.sourceRefs.values()].reduce((sum, list) => sum + list.length, 0);
  const operationCount = [...model.jki.values()].reduce((sum, node) => sum + (node.sources?.ex?.length || 0), 0);
  const stateCount = Object.values(engine.q).filter(value => value !== null).length;
  for (const [id, value] of Object.entries({ 'stat-nodes': model.jki.size, 'stat-edges': edgeCount, 'stat-state': stateCount, 'stat-ex': operationCount, 'stat-groups': model.jks.size, 'stat-units': engine.units, 'stat-events': engine.events.length, 'stat-tasks': engine.tasks.length, 'stat-gpu': gpu.stats.dispatches })) setText(id, value);
  for (const id of ['total', 'total2']) $(id).textContent = engine.stats.nodeTasks;
  $('event-total').textContent = engine.stats.nodeTasks + engine.stats.transactions;
  $('EXtotal').textContent = engine.stats.operations;
  renderQueue('events', engine.events);
  renderQueue('tasks', engine.tasks);
  const trace = engine.trace.slice(-APP_CONFIG.view.traceRows);
  historyRows(trace);
  $('trace-limit').textContent = `显示最近 ${trace.length} / ${engine.trace.length} 条；下载保留完整记录。`;
  $('rounds-json').textContent = pretty({ trigger_all: engine.triggerAll, rounds: engine.rounds });
  renderInspector(); renderOutput(); view.update(engine, selected);
}
async function processUnit(single = false) {
  let result;
  if ($('backend').value === 'webgpu') await backendReady;
  if ($('backend').value !== 'webgpu') result = engine.step();
  else result = single || !$('skip').checked ? await engine.stepAsync(input => gpu.compute(input)) : await engine.runBatchAsync(inputs => gpu.computeBatch(inputs), { maxTasks: APP_CONFIG.engine.gpuBatch, maxEventUnits: APP_CONFIG.engine.frameUnits });
  if (result && (single || !$('skip').checked)) { view.update(engine, selected); view.onUnit(result, { force: single }); }
  return result;
}
function advanceScript() {
  if (engine.idle && scriptBatches && nextBatch < scriptBatches.length) { engine.injectBatch(scriptBatches[nextBatch++]); return true; }
  return false;
}
async function tick(generation) {
  if (!running || generation !== schedulerVersion) return;
  try {
    const started = performance.now(); let count = 0;
    do {
      while (engine.idle && advanceScript()) { if (!engine.idle) break; }
      if (engine.idle) { pause(); message(scriptBatches ? `运行脚本完成 · ${nextBatch} 批 · ${engine.outputs.length} 条输出。` : '队列已静止。'); break; }
      await processUnit(); count++;
      if (engine.units - runStart >= APP_CONFIG.engine.maxUnits) { pause(); message('已达到本次处理预算，队列完整保留；可继续运行或保存现场。'); break; }
    } while (running && generation === schedulerVersion && $('skip').checked && count < APP_CONFIG.engine.frameUnits && performance.now() - started < APP_CONFIG.engine.frameBudgetMs * Number($('speed').value));
    render();
  } catch (error) { pause(); message(error.message, true); render(); }
}
function schedule() {
  if (!running || timer !== null || inFlight) return;
  const generation = schedulerVersion;
  timer = setTimeout(() => {
    timer = null;
    if (!running || generation !== schedulerVersion || inFlight) return;
    const work = tick(generation);
    inFlight = work;
    work.finally(() => {
      if (inFlight === work) inFlight = null;
      if (running) schedule();
    });
  }, interval());
}
function play() {
  if (running) { pause(); render(); return; }
  running = true; schedulerVersion++; runStart = engine.units; render(); schedule();
}

for (const button of document.querySelectorAll('[data-close]')) button.addEventListener('click', () => close(button.dataset.close));
options($('example-select'), builtins.map(item => [item.jkm, item.jkm]), APP_CONFIG.model.example);
for (const [id, limits] of [['speed', APP_CONFIG.playback.speed], ['image-pixels', APP_CONFIG.image.limits.pixels], ['image-threshold', APP_CONFIG.image.limits.threshold]]) {
  for (const key of ['min', 'max', 'step']) $(id)[key] = limits[key];
}
for (const [id, size] of [['output-board', APP_CONFIG.view.board], ['image-preview', APP_CONFIG.image.preview]]) { $(id).width = size.width; $(id).height = size.height; }
$('backend').value = APP_CONFIG.engine.backend;
let backendReady = initializeConfiguredBackend(gpu, APP_CONFIG.engine.backend, () => disposed);
$('speed').value = APP_CONFIG.playback.speed.value; $('speed-value').textContent = `${$('speed').value}×`;
$('skip').checked = APP_CONFIG.playback.skip;
updatePlayback();
for (const button of jkmPanel.querySelectorAll('[data-layout]')) {
  button.classList.toggle('active', button.dataset.layout === APP_CONFIG.scene.layout);
  button.setAttribute('aria-pressed', String(button.dataset.layout === APP_CONFIG.scene.layout));
  button.addEventListener('click', () => {
    view.setLayout(button.dataset.layout);
    for (const item of jkmPanel.querySelectorAll('[data-layout]')) { item.classList.toggle('active', item === button); item.setAttribute('aria-pressed', String(item === button)); }
  });
}
$('image-threshold').value = APP_CONFIG.image.threshold; $('image-pixels').value = APP_CONFIG.image.maxPixels;
$('speed').addEventListener('input', () => { $('speed-value').textContent = `${$('speed').value}×`; updatePlayback(); });
$('skip').addEventListener('change', updatePlayback);
$('example-select').addEventListener('change', () => boundary(() => {
  const raw = builtins.find(item => item.jkm === $('example-select').value);
  loadModel(raw, undefined, true);
}).catch(error => message(error.message, true)));
$('backend').addEventListener('change', () => boundary(async () => {
  if ($('backend').value === 'webgpu') {
    backendReady = initializeConfiguredBackend(gpu, $('backend').value, () => disposed);
    await backendReady;
  }
  else $('compute-message').textContent = 'JavaScript 串行计算；事件优先。';
  render();
}).catch(error => message(error.message, true)));
action('gpu-retry', () => view.recover());
action('camera-reset', () => view.fit());
action('node-labels', () => { const hidden = $('node-labels').getAttribute('aria-pressed') !== 'true'; $('node-labels').setAttribute('aria-pressed', String(hidden)); $('node-labels').textContent = hidden ? '显示名称和次数' : '隐藏名称和次数'; view.setLabels(!hidden); });
action('black-background', () => { const black = $('black-background').getAttribute('aria-pressed') !== 'true'; $('black-background').setAttribute('aria-pressed', String(black)); view.setBlackBackground(black); });
const inspectorWindow = jkmPanel.querySelector('[data-cosmic-window="inspector"]');
inspectorWindow.classList.add('inspector');
nodeInspector.classList.remove('inspector');
const sceneWindow = jkmPanel.querySelector('[data-cosmic-window="scene"]');
// Dual-panel fullscreen shows the renderer. Single-panel fullscreen preserves
// the current desktop, including each window's visibility and collapsed state.
$('scene-fullscreen').addEventListener('click', () => {
  if ($('scene-fullscreen').getAttribute('aria-pressed') === 'true' || desktop.single) return;
  desktop.show('scene');
  if (sceneWindow.dataset.collapsed === 'true') desktop.collapse('scene');
});
const sceneFullscreenControl = setupSceneFullscreen(sceneWindow, $('scene-fullscreen'), undefined, [], {
  resolveTarget: () => desktop.single
    ? { element: jkmPanel.querySelector('.cosmic-scene-area'), className: 'cosmic-panel-fullscreen', label: `左侧${APP_CONFIG.desktop.display.modes.single.label}` }
    : { element: sceneWindow, className: 'scene-fullscreen', label: `${APP_CONFIG.desktop.display.modes.dual.label} 3D 场景` },
});
jkmPanel.addEventListener('cosmic-display-mode-change', () => sceneFullscreenControl.refresh());
action('play', () => play());
action('step', () => boundary(async () => { advanceScript(); inFlight = processUnit(true); try { await inFlight; } finally { inFlight = null; if (running) schedule(); } render(); message('已处理一个完整单元。'); }));
action('reset', () => boundary(() => { engine.reset(); scriptBatches = null; nextBatch = 0; render(); message('已恢复 JKM 初值。'); }));
action('send', () => boundary(() => { const count = engine.injectBatch(JSON.parse($('input-json').value)); scriptBatches = null; render(); message(`已注入 ${count} 条入口通知。`); }));
action('trace-download', () => boundary(() => download(`${model.name}.trace.jsonl`, engine.trace.map(record => JSON.stringify(record)).join('\n') + (engine.trace.length ? '\n' : ''), 'application/x-ndjson')));
action('import-btn', () => { $('model-json').value = pretty(model.raw); $('model-error').textContent = ''; show('models-dialog'); });
action('model-apply', () => boundary(() => { loadModel(JSON.parse($('model-json').value)); close('models-dialog'); }), 'model-error');
action('model-download', () => download(`${model.name}.jkm.json`, model.raw));
function jsonFileInput(id, apply, errorId) {
  $(id).addEventListener('change', async event => {
    const file = event.target.files[0];
    if (!file) return;
    const generation = (fileVersions.get(id) || 0) + 1;
    fileVersions.set(id, generation);
    try {
      const raw = await readFile(file);
      if (fileVersions.get(id) === generation) await apply(raw, file, () => fileVersions.get(id) === generation);
    } catch (error) { if (fileVersions.get(id) === generation) $(errorId).textContent = error.message; }
    finally { if (fileVersions.get(id) === generation) event.target.value = ''; }
  });
}
jsonFileInput('model-file', (raw, file, current) => boundary(() => { if (!current()) return; loadModel(raw, file.name); close('models-dialog'); }), 'model-error');

action('script-open', () => { $('script-error').textContent = ''; show('script-dialog'); });
$('model-path').addEventListener('change', () => { modelPath = $('model-path').value.trim(); });
jsonFileInput('script-file', raw => { validateRunScript(raw, model); $('script-json').value = pretty(raw); }, 'script-error');
action('script-download', () => { const script = validateRunScript(JSON.parse($('script-json').value), model); download(`${script.run}.run.json`, script); }, 'script-error');
action('script-run', () => boundary(() => {
  const script = validateRunScript(JSON.parse($('script-json').value), model);
  modelPath = $('model-path').value.trim();
  if (script.model !== modelPath) throw new Error('脚本 model 与当前 JKM 文件标识不一致；请先加载对应模型并核对标识。');
  const next = new JKEngine(model, { observe: script.observe, historyLimit: APP_CONFIG.view.traceRows });
  engine = next; observation = structuredClone(script.observe); scriptBatches = script.batches; nextBatch = 0;
  $('watch-json').value = pretty(observation.watch); $('read-json').value = pretty(observation.read);
  close('script-dialog'); message(`正在执行脚本 ${script.run} · ${script.batches.length} 批。`); play();
}), 'script-error');
action('snapshot-open', () => boundary(() => { $('snapshot-json').value = pretty(engine.snapshot(APP_CONFIG.model.snapshotName)); $('snapshot-error').textContent = ''; show('snapshot-dialog'); }));
action('snapshot-capture', () => boundary(() => { $('snapshot-json').value = pretty(engine.snapshot(APP_CONFIG.model.snapshotName)); }), 'snapshot-error');
action('snapshot-download', () => { const snapshot = validateSnapshot(JSON.parse($('snapshot-json').value), model); download(`${snapshot.snapshot}.snapshot.json`, snapshot); }, 'snapshot-error');
jsonFileInput('snapshot-file', raw => { validateSnapshot(raw, model); $('snapshot-json').value = pretty(raw); }, 'snapshot-error');
action('snapshot-restore', () => boundary(() => { engine.restore(JSON.parse($('snapshot-json').value)); scriptBatches = null; nextBatch = 0; render(); close('snapshot-dialog'); message('现场已恢复并暂停；观察历史从此处重新记录。'); }), 'snapshot-error');
action('observe-open', () => { $('watch-json').value = pretty(observation.watch); $('read-json').value = pretty(observation.read); $('observe-error').textContent = ''; show('observe-dialog'); });
action('observe-apply', () => boundary(() => { const observe = { watch: JSON.parse($('watch-json').value), read: JSON.parse($('read-json').value) }; const next = new JKEngine(model, { observe, historyLimit: APP_CONFIG.view.traceRows }); const script = validateRunScript({ ...currentScript(), observe }, model); engine = next; observation = observe; scriptBatches = null; $('script-json').value = pretty(script); render(); close('observe-dialog'); message('已更新观察配置，并恢复 JKM 初值。'); }), 'observe-error');

async function poolRequest(command, token) {
  if (poolPending) throw new Error('共享池操作正在进行，请稍后重试');
  poolPending = true;
  const controller = new AbortController(); const timeout = setTimeout(() => controller.abort(), APP_CONFIG.pool.timeoutMs);
  try {
    const headers = command ? { 'Content-Type': 'application/json' } : {};
    if (token) headers.Authorization = `Bearer ${token}`;
    const response = await fetch(import.meta.env.VITE_MODEL_POOL_API_URL || APP_CONFIG.pool.endpoint, { method: command ? 'POST' : 'GET', headers, ...(command ? { body: JSON.stringify(command) } : {}), cache: 'no-store', signal: controller.signal });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `模型池 HTTP ${response.status}`);
    pool = parseModelPool(data.pool); renderPool(data.selectedId); message('JKRD7 共享模型池已更新。'); return data;
  } catch (error) { $('pool-message').textContent = `共享操作未确认：${error.message}。可继续本地导入/下载；刷新核对后再操作。`; throw error; }
  finally { clearTimeout(timeout); poolPending = false; }
}
function renderPool(id) {
  options($('pool-select'), [['', '选择共享模型'], ...pool.permanent.map(entry => [entry.id, `永久 / ${entry.model.jkm}`]), ...pool.temporary.map(entry => [entry.id, `临时 / ${entry.model.jkm}`])], id || '');
  $('pool-message').textContent = `JKRD7 共享池 · revision ${pool.revision} · ${pool.permanent.length + pool.temporary.length} 个模型`;
}
function selectedEntry() { if (!pool) throw new Error('请先连接共享池'); const entry = [...pool.permanent, ...pool.temporary].find(item => item.id === $('pool-select').value); if (!entry) throw new Error('请先选择共享模型'); return entry; }
action('pool-refresh', () => poolRequest(), 'model-error');
action('pool-load', () => boundary(() => { loadModel(selectedEntry().model); close('models-dialog'); }), 'model-error');
action('pool-import', async () => { const definition = structuredClone(model.raw); if (!pool) await poolRequest(); await poolRequest({ action: 'import', revision: pool.revision, model: definition }); }, 'model-error');
function askAuth(command) { authCommand = command; $('pool-token').value = ''; $('auth-error').textContent = ''; $('auth-title').textContent = command.action === 'delete' ? '删除永久模型' : '转为永久模型'; show('auth-dialog'); }
action('pool-promote', () => { const entry = selectedEntry(); askAuth({ action: 'promote', revision: pool.revision, id: entry.id }); }, 'model-error');
action('pool-delete', async () => { const entry = selectedEntry(); const command = { action: 'delete', revision: pool.revision, id: entry.id }; if (pool.permanent.some(item => item.id === entry.id)) askAuth(command); else await poolRequest(command); }, 'model-error');
$('auth-dialog').addEventListener('close', () => { $('pool-token').value = ''; authCommand = null; });
$('auth-form').addEventListener('submit', async event => { event.preventDefault(); const command = authCommand, token = $('pool-token').value; $('pool-token').value = ''; try { await poolRequest(command, token); close('auth-dialog'); } catch (error) { $('auth-error').textContent = error.message; } });

action('image-input', () => { $('image-error').textContent = ''; show('image-dialog'); });
$('image-file').addEventListener('change', async event => { try { const file = event.target.files[0]; if (!file) return; const generation = ++imageLoadVersion; if (file.size > APP_CONFIG.view.fileBytes) throw new Error('图片文件超过限制'); const bitmap = await createImageBitmap(file); if (generation !== imageLoadVersion) { bitmap.close(); return; } if (bitmap.width * bitmap.height > APP_CONFIG.image.limits.decodedPixels) { bitmap.close(); throw new Error('图片解码尺寸超过限制'); } imageBitmap?.close(); imageBitmap = bitmap; const canvas = $('image-preview'), ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); const scale = Math.min(canvas.width / imageBitmap.width, canvas.height / imageBitmap.height); ctx.drawImage(imageBitmap, 0, 0, imageBitmap.width * scale, imageBitmap.height * scale); } catch (error) { $('image-error').textContent = error.message; } finally { event.target.value = ''; } });
action('image-convert', () => {
  if (!imageBitmap) throw new Error('请先选择图片');
  const zero = $('image-zero').value, one = $('image-one').value;
  if (!model.inputs.includes(zero) || !model.inputs.includes(one) || zero === one) throw new Error('请选择两个不同的合法独热入口');
  const max = Number($('image-pixels').value), threshold = Number($('image-threshold').value);
  if (!Number.isInteger(max) || max < 1 || max > APP_CONFIG.image.limits.pixels.max || !Number.isInteger(threshold) || threshold < 0 || threshold > APP_CONFIG.image.limits.threshold.max) throw new Error('请检查像素上限与灰度阈值');
  const count = Math.min(max, imageBitmap.width * imageBitmap.height);
  const canvas = new OffscreenCanvas(Math.min(imageBitmap.width, count), Math.ceil(count / imageBitmap.width));
  const ctx = canvas.getContext('2d'); ctx.fillStyle = APP_CONFIG.image.background; ctx.fillRect(0, 0, canvas.width, canvas.height); ctx.drawImage(imageBitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
  const batches = pixelsToBatches(pixels, count, { zero, one, threshold });
  $('script-json').value = pretty(currentScript(batches)); close('image-dialog'); show('script-dialog');
}, 'image-error');

let rgbWorkspace = null, workspaceVersion = 0, activeWorkspace = APP_CONFIG.workspace.active;
async function switchWorkspace(mode) {
  const generation = ++workspaceVersion;
  if (mode === 'rgb') {
    await sceneFullscreenControl.exit();
    if (generation !== workspaceVersion) return;
    await boundary(() => {});
    if (generation !== workspaceVersion) return;
  } else if (rgbWorkspace) {
    await rgbWorkspace.setActive(false);
    if (generation !== workspaceVersion) return;
  }
  activeWorkspace = mode;
  $('app').dataset.workspace = mode;
  for (const key of ['rgb', 'jkm']) {
    const active = key === mode;
    $(`${key}-panel`).hidden = !active;
    $(`${key}-header-model`).hidden = !active;
    $(`${key}-tab`).setAttribute('aria-selected', String(active));
    $(`${key}-tab`).tabIndex = active ? 0 : -1;
  }
  $('import-btn').hidden = mode !== 'jkm'; $('rgb-import-btn').hidden = mode !== 'rgb';
  desktop.setActive(mode === 'jkm');
  view.setAnimationEnabled(mode === 'jkm');
  if (mode === 'rgb') {
    if (!rgbWorkspace) {
      const { RGBWorkspaceUI } = await import('../src/ui/rgb-workspace-ui.js');
      if (generation !== workspaceVersion) return;
      rgbWorkspace = new RGBWorkspaceUI();
    }
    await rgbWorkspace.ready;
    if (generation !== workspaceVersion) return;
    await rgbWorkspace.setActive(true);
  } else { view.resize(); render(); }
}
for (const mode of ['rgb', 'jkm']) {
  const tab = $(`${mode}-tab`);
  tab.addEventListener('click', () => switchWorkspace(mode).catch(error => {
    message(error.message, true); $('rgb-message').textContent = error.message;
  }));
  tab.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 'rgb' : event.key === 'End' ? 'jkm' : mode === 'rgb' ? 'jkm' : 'rgb';
    $(`${next}-tab`).focus(); $(`${next}-tab`).click();
  });
}

window.addEventListener('pagehide', () => { disposed = true; pause(); desktop.dispose(); nodeTree.dispose(); rgbWorkspace?.dispose(); view.dispose(); gpu.dispose(); imageBitmap?.close(); });
try {
  loadModel(builtins.find(item => item.jkm === APP_CONFIG.model.example), undefined, true);
  await Promise.all([view.ready, backendReady]);
  if (!disposed && activeWorkspace !== 'jkm') await switchWorkspace(activeWorkspace);
} catch (error) { if (!disposed) message(`初始化失败：${error.message}`, true); }
