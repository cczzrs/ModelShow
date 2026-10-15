import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../../html/config.js';
import { compileModel, JKEngine } from '../../src/jk/engine.js';
import { compileSnapshot, exportCurrentModel, serializeModel } from '../../src/jk/model-schema.js';
import { displayNodeId } from '../../src/jk/node-id.js';
import { defaultDisplay, evaluatePixel, loadDisplay } from '../../src/ui/output-display.js';
import { lampDetails } from '../../src/ui/output-display-ui.js';
import { Playback } from '../../src/ui/playback.js';
import { mainSource, sourceFunction, staticDocument, inspectorHarness } from '../helpers/ui-harness.js';

function updateHarness(model) {
  const document = staticDocument();
  const $ = id => document.getElementById(id);
  const clones = [];
  const cloneTemplate = id => {
    clones.push(id);
    return $(id).content.firstElementChild.cloneNode(true);
  };
  const state = {
    document, $, cloneTemplate, APP_CONFIG, model, displayNodeId,
    engine: new JKEngine(model),
    outputElements: new Map(model.outputs.map(output => [output.id, cloneTemplate('output-row-template').querySelector('.output-value')])),
    outputPublicationElements: new Map(model.outputs.map(output => [output.id, cloneTemplate('output-row-template').querySelector('.output-publication')])),
    playback: { running: true, active: null, visuals: [] },
    displayUI: { calls: [], update(values) { this.calls.push(values); } },
    view: { calls: [], refresh(engine) { this.calls.push(engine); } },
    message() {},
    renderInspector() {},
  };
  const functions = new Function('state', `
    with (state) {
      ${sourceFunction(mainSource, 'renderQueue')}
      ${sourceFunction(mainSource, 'update')}
      return { renderQueue, update };
    }
  `)(state);
  return { $, state, clones, ...functions };
}

test('the real virtual queue fills only viewport rows and retains its static spacer while scrolling', () => {
  const model = compileModel({
    nodes: [{ id: 'Q0', ex: 'J0K(X0)' }],
    initial_q: { 0: ['Q0'], 1: [] }, q_y: [{Y0:'Q0'}],
  });
  const { $, state, clones, renderQueue } = updateHarness(model);
  for (let index = 0; index < 1000; index++) state.engine.send({ X0: index % 2 });
  const host = $('queue');
  host.clientHeight = 180;
  host.scrollTop = 3600;
  const rows = $('queue-rows');
  const spacer = $('queue-spacer');
  const reads = [];
  const itemAt = state.engine.itemAt.bind(state.engine);
  state.engine.itemAt = index => { reads.push(index); return itemAt(index); };
  renderQueue();
  assert.equal(rows.children.length, 10, 'five visible rows plus the existing overscan');
  assert.deepEqual(reads, Array.from({ length: 10 }, (_, index) => index + 98));
  assert.equal(clones.filter(id => id === 'queue-row-template').length, 10);
  assert.equal(rows.children[0].querySelector('[data-node-name]').textContent, 'Q0');
  assert.equal(rows.children[0].querySelector('button').dataset.nodeKey, 'node-0');
  assert.equal(rows.children[0].querySelector('em').textContent, 'Xi.FIFO #99');
  assert.equal(rows.children[0].querySelector('.values').textContent, '{}');
  assert.match(rows.children[0].querySelector('.values').title, /任务锁存/);
  assert.equal(host.style.get('--queue-total-height'), '36000px');
  assert.equal(host.style.get('--queue-scroll-offset'), '3528px');
  assert.equal($('queue-empty').hidden, true);
  host.scrollTop = 999999;
  reads.length = 0;
  renderQueue();
  assert.equal(host.scrollTop, 35820);
  assert.deepEqual(reads, [993, 994, 995, 996, 997, 998, 999]);
  assert.equal($('queue-rows'), rows);
  assert.equal($('queue-spacer'), spacer);
  assert.equal(state.engine.length, 1000, 'scrolling does not execute the queue');
  assert.equal(state.engine.total, 0);
  assert.equal(state.engine.latest.get('X0'), 1, 'send updates readable Xi immediately');
});

test('the real update shows the latest 60 history entries and current output without rebuilding fixed panels', () => {
  const model = compileModel({ nodes: [{ id: 'Q0', ex: 'J0K(X0)' }], initial_q: { 0: ['Q0'], 1: [] }, q_y: [{ Y0: 'Q0' }] });
  const { $, state, update } = updateHarness(model);
  for (let index = 0; index < 45; index++) {
    state.engine.send({ X0: index % 2 });
    while (state.engine.length) state.engine.step();
  }
  const history = [...state.engine.history];
  const inspector = $('inspector');
  const queue = $('queue-rows');
  update();
  const rows = $('history').children;
  assert.equal(rows.length, 60);
  assert.match(rows[0].querySelector('span').textContent, /^Xi.FIFO #45 Q0$/);
  assert.ok(rows.some(row => /^求值 #45 Q0$/.test(row.querySelector('span').textContent)));
  assert.ok(rows.some(row => /→ 0 · 发布/.test(row.querySelector('b').textContent)));
  assert.ok(rows.some(row => row.querySelector('b').textContent === '已入队'));
  assert.equal(state.outputElements.get('Y0').textContent, '0');
  assert.equal(state.outputElements.get('Y0').classList.contains('empty'), false);
  assert.equal(state.outputPublicationElements.get('Y0').textContent, '最近发布 0');
  assert.equal($('output-status').textContent, 'Yi 按事件即时输出 · 队列排空不生成新输出');
  assert.equal($('total').textContent, '45');
  assert.equal($('event-total').textContent, '45');
  assert.equal($('queue-empty').hidden, false);
  assert.equal(state.displayUI.calls.length, 1);
  assert.equal(state.view.calls.length, 1);
  update();
  assert.equal($('inspector'), inspector);
  assert.equal($('queue-rows'), queue);
  assert.deepEqual(state.engine.history, history, 'presentation never consumes or reorders history');
});

test('the real inspector switches fixed panels, retains collapsed evaluation and shows applied lamp values', () => {
  const model = compileModel({ nodes: [{ id: 'Q0', ex: 'J0K(X0)' }], initial_q: { 0: ['Q0'], 1: [] }, q_y: [{ Y0: 'Q0' }] });
  const engine = new JKEngine(model);
  engine.send({ X0: 1 });
  engine.step();
  const board = defaultDisplay(1, 1);
  board.pixels[0].channels.r.value = 91;
  const view = { outputState: { config: board, results: [evaluatePixel(board.pixels[0], new Map(), new Map())] } };
  const { $, state, render } = inspectorHarness(model, engine, model.nodes[0].key, displayNodeId, { view, lampDetails });
  const panels = $('inspector').querySelectorAll('[data-inspector-panel]');
  render();
  assert.equal($('inspector-q').textContent, '1');
  assert.equal($('inspector-type').textContent, '有状态 Qi_q');
  assert.equal($('inspector-initial').textContent, '0');
  assert.equal($('inspector-propagation').textContent, 'q=0/1');
  assert.match($('inspector-publication').textContent, /已发布一次来源事件/);
  assert.equal($('inspector-evaluation').hidden, false);
  assert.equal($('inspector-operations').children.length, 2);
  assert.match($('inspector-operations').textContent, /K\(X0\).*XOR.*→ 1/);
  $('inspector-evaluation').open = false;
  render();
  assert.equal($('inspector-evaluation').open, false);
  for (const [selected, panel] of [[null, 'empty'], ['X0', 'input'], ['Y0', 'output'], ['lamp:0', 'lamp'], [model.nodes[0].key, 'jk']]) {
    state.selected = selected;
    render();
    assert.deepEqual($('inspector').querySelectorAll('[data-inspector-panel]'), panels);
    assert.deepEqual(panels.filter(item => !item.hidden).map(item => item.attributes.id), [`inspector-${panel}`]);
  }
  assert.equal($('inspector-input-value').textContent, '当前可读值：1');
  assert.equal($('inspector-output-value').textContent, '最近输出事件数据：1');
  assert.match($('inspector-output-publication').textContent, /最近发布：1/);
  assert.match($('inspector-lamp-readout').textContent, /亮度：91/);
  state.selected = 'lamp:0';
  view.outputState.config.pixels = [];
  render();
  assert.equal($('inspector-lamp-missing').hidden, false);
  assert.equal($('inspector-lamp-edit').hidden, true);
  assert.equal($('inspector-lamp-readout').hidden, true);
});

test('unpublished and zero Yi states are visibly distinct even when the queues empty', () => {
 const model=compileModel({nodes:[{id:'Q0',ex:'J0K(X0)',pro:'q=1'},{id:'Q1',ex:'J0K(Q0)K1'}],initial_q:{0:['Q0'],1:[]},q_y:[{Y0:'Q1'}]});
 const {$,state,update}=updateHarness(model);
 state.engine.send({X0:0});state.engine.step();update();
 assert.equal(state.outputElements.get('Y0').textContent,'未输出');
 assert.equal(state.outputPublicationElements.get('Y0').textContent,'尚未发布');
 const inspector=inspectorHarness(model,state.engine,model.nodes[0].key,displayNodeId);inspector.render();
 assert.match(inspector.$('inspector-publication').textContent,/已过滤事件/);
 state.engine.send({X0:1});while(state.engine.length)state.engine.step();update();
 assert.equal(state.outputElements.get('Y0').textContent,'0');assert.equal(state.outputElements.get('Y0').classList.contains('empty'),false);
 assert.match($('output-status').textContent,/按事件即时输出/);
});

test('a blocked model keeps its validation boundary visible and disables execution controls', () => {
  const model = compileModel({ nodes: [{ id: 'Q0', ex: 'J0K(X0)' }], initial_q: { 0: ['Q0'], 1: [] }, q_y: [] });
  const { $, update } = updateHarness(model);
  model.canExecute = false;
  update();
  for (const id of ['send', 'step', 'play']) assert.equal($(id).disabled, true);
  assert.equal($('run-status').textContent, '校验未通过');
  assert.equal($('output-status').textContent, '模型校验未通过 · 正式输出不可用');
});

function snapshotHarness() {
  const document = staticDocument();
  const $ = id => document.getElementById(id);
  const rendered = [], messages = [];
  const state = {
    document, $, APP_CONFIG, compileModel, JKEngine, Playback, displayNodeId,
    exportCurrentModel, loadDisplay,
    cloneTemplate: id => $(id).content.firstElementChild.cloneNode(true),
    model: null, engine: null, playback: null, selected: null, modelVersion: 0,
    outputElements: new Map(), outputPublicationElements: new Map(), pickerElements: new Map(),
    imageUI: {setModel() {}}, frameUpdates: {request() {}},
    updateSpeedControl() {}, select() {},
    displayUI: {
      config: defaultDisplay(),
      load(config, outputs, error) {
        this.config = structuredClone(config);
        this.outputs = outputs;
        this.error = error;
      },
    },
    view: {
      layoutMode: null,
      setModel() {}, syncOutputs() {},
      requestLayout(mode) { this.layoutMode = mode; },
      setOutputDisplay: config => rendered.push(structuredClone(config)),
    },
    message: (...args) => messages.push(args),
  };
  $('speed').value = APP_CONFIG.playback.speed.value;
  $('skip').checked = APP_CONFIG.playback.skipAnimation;
  const functions = new Function('state', `with(state) {
    ${sourceFunction(mainSource, 'install')}
    ${sourceFunction(mainSource, 'currentSnapshot')}
    return {install, currentSnapshot};
  }`)(state);
  return {state, rendered, messages, ...functions};
}

function boardSnapshot(outputBoard) {
  return serializeModel({
    nodes: [{id: 'Q0', ex: 'J0K(X0)'}],
    initial_q: {0: ['Q0'], 1: []}, q_y: [{Y0: 'Q0'}],
    display: {show: '3D', ...(outputBoard === undefined ? {} : {outputBoard})},
  });
}

test('install restores the snapshot board to the editor and scene without changing the saved configuration', () => {
  const h = snapshotHarness(), board = defaultDisplay(1, 2);
  board.enabled = true;
  board.pixels[0].channels.r.value = 91;
  const raw = boardSnapshot(board), original = structuredClone(raw);
  h.install(raw);
  assert.equal(h.state.model.canExecute, true);
  assert.deepEqual(h.state.displayUI.config, board);
  assert.deepEqual(h.rendered, [board]);
  assert.equal(h.state.view.layoutMode, '3D');
  assert.deepEqual(h.state.displayUI.outputs, h.state.model.outputs);
  assert.equal(h.state.displayUI.error, null);
  h.state.displayUI.config.pixels[0].channels.r.value = 172;
  h.install(raw);
  assert.equal(h.state.displayUI.config.pixels[0].channels.r.value, 91);
  assert.deepEqual(raw, original);
});

test('installing a snapshot without a board resets a previous board to the unified defaults', () => {
  const h = snapshotHarness(), board = defaultDisplay(1, 1);
  board.enabled = true;
  board.pixels[0].channels.r.value = 183;
  h.install(boardSnapshot(board));
  const raw = boardSnapshot();
  h.install(raw);
  assert.deepEqual(h.state.displayUI.config, defaultDisplay());
  assert.deepEqual(h.rendered.at(-1), defaultDisplay());
  assert.equal(h.state.view.layoutMode, '3D');
  assert.equal(h.state.displayUI.error, null);
  assert.equal(Object.hasOwn(raw.display, 'outputBoard'), false);
});

test('current snapshot export combines applied board, selected layout, live q and pending tasks into one loadable JSON', () => {
  const h = snapshotHarness(), raw = boardSnapshot(defaultDisplay(1, 1));
  const original = structuredClone(raw);
  h.install(raw);
  h.state.engine.send({X0: 1});
  h.state.engine.step();
  h.state.engine.send({X0: 0});
  h.state.displayUI.config.pixels[0].channels.r.value = 97;
  h.state.view.layoutMode = '2D';
  const snapshot = h.currentSnapshot();
  assert.equal(compileSnapshot(snapshot).canExecute, true);
  assert.deepEqual(snapshot.initial_q, {0: [], 1: ['Q0']});
  assert.deepEqual(snapshot.FIFOS, {'Xi.FIFO': [{Q0: {}}], 'Qi.FIFO': []});
  assert.equal(snapshot.display.show, '2D');
  assert.equal(snapshot.display.outputBoard.pixels[0].channels.r.value, 97);
  assert.deepEqual(raw, original, 'export does not rewrite the loaded source snapshot');
  h.state.displayUI.config.pixels[0].channels.r.value = 123;
  assert.equal(snapshot.display.outputBoard.pixels[0].channels.r.value, 97);
  const restored = snapshotHarness();
  restored.install(snapshot);
  assert.deepEqual(restored.state.displayUI.config, snapshot.display.outputBoard);
  assert.equal(restored.state.engine.q.get('Q0'), 1);
  assert.equal(restored.state.engine.length, 1);
  assert.equal(restored.state.playback.running, false);
});

test('exporting an uninstalled model draft retains its own board and state instead of borrowing the running model', () => {
  const h = snapshotHarness();
  h.install(boardSnapshot(defaultDisplay(1, 1)));
  h.state.engine.send({X0: 1});
  h.state.engine.step();
  h.state.engine.send({X0: 0});
  h.state.displayUI.config.pixels[0].channels.r.value = 211;
  h.state.view.layoutMode = '2D';
  const ownBoard = defaultDisplay(1, 2);
  ownBoard.pixels[0].channels.r.value = 43;
  for (const board of [ownBoard, undefined]) {
    const draft = boardSnapshot(board);
    draft.name = '未导入的模型草稿';
    const saved = h.currentSnapshot(draft);
    assert.equal(compileSnapshot(saved).canExecute, true);
    assert.deepEqual(saved.display, draft.display);
    assert.deepEqual(saved.initial_q, {0: ['Q0'], 1: []});
    assert.deepEqual(saved.FIFOS, {'Xi.FIFO': [], 'Qi.FIFO': []});
  }
  assert.equal(h.state.engine.q.get('Q0'), 1);
  assert.equal(h.state.engine.length, 1);
  assert.equal(h.state.displayUI.config.pixels[0].channels.r.value, 211);
});
