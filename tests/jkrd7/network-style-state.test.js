import test from 'node:test';
import assert from 'node:assert/strict';
import { APP_CONFIG } from '../../html/config.js';
import { defaultNetworkStyles, normalizeNetworkStyles } from '../../src/ui/network-style-state.js';
import { NetworkStylePanel } from '../../src/ui/network-style-panel.js';
import { resolveNodeStyle } from '../../src/scene/network-style.js';

const config = APP_CONFIG.scene.styles;
const copy = value => structuredClone(value);

test('network preference defaults preserve established colors and contain no product labels or model data', () => {
  const state = defaultNetworkStyles(config);
  assert.deepEqual(Object.keys(state), ['version', 'edges', 'nodes', 'computation', 'tags']);
  assert.deepEqual(Object.keys(state.edges), ['J', 'K', 'trigger', 'source', 'observe']);
  assert.deepEqual(Object.keys(state.nodes), ['input', 'node', 'observe']);
  assert.deepEqual(state.edges.J, { color: '#e898c0', opacity: 0.4, length: 1, visible: true });
  assert.deepEqual(state.nodes.input, { color: '#73aaff', size: 1, visible: true, labels: true });
  assert.deepEqual(state.computation, { ex: {}, q: {} });
  assert.deepEqual(state.tags, {});
  state.edges.J.color = '#112233';
  assert.equal(config.edges.types.J.color, '#e898c0');
});

test('saved styles validate fields independently, retain false and zero, and drop runtime values', () => {
  const saved = defaultNetworkStyles(config);
  saved.edges.J = { color: '#AABBCC', opacity: 0, length: Infinity, visible: false, source: 'G1.Q1' };
  saved.edges.K = { color: 'url(example)', opacity: 5, length: -3, visible: 'false' };
  saved.nodes.input = { color: '#123', size: '4', visible: false, labels: false, q: 1 };
  saved.nodes.node.size = 1e6;
  saved.nodes.unknown = {}; saved.edges.unknown = {}; saved.model = { q: 0 };
  const result = normalizeNetworkStyles(saved, config);
  assert.deepEqual(result.edges.J, { color: '#aabbcc', opacity: 0, length: 1, visible: false });
  assert.deepEqual(result.edges.K, { color: '#689ef3', opacity: 1, length: config.edges.limits.length.min, visible: true });
  assert.deepEqual(result.nodes.input, { color: '#73aaff', size: 1, visible: false, labels: false });
  assert.equal(result.nodes.node.size, config.nodes.limits.size.max);
  assert.equal(Object.hasOwn(result.nodes, 'unknown'), false);
  assert.equal(Object.hasOwn(result.edges, 'unknown'), false);
  assert.equal(Object.hasOwn(result, 'model'), false);
  assert.deepEqual(normalizeNetworkStyles(JSON.parse(JSON.stringify(result)), config), result);
});

test('invalid storage and unsupported versions use complete current defaults', () => {
  const defaults = defaultNetworkStyles(config);
  for (const raw of [null, undefined, 'styles', [], 1, { version: 99 }, { edges: { J: { color: '#aabbcc' } } }]) {
    assert.deepEqual(normalizeNetworkStyles(raw, config), defaults);
  }
  const inherited = Object.create({ version: config.storage.version, edges: { J: { color: '#aabbcc' } } });
  assert.deepEqual(normalizeNetworkStyles(inherited, config), defaults);
});

test('saved preferences without computation overrides retain every base and purpose style', () => {
  const saved = defaultNetworkStyles(config);
  delete saved.computation;
  saved.nodes.input.color = '#234567';
  saved.nodes.node.size = 1.5;
  saved.tags.pre = { color: '#abcdef', size: 2, visible: false, labels: true };
  const restored = normalizeNetworkStyles(saved, config);
  assert.deepEqual(restored.computation, { ex: {}, q: {} });
  assert.deepEqual(restored.nodes, saved.nodes);
  assert.deepEqual(restored.tags, saved.tags);
  for (const hasEX of [true, false]) {
    assert.deepEqual(resolveNodeStyle({ isInput: true, hasEX }, restored), saved.nodes.input);
    assert.deepEqual(resolveNodeStyle({ hasEX }, restored), saved.nodes.node);
    assert.deepEqual(resolveNodeStyle({ hasEX, tags: ['pre'] }, restored), saved.tags.pre);
  }
});

test('computation preferences keep only explicit supported style properties', () => {
  const saved = defaultNetworkStyles(config);
  saved.computation = {
    ex: { color: '#ABCDEF', size: 500, visible: false, q: 1 },
    q: { labels: false }, unknown: { visible: false },
  };
  const restored = normalizeNetworkStyles(saved, config);
  assert.deepEqual(restored.computation, {
    ex: { color: '#abcdef', size: config.nodes.limits.size.max, visible: false }, q: { labels: false },
  });
  assert.deepEqual(normalizeNetworkStyles(JSON.parse(JSON.stringify(restored)), config), restored);
});

test('arbitrary purpose tags stay own data properties and cannot pollute object prototypes', () => {
  const saved = JSON.parse('{"version":1,"tags":{"__proto__":{"color":"#123456","size":2},"constructor":{"visible":false},"prototype":{"labels":false},"<b>pre</b>":{"color":"#FF0000"},"bad":[],"empty":null}}');
  const state = normalizeNetworkStyles(saved, config);
  assert.equal(Object.getPrototypeOf(state.tags), Object.prototype);
  assert.equal(Object.hasOwn(state.tags, '__proto__'), true);
  assert.equal(state.tags.__proto__.color, '#123456');
  assert.equal(state.tags.constructor.visible, false);
  assert.equal(state.tags.prototype.labels, false);
  assert.equal(state.tags['<b>pre</b>'].color, '#ff0000');
  assert.equal(Object.hasOwn(state.tags, 'bad'), false);
  assert.equal(Object.hasOwn(state.tags, 'empty'), false);
  assert.equal({}.color, undefined);
  assert.equal(resolveNodeStyle({ tags: ['__proto__', 'constructor'] }, state).color, '#123456');
  assert.deepEqual(normalizeNetworkStyles(JSON.parse(JSON.stringify(state)), config), state);
});

class Field {
  constructor(value = '') { this.value = value; this.checked = false; this.dataset = {}; this.children = []; this.handlers = new Map(); }
  addEventListener(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
  }
  removeEventListener(type, handler) { this.handlers.get(type)?.delete(handler); }
  fire(type) { for (const handler of this.handlers.get(type) ?? []) handler({ target: this }); }
  append(option) { option.parent = this; this.children.push(option); }
  remove() { this.parent.children = this.parent.children.filter(item => item !== this); }
  querySelectorAll() { return this.children.filter(option => Object.hasOwn(option.dataset, 'networkStyleTag')); }
  cloneNode() { return new Field(); }
  setAttribute(name, value) { (this.attributes ??= {})[name] = value; }
  querySelector() { return this.status; }
}

function harness(saved = null, { readFails = false, writeFails = false, legend = [], getMarkerColor } = {}) {
  const fields = new Map(), changes = [], writes = [], errors = [];
  const toggles = Object.fromEntries(Object.keys(config.edges.types).map(key => {
    const button = new Field(); button.dataset.networkEdgeToggle = key; button.status = new Field();
    return [key, button];
  }));
  const storage = new Map(saved === null ? [] : [[config.storage.key, saved]]);
  const root = {
    querySelectorAll: selector => selector === '[data-network-edge-toggle]' ? Object.values(toggles) : legend.filter(element => Object.hasOwn(element.dataset,
      selector === '[data-network-node-color]' ? 'networkNodeColor' : 'networkEdgeColor')),
    querySelector: selector => {
      const id = selector.slice(1);
      if (!fields.has(id)) fields.set(id, new Field());
      return fields.get(id);
    },
    ownerDocument: {
      getElementById: () => ({ content: { firstElementChild: new Field() } }),
      defaultView: {
        localStorage: {
          getItem: key => { if (readFails) throw new Error('storage blocked'); return storage.get(key) ?? null; },
          setItem: (key, value) => { if (writeFails) throw new Error('quota'); writes.push([key, value]); storage.set(key, value); },
        },
        CustomEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
      },
    },
    dispatchEvent: event => errors.push(event),
  };
  const panel = new NetworkStylePanel({ root, config, onChange: state => changes.push(copy(state)), getMarkerColor });
  const field = name => fields.get(`network-${name}`);
  return { panel, field, changes, writes, errors, storage, toggles };
}

function model(entries, inputs = []) {
  return { inputs, jki: new Map(entries.map(([path, tags]) => [path, { q: 0, pro: { tag: tags } }])) };
}

test('panel restores once without writing, edits selected edge only, and reset persists that type', () => {
  const saved = defaultNetworkStyles(config); saved.edges.trigger.color = '#ffff00';
  const { panel, field, changes, writes } = harness(JSON.stringify(saved));
  assert.equal(changes.length, 1); assert.equal(writes.length, 0);
  field('edge-type').value = 'trigger'; field('edge-type').fire('change');
  assert.equal(field('edge-color').value, '#ffff00'); assert.equal(writes.length, 0);
  field('edge-length').value = '2.5'; field('edge-length').fire('input');
  assert.equal(panel.state.edges.trigger.length, 2.5);
  assert.deepEqual(panel.state.edges.J, saved.edges.J);
  assert.equal(field('edge-length-value').textContent, '250%');
  field('edge-visible').checked = false; field('edge-visible').fire('change');
  assert.equal(panel.state.edges.trigger.visible, false);
  field('edge-reset').fire('click');
  assert.deepEqual(panel.state, defaultNetworkStyles(config));
  assert.equal(writes.length, 3);
  const reloaded = harness(writes.at(-1)[1]);
  assert.deepEqual(reloaded.panel.state, panel.state);
  assert.equal(reloaded.writes.length, 0);
});

test('scene edge toggles share appearance state, preserve other styles and restore saved visibility', () => {
  const saved = defaultNetworkStyles(config);
  saved.edges.trigger = { color: '#123456', length: 2, opacity: 0.25, visible: false };
  const { panel, field, toggles, writes, changes } = harness(JSON.stringify(saved));
  assert.equal(toggles.trigger.attributes['aria-pressed'], 'false');
  assert.equal(toggles.trigger.status.textContent, '已隐藏');
  assert.equal(writes.length, 0);
  for (const key of Object.keys(config.edges.types)) {
    const before = copy(panel.state), visible = !before.edges[key].visible;
    toggles[key].fire('click');
    assert.deepEqual(panel.state, { ...before, edges: { ...before.edges, [key]: { ...before.edges[key], visible } } });
    assert.deepEqual(changes.at(-1), panel.state);
    assert.equal(field('edge-type').value, config.edges.defaultType);
    assert.equal(toggles[key].attributes['aria-pressed'], String(visible));
    assert.equal(toggles[key].status.textContent, visible ? '已显示' : '已隐藏');
    assert.equal(toggles[key].title, `${visible ? '隐藏' : '显示'}${config.edges.types[key].label}`);
  }
  field('edge-type').value = 'trigger'; field('edge-type').fire('change');
  assert.equal(field('edge-visible').checked, true);
  field('edge-visible').checked = false; field('edge-visible').fire('change');
  assert.equal(toggles.trigger.attributes['aria-pressed'], 'false');
  assert.equal(toggles.trigger.status.textContent, '已隐藏');
  const restored = harness(writes.at(-1)[1]);
  assert.deepEqual(restored.panel.state, panel.state);
  assert.equal(restored.toggles.trigger.attributes['aria-pressed'], 'false');
  field('edge-reset').fire('click');
  assert.equal(toggles.trigger.attributes['aria-pressed'], 'true');
  assert.equal(toggles.trigger.status.textContent, '已显示');
  panel.dispose(); const committed = writes.length;
  toggles.trigger.fire('click');
  assert.equal(writes.length, committed);
});

test('purpose options are cloned text, inherit the base category, and preserve overrides across model switches', () => {
  const { panel, field, changes, writes } = harness();
  const first = model([['G1.Q1', ['pre', '<b>pre</b>']], ['G1.Q2', ['bit', 'pre']]], ['G1.Q1']);
  const original = copy(first);
  panel.setModel(first);
  assert.deepEqual(first, original);
  assert.deepEqual(field('node-type').children.map(option => option.textContent), ['用途：pre', '用途：<b>pre</b>', '用途：bit']);
  assert.equal(writes.length, 0); assert.equal(changes.length, 1);
  field('node-type').value = 'tag:pre'; field('node-type').fire('change');
  assert.equal(field('node-color').value, config.nodes.types.input.color);
  field('node-size').value = '2'; field('node-size').fire('input');
  field('node-labels').checked = false; field('node-labels').fire('change');
  assert.deepEqual(panel.state.tags.pre, { color: '#73aaff', size: 2, visible: true, labels: false });
  assert.equal(field('node-reset').textContent, '恢复继承样式');
  panel.setModel(model([['G3.Q1', ['done']]]));
  assert.equal(field('node-type').value, config.nodes.defaultType);
  assert.deepEqual(field('node-type').children.map(option => option.value), ['tag:done']);
  assert.equal(panel.state.tags.pre.size, 2);
  panel.setModel(first);
  field('node-type').value = 'tag:pre'; field('node-type').fire('change');
  assert.equal(field('node-size').value, 2);
  field('node-reset').fire('click');
  assert.equal(Object.hasOwn(panel.state.tags, 'pre'), false);
  assert.equal(field('node-size').value, 1);
  assert.equal(writes.length, 3);
});

test('both computation groups edit only the changed property and persist independently across models', () => {
  const { panel, field, writes } = harness();
  const original = copy(panel.state);
  for (const [group, hasEX] of [['ex', true], ['q', false]]) {
    field('node-type').value = `computation:${group}`; field('node-type').fire('change');
    assert.equal(field('node-reset').textContent, '恢复继承样式');
    assert.equal(field('node-color').value, original.nodes.node.color);
    field('node-visible').checked = false; field('node-visible').fire('change');
    assert.deepEqual(panel.state.computation[group], { visible: false });
    assert.deepEqual(resolveNodeStyle({ isInput: true, hasEX }, panel.state), { ...original.nodes.input, visible: false });
    field('node-color').value = group === 'ex' ? '#112233' : '#aabbcc'; field('node-color').fire('input');
    field('node-size').value = group === 'ex' ? '2' : '1.5'; field('node-size').fire('input');
    field('node-labels').checked = false; field('node-labels').fire('change');
    panel.setModel(model([['G1.Q1', ['pre']]], ['G1.Q1']));
    assert.equal(field('node-type').value, `computation:${group}`);
  }
  assert.deepEqual(panel.state.nodes, original.nodes);
  assert.deepEqual(panel.state.edges, original.edges);
  assert.deepEqual(panel.state.tags, {});
  assert.deepEqual(panel.state.computation.ex, { visible: false, color: '#112233', size: 2, labels: false });
  assert.deepEqual(panel.state.computation.q, { visible: false, color: '#aabbcc', size: 1.5, labels: false });
  const restored = harness(writes.at(-1)[1]);
  assert.deepEqual(restored.panel.state, panel.state);
  restored.field('node-type').value = 'computation:ex'; restored.field('node-type').fire('change');
  assert.equal(restored.field('node-color').value, '#112233');
  assert.equal(restored.field('node-visible').checked, false);
  const beforeReset = copy(panel.state);
  field('node-reset').fire('click');
  assert.deepEqual(panel.state.computation.q, {});
  assert.deepEqual(panel.state.computation.ex, beforeReset.computation.ex);
  assert.deepEqual(resolveNodeStyle({ isInput: true, hasEX: false }, panel.state), original.nodes.input);
  assert.deepEqual(harness(writes.at(-1)[1]).panel.state, panel.state);
});

test('purpose controls inherit the correct computation group and reset back to it', () => {
  const saved = defaultNetworkStyles(config);
  saved.computation = { ex: { color: '#112233', size: 2 }, q: { color: '#aabbcc', labels: false } };
  const { panel, field } = harness(JSON.stringify(saved));
  panel.setModel({ inputs: ['G1.Q1'], jki: new Map([
    ['G1.Q1', { q: 0, sources: { ex: [{ J: 'G1.Q2' }] }, pro: { tag: ['computed'] } }],
    ['G1.Q2', { q: 1, pro: { tag: ['storage'] } }],
  ]) });
  field('node-type').value = 'tag:computed'; field('node-type').fire('change');
  assert.equal(field('node-color').value, '#112233');
  assert.equal(field('node-size').value, 2);
  field('node-color').value = '#445566'; field('node-color').fire('input');
  assert.equal(resolveNodeStyle({ hasEX: true, tags: ['computed'] }, panel.state).color, '#445566');
  field('node-reset').fire('click');
  assert.equal(field('node-color').value, '#112233');
  field('node-type').value = 'tag:storage'; field('node-type').fire('change');
  assert.equal(field('node-color').value, '#aabbcc');
  assert.equal(field('node-labels').checked, false);
});

test('x marker controls appear only for ex, preserve other preferences, and restore cached explicit values', () => {
  let sceneColor = '#abcdef';
  const { panel, field, writes } = harness(null, { getMarkerColor: () => sceneColor });
  const original = copy(panel.state);
  assert.equal(field('node-marker-visible-field').hidden, true);
  assert.equal(field('node-marker-color-field').hidden, true);
  field('node-type').value = 'computation:ex'; field('node-type').fire('change');
  assert.equal(field('node-marker-visible-field').hidden, false);
  assert.equal(field('node-marker-color-field').hidden, false);
  assert.equal(field('node-marker-visible').checked, true);
  assert.equal(field('node-marker-color').value, sceneColor);
  assert.equal(writes.length, 0);
  field('node-marker-visible').checked = false; field('node-marker-visible').fire('change');
  assert.deepEqual(panel.state.computation.ex, { marker: { visible: false } });
  field('node-marker-color').value = '#123456'; field('node-marker-color').fire('input');
  assert.deepEqual(panel.state, { ...original, computation: { ex: { marker: { visible: false, color: '#123456' } }, q: {} } });
  // Changing a normal node attribute retains its independently configured marker.
  field('node-size').value = '1.5'; field('node-size').fire('input');
  assert.deepEqual(panel.state.computation.ex, { size: 1.5, marker: { visible: false, color: '#123456' } });
  const restored = harness(writes.at(-1)[1]);
  restored.field('node-type').value = 'computation:ex'; restored.field('node-type').fire('change');
  assert.equal(restored.field('node-marker-visible').checked, false);
  assert.equal(restored.field('node-marker-color').value, '#123456');
  panel.setModel(model([['G1.Q1', ['pre']]]));
  for (const type of ['computation:q', 'input', 'node', 'observe', 'tag:pre']) {
    field('node-type').value = type; field('node-type').fire('change');
    assert.equal(field('node-marker-visible-field').hidden, true);
    assert.equal(field('node-marker-color-field').hidden, true);
    const before = writes.length;
    field('node-marker-visible').fire('change'); field('node-marker-color').fire('input');
    assert.equal(writes.length, before);
  }
  field('node-type').value = 'computation:ex'; field('node-type').fire('change');
  sceneColor = '#556677';
  field('node-reset').fire('click');
  assert.deepEqual(panel.state, original);
  assert.equal(field('node-marker-visible').checked, true);
  assert.equal(field('node-marker-color').value, sceneColor);
  assert.deepEqual(harness(writes.at(-1)[1]).panel.state, original);
  panel.dispose(); const before = writes.length;
  field('node-marker-visible').fire('change'); field('node-marker-color').fire('input');
  assert.equal(writes.length, before);
});

test('x marker settings validate independently and never apply to q nodes or purpose styles', () => {
  const saved = defaultNetworkStyles(config);
  saved.computation.ex = { labels: false, marker: { visible: false, color: '#AABBCC', size: 100, q: 1 } };
  saved.computation.q = { marker: { visible: true, color: '#112233' } };
  saved.tags.pre = { ...saved.nodes.node, marker: { visible: false } };
  const normalized = normalizeNetworkStyles(saved, config);
  assert.deepEqual(normalized.computation, { ex: { labels: false, marker: { visible: false, color: '#aabbcc' } }, q: {} });
  assert.deepEqual(normalized.tags.pre, saved.nodes.node);
  assert.deepEqual(normalizeNetworkStyles(JSON.parse(JSON.stringify(normalized)), config), normalized);
  for (const marker of [null, [], {}, { visible: 'false', color: 'red' }]) {
    saved.computation.ex.marker = marker;
    assert.deepEqual(normalizeNetworkStyles(saved, config).computation.ex, { labels: false });
  }
  const { panel, field } = harness(JSON.stringify(saved));
  field('node-type').value = 'computation:ex'; field('node-type').fire('change');
  assert.equal(field('node-marker-visible').checked, false);
  field('node-marker-visible').checked = true; field('node-marker-visible').fire('change');
  assert.equal(panel.state.computation.ex.labels, false);
  assert.deepEqual(panel.state.computation.ex.marker, { visible: true });
});

test('editing or resetting a prototype-named tag uses the same safe settings flow', () => {
  const { panel, field, writes } = harness();
  panel.setModel(model([['G1.Q1', ['__proto__', 'constructor']]]));
  field('node-type').value = 'tag:__proto__'; field('node-type').fire('change');
  field('node-color').value = '#12ab34'; field('node-color').fire('input');
  assert.equal(Object.hasOwn(panel.state.tags, '__proto__'), true);
  assert.equal(Object.getPrototypeOf(panel.state.tags), Object.prototype);
  assert.equal(resolveNodeStyle({ tags: ['__proto__'] }, panel.state).color, '#12ab34');
  assert.equal(harness(writes[0][1]).panel.state.tags.__proto__.color, '#12ab34');
  field('node-reset').fire('click');
  assert.equal(Object.hasOwn(panel.state.tags, '__proto__'), false);
  assert.equal({}.color, undefined);
});

test('storage failures retain live editing and dispose removes handlers', () => {
  for (const saved of ['invalid JSON', '{"version":999}']) {
    assert.deepEqual(harness(saved).panel.state, defaultNetworkStyles(config));
  }
  const { panel, field, changes, writes, errors } = harness(null, { readFails: true, writeFails: true });
  field('node-visible').checked = false; field('node-visible').fire('change');
  assert.equal(panel.state.nodes.node.visible, false);
  assert.equal(changes.length, 2); assert.equal(writes.length, 0);
  assert.equal(errors.length, 1); assert.equal(errors[0].type, 'network-style-error');
  assert.equal(errors[0].bubbles, true);
  panel.dispose();
  field('node-visible').checked = true; field('node-visible').fire('change');
  assert.equal(changes.length, 2);
  assert.equal(panel.state.nodes.node.visible, false);
});

test('legend reflects restored and edited base colors independently of purpose overrides', () => {
  const legend = [
    ...['input', 'node', 'observe', '__proto__'].map(key => ({ dataset: { networkNodeColor: key }, style: {} })),
    ...['J', 'K'].map(key => ({ dataset: { networkEdgeColor: key }, style: {} })),
  ];
  const saved = defaultNetworkStyles(config);
  saved.nodes.input.color = '#123456'; saved.edges.K.color = '#abcdef';
  const { panel, field } = harness(JSON.stringify(saved), { legend });
  assert.deepEqual(legend.map(element => element.style.backgroundColor), [
    '#123456', '#f1f6ff', '#79dfae', undefined, '#e898c0', '#abcdef',
  ]);
  field('node-type').value = 'input'; field('node-type').fire('change');
  field('node-color').value = '#112233'; field('node-color').fire('input');
  assert.equal(legend[0].style.backgroundColor, '#112233');
  field('edge-type').value = 'J'; field('edge-type').fire('change');
  field('edge-color').value = '#332211'; field('edge-color').fire('input');
  assert.equal(legend[4].style.backgroundColor, '#332211');
  panel.setModel(model([['G1.Q1', ['pre']]], ['G1.Q1']));
  field('node-type').value = 'tag:pre'; field('node-type').fire('change');
  field('node-color').value = '#ff0000'; field('node-color').fire('input');
  assert.equal(panel.state.tags.pre.color, '#ff0000');
  assert.equal(legend[0].style.backgroundColor, '#112233');
});
