import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { APP_CONFIG } from '../../html/config.js';
import { edgeStyleType, nodeStyleTarget, nodeComputationType, resolveNodeStyle, adjustNetworkLayout } from '../../src/scene/network-style.js';
import { createDisplayModel } from '../../src/scene/model-view.js';
import { NetworkView, arrowEnd } from '../../src/scene/view.js';
import { CanvasRenderer } from '../../src/scene/canvas-renderer.js';

const config = APP_CONFIG.scene.styles;
const styles = () => ({ version: 1, edges: structuredClone(config.edges.types), nodes: structuredClone(config.nodes.types),
  computation: Object.fromEntries(Object.entries(config.nodes.computationTypes).map(([key, value]) => [key, structuredClone(value.overrides)])), tags: {} });
const near = (actual, expected, epsilon = 1e-6) => assert.ok(Math.abs(actual - expected) < epsilon, `${actual} ≈ ${expected}`);
const distance = (layout, a, b) => Math.hypot(...['x', 'y', 'z'].map(axis => layout.positions.get(a)[axis] - layout.positions.get(b)[axis]));
const lineLayout = () => ({ positions: new Map([['a', { x: -1, y: 0, z: 0 }], ['b', { x: 1, y: 0, z: 0 }], ['alone', { x: 7, y: 5, z: 2 }]]),
  bounds: { min: { x: -1, y: 0, z: 0 }, max: { x: 7, y: 5, z: 2 } } });
const edge = (op = 'J') => ({ sourceKey: 'a', targetKey: 'b', relation: 'source', op });

function mockCanvas() {
  const context = { clearRect() {}, fillText() {}, measureText: text => ({ width: text.length * 16 }),
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, fill() {}, fillRect() {} };
  return { getContext: () => context };
}
function viewFixture(t, extraNodes = []) {
  const previous = globalThis.document;
  globalThis.document = { createElement: mockCanvas, hidden: false };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const view = new NetworkView({ closest: () => ({ classList: { toggle() {} } }) }, () => {});
  view.requestLayout = () => {};
  view.setModel({ nodes: [
    { id: 'G1.Q1', key: 'G1.Q1', initial: 0, hasEX: true, isInput: true, tags: ['pre', 'done'], errors: [], tokens: [] },
    { id: 'G1.Q2', key: 'G1.Q2', initial: 0, hasEX: true, tags: ['done'], errors: [], tokens: [
      { source: 'G1.Q1', index: 0, op: 'J', relation: 'source' },
      { source: 'G1.Q1', index: 0, op: 'K', relation: 'trigger' },
    ] },
    ...extraNodes,
  ], inputs: [], outputs: [{ id: 'observe:G1.Q2', source: 'G1.Q2', error: null }] });
  view.available = true;
  t.after(() => { view.labels.dispose(); view.batches.dispose(); view.clearSignals(); });
  return view;
}

test('shared categories distinguish operations, notifications and observation, with own-tag priority', () => {
  assert.deepEqual([
    edgeStyleType({ op: 'J', relation: 'source' }), edgeStyleType({ op: 'K', relation: 'source' }),
    edgeStyleType({ op: 'K', relation: 'trigger' }), edgeStyleType({ op: 'K', relation: 'source-definition' }),
    edgeStyleType({ op: 'Y' }),
  ], ['J', 'K', 'trigger', 'source', 'observe']);
  const state = styles();
  state.tags = Object.fromEntries([['__proto__', { ...state.nodes.node, color: '#ff0000' }], ['done', { ...state.nodes.node, size: 2 }]]);
  const node = { isInput: true, tags: ['constructor', '__proto__', 'done'] };
  assert.deepEqual(nodeStyleTarget(node, state), { category: 'input', tag: '__proto__' });
  assert.equal(resolveNodeStyle(node, state), state.tags.__proto__);
  assert.equal(resolveNodeStyle({ type: 'Y' }, state), state.nodes.observe);
  assert.equal(resolveNodeStyle({ tags: ['constructor'] }, state), state.nodes.node);
});

test('computation groups use nonempty EX regardless of q, inputs or source/seed fields; observations are excluded', () => {
  for (const q of [0, 1]) {
    for (const sources of [undefined, {}, { ex: [] }, { s: ['G1.Q1'], seed: 1 }]) {
      assert.equal(nodeComputationType({ q, sources }), 'q');
      assert.equal(nodeComputationType({ q, sources, isInput: true }), 'q');
    }
    for (const ex of [['J'], ['K', 'J']]) {
      assert.equal(nodeComputationType({ q, sources: { ex } }), 'ex');
      assert.equal(nodeComputationType({ q, sources: { ex }, isInput: true }), 'ex');
    }
  }
  assert.equal(nodeComputationType({ hasEX: true }), 'ex');
  assert.equal(nodeComputationType({ hasEX: false }), 'q');
  assert.equal(nodeComputationType({ category: 'observe' }), null);
  assert.equal(nodeComputationType({ type: 'Y' }), null);
});

test('computation overrides preserve untouched base attributes and remain below purpose tags', () => {
  const state = styles(), input = { isInput: true, hasEX: false };
  assert.equal(resolveNodeStyle(input, state), state.nodes.input);
  state.computation.q = { visible: false };
  state.computation.ex = { size: 2 };
  assert.deepEqual(resolveNodeStyle(input, state), { ...state.nodes.input, visible: false });
  assert.deepEqual(resolveNodeStyle({ hasEX: false }, state), { ...state.nodes.node, visible: false });
  assert.deepEqual(resolveNodeStyle({ isInput: true, hasEX: true }, state), { ...state.nodes.input, size: 2 });
  assert.equal(resolveNodeStyle({ category: 'observe' }, state), state.nodes.observe);
  state.tags.pre = { color: '#aabbcc', size: 3, labels: false, visible: true };
  assert.equal(resolveNodeStyle({ ...input, tags: ['pre'] }, state), state.tags.pre);
  state.computation.q = {};
  assert.equal(resolveNodeStyle(input, state), state.nodes.input);
});

test('marker preferences remain separate from ordinary node appearance', () => {
  const state = styles();
  state.computation.ex.marker = { visible: false, color: '#ff0000' };
  assert.equal(resolveNodeStyle({ hasEX: true }, state), state.nodes.node);
  assert.equal(resolveNodeStyle({ hasEX: true, isInput: true }, state), state.nodes.input);
  state.computation.ex.size = 2;
  assert.deepEqual(resolveNodeStyle({ hasEX: true }, state), { ...state.nodes.node, size: 2 });
});

test('explicit x visibility and color reach GPU glyphs independently of name settings and purpose labels', t => {
  const view = viewFixture(t), state = styles();
  const input = view.visuals.get('G1.Q1'), computing = view.visuals.get('G1.Q2');
  const originalColor = APP_CONFIG.scene.nodeMarker.color.slice(1);
  assert.equal(input.q.textColor.getHexString(), originalColor);
  state.tags.pre = { ...state.nodes.input, labels: false };
  view.setNetworkStyles(state);
  assert.equal(input.q.visible, config.nodes.computationTypes.ex.marker.visible, 'x uses its independent default even when names are hidden');
  assert.equal(input.q.textColor.getHexString(), config.nodes.computationTypes.ex.marker.color.slice(1));
  view.setNodeLabelsHidden(true);
  state.computation.ex.marker = { visible: true, color: '#00ff88' };
  view.setNetworkStyles(state);
  view.labels.flush();
  const color = new THREE.Color('#00ff88');
  for (const visual of [input, computing]) {
    assert.equal(visual.title.visible, false); assert.equal(visual.count.visible, false);
    assert.equal(visual.q.visible, true); assert.equal(visual.q.slot.visible, true);
    assert.equal(visual.q.textColor.getHexString(), '00ff88');
    const offset = visual.q.slot.start * 3;
    const tint = visual.q.slot.page.attributes.tint.array;
    near(tint[offset], color.r); near(tint[offset + 1], color.g); near(tint[offset + 2], color.b);
  }
  state.computation.ex.marker.visible = false;
  view.setNetworkStyles(state); view.labels.flush();
  for (const visual of [input, computing]) {
    assert.equal(visual.q.visible, false); assert.equal(visual.q.slot.visible, false);
    const offset = visual.q.slot.start * 2;
    assert.deepEqual([...visual.q.slot.page.attributes.size.array.slice(offset, offset + 2)], [0, 0]);
  }
  view.setNodeLabelsHidden(false);
  assert.equal(computing.title.visible, true); assert.equal(computing.q.visible, false);
  state.computation.ex.marker.visible = true;
  state.tags.pre.visible = false; state.computation.ex.visible = false;
  view.setNetworkStyles(state);
  assert.equal(input.q.visible, false); assert.equal(computing.q.visible, false);
});

test('custom x appearance survives scene colors, refreshes and model replacement in Canvas and resets to independent defaults', t => {
  const view = viewFixture(t, [
    { id: 'G1.Q3', key: 'G1.Q3', initial: 0, hasEX: false, tags: [], errors: [], tokens: [] },
  ]), state = styles();
  state.computation.ex.marker = { visible: true, color: '#1188cc' };
  view.setNetworkStyles(state);
  view.applyAppearance({ foreground: '#dd8844', fontScale: 1.5 });
  const assertColor = () => {
    for (const id of ['G1.Q1', 'G1.Q2']) {
      const visual = view.visuals.get(id);
      assert.equal(visual.q.textColor.getHexString(), '1188cc');
      assert.equal(visual.title.textColor.getHexString(), 'dd8844');
      assert.equal(visual.q.fontSize, config.nodes.computationTypes.ex.marker.size * 1.5);
      assert.equal(visual.q.visible, true);
    }
  };
  assertColor();
  view.refresh({ counts: new Map([['G1.Q1', 3]]), outputs: new Map() }); assertColor();
  view.applyLayout(view.originalLayout, { preserveMotion: true }); assertColor();
  view.setModel(structuredClone(view.model)); assertColor();
  assert.equal(view.visuals.get('G1.Q3').q, null);
  assert.equal(view.visuals.get('observe:G1.Q2').q, null);
  view.camera.position.set(0, 0, 100); view.camera.lookAt(0, 0, 0); view.camera.updateProjectionMatrix();
  const renderer = new CanvasRenderer(view, { canvas: mockCanvas() }); renderer.setSize(800, 600);
  renderer.render(view.scene, view.camera);
  assert.deepEqual(renderer.labels.filter(label => label.text === 'x').map(label => label.color),
    Array(2).fill(new THREE.Color('#1188cc').getStyle()));
  state.computation.ex.marker.visible = false;
  view.setNetworkStyles(state); renderer.render(view.scene, view.camera);
  assert.equal(renderer.labels.some(label => label.text === 'x'), false);
  assert.equal(renderer.labels.some(label => label.text === 'G1.Q1'), true);
  state.computation.ex = {};
  view.setNetworkStyles(state); renderer.render(view.scene, view.camera);
  assert.deepEqual(renderer.labels.filter(label => label.text === 'x').map(label => label.color),
    Array(2).fill(new THREE.Color(config.nodes.computationTypes.ex.marker.color).getStyle()));
  view.setNetworkStyles(null);
  view.appearance = null; view.syncLabelAppearance();
  assert.equal(view.visuals.get('G1.Q1').q.textColor.getHexString(), APP_CONFIG.scene.nodeMarker.color.slice(1));
});

test('drawing projection copies purpose tags without altering the compiled definition', () => {
  const definition = { q: 0, pro: { tag: ['pre', 'done'] } };
  const compiled = { paths: ['G1.Q1'], jki: new Map([['G1.Q1', definition]]), inputs: ['G1.Q1'],
    sourceRefs: new Map(), triggerRefs: new Map(), name: 'tagged' };
  const projection = createDisplayModel(compiled, { read: ['G1.Q1'] });
  projection.nodes[0].tags.push('drawing-only');
  assert.deepEqual(definition.pro.tag, ['pre', 'done']);
  assert.deepEqual(projection.outputs[0].tags, []);
  assert.equal(nodeStyleTarget(projection.outputs[0], styles()).category, 'observe');
});

test('both computation groups style GPU cubes and Canvas consistently, with observation endpoints unchanged', t => {
  const view = viewFixture(t, [
    { id: 'G1.Q3', key: 'G1.Q3', initial: 1, hasEX: false, tags: [], errors: [], tokens: [] },
  ]), state = styles();
  state.computation.ex = { color: '#ff2299', size: 1.5 };
  state.computation.q = { color: '#22aaff', size: 2, labels: false };
  view.setNetworkStyles(state);
  const input = view.visuals.get('G1.Q1'), computing = view.visuals.get('G1.Q2');
  const stored = view.visuals.get('G1.Q3'), observed = view.visuals.get('observe:G1.Q2');
  for (const node of [input, computing]) {
    assert.equal(node.hasEX, true);
    assert.equal(node.mesh.material.color.getHexString(), 'ff2299');
    assert.equal(node.mesh.scale.x, 1.5);
    assert.equal(view.batches.nodes.instanceMatrix.array[node.batchIndex * 16], 1.5);
  }
  assert.equal(stored.hasEX, false);
  assert.equal(stored.mesh.material.color.getHexString(), '22aaff');
  assert.equal(stored.mesh.scale.x, 2);
  assert.equal(view.batches.nodes.instanceMatrix.array[stored.batchIndex * 16], 2);
  assert.equal(stored.title.visible, false); assert.equal(stored.count.visible, false);
  assert.equal(observed.mesh.material.color.getHexString(), state.nodes.observe.color.slice(1));
  assert.equal(observed.mesh.scale.x, 1); assert.equal(observed.mesh.visible, true);
  const renderer = new CanvasRenderer(view, { canvas: mockCanvas() }); renderer.setSize(800, 600);
  const cubes = [];
  renderer.cube = mesh => { if (mesh.visible) cubes.push([mesh.material.color.getHexString(), mesh.scale.x]); };
  renderer.curve = renderer.arrow = renderer.label = () => {};
  renderer.render(view.scene, view.camera);
  assert.deepEqual(cubes, [['ff2299', 1.5], ['ff2299', 1.5], ['22aaff', 2], [state.nodes.observe.color.slice(1), 1]]);
  state.computation.ex.visible = false;
  view.setNetworkStyles(state);
  assert.equal(input.mesh.visible, false); assert.equal(computing.mesh.visible, false);
  assert.equal(stored.mesh.visible, true); assert.equal(observed.mesh.visible, true);
  assert.equal(view.batches.nodes.instanceMatrix.array[input.batchIndex * 16], 0);
  assert.ok(view.edges.every(item => !item.visible));
  state.computation.q.visible = false;
  view.setNetworkStyles(state); cubes.length = 0; renderer.render(view.scene, view.camera);
  assert.deepEqual(cubes, [[state.nodes.observe.color.slice(1), 1]]);
  assert.equal(view.batches.nodes.instanceMatrix.array[stored.batchIndex * 16], 0);
  state.computation = { ex: {}, q: {} };
  view.setNetworkStyles(state);
  assert.equal(input.mesh.material.color.getHexString(), state.nodes.input.color.slice(1));
  assert.equal(stored.title.visible, true); assert.equal(stored.mesh.scale.x, 1);
});

test('default lengths preserve exact layout; length changes move endpoints and restore without accumulation', () => {
  const original = lineLayout(), before = structuredClone(original), state = styles();
  assert.equal(adjustNetworkLayout(original, [edge()], state, config.layout), original);
  state.edges.J.length = 2;
  const twice = adjustNetworkLayout(original, [edge()], state, config.layout);
  near(distance(twice, 'a', 'b'), 4);
  assert.deepEqual(twice.positions.get('alone'), original.positions.get('alone'));
  assert.deepEqual(adjustNetworkLayout(original, [edge()], state, config.layout), twice);
  assert.deepEqual(original, before);
  state.edges.J.length = 1;
  assert.equal(adjustNetworkLayout(original, [edge()], state, config.layout), original);
});

test('competing edge types compromise deterministically while self loops never move their node', () => {
  const original = lineLayout(), state = styles(); state.edges.J.length = 3;
  const result = adjustNetworkLayout(original, [edge('J'), edge('K')], state, config.layout);
  near(distance(result, 'a', 'b'), 4);
  near(result.positions.get('a').x + result.positions.get('b').x, 0);
  assert.equal(adjustNetworkLayout(original, [{ ...edge(), targetKey: 'a' }], state, config.layout), original);
});

test('neutral styles keep original geometry and GPU materials; unconfigured view stays unchanged', t => {
  const view = viewFixture(t), positions = [...view.visuals].map(([key, value]) => [key, value.mesh.position.toArray()]);
  const matrices = view.batches.nodes.instanceMatrix.array.slice(), arrows = view.batches.arrows.instanceMatrix.array.slice();
  const material = view.batches.arrows.material;
  const neutral = styles();
  for (const style of Object.values(neutral.edges)) Object.assign(style, { opacity: .4, length: 1, visible: true });
  view.setNetworkStyles(neutral);
  assert.deepEqual([...view.visuals].map(([key, value]) => [key, value.mesh.position.toArray()]), positions);
  assert.deepEqual(view.batches.nodes.instanceMatrix.array, matrices);
  assert.deepEqual(view.batches.arrows.instanceMatrix.array, arrows);
  assert.equal(view.batches.arrows.material, material);
  view.setNetworkStyles(null);
  assert.deepEqual(view.batches.nodes.instanceMatrix.array, matrices);
  assert.equal(view.networkStyles, null);
});

test('node style hides cube, all labels, incident edges, signals and picking; restoring preserves runtime data', t => {
  const view = viewFixture(t), state = styles(), node = view.visuals.get('G1.Q1');
  const engine = { counts: new Map([['G1.Q1', 2]]), outputs: new Map() }; view.refresh(engine);
  view.showTransfers([{ source: 'G1.Q1', target: 'G1.Q2', value: 1, relation: 'source' }]);
  assert.equal(view.signals.length, 1);
  state.tags.pre = { ...state.nodes.input, visible: false };
  view.setNetworkStyles(state);
  assert.equal(node.mesh.visible, false);
  assert.ok([node.title, node.count, node.q].every(label => !label.visible));
  assert.equal(view.pickObjects().includes(node.mesh), false);
  assert.ok(view.edges.slice(0, 2).every(item => !item.visible));
  assert.ok(view.signals.every(item => !item.text.visible && !item.tip.visible));
  assert.equal(view.batches.nodes.instanceMatrix.array[0], 0);
  assert.equal(view.batches.nodes.instanceMatrix.array[15], 1);
  assert.equal(view.batches.lines.geometry.attributes.color.array[3], 0);
  state.tags.pre.visible = true; state.tags.pre.labels = false;
  view.setNetworkStyles(state);
  assert.equal(node.mesh.visible, true);
  assert.ok([node.title, node.count].every(label => !label.visible));
  assert.equal(node.q.visible, config.nodes.computationTypes.ex.marker.visible);
  assert.equal(view.pickObjects().includes(node.mesh), true);
  assert.equal(view.signals[0].text.visible, true);
  assert.equal(view.engine, engine); assert.equal(engine.counts.get('G1.Q1'), 2);
});

test('node sizes update GPU transforms and arrow collision; appearance edits never reset camera', t => {
  const view = viewFixture(t), state = styles(), target = view.visuals.get('G1.Q2');
  const before = view.edges[0].endT, camera = view.camera.position.clone();
  const motion = view.edges.map(item => ({ seed: item.curve.seed, speed: item.curve.speed, point: item.curve.getPoint(.37).toArray() }));
  view.resetCamera = () => assert.fail('style edits must not reset camera');
  state.nodes.node.size = 4; state.edges.J.length = 1.5;
  view.setNetworkStyles(state);
  assert.equal(target.mesh.scale.x, 4);
  assert.equal(view.batches.nodes.instanceMatrix.array[target.batchIndex * 16], 4);
  assert.equal(view.camera.position.equals(camera), true);
  assert.deepEqual(view.edges.map(item => ({ seed: item.curve.seed, speed: item.curve.speed })), motion.map(({ seed, speed }) => ({ seed, speed })));
  const curve = new THREE.LineCurve3(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(1, 0, 0));
  assert.ok(arrowEnd(curve, new THREE.Vector3(1, 0, 0), 4) < arrowEnd(curve, new THREE.Vector3(1, 0, 0), 1));
  assert.ok(Number.isFinite(before));
  const original = view.originalLayout;
  state.nodes.node.size = 1; state.edges.J.length = 1;
  view.setNetworkStyles(state);
  for (const [key, value] of view.visuals) assert.deepEqual(value.mesh.position.toArray(), Object.values(original.positions.get(key)));
  assert.deepEqual(view.edges.map(item => item.curve.getPoint(.37).toArray()), motion.map(item => item.point));
});

test('GPU buffers honor per-type alpha/visibility and retain warning colors and selected emphasis', t => {
  const view = viewFixture(t), state = styles(); state.edges.J.opacity = .1; state.edges.J.color = '#ff0000';
  state.edges.trigger.visible = false;
  view.setNetworkStyles(state);
  const batch = view.batches;
  near(batch.lines.geometry.attributes.color.array[3], .1);
  near(batch.arrowOpacity.array[0], .2);
  assert.equal(batch.lines.geometry.attributes.color.array[batch.segments * 8 + 3], 0);
  view.selected = 'G1.Q2'; view.refresh({ counts: new Map([['G1.Q1', 1001]]), outputs: new Map() });
  assert.equal(batch.edgeColors[0], 0xff596e);
  near(batch.lines.geometry.attributes.color.array[3], .25);
  near(batch.selectedArrowOpacity.array[0], .25);
  assert.equal(view.edges[0].highlight.visible, true);
  near(view.edges[0].highlight.material.opacity, .25);
  assert.equal(view.visuals.get('G1.Q1').mesh.material.color.getHex(), 0xff596e);
});

test('Canvas uses styled cube size, edge alpha and visibility without painting hidden labels/signals', t => {
  const view = viewFixture(t), state = styles(); state.edges.J.opacity = .1; state.edges.trigger.visible = false;
  state.nodes.node.size = 2;
  view.setNetworkStyles(state);
  const renderer = new CanvasRenderer(view, { canvas: mockCanvas() }); renderer.setSize(800, 600);
  const curves = [], cubes = [], arrows = [], labels = [];
  renderer.curve = (curve, color, width, alpha) => curves.push(alpha);
  renderer.arrow = (curve, position, color, size, alpha) => arrows.push(alpha);
  renderer.cube = mesh => { if (mesh.visible) cubes.push(mesh.scale.x); };
  renderer.label = label => { if (label?.visible) labels.push(label.text); };
  renderer.render(view.scene, view.camera);
  assert.deepEqual(curves, [.1, .4]); assert.deepEqual(arrows, [.25, 1]);
  assert.deepEqual(cubes, [1, 2, 1]); assert.ok(labels.length);
  curves.length = cubes.length = labels.length = arrows.length = 0;
  state.nodes.input.visible = false; state.nodes.node.visible = false; state.nodes.observe.visible = false;
  view.setNetworkStyles(state); renderer.render(view.scene, view.camera);
  assert.deepEqual(curves, []); assert.deepEqual(cubes, []); assert.deepEqual(labels, []); assert.deepEqual(arrows, []);
});
