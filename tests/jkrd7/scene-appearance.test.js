import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three/webgpu';
import { APP_CONFIG } from '../../html/config.js';
import { NetworkView } from '../../src/scene/view.js';
import { NodeLabels } from '../../src/scene/node-labels.js';
import { CanvasRenderer } from '../../src/scene/canvas-renderer.js';
import { compileModel } from '../../src/jk/model-schema.js';
import { createDisplayModel } from '../../src/scene/model-view.js';

const defaults = { ...APP_CONFIG.desktop.appearance, ...APP_CONFIG.desktop.windows.scene.appearance };
const colorHex = color => `#${color.getHexString()}`;
function sceneView() {
  const classes = new Map();
  return new NetworkView({ closest: () => ({ classList: { toggle: (key, value) => classes.set(key, value) } }) }, () => {});
}
function addVisual(view) {
  const labels = new NodeLabels();
  const title = labels.add('G1.Q1');
  const count = labels.add('0 次', { color: '#5c7a96', size: 17 });
  const q = labels.add('x', { color: '#173145', size: 30 });
  q.scale.set(.46, .115, 1);
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(.1, .1, .1), new THREE.MeshBasicMaterial({ color: 0x73aaff }));
  const visual = { title, count, q, mesh, id: 'G1.Q1', type: 'Q', base: 0x73aaff, lastCount: 0 };
  view.visuals.set('G1.Q1', visual);
  return visual;
}

test('scene and Canvas show x only on nonempty EX and remove it after a model change', t => {
  const previousDocument = globalThis.document;
  const context = {
    clearRect() {}, fillText() {}, measureText: text => ({ width: text.length * 16 }),
    setTransform() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {}, fill() {}, fillRect() {},
  };
  globalThis.document = { createElement: () => ({ getContext: () => context }) };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const view = sceneView(); view.requestLayout = () => {};
  t.after(() => { view.labels.dispose(); view.batches.dispose(); view.nodeGeometry.dispose(); });
  const raw = { jkm: 'node-markers', version: '7.0.0', queues: ['work'], roots: [{
    id: 'G1', queue: 'work', pro: {}, runtime: {}, trigger: { any: ['Q1'] }, members: [
      { id: 'Q1', q: 0, trigger: { any: [] } },
      { id: 'Q2', q: 1, trigger: { any: ['Q1'] }, sources: {} },
      { id: 'Q3', q: 0, trigger: { any: ['Q1'] }, sources: { s: ['Q1'], seed: 1 } },
      { id: 'Q4', q: 1, trigger: { any: ['Q1'] }, sources: { s: ['Q1'], ex: [] } },
      { id: 'Q5', q: 0, trigger: { any: ['Q1'] }, sources: { s: ['Q1'], ex: ['J'] } },
      { id: 'Q6', q: 1, trigger: { any: ['Q1'] }, sources: { s: ['Q1'], ex: ['K'] } },
    ],
  }] };
  const drawing = () => createDisplayModel(compileModel(raw), { read: ['G1.Q5'] });
  view.setModel(drawing());
  for (const id of ['G1.Q1', 'G1.Q2', 'G1.Q3', 'G1.Q4', 'observe:G1.Q5']) assert.equal(view.visuals.get(id).q, null, id);
  for (const id of ['G1.Q5', 'G1.Q6']) {
    const marker = view.visuals.get(id).q;
    assert.equal(marker.text, 'x'); assert.equal(marker.visible, true);
    assert.equal(marker.slot.visible, true, 'marker is present in the GPU label batch');
    assert.deepEqual(marker.position.toArray(), view.visuals.get(id).mesh.position.toArray());
  }
  view.camera.position.set(0, 0, 100); view.camera.lookAt(0, 0, 0); view.camera.updateProjectionMatrix();
  const renderer = new CanvasRenderer(view, { canvas: { getContext: () => context } }); renderer.setSize(800, 600);
  renderer.render(view.scene, view.camera);
  assert.equal(renderer.labels.filter(label => label.text === 'x').length, 2);
  assert.ok(renderer.labels.every(label => label.text !== 'q'));

  const priorLabels = view.labels;
  raw.roots[0].members[4].sources.ex = [];
  delete raw.roots[0].members[5].sources;
  view.setModel(drawing());
  assert.equal(priorLabels.labels.size, 0, 'old marker resources are released');
  assert.ok([...view.visuals.values()].every(visual => visual.q === null));
  renderer.render(view.scene, view.camera);
  assert.ok(renderer.labels.every(label => label.text !== 'x' && label.text !== 'q'));
});

test('unconfigured labels retain semantic colors while captured scene defaults apply white text at 110 percent', () => {
  const view = sceneView(), visual = addVisual(view);
  const original = [visual.title, visual.count, visual.q].map(label => ({ size: label.fontSize, color: colorHex(label.textColor), scale: label.scale.toArray() }));
  view.syncLabelAppearance();
  assert.deepEqual([visual.title, visual.count, visual.q].map(label => ({ size: label.fontSize, color: colorHex(label.textColor), scale: label.scale.toArray() })), original);
  assert.equal(defaults.foreground, '#ffffff');
  assert.equal(defaults.fontScale, 1.1);
  let updates = 0;
  const sync = view.syncLabelAppearance.bind(view);
  view.syncLabelAppearance = () => { updates++; sync(); };
  assert.deepEqual(view.applyAppearance(defaults), { changed: true, blackBackgroundChanged: false });
  assert.deepEqual(view.applyAppearance({ ...defaults, radius: 28 }), { changed: false, blackBackgroundChanged: false });
  assert.equal(updates, 1);
  assert.equal(view.renderer, undefined);
  assert.deepEqual([visual.title, visual.count, visual.q].map(label => ({ size: label.fontSize, color: colorHex(label.textColor), scale: label.scale.toArray() })), original.map(label => ({ ...label, size: label.size * 1.1, color: '#ffffff' })));
});

test('label color and scale change without accumulating scale or changing node and edge materials', () => {
  const view = sceneView(), visual = addVisual(view);
  const nodeColor = visual.mesh.material.color.clone();
  const edge = new THREE.MeshBasicMaterial({ color: 0xe898c0, transparent: true, opacity: .4 });
  view.edges.push({ material: edge });
  view.applyAppearance({ ...defaults, foreground: '#ff0000', fontScale: 2 });
  assert.equal(visual.title.fontSize, 44);
  assert.equal(visual.count.fontSize, 34);
  assert.equal(visual.q.fontSize, 60);
  assert.equal(colorHex(visual.title.textColor), '#ff0000');
  view.applyAppearance({ ...defaults, foreground: '#00ff00', fontScale: 0.75 });
  assert.equal(visual.title.fontSize, 16.5);
  view.applyAppearance(defaults);
  assert.equal(visual.title.fontSize, 22 * defaults.fontScale);
  assert.deepEqual([visual.title, visual.count, visual.q].map(label => colorHex(label.textColor)), Array(3).fill(defaults.foreground));
  assert.equal(visual.mesh.material.color.equals(nodeColor), true);
  assert.equal(colorHex(edge.color), '#e898c0'); assert.equal(edge.opacity, .4);
});

test('count refresh retains configured text appearance when changing from a custom color to defaults', () => {
  const view = sceneView(), visual = addVisual(view);
  view.applyAppearance({ ...defaults, foreground: '#ffcc00', fontScale: 1.5 });
  view.refresh({ counts: new Map([['G1.Q1', 1001]]), outputs: new Map() });
  assert.equal(visual.count.text, '1001 次');
  assert.equal(visual.count.fontSize, 25.5);
  assert.equal(colorHex(visual.count.textColor), '#ffcc00');
  view.applyAppearance(defaults);
  assert.equal(visual.count.fontSize, 17 * defaults.fontScale);
  assert.equal(colorHex(visual.count.textColor), defaults.foreground);
  view.refresh({ counts: new Map([['G1.Q1', 1002]]), outputs: new Map() });
  assert.equal(visual.count.fontSize, 17 * defaults.fontScale);
  assert.equal(colorHex(visual.count.textColor), defaults.foreground);
});

test('new model labels and signal sprites inherit cached appearance without rebuilding textures repeatedly', t => {
  const previousDocument = globalThis.document;
  const painting = [];
  globalThis.document = { createElement: () => ({ getContext: () => ({ clearRect() {}, fillText(text) { painting.push({ text, color: this.fillStyle }); }, measureText: text => ({ width: text.length * 16 }) }) }) };
  t.after(() => { if (previousDocument === undefined) delete globalThis.document; else globalThis.document = previousDocument; });
  const view = sceneView();
  view.requestLayout = () => {};
  view.applyAppearance({ ...defaults, foreground: '#dd8844', fontScale: 1.5 });
  const model = id => ({ nodes: [{ key: id, id, initial: 0, errors: [], tokens: [] }], inputs: [], outputs: [] });
  view.setModel(model('G1.Q1'));
  assert.equal(view.visuals.get('G1.Q1').title.fontSize, 33);
  assert.equal(colorHex(view.visuals.get('G1.Q1').title.textColor), '#dd8844');
  view.setModel(model('G1.Q2'));
  assert.equal(view.visuals.has('G1.Q1'), false);
  assert.equal(view.visuals.get('G1.Q2').title.fontSize, 33);
  const image = globalThis.document.createElement('canvas'); image.width = 256; image.height = 64;
  const text = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(image) }));
  text.scale.set(1.5, .375, 1); text.userData.label = { text: '1', color: '#eefcf8', size: 34 };
  const signal = { text }; view.signals.push(signal); view.styleSignalLabel(signal);
  assert.deepEqual(text.scale.toArray(), [2.25, .5625, 1.5]);
  const painted = painting.length;
  view.styleSignalLabel(signal);
  assert.equal(painting.length, painted);
  view.applyAppearance(defaults);
  assert.deepEqual(text.scale.toArray(), [1.5, .375, 1].map(value => value * defaults.fontScale));
  assert.equal(painting.at(-1).color, defaults.foreground);
  view.setModel(model('G1.Q3'));
  assert.equal(view.visuals.get('G1.Q3').title.fontSize, 22 * defaults.fontScale);
  assert.equal(colorHex(view.visuals.get('G1.Q3').title.textColor), defaults.foreground);
});

test('background changes leave the transparent renderer intact and exit black mode only after an edit', () => {
  const view = sceneView();
  view.renderer = { setClearColor() { assert.fail('appearance must not cover the CSS gradient'); } };
  view.setBlackBackground(true);
  assert.equal(view.applyAppearance(defaults).blackBackgroundChanged, false);
  assert.equal(view.blackBackground, true);
  view.applyAppearance({ ...defaults, foreground: '#ff0000' });
  assert.equal(view.blackBackground, true);
  assert.equal(view.applyAppearance({ ...defaults, foreground: '#ff0000', opacity: 0 }).blackBackgroundChanged, true);
  assert.equal(view.appearance.opacity, 0);
  assert.equal(view.blackBackground, false);
  assert.equal(view.scene.background, null);
  view.setBlackBackground(true);
  assert.equal(view.applyAppearance({ ...defaults, opacity: 0, background: '#223344' }).blackBackgroundChanged, true);
});

test('Canvas fallback scales clamped labels while keeping background transparent and geometry opaque', () => {
  const view = sceneView(), visual = addVisual(view), fills = [], backgrounds = [];
  view.camera.position.set(0, 0, 100); view.camera.lookAt(0, 0, 0); view.camera.updateProjectionMatrix();
  const context = {
    setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, closePath() {}, stroke() {},
    fill() { fills.push(this.globalAlpha); }, fillRect() { backgrounds.push(this.globalAlpha); }, fillText() {},
  };
  const renderer = new CanvasRenderer(view, { canvas: { getContext: () => context } });
  renderer.setSize(400, 300); renderer.setClearColor(0x091422, 0);
  view.applyAppearance({ ...defaults, foreground: '#ff8844', fontScale: 2, opacity: 0 });
  renderer.render(view.scene, view.camera);
  assert.equal(renderer.labels[0].fontSize, APP_CONFIG.scene.renderer.software.minFontPixels * 2);
  assert.equal(colorHex(visual.title.textColor), '#ff8844');
  assert.equal(backgrounds.length, 0);
  assert.ok(fills.length > 0); assert.ok(fills.every(alpha => alpha === 1));
  view.setBlackBackground(true);
  renderer.render(view.scene, view.camera);
  assert.deepEqual(backgrounds, [1]);
});
