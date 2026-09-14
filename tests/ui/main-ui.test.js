import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../../src/config.js';
import { compileModel, JKEngine } from '../../src/core/engine.js';
import { displayNodeId } from '../../src/core/node-id.js';
import { defaultDisplay, evaluatePixel } from '../../src/output/output-display.js';
import { lampDetails } from '../../src/output/output-display-ui.js';
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
    nodes: Array.from({ length: 1000 }, (_, index) => ({ id: `Q${index}`, ex: 'J0K1' })),
    initial_q: { 0: [], 1: [] }, q_y: [],
  });
  const { $, state, clones, renderQueue } = updateHarness(model);
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
  assert.equal(rows.children[0].querySelector('[data-node-name]').textContent, 'Q98');
  assert.equal(rows.children[0].querySelector('button').dataset.nodeKey, model.nodes[98].key);
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
});

test('the real update shows the latest 60 history entries and current output without rebuilding fixed panels', () => {
  const model = compileModel({ nodes: [{ id: 'Q0', ex: 'J0K(X0)' }], initial_q: { 0: [], 1: [] }, q_y: [{ Y0: 'Q0' }] });
  const { $, state, update } = updateHarness(model);
  for (let index = 0; index < 45; index++) {
    state.engine.send({ X0: index % 2 });
    state.engine.step();
  }
  const history = [...state.engine.history];
  const inspector = $('inspector');
  const queue = $('queue-rows');
  update();
  const rows = $('history').children;
  assert.equal(rows.length, 60);
  assert.equal(rows[0].querySelector('span').textContent, '#45  Q0');
  assert.equal(rows[0].querySelector('b').textContent, '· → 0');
  assert.equal(rows[59].querySelector('span').textContent, '↗ X0');
  assert.equal(state.outputElements.get('Y0').textContent, '0');
  assert.equal(state.outputElements.get('Y0').classList.contains('empty'), false);
  assert.equal($('total').textContent, '45');
  assert.equal($('queue-empty').hidden, false);
  assert.equal(state.displayUI.calls.length, 1);
  assert.equal(state.view.calls.length, 1);
  update();
  assert.equal($('inspector'), inspector);
  assert.equal($('queue-rows'), queue);
  assert.deepEqual(state.engine.history, history, 'presentation never consumes or reorders history');
});

test('the real inspector switches fixed panels, retains collapsed evaluation and shows applied lamp values', () => {
  const model = compileModel({ nodes: [{ id: 'Q0', tag: 'A', ex: 'J0K(X0)' }], initial_q: { 0: ['Q0'], 1: [] }, q_y: [{ Y0: 'Q0' }] });
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
  assert.equal($('inspector-input-value').textContent, '最近发送：1');
  assert.equal($('inspector-output-value').textContent, '最近输出：1');
  assert.match($('inspector-lamp-readout').textContent, /亮度：91/);
  state.selected = 'lamp:0';
  view.outputState.config.pixels = [];
  render();
  assert.equal($('inspector-lamp-missing').hidden, false);
  assert.equal($('inspector-lamp-edit').hidden, true);
  assert.equal($('inspector-lamp-readout').hidden, true);
});
